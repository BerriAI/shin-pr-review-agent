import type { Gate } from "./types.js";

// Files whose changes affect logging behavior. Narrow on purpose: edits to
// these directories have historically caused log-shape regressions that
// only surface in production dashboards. We require visual proof (a
// screenshot or paste) in the PR body or comments before spending an LLM
// review.
const LOGGING_PATH_RES: RegExp[] = [
  /^litellm\/_logging[^/]*\.py$/,
  /^litellm\/integrations\//,
];

// Markers that count as "screenshot or proof of fix":
//   - Markdown image: ![alt](url)
//   - GitHub user-uploaded asset URLs (the host that PR drag-and-drop uploads
//     hit): user-images.githubusercontent.com, private-user-images...,
//     and the `<repo>/assets/<id>` form GitHub now uses.
//   - HTML <img ...> tags (some authors paste raw HTML).
const SCREENSHOT_MARKERS: RegExp[] = [
  /!\[[^\]]*\]\([^)]+\)/,
  /https?:\/\/(?:private-)?user-images\.githubusercontent\.com\//i,
  /https?:\/\/github\.com\/[^/]+\/[^/]+\/assets\//i,
  /<img\s+[^>]*src=/i,
];

function touchesLogging(filename: string): boolean {
  return LOGGING_PATH_RES.some((re) => re.test(filename));
}

function hasScreenshot(text: string): boolean {
  return SCREENSHOT_MARKERS.some((re) => re.test(text));
}

export const loggingScreenshotGate: Gate = {
  name: "logging_screenshot",
  evaluate: (g) => {
    const loggingFiles = g.diff_files
      .filter((f) => touchesLogging(f.filename))
      .map((f) => f.filename);
    if (loggingFiles.length === 0) return null;

    const haystack = [g.pr_body, ...g.pr_comments].join("\n\n");
    if (hasScreenshot(haystack)) return null;

    const sample = loggingFiles.slice(0, 3).join(", ");
    const more = loggingFiles.length > 3 ? `, … (+${loggingFiles.length - 3})` : "";
    return {
      category: "logging_screenshot",
      reason: `Logging gate: PR touches logging code (${sample}${more}) but no screenshot or proof-of-fix found in PR body or comments. Paste a screenshot of the logs/dashboard showing the change working before requesting review.`,
    };
  },
  evidence: (g) => {
    const has_logging_change = g.diff_files.some((f) => touchesLogging(f.filename));
    const haystack = [g.pr_body, ...g.pr_comments].join("\n\n");
    return {
      has_logging_change,
      has_screenshot: hasScreenshot(haystack),
      // The original gate predates an explicit `screenshot-ok` style label,
      // so this is `false` by design today; we surface it anyway so the
      // observability shape stays stable if a future override label is added.
      label_present: false,
    };
  },
};
