#!/usr/bin/env -S npx tsx --env-file .env
/**
 * Test the /webhook/github endpoint locally.
 *
 * Sends a fake pull_request webhook with a correct HMAC-SHA256 signature,
 * exercises signature verification and gating logic without triggering a real review.
 *
 * Required env (loaded from .env):
 *   GITHUB_WEBHOOK_SECRET
 *
 * Optional:
 *   SERVER_URL  (default: http://localhost:8081)
 *   PR_URL      (default: https://github.com/BerriAI/litellm/pull/1)
 *
 * Usage:
 *   npx tsx --env-file .env scripts/test_webhook.ts
 *   npx tsx --env-file .env scripts/test_webhook.ts --action synchronize
 *   npx tsx --env-file .env scripts/test_webhook.ts --draft
 *   npx tsx --env-file .env scripts/test_webhook.ts --bad-sig   # expect 401
 */

import { createHmac } from "node:crypto";

const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8081";
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const PR_URL = process.env.PR_URL ?? "https://github.com/BerriAI/litellm/pull/1";

const args = process.argv.slice(2);
const action = args.includes("--action")
  ? args[args.indexOf("--action") + 1]
  : "opened";
const isDraft = args.includes("--draft");
const badSig = args.includes("--bad-sig");

// --- Build payload -----------------------------------------------------------

const payload = {
  action,
  number: 1,
  pull_request: {
    number: 1,
    html_url: PR_URL,
    draft: isDraft,
    title: "[test] fake PR from test_webhook script",
    state: "open",
    user: { login: "test-bot" },
    head: { sha: "deadbeef00000000000000000000000000000000", ref: "test-branch" },
    base: { ref: "main" },
  },
  repository: {
    full_name: "BerriAI/litellm",
    name: "litellm",
    owner: { login: "BerriAI" },
  },
  sender: { login: "test-bot" },
};

const body = JSON.stringify(payload);

// --- Sign -------------------------------------------------------------------

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

const sig = badSig
  ? "sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb"
  : sign(body, WEBHOOK_SECRET);

// --- Send -------------------------------------------------------------------

const url = `${SERVER_URL}/webhook/github`;

console.log(`\nPOST ${url}`);
console.log(`  X-GitHub-Event:        pull_request`);
console.log(`  X-Hub-Signature-256:   ${sig.slice(0, 20)}...`);
console.log(`  action:                ${action}`);
console.log(`  draft:                 ${isDraft}`);
console.log(`  bad-sig:               ${badSig}`);
console.log();

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-GitHub-Event": "pull_request",
    "X-Hub-Signature-256": sig,
  },
  body,
});

const text = await res.text();
let pretty: string;
try {
  pretty = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  pretty = text;
}

console.log(`Status: ${res.status} ${res.statusText}`);
console.log(pretty);

// Exit non-zero if unexpected status
if (badSig && res.status !== 401) {
  console.error("\nFAIL: expected 401 for bad signature");
  process.exit(1);
}
if (!badSig && res.status >= 400) {
  console.error("\nFAIL: unexpected error status");
  process.exit(1);
}
console.log("\nOK");
