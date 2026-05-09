#!/usr/bin/env -S npx tsx --env-file .env
/**
 * Smoke test for the e2b + Claude Code integration.
 *
 * Reads E2B_API_KEY, LITELLM_API_KEY, LITELLM_API_BASE from .env (or env).
 * Forwards LITELLM creds as ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL into the
 * sandbox so Claude Code inside e2b routes requests through LiteLLM.
 *
 * Test steps:
 *   1. Create sandbox with the 'claude' template
 *   2. Verify claude CLI is available
 *   3. Verify ANTHROPIC_BASE_URL is set inside sandbox
 *   4. Run a simple claude -p "say: SMOKE_OK" and confirm output contains SMOKE_OK
 *   5. Kill sandbox
 *
 * Usage:
 *   npx tsx --env-file .env scripts/test_e2b_smoke.ts
 */

import { Sandbox } from "e2b";

function requireEnv(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (!v) throw new Error(`${key} not set — add it to .env`);
  return v;
}

async function main(): Promise<void> {
  const e2bKey = requireEnv("E2B_API_KEY");
  // Prefer LITELLM_* creds so the test always exercises the LiteLLM path when
  // running via `--env-file .env`, regardless of any ANTHROPIC_* vars already
  // set in the shell environment.
  const anthropicKey = requireEnv(
    "LITELLM_API_KEY",
    process.env.ANTHROPIC_API_KEY,
  );
  const anthropicBase = (
    process.env.LITELLM_API_BASE ?? process.env.ANTHROPIC_BASE_URL ?? ""
  ).replace(/\/$/, "");

  console.log("=== e2b smoke test ===");
  console.log(`anthropic key  : ${anthropicKey.slice(0, 12)}...`);
  console.log(`anthropic base : ${anthropicBase ?? "(default — Anthropic)"}`);
  console.log();

  console.log("[1/4] creating e2b sandbox (template: claude)...");
  const t0 = Date.now();
  const sandbox = await Sandbox.create("claude", {
    apiKey: e2bKey,
    envs: {
      ANTHROPIC_API_KEY: anthropicKey,
      ...(anthropicBase ? { ANTHROPIC_BASE_URL: anthropicBase } : {}),
    },
    timeoutMs: 120_000,
  });
  console.log(`      sandbox id: ${sandbox.sandboxId}  (${Date.now() - t0}ms)`);

  try {
    // Step 2 — verify claude CLI is present
    console.log("\n[2/4] checking claude CLI...");
    const whichResult = await sandbox.commands.run("which claude && claude --version 2>&1");
    if (whichResult.exitCode !== 0) {
      throw new Error(
        `claude CLI not found in sandbox (exit ${whichResult.exitCode}): ${whichResult.stdout}`,
      );
    }
    console.log(`      ${whichResult.stdout.trim()}`);

    // Step 3 — verify env vars are set inside sandbox
    console.log("\n[3/4] checking env vars inside sandbox...");
    const envResult = await sandbox.commands.run(
      "echo ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:0:12}... && echo ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL",
    );
    console.log(`      ${envResult.stdout.trim()}`);

    // Step 4 — run a real claude call through LiteLLM
    console.log("\n[4/4] running claude -p (routes through ANTHROPIC_BASE_URL)...");
    const t1 = Date.now();
    const claudeResult = await sandbox.commands.run(
      `claude --dangerously-skip-permissions -p "Reply with exactly the string SMOKE_OK and nothing else."`,
      { timeoutMs: 120_000 },
    );
    const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
    console.log(`      exit code : ${claudeResult.exitCode}`);
    console.log(`      output    : ${claudeResult.stdout.trim().slice(0, 300)}`);
    console.log(`      elapsed   : ${elapsed}s`);

    if (claudeResult.exitCode !== 0) {
      throw new Error(`claude exited ${claudeResult.exitCode}`);
    }
    if (!claudeResult.stdout.includes("SMOKE_OK")) {
      throw new Error(
        `expected SMOKE_OK in output, got: ${claudeResult.stdout.slice(0, 200)}`,
      );
    }

    console.log("\n✓ SMOKE TEST PASSED");
  } finally {
    await sandbox.kill();
    console.log(`  sandbox killed (total: ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

main().catch((e) => {
  console.error(`\n✗ SMOKE TEST FAILED: ${(e as Error).message}`);
  process.exit(1);
});
