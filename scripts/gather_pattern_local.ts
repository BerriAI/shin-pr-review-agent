#!/usr/bin/env -S npx tsx
/**
 * Local-clone gather for pattern review.
 *
 * Same JSON output shape as gather_pattern_data.py but uses the local git clone
 * instead of GitHub MCP API — no network calls except one git fetch and an
 * optional gh CLI call for the PR title.
 *
 * Required env (optional):
 *     LITELLM_CLONE_DIR  - path to local litellm clone
 *                          (default: /Users/krrishdholakia/Documents/litellm)
 *
 * Usage:
 *     npx tsx scripts/gather_pattern_local.ts https://github.com/BerriAI/litellm/pull/123
 *     LITELLM_CLONE_DIR=/path/to/clone npx tsx scripts/gather_pattern_local.ts <pr_url>
 *
 * Direct port of gather_pattern_local.py — keeps function names, JSON shape, and
 * tuning constants identical.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname as pathDirname, join, relative } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CLONE_DIR = join(homedir(), "Documents", "litellm");
const CLONE_DIR = process.env.LITELLM_CLONE_DIR ?? DEFAULT_CLONE_DIR;
const DOCS_ROOT = "docs/my-website/docs";

const MAX_PATCH_CHARS = 2000;
const MAX_DOC_EXCERPT_CHARS = 1500;
const MAX_SIBLING_HEAD_CHARS = 1200;
const MAX_SIBLINGS_PER_FILE = 3;
const MAX_DOC_EXCERPTS_PER_FILE = 3;
const MAX_DOCS_FETCHED = 30;

const PR_URL_RE = /github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<num>\d+)/;
const PR_SHORT_RE = /^(?<owner>[^/\s]+)\/(?<repo>[^#\s]+)#(?<num>\d+)$/;

// Python strings are sequences of Unicode codepoints; JS strings are UTF-16
// code units, so non-BMP chars (like emoji) count as 2 in JS .length / .slice.
// These helpers slice and search in codepoints to match Python's semantics so
// truncation boundaries land on identical characters across the two ports.
function cpSlice(s: string, start: number, end?: number): string {
  // Array.from iterates by codepoint, joining gives back a normal string.
  const cps = Array.from(s);
  return cps.slice(start, end ?? cps.length).join("");
}

function cpLength(s: string): number {
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of s) n++;
  return n;
}

function cpIndexOf(haystack: string, needle: string): number {
  // Find the codepoint index where `needle` starts in `haystack`. Returns -1 if absent.
  // We need this because indexOf returns a UTF-16 position which doesn't match
  // Python's str.find when emoji or other surrogate-pair chars appear earlier.
  const u16Idx = haystack.indexOf(needle);
  if (u16Idx < 0) return -1;
  // Convert UTF-16 index to codepoint index by counting codepoints up to u16Idx.
  let cpIdx = 0;
  let i = 0;
  while (i < u16Idx) {
    const code = haystack.charCodeAt(i);
    // High surrogate? Skip both halves as one codepoint.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < haystack.length) i += 2;
    else i++;
    cpIdx++;
  }
  return cpIdx;
}

const _CONFLICT_PATTERNS: Record<string, RegExp> = {
  logger_import:
    /(from\s+litellm[._\w]*\s+import\s+verbose_logger|^import\s+logging\s*$|logger\s*=\s*logging\.getLogger)/m,
  async_client: /(httpx\.AsyncClient|aiohttp\.ClientSession|litellm\.module_level_aclient)/,
};

function parsePrUrl(url: string): { owner: string; repo: string; num: number } {
  const m = PR_URL_RE.exec(url) ?? PR_SHORT_RE.exec(url.trim());
  if (!m || !m.groups) throw new Error(`Not a recognised PR reference: ${url}`);
  return { owner: m.groups.owner, repo: m.groups.repo, num: parseInt(m.groups.num, 10) };
}

interface CmdResult {
  stdout: string;
  stderr: string;
  status: number;
}

function _git(...args: string[]): CmdResult {
  // execFileSync throws on non-zero exit; mimic Python's subprocess.run() (capture, don't throw).
  // Normalize CRLF -> LF so we match Python's text-mode universal newline behavior;
  // critical for diff output of files stored with CRLF endings.
  const norm = (s: string | undefined): string => (s ?? "").replace(/\r\n?/g, "\n");
  try {
    const stdout = execFileSync("git", ["-C", CLONE_DIR, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout: norm(stdout), stderr: "", status: 0 };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: norm(err.stdout?.toString()),
      stderr: norm(err.stderr?.toString()),
      status: err.status ?? 1,
    };
  }
}

// ── git fetch + diff ─────────────────────────────────────────────────────────

function fetchPrDiff(prNumber: number): { diff: string; headSha: string } {
  process.stderr.write(`[git] fetch PR #${prNumber}\n`);
  const t0 = Date.now();
  _git("fetch", "origin", `pull/${prNumber}/head:pr/${prNumber}`);
  _git("fetch", "--depth=1", "origin", "main:refs/remotes/origin/main");
  process.stderr.write(`[git] fetch done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const shaR = _git("rev-parse", `pr/${prNumber}`);
  const headSha = shaR.stdout.trim();

  const t1 = Date.now();
  let r = _git("diff", `origin/main...pr/${prNumber}`);
  if (!r.stdout.trim() && r.stderr.includes("no merge base")) {
    r = _git("diff", "origin/main", `pr/${prNumber}`);
  }
  const diff = r.stdout;
  process.stderr.write(
    `[git] diff ${diff.length.toLocaleString()} chars in ${((Date.now() - t1) / 1000).toFixed(2)}s\n`,
  );
  return { diff, headSha };
}

const _GIT_STATUS_MAP: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "removed",
  R: "renamed",
  C: "copied",
  T: "modified",
  U: "modified",
};

function _getNameStatus(prNumber: number): Record<string, string> {
  const r = _git("diff", "--name-status", "origin/main", `pr/${prNumber}`);
  const out: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length === 0 || parts[0] === "") continue;
    const code = (parts[0][0] ?? "").toUpperCase();
    if (code === "R" && parts.length >= 3) {
      out[parts[2]] = "renamed";
    } else if (parts.length >= 2) {
      out[parts[1]] = _GIT_STATUS_MAP[code] ?? "modified";
    }
  }
  return out;
}

function _getNumstat(prNumber: number): Record<string, [number, number]> {
  const r = _git("diff", "--numstat", "origin/main", `pr/${prNumber}`);
  const out: Record<string, [number, number]> = {};
  for (const line of r.stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    out[parts[2]] = [Number.isFinite(a) ? a : 0, Number.isFinite(d) ? d : 0];
  }
  return out;
}

interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

function parseDiffFiles(diff: string, prNumber: number): DiffFile[] {
  // Parse unified diff + git metadata into list of {filename, status, additions, deletions, patch}.
  const patches: Record<string, string> = {};
  let curFile: string | null = null;
  let curLines: string[] = [];
  // splitlines(keepends=True): keep trailing \n on each line
  const lines = diff.split(/(?<=\n)/);
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (curFile !== null) patches[curFile] = curLines.join("");
      curFile = null;
      curLines = [];
    } else if (line.startsWith("+++ b/")) {
      curFile = line.slice(6).replace(/\n$/, "");
    } else if (curFile !== null) {
      curLines.push(line);
    }
  }
  if (curFile !== null) patches[curFile] = curLines.join("");

  const statusMap = _getNameStatus(prNumber);
  const numstat = _getNumstat(prNumber);

  const out: DiffFile[] = [];
  for (const fn of Object.keys(patches)) {
    let patch = patches[fn];
    if (cpLength(patch) > MAX_PATCH_CHARS) {
      patch = cpSlice(patch, 0, MAX_PATCH_CHARS) + "\n... [truncated]";
    }
    const [add, dele] = numstat[fn] ?? [0, 0];
    out.push({
      filename: fn,
      status: statusMap[fn] ?? "modified",
      additions: add,
      deletions: dele,
      patch,
    });
  }
  return out;
}

// ── keywords + doc grep ───────────────────────────────────────────────────────

function _keywordsForFile(filename: string): string[] {
  const skipDirs = new Set(["src", "lib", "tests", "test", "litellm", "__init__"]);
  const skipStems = new Set(["utils", "init", "main", "base", "types", "constants"]);
  const parts = filename.split(/[\\/]/).filter((p) => p.length > 0);
  if (parts.length === 0) return [];
  const last = parts[parts.length - 1];
  const stem = last.includes(".") ? last.slice(0, last.lastIndexOf(".")) : last;
  const keywords: string[] = [];
  if (stem && !skipStems.has(stem)) keywords.push(stem);
  for (const p of parts.slice(0, -1)) {
    if (p && !skipDirs.has(p) && !keywords.includes(p)) keywords.push(p);
  }
  return keywords.slice(0, 4);
}

function _grepDocs(keyword: string): string[] {
  const docs = join(CLONE_DIR, DOCS_ROOT);
  if (!existsSync(docs)) return [];
  try {
    const stdout = execFileSync("grep", ["-rl", "-i", "--include=*.md", keyword, docs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout
      .trim()
      .split("\n")
      .filter((p) => p.trim().length > 0)
      .slice(0, MAX_DOC_EXCERPTS_PER_FILE);
  } catch (e) {
    // grep returns 1 when there are no matches — treat as empty list, not an error
    const err = e as NodeJS.ErrnoException & { status?: number; stdout?: string };
    if (err.status === 1) {
      const stdout = err.stdout?.toString() ?? "";
      return stdout
        .trim()
        .split("\n")
        .filter((p) => p.trim().length > 0)
        .slice(0, MAX_DOC_EXCERPTS_PER_FILE);
    }
    return [];
  }
}

function _excerptAround(text: string, keyword: string): { heading: string; excerpt: string } {
  // Return (nearest_heading, excerpt) — same logic as gather_pattern_data.py.
  // All offsets/lengths in codepoints to match Python str semantics.
  const idx = cpIndexOf(text.toLowerCase(), keyword.toLowerCase());
  if (idx < 0) {
    return { heading: "", excerpt: cpSlice(text, 0, MAX_DOC_EXCERPT_CHARS) };
  }
  const half = Math.floor(MAX_DOC_EXCERPT_CHARS / 2);
  const total = cpLength(text);
  const excerpt = cpSlice(text, Math.max(0, idx - half), Math.min(total, idx + half));
  let heading = "";
  const before = cpSlice(text, 0, idx).split("\n").reverse();
  const headingRe = /^(#{1,6})\s+(.*)$/;
  for (const line of before) {
    const m = headingRe.exec(line);
    if (m) {
      heading = m[2].trim();
      break;
    }
  }
  return { heading, excerpt };
}

interface DocExcerpt {
  path: string;
  heading: string;
  excerpt: string;
  matched_files: string[];
}

function _safeReadText(path: string): string | null {
  // Match Python's text-mode read which performs universal newline translation
  // (\r\n and \r -> \n). Without this, CRLF-terminated source files produce
  // different excerpts than the Python implementation.
  try {
    return readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
}

function _relativeToClone(path: string): string {
  try {
    const r = relative(CLONE_DIR, path);
    // Python's Path.relative_to throws if path isn't a subpath; mimic by checking for ".."
    if (r.startsWith("..")) return path;
    return r;
  } catch {
    return path;
  }
}

function gatherDocExcerpts(diffFiles: DiffFile[]): DocExcerpt[] {
  // Output shape: [{path, heading, excerpt, matched_files}, ...]
  const t0 = Date.now();
  const kwToFiles: Record<string, string[]> = {};
  for (const f of diffFiles) {
    const fn = f.filename;
    if (fn) {
      for (const kw of _keywordsForFile(fn)) {
        (kwToFiles[kw] = kwToFiles[kw] ?? []).push(fn);
      }
    }
  }

  const merged = new Map<string, DocExcerpt>();
  let totalDocs = 0;

  for (const kw of Object.keys(kwToFiles)) {
    const fnames = kwToFiles[kw];
    for (const docPath of _grepDocs(kw)) {
      if (totalDocs >= MAX_DOCS_FETCHED) break;
      const text = _safeReadText(docPath);
      if (text === null) continue;
      const rel = _relativeToClone(docPath);
      const { heading, excerpt } = _excerptAround(text, kw);
      const key = `${rel}\u0000${heading}`;
      let entry = merged.get(key);
      if (!entry) {
        entry = { path: rel, heading, excerpt, matched_files: [] };
        merged.set(key, entry);
        totalDocs++;
      }
      for (const fn of fnames) {
        if (!entry.matched_files.includes(fn)) entry.matched_files.push(fn);
      }
    }
  }

  const result = Array.from(merged.values());
  process.stderr.write(
    `[local] doc_excerpts=${result.length} in ${((Date.now() - t0) / 1000).toFixed(2)}s\n`,
  );
  return result;
}

// ── siblings ──────────────────────────────────────────────────────────────────

interface Sibling {
  path: string;
  head_excerpt: string;
}
interface SiblingGroup {
  diff_file: string;
  siblings: Sibling[];
}

function gatherSiblingExcerpts(diffFiles: DiffFile[]): SiblingGroup[] {
  // Output shape: [{diff_file, siblings: [{path, head_excerpt}]}, ...]
  const t0 = Date.now();
  const out: SiblingGroup[] = [];
  const codeExtRe = /\.(py|ts|tsx|js|jsx|go|rs|java)$/;
  for (const f of diffFiles) {
    const fn = f.filename;
    const fnDir = pathDirname(fn);
    const d = join(CLONE_DIR, fnDir === "." ? "" : fnDir);
    if (!existsSync(d)) continue;
    const fnBase = fn.split(/[\\/]/).pop() ?? "";
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      continue;
    }
    const siblings: Sibling[] = [];
    for (const name of entries) {
      if (name === fnBase) continue;
      if (!codeExtRe.test(name)) continue;
      const full = join(d, name);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      const text = _safeReadText(full);
      if (text === null) continue;
      const content = cpSlice(text, 0, MAX_SIBLING_HEAD_CHARS);
      const rel = _relativeToClone(full);
      siblings.push({ path: rel, head_excerpt: content });
      if (siblings.length >= MAX_SIBLINGS_PER_FILE) break;
    }
    if (siblings.length > 0) out.push({ diff_file: fn, siblings });
  }
  process.stderr.write(
    `[local] sibling_excerpts=${out.length} in ${((Date.now() - t0) / 1000).toFixed(2)}s\n`,
  );
  return out;
}

// ── conflict hints ────────────────────────────────────────────────────────────

interface ConflictHint {
  topic: string;
  doc_path: string;
  sibling_path: string;
  note: string;
}

function _allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const r = new RegExp(re.source, flags);
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    out.push(m);
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
}

function _extractCaptured(m: RegExpExecArray): string {
  // Mirrors Python: re.findall returns the value of the first non-empty group when
  // any groups exist. With one capture group, that group's value; with multiple, the
  // first truthy one. Without groups, the whole match.
  if (m.length <= 1) return m[0] ?? "";
  for (let i = 1; i < m.length; i++) {
    if (m[i]) return m[i];
  }
  return "";
}

function findConflictHints(
  docExcerpts: DocExcerpt[],
  siblingExcerpts: SiblingGroup[],
): ConflictHint[] {
  const hints: ConflictHint[] = [];
  for (const topic of Object.keys(_CONFLICT_PATTERNS)) {
    const pat = _CONFLICT_PATTERNS[topic];
    const docHits: Array<[string, string]> = [];
    for (const d of docExcerpts) {
      for (const m of _allMatches(pat, d.excerpt)) {
        const val = _extractCaptured(m);
        if (val) docHits.push([d.path, val]);
      }
    }
    if (docHits.length === 0) continue;
    for (const sg of siblingExcerpts) {
      for (const sib of sg.siblings) {
        for (const m of _allMatches(pat, sib.head_excerpt)) {
          const val = _extractCaptured(m);
          if (!val) continue;
          for (const [docPath, docVal] of docHits) {
            const dV = docVal.trim();
            const sV = val.trim();
            if (dV === sV) continue;
            hints.push({
              topic,
              doc_path: docPath,
              sibling_path: sib.path,
              note: `doc shows \`${dV}\`, sibling uses \`${sV}\``,
            });
          }
        }
      }
    }
  }
  const seen = new Set<string>();
  const deduped: ConflictHint[] = [];
  for (const h of hints) {
    const k = `${h.topic}\u0000${h.doc_path}\u0000${h.sibling_path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(h);
  }
  return deduped;
}

// ── PR title (optional gh CLI) ────────────────────────────────────────────────

function _fetchPrTitle(owner: string, repo: string, num: number): string {
  try {
    const stdout = execFileSync(
      "gh",
      ["api", `repos/${owner}/${repo}/pulls/${num}`, "--jq", ".title"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

// ── entry point ───────────────────────────────────────────────────────────────

function gather(prRef: string): Record<string, unknown> {
  const { owner, repo, num } = parsePrUrl(prRef);
  const tWall = Date.now();

  const { diff: diffRaw, headSha } = fetchPrDiff(num);
  const diffFiles = parseDiffFiles(diffRaw, num);
  process.stderr.write(`[parse] ${diffFiles.length} changed files\n`);

  const prTitle = _fetchPrTitle(owner, repo, num);

  const docExcerpts = gatherDocExcerpts(diffFiles);
  const siblingExcerpts = gatherSiblingExcerpts(diffFiles);
  const conflictHints = findConflictHints(docExcerpts, siblingExcerpts);

  process.stderr.write(
    `[gather] total ${((Date.now() - tWall) / 1000).toFixed(1)}s  ` +
      `docs=${docExcerpts.length}  siblings=${siblingExcerpts.length}  ` +
      `hints=${conflictHints.length}\n`,
  );
  return {
    owner,
    repo,
    pr_number: num,
    pr_title: prTitle,
    head_sha: headSha,
    diff_files: diffFiles,
    doc_excerpts: docExcerpts,
    sibling_excerpts: siblingExcerpts,
    conflict_hints: conflictHints,
  };
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
    process.stderr.write("usage: gather_pattern_local.ts <pr-url-or-owner/repo#N>\n");
    return 2;
  }

  let result: Record<string, unknown>;
  try {
    result = gather(args[0]);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Not a recognised PR reference")) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    if (e instanceof Error && e.stack) {
      process.stderr.write(`${e.stack}\n`);
    }
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return 1;
  }

  process.stdout.write(JSON.stringify(result));
  process.stdout.write("\n");
  return 0;
}

process.exit(main());
