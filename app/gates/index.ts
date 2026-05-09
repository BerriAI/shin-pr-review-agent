import type {
  Gate,
  GateBlock,
  GateEvaluation,
  GatherData,
  Overrides,
} from "./types.js";
import { greptileGate } from "./greptile.js";
import { sizeGate } from "./size.js";
import { loggingScreenshotGate } from "./logging_screenshot.js";
import { parseOverrides } from "./overrides.js";

// Order matters: cheapest signal first, broadest blast radius last. The
// observability refactor evaluates every gate (no short-circuit) so we always
// persist a full row of evidence; `firstBlock` on the return preserves the
// short-circuit semantics callers want for early-return + verdict shaping.
const GATES: Gate[] = [
  greptileGate,
  sizeGate,
  loggingScreenshotGate,
];

// Coerce the gather script's loosely-typed JSON into the narrow GatherData
// shape the gates consume. Centralises field defaults so individual gates
// do not litter `?? []` / `?? ""` everywhere.
export function toGatherData(raw: Record<string, unknown>): GatherData {
  return {
    pr_number: (raw.pr_number as number | undefined) ?? 0,
    pr_title: (raw.pr_title as string | undefined) ?? "",
    pr_body: (raw.pr_body as string | undefined) ?? "",
    pr_labels: (raw.pr_labels as string[] | undefined) ?? [],
    pr_comments: (raw.pr_comments as string[] | undefined) ?? [],
    diff_files: (raw.diff_files as GatherData["diff_files"] | undefined) ?? [],
    greptile_score: (raw.greptile_score as number | null | undefined) ?? null,
  };
}

// Evaluate every gate and return both the full evaluations array (for
// observability persistence) and the first blocking gate (for callers that
// want short-circuit early-return + verdict semantics). The first-block tie
// to GATES order is intentional: gates are ordered cheapest-signal-first, so
// `firstBlock` matches what the legacy short-circuit `runGates` would have
// returned.
export function runGates(
  g: GatherData,
  o?: Overrides,
): { evaluations: GateEvaluation[]; firstBlock: GateBlock | null } {
  const overrides = o ?? parseOverrides(g);
  const evaluations: GateEvaluation[] = [];
  let firstBlock: GateBlock | null = null;
  for (const gate of GATES) {
    const block = gate.evaluate(g, overrides);
    evaluations.push({
      gate: gate.name,
      blocked: block !== null,
      reason: block ? block.reason : null,
      evidence: gate.evidence(g, overrides),
    });
    if (block && firstBlock === null) firstBlock = block;
  }
  return { evaluations, firstBlock };
}

export type {
  Gate,
  GateBlock,
  GateCategory,
  GateEvaluation,
  GatherData,
  Overrides,
} from "./types.js";
export { parseOverrides } from "./overrides.js";
