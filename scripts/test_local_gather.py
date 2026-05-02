#!/usr/bin/env python3
"""
Pattern review using local litellm clone — no MCP round trips.

Gather flow:
  1. git fetch origin pull/<N>/head  (one network call)
  2. git diff litellm_internal_staging...FETCH_HEAD  (local, instant)
  3. grep + read files from local clone  (local, instant)
  4. single LLM call with all context bundled  (no tool loop)

Usage:
    python scripts/test_local_gather.py <pr_url>
    LITELLM_CLONE_DIR=/path/to/clone python scripts/test_local_gather.py <pr_url>
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

HERE = Path(__file__).parent
ROOT = HERE.parent
load_dotenv(ROOT / ".env")

LITELLM_API_BASE = os.environ["LITELLM_API_BASE"].rstrip("/")
LITELLM_API_KEY  = os.environ["LITELLM_API_KEY"]
MODEL            = os.environ.get("LITELLM_DEFAULT_MODEL", "anthropic/claude-sonnet-4-6")
CLONE_DIR        = Path(os.environ.get("LITELLM_CLONE_DIR", "/Users/krrishdholakia/Documents/litellm"))
BASE_BRANCH      = os.environ.get("LITELLM_BASE_BRANCH", "litellm_internal_staging")

DOCS_ROOT             = "docs/my-website/docs"
MAX_PATCH_CHARS       = 1200
MAX_DOC_CHARS         = 800
MAX_SIBLING_CHARS     = 600
MAX_SIBLINGS_PER_FILE = 2
MAX_DOCS_PER_KEYWORD  = 2
MAX_PROMPT_CHARS      = 30_000   # hard cap before sending to LLM

PR_RE = re.compile(r"github\.com/[^/]+/[^/]+/pull/(\d+)")


# ── git helpers ───────────────────────────────────────────────────────────────

def _git(*args: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(CLONE_DIR), *args],
        capture_output=True, text=True, **kw
    )


def fetch_pr(pr_number: int) -> str:
    """Fetch PR head and return the diff against the PR's target branch (main)."""
    print(f"[git] fetch PR #{pr_number}", flush=True)
    t0 = time.time()
    # Fetch PR head
    _git("fetch", "origin", f"pull/{pr_number}/head:pr/{pr_number}")
    # Also ensure origin/main is available for diffing (PRs target main, not staging)
    _git("fetch", "--depth=1", "origin", "main:refs/remotes/origin/main")
    print(f"[git] fetch done in {time.time()-t0:.1f}s", flush=True)

    t0 = time.time()
    # Three-dot diff needs a merge base; shallow fetches often lack one.
    # Try three-dot first, fall back to two-dot.
    r = _git("diff", f"origin/main...pr/{pr_number}")
    if not r.stdout.strip() and "no merge base" in r.stderr:
        r = _git("diff", f"origin/main", f"pr/{pr_number}")
    diff = r.stdout
    print(f"[git] diff vs main: {len(diff):,} chars in {time.time()-t0:.2f}s", flush=True)
    return diff


def parse_diff(diff: str) -> list[dict]:
    """Split unified diff into per-file dicts with truncated patches."""
    files: list[dict] = []
    cur_file: str | None = None
    cur_lines: list[str] = []

    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if cur_file:
                files.append({"filename": cur_file, "patch": "".join(cur_lines)})
            cur_file = None
            cur_lines = []
        elif line.startswith("+++ b/"):
            cur_file = line[6:].rstrip("\n")
        elif cur_file:
            cur_lines.append(line)

    if cur_file:
        files.append({"filename": cur_file, "patch": "".join(cur_lines)})

    out = []
    for f in files:
        p = f["patch"]
        if len(p) > MAX_PATCH_CHARS:
            p = p[:MAX_PATCH_CHARS] + "\n... [patch truncated]"
        out.append({"filename": f["filename"], "patch": p})
    return out


# ── local content helpers ─────────────────────────────────────────────────────

_SKIP_DIRS  = {"src", "lib", "tests", "test", "__pycache__"}
_SKIP_STEMS = {"utils", "init", "main", "base", "types", "constants"}

def keywords_for(filename: str) -> list[str]:
    parts = [p for p in re.split(r"[/\\]", filename) if p]
    if not parts:
        return []
    stem = parts[-1].rsplit(".", 1)[0]
    kws: list[str] = []
    if stem and stem not in _SKIP_STEMS:
        kws.append(stem)
    for p in parts[:-1]:
        if p and p not in _SKIP_DIRS and p not in kws:
            kws.append(p)
    return kws[:4]


def grep_docs(keyword: str) -> list[Path]:
    docs = CLONE_DIR / DOCS_ROOT
    if not docs.exists():
        return []
    r = subprocess.run(
        ["grep", "-rl", "-i", "--include=*.md", keyword, str(docs)],
        capture_output=True, text=True, timeout=10,
    )
    paths = [Path(p) for p in r.stdout.strip().splitlines() if p.strip()]
    return paths[:MAX_DOCS_PER_KEYWORD]


def excerpt(text: str, keyword: str, window: int = MAX_DOC_CHARS) -> str:
    idx = text.lower().find(keyword.lower())
    if idx < 0:
        return text[:window]
    half = window // 2
    return text[max(0, idx - half): idx + half]


def read_local(path: Path, max_chars: int) -> str | None:
    if not path.exists():
        return None
    try:
        t = path.read_text(errors="replace")
        return t[:max_chars]
    except Exception:
        return None


def siblings(filename: str) -> list[dict]:
    d = CLONE_DIR / Path(filename).parent
    if not d.exists():
        return []
    out: list[dict] = []
    for f in sorted(d.iterdir()):
        if f.name == Path(filename).name:
            continue
        if not re.search(r"\.(py|ts|tsx|js|jsx)$", f.name):
            continue
        content = read_local(f, MAX_SIBLING_CHARS)
        if content:
            out.append({"path": str(f.relative_to(CLONE_DIR)), "head": content})
        if len(out) >= MAX_SIBLINGS_PER_FILE:
            break
    return out


# ── gather ────────────────────────────────────────────────────────────────────

def gather_local(diff_files: list[dict]) -> dict:
    t0 = time.time()
    doc_excerpts: list[dict] = []
    sibling_excerpts: list[dict] = []
    seen_docs: set[str] = set()

    for f in diff_files:
        fn = f["filename"]
        for kw in keywords_for(fn):
            for doc_path in grep_docs(kw):
                key = str(doc_path)
                if key in seen_docs:
                    continue
                seen_docs.add(key)
                content = read_local(doc_path, MAX_DOC_CHARS * 2)
                if not content:
                    continue
                doc_excerpts.append({
                    "path": str(doc_path.relative_to(CLONE_DIR)),
                    "matched_file": fn,
                    "keyword": kw,
                    "excerpt": excerpt(content, kw),
                })

        sibs = siblings(fn)
        if sibs:
            sibling_excerpts.append({"diff_file": fn, "siblings": sibs})

    print(
        f"[local] gather {time.time()-t0:.2f}s  "
        f"doc_excerpts={len(doc_excerpts)}  sibling_excerpts={len(sibling_excerpts)}",
        flush=True,
    )
    return {"doc_excerpts": doc_excerpts, "sibling_excerpts": sibling_excerpts}


# ── prompt builder ────────────────────────────────────────────────────────────

def build_user_prompt(pr_url: str, diff_files: list[dict], local: dict) -> str:
    parts: list[str] = [f"PR: {pr_url}\n\n"]

    parts.append("## Diff\n\n")
    for f in diff_files:
        parts.append(f"### `{f['filename']}`\n```diff\n{f['patch']}\n```\n\n")

    if local["doc_excerpts"]:
        parts.append("## Relevant doc excerpts (from local clone)\n\n")
        for d in local["doc_excerpts"]:
            parts.append(
                f"**`{d['path']}`** (keyword `{d['keyword']}` matched `{d['matched_file']}`):\n"
                f"```\n{d['excerpt']}\n```\n\n"
            )

    if local["sibling_excerpts"]:
        parts.append("## Sibling file excerpts (same directory, local clone)\n\n")
        for sg in local["sibling_excerpts"]:
            parts.append(f"**For `{sg['diff_file']}`:**\n")
            for s in sg["siblings"]:
                parts.append(f"`{s['path']}`:\n```\n{s['head']}\n```\n\n")

    prompt = "".join(parts)
    if len(prompt) > MAX_PROMPT_CHARS:
        prompt = prompt[:MAX_PROMPT_CHARS] + "\n\n... [prompt truncated to fit context limit]"
    return prompt


# ── system prompt (same output schema, no tool-call instructions) ──────────────

_PROSE_RULE = "plain prose, no markdown bold or italics"

SYSTEM = f"""You review a GitHub pull request for BerriAI/litellm and decide whether the diff
conforms to the repo's documented and de-facto code patterns.

You are given the full diff, relevant doc excerpts, and sibling file excerpts directly.
No tool calls needed — all data is in the prompt.

Hard rules:
- Docs beat code on conflict. Cite the doc path in the finding.
- Only cite files present in the diff or provided excerpts. Never invent paths.
- A pattern is de-facto when it appears in ≥2 sibling excerpts and docs don't contradict.
- Conforms files emit ZERO findings. Only flag violates_docs or violates_code_only.

REJECTION CHECKLIST — drop any finding where:
1. Rationale contains: "may", "might", "could", "potentially", "unverifiable".
2. Rationale mentions truncation or unreadable patches.
3. File classified conforms or no_pattern_found.

OUTPUT OVERRIDE: Return PatternReport JSON only. No prose.
Print JSON on the LAST LINE. Single-line JSON only.

Schema:
{{
  "findings": [
    {{
      "file": "str",
      "severity": "blocker|suggestion|nit",
      "risk": "high|medium|low",
      "source": "docs|code",
      "citation": "str",
      "rationale": "str (≤200 chars, {_PROSE_RULE})"
    }}
  ],
  "tech_debt": [
    {{"doc_path": "str", "code_path": "str", "note": "str (≤200 chars)"}}
  ]
}}

If no findings: findings: []. If no tech_debt: [].
Print your JSON on the LAST LINE of your response. Single-line JSON only."""


# ── LLM call ─────────────────────────────────────────────────────────────────

def run_review(user_prompt: str) -> tuple[str, float]:
    client = OpenAI(base_url=f"{LITELLM_API_BASE}/v1", api_key=LITELLM_API_KEY)
    print(f"\n[llm] single call  prompt={len(user_prompt):,} chars", flush=True)
    t0 = time.time()
    resp = client.chat.completions.create(
        model=MODEL,
        max_tokens=4096,
        messages=[
            {"role": "system", "content": SYSTEM},
            {"role": "user",   "content": user_prompt},
        ],
    )
    elapsed = time.time() - t0
    text = resp.choices[0].message.content or ""
    print(f"[llm] done in {elapsed:.1f}s  output={len(text)} chars", flush=True)
    return text, elapsed


# ── main ──────────────────────────────────────────────────────────────────────

def _extract_json(text: str) -> dict | None:
    for line in reversed(text.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                pass
    return None


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python scripts/test_local_gather.py <pr_url>")
        sys.exit(1)

    pr_url = sys.argv[1]
    m = PR_RE.search(pr_url)
    if not m:
        print(f"Cannot parse PR number from: {pr_url}")
        sys.exit(1)
    pr_number = int(m.group(1))

    print("=" * 60)
    print(f"Local-gather pattern review")
    print(f"PR:    {pr_url}")
    print(f"Clone: {CLONE_DIR}  (branch: {BASE_BRANCH})")
    print(f"Model: {MODEL}")
    print("=" * 60)

    t_wall = time.time()

    # 1. Diff
    diff_raw    = fetch_pr(pr_number)
    diff_files  = parse_diff(diff_raw)
    print(f"[parse] {len(diff_files)} changed files")

    # 2. Local gather (grep + sibling reads)
    local       = gather_local(diff_files)

    # 3. Build prompt
    user_prompt = build_user_prompt(pr_url, diff_files, local)

    # 4. Single LLM call
    output, llm_time = run_review(user_prompt)

    total = time.time() - t_wall

    print("\n" + "=" * 60)
    print("OUTPUT (last 3000 chars):")
    print("=" * 60)
    print(output[-3000:] if len(output) > 3000 else output)

    print("\n" + "=" * 60)
    print("BENCHMARK")
    print("=" * 60)
    print(f"Wall time  : {total:.1f}s")
    print(f"LLM time   : {llm_time:.1f}s")
    print(f"Gather time: {total - llm_time:.1f}s  (git fetch + grep + reads)")
    print(f"Files      : {len(diff_files)}")
    print(f"Doc excerpt: {len(local['doc_excerpts'])}")
    print(f"Siblings   : {len(local['sibling_excerpts'])}")
    print(f"Prompt size: {len(user_prompt):,} chars")

    data = _extract_json(output)
    if data is not None:
        findings  = data.get("findings", [])
        tech_debt = data.get("tech_debt", [])
        print(f"JSON OK    : findings={len(findings)}  tech_debt={len(tech_debt)}")
        for f in findings:
            sev  = f.get("severity", "?")
            risk = f.get("risk", "?")
            file = f.get("file", "?")
            rat  = f.get("rationale", "")[:80]
            print(f"  [{sev} risk={risk}] {file} — {rat}")
    else:
        print("JSON       : NOT FOUND — model returned prose")


if __name__ == "__main__":
    main()
