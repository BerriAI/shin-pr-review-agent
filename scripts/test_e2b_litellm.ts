#!/usr/bin/env -S npx tsx --env-file .env
/**
 * Karpathy pre-merge review of the 5 most recent open BerriAI/litellm PRs,
 * run in parallel E2B sandboxes with LiteLLM proxy as the Anthropic backend.
 *
 * Required env (in .env):
 *   E2B_API_KEY       - E2B API key
 *   LITELLM_API_KEY   - forwarded into sandbox as ANTHROPIC_API_KEY
 *   LITELLM_API_BASE  - forwarded into sandbox as ANTHROPIC_BASE_URL
 *
 * Optional:
 *   GITHUB_TOKEN      - avoids GitHub API rate limits
 *
 * Usage:
 *   npx tsx --env-file .env scripts/test_e2b_litellm.ts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "e2b";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function fetchRecentPRs(count: number): Promise<number[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;

  const res = await fetch(
    `https://api.github.com/repos/BerriAI/litellm/pulls?state=open&sort=created&direction=desc&per_page=${count}`,
    { headers },
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as Array<{ number: number }>;
  return data.map((pr) => pr.number);
}

const SANDBOX_MAX_RETRIES = 2;
const SANDBOX_RETRY_BASE_MS = 5_000;

async function reviewPRWithRetry(
  prNum: number,
  e2bKey: string,
  litellmKey: string,
  litellmBase: string,
  skillBody: string,
): Promise<{ prNum: number; verdict: unknown; error?: string }> {
  let lastError: Error | undefined;
  for (let sandboxAttempt = 0; sandboxAttempt <= SANDBOX_MAX_RETRIES; sandboxAttempt++) {
    if (sandboxAttempt > 0) {
      const delay = SANDBOX_RETRY_BASE_MS * Math.pow(2, sandboxAttempt - 1);
      process.stderr.write(
        `[pr-${prNum}] timeout — sandbox retry ${sandboxAttempt}/${SANDBOX_MAX_RETRIES} in ${delay / 1000}s\n`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      return await reviewPR(prNum, e2bKey, litellmKey, litellmBase, skillBody);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const isTimeout = msg.includes("deadline_exceeded") || msg.includes("timed out") || msg.includes("timeoutMs");
      if (!isTimeout || sandboxAttempt >= SANDBOX_MAX_RETRIES) throw err;
      lastError = err as Error;
    }
  }
  throw lastError;
}

async function reviewPR(
  prNum: number,
  e2bKey: string,
  litellmKey: string,
  litellmBase: string,
  skillBody: string,
): Promise<{ prNum: number; verdict: unknown; error?: string }> {
  const prUrl = `https://github.com/BerriAI/litellm/pull/${prNum}`;
  const prompt = `${skillBody}

The repository is already cloned at /home/user/repo. Do NOT use \`gh\` CLI.
Instead use git commands directly:
  - Fetch the PR:  git fetch origin pull/${prNum}/head:pr/${prNum}
  - Get the diff:  git diff origin/main...pr/${prNum}
  - List files:    git diff --name-only origin/main...pr/${prNum}
  - Read files:    use Read/Bash tools on /home/user/repo/<path>

PR to review: ${prUrl}`;

  process.stderr.write(`[pr-${prNum}] creating sandbox\n`);
  const sandbox = await Sandbox.create("claude", {
    apiKey: e2bKey,
    envs: {
      ANTHROPIC_API_KEY: litellmKey,
      ANTHROPIC_BASE_URL: litellmBase,
    },
    timeoutMs: 600_000,
  });

  try {
    process.stderr.write(`[pr-${prNum}] cloning BerriAI/litellm (depth=50)\n`);
    const cloneResult = await sandbox.commands.run(
      `git clone --depth=50 https://github.com/BerriAI/litellm.git /home/user/repo 2>&1`,
      { timeoutMs: 120_000 },
    );
    if (cloneResult.exitCode !== 0) {
      throw new Error(
        `git clone failed (exit ${cloneResult.exitCode}):\n${cloneResult.stdout.slice(0, 500)}`,
      );
    }
    process.stderr.write(`[pr-${prNum}] clone ok\n`);

    const fetchResult = await sandbox.commands.run(
      `cd /home/user/repo && git fetch origin pull/${prNum}/head:pr/${prNum} 2>&1`,
      { timeoutMs: 60_000 },
    );
    if (fetchResult.exitCode !== 0) {
      process.stderr.write(`[pr-${prNum}] fetch warning: ${fetchResult.stdout.slice(0, 200)}\n`);
    }
    process.stderr.write(`[pr-${prNum}] fetch ok\n`);

    await sandbox.files.write("/tmp/karpathy_prompt.txt", prompt);

    process.stderr.write(`[pr-${prNum}] running karpathy review via LiteLLM proxy\n`);
    const MAX_RETRIES = 2;
    let claudeResult: Awaited<ReturnType<typeof sandbox.commands.run>>;
    let attempt = 0;
    while (true) {
      process.stderr.write(`[pr-${prNum}] claude attempt ${attempt + 1}/${MAX_RETRIES + 1}\n`);
      let capturedOutput = "";
      claudeResult = await sandbox.commands.run(
        `cd /home/user/repo && claude --dangerously-skip-permissions -p "$(cat /tmp/karpathy_prompt.txt)"`,
        {
          timeoutMs: 600_000,
          onStdout: (data: string) => {
            capturedOutput += data;
            process.stdout.write(`[pr-${prNum}] ${data}`);
          },
          onStderr: (data: string) => {
            capturedOutput += data;
            process.stderr.write(`[pr-${prNum}] ${data}`);
          },
        },
      );

      const is403 = claudeResult.exitCode !== 0 && capturedOutput.includes("403");
      if (!is403 || attempt >= MAX_RETRIES) break;

      attempt++;
      process.stderr.write(`[pr-${prNum}] 403 detected — retry ${attempt}/${MAX_RETRIES}\n`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }

    process.stderr.write(`[pr-${prNum}] claude exit code: ${claudeResult.exitCode}\n`);

    const lines = claudeResult.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const lastLine = lines.at(-1) ?? "";
    try {
      const verdict = JSON.parse(lastLine);
      return { prNum, verdict };
    } catch {
      return { prNum, verdict: null, error: "last line not JSON — full output above is verdict" };
    }
  } finally {
    await sandbox.kill();
    process.stderr.write(`[pr-${prNum}] sandbox killed\n`);
  }
}

async function main(): Promise<void> {
  const e2bKey = process.env.E2B_API_KEY;
  if (!e2bKey) throw new Error("E2B_API_KEY not set");

  const litellmKey = process.env.LITELLM_API_KEY;
  if (!litellmKey) throw new Error("LITELLM_API_KEY not set");

  const litellmBase = process.env.LITELLM_API_BASE;
  if (!litellmBase) throw new Error("LITELLM_API_BASE not set");

  const skillContent = readFileSync(resolve(__dirname, "../skills/karpathy.md"), "utf8");
  const skillBody = skillContent.replace(/^---[\s\S]*?---\n/, "").trim();

  process.stderr.write(`[karpathy] fetching 5 most recent open PRs from BerriAI/litellm\n`);
  const prNums = await fetchRecentPRs(5);
  process.stderr.write(`[karpathy] PRs: ${prNums.join(", ")}\n`);
  process.stderr.write(`[karpathy] ANTHROPIC_BASE_URL → ${litellmBase}\n`);
  process.stderr.write(`[karpathy] launching ${prNums.length} sandboxes in parallel\n`);

  const results = await Promise.allSettled(
    prNums.map((prNum) => reviewPRWithRetry(prNum, e2bKey, litellmKey, litellmBase, skillBody)),
  );

  process.stdout.write("\n--- VERDICTS ---\n");
  for (const result of results) {
    if (result.status === "fulfilled") {
      const { prNum, verdict, error } = result.value;
      process.stdout.write(`\nPR #${prNum}: https://github.com/BerriAI/litellm/pull/${prNum}\n`);
      if (error) {
        process.stderr.write(`[pr-${prNum}] ${error}\n`);
      } else {
        process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
      }
    } else {
      process.stderr.write(`\nPR failed: ${(result.reason as Error).message}\n`);
    }
  }
}

main().catch((e) => {
  process.stderr.write(`error: ${(e as Error).message}\n`);
  process.exit(1);
});
