#!/usr/bin/env python3
"""Gather everything needed to triage a single GitHub PR via LiteLLM MCP.

All GitHub API calls go through the LiteLLM MCP proxy — no GITHUB_TOKEN needed.

Required env:
    LITELLM_API_BASE   - LiteLLM proxy base URL
    LITELLM_API_KEY    - LiteLLM API key

Usage:
    python gather_pr_triage_data.py https://github.com/owner/repo/pull/123
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from typing import Any

import httpx

OTHER_PRS_SAMPLE_SIZE = 3
MAX_PATCH_CHARS = 2000
MAX_LOG_CHARS = 3000

_GH_ACTIONS_JOB_URL_RE = re.compile(
    r"https?://github\.com/"
    r"(?P<owner>[^/]+)/(?P<repo>[^/]+)"
    r"/actions/runs/\d+/job/(?P<job_id>\d+)"
)
_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_FAILURE_MARKERS = (
    re.compile(r"\bTraceback \(most recent call last\):"),
    re.compile(r"(?<!\S)Exception:"),
    re.compile(r"(?<!\S)FAILED "),
    re.compile(r"##\[error\]"),
    re.compile(r"(?<!\S)Error:"),
    re.compile(r"(?<!\S)error:"),
)
_GREPTILE_LOGIN_RE = re.compile(r"greptile", re.IGNORECASE)
_GREPTILE_SCORE_RE = re.compile(
    r"confidence\s*score[^0-9]{0,10}([1-5])\s*/\s*5", re.IGNORECASE
)
_GREPTILE_SCORE_FALLBACK_RE = re.compile(r"\b([1-5])\s*/\s*5\b")
_CIRCLECI_NAME_RE = re.compile(r"(^|/)circleci(\s*[:/]|\b)", re.IGNORECASE)

_POLICY_META_CHECK_SUBSTRINGS = (
    "verify pr source branch",
    "dco",
    "cla/cla-bot",
    "cla-assistant",
    "license/cla",
    "signed-off-by",
    "semantic-pull-request",
    "semantic pull request",
)


def _is_policy_meta_check(name: str) -> bool:
    n = name.lower()
    return any(s in n for s in _POLICY_META_CHECK_SUBSTRINGS)


def _extract_failure_window(text: str, max_chars: int = MAX_LOG_CHARS) -> str:
    if len(text) <= max_chars:
        return text
    for marker in _FAILURE_MARKERS:
        matches = list(marker.finditer(text))
        if not matches:
            continue
        last = matches[-1]
        start = max(0, last.start() - 200)
        end = min(len(text), start + max_chars)
        prefix = "...[truncated]\n" if start > 0 else ""
        suffix = "\n...[truncated]" if end < len(text) else ""
        return f"{prefix}{text[start:end]}{suffix}"
    return "...[truncated]\n" + text[-max_chars:]


PR_URL_RE = re.compile(
    r"github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<num>\d+)"
)
PR_SHORT_RE = re.compile(r"^(?P<owner>[^/\s]+)/(?P<repo>[^#\s]+)#(?P<num>\d+)$")


def parse_pr_url(url: str) -> tuple[str, str, int]:
    m = PR_URL_RE.search(url) or PR_SHORT_RE.match(url.strip())
    if not m:
        raise ValueError(f"Not a recognised PR reference: {url}")
    return m["owner"], m["repo"], int(m["num"])


# --------------------------------------------------------------------------- #
# LiteLLM MCP client                                                          #
# --------------------------------------------------------------------------- #


class _LiteLLMMcp:
    """Minimal MCP (Streamable HTTP) client for the LiteLLM proxy.

    Handles all GitHub API calls — no GITHUB_TOKEN required.
    The proxy returns SSE-framed responses; we parse those by hand.
    Trailing slash on /mcp/ avoids a 307 redirect on every call.
    """

    def __init__(self, base_url: str, api_key: str, max_concurrency: int = 8) -> None:
        self.url = base_url.rstrip("/") + "/mcp/"
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "x-litellm-api-key": f"Bearer {api_key}",
        }
        self._sem = asyncio.Semaphore(max_concurrency)

    async def call_tool(
        self,
        client: httpx.AsyncClient,
        name: str,
        arguments: dict,
    ) -> dict | None:
        """POST a tools/call and return the parsed result, or None on error."""
        body = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        try:
            async with self._sem:
                r = await asyncio.wait_for(
                    client.post(self.url, headers=self.headers, json=body, timeout=60.0),
                    timeout=10.0,
                )
            r.raise_for_status()
        except (httpx.HTTPError, asyncio.TimeoutError):
            return None
        for line in r.text.splitlines():
            if not line.startswith("data: "):
                continue
            try:
                obj = json.loads(line[len("data: "):])
            except ValueError:
                continue
            if "error" in obj:
                return None
            res = obj.get("result")
            if isinstance(res, dict):
                return res
        return None

    def _extract_text(self, res: dict) -> str:
        parts = [
            c.get("text", "")
            for c in (res.get("content") or [])
            if isinstance(c, dict) and c.get("type") == "text"
        ]
        return "\n".join(parts).strip()

    async def gh_json(
        self, client: httpx.AsyncClient, tool: str, args: dict
    ) -> Any:
        """Call GitHub MCP tool and return parsed JSON. Raises on failure."""
        res = await self.call_tool(client, tool, args)
        if res is None or res.get("isError"):
            raise RuntimeError(f"MCP tool {tool!r} failed")
        text = self._extract_text(res)
        if not text:
            raise RuntimeError(f"MCP tool {tool!r} returned empty content")
        return json.loads(text)

    async def gh_text(
        self, client: httpx.AsyncClient, tool: str, args: dict
    ) -> str:
        """Call GitHub MCP tool and return raw text content."""
        res = await self.call_tool(client, tool, args)
        if res is None:
            return ""
        return self._extract_text(res)

    async def gh_list(
        self,
        client: httpx.AsyncClient,
        tool: str,
        args: dict,
        list_key: str | None = None,
    ) -> list[dict]:
        """Page through a GitHub MCP list tool until exhausted."""
        items: list[dict] = []
        page = 1
        per_page = 100
        while True:
            data = await self.gh_json(
                client, tool, {**args, "per_page": per_page, "page": page}
            )
            batch = data.get(list_key, []) if list_key else data
            if not isinstance(batch, list):
                break
            items.extend(batch)
            if len(batch) < per_page:
                break
            page += 1
        return items


# --------------------------------------------------------------------------- #
# Check enumeration                                                            #
# --------------------------------------------------------------------------- #


async def _list_check_runs(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    sha: str,
) -> list[dict]:
    runs = await mcp.gh_list(
        client,
        "github_openapi_mcp-checks/list-for-ref",
        {"owner": owner, "repo": repo, "ref": sha},
        list_key="check_runs",
    )
    latest: dict[str, dict] = {}
    for r in runs:
        latest[r["name"]] = r
    return list(latest.values())


async def _list_classic_statuses(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    sha: str,
) -> list[dict]:
    try:
        combined = await mcp.gh_json(
            client,
            "github_openapi_mcp-repos/get-combined-status-for-ref",
            {"owner": owner, "repo": repo, "ref": sha},
        )
    except Exception:
        return []
    statuses = combined.get("statuses") or []
    out: list[dict] = []
    for s in statuses:
        state = s.get("state")
        conclusion = {
            "success": "success",
            "failure": "failure",
            "error": "failure",
            "pending": None,
        }.get(state)
        out.append(
            {
                "id": None,
                "name": s["context"],
                "conclusion": conclusion,
                "status": "completed" if conclusion else "in_progress",
                "html_url": s.get("target_url"),
                "output": {"summary": s.get("description"), "text": None},
            }
        )
    return out


async def _all_checks(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    sha: str,
) -> list[dict]:
    runs, statuses = await asyncio.gather(
        _list_check_runs(client, mcp, owner, repo, sha),
        _list_classic_statuses(client, mcp, owner, repo, sha),
    )
    by_name: dict[str, dict] = {s["name"]: s for s in statuses}
    for r in runs:
        by_name[r["name"]] = r
    return list(by_name.values())


def _has_circleci_checks(checks: list[dict]) -> bool:
    for c in checks or []:
        name = c.get("name") or ""
        if _CIRCLECI_NAME_RE.search(name):
            return True
        app = c.get("app") or {}
        slug = (app.get("slug") or "").lower()
        if "circleci" in slug:
            return True
        html_url = c.get("html_url") or ""
        if "circleci.com" in html_url:
            return True
    return False


# --------------------------------------------------------------------------- #
# Per-failure enrichment                                                       #
# --------------------------------------------------------------------------- #


async def _fetch_annotations(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    run_id: int | None,
) -> list[str]:
    if run_id is None:
        return []
    try:
        ann = await mcp.gh_json(
            client,
            "github_openapi_mcp-checks/list-annotations",
            {"owner": owner, "repo": repo, "check_run_id": run_id, "per_page": 20, "page": 1},
        )
    except Exception:
        return []
    if not isinstance(ann, list):
        return []
    out: list[str] = []
    for a in ann:
        msg = (a.get("message") or "").strip()
        path = a.get("path") or ""
        line = a.get("start_line")
        out.append(f"{path}:{line}: {msg}"[:300])
    return out


_MCP_TRUNCATION_PRELUDE_RE = re.compile(
    r"^\s*<MCPTruncationWarning>.*?</MCPTruncationWarning>\s*",
    re.DOTALL,
)


async def _fetch_circleci_failure_log(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    html_url: str | None,
) -> str | None:
    if not html_url or "circleci.com" not in html_url:
        return None
    res = await mcp.call_tool(
        client,
        "circle_ci_mcp-get_build_failure_logs",
        {"params": {"projectURL": html_url}},
    )
    if not res or res.get("isError"):
        return None
    parts = []
    for c in res.get("content") or []:
        if isinstance(c, dict) and c.get("type") == "text":
            parts.append(c.get("text") or "")
    text = "\n".join(parts).strip()
    if not text:
        return None
    text = _MCP_TRUNCATION_PRELUDE_RE.sub("", text)
    text = _ANSI_ESCAPE_RE.sub("", text)
    return _extract_failure_window(text) if text.strip() else None


async def _fetch_actions_job_log(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    html_url: str | None,
) -> str | None:
    if not html_url:
        return None
    m = _GH_ACTIONS_JOB_URL_RE.search(html_url)
    if not m:
        return None
    try:
        text = await mcp.gh_text(
            client,
            "github_openapi_mcp-actions/download-job-logs-for-workflow-run",
            {
                "owner": m["owner"],
                "repo": m["repo"],
                "job_id": int(m["job_id"]),
            },
        )
    except Exception:
        return None
    if not text:
        return None
    # If the tool returned a redirect URL rather than content, fetch it
    stripped = text.strip()
    if stripped.startswith("http") and "\n" not in stripped and len(stripped) < 500:
        try:
            r = await client.get(stripped, follow_redirects=True, timeout=30.0)
            if r.status_code == 200:
                text = r.text
            else:
                return None
        except httpx.HTTPError:
            return None
    text = _ANSI_ESCAPE_RE.sub("", text)
    return _extract_failure_window(text) if text.strip() else None


# --------------------------------------------------------------------------- #
# PR-level fetches                                                             #
# --------------------------------------------------------------------------- #


async def _fetch_diff(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    pr_number: int,
) -> list[dict]:
    files = await mcp.gh_list(
        client,
        "github_openapi_mcp-pulls/list-files",
        {"owner": owner, "repo": repo, "pull_number": pr_number},
    )
    out: list[dict] = []
    for f in files:
        patch = f.get("patch")
        if patch and len(patch) > MAX_PATCH_CHARS:
            patch = patch[:MAX_PATCH_CHARS] + "\n...[truncated]"
        out.append(
            {
                "filename": f["filename"],
                "status": f.get("status", "modified"),
                "additions": f.get("additions", 0),
                "deletions": f.get("deletions", 0),
                "patch": patch,
            }
        )
    return out


async def _fetch_other_open_prs(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    exclude_pr: int,
    n: int,
) -> list[dict]:
    pulls = await mcp.gh_json(
        client,
        "github_openapi_mcp-pulls/list",
        {
            "owner": owner,
            "repo": repo,
            "state": "open",
            "sort": "updated",
            "direction": "desc",
            "per_page": n + 5,
            "page": 1,
        },
    )
    if not isinstance(pulls, list):
        return []
    return [p for p in pulls if p["number"] != exclude_pr][:n]


async def _fetch_greptile_score(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    pr_number: int,
) -> int | None:
    try:
        reviews, comments = await asyncio.gather(
            mcp.gh_list(
                client,
                "github_openapi_mcp-pulls/list-reviews",
                {"owner": owner, "repo": repo, "pull_number": pr_number},
            ),
            mcp.gh_list(
                client,
                "github_openapi_mcp-issues/list-comments",
                {"owner": owner, "repo": repo, "issue_number": pr_number},
            ),
        )
    except Exception:
        return None

    candidates: list[tuple[str, str]] = []
    for r in reviews or []:
        login = (r.get("user") or {}).get("login") or ""
        if _GREPTILE_LOGIN_RE.search(login):
            candidates.append((r.get("submitted_at") or "", r.get("body") or ""))
    for c in comments or []:
        login = (c.get("user") or {}).get("login") or ""
        if _GREPTILE_LOGIN_RE.search(login):
            candidates.append((c.get("created_at") or "", c.get("body") or ""))

    candidates.sort(reverse=True)
    for _, body in candidates:
        m = _GREPTILE_SCORE_RE.search(body) or _GREPTILE_SCORE_FALLBACK_RE.search(body)
        if m:
            return int(m.group(1))
    return None


# --------------------------------------------------------------------------- #
# Orchestration                                                                #
# --------------------------------------------------------------------------- #


async def _fetch_pr_with_mergeable(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    pr_number: int,
) -> dict:
    pr = await mcp.gh_json(
        client,
        "github_openapi_mcp-pulls/get",
        {"owner": owner, "repo": repo, "pull_number": pr_number},
    )
    if pr.get("mergeable") is None:
        await asyncio.sleep(1.5)
        pr = await mcp.gh_json(
            client,
            "github_openapi_mcp-pulls/get",
            {"owner": owner, "repo": repo, "pull_number": pr_number},
        )
    return pr


async def gather(
    owner: str,
    repo: str,
    pr_number: int,
    *,
    mcp: _LiteLLMMcp,
) -> dict:
    async with httpx.AsyncClient() as client:
        pr, diff_files, other_prs, greptile_score = await asyncio.gather(
            _fetch_pr_with_mergeable(client, mcp, owner, repo, pr_number),
            _fetch_diff(client, mcp, owner, repo, pr_number),
            _fetch_other_open_prs(client, mcp, owner, repo, pr_number, OTHER_PRS_SAMPLE_SIZE),
            _fetch_greptile_score(client, mcp, owner, repo, pr_number),
        )
        head_sha = pr["head"]["sha"]

        mergeable = pr.get("mergeable")
        mergeable_state = pr.get("mergeable_state")
        if pr.get("state") == "closed" and pr.get("merged_at"):
            mergeable = True
            mergeable_state = "clean"

        own_checks_task = _all_checks(client, mcp, owner, repo, head_sha)
        other_checks_tasks = [
            _all_checks(client, mcp, owner, repo, p["head"]["sha"])
            for p in other_prs
        ]
        own_checks, *other_checks = await asyncio.gather(
            own_checks_task, *other_checks_tasks
        )

        passing: list[str] = []
        in_progress: list[str] = []
        failing_runs: list[dict] = []
        for r in own_checks:
            concl = r.get("conclusion")
            if concl in ("success", "neutral", "skipped"):
                passing.append(r["name"])
            elif concl in ("failure", "timed_out", "cancelled"):
                failing_runs.append(r)
            else:
                in_progress.append(r["name"])

        if failing_runs:
            (
                annotations_per,
                circleci_logs_per,
                actions_logs_per,
            ) = await asyncio.gather(
                asyncio.gather(
                    *[
                        _fetch_annotations(client, mcp, owner, repo, r.get("id"))
                        for r in failing_runs
                    ]
                ),
                asyncio.gather(
                    *[
                        _fetch_circleci_failure_log(client, mcp, r.get("html_url"))
                        for r in failing_runs
                    ]
                ),
                asyncio.gather(
                    *[
                        _fetch_actions_job_log(client, mcp, r.get("html_url"))
                        for r in failing_runs
                    ]
                ),
            )
        else:
            annotations_per = []
            circleci_logs_per = []
            actions_logs_per = []

        failure_contexts: list[dict] = []
        for r, ann_list, cci_log, gha_log in zip(
            failing_runs, annotations_per, circleci_logs_per, actions_logs_per
        ):
            name = r["name"]
            output = r.get("output") or {}
            text = output.get("text") or ""
            if len(text) > MAX_LOG_CHARS:
                text = text[:MAX_LOG_CHARS] + "\n...[truncated]"
            if cci_log:
                text = (
                    f"{text}\n\n--- CircleCI raw log tail ---\n{cci_log}"
                    if text
                    else f"--- CircleCI raw log tail ---\n{cci_log}"
                )
            if gha_log:
                text = (
                    f"{text}\n\n--- GitHub Actions raw log tail ---\n{gha_log}"
                    if text
                    else f"--- GitHub Actions raw log tail ---\n{gha_log}"
                )
            other_status: list[dict] = []
            for p, p_checks in zip(other_prs, other_checks):
                match = next((c for c in p_checks if c["name"] == name), None)
                other_status.append(
                    {
                        "pr_number": p["number"],
                        "pr_title": p.get("title", ""),
                        "found": match is not None,
                        "conclusion": (match or {}).get("conclusion"),
                    }
                )
            also_failing_elsewhere = any(
                p.get("conclusion") in ("failure", "timed_out", "cancelled")
                for p in other_status
            )
            failure_contexts.append(
                {
                    "check_name": name,
                    "conclusion": r.get("conclusion"),
                    "summary": output.get("summary"),
                    "failure_excerpt": text or None,
                    "annotations": ann_list,
                    "html_url": r.get("html_url"),
                    "other_prs": other_status,
                    "is_policy_meta": _is_policy_meta_check(name),
                    "also_failing_on_other_prs": also_failing_elsewhere,
                }
            )

        return {
            "owner": owner,
            "repo": repo,
            "pr_number": pr_number,
            "pr_title": pr.get("title", ""),
            "pr_author": (pr.get("user") or {}).get("login") or "",
            "head_sha": head_sha,
            "passing_checks": passing,
            "in_progress_checks": in_progress,
            "failing_check_contexts": failure_contexts,
            "diff_files": diff_files,
            "other_pr_numbers": [p["number"] for p in other_prs],
            "greptile_score": greptile_score,
            "has_circleci_checks": _has_circleci_checks(own_checks),
            "mergeable": mergeable,
            "mergeable_state": mergeable_state,
        }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pr", help="PR URL or owner/repo#N")
    args = ap.parse_args()

    try:
        owner, repo, pr_number = parse_pr_url(args.pr)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(2)

    litellm_base = os.environ.get("LITELLM_API_BASE")
    litellm_key = os.environ.get("LITELLM_API_KEY")
    if not litellm_base or not litellm_key:
        print(
            "error: LITELLM_API_BASE and LITELLM_API_KEY must be set",
            file=sys.stderr,
        )
        sys.exit(1)

    mcp = _LiteLLMMcp(litellm_base, litellm_key)

    try:
        report = asyncio.run(gather(owner, repo, pr_number, mcp=mcp))
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)

    json.dump(report, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
