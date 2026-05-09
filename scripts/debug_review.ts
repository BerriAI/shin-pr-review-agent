#!/usr/bin/env -S npx tsx
/**
 * One-shot local test for the triage pipeline.
 *
 * Boots the Pi SDK registry, assembles system prompts, then calls reviewPr()
 * for the given PR URL. Prints all the new debug output so we can diagnose
 * why greptile_score lands at null on PR 27150.
 *
 * Usage: npx tsx scripts/debug_review.ts [pr_url]
 *   default pr_url: https://github.com/BerriAI/litellm/pull/27150
 */
import { initRegistry, initSystemPrompts, reviewPr } from "../app/review.js";

async function main() {
  const prUrl = process.argv[2] ?? "https://github.com/BerriAI/litellm/pull/27150";
  console.log(`[test] starting reviewPr for ${prUrl}`);
  await initRegistry();
  initSystemPrompts();
  const t0 = Date.now();
  try {
    const { card, drilldown, runId, toolTrace } = await reviewPr(prUrl, {
      source: "debug-script",
      onProgress: (m) => console.log(`[test progress] ${m}`),
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[test] DONE in ${elapsed}s runId=${runId} toolTrace=${toolTrace.length}`);
    console.log(`\n=== CARD ===\n${card}`);
    console.log(`\n=== DRILLDOWN ===\n${drilldown}`);
  } catch (e) {
    console.error(`[test] FAILED:`, e);
    process.exitCode = 1;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
