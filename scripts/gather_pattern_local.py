#!/usr/bin/env python3
"""
Local-clone gather for pattern review.

Same JSON output shape as gather_pattern_data.py but uses the local git clone
instead of GitHub MCP API — no network calls except one git fetch and an
optional gh CLI call for the PR title.

Required env (optional):
    LITELLM_CLONE_DIR  - path to local litellm clone
                         (default: /Users/krrishdholakia/Documents/litellm)

Usage:
    python scripts/gather_pattern_local.py https://github.com/BerriAI/litellm/pull/123
    LITELLM_CLONE_DIR=/path/to/clone python scripts/gather_pattern_local.py <pr_url>
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass

CLONE_DIR = Path(os.environ.get("LITELLM_CLONE_DIR", "/Users/krrishdholakia/Documents/litellm"))
DOCS_ROOT = "docs/my-website/docs"

MAX_PATCH_CHARS        = 2000
MAX_DOC_EXCERPT_CHARS  = 1500
MAX_SIBLING_HEAD_CHARS = 1200
MAX_SIBLINGS_PER_FILE  = 3
MAX_DOC_EXCERPTS_PER_FILE = 3
MAX_DOCS_FETCHED       = 30

PR_URL_RE   = re.compile(r"github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/pull/(?P<num>\d+)")
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


def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(CLONE_DIR), *args],
        capture_output=True, text=True,
    )


# ── git fetch + diff ─────────────────────────────────────────────────────────

def fetch_pr_diff(pr_number: int) -> tuple[str, str]:
    """Fetch PR head; return (unified_diff_text, head_sha)."""
    print(f"[git] fetch PR #{pr_number}", file=sys.stderr)
    t0 = time.time()
    _git("fetch", "origin", f"pull/{pr_number}/head:pr/{pr_number}")
    _git("fetch", "--depth=1", "origin", "main:refs/remotes/origin/main")
    print(f"[git] fetch done in {time.time()-t0:.1f}s", file=sys.stderr)

    sha_r = _git("rev-parse", f"pr/{pr_number}")
    head_sha = sha_r.stdout.strip()

    t0 = time.time()
    r = _git("diff", f"origin/main...pr/{pr_number}")
    if not r.stdout.strip() and "no merge base" in r.stderr:
        r = _git("diff", "origin/main", f"pr/{pr_number}")
    diff = r.stdout
    print(f"[git] diff {len(diff):,} chars in {time.time()-t0:.2f}s", file=sys.stderr)
    return diff, head_sha


_GIT_STATUS_MAP = {
    "A": "added", "M": "modified", "D": "removed",
    "R": "renamed", "C": "copied", "T": "modified", "U": "modified",
}


def _get_name_status(pr_number: int) -> dict[str, str]:
    r = _git("diff", "--name-status", "origin/main", f"pr/{pr_number}")
    out: dict[str, str] = {}
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        if not parts:
            continue
        code = parts[0][:1].upper()
        if code == "R" and len(parts) >= 3:
            out[parts[2]] = "renamed"
        elif len(parts) >= 2:
            out[parts[1]] = _GIT_STATUS_MAP.get(code, "modified")
    return out


def _get_numstat(pr_number: int) -> dict[str, tuple[int, int]]:
    r = _git("diff", "--numstat", "origin/main", f"pr/{pr_number}")
    out: dict[str, tuple[int, int]] = {}
    for line in r.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        try:
            out[parts[2]] = (int(parts[0]), int(parts[1]))
        except ValueError:
            out[parts[2]] = (0, 0)
    return out


def parse_diff_files(diff: str, pr_number: int) -> list[dict]:
    """Parse unified diff + git metadata into list of {filename, status, additions, deletions, patch}."""
    patches: dict[str, str] = {}
    cur_file: str | None = None
    cur_lines: list[str] = []
    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if cur_file:
                patches[cur_file] = "".join(cur_lines)
            cur_file = None
            cur_lines = []
        elif line.startswith("+++ b/"):
            cur_file = line[6:].rstrip("\n")
        elif cur_file:
            cur_lines.append(line)
    if cur_file:
        patches[cur_file] = "".join(cur_lines)

    status_map = _get_name_status(pr_number)
    numstat    = _get_numstat(pr_number)

    out: list[dict] = []
    for fn, patch in patches.items():
        if len(patch) > MAX_PATCH_CHARS:
            patch = patch[:MAX_PATCH_CHARS] + "\n... [truncated]"
        add, dele = numstat.get(fn, (0, 0))
        out.append({
            "filename":  fn,
            "status":    status_map.get(fn, "modified"),
            "additions": add,
            "deletions": dele,
            "patch":     patch,
        })
    return out


# ── keywords + doc grep ───────────────────────────────────────────────────────

def _keywords_for_file(filename: str) -> list[str]:
    skip_dirs  = {"src", "lib", "tests", "test", "litellm", "__init__"}
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


def _grep_docs(keyword: str) -> list[Path]:
    docs = CLONE_DIR / DOCS_ROOT
    if not docs.exists():
        return []
    try:
        r = subprocess.run(
            ["grep", "-rl", "-i", "--include=*.md", keyword, str(docs)],
            capture_output=True, text=True, timeout=10,
        )
        return [Path(p) for p in r.stdout.strip().splitlines() if p.strip()][:MAX_DOC_EXCERPTS_PER_FILE]
    except Exception:
        return []


def _excerpt_around(text: str, keyword: str) -> tuple[str, str]:
    """Return (nearest_heading, excerpt) — same logic as gather_pattern_data.py."""
    idx = text.lower().find(keyword.lower())
    if idx < 0:
        return ("", text[:MAX_DOC_EXCERPT_CHARS])
    half = MAX_DOC_EXCERPT_CHARS // 2
    excerpt = text[max(0, idx - half): min(len(text), idx + half)]
    heading = ""
    for line in text[:idx].splitlines()[::-1]:
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            heading = m.group(2).strip()
            break
    return (heading, excerpt)


def gather_doc_excerpts(diff_files: list[dict]) -> list[dict]:
    """Output shape: [{path, heading, excerpt, matched_files}, ...]"""
    t0 = time.time()
    kw_to_files: dict[str, list[str]] = {}
    for f in diff_files:
        fn = f["filename"]
        if fn:
            for kw in _keywords_for_file(fn):
                kw_to_files.setdefault(kw, []).append(fn)

    # (path, heading) → merged entry
    merged: dict[tuple[str, str], dict] = {}
    total_docs = 0

    for kw, fnames in kw_to_files.items():
        for doc_path in _grep_docs(kw):
            if total_docs >= MAX_DOCS_FETCHED:
                break
            try:
                text = doc_path.read_text(errors="replace")
            except Exception:
                continue
            try:
                rel = str(doc_path.relative_to(CLONE_DIR))
            except ValueError:
                rel = str(doc_path)
            heading, excerpt = _excerpt_around(text, kw)
            key = (rel, heading)
            if key not in merged:
                merged[key] = {
                    "path":          rel,
                    "heading":       heading,
                    "excerpt":       excerpt,
                    "matched_files": [],
                }
                total_docs += 1
            for fn in fnames:
                if fn not in merged[key]["matched_files"]:
                    merged[key]["matched_files"].append(fn)

    result = list(merged.values())
    print(f"[local] doc_excerpts={len(result)} in {time.time()-t0:.2f}s", file=sys.stderr)
    return result


# ── siblings ──────────────────────────────────────────────────────────────────

def gather_sibling_excerpts(diff_files: list[dict]) -> list[dict]:
    """Output shape: [{diff_file, siblings: [{path, head_excerpt}]}, ...]"""
    t0 = time.time()
    out: list[dict] = []
    for f in diff_files:
        fn = f["filename"]
        d = CLONE_DIR / Path(fn).parent
        if not d.exists():
            continue
        siblings: list[dict] = []
        for sib in sorted(d.iterdir()):
            if sib.name == Path(fn).name:
                continue
            if not re.search(r"\.(py|ts|tsx|js|jsx|go|rs|java)$", sib.name):
                continue
            try:
                content = sib.read_text(errors="replace")[:MAX_SIBLING_HEAD_CHARS]
            except Exception:
                continue
            try:
                rel = str(sib.relative_to(CLONE_DIR))
            except ValueError:
                rel = str(sib)
            siblings.append({"path": rel, "head_excerpt": content})
            if len(siblings) >= MAX_SIBLINGS_PER_FILE:
                break
        if siblings:
            out.append({"diff_file": fn, "siblings": siblings})
    print(f"[local] sibling_excerpts={len(out)} in {time.time()-t0:.2f}s", file=sys.stderr)
    return out


# ── conflict hints ────────────────────────────────────────────────────────────

def find_conflict_hints(
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
                        d_v = doc_val.strip()
                        s_v = val.strip()
                        if d_v == s_v:
                            continue
                        hints.append({
                            "topic":        topic,
                            "doc_path":     doc_path,
                            "sibling_path": sib["path"],
                            "note":         f"doc shows `{d_v}`, sibling uses `{s_v}`",
                        })
    seen: set[tuple[str, str, str]] = set()
    deduped: list[dict] = []
    for h in hints:
        k = (h["topic"], h["doc_path"], h["sibling_path"])
        if k in seen:
            continue
        seen.add(k)
        deduped.append(h)
    return deduped


# ── PR title (optional gh CLI) ────────────────────────────────────────────────

def _fetch_pr_title(owner: str, repo: str, num: int) -> str:
    try:
        r = subprocess.run(
            ["gh", "api", f"repos/{owner}/{repo}/pulls/{num}", "--jq", ".title"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return ""


# ── entry point ───────────────────────────────────────────────────────────────

def gather(pr_ref: str) -> dict:
    owner, repo, num = parse_pr_url(pr_ref)
    t_wall = time.time()

    diff_raw, head_sha = fetch_pr_diff(num)
    diff_files = parse_diff_files(diff_raw, num)
    print(f"[parse] {len(diff_files)} changed files", file=sys.stderr)

    pr_title = _fetch_pr_title(owner, repo, num)

    doc_excerpts     = gather_doc_excerpts(diff_files)
    sibling_excerpts = gather_sibling_excerpts(diff_files)
    conflict_hints   = find_conflict_hints(doc_excerpts, sibling_excerpts)

    print(
        f"[gather] total {time.time()-t_wall:.1f}s  "
        f"docs={len(doc_excerpts)}  siblings={len(sibling_excerpts)}  "
        f"hints={len(conflict_hints)}",
        file=sys.stderr,
    )
    return {
        "owner":            owner,
        "repo":             repo,
        "pr_number":        num,
        "pr_title":         pr_title,
        "head_sha":         head_sha,
        "diff_files":       diff_files,
        "doc_excerpts":     doc_excerpts,
        "sibling_excerpts": sibling_excerpts,
        "conflict_hints":   conflict_hints,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pr_ref", help="PR URL or owner/repo#N")
    args = parser.parse_args()

    try:
        result = gather(args.pr_ref)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 2
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"error: {e}", file=sys.stderr)
        return 1

    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
