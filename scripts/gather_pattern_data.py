#!/usr/bin/env python3
"""Gather everything needed to review a litellm PR for pattern conformance via LiteLLM MCP.

All GitHub API calls go through the LiteLLM MCP proxy — no GITHUB_TOKEN needed.
All independent calls are batched with asyncio.gather for speed.

Required env:
    LITELLM_API_BASE   - LiteLLM proxy base URL
    LITELLM_API_KEY    - LiteLLM API key

Usage:
    python gather_pattern_data.py https://github.com/BerriAI/litellm/pull/123
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

DOCS_ROOT = "docs/my-website/docs"
MAX_PATCH_CHARS = 2000
MAX_DOC_EXCERPT_CHARS = 1500
MAX_SIBLING_HEAD_CHARS = 1200
MAX_SIBLINGS_PER_FILE = 3
MAX_DOC_EXCERPTS_PER_FILE = 3
MAX_DOCS_FETCHED = 30

PR_URL_RE = re.compile(
    r"github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<num>\d+)"
)
PR_SHORT_RE = re.compile(r"^(?P<owner>[^/\s]+)/(?P<repo>[^#\s]+)#(?P<num>\d+)$")

_CONFLICT_PATTERNS = {
    "logger_import": re.compile(
        r"(from\s+litellm[._\w]*\s+import\s+verbose_logger|"
        r"import\s+logging\s*$|"
        r"logger\s*=\s*logging\.getLogger)",
        re.MULTILINE,
    ),
    "async_client": re.compile(
        r"(httpx\.AsyncClient|aiohttp\.ClientSession|"
        r"litellm\.module_level_aclient)"
    ),
}


def parse_pr_url(url: str) -> tuple[str, str, int]:
    m = PR_URL_RE.search(url) or PR_SHORT_RE.match(url.strip())
    if not m:
        raise ValueError(f"Not a recognised PR reference: {url}")
    return m["owner"], m["repo"], int(m["num"])


# --------------------------------------------------------------------------- #
# LiteLLM MCP client                                                          #
# --------------------------------------------------------------------------- #


class _LiteLLMMcp:
    """Minimal MCP (Streamable HTTP) client for the LiteLLM proxy."""

    def __init__(self, base_url: str, api_key: str, max_concurrency: int = 8) -> None:
        self.url = base_url.rstrip("/") + "/mcp/"
        self.headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "x-litellm-api-key": f"Bearer {api_key}",
        }
        self._sem = asyncio.Semaphore(max_concurrency)

    async def call_tool(
        self, client: httpx.AsyncClient, name: str, arguments: dict
    ) -> dict | None:
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

    async def gh_json(self, client: httpx.AsyncClient, tool: str, args: dict) -> Any:
        res = await self.call_tool(client, tool, args)
        if res is None or res.get("isError"):
            raise RuntimeError(f"MCP tool {tool!r} failed")
        text = self._extract_text(res)
        if not text:
            raise RuntimeError(f"MCP tool {tool!r} returned empty content")
        return json.loads(text)

    async def gh_text(self, client: httpx.AsyncClient, tool: str, args: dict) -> str:
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
# PR + diff                                                                    #
# --------------------------------------------------------------------------- #


async def _fetch_pr(
    client: httpx.AsyncClient, mcp: _LiteLLMMcp, owner: str, repo: str, num: int
) -> dict:
    return await mcp.gh_json(
        client,
        "github_openapi_mcp-pulls/get",
        {"owner": owner, "repo": repo, "pull_number": num},
    )


async def _fetch_diff_files(
    client: httpx.AsyncClient, mcp: _LiteLLMMcp, owner: str, repo: str, num: int
) -> list[dict]:
    raw = await mcp.gh_list(
        client,
        "github_openapi_mcp-pulls/list-files",
        {"owner": owner, "repo": repo, "pull_number": num},
    )
    out: list[dict] = []
    for f in raw:
        patch = f.get("patch") or ""
        if len(patch) > MAX_PATCH_CHARS:
            patch = patch[:MAX_PATCH_CHARS] + "\n... [truncated]"
        out.append(
            {
                "filename": f.get("filename"),
                "status": f.get("status"),
                "additions": f.get("additions", 0),
                "deletions": f.get("deletions", 0),
                "patch": patch,
            }
        )
    return out


# --------------------------------------------------------------------------- #
# Docs search — fully batched                                                  #
# --------------------------------------------------------------------------- #


def _keywords_for_file(filename: str) -> list[str]:
    skip_dirs = {"src", "lib", "tests", "test", "litellm", "__init__"}
    skip_stems = {"utils", "init", "main", "base", "types", "constants"}
    parts = [p for p in re.split(r"[\\/]", filename) if p]
    if not parts:
        return []
    stem = parts[-1].rsplit(".", 1)[0]
    keywords: list[str] = []
    if stem and stem not in skip_stems:
        keywords.append(stem)
    for p in parts[:-1]:
        if p and p not in skip_dirs and p not in keywords:
            keywords.append(p)
    return keywords[:4]


async def _search_one_keyword(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    keyword: str,
) -> list[str]:
    query = f'"{keyword}" repo:{owner}/{repo} path:{DOCS_ROOT} extension:md'
    try:
        data = await mcp.gh_json(
            client, "github_mcp-search_code", {"query": query, "perPage": 5}
        )
    except Exception:
        return []
    items: list[Any] = []
    if isinstance(data, dict):
        items = data.get("items") or data.get("results") or []
    elif isinstance(data, list):
        items = data
    paths: list[str] = []
    for it in items:
        p = it.get("path") or it.get("full_name") if isinstance(it, dict) else None
        if p and p not in paths:
            paths.append(p)
    return paths


async def _fetch_file_content(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    path: str,
    ref: str,
) -> str | None:
    try:
        text = await mcp.gh_text(
            client,
            "github_mcp-get_file_contents",
            {"owner": owner, "repo": repo, "path": path, "ref": ref},
        )
        return text if text else None
    except Exception:
        return None


def _excerpt_around(text: str, keyword: str) -> tuple[str, str]:
    idx = text.lower().find(keyword.lower())
    if idx < 0:
        return ("", text[:MAX_DOC_EXCERPT_CHARS])
    half = MAX_DOC_EXCERPT_CHARS // 2
    start = max(0, idx - half)
    end = min(len(text), idx + half)
    excerpt = text[start:end]
    heading = ""
    for line in text[:idx].splitlines()[::-1]:
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            heading = m.group(2).strip()
            break
    return (heading, excerpt)


async def _gather_doc_excerpts(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    head_sha: str,
    diff_files: list[dict],
) -> list[dict]:
    # Batch 1: fire all keyword searches in parallel
    # Deduplicate keywords across files; map kw -> [filenames] to preserve attribution
    kw_to_files: dict[str, list[str]] = {}
    for f in diff_files:
        fn = f["filename"]
        if fn:
            for kw in _keywords_for_file(fn):
                kw_to_files.setdefault(kw, []).append(fn)

    unique_kws = list(kw_to_files)
    search_results = await asyncio.gather(
        *[_search_one_keyword(client, mcp, owner, repo, kw) for kw in unique_kws],
        return_exceptions=True,
    )

    # Collect all unique doc paths (capped)
    paths_needed: dict[str, list[tuple[str, str]]] = {}  # path -> [(filename, kw)]
    for kw, res in zip(unique_kws, search_results):
        if isinstance(res, Exception) or not isinstance(res, list):
            continue
        for fn in kw_to_files[kw]:
            for path in res[:MAX_DOC_EXCERPTS_PER_FILE]:
                if path not in paths_needed:
                    paths_needed[path] = []
                paths_needed[path].append((fn, kw))

    # Cap total doc fetches
    capped_paths = list(paths_needed.keys())[:MAX_DOCS_FETCHED]

    # Batch 2: fetch all doc files in parallel
    doc_contents = await asyncio.gather(
        *[_fetch_file_content(client, mcp, owner, repo, p, head_sha) for p in capped_paths],
        return_exceptions=True,
    )
    doc_cache: dict[str, str] = {}
    for path, content in zip(capped_paths, doc_contents):
        if isinstance(content, str) and content:
            doc_cache[path] = content

    # Assemble excerpts
    merged: dict[tuple[str, str], dict] = {}
    for path, refs in paths_needed.items():
        body = doc_cache.get(path)
        if not body:
            continue
        for fn, kw in refs:
            heading, excerpt = _excerpt_around(body, kw)
            key = (path, heading)
            if key in merged:
                if fn not in merged[key]["matched_files"]:
                    merged[key]["matched_files"].append(fn)
            else:
                merged[key] = {
                    "path": path,
                    "heading": heading,
                    "excerpt": excerpt,
                    "matched_files": [fn],
                }
    return list(merged.values())


# --------------------------------------------------------------------------- #
# Siblings — fully batched                                                     #
# --------------------------------------------------------------------------- #


async def _list_dir(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    dir_path: str,
    ref: str,
) -> list[dict]:
    path = dir_path if dir_path else "/"
    try:
        text = await mcp.gh_text(
            client,
            "github_mcp-get_file_contents",
            {"owner": owner, "repo": repo, "path": path, "ref": ref},
        )
        if not text:
            return []
        data = json.loads(text)
        return data if isinstance(data, list) else []
    except Exception:
        return []


async def _gather_sibling_excerpts(
    client: httpx.AsyncClient,
    mcp: _LiteLLMMcp,
    owner: str,
    repo: str,
    head_sha: str,
    diff_files: list[dict],
) -> list[dict]:
    # Batch 1: list all directories in parallel
    diff_filenames = [f["filename"] for f in diff_files if f.get("filename")]
    dir_paths = []
    for fn in diff_filenames:
        parts = fn.rsplit("/", 1)
        dir_paths.append(parts[0] if len(parts) == 2 else "")

    listings = await asyncio.gather(
        *[_list_dir(client, mcp, owner, repo, dp, head_sha) for dp in dir_paths],
        return_exceptions=True,
    )

    # Collect all unique sibling paths to fetch
    sibling_map: dict[str, list[str]] = {}  # filename -> [sib_path, ...]
    for fn, listing in zip(diff_filenames, listings):
        if isinstance(listing, Exception) or not isinstance(listing, list):
            continue
        sibs: list[str] = []
        for entry in listing:
            if entry.get("type") != "file":
                continue
            sib_path = entry.get("path")
            if not sib_path or sib_path == fn:
                continue
            if not re.search(r"\.(py|ts|tsx|js|jsx|go|rs|java)$", sib_path):
                continue
            sibs.append(sib_path)
            if len(sibs) >= MAX_SIBLINGS_PER_FILE:
                break
        sibling_map[fn] = sibs

    # Collect unique sibling paths across all files
    all_sib_paths = list({p for sibs in sibling_map.values() for p in sibs})

    # Batch 2: fetch all sibling files in parallel
    sib_contents = await asyncio.gather(
        *[_fetch_file_content(client, mcp, owner, repo, p, head_sha) for p in all_sib_paths],
        return_exceptions=True,
    )
    sib_cache: dict[str, str] = {}
    for path, content in zip(all_sib_paths, sib_contents):
        if isinstance(content, str) and content:
            sib_cache[path] = content[:MAX_SIBLING_HEAD_CHARS]

    # Assemble result
    out: list[dict] = []
    for fn in diff_filenames:
        sibs = sibling_map.get(fn, [])
        siblings: list[dict] = []
        for sib_path in sibs:
            if sib_path in sib_cache:
                siblings.append({"path": sib_path, "head_excerpt": sib_cache[sib_path]})
        if siblings:
            out.append({"diff_file": fn, "siblings": siblings})
    return out


# --------------------------------------------------------------------------- #
# Conflict hints                                                               #
# --------------------------------------------------------------------------- #


def _find_conflict_hints(
    doc_excerpts: list[dict], sibling_excerpts: list[dict]
) -> list[dict]:
    hints: list[dict] = []
    for topic, pat in _CONFLICT_PATTERNS.items():
        doc_hits: list[tuple[str, str]] = []
        for d in doc_excerpts:
            for m in pat.findall(d["excerpt"]):
                val = m if isinstance(m, str) else next((x for x in m if x), "")
                if val:
                    doc_hits.append((d["path"], val))
        if not doc_hits:
            continue
        for sg in sibling_excerpts:
            for sib in sg["siblings"]:
                for m in pat.findall(sib["head_excerpt"]):
                    val = m if isinstance(m, str) else next((x for x in m if x), "")
                    if not val:
                        continue
                    for doc_path, doc_val in doc_hits:
                        d = doc_val.strip()
                        s = val.strip()
                        if d == s:
                            continue
                        hints.append(
                            {
                                "topic": topic,
                                "doc_path": doc_path,
                                "sibling_path": sib["path"],
                                "note": f"doc shows `{d}`, sibling uses `{s}`",
                            }
                        )
    seen: set[tuple[str, str, str]] = set()
    deduped: list[dict] = []
    for h in hints:
        k = (h["topic"], h["doc_path"], h["sibling_path"])
        if k in seen:
            continue
        seen.add(k)
        deduped.append(h)
    return deduped


# --------------------------------------------------------------------------- #
# Entry point                                                                  #
# --------------------------------------------------------------------------- #


async def gather(pr_ref: str, mcp: _LiteLLMMcp) -> dict:
    owner, repo, num = parse_pr_url(pr_ref)

    async with httpx.AsyncClient() as client:
        # Batch: PR details + diff files in parallel
        pr, diff_files = await asyncio.gather(
            _fetch_pr(client, mcp, owner, repo, num),
            _fetch_diff_files(client, mcp, owner, repo, num),
        )
        head_sha = pr["head"]["sha"]

        # Batch: doc excerpts + sibling excerpts in parallel
        doc_excerpts, sibling_excerpts = await asyncio.gather(
            _gather_doc_excerpts(client, mcp, owner, repo, head_sha, diff_files),
            _gather_sibling_excerpts(client, mcp, owner, repo, head_sha, diff_files),
        )
        conflict_hints = _find_conflict_hints(doc_excerpts, sibling_excerpts)

    return {
        "owner": owner,
        "repo": repo,
        "pr_number": num,
        "pr_title": pr.get("title", ""),
        "head_sha": head_sha,
        "diff_files": diff_files,
        "doc_excerpts": doc_excerpts,
        "sibling_excerpts": sibling_excerpts,
        "conflict_hints": conflict_hints,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pr_ref", help="PR URL or owner/repo#N")
    args = parser.parse_args()

    litellm_base = os.environ.get("LITELLM_API_BASE")
    litellm_key = os.environ.get("LITELLM_API_KEY")
    if not litellm_base or not litellm_key:
        print(
            "error: LITELLM_API_BASE and LITELLM_API_KEY must be set",
            file=sys.stderr,
        )
        return 1

    mcp = _LiteLLMMcp(litellm_base, litellm_key)

    try:
        result = asyncio.run(gather(args.pr_ref, mcp))
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
