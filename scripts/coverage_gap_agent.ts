/**
 * Test Coverage Gap Agent — minimal script using @cursor/sdk.
 *
 * For a given PR, the agent:
 *   1. Fetches the diff and identifies new filters / guards / allowlists
 *   2. Greps the litellm repo to enumerate all input classes that reach each guard
 *   3. Checks whether each input class has a dedicated test
 *   4. Emits a JSON gap report
 *
 * Run:
 *   CURSOR_API_KEY=... npx tsx scripts/coverage_gap_agent.ts [pr-url]
 *
 * Example:
 *   CURSOR_API_KEY=... npx tsx scripts/coverage_gap_agent.ts https://github.com/BerriAI/litellm/pull/27769
 */

// @ts-ignore — @cursor/sdk ships ESM types
import { Agent } from "@cursor/sdk";

const CURSOR_API_KEY = process.env.CURSOR_API_KEY;
const CURSOR_MODEL   = process.env.CURSOR_MODEL ?? "claude-sonnet-4-6";
const LITELLM_REPO   = "https://github.com/BerriAI/litellm";

const PR_URL = process.argv[2] ?? "https://github.com/BerriAI/litellm/pull/27769";

if (!CURSOR_API_KEY) {
  console.error("CURSOR_API_KEY not set");
  process.exit(1);
}

const SYSTEM = `\
You are a test coverage gap detector for the BerriAI/litellm repository.
You do NOT review code quality, logic correctness, or style.
Your ONLY job: find untested input classes for new filters/guards/allowlists.

CRITICAL: Do NOT narrate your steps. Do NOT output prose during your search.
Run all tool calls silently. When done, output ONLY the final JSON — nothing else.

## Process

1. Fetch the PR diff (web_fetch the /files page or .diff URL).
2. Find every new filter/guard/allowlist added (if x not in list, filter(lambda…), assert x in allowed).
3. For each guard: grep the repo to find all values that flow into the guarded list.
   Focus on: functions that populate the list, call sites, config fixtures.
4. For each input class found: grep tests/ to check if a test covers it through this guard.
5. Output the JSON below — last line, single-line object, nothing after it.

{
  "pr": "<pr_url>",
  "guards": [
    {
      "guard_fn": "<function or expression>",
      "file": "<path>",
      "line": <number>,
      "input_classes": [
        {
          "name": "<input class name>",
          "example": "<concrete example value>",
          "source": "<where this value originates in the codebase>",
          "has_test": <true|false>,
          "test_file": "<path or null>",
          "suggested_test": "<suggested test function name if has_test=false>"
        }
      ]
    }
  ],
  "gaps": <number of input_classes where has_test=false>,
  "verdict": "<BLOCKED if gaps > 0, else COVERED>"
}`;

async function main() {
  console.log(`[coverage-gap] pr=${PR_URL}`);
  console.log(`[coverage-gap] model=${CURSOR_MODEL} repo=${LITELLM_REPO}`);

  const t0 = Date.now();
  const agent = await Agent.create({
    apiKey: CURSOR_API_KEY,
    name: "coverage-gap-agent",
    model: { id: CURSOR_MODEL },
    cloud: {
      repos: [{ url: LITELLM_REPO }],
      envVars: {},
    },
  });
  console.log(`[coverage-gap] agent created in ${Date.now() - t0}ms`);

  const prompt = `${SYSTEM}\n\n---\n\nAnalyse this PR for test coverage gaps: ${PR_URL}\n\nReturn the JSON verdict on the LAST LINE as a single-line object.`;

  console.log(`[coverage-gap] sending prompt (${prompt.length} chars)…`);
  const t1 = Date.now();
  const run = await agent.send(prompt);

  let assistantText = "";
  let eventCount = 0;

  for await (const event of run.stream() as AsyncIterable<any>) {
    eventCount++;
    const t = event?.type;
    if (t === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block?.type === "text") assistantText += block.text;
      }
    } else if (t === "tool_call") {
      const name = event.tool ?? event.name ?? "unknown";
      const args = JSON.stringify(event.args ?? {}).slice(0, 120);
      console.log(`  [tool] ${name} ${args}`);
    } else if (t === "tool_result") {
      const name = event.tool ?? event.name ?? "unknown";
      const preview = JSON.stringify(event.result ?? "").slice(0, 80);
      console.log(`  [result] ${name} → ${preview}`);
    }
  }
  await (run as any).wait?.();

  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\n[coverage-gap] done in ${elapsed}s  events=${eventCount}  outputLen=${assistantText.length}`);

  // Extract last-line JSON
  const lines = assistantText.trim().split("\n").reverse();
  let report: unknown = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("{")) {
      try { report = JSON.parse(t); break; } catch { /* keep looking */ }
    }
  }

  if (!report) {
    // Fallback: try to find any JSON block
    const m = assistantText.match(/\{[\s\S]*\}/);
    if (m) {
      try { report = JSON.parse(m[0]); } catch { /* */ }
    }
  }

  console.log("\n=== COVERAGE GAP REPORT ===");
  if (report) {
    console.log(JSON.stringify(report, null, 2));
    const r = report as any;
    const verdict = r.verdict ?? "UNKNOWN";
    const gaps = r.gaps ?? "?";
    console.log(`\nverdict=${verdict}  gaps=${gaps}`);
    process.exit(verdict === "COVERED" ? 0 : 1);
  } else {
    console.log("[coverage-gap] could not extract JSON from output");
    console.log("\n--- raw output ---");
    console.log(assistantText);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("[coverage-gap] threw:", e);
  process.exit(1);
});
