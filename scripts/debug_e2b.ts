import { Sandbox } from "e2b";

const e2bKey = process.env.E2B_API_KEY!;
const anthropicKey = process.env.LITELLM_API_KEY!;
const anthropicBase = (process.env.LITELLM_API_BASE ?? "").replace(/\/$/, "");

console.log("base:", anthropicBase);

async function main() {
  const sandbox = await Sandbox.create("claude", {
    apiKey: e2bKey,
    envs: { ANTHROPIC_API_KEY: anthropicKey, ANTHROPIC_BASE_URL: anthropicBase },
    timeoutMs: 120_000,
  });

  try {
    // Test 1: curl LiteLLM from inside sandbox
    console.log("\n[1] curl from sandbox → LiteLLM");
    const curlResult = await sandbox.commands.run(
      `curl -s -w "\\nHTTP:%{http_code}" -X POST "${anthropicBase}/v1/messages" \
       -H "x-api-key: ${anthropicKey}" \
       -H "anthropic-version: 2023-06-01" \
       -H "content-type: application/json" \
       -d '{"model":"claude-haiku-4-5","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
       --max-time 20 2>&1`,
      { timeoutMs: 25_000 }
    );
    console.log(" ", curlResult.stdout.slice(-300));
    console.log("  exit:", curlResult.exitCode);

    // Test 2: claude with live output
    console.log("\n[2] claude -p with live stdout");
    const claudeResult = await sandbox.commands.run(
      `claude --dangerously-skip-permissions -p "reply with exactly: SMOKE_OK" 2>&1`,
      {
        onStdout: (d) => process.stdout.write(`  stdout> ${d}`),
        timeoutMs: 50_000,
      }
    );
    console.log("\n  exit:", claudeResult.exitCode);
  } finally {
    await sandbox.kill();
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
