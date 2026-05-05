#!/usr/bin/env -S npx tsx
/**
 * E2B-backed gather for pattern review.
 *
 * Same JSON output shape as gather_pattern_local.ts but runs inside an
 * isolated E2B sandbox with Claude Code CLI — no local git clone required.
 *
 * Required env:
 *     E2B_API_KEY        - E2B API key
 *     ANTHROPIC_API_KEY  - forwarded into sandbox for Claude Code
 *
 * Optional env:
 *     GITHUB_TOKEN  - for private repos or higher GitHub API rate limits
 *
 * Usage:
 *     E2B_API_KEY=... ANTHROPIC_API_KEY=... npx tsx scripts/gather_pattern_e2b.ts \
 *       https://github.com/BerriAI/litellm/pull/123
 */

import { Sandbox } from "e2b";

const PR_URL_RE =
  /github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<num>\d+)/;
const PR_SHORT_RE = /^(?<owner>[^/\s]+)\/(?<repo>[^#\s]+)#(?<num>\d+)$/;

function parsePrUrl(url: string): { owner: string; repo: string; num: number } {
  const m = PR_URL_RE.exec(url) ?? PR_SHORT_RE.exec(url.trim());
  if (!m || !m.groups) throw new Error(`Not a recognised PR reference: ${url}`);
  return {
    owner: m.groups.owner,
    repo: m.groups.repo,
    num: parseInt(m.groups.num, 10),
  };
}

function buildAnalysisPrompt(
  owner: string,
  repo: string,
  num: number,
): string {
  return `You are gathering structured data about PR #${num} for ${owner}/${repo} to support a pattern-conformance review.

The repository is cloned at /home/user/repo and the PR is available as branch pr/${num}.

Do the following steps IN ORDER:

1. Run: git diff origin/main...pr/${num}
   Collect the diff for all changed files.

2. For each changed file, list files in the same directory that were NOT changed (siblings). Read the first 1200 characters of up to 3 siblings per directory.

3. Search docs/my-website/docs/ for .md and .mdx files whose filename or content is semantically related to the changed files. Read the first 1500 characters of up to 3 matching excerpts per changed file (max 30 doc excerpts total).

4. Run: git rev-parse pr/${num}
   to get head_sha.

5. Try: gh api repos/${owner}/${repo}/pulls/${num} --jq .title
   to get pr_title. Use "" if this fails.

6. Write the collected data as a single valid JSON object to /tmp/gather_result.json using this exact schema (no markdown fences, no explanation — pure JSON only):
{
  "owner": "${owner}",
  "repo": "${repo}",
  "pr_number": ${num},
  "pr_title": "<string>",
  "head_sha": "<string>",
  "diff_files": [
    {
      "filename": "<relative path>",
      "status": "<added|modified|removed|renamed>",
      "additions": <int>,
      "deletions": <int>,
      "patch": "<diff text>"
    }
  ],
  "doc_excerpts": [
    {
      "path": "<docs relative path>",
      "excerpt": "<first 1500 chars>",
      "matched_files": ["<changed file that triggered this doc>"]
    }
  ],
  "sibling_excerpts": [
    {
      "diff_file": "<changed file path>",
      "siblings": [
        {
          "path": "<sibling file path>",
          "head_excerpt": "<first 1200 chars>"
        }
      ]
    }
  ],
  "conflict_hints": []
}

CRITICAL: /tmp/gather_result.json must contain ONLY valid JSON with no surrounding text.`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === "-h" || args[0] === "--help") {
    process.stderr.write(
      "usage: gather_pattern_e2b.ts <pr-url-or-owner/repo#N>\n",
    );
    process.exit(2);
  }

  const { owner, repo, num } = parsePrUrl(args[0]);

  const e2bKey = process.env.E2B_API_KEY;
  if (!e2bKey) throw new Error("E2B_API_KEY not set");

  // Support LiteLLM as the Anthropic backend: ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
  // fall back to LITELLM_API_KEY / LITELLM_API_BASE when not set directly.
  const anthropicKey =
    process.env.ANTHROPIC_API_KEY ?? process.env.LITELLM_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY or LITELLM_API_KEY not set");
  const anthropicBase =
    process.env.ANTHROPIC_BASE_URL ?? process.env.LITELLM_API_BASE;

  const githubToken = process.env.GITHUB_TOKEN ?? "";

  process.stderr.write(
    `[e2b] creating sandbox for ${owner}/${repo}#${num}\n`,
  );
  if (anthropicBase) {
    process.stderr.write(`[e2b] using custom ANTHROPIC_BASE_URL: ${anthropicBase}\n`);
  }
  const t0 = Date.now();

  const sandbox = await Sandbox.create("claude", {
    apiKey: e2bKey,
    envs: {
      ANTHROPIC_API_KEY: anthropicKey,
      ...(anthropicBase ? { ANTHROPIC_BASE_URL: anthropicBase } : {}),
      ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
    },
    timeoutMs: 600_000,
  });

  try {
    const cloneUrl = githubToken
      ? `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;

    process.stderr.write(`[e2b] cloning ${owner}/${repo}\n`);
    const cloneResult = await sandbox.commands.run(
      `git clone --depth=50 "${cloneUrl}" /home/user/repo 2>&1`,
    );
    if (cloneResult.exitCode !== 0) {
      throw new Error(
        `git clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stdout.slice(0, 300)}`,
      );
    }

    process.stderr.write(`[e2b] fetching PR #${num}\n`);
    const fetchResult = await sandbox.commands.run(
      [
        `cd /home/user/repo`,
        `git fetch origin pull/${num}/head:pr/${num} 2>&1`,
        `git fetch --depth=1 origin main:refs/remotes/origin/main 2>&1`,
      ].join(" && "),
    );
    if (fetchResult.exitCode !== 0) {
      process.stderr.write(
        `[e2b] fetch warning: ${fetchResult.stdout.slice(0, 200)}\n`,
      );
    }

    const prompt = buildAnalysisPrompt(owner, repo, num);
    process.stderr.write(`[e2b] running claude analysis (may take ~2 min)\n`);
    const claudeResult = await sandbox.commands.run(
      `cd /home/user/repo && claude --dangerously-skip-permissions -p ${JSON.stringify(prompt)}`,
      { timeoutMs: 300_000 },
    );
    if (claudeResult.exitCode !== 0) {
      process.stderr.write(
        `[e2b] claude stderr: ${claudeResult.stdout.slice(-500)}\n`,
      );
    }

    const readResult = await sandbox.commands.run(
      "cat /tmp/gather_result.json",
    );
    if (readResult.exitCode !== 0) {
      throw new Error(
        "Claude did not write /tmp/gather_result.json — analysis failed",
      );
    }

    const resultJson = readResult.stdout.trim();
    JSON.parse(resultJson); // validate before writing to stdout

    process.stderr.write(
      `[e2b] done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
    );
    process.stdout.write(resultJson);
    process.stdout.write("\n");
  } finally {
    await sandbox.kill();
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(1);
});
