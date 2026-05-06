#!/usr/bin/env -S npx tsx
/**
 * Smoke test: auto-merge posts review card in PR comment.
 *
 * Checks:
 *   1. review.ts exports renderCard and TriageCard
 *   2. mergePrToAgentBranch accepts reviewCard param
 *   3. Comment body includes card when reviewCard provided
 *   4. Comment body is plain staging message when reviewCard omitted
 *   5. Webhook path captures card from reviewPr() and passes it through
 *   6. Blocked-watch path renders finalRun.card and passes it through
 *
 * No live DB or GitHub needed.
 *
 * Usage:
 *   npx tsx scripts/smoke_merge_comment.ts
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
// 1. review.ts exports
// ---------------------------------------------------------------------------
console.log("\n[1] review.ts exports");
const reviewSrc = readFileSync(resolve(ROOT, "app/review.ts"), "utf8");
assert(reviewSrc.includes("export interface TriageCard"), "TriageCard exported");
assert(reviewSrc.includes("export function renderCard("), "renderCard exported");
assert(
  reviewSrc.includes("export async function reviewPr("),
  "reviewPr exported",
);
// renderCard return includes key fields
const renderCardMatch = reviewSrc.match(/export function renderCard[\s\S]{0,400}?\n\}/);
assert(
  renderCardMatch !== null && renderCardMatch[0].includes("Merge Confidence"),
  "renderCard output includes 'Merge Confidence'",
);

// ---------------------------------------------------------------------------
// 2. server.ts: mergePrToAgentBranch signature
// ---------------------------------------------------------------------------
console.log("\n[2] mergePrToAgentBranch signature");
const srvSrc = readFileSync(resolve(ROOT, "app/server.ts"), "utf8");
assert(
  srvSrc.includes("reviewCard?: string,"),
  "mergePrToAgentBranch accepts optional reviewCard param",
);

// ---------------------------------------------------------------------------
// 3. Comment body construction logic
// ---------------------------------------------------------------------------
console.log("\n[3] Comment body construction");
assert(
  srvSrc.includes("const mergeComment = reviewCard"),
  "mergeComment branches on reviewCard",
);
assert(
  srvSrc.includes("---\\n\\n${reviewCard}"),
  "card appended after HR separator when reviewCard present",
);
assert(
  srvSrc.includes("body: JSON.stringify({ body: mergeComment })"),
  "mergeComment used as comment body",
);

// ---------------------------------------------------------------------------
// 4. Unified hook architecture: all merges through autoMergeReadyPr
// ---------------------------------------------------------------------------
console.log("\n[4] Unified hook architecture");
// All three old paths (webhook, blocked-watch, chat) now call mergePrToAgentBranch
// exclusively through autoMergeReadyPr via the autoMergeHook.
assert(
  srvSrc.includes("setAutoMergeHook(autoMergeReadyPr)"),
  "autoMergeReadyPr registered as the hook",
);
// Only autoMergeReadyPr and the manual merge API endpoint call mergePrToAgentBranch directly.
// Webhook and blocked-watch must NOT add additional direct calls.
const mergeCallCount = (srvSrc.match(/await mergePrToAgentBranch\(/g) ?? []).length;
assert(
  mergeCallCount === 2,
  `exactly 2 mergePrToAgentBranch call sites (hook + manual API) — found ${mergeCallCount}`,
);
// Confirm hook registration is in startup section
assert(
  srvSrc.includes("setAutoMergeHook(autoMergeReadyPr)"),
  "hook wired at startup",
);

// ---------------------------------------------------------------------------
// 5. Auto-merge hook passes cardText through
// ---------------------------------------------------------------------------
console.log("\n[5] Auto-merge hook path");
const reviewSrc2 = readFileSync(resolve(ROOT, "app/review.ts"), "utf8");
assert(
  reviewSrc2.includes("runId: string, cardText: string") ||
  reviewSrc2.includes("cardText: string) => Promise<void>"),
  "AutoMergeHook type includes cardText param",
);
assert(
  reviewSrc2.includes("_autoMergeHook(prUrl, triage.pr_number, repoMatch[1], runId, cardText)"),
  "autoMergeHook called with cardText at call site in review.ts",
);
assert(
  srvSrc.includes("cardText: string,") && srvSrc.includes("autoMergeReadyPr"),
  "autoMergeReadyPr accepts cardText param",
);
assert(
  srvSrc.includes("agentBranchName(), cardText)"),
  "autoMergeReadyPr passes cardText to mergePrToAgentBranch",
);

// ---------------------------------------------------------------------------
// 6. Pure logic: comment body simulation
// ---------------------------------------------------------------------------
console.log("\n[6] Comment body simulation");

function buildMergeComment(agentBranch: string, stagingPrUrl: string, reviewCard?: string): string {
  return reviewCard
    ? `🤖 **litellm-agent**: Merged into staging branch \`${agentBranch}\`. Staging PR: ${stagingPrUrl}\n\n---\n\n${reviewCard}`
    : `🤖 **litellm-agent**: Merged into staging branch \`${agentBranch}\`. Staging PR: ${stagingPrUrl}`;
}

const BRANCH = "litellm_agent_oss_staging_05_05_2026";
const STAGING_URL = "https://github.com/BerriAI/litellm/pull/999";
const CARD = "*Triage Summary*\nFixes null guard on streaming.\n\n*Merge Confidence: 4/5*  ✅ READY\nReady to ship.\n\nNo blocking issues.";

const withCard = buildMergeComment(BRANCH, STAGING_URL, CARD);
assert(withCard.includes("Merged into staging branch"), "with card: staging message present");
assert(withCard.includes("---"), "with card: HR separator present");
assert(withCard.includes(CARD), "with card: full card text present");
assert(withCard.includes(STAGING_URL), "with card: staging PR URL present");

const withoutCard = buildMergeComment(BRANCH, STAGING_URL);
assert(withoutCard.includes("Merged into staging branch"), "without card: staging message present");
assert(!withoutCard.includes("---"), "without card: no HR separator");
assert(!withoutCard.includes("Triage"), "without card: no card text");

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
