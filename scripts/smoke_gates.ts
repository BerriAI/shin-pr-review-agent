#!/usr/bin/env -S npx tsx
// Smoke test for the deterministic pre-review gates. No network, no LLM.
// Synthesises gather payloads matching real PR shapes and asserts the
// expected gate fires (or none does) for each.
//
// Run with: npx tsx scripts/smoke_gates.ts
import {
  runGates,
  parseOverrides,
  toGatherData,
  type GatherData,
} from "../app/gates/index.js";

let failed = 0;
let passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function base(overrides: Partial<GatherData> = {}): GatherData {
  return {
    pr_number: 1,
    pr_title: "test",
    pr_body: "",
    pr_labels: [],
    pr_comments: [],
    diff_files: [],
    greptile_score: 5,
    ...overrides,
  };
}

console.log("\n[1] Greptile gate");
check(
  "score 5 + small diff → no block",
  runGates(base({ diff_files: [{ filename: "x.py", additions: 10, deletions: 0 }] })).firstBlock === null,
);
check(
  "score null → greptile gate fires",
  runGates(base({ greptile_score: null })).firstBlock?.category === "greptile",
);
check(
  "score 3 → greptile gate fires",
  runGates(base({ greptile_score: 3 })).firstBlock?.category === "greptile",
);

console.log("\n[2] Size gate — file > 500 LOC");
const pr27228Like = base({
  diff_files: [
    { filename: "litellm/proxy/guardrails/.../unified_guardrail.py", additions: 553, deletions: 1 },
    { filename: "tests/.../test_unified_guardrail.py", additions: 630, deletions: 0 },
    { filename: "litellm/types/utils.py", additions: 1, deletions: 0 },
  ],
});
const block27228 = runGates(pr27228Like).firstBlock;
check(
  "PR 27228 shape (one file +553) → size gate fires",
  block27228?.category === "size",
  block27228?.reason,
);
check(
  "size gate reason mentions the offending file",
  !!block27228?.reason.includes("unified_guardrail.py"),
);

console.log("\n[3] Size gate — file count > 20");
const manyFiles: GatherData = base({
  diff_files: Array.from({ length: 25 }, (_, i) => ({
    filename: `f${i}.py`,
    additions: 10,
    deletions: 0,
  })),
});
check(
  "25 files → size gate fires",
  runGates(manyFiles).firstBlock?.category === "size",
);

console.log("\n[4] Size gate — total churn > 2000");
const bigChurn: GatherData = base({
  diff_files: [
    { filename: "a.py", additions: 400, deletions: 400 },
    { filename: "b.py", additions: 400, deletions: 400 },
    { filename: "c.py", additions: 400, deletions: 400 },
  ],
});
check(
  "2400 churn → size gate fires",
  runGates(bigChurn).firstBlock?.category === "size",
);

console.log("\n[5] Size gate — overrides bypass");
const oversizedWithLabel = base({
  diff_files: [{ filename: "big.py", additions: 600, deletions: 0 }],
  pr_labels: ["oversized-ok"],
});
check(
  "oversized-ok label → size gate skipped",
  runGates(oversizedWithLabel).firstBlock === null,
);
const oversizedWithTrailer = base({
  diff_files: [{ filename: "big.py", additions: 600, deletions: 0 }],
  pr_body: "Some description.\n\nBig-PR-Approved: maintainer\n",
});
check(
  "Big-PR-Approved trailer → size gate skipped",
  runGates(oversizedWithTrailer).firstBlock === null,
);

console.log("\n[6] Logging-screenshot gate");
const loggingNoShot = base({
  diff_files: [{ filename: "litellm/integrations/langfuse.py", additions: 30, deletions: 5 }],
  pr_body: "fixes a bug",
});
check(
  "logging change + no screenshot → gate fires",
  runGates(loggingNoShot).firstBlock?.category === "logging_screenshot",
);
const loggingWithShot = base({
  diff_files: [{ filename: "litellm/integrations/langfuse.py", additions: 30, deletions: 5 }],
  pr_body: "fixes a bug\n\n![before](https://user-images.githubusercontent.com/123/abc.png)\n",
});
check(
  "logging change + githubusercontent image → gate passes",
  runGates(loggingWithShot).firstBlock === null,
);
const loggingShotInComment = base({
  diff_files: [{ filename: "litellm/_logging.py", additions: 30, deletions: 5 }],
  pr_body: "fixes a bug",
  pr_comments: ["here is the proof: ![](https://github.com/x/y/assets/123/abc)"],
});
check(
  "logging change + screenshot in comment → gate passes",
  runGates(loggingShotInComment).firstBlock === null,
);
const nonLogging = base({
  diff_files: [{ filename: "litellm/types/utils.py", additions: 30, deletions: 5 }],
});
check(
  "non-logging change → logging gate does not fire",
  runGates(nonLogging).firstBlock === null,
);

console.log("\n[7] toGatherData defaults missing fields");
const td = toGatherData({ pr_number: 42, greptile_score: 5 });
check(
  "missing pr_body defaults to empty string",
  td.pr_body === "" && Array.isArray(td.pr_labels) && td.pr_labels.length === 0,
);
check(
  "missing diff_files defaults to empty array",
  Array.isArray(td.diff_files) && td.diff_files.length === 0,
);

console.log("\n[8] parseOverrides label is case-insensitive");
check(
  "OVERSIZED-OK uppercase label still parses",
  parseOverrides(base({ pr_labels: ["OVERSIZED-OK"] })).oversized_ok === true,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
