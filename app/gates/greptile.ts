import type { Gate } from "./types.js";

// Anyone with a GitHub account can open a PR; running the full LLM pipeline
// on every drive-by PR is both expensive and a prompt-injection surface (PR
// body / diff / CI logs / comments all reach the model). We require Greptile
// to have rated the PR ≥ MIN_SCORE before spending the LLM call.
export const GREPTILE_GATE_MIN_SCORE = 4;

export function greptileGatePass(score: number | null): boolean {
  return typeof score === "number" && score >= GREPTILE_GATE_MIN_SCORE;
}

export const greptileGate: Gate = {
  name: "greptile",
  evaluate: (g) => {
    if (greptileGatePass(g.greptile_score)) return null;
    const score = g.greptile_score;
    const scoreStr = score === null ? "not yet reviewed" : `${score}/5`;
    return {
      category: "greptile",
      reason: `Greptile gate: score ${scoreStr} below required ${GREPTILE_GATE_MIN_SCORE}/5 — request a Greptile review (\`@greptileai\`) and resolve its comments before maintainer review.`,
    };
  },
  evidence: (g) => ({
    score: g.greptile_score,
    reason:
      g.greptile_score === null
        ? "not yet reviewed"
        : greptileGatePass(g.greptile_score)
          ? `score ${g.greptile_score}/5 ≥ required ${GREPTILE_GATE_MIN_SCORE}/5`
          : `score ${g.greptile_score}/5 below required ${GREPTILE_GATE_MIN_SCORE}/5`,
  }),
};
