#!/usr/bin/env -S npx tsx
/**
 * End-to-end smoke for the observability infra (gate_results, fuse_trace,
 * timing, automerge_decision, karpathy tool_trace).
 *
 * Runs reviewPr() against a real BerriAI/litellm PR, then asserts each
 * persistence layer (DB row → /runs API → /chat/stream LLM dump) actually
 * surfaces the new debug fields.
 *
 * Run:
 *   # local server already on :8081
 *   npx tsx --env-file .env scripts/smoke_observability.ts
 *
 *   # override the target PR
 *   OBS_SMOKE_PR_URL=https://github.com/BerriAI/litellm/pull/26468 \
 *     npx tsx --env-file .env scripts/smoke_observability.ts
 *
 *   # or via argv
 *   npx tsx --env-file .env scripts/smoke_observability.ts \
 *     https://github.com/BerriAI/litellm/pull/26468
 *
 * Env:
 *   OBS_SMOKE_PR_URL  PR url to review (default: a recent closed BerriAI/litellm PR)
 *   SERVER_URL        base URL for API + chat probes (default http://localhost:8081)
 *   PORT              fallback port if SERVER_URL unset (default 8081)
 *   BOT_API_KEY       bearer token if the server has BOT_API_KEYS configured
 *   OBS_SMOKE_TIMEOUT_MS  per-request timeout (default 600000)
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
import * as db from "../app/db.js";
import { initSystemPrompts, reviewPr } from "../app/review.js";

// --- Config ------------------------------------------------------------------

// Default PR: a recent closed/merged BerriAI/litellm PR. PR #26468 is the
// same one scripts/smoke_chat_cursor.ts uses as its canonical target — it's
// closed, has Greptile review history, and has been reliable for smokes.
// If this becomes stale, override with OBS_SMOKE_PR_URL or the first argv.
const DEFAULT_PR_URL = "https://github.com/BerriAI/litellm/pull/26468";
const PR_URL =
  process.env.OBS_SMOKE_PR_URL ?? process.argv[2] ?? DEFAULT_PR_URL;

const PORT = process.env.PORT ?? "8081";
const SERVER_URL = (process.env.SERVER_URL ?? `http://localhost:${PORT}`).replace(
  /\/$/,
  "",
);
const BOT_API_KEY = process.env.BOT_API_KEY ?? "";
const TIMEOUT_MS = parseInt(process.env.OBS_SMOKE_TIMEOUT_MS ?? "600000", 10);

// --- Pretty output (chalk if available, plain otherwise) --------------------

type Painter = (s: string) => string;
let green: Painter = (s) => s;
let red: Painter = (s) => s;
let dim: Painter = (s) => s;
try {
  // chalk is optional — fall back to no-color if not installed.
  const chalk: any = (await import("chalk")).default;
  green = (s) => chalk.green(s);
  red = (s) => chalk.red(s);
  dim = (s) => chalk.dim(s);
} catch {
  /* no chalk; plain output */
}

let passed = 0;
let failed = 0;
function pass(name: string, detail?: string): void {
  passed++;
  console.log(`  ${green("PASS")} ${name}${detail ? ` ${dim(`— ${detail}`)}` : ""}`);
}
function fail(name: string, detail: string): void {
  failed++;
  console.log(`  ${red("FAIL")} ${name} — ${detail}`);
}
function check(name: string, cond: boolean, detail = ""): boolean {
  if (cond) {
    pass(name, detail);
    return true;
  }
  fail(name, detail || "assertion failed");
  return false;
}

function bail(msg: string): never {
  console.error(`\n${red("✗ smoke aborted:")} ${msg}`);
  process.exit(1);
}

// --- Helpers -----------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (BOT_API_KEY) h.authorization = `Bearer ${BOT_API_KEY}`;
  return h;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain an SSE response body into a single assistant text string. The
 * /chat/stream endpoint emits events of shape:
 *   data: {"type":"text_delta","delta":"..."}\n\n
 *   data: {"type":"tool_call",...}\n\n
 *   data: {"type":"done","output":"...full...","tool_trace":[...]}\n\n
 * We prefer the final `done.output` (it's the canonical assistant text the
 * server assembled), falling back to concatenated `text_delta` chunks.
 */
async function readSseStream(resp: Response): Promise<{
  fullText: string;
  events: Array<Record<string, unknown>>;
}> {
  if (!resp.body) return { fullText: "", events: [] };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let deltaText = "";
  let doneOutput: string | null = null;
  const events: Array<Record<string, unknown>> = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank line ("\n\n").
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // Each frame can have multiple "data: ..." lines; only data: matters.
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(payload);
        } catch {
          continue;
        }
        events.push(obj);
        if (obj.type === "text_delta" && typeof obj.delta === "string") {
          deltaText += obj.delta;
        } else if (obj.type === "done" && typeof obj.output === "string") {
          doneOutput = obj.output;
        } else if (obj.type === "error") {
          throw new Error(
            `chat stream errored: ${String(obj.message ?? "(no message)")}`,
          );
        }
      }
    }
  }
  return {
    fullText: doneOutput ?? deltaText,
    events,
  };
}

// --- Main flow ---------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    `${dim("smoke_observability")} server=${SERVER_URL} authed=${BOT_API_KEY ? "yes" : "no"}`,
  );
  console.log(`${dim("target PR:")} ${PR_URL}`);

  // 0. Init shared infra (DB pool, system prompts).
  console.log(`\n[0/6] init db + system prompts`);
  try {
    await db.initDb();
  } catch (e) {
    bail(
      `db.initDb failed — is DATABASE_URL set and Postgres reachable? ${String(e).slice(0, 200)}`,
    );
  }
  initSystemPrompts();
  pass("db + prompts initialized");

  // 1. Run reviewPr against the target PR.
  console.log(`\n[1/6] reviewPr(${PR_URL})`);
  const t0 = Date.now();
  let runId: string;
  try {
    const r = await reviewPr(PR_URL, {
      source: "smoke",
      onProgress: (msg) => process.stdout.write(`    ${dim("·")} ${dim(msg)}\n`),
    });
    runId = r.runId;
  } catch (e) {
    bail(`reviewPr threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  const dtReview = ((Date.now() - t0) / 1000).toFixed(1);
  pass(`reviewPr completed`, `runId=${runId} (${dtReview}s)`);

  // 2. Query the DB row.
  console.log(`\n[2/6] db.getRun(${runId})`);
  const row = await db.getRun(runId);
  if (!row) bail(`db.getRun returned null for runId=${runId}`);
  const card = row.card as { verdict?: string } | null;
  const verdict = card?.verdict ?? "(none)";
  pass(`row fetched`, `verdict=${verdict}`);

  // 3. Assert observability fields populated.
  console.log(`\n[3/6] assert observability fields on DB row`);
  const gateResults = row.gate_results as unknown[] | undefined;
  check(
    "gate_results is a non-empty array",
    Array.isArray(gateResults) && gateResults.length >= 1,
    `got ${Array.isArray(gateResults) ? `length=${gateResults.length}` : typeof gateResults}`,
  );

  const fuseTrace = row.fuse_trace as unknown[] | undefined;
  check(
    "fuse_trace is a non-empty array",
    Array.isArray(fuseTrace) && fuseTrace.length >= 1,
    `got ${Array.isArray(fuseTrace) ? `length=${fuseTrace.length}` : typeof fuseTrace}`,
  );

  const timing = row.timing as Record<string, unknown> | undefined;
  check(
    "timing is a non-empty object",
    !!timing && typeof timing === "object" && Object.keys(timing).length > 0,
    `keys=${timing ? Object.keys(timing).join(",") : "(none)"}`,
  );
  check(
    "timing.total_ms is a positive number",
    typeof timing?.total_ms === "number" && (timing.total_ms as number) > 0,
    `total_ms=${timing?.total_ms}`,
  );

  // karpathy_check.tool_trace — only required if karpathy actually ran.
  // Karpathy fires only when the pre-karpathy verdict was READY.
  const karp = row.karpathy_check as { status?: string; tool_trace?: unknown } | null;
  if (karp && karp.status === "ok") {
    check(
      "karpathy_check.tool_trace is an array (status=ok)",
      Array.isArray(karp.tool_trace),
      `got ${typeof karp.tool_trace}`,
    );
  } else {
    pass(
      "karpathy_check skipped or non-ok",
      `status=${karp?.status ?? "(unset)"} (no tool_trace assertion)`,
    );
  }

  // automerge_decision — only required if final verdict was READY AND the
  // auto-merge hook is registered. The hook is registered in app/server.ts's
  // bootstrap (setAutoMergeHook(autoMergeReadyPr)). When this smoke runs as
  // a standalone script (direct reviewPr import), server.ts is not loaded so
  // _autoMergeHook is undefined and no decision row is written. That matches
  // production semantics: only the running server attempts auto-merge.
  // We treat this case as informational, not a failure, so the smoke is
  // useful both standalone (this branch) and end-to-end (via webhook).
  const automerge = row.automerge_decision as
    | { decision?: string; reason?: string }
    | null
    | undefined;
  if (verdict === "READY") {
    if (automerge != null) {
      check(
        "automerge_decision present (verdict=READY)",
        true,
        `decision=${automerge.decision} reason=${automerge.reason}`,
      );
      check(
        "automerge_decision.reason is a string",
        typeof automerge?.reason === "string" && automerge.reason.length > 0,
        `reason=${automerge?.reason}`,
      );
    } else {
      pass(
        "automerge_decision skipped (no hook in standalone smoke)",
        "verdict=READY but reviewPr ran without server.ts bootstrap; auto-merge path covered by webhook smoke",
      );
    }
  } else {
    pass(
      "automerge_decision skipped (verdict!=READY)",
      `verdict=${verdict} — hook never fires`,
    );
  }

  // 4. Hit the /runs/api/runs/:id endpoint.
  console.log(`\n[4/6] GET ${SERVER_URL}/runs/api/runs/${runId}`);
  let apiRow: Record<string, unknown>;
  try {
    const apiResp = await fetchWithTimeout(
      `${SERVER_URL}/runs/api/runs/${runId}`,
      { headers: authHeaders() },
    );
    if (!apiResp.ok) {
      bail(
        `API returned ${apiResp.status}: ${(await apiResp.text()).slice(0, 400)}`,
      );
    }
    apiRow = (await apiResp.json()) as Record<string, unknown>;
  } catch (e) {
    bail(
      `API fetch failed — is the server running on ${SERVER_URL}? ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  pass("API responded 200");
  check(
    "API exposes gate_results",
    Array.isArray(apiRow.gate_results),
    `got ${typeof apiRow.gate_results}`,
  );
  check(
    "API exposes fuse_trace",
    Array.isArray(apiRow.fuse_trace),
    `got ${typeof apiRow.fuse_trace}`,
  );
  check(
    "API exposes timing",
    "timing" in apiRow && !!apiRow.timing && typeof apiRow.timing === "object",
    `got ${typeof apiRow.timing}`,
  );
  // automerge_decision + merge_error keys must always be present (nullable).
  check(
    "API includes automerge_decision key",
    "automerge_decision" in apiRow,
    "key missing from response",
  );
  check(
    "API includes merge_error key",
    "merge_error" in apiRow,
    "key missing from response",
  );

  // 5. Ask the chat LLM to explain the run.
  console.log(`\n[5/6] POST ${SERVER_URL}/chat/stream`);
  const chatMessage =
    verdict === "READY"
      ? "Why did this PR merge (or fail to merge)? Walk me through the gates that ran, the fuse rules that fired, and the automerge decision."
      : "Why was this PR not READY? Walk me through the gates that ran and the fuse rules that fired.";
  let chatText = "";
  try {
    const chatResp = await fetchWithTimeout(`${SERVER_URL}/chat/stream`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        run_id: runId,
        thread_id: `smoke-${Date.now()}`,
        message: chatMessage,
        title: "smoke",
      }),
    });
    if (!chatResp.ok) {
      bail(
        `chat returned ${chatResp.status}: ${(await chatResp.text()).slice(0, 400)}`,
      );
    }
    const drained = await readSseStream(chatResp);
    chatText = drained.fullText;
  } catch (e) {
    bail(
      `chat fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  pass("chat stream drained", `outputLen=${chatText.length}`);

  const lower = chatText.toLowerCase();
  const refs = ["gate", "fuse", "automerge", "timing"].filter((k) =>
    lower.includes(k),
  );
  check(
    "chat references >= 2 of {gate, fuse, automerge, timing}",
    refs.length >= 2,
    `matched=[${refs.join(",")}] preview="${chatText.slice(0, 400).replace(/\s+/g, " ")}"`,
  );

  // 6. Summary.
  console.log(`\n[6/6] summary`);
  const summary = {
    runId,
    verdict,
    gate_results_len: Array.isArray(gateResults) ? gateResults.length : null,
    fuse_trace_len: Array.isArray(fuseTrace) ? fuseTrace.length : null,
    total_ms: typeof timing?.total_ms === "number" ? timing.total_ms : null,
    automerge: automerge?.decision ?? "(n/a)",
    chat_refs: refs,
  };
  console.log(dim(JSON.stringify(summary, null, 2)));

  if (failed > 0) {
    console.log(`\n${red(`✗ ${failed} check(s) failed`)} (${passed} passed)`);
    process.exit(1);
  }
  console.log(
    `\n${green("✓ all observability smoke checks passed")} (${passed} checks)`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(
    `\n${red("✗ smoke crashed:")} ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
  );
  process.exit(1);
});
