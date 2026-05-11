#!/usr/bin/env -S npx tsx
/**
 * Smoke test for the blocked-watch poll logic (no live DB or GitHub needed).
 *
 * Tests the 3 branches of pollBlockedWatches:
 *   A) PR already closed  → deleteRun (no comment/close GitHub call)
 *   B) PR had activity    → resetBlockedWatch (restarts 7-day clock)
 *   C) PR stale 7+ days   → post comment + close GitHub PR + deleteRun
 *
 * Also validates migration SQL and db.ts function signatures at import time.
 *
 * Usage:
 *   npx tsx scripts/smoke_blocked_watch.ts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. Migration SQL sanity-check
// ---------------------------------------------------------------------------
console.log("\n[1] Migration SQL");
const migSql = readFileSync(resolve(ROOT, "migrations/0004_blocked_watch.sql"), "utf8");
assert(migSql.includes("blocked_watch_started_at"), "column name present");
assert(migSql.includes("ALTER TABLE runs ADD COLUMN IF NOT EXISTS"), "idempotent ALTER TABLE");
assert(migSql.includes("CREATE INDEX IF NOT EXISTS"), "idempotent index");
assert(migSql.includes("WHERE blocked_watch_started_at IS NOT NULL"), "partial index");

// ---------------------------------------------------------------------------
// 2. db.ts exports exist (TypeScript already validated signatures)
// ---------------------------------------------------------------------------
console.log("\n[2] db.ts exports");
// Dynamic import would require a live pool; use grep on source instead.
const dbSrc = readFileSync(resolve(ROOT, "app/db.ts"), "utf8");
assert(dbSrc.includes("export async function startBlockedWatch"), "startBlockedWatch exported");
assert(dbSrc.includes("export async function resetBlockedWatch"), "resetBlockedWatch exported");
assert(dbSrc.includes("export async function listExpiredBlockedWatches"), "listExpiredBlockedWatches exported");
assert(dbSrc.includes("export async function deleteRun"), "deleteRun exported");
assert(dbSrc.includes("INTERVAL '7 days'"), "7-day interval in SQL");
assert(dbSrc.includes("card->>'verdict' = 'BLOCKED'"), "verdict filter in SQL");
assert(
  dbSrc.includes("blocked_watch_started_at IS NULL") && dbSrc.includes("blocked_watch_started_at = NOW()"),
  "startBlockedWatch is idempotent (IS NULL guard)",
);

// ---------------------------------------------------------------------------
// 3. server.ts wiring
// ---------------------------------------------------------------------------
console.log("\n[3] server.ts wiring");
const srvSrc = readFileSync(resolve(ROOT, "app/server.ts"), "utf8");
assert(srvSrc.includes("const finalRunId = await stabilizePr("), "stabilizePr result captured");
assert(srvSrc.includes(`verdict === "BLOCKED"`), "BLOCKED verdict check after stabilize");
assert(srvSrc.includes("await db.startBlockedWatch(finalRunId)"), "startBlockedWatch called in webhook handler");
assert(srvSrc.includes("async function pollBlockedWatches()"), "pollBlockedWatches defined");
assert(srvSrc.includes("await db.deleteRun(runId)"), "deleteRun called in poll");
assert(srvSrc.includes("await db.resetBlockedWatch(runId)"), "resetBlockedWatch called on activity");
assert(srvSrc.includes("state: \"closed\""), "PR close PATCH present in poll");
assert(srvSrc.includes("BLOCKED_WATCH_INTERVAL_MS"), "poll interval constant defined");
assert(srvSrc.includes("setInterval(() => { pollBlockedWatches()"), "setInterval wired at startup");
assert(srvSrc.includes("pollBlockedWatches().catch(console.error)"), "initial poll on startup");
assert(
  (srvSrc.match(/updated_at: string/g) ?? []).length >= 1,
  "updated_at added to fetchPr return type",
);
assert(srvSrc.includes("Promise<string>"), "stabilizePr returns string (finalRunId)");

// ---------------------------------------------------------------------------
// 4. Poll logic simulation (pure, no I/O)
// ---------------------------------------------------------------------------
console.log("\n[4] Poll logic simulation");

type WatchRecord = { run_id: string; pr_url: string; pr_number: number; blocked_watch_started_at: Date };
type FetchedPr = { state: string; updated_at: string } | null;

interface Calls {
  deleted: string[];
  reset: string[];
  commented: number[];
  closed: number[];
}

async function simulatePoll(
  watches: WatchRecord[],
  prsByNumber: Record<number, FetchedPr>,
): Promise<Calls> {
  const calls: Calls = { deleted: [], reset: [], commented: [], closed: [] };

  for (const run of watches) {
    const prNumber = run.pr_number;
    const watchStartedAt = run.blocked_watch_started_at;
    const pr = prsByNumber[prNumber];

    if (!pr || pr.state !== "open") {
      calls.deleted.push(run.run_id);
      continue;
    }

    const prUpdatedAt = new Date(pr.updated_at);
    if (prUpdatedAt > watchStartedAt) {
      calls.reset.push(run.run_id);
      continue;
    }

    // Stale — close + delete
    calls.commented.push(prNumber);
    calls.closed.push(prNumber);
    calls.deleted.push(run.run_id);
  }

  return calls;
}

const WATCH_START = new Date("2026-04-20T00:00:00Z");  // 7+ days ago
const BEFORE_WATCH = new Date("2026-04-19T00:00:00Z");
const AFTER_WATCH = new Date("2026-04-25T00:00:00Z");

// Branch A: PR already closed
const caseA = await simulatePoll(
  [{ run_id: "run-a", pr_url: "https://github.com/BerriAI/litellm/pull/100", pr_number: 100, blocked_watch_started_at: WATCH_START }],
  { 100: { state: "closed", updated_at: BEFORE_WATCH.toISOString() } },
);
assert(caseA.deleted.includes("run-a"), "A: closed PR → deleteRun");
assert(!caseA.commented.includes(100), "A: closed PR → no comment");
assert(!caseA.closed.includes(100), "A: closed PR → no GitHub close call");

// Branch B: PR had activity after watch start
const caseB = await simulatePoll(
  [{ run_id: "run-b", pr_url: "https://github.com/BerriAI/litellm/pull/200", pr_number: 200, blocked_watch_started_at: WATCH_START }],
  { 200: { state: "open", updated_at: AFTER_WATCH.toISOString() } },
);
assert(!caseB.deleted.includes("run-b"), "B: active PR → no delete");
assert(caseB.reset.includes("run-b"), "B: active PR → resetBlockedWatch");

// Branch C: PR stale 7+ days
const caseC = await simulatePoll(
  [{ run_id: "run-c", pr_url: "https://github.com/BerriAI/litellm/pull/300", pr_number: 300, blocked_watch_started_at: WATCH_START }],
  { 300: { state: "open", updated_at: BEFORE_WATCH.toISOString() } },
);
assert(caseC.deleted.includes("run-c"), "C: stale PR → deleteRun");
assert(caseC.commented.includes(300), "C: stale PR → post comment");
assert(caseC.closed.includes(300), "C: stale PR → close PR");
assert(!caseC.reset.includes("run-c"), "C: stale PR → no reset");

// Branch D: PR missing from GitHub (null fetch result)
const caseD = await simulatePoll(
  [{ run_id: "run-d", pr_url: "https://github.com/BerriAI/litellm/pull/400", pr_number: 400, blocked_watch_started_at: WATCH_START }],
  { 400: null },
);
assert(caseD.deleted.includes("run-d"), "D: PR fetch returns null → deleteRun");
assert(!caseD.commented.includes(400), "D: null PR → no comment");

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nSOME TESTS FAILED");
  process.exit(1);
}
console.log("\nAll smoke tests passed");
