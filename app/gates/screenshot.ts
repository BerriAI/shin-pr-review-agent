import type { Gate } from "./types.js";

// Markers that count as visual proof in the PR body or comments.
// Mirrors SCREENSHOT_MARKERS in logging_screenshot.ts.
const SCREENSHOT_MARKERS: RegExp[] = [
  /!\[[^\]]*\]\([^)]+\)/,
  /https?:\/\/(?:private-)?user-images\.githubusercontent\.com\//i,
  /https?:\/\/github\.com\/[^/]+\/[^/]+\/assets\//i,
  /<img\s+[^>]*src=/i,
];

// Label that opts a PR out of this gate (e.g. pure-docs, CI-only changes).
const EXEMPT_LABEL = "screenshot-exempt";

function hasScreenshot(text: string): boolean {
  return SCREENSHOT_MARKERS.some((re) => re.test(text));
}

export const screenshotGate: Gate = {
  name: "screenshot",
  evaluate: (g, _o) => {
    if (g.pr_labels.includes(EXEMPT_LABEL)) return null;

    const haystack = [g.pr_body, ...g.pr_comments].join("\n\n");
    if (hasScreenshot(haystack)) return null;

    return {
      category: "screenshot",
      reason:
        "Screenshot gate: no screenshot or visual proof found in PR body or comments. " +
        "Paste a screenshot showing the fix or feature working. " +
        `Add the \`${EXEMPT_LABEL}\` label if this PR has no visible output (e.g. pure docs, CI config).`,
    };
  },
  evidence: (_g, _o) => {
    const haystack = [_g.pr_body, ..._g.pr_comments].join("\n\n");
    return {
      has_screenshot: hasScreenshot(haystack),
      exempt: _g.pr_labels.includes(EXEMPT_LABEL),
    };
  },
};
