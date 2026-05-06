#!/usr/bin/env -S npx tsx
/**
 * Gather everything needed to triage a single GitHub PR via LiteLLM MCP.
 *
 * All GitHub API calls go through the LiteLLM MCP proxy — no GITHUB_TOKEN needed.
 *
 * Required env:
 *     LITELLM_API_BASE   - LiteLLM proxy base URL
 *     LITELLM_API_KEY    - LiteLLM API key
 *
 * Usage:
 *     npx tsx gather_pr_triage_data.ts https://github.com/owner/repo/pull/123
 *
 * Direct port of gather_pr_triage_data.py — keeps function names, JSON shape, and
 * tuning constants identical so the existing TS callers / agent skills don't change.
 */

const OTHER_PRS_SAMPLE_SIZE = 3;
const MAX_PATCH_CHARS = 2000;
const MAX_LOG_CHARS = 3000;

const _GH_ACTIONS_JOB_URL_RE =
  /https?:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/actions\/runs\/\d+\/job\/(?<job_id>\d+)/;
// eslint-disable-next-line no-control-regex
const _ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const _FAILURE_MARKERS: RegExp[] = [
  /\bTraceback \(most recent call last\):/g,
  /(?<!\S)Exception:/g,
  /(?<!\S)FAILED /g,
  /##\[error\]/g,
  /(?<!\S)Error:/g,
  /(?<!\S)error:/g,
];
// Real Greptile bot account on GitHub. Confirmed against
// https://github.com/BerriAI/litellm/pull/27256 — the bot user has
// login="greptile-apps[bot]" and type="Bot". We require BOTH to match so
// an attacker cannot register a normal account whose name happens to
// contain "greptile" and spoof a high score in their own PR.
export const GREPTILE_BOT_LOGIN = "greptile-apps[bot]";
export function isGreptileBotUser(u: unknown): boolean {
  if (!u || typeof u !== "object") return false;
  const obj = u as { login?: unknown; type?: unknown };
  return obj.login === GREPTILE_BOT_LOGIN && obj.type === "Bot";
}
const _GREPTILE_SCORE_RE = /confidence\s*score[^0-9]{0,10}([1-5])\s*\/\s*5/i;
const _GREPTILE_SCORE_FALLBACK_RE = /\b([1-5])\s*\/\s*5\b/;
const _CIRCLECI_NAME_RE = /(^|\/)circleci(\s*[:/]|\b)/i;

const _POLICY_META_CHECK_SUBSTRINGS = [
  "verify pr source branch",
  "dco",
  "cla/cla-bot",
  "cla-assistant",
  "license/cla",
  "signed-off-by",
  "semantic-pull-request",
  "semantic pull request",
];

function _isPolicyMetaCheck(name: string): boolean {
  const n = name.toLowerCase();
  return _POLICY_META_CHECK_SUBSTRINGS.some((s) => n.includes(s));
}

function _extractFailureWindow(text: string, maxChars: number = MAX_LOG_CHARS): string {
  // Note: lengths are in JS UTF-16 code units (Python uses codepoints). They
  // disagree on non-BMP chars (emoji), but CI failure logs are practically
  // always ASCII so the divergence — if any — is benign. Kept simple by design.
  if (text.length <= maxChars) return text;
  for (const marker of _FAILURE_MARKERS) {
    const matches: RegExpExecArray[] = [];
    const re = new RegExp(marker.source, marker.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      matches.push(m);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    if (matches.length === 0) continue;
    const last = matches[matches.length - 1];
    const start = Math.max(0, last.index - 200);
    const end = Math.min(text.length, start + maxChars);
    const prefix = start > 0 ? "...[truncated]\n" : "";
    const suffix = end < text.length ? "\n...[truncated]" : "";
    return `${prefix}${text.slice(start, end)}${suffix}`;
  }
  return "...[truncated]\n" + text.slice(text.length - maxChars);
}

const PR_URL_RE = /github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<num>\d+)/;
const PR_SHORT_RE = /^(?<owner>[^/\s]+)\/(?<repo>[^#\s]+)#(?<num>\d+)$/;

function parsePrUrl(url: string): { owner: string; repo: string; num: number } {
  const m = PR_URL_RE.exec(url) ?? PR_SHORT_RE.exec(url.trim());
  if (!m || !m.groups) throw new Error(`Not a recognised PR reference: ${url}`);
  return { owner: m.groups.owner, repo: m.groups.repo, num: parseInt(m.groups.num, 10) };
}

// --------------------------------------------------------------------------- //
// Async concurrency helper                                                    //
// --------------------------------------------------------------------------- //

class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits++;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// --------------------------------------------------------------------------- //
// LiteLLM MCP client                                                          //
// --------------------------------------------------------------------------- //

interface McpResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

class _LiteLLMMcp {
  /** Minimal MCP (Streamable HTTP) client for the LiteLLM proxy.
   *
   * Handles all GitHub API calls — no GITHUB_TOKEN required.
   * The proxy returns SSE-framed responses; we parse those by hand.
   * Trailing slash on /mcp/ avoids a 307 redirect on every call.
   */
  url: string;
  headers: Record<string, string>;
  private _sem: Semaphore;

  constructor(baseUrl: string, apiKey: string, maxConcurrency = 8) {
    this.url = baseUrl.replace(/\/+$/, "") + "/mcp/";
    this.headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-litellm-api-key": `Bearer ${apiKey}`,
    };
    this._sem = new Semaphore(maxConcurrency);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpResult | null> {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    };
    let r: Response;
    try {
      r = await this._sem.run(() =>
        fetchWithTimeout(
          this.url,
          {
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(body),
          },
          // Python uses post(timeout=60) wrapped in wait_for(timeout=10). Match the outer
          // (effective) timeout to keep behavior identical: the outer is the binding limit.
          10_000,
        ),
      );
    } catch {
      return null;
    }
    if (!r.ok) return null;
    const text = await r.text();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data: ")) continue;
      let obj: { error?: unknown; result?: unknown };
      try {
        obj = JSON.parse(line.slice("data: ".length));
      } catch {
        continue;
      }
      if (obj.error !== undefined) return null;
      const res = obj.result;
      if (res && typeof res === "object" && !Array.isArray(res)) return res as McpResult;
    }
    return null;
  }

  _extractText(res: McpResult): string {
    const parts: string[] = [];
    for (const c of res.content ?? []) {
      if (c && typeof c === "object" && c.type === "text") {
        parts.push(c.text ?? "");
      }
    }
    return parts.join("\n").trim();
  }

  async ghJson(tool: string, args: Record<string, unknown>): Promise<any> {
    const res = await this.callTool(tool, args);
    if (res === null || res.isError) throw new Error(`MCP tool '${tool}' failed`);
    const text = this._extractText(res);
    if (!text) throw new Error(`MCP tool '${tool}' returned empty content`);
    return JSON.parse(text);
  }

  async ghText(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.callTool(tool, args);
    if (res === null) return "";
    return this._extractText(res);
  }

  async ghList(
    tool: string,
    args: Record<string, unknown>,
    listKey: string | null = null,
  ): Promise<any[]> {
    const items: any[] = [];
    let page = 1;
    const perPage = 100;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const data = await this.ghJson(tool, { ...args, per_page: perPage, page });
      const batch = listKey ? data?.[listKey] ?? [] : data;
      if (!Array.isArray(batch)) break;
      items.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }
    return items;
  }
}

// --------------------------------------------------------------------------- //
// Check enumeration                                                           //
// --------------------------------------------------------------------------- //

async function _listCheckRuns(
  mcp: _LiteLLMMcp,
  owner: string,
  repo: string,
  sha: string,
): Promise<any[]> {
  const runs = await mcp.ghList(
    "github_openapi_mcp-checks/list-for-ref",
    { owner, repo, ref: sha },
    "check_runs",
  );
  const latest: Record<string, any> = {};
  for (const r of runs) {
    latest[r.name] = r;
  }
  return Object.values(latest);
}

async function _listClassicStatuses(
  mcp: _LiteLLMMcp,
  owner: string,
  repo: string,
  sha: string,
): Promise<any[]> {
  let combined: any;
  try {
    combined = await mcp.ghJson(
      "github_openapi_mcp-repos/get-combined-status-for-ref",
      { owner, repo, ref: sha },
    );
  } catch {
    return [];
  }
  const statuses = combined?.statuses ?? [];
  const stateToConclusion: Record<string, string | null> = {
    success: "success",
    failure: "failure",
    error: "failure",
    pending: null,
  };
  const out: any[] = [];
  for (const s of statuses) {
    const state = s.state;
    const conclusion = stateToConclusion[state] ?? null;
    out.push({
      id: null,
      name: s.context,
      conclusion,
      status: conclusion ? "completed" : "in_progress",
      html_url: s.target_url,
      output: { summary: s.description, text: null },
    });
  }
  return out;
}

async function _allChecks(
  mcp: _LiteLLMMcp,
  owner: string,
  repo: string,
  sha: string,
): Promise<any[]> {
  const [runs, statuses] = await Promise.all([
    _listCheckRuns(mcp, owner, repo, sha),
    _listClassicStatuses(mcp, owner, repo, sha),
  ]);
  const byName: Record<string, any> = {};
  for (const s of statuses) byName[s.name] = s;
  for (const r of runs) byName[r.name] = r;
  return Object.values(byName);
}

function _hasCircleciChecks(checks: any[]): boolean {
  for (const c of checks ?? []) {
    const name = c?.name ?? "";
    if (_CIRCLECI_NAME_RE.test(name)) return true;
    const app = c?.app ?? {};
    const slug = (app?.slug ?? "").toLowerCase();
    if (slug.includes("circleci")) return true;
    const htmlUrl = c?.html_url ?? "";
    if (htmlUrl.includes("circleci.com")) return true;
  }
  return false;
}

// --------------------------------------------------------------------------- //
// Per-failure enrichment                                                      //
// --------------------------------------------------------------------------- //

async function _fetchAnnotations(
  mcp: _LiteLLMMcp,
  owner: string,
  repo: string,
  runId: number | null,
): Promise<string[]> {
  if (runId === null || runId === undefined) return [];
  let ann: any;
  try {
    ann = await mcp.ghJson("github_openapi_mcp-checks/list-annotations", {
      owner,
      repo,
      check_run_id: runId,
      per_page: 20,
      page: 1,
    });
  } catch {
    return [];
  }
  if (!Array.isArray(ann)) return [];
  const out: string[] = [];
  for (const a of ann) {
    const msg = (a?.message ?? "").trim();
    const path = a?.path ?? "";
    const line = a?.start_line;
    out.push(`${path}:${line}: ${msg}`.slice(0, 300));
  }
  return out;
}

const _MCP_TRUNCATION_PRELUDE_RE = /^\s*<MCPTruncationWarning>[\s\S]*?<\/MCPTruncationWarning>\s*/;

async function _fetchCircleciFailureLog(
  mcp: _LiteLLMMcp,
  htmlUrl: string | null,
): Promise<string | null> {
  if (!htmlUrl || !htmlUrl.includes("circleci.com")) return null;
  const res = await mcp.callTool("circle_ci_mcp-get_build_failure_logs", {
    params: { projectURL: htmlUrl },
  });
  if (!res || res.isError) return null;
  const parts: string[] = [];
  for (const c of res.content ?? []) {
    if (c && typeof c === "object" && c.type === "text") {
      parts.push(c.text ?? "");
    }
  }
  let text = parts.join("\n").trim();
  if (!text) return null;
  text = text.replace(_MCP_TRUNCATION_PRELUDE_RE, "");
  text = text.replace(_ANSI_ESCAPE_RE, "");
  return text.trim() ? _extractFailureWindow(text) : null;
}

async function _fetchActionsJobLog(
  mcp: _LiteLLMMcp,
  htmlUrl: string | null,
): Promise<string | null> {
  if (!htmlUrl) return null;
  const m = _GH_ACTIONS_JOB_URL_RE.exec(htmlUrl);
  if (!m || !m.groups) return null;
  let text: string;
  try {
    text = await mcp.ghText("github_openapi_mcp-actions/download-job-logs-for-workflow-run", {
      owner: m.groups.owner,
      repo: m.groups.repo,
      job_id: parseInt(m.groups.job_id, 10),
    });
  } catch {
    return null;
  }
  if (!text) return null;
  // If the tool returned a redirect URL rather than content, fetch it
  const stripped = text.trim();
  if (stripped.startsWith("http") && !stripped.includes("\n") && stripped.length < 500) {
    try {
      const r = await fetchWithTimeout(stripped, { redirect: "follow" }, 30_000);
      if (r.status === 200) {
        text = await r.text();
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }
  text = text.replace(_ANSI_ESCAPE_RE, "");
  return text.trim() ? _extractFailureWindow(text) : null;
}

// --------------------------------------------------------------------------- //
// PR-level fetches                                                            //
// --------------------------------------------------------------------------- //

async function _fetchDiff(
  mcp: _LiteLLMMcp,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<any[]> {
  const files = await mcp.ghList("github_openapi_mcp-pulls/list-files", {
    owner,
    repo,
    pull_number: prNumber,
  });
  const out: any[] = [];
  for (const f of files) {
    let patch: string | null = f.patch ?? null;
    if (patch && patch.length > MAX_PATCH_CHARS) {
      patch = patch.slice(0, MAX_PATCH_CHARS) + "\n...[truncated]";
    }
    out.push({
      filename: f.filename,
      status: f.status ?? "modified",
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch,
    });
  }
  return out;
}

async function _fetchOtherOpenPrs(
  mcp: _LiteLLMMcp,
  owner: string,
  repo: string,
  excludePr: number,
  n: number,
): Promise<any[]> {
  const pulls = await mcp.ghJson("github_openapi_mcp-pulls/list", {
    owner,
    repo,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: n + 5,
    page: 1,
  });
  if (!Array.isArray(pulls)) return [];
  return pulls.filter((p: any) => p.number !== excludePr).slice(0, n);
}

async function _fetchGreptileScore(
  mcp: _LiteLLMMcp,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  let reviews: any[];
  let comments: any[];
  try {
    [reviews, comments] = await Promise.all([
      mcp.ghList("github_openapi_mcp-pulls/list-reviews", {
        owner,
        repo,
        pull_number: prNumber,
      }),
      mcp.ghList("github_openapi_mcp-issues/list-comments", {
        owner,
        repo,
        issue_number: prNumber,
      }),
    ]);
  } catch {
    return null;
  }

  const candidates: Array<[string, string]> = [];
  for (const r of reviews ?? []) {
    if (isGreptileBotUser(r?.user)) {
      candidates.push([r.submitted_at ?? "", r.body ?? ""]);
    }
  }
  for (const c of comments ?? []) {
    if (isGreptileBotUser(c?.user)) {
      candidates.push([c.created_at ?? "", c.body ?? ""]);
    }
  }
  candidates.sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  for (const [, body] of candidates) {
    const m = _GREPTILE_SCORE_RE.exec(body) ?? _GREPTILE_SCORE_FALLBACK_RE.exec(body);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Orchestration                                                               //
// --------------------------------------------------------------------------- //

async function _fetchPrWithMergeable(
  mcp: _LiteLLMMcp,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<any> {
  let pr = await mcp.ghJson("github_openapi_mcp-pulls/get", {
    owner,
    repo,
    pull_number: prNumber,
  });
  if (pr.mergeable === null || pr.mergeable === undefined) {
    await new Promise((r) => setTimeout(r, 1500));
    pr = await mcp.ghJson("github_openapi_mcp-pulls/get", {
      owner,
      repo,
      pull_number: prNumber,
    });
  }
  return pr;
}

async function gather(
  owner: string,
  repo: string,
  prNumber: number,
  mcp: _LiteLLMMcp,
): Promise<Record<string, unknown>> {
  const [pr, diffFiles, otherPrs, greptileScore] = await Promise.all([
    _fetchPrWithMergeable(mcp, owner, repo, prNumber),
    _fetchDiff(mcp, owner, repo, prNumber),
    _fetchOtherOpenPrs(mcp, owner, repo, prNumber, OTHER_PRS_SAMPLE_SIZE),
    _fetchGreptileScore(mcp, owner, repo, prNumber),
  ]);
  const headSha = pr.head.sha;

  let mergeable = pr.mergeable;
  let mergeableState = pr.mergeable_state;
  if (pr.state === "closed" && pr.merged_at) {
    mergeable = true;
    mergeableState = "clean";
  }

  const ownChecksTask = _allChecks(mcp, owner, repo, headSha);
  const otherChecksTasks = otherPrs.map((p: any) =>
    _allChecks(mcp, owner, repo, p.head.sha),
  );
  const allChecksResults = await Promise.all([ownChecksTask, ...otherChecksTasks]);
  const ownChecks = allChecksResults[0];
  const otherChecks = allChecksResults.slice(1);

  const passing: string[] = [];
  const inProgress: string[] = [];
  const failingRuns: any[] = [];
  for (const r of ownChecks) {
    const concl = r.conclusion;
    if (concl === "success" || concl === "neutral" || concl === "skipped") {
      passing.push(r.name);
    } else if (concl === "failure" || concl === "timed_out" || concl === "cancelled") {
      failingRuns.push(r);
    } else {
      inProgress.push(r.name);
    }
  }

  let annotationsPer: string[][] = [];
  let circleciLogsPer: Array<string | null> = [];
  let actionsLogsPer: Array<string | null> = [];
  if (failingRuns.length > 0) {
    [annotationsPer, circleciLogsPer, actionsLogsPer] = await Promise.all([
      Promise.all(failingRuns.map((r) => _fetchAnnotations(mcp, owner, repo, r.id ?? null))),
      Promise.all(failingRuns.map((r) => _fetchCircleciFailureLog(mcp, r.html_url ?? null))),
      Promise.all(failingRuns.map((r) => _fetchActionsJobLog(mcp, r.html_url ?? null))),
    ]);
  }

  const failureContexts: any[] = [];
  for (let i = 0; i < failingRuns.length; i++) {
    const r = failingRuns[i];
    const annList = annotationsPer[i];
    const cciLog = circleciLogsPer[i];
    const ghaLog = actionsLogsPer[i];
    const name = r.name;
    const output = r.output ?? {};
    let text: string = output.text ?? "";
    if (text.length > MAX_LOG_CHARS) {
      text = text.slice(0, MAX_LOG_CHARS) + "\n...[truncated]";
    }
    if (cciLog) {
      text = text
        ? `${text}\n\n--- CircleCI raw log tail ---\n${cciLog}`
        : `--- CircleCI raw log tail ---\n${cciLog}`;
    }
    if (ghaLog) {
      text = text
        ? `${text}\n\n--- GitHub Actions raw log tail ---\n${ghaLog}`
        : `--- GitHub Actions raw log tail ---\n${ghaLog}`;
    }
    const otherStatus: any[] = [];
    for (let j = 0; j < otherPrs.length; j++) {
      const p = otherPrs[j];
      const pChecks = otherChecks[j];
      const match = pChecks.find((c: any) => c.name === name) ?? null;
      otherStatus.push({
        pr_number: p.number,
        pr_title: p.title ?? "",
        found: match !== null,
        conclusion: match?.conclusion ?? null,
      });
    }
    const alsoFailingElsewhere = otherStatus.some(
      (p) => p.conclusion === "failure" || p.conclusion === "timed_out" || p.conclusion === "cancelled",
    );
    failureContexts.push({
      check_name: name,
      conclusion: r.conclusion,
      summary: output.summary,
      failure_excerpt: text || null,
      annotations: annList,
      html_url: r.html_url,
      other_prs: otherStatus,
      is_policy_meta: _isPolicyMetaCheck(name),
      also_failing_on_other_prs: alsoFailingElsewhere,
    });
  }

  return {
    owner,
    repo,
    pr_number: prNumber,
    pr_title: pr.title ?? "",
    pr_author: pr.user?.login ?? "",
    head_sha: headSha,
    passing_checks: passing,
    in_progress_checks: inProgress,
    failing_check_contexts: failureContexts,
    diff_files: diffFiles,
    other_pr_numbers: otherPrs.map((p: any) => p.number),
    greptile_score: greptileScore,
    has_circleci_checks: _hasCircleciChecks(ownChecks),
    mergeable,
    mergeable_state: mergeableState,
  };
}

// --------------------------------------------------------------------------- //
// Entry point                                                                 //
// --------------------------------------------------------------------------- //

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
    process.stderr.write(
      "usage: gather_pr_triage_data.ts <pr-url-or-owner/repo#N>\n",
    );
    process.exit(2);
  }

  let owner: string;
  let repo: string;
  let prNumber: number;
  try {
    ({ owner, repo, num: prNumber } = parsePrUrl(args[0]));
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    process.exit(2);
    return;
  }

  const litellmBase = process.env.LITELLM_API_BASE;
  const litellmKey = process.env.LITELLM_API_KEY;
  if (!litellmBase || !litellmKey) {
    process.stderr.write("error: LITELLM_API_BASE and LITELLM_API_KEY must be set\n");
    process.exit(1);
    return;
  }

  const mcp = new _LiteLLMMcp(litellmBase, litellmKey);

  let report: Record<string, unknown>;
  try {
    report = await gather(owner, repo, prNumber, mcp);
  } catch (exc) {
    process.stderr.write(`error: ${(exc as Error).message}\n`);
    process.exit(1);
    return;
  }

  process.stdout.write(JSON.stringify(report, null, 2));
  process.stdout.write("\n");
}

// Only auto-run main() when this file is the entry point — guards against
// importers (e.g. smoke tests, helpers) triggering a CLI usage exit.
const _isEntryPoint = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return import.meta.url === new URL(`file://${argv1}`).href;
  } catch {
    return false;
  }
})();
if (_isEntryPoint) {
  main().catch((e) => {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
