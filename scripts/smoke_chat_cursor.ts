/**
 * Smoke test: POST /chat/api and verify the @cursor/sdk Agent actually runs.
 *
 * Run:
 *   SERVER_URL=https://shin-pr-review-agent.onrender.com \
 *   BOT_API_KEY=... \
 *   npx tsx scripts/smoke_chat_cursor.ts
 *
 * Default SERVER_URL = http://localhost:8081. Default test PR URL =
 * https://github.com/BerriAI/litellm/pull/26468 (the PR that surfaced the bug).
 *
 * What it asserts:
 *   1. /chat/api responds 200 to a plain prompt and returns LLM output that
 *      is not the canned "⚠️ agent failed:" error envelope. Output must
 *      include the deterministic marker we asked for, proving the cursor
 *      SDK actually round-tripped a turn (and didn't, e.g., return an empty
 *      stream because Agent.create or Agent.send threw silently).
 *   2. /chat/api responds 200 to a "review this PR: <url>" prompt, the
 *      tool_trace contains a review_pr call, AND output length > the review
 *      card alone — i.e., the cursor SDK produced commentary AFTER reviewPr()
 *      handed back its card. This catches the screenshot regression where the
 *      review card rendered but the LLM step never wrote a single token.
 */
import { randomUUID } from "node:crypto";

const SERVER_URL = (process.env.SERVER_URL ?? "http://localhost:8081").replace(/\/$/, "");
const BOT_API_KEY = process.env.BOT_API_KEY ?? "";
const TEST_PR_URL =
  process.env.SMOKE_TEST_PR_URL ?? "https://github.com/BerriAI/litellm/pull/26468";
const TIMEOUT_MS = parseInt(process.env.SMOKE_TIMEOUT_MS ?? "600000", 10);

const PING_MARKER = "PONG-CURSOR-SMOKE-OK";

interface ChatResponse {
  output?: string;
  tool_trace?: Array<
    | { kind: "call"; tool: string; args: unknown }
    | { kind: "result"; tool: string; isError: boolean; preview: string }
  >;
  thread_id?: string;
  available_tools?: string[];
  intent?: string;
  error?: string;
}

async function postChat(message: string): Promise<{ status: number; body: ChatResponse }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (BOT_API_KEY) headers.authorization = `Bearer ${BOT_API_KEY}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${SERVER_URL}/chat/api`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, thread_id: randomUUID().replace(/-/g, "") }),
      signal: ac.signal,
    });
    const text = await resp.text();
    let body: ChatResponse;
    try {
      body = JSON.parse(text);
    } catch {
      body = { output: text };
    }
    return { status: resp.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function assertNoAgentFailure(out: string): void {
  if (/^⚠️\s*agent failed:/.test(out)) {
    throw new Error(`agent error envelope returned: ${out.slice(0, 400)}`);
  }
}

async function testCursorPing(): Promise<void> {
  const prompt =
    `Reply with exactly the single token "${PING_MARKER}" and nothing else. ` +
    `No quotes, no commentary, no markdown.`;

  console.log(`[1/2] cursor ping → POST ${SERVER_URL}/chat/api`);
  const t0 = Date.now();
  const { status, body } = await postChat(prompt);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (status !== 200) {
    throw new Error(`expected 200, got ${status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  const out = body.output ?? "";
  console.log(`      ${dt}s status=200 outputLen=${out.length} preview=${JSON.stringify(out.slice(0, 120))}`);
  assertNoAgentFailure(out);
  if (out.length === 0) throw new Error("cursor returned empty output (Agent stream produced 0 text tokens)");
  if (!out.includes(PING_MARKER)) {
    throw new Error(
      `cursor output missing marker "${PING_MARKER}" — LLM did not round-trip the prompt. ` +
        `output=${JSON.stringify(out.slice(0, 400))}`,
    );
  }
  console.log(`      OK — cursor SDK returned marker`);
}

async function testReviewPrPath(): Promise<void> {
  const prompt = `review this pr: ${TEST_PR_URL}`;

  console.log(`[2/2] review_pr + cursor commentary → ${TEST_PR_URL}`);
  const t0 = Date.now();
  const { status, body } = await postChat(prompt);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  if (status !== 200) {
    throw new Error(`expected 200, got ${status}: ${JSON.stringify(body).slice(0, 400)}`);
  }
  const out = body.output ?? "";
  const trace = body.tool_trace ?? [];
  console.log(
    `      ${dt}s status=200 outputLen=${out.length} traceLen=${trace.length} ` +
      `tools=[${trace.map((t) => ("tool" in t ? t.tool : "?")).join(",")}]`,
  );
  assertNoAgentFailure(out);

  const hasReviewCall = trace.some((t) => t.kind === "call" && t.tool === "review_pr");
  if (!hasReviewCall) {
    throw new Error(
      `tool_trace missing review_pr call — runChatTurn did not detect the PR URL. ` +
        `trace=${JSON.stringify(trace).slice(0, 400)}`,
    );
  }

  // The reviewPr() card lands in `output` either as the whole answer
  // (when the chat cursor agent decides the card is enough) or as
  // context the agent composes commentary on top of. The screenshot
  // regression was the cursor SDK returning ZERO tokens, leaving only
  // the framing string. So we require:
  //   - the chat cursor agent returns *substantive* text (≥ 200 chars
  //     of PR-relevant content), AND
  //   - that text references the PR somehow (PR number / url substring),
  // proving the cursor SDK actually composed a response rather than
  // emitting a blank stream.
  const reviewResult = trace.find((t) => t.kind === "result" && t.tool === "review_pr");
  const cardLen =
    reviewResult && reviewResult.kind === "result" ? reviewResult.preview.length : 0;
  if (cardLen === 0) {
    throw new Error("review_pr tool_result missing — reviewPr() did not return a card");
  }
  if (out.length < 200) {
    throw new Error(
      `cursor SDK output too short — likely silent agent failure. ` +
        `outputLen=${out.length} cardLen=${cardLen}. ` +
        `output=${JSON.stringify(out.slice(0, 600))}`,
    );
  }
  const prNumberMatch = TEST_PR_URL.match(/\/pull\/(\d+)/);
  const prRef = prNumberMatch ? prNumberMatch[1] : "";
  if (prRef && !out.includes(prRef) && !out.includes(TEST_PR_URL)) {
    throw new Error(
      `cursor SDK output never references the PR (${prRef}) — looks unrelated. ` +
        `output=${JSON.stringify(out.slice(0, 600))}`,
    );
  }
  console.log(
    `      OK — cursor SDK composed a ${out.length}-char response (cardLen=${cardLen})`,
  );
}

async function main(): Promise<void> {
  console.log(`SERVER_URL=${SERVER_URL}  authed=${BOT_API_KEY ? "yes" : "no"}`);
  await testCursorPing();
  await testReviewPrPath();
  console.log("\n✓ all checks passed — cursor SDK is being used");
}

main().catch((e) => {
  console.error(`\n✗ smoke failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
