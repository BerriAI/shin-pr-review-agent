import type { DiffFile, Gate } from "./types.js";

// Hard size limits. A PR that breaches any of these almost always fails human
// review on the first pass (too many concerns to track, hard to revert, hard
// to bisect). We block the LLM pipeline and ask the author to split before
// maintainer review.
export const MAX_FILE_ADDED_LOC = 500;
export const MAX_FILES_CHANGED = 20;
export const MAX_TOTAL_CHURN = 2000;
// Tests outweighing code by more than this multiple usually means tests are
// over-specified for a small change, or the feature is too thin to justify
// the surface area being tested.
export const MAX_TEST_TO_CODE_RATIO = 3;

const TEST_PATH_RE = /(^|\/)tests?\//;

function isTest(f: DiffFile): boolean {
  return TEST_PATH_RE.test(f.filename);
}

// Aggregate the per-file diff into the scalar facts both `evaluate` and
// `evidence` need (file count, additions, deletions). Pulling this into a
// helper avoids re-iterating diff_files twice when both methods run on the
// same GatherData.
function summarizeDiff(g: { diff_files: DiffFile[] }) {
  const files = g.diff_files;
  let totalAdds = 0;
  let totalDels = 0;
  for (const f of files) {
    totalAdds += f.additions;
    totalDels += f.deletions;
  }
  return {
    files_changed: files.length,
    additions: totalAdds,
    deletions: totalDels,
  };
}

export const sizeGate: Gate = {
  name: "size",
  evaluate: (g, overrides) => {
    if (overrides.oversized_ok) return null;

    const files = g.diff_files;
    const filesChanged = files.length;
    let totalAdds = 0;
    let totalDels = 0;
    let testAdds = 0;
    let codeAdds = 0;
    const oversizedFiles: string[] = [];
    for (const f of files) {
      totalAdds += f.additions;
      totalDels += f.deletions;
      if (f.additions > MAX_FILE_ADDED_LOC) {
        oversizedFiles.push(`${f.filename} (+${f.additions})`);
      }
      if (isTest(f)) testAdds += f.additions;
      else codeAdds += f.additions;
    }
    const churn = totalAdds + totalDels;

    if (oversizedFiles.length > 0) {
      return {
        category: "size",
        reason: `Size gate: ${oversizedFiles.length} file(s) over ${MAX_FILE_ADDED_LOC} added LOC — split first (${oversizedFiles.slice(0, 3).join(", ")}${oversizedFiles.length > 3 ? ", …" : ""}). Add the \`oversized-ok\` label or a \`Big-PR-Approved: <handle>\` trailer if a maintainer has signed off.`,
      };
    }
    if (filesChanged > MAX_FILES_CHANGED) {
      return {
        category: "size",
        reason: `Size gate: ${filesChanged} files changed (limit ${MAX_FILES_CHANGED}) — split into focused PRs. Add the \`oversized-ok\` label or a \`Big-PR-Approved: <handle>\` trailer if a maintainer has signed off.`,
      };
    }
    if (churn > MAX_TOTAL_CHURN) {
      return {
        category: "size",
        reason: `Size gate: ${churn} total LOC churned (limit ${MAX_TOTAL_CHURN}) — split first. Add the \`oversized-ok\` label or a \`Big-PR-Approved: <handle>\` trailer if a maintainer has signed off.`,
      };
    }
    // Only flag test/code ratio when there's enough code to make the ratio
    // meaningful — a PR with 5 LOC of code and 30 LOC of tests is fine.
    if (codeAdds >= 50 && testAdds > codeAdds * MAX_TEST_TO_CODE_RATIO) {
      return {
        category: "size",
        reason: `Size gate: tests (+${testAdds}) exceed code (+${codeAdds}) by more than ${MAX_TEST_TO_CODE_RATIO}× — over-specified or feature too thin. Add the \`oversized-ok\` label if intentional.`,
      };
    }
    return null;
  },
  evidence: (g, overrides) => ({
    ...summarizeDiff(g),
    oversized_ok: overrides.oversized_ok,
  }),
};
