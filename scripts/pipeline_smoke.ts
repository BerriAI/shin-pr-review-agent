/**
 * End-to-end smoke for the migrated Cursor SDK pipeline.
 *
 * Calls reviewPr() directly (triage + pattern + karpathy + fuse) on the v2
 * smoke set, scores agent verdict against human_label, writes results.
 *
 * Run:
 *   npx tsx --env-file .env scripts/pipeline_smoke.ts eval/pr_set_v2_smoke.json
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "../app/db.js";
import { initSystemPrompts, reviewPr } from "../app/review.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

interface PrEntry {
  url: string;
  category?: string;
  human_label?: "ready" | "not_ready" | null;
}
interface PrSet {
  prs: PrEntry[];
}

function verdictFromCard(card: string): "ready" | "not_ready" | "waiting" {
  if (/✅\s*READY/.test(card)) return "ready";
  if (/⏳\s*WAITING/.test(card)) return "waiting";
  return "not_ready";
}

async function main() {
  const setPath = process.argv[2] ?? "eval/pr_set_v2_smoke.json";
  const prSet: PrSet = JSON.parse(readFileSync(`${REPO_ROOT}/${setPath}`, "utf8"));

  await db.initDb().catch((e) => {
    console.warn("db.initDb failed (continuing without DB persistence):", String(e).slice(0, 200));
  });
  initSystemPrompts();

  console.log(`pipeline smoke: ${prSet.prs.length} PRs, set=${setPath}`);
  const CONCURRENCY = parseInt(process.env.SMOKE_CONCURRENCY ?? "2", 10);

  const results: any[] = [];
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= prSet.prs.length) return;
      const pr = prSet.prs[idx];
      console.log(`  [${idx + 1}/${prSet.prs.length}] ${pr.url} …`);
      const t0 = Date.now();
      try {
        const { card, drilldown, runId } = await reviewPr(pr.url, {
          source: "smoke",
          onProgress: (msg) => process.stdout.write(`    · ${msg}\n`),
        });
        const verdict = verdictFromCard(card);
        const dt = (Date.now() - t0) / 1000;
        const agree = pr.human_label
          ? (verdict === "ready" && pr.human_label === "ready") ||
            (verdict !== "ready" && pr.human_label === "not_ready")
          : null;
        const tag = agree === true ? "✓" : agree === false ? "✗" : "·";
        console.log(`    ${tag} agent=${verdict} human=${pr.human_label} ${dt.toFixed(1)}s`);
        results.push({
          url: pr.url, human_label: pr.human_label ?? null, agent_verdict: verdict,
          agree, duration_s: dt, run_id: runId, card, drilldown,
        });
      } catch (e) {
        const dt = (Date.now() - t0) / 1000;
        console.log(`    ✗ ERROR ${dt.toFixed(1)}s — ${String(e).slice(0, 200)}`);
        results.push({
          url: pr.url, human_label: pr.human_label ?? null, agent_verdict: "error",
          agree: null, duration_s: dt, error: String(e),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const graded = results.filter((r) => r.agree !== null);
  const agree = graded.filter((r) => r.agree).length;
  const errors = results.filter((r) => r.agent_verdict === "error").length;

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = `${REPO_ROOT}/eval/results/pipeline_${ts}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    `${outDir}/results.json`,
    JSON.stringify({ schema: "pipeline-smoke/v1", set: setPath, ts, summary: { graded: graded.length, agree, errors }, results }, null, 2),
  );

  console.log("\n=== summary ===");
  console.log(`  graded: ${graded.length}/${results.length}  errors: ${errors}`);
  console.log(`  agreement: ${agree}/${graded.length}`);
  console.log(`  results: ${outDir}/results.json`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
