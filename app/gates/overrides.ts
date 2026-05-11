import type { GatherData, Overrides } from "./types.js";

// PR label that bypasses the size gate. Maintainer-applied; signals the PR is
// big on purpose (mass rename, lib bump, codegen).
export const OVERSIZED_OK_LABEL = "oversized-ok";

// Commit-trailer form, parsed from the PR body. Lets a contributor request a
// size override inline without needing label-write permissions on the repo.
// Shape: `Big-PR-Approved: <handle>` on its own line in the PR body.
const BIG_PR_APPROVED_RE = /^Big-PR-Approved:\s*\S+/im;

export function parseOverrides(g: GatherData): Overrides {
  const oversized_ok =
    g.pr_labels.some((l) => l.toLowerCase() === OVERSIZED_OK_LABEL) ||
    BIG_PR_APPROVED_RE.test(g.pr_body);
  return { oversized_ok };
}
