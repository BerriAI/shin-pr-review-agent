/**
 * Minimal eval: validate @cursor/sdk could replace the Karpathy / triage stage
 * of the PR review pipeline. Runs the karpathy.md skill against a PR set,
 * extracts the last-line JSON verdict, maps to ready/not_ready, scores
 * agreement vs human_label.
 *
 * Setup:
 *   npm install @cursor/sdk
 *   export CURSOR_API_KEY=...
 *   export CURSOR_MODEL=composer-2   # or claude-4-7-sonnet, etc.
 *
 * Run:
 *   npx tsx scripts/cursor_eval.ts eval/pr_set_v2_smoke.json
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore — installed separately, not in package.json yet
import { Agent } from "@cursor/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

interface PrEntry {
  url: string;
  category?: string;
  notes?: string;
  human_label?: "ready" | "not_ready" | null;
  human_notes?: string;
}
interface PrSet {
  repo: string;
  prs: PrEntry[];
}

interface PrResult {
  url: string;
  human_label: string | null;
  agent_verdict: "ready" | "not_ready" | "error";
  agent_gate: string | null;
  one_liner: string;
  duration_s: number;
  raw_json: unknown;
  agree: boolean | null;
  error?: string;
}

function loadKarpathySkill(): string {
  const body = readFileSync(`${REPO_ROOT}/skills/karpathy.md`, "utf8");
  // Strip frontmatter
  return body.replace(/^---[\s\S]*?---\n/, "");
}

function extractLastJson(text: string): unknown | null {
  const lines = text.trim().split("\n").reverse();
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("{")) {
      try {
        return JSON.parse(t);
      } catch {
        /* continue */
      }
    }
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* */
    }
  }
  return null;
}

function gateToVerdict(gate: string | undefined): "ready" | "not_ready" {
  // Karpathy schema: safe_for_high_rps_gateway = yes | conditional | no
  // Map: yes -> ready, conditional/no -> not_ready (mirrors fuse() logic
  // where conditional/no docks score 2/5 from an otherwise-ready PR).
  return gate === "yes" ? "ready" : "not_ready";
}

async function reviewOne(
  pr: PrEntry,
  systemPrompt: string,
  apiKey: string,
  modelId: string,
): Promise<PrResult> {
  const t0 = Date.now();
  const userPrompt = `${systemPrompt}\n\n---\n\nReview this PR: ${pr.url}\n\nReturn the JSON verdict on the LAST LINE as a single-line object.`;

  try {
    const agent = await Agent.create({
      apiKey,
      name: `pr-eval-${pr.url.split("/").pop()}`,
      model: { id: modelId },
      local: { cwd: REPO_ROOT },
    });

    const run = await agent.send(userPrompt);
    let assistantText = "";
    for await (const event of run.stream()) {
      if (event.type !== "assistant") continue;
      for (const block of event.message?.content ?? []) {
        if (block.type === "text") assistantText += block.text;
      }
    }
    await run.wait?.();

    const raw = extractLastJson(assistantText);
    const gate = (raw as any)?.merge_gate?.safe_for_high_rps_gateway;
    const liner = (raw as any)?.merge_gate?.one_liner ?? "";
    const verdict = raw ? gateToVerdict(gate) : "error";
    const duration = (Date.now() - t0) / 1000;

    return {
      url: pr.url,
      human_label: pr.human_label ?? null,
      agent_verdict: verdict,
      agent_gate: gate ?? null,
      one_liner: liner,
      duration_s: duration,
      raw_json: raw,
      agree:
        pr.human_label && verdict !== "error"
          ? pr.human_label === verdict
          : null,
    };
  } catch (e) {
    return {
      url: pr.url,
      human_label: pr.human_label ?? null,
      agent_verdict: "error",
      agent_gate: null,
      one_liner: "",
      duration_s: (Date.now() - t0) / 1000,
      raw_json: null,
      agree: null,
      error: String(e),
    };
  }
}

async function main() {
  const setPath = process.argv[2] ?? "eval/pr_set_v2_smoke.json";
  const apiKey = process.env.CURSOR_API_KEY;
  const modelId = process.env.CURSOR_MODEL ?? "composer-2";
  if (!apiKey) {
    console.error("CURSOR_API_KEY not set");
    process.exit(1);
  }

  const prSet: PrSet = JSON.parse(
    readFileSync(`${REPO_ROOT}/${setPath}`, "utf8"),
  );
  const systemPrompt = loadKarpathySkill();

  console.log(
    `cursor-sdk eval: ${prSet.prs.length} PRs, model=${modelId}, set=${setPath}`,
  );

  // Bounded concurrency = 2 (Cursor SDK pricing is per-token; throttle to
  // avoid burst spend during validation runs).
  const CONCURRENCY = parseInt(process.env.EVAL_CONCURRENCY ?? "2", 10);
  const results: PrResult[] = [];
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= prSet.prs.length) return;
      const pr = prSet.prs[idx];
      console.log(`  [${idx + 1}/${prSet.prs.length}] ${pr.url} …`);
      const r = await reviewOne(pr, systemPrompt, apiKey!, modelId);
      results.push(r);
      const tag = r.agree === true ? "✓" : r.agree === false ? "✗" : "·";
      console.log(
        `    ${tag} agent=${r.agent_verdict} (gate=${r.agent_gate}) human=${r.human_label} ${r.duration_s.toFixed(1)}s`,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Confusion matrix
  const graded = results.filter((r) => r.agree !== null);
  const agree = graded.filter((r) => r.agree).length;
  const tp = graded.filter(
    (r) => r.human_label === "ready" && r.agent_verdict === "ready",
  ).length;
  const tn = graded.filter(
    (r) => r.human_label === "not_ready" && r.agent_verdict === "not_ready",
  ).length;
  const fp = graded.filter(
    (r) => r.human_label === "not_ready" && r.agent_verdict === "ready",
  ).length;
  const fn = graded.filter(
    (r) => r.human_label === "ready" && r.agent_verdict === "not_ready",
  ).length;
  const errors = results.filter((r) => r.agent_verdict === "error").length;

  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const outDir = `${REPO_ROOT}/eval/results/cursor_${ts}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    `${outDir}/results.json`,
    JSON.stringify(
      {
        schema: "cursor-sdk-eval/v1",
        model: modelId,
        set: setPath,
        ts,
        summary: { graded: graded.length, agree, tp, tn, fp, fn, errors },
        results,
      },
      null,
      2,
    ),
  );

  console.log("\n=== summary ===");
  console.log(`  graded: ${graded.length}/${results.length}  errors: ${errors}`);
  console.log(`  agreement: ${agree}/${graded.length}`);
  console.log(`  tp=${tp}  tn=${tn}  fp=${fp}  fn=${fn}`);
  console.log(`  results: ${outDir}/results.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
