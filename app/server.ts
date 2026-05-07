import {
  randomUUID,
  timingSafeEqual,
  createHmac,
  createSign,
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import session from "express-session";
import * as db from "./db.js";
import { isFirstTimeAuthor } from "./automerge_guards.js";
import {
  initRegistry,
  initSystemPrompts,
  reviewPr,
  setAutoMergeHook,
  promptChatSession,
  promptChatSessionStreaming,
  listThreads,
  getThread,
  deleteThread,
  createThread,
  ensureChatSession,
} from "./review.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(__dirname, "../ui");
const SKILLS_DIR = resolve(__dirname, "../skills");

function parseSkillFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

// --- Debug logger -------------------------------------------------------------
const _DBG_T0 = Date.now();
function dbg(tag: string, ...rest: unknown[]): void {
  const ms = Date.now() - _DBG_T0;
  // eslint-disable-next-line no-console
  console.log(`[debug +${ms}ms] ${tag}`, ...rest);
}

// --- Auth config --------------------------------------------------------------

const GITHUB_APP_ID = process.env.GITHUB_APP_ID ?? "";
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY ?? "";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const BOT_API_KEYS = new Set(
  (process.env.BOT_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
);
const SESSION_AUTH = !!(ADMIN_USERNAME && ADMIN_PASSWORD);
const AUTH_ENABLED = SESSION_AUTH || BOT_API_KEYS.size > 0;
const SESSION_SECRET = process.env.SESSION_SECRET ?? randomUUID();
const _WHITELIST_ENTRIES = (process.env.WHITELIST_GITHUB_LOGINS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
function isWhitelistedLogin(login: string): boolean {
  const l = login.toLowerCase();
  return _WHITELIST_ENTRIES.some((entry) => {
    if (!entry.includes("*")) return entry === l;
    const pattern = entry.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`).test(l);
  });
}

function bearerToken(req: Request): string | null {
  const h = req.headers.authorization ?? "";
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  return h.slice("bearer ".length).trim() || null;
}

function bearerOk(token: string): boolean {
  const t = Buffer.from(token, "utf8");
  for (const key of BOT_API_KEYS) {
    const k = Buffer.from(key, "utf8");
    if (t.length !== k.length) continue;
    if (timingSafeEqual(t, k)) return true;
  }
  return false;
}

function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_ENABLED) return next();
  if (BOT_API_KEYS.size) {
    const tok = bearerToken(req);
    if (tok && bearerOk(tok)) return next();
  }
  if (SESSION_AUTH && (req.session as any)?.user === ADMIN_USERNAME)
    return next();
  const accept = req.headers.accept ?? "";
  if (SESSION_AUTH && accept.includes("text/html") && req.method === "GET") {
    res.redirect(303, "/login");
    return;
  }
  res.status(401).json({ error: "login required" });
}

// --- GitHub App auth ----------------------------------------------------------

function makeAppJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: GITHUB_APP_ID }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const sig = createSign("RSA-SHA256")
    .update(data)
    .sign(GITHUB_APP_PRIVATE_KEY, "base64url");
  return `${data}.${sig}`;
}

async function getInstallationToken(installationId: number): Promise<string> {
  const r = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${makeAppJwt()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r.ok)
    throw new Error(`installation token failed: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

async function fetchPr(
  token: string,
  repoFullName: string,
  prNumber: number,
): Promise<{
  html_url: string;
  draft: boolean;
  state: string;
  updated_at: string;
  title: string;
  head: { sha: string; ref: string };
  base: { ref: string };
  user: { login: string; type?: string };
}> {
  const r = await fetch(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r.ok) throw new Error(`PR fetch failed: ${r.status}`);
  return r.json() as Promise<{
    html_url: string;
    draft: boolean;
    state: string;
    updated_at: string;
    title: string;
    head: { sha: string; ref: string };
    base: { ref: string };
    user: { login: string; type?: string };
  }>;
}

function agentBranchName(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `litellm_agent_oss_staging_${mm}_${dd}_${yyyy}`;
}

async function ensureBranch(
  token: string,
  repoFullName: string,
  branchName: string,
  fromRef: string,
): Promise<void> {
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const checkR = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branchName}`,
    { headers: ghHeaders },
  );
  if (checkR.status === 200) return;
  if (checkR.status !== 404)
    throw new Error(`branch check failed: ${checkR.status}`);
  const refR = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/${fromRef}`,
    { headers: ghHeaders },
  );
  if (!refR.ok) throw new Error(`ref fetch failed: ${refR.status}`);
  const refData = (await refR.json()) as { object: { sha: string } };
  const createR = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs`,
    {
      method: "POST",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: `refs/heads/${branchName}`,
        sha: refData.object.sha,
      }),
    },
  );
  if (!createR.ok)
    throw new Error(
      `branch create failed: ${createR.status} ${await createR.text()}`,
    );
}

async function getDefaultBranch(token: string, repoFullName: string): Promise<string> {
  const r = await fetch(`https://api.github.com/repos/${repoFullName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) throw new Error(`repo fetch failed: ${r.status}`);
  const data = (await r.json()) as { default_branch: string };
  return data.default_branch;
}

async function ensureStagingPr(
  token: string,
  repoFullName: string,
  stagingBranch: string,
  baseBranch: string,
): Promise<{ html_url: string; number: number; created: boolean }> {
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const [owner] = repoFullName.split("/");
  // Check for existing open PR from this staging branch
  const searchR = await fetch(
    `https://api.github.com/repos/${repoFullName}/pulls?state=open&head=${owner}:${stagingBranch}&base=${baseBranch}&per_page=1`,
    { headers: ghHeaders },
  );
  if (searchR.ok) {
    const existing = (await searchR.json()) as Array<{ html_url: string; number: number }>;
    if (existing.length > 0)
      return { html_url: existing[0].html_url, number: existing[0].number, created: false };
  }
  // Create new PR
  const now = new Date();
  const dateLabel = `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  const createR = await fetch(
    `https://api.github.com/repos/${repoFullName}/pulls`,
    {
      method: "POST",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `[litellm-agent] Staging → ${baseBranch} (${dateLabel})`,
        head: stagingBranch,
        base: baseBranch,
        body: `Automated staging PR created by litellm-agent.\n\nThis branch collects PRs approved by the agent on ${dateLabel}.`,
      }),
    },
  );
  if (!createR.ok)
    throw new Error(`staging PR create failed: ${createR.status} ${await createR.text()}`);
  const created = (await createR.json()) as { html_url: string; number: number };
  return { html_url: created.html_url, number: created.number, created: true };
}

async function mergePrToAgentBranch(
  token: string,
  repoFullName: string,
  prNumber: number,
  agentBranch: string,
  reviewCard?: string,
): Promise<{ merge_commit_sha: string; branch: string; staging_pr_url: string; staging_pr_number: number }> {
  const [pr, defaultBranch] = await Promise.all([
    fetchPr(token, repoFullName, prNumber),
    getDefaultBranch(token, repoFullName),
  ]);
  if (pr.state !== "open") {
    throw new Error(`PR #${prNumber} is not open (state=${pr.state}), skipping merge`);
  }
  const originalBase = pr.base.ref;
  await ensureBranch(token, repoFullName, agentBranch, originalBase);

  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  // Point PR at the staging branch so GitHub's squash merge targets it.
  const rebaseR = await fetch(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
    {
      method: "PATCH",
      headers: ghHeaders,
      body: JSON.stringify({ base: agentBranch }),
    },
  );
  if (!rebaseR.ok) throw new Error(`base change failed: ${rebaseR.status} ${await rebaseR.text()}`);

  // Squash merge — GitHub auto-closes the PR on success.
  const mergeR = await fetch(
    `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/merge`,
    {
      method: "PUT",
      headers: ghHeaders,
      body: JSON.stringify({
        merge_method: "squash",
        commit_title: `${pr.title} (#${prNumber})`,
        commit_message: `Squash-merged by litellm-agent from ${pr.user.login}'s PR.`,
      }),
    },
  );
  if (!mergeR.ok) {
    // Conflict or other failure — revert the base change so the PR is left clean.
    await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
      {
        method: "PATCH",
        headers: ghHeaders,
        body: JSON.stringify({ base: originalBase }),
      },
    ).catch((e) => console.warn(`[merge] base revert failed for PR #${prNumber}:`, e));
    throw new Error(`squash merge failed: ${mergeR.status} ${await mergeR.text()}`);
  }
  const merge_commit_sha = ((await mergeR.json()) as { sha: string }).sha;

  const stagingPr = await ensureStagingPr(token, repoFullName, agentBranch, defaultBranch);

  // PR is already closed by GitHub — just leave a comment with the staging link.
  const mergeComment = reviewCard
    ? `🤖 **litellm-agent**: Squash-merged into staging branch \`${agentBranch}\`. Staging PR: ${stagingPr.html_url}\n\n---\n\n${reviewCard}`
    : `🤖 **litellm-agent**: Squash-merged into staging branch \`${agentBranch}\`. Staging PR: ${stagingPr.html_url}`;
  await fetch(`https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: ghHeaders,
    body: JSON.stringify({ body: mergeComment }),
  }).catch((err) => console.warn(`[merge] comment on PR #${prNumber} failed:`, err));

  // Trigger Greptile review on the staging PR after each merge.
  await fetch(`https://api.github.com/repos/${repoFullName}/issues/${stagingPr.number}/comments`, {
    method: "POST",
    headers: ghHeaders,
    body: JSON.stringify({ body: "@greptile please review" }),
  }).catch((err) => console.warn(`[merge] greptile trigger on staging PR #${stagingPr.number} failed:`, err));

  return {
    merge_commit_sha,
    branch: agentBranch,
    staging_pr_url: stagingPr.html_url,
    staging_pr_number: stagingPr.number,
  };
}

async function rebuildStagingBranch(
  token: string,
  repo: string,
  stagingBranch: string,
): Promise<{ mergesReplayed: number }> {
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const remaining = await db.listTodayStagingMergesForRebuild(repo);
  const defaultBranch = await getDefaultBranch(token, repo);
  const refR = await fetch(
    `https://api.github.com/repos/${repo}/git/refs/heads/${defaultBranch}`,
    { headers: ghHeaders },
  );
  if (!refR.ok) throw new Error(`ref fetch failed: ${refR.status}`);
  const { object: { sha: mainSha } } = await refR.json() as { object: { sha: string } };

  // Reset staging branch to main HEAD (force-overwrite)
  const patchR = await fetch(
    `https://api.github.com/repos/${repo}/git/refs/heads/${stagingBranch}`,
    {
      method: "PATCH",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ sha: mainSha, force: true }),
    },
  );
  if (!patchR.ok) throw new Error(`branch reset failed: ${patchR.status} ${await patchR.text()}`);

  for (const merge of remaining) {
    const pr = await fetchPr(token, repo, merge.pr_number);
    const mergeR = await fetch(`https://api.github.com/repos/${repo}/merges`, {
      method: "POST",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        base: stagingBranch,
        head: pr.head.sha,
        commit_message: `Merge PR #${merge.pr_number} into agent staging branch`,
      }),
    });
    if (!mergeR.ok && mergeR.status !== 204)
      throw new Error(`re-merge PR #${merge.pr_number} failed: ${mergeR.status} ${await mergeR.text()}`);
  }

  return { mergesReplayed: remaining.length };
}

async function getOrgInstallationId(org: string): Promise<number> {
  const r = await fetch("https://api.github.com/app/installations?per_page=100", {
    headers: {
      Authorization: `Bearer ${makeAppJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) throw new Error(`installations fetch failed: ${r.status}`);
  const installs = await r.json() as Array<{ id: number; account: { login: string } }>;
  const match = installs.find(i => i.account.login.toLowerCase() === org.toLowerCase());
  if (!match) throw new Error(`no installation found for org: ${org}`);
  return match.id;
}

async function listOpenPrs(token: string, repoFullName: string, limit: number): Promise<Array<{
  number: number; html_url: string; draft: boolean; head: { sha: string };
}>> {
  const perPage = Math.min(limit, 100);
  const r = await fetch(
    `https://api.github.com/repos/${repoFullName}/pulls?state=open&per_page=${perPage}&sort=created&direction=desc`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r.ok) throw new Error(`PR list failed: ${r.status}`);
  const prs = await r.json() as Array<{ number: number; html_url: string; draft: boolean; head: { sha: string } }>;
  return prs.slice(0, limit);
}

// --- Express app --------------------------------------------------------------

function verifyGithubSignature(
  rawBody: Buffer,
  sigHeader: string,
  secret: string,
): boolean {
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const actual = Buffer.from(sigHeader, "utf8");
  const exp = Buffer.from(expected, "utf8");
  if (actual.length !== exp.length) return false;
  return timingSafeEqual(actual, exp);
}

const app = express();
app.use(
  express.json({
    limit: "10mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false }));

if (SESSION_AUTH) {
  app.use(
    session({
      secret: SESSION_SECRET,
      name: "litellm_bot_session",
      resave: false,
      saveUninitialized: false,
      cookie: { sameSite: "lax", httpOnly: true },
    }),
  );
}

// --- Daily auto-merge cap -----------------------------------------------------

const DAILY_MERGE_CAP = 10;

// --- GitHub webhook -----------------------------------------------------------

// In-memory signal: Greptile has commented for a given (repo, prNumber, sha).
// Ephemeral — lost on restart. Worst case: check_suite arrives first after restart,
// Greptile signal missing → skip. issue_comment will pick it up when Greptile (re-)comments.
const greptileReadyShas = new Set<string>();

function greptileKey(repo: string, prNumber: number, sha: string): string {
  return `${repo}#${prNumber}#${sha}`;
}

async function areAllCheckSuitesComplete(
  token: string,
  repoFullName: string,
  sha: string,
): Promise<boolean> {
  const r = await fetch(
    `https://api.github.com/repos/${repoFullName}/commits/${sha}/check-suites?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r.ok) {
    console.warn(`[webhook] areAllCheckSuitesComplete fetch failed: ${r.status}`);
    return false;
  }
  const data = (await r.json()) as { check_suites: Array<{ status: string }> };
  return data.check_suites.length > 0 && data.check_suites.every((s) => s.status === "completed");
}

// Shared post-claim review logic used by both issue_comment and check_suite handlers.
async function runWebhookReview(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  delivery: string | undefined,
  source: string,
): Promise<void> {
  const t0 = Date.now();
  const token = await getInstallationToken(installationId);
  const pr = await fetchPr(token, repoFullName, prNumber);
  console.log(
    `[webhook] delivery=${delivery} fetched PR #${prNumber}: state=${pr.state} draft=${pr.draft} headSha=${pr.head.sha}`,
  );

  if (pr.state !== "open") {
    console.log(`[webhook] delivery=${delivery} PR #${prNumber} no longer open, skipping`);
    return;
  }
  if (pr.draft) {
    console.log(`[webhook] delivery=${delivery} PR #${prNumber} is draft, skipping`);
    return;
  }
  if (_WHITELIST_ENTRIES.length && isWhitelistedLogin(pr.user.login)) {
    console.log(`[webhook] delivery=${delivery} PR #${prNumber} author=${pr.user.login} is whitelisted, skipping`);
    return;
  }

  const claimed = await db.claimWebhookReview(prNumber, pr.head.sha, repoFullName);
  console.log(
    `[webhook] delivery=${delivery} claimWebhookReview PR #${prNumber} sha=${pr.head.sha} claimed=${claimed}`,
  );
  if (!claimed) {
    console.log(
      `[webhook] delivery=${delivery} PR #${prNumber} sha=${pr.head.sha} already reviewed, skipping`,
    );
    return;
  }

  console.log(
    `[webhook] delivery=${delivery} triggering review for ${pr.html_url} sha=${pr.head.sha} source=${source}`,
  );
  const { runId } = await reviewPr(pr.html_url, { source });
  console.log(
    `[webhook] delivery=${delivery} review complete for PR #${prNumber} sha=${pr.head.sha} elapsedMs=${Date.now() - t0}`,
  );

  const finalRun = await db.getRun(runId);
  const finalVerdict = (finalRun?.card as Record<string, unknown> | null)?.verdict;
  if (finalVerdict === "BLOCKED") {
    await db.startBlockedWatch(runId);
    console.log(`[webhook] delivery=${delivery} PR #${prNumber} BLOCKED — started 7-day inactivity watch`);
  }
  // READY: auto-merge handled by hook registered in reviewPr (all sources unified).
}

app.post("/webhook/github", (req, res) => {
  const sigRaw = req.headers["x-hub-signature-256"];
  const sig = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
  const eventRaw = req.headers["x-github-event"];
  const event = Array.isArray(eventRaw) ? eventRaw[0] : eventRaw;
  const deliveryRaw = req.headers["x-github-delivery"];
  const delivery = Array.isArray(deliveryRaw) ? deliveryRaw[0] : deliveryRaw;

  console.log(
    `[webhook] received event=${event} delivery=${delivery} sigPresent=${Boolean(sig)}`,
  );

  if (GITHUB_WEBHOOK_SECRET) {
    if (!sig) {
      console.warn(`[webhook] delivery=${delivery} missing signature`);
      res.status(401).json({ error: "missing signature" });
      return;
    }
    const rawBody: Buffer = (req as any).rawBody;
    if (
      !rawBody ||
      !verifyGithubSignature(rawBody, sig, GITHUB_WEBHOOK_SECRET)
    ) {
      console.warn(
        `[webhook] delivery=${delivery} invalid signature (rawBodyPresent=${Boolean(rawBody)})`,
      );
      res.status(401).json({ error: "invalid signature" });
      return;
    }
  }

  if (event !== "issue_comment" && event !== "check_suite") {
    console.log(
      `[webhook] delivery=${delivery} skipping: event=${event} not handled`,
    );
    res.json({ skipped: true, reason: `event=${event}` });
    return;
  }

  // --- check_suite completed: fire review if Greptile has already commented ---
  if (event === "check_suite") {
    const csPayload = req.body as {
      action?: string;
      check_suite?: {
        head_sha?: string;
        status?: string;
        pull_requests?: Array<{ number?: number }>;
      };
      repository?: { full_name?: string };
      installation?: { id?: number };
    };

    const csAction = csPayload.action ?? "";
    const headSha = csPayload.check_suite?.head_sha ?? "";
    const csPrs = csPayload.check_suite?.pull_requests ?? [];
    const csRepo = csPayload.repository?.full_name ?? "";
    const csInstallationId = csPayload.installation?.id;

    console.log(
      `[webhook] delivery=${delivery} check_suite action=${csAction} sha=${headSha} repo=${csRepo} prs=${csPrs.map((p) => p.number).join(",")}`,
    );

    if (csAction !== "completed" || !headSha || !csRepo || !csInstallationId) {
      res.json({ skipped: true, reason: "check_suite not completed or missing fields" });
      return;
    }

    const csInstallId: number = csInstallationId;

    res.status(202).json({ ok: true, queued: true });

    (async () => {
      const token = await getInstallationToken(csInstallId);
      const allDone = await areAllCheckSuitesComplete(token, csRepo, headSha);
      if (!allDone) {
        console.log(`[webhook] delivery=${delivery} check_suite: not all suites complete for sha=${headSha}, skipping`);
        return;
      }
      for (const csPr of csPrs) {
        const prNum = csPr.number;
        if (!prNum) continue;
        const key = greptileKey(csRepo, prNum, headSha);
        if (!greptileReadyShas.has(key)) {
          console.log(`[webhook] delivery=${delivery} check_suite: Greptile not yet ready for PR #${prNum} sha=${headSha}, skipping`);
          continue;
        }
        console.log(`[webhook] delivery=${delivery} check_suite: both signals ready for PR #${prNum} sha=${headSha} — queueing review`);
        await runWebhookReview(csInstallId, csRepo, prNum, delivery, "webhook_check_suite").catch((err) =>
          console.error(`[webhook] delivery=${delivery} check_suite review failed for PR #${prNum}:`, err),
        );
      }
    })().catch((err) =>
      console.error(`[webhook] delivery=${delivery} check_suite handler failed:`, err),
    );
    return;
  }

  // --- issue_comment: record Greptile signal, fire review if CI already done ---
  const payload = req.body as {
    action?: string;
    comment?: {
      id?: number;
      user?: { login?: string };
      created_at?: string;
      updated_at?: string;
      body?: string;
    };
    issue?: { number?: number; pull_request?: unknown; state?: string };
    repository?: { full_name?: string };
    installation?: { id?: number };
  };

  const action = payload.action ?? "";
  const commentId = payload.comment?.id;
  const commentLogin = payload.comment?.user?.login;
  const commentCreatedAt = payload.comment?.created_at;
  const commentUpdatedAt = payload.comment?.updated_at;
  const commentBodyLen = payload.comment?.body?.length ?? 0;
  const issueNumber = payload.issue?.number;
  const issueState = payload.issue?.state;
  const isPr = Boolean(payload.issue?.pull_request);
  const repoFullNameRaw = payload.repository?.full_name;
  const installationIdRaw = payload.installation?.id;

  console.log(
    `[webhook] delivery=${delivery} payload action=${action} commentId=${commentId} commentLogin=${commentLogin} ` +
      `commentCreatedAt=${commentCreatedAt} commentUpdatedAt=${commentUpdatedAt} bodyLen=${commentBodyLen} ` +
      `issue=#${issueNumber} issueState=${issueState} isPr=${isPr} repo=${repoFullNameRaw} installationId=${installationIdRaw}`,
  );

  if (!["created", "edited"].includes(action)) {
    console.log(
      `[webhook] delivery=${delivery} skipping: action=${action} not in [created,edited]`,
    );
    res.json({ skipped: true, reason: `action=${action}` });
    return;
  }
  if (commentLogin !== "greptile-apps[bot]") {
    console.log(
      `[webhook] delivery=${delivery} skipping: commentLogin=${commentLogin} (not greptile)`,
    );
    res.json({ skipped: true, reason: "not greptile" });
    return;
  }
  if (!isPr) {
    console.log(
      `[webhook] delivery=${delivery} skipping: issue #${issueNumber} is not a PR`,
    );
    res.json({ skipped: true, reason: "not a PR comment" });
    return;
  }
  if (issueState !== "open") {
    console.log(
      `[webhook] delivery=${delivery} skipping: PR #${issueNumber} state=${issueState}`,
    );
    res.json({ skipped: true, reason: "PR not open" });
    return;
  }

  const prNumber = issueNumber;
  const repoFullName = repoFullNameRaw;
  const installationId = installationIdRaw;

  if (!prNumber || !repoFullName || !installationId) {
    console.warn(
      `[webhook] delivery=${delivery} missing fields: prNumber=${prNumber} repo=${repoFullName} installationId=${installationId}`,
    );
    res
      .status(400)
      .json({ error: "missing prNumber, repoFullName, or installationId" });
    return;
  }

  const icPrNumber: number = prNumber;
  const icRepo: string = repoFullName;
  const icInstallId: number = installationId;

  const isEdit = action === "edited";
  console.log(
    `[webhook] delivery=${delivery} accepted: PR #${prNumber} repo=${repoFullName} action=${action} isEdit=${isEdit} commentId=${commentId} -> checking CI state`,
  );

  res.status(202).json({ ok: true, queued: true });

  (async () => {
    const token = await getInstallationToken(icInstallId);
    const pr = await fetchPr(token, icRepo, icPrNumber);
    console.log(
      `[webhook] delivery=${delivery} fetched PR #${icPrNumber}: state=${pr.state} draft=${pr.draft} headSha=${pr.head.sha}`,
    );

    // Record that Greptile has commented for this SHA (checked by check_suite handler).
    greptileReadyShas.add(greptileKey(icRepo, icPrNumber, pr.head.sha));

    const allDone = await areAllCheckSuitesComplete(token, icRepo, pr.head.sha);
    if (!allDone) {
      console.log(
        `[webhook] delivery=${delivery} PR #${icPrNumber} sha=${pr.head.sha}: CI not yet complete — check_suite handler will trigger review`,
      );
      return;
    }

    console.log(
      `[webhook] delivery=${delivery} PR #${icPrNumber} sha=${pr.head.sha}: both signals ready (Greptile + CI) — queueing review`,
    );
    await runWebhookReview(icInstallId, icRepo, icPrNumber, delivery, "webhook");
  })().catch((err) => {
    console.error(
      `[webhook] delivery=${delivery} failed for PR #${prNumber}:`,
      err,
    );
  });
});

// --- UI routes ----------------------------------------------------------------

app.get("/", (_req, res) => res.redirect("/chat"));

app.get("/chat", requireLogin, (_req, res) => {
  res.sendFile(join(UI_DIR, "chat.html"));
});

app.get("/runs", requireLogin, (_req, res) => {
  res.sendFile(join(UI_DIR, "runs.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(join(UI_DIR, "login.html"));
});

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };
  if (
    SESSION_AUTH &&
    username === ADMIN_USERNAME &&
    password === ADMIN_PASSWORD
  ) {
    (req.session as any).user = username;
    res.redirect("/chat");
  } else {
    res
      .status(401)
      .send(
        `<!doctype html><html><body>Invalid credentials. <a href="/login">Try again</a></body></html>`,
      );
  }
});

app.post("/logout", (req, res) => {
  req.session?.destroy(() => {});
  res.redirect("/login");
});

// --- Chat thread endpoints ----------------------------------------------------

app.get("/chat/api/threads", requireLogin, (_req, res) => {
  res.json(listThreads());
});

app.post("/chat/api/threads", requireLogin, (_req, res) => {
  const t = createThread();
  res.json(t);
});

app.get("/chat/api/threads/:id", requireLogin, (req, res) => {
  const t = getThread(req.params.id);
  if (!t) return res.status(404).json({ error: "thread not found" });
  res.json({
    id: t.id,
    title: t.title,
    updated_at: t.updated_at,
    turns: t.turns,
  });
});

app.delete("/chat/api/threads/:id", requireLogin, (req, res) => {
  if (!deleteThread(req.params.id))
    return res.status(404).json({ error: "thread not found" });
  res.json({ ok: true });
});

// --- Chat API endpoint --------------------------------------------------------

app.post("/chat/api", requireLogin, async (req, res) => {
  const { message, thread_id, title, run_id } = req.body as {
    message?: string;
    thread_id?: string;
    title?: string;
    run_id?: string;
  };
  if (!message?.trim())
    return res.status(400).json({ error: "message is empty" });

  const tid = thread_id ?? randomUUID().replace(/-/g, "");
  const t0 = Date.now();
  dbg(
    `POST /chat/api: ENTER tid=${tid} runId=${run_id ?? "none"} msgLen=${message.length} preview="${message.slice(0, 80)}"`,
  );
  try {
    await ensureChatSession(tid, title, run_id);
    dbg(
      `POST /chat/api: ensureChatSession done (${Date.now() - t0}ms), calling promptChatSession`,
    );
    const { output, toolTrace, availableTools, intent } = await promptChatSession(
      tid,
      message,
      title,
      run_id,
    );
    dbg(
      `POST /chat/api: promptChatSession resolved (${Date.now() - t0}ms total) outputLen=${output.length}`,
    );
    res.json({
      output,
      tool_trace: toolTrace,
      thread_id: tid,
      available_tools: availableTools,
      intent,
    });
  } catch (err) {
    dbg(`POST /chat/api: THREW after ${Date.now() - t0}ms`, err);
    res.json({
      output: `⚠️ agent failed: ${err}`,
      tool_trace: [],
      thread_id: tid,
    });
  }
});

// --- Streaming chat (SSE) -----------------------------------------------------

app.post("/chat/stream", requireLogin, async (req, res) => {
  const { message, thread_id, title, run_id } = req.body as {
    message?: string;
    thread_id?: string;
    title?: string;
    run_id?: string;
  };
  if (!message?.trim())
    return res.status(400).json({ error: "message is empty" });

  const tid = thread_id ?? randomUUID().replace(/-/g, "");
  const t0 = Date.now();
  dbg(
    `POST /chat/stream: ENTER tid=${tid} runId=${run_id ?? "none"} msgLen=${message.length} preview="${message.slice(0, 80)}"`,
  );
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (obj: object) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    await ensureChatSession(tid, title, run_id);
    dbg(
      `POST /chat/stream: ensureChatSession done (${Date.now() - t0}ms), calling promptChatSessionStreaming`,
    );
    const { output, toolTrace, availableTools, intent } =
      await promptChatSessionStreaming(
        tid,
        message,
        title,
        (event) => send(event),
        run_id,
      );
    dbg(
      `POST /chat/stream: promptChatSessionStreaming resolved (${Date.now() - t0}ms total)`,
    );
    send({
      type: "done",
      output,
      tool_trace: toolTrace,
      thread_id: tid,
      available_tools: availableTools,
      intent,
    });
  } catch (err) {
    dbg(`POST /chat/stream: THREW after ${Date.now() - t0}ms`, err);
    send({ type: "error", message: String(err), thread_id: tid });
  } finally {
    res.end();
    dbg(`POST /chat/stream: response ended tid=${tid}`);
  }
});

// --- OpenAI-compatible completions -------------------------------------------

app.post("/v1/chat/completions", requireLogin, async (req, res) => {
  const body = req.body as {
    messages?: Array<{
      role: string;
      content: string | Array<{ type?: string; text?: string }>;
    }>;
    session_id?: string;
    title?: string;
    model?: string;
    stream?: boolean;
    run_id?: string;
  };
  const msgs = body?.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  function flatContent(c: unknown): string {
    if (typeof c === "string") return c;
    if (Array.isArray(c))
      return c
        .filter((p: any) => p?.type === "text")
        .map((p: any) => p.text)
        .join("");
    return "";
  }
  const userText = flatContent(lastUser?.content);
  if (!userText.trim())
    return res
      .status(400)
      .json({ error: { message: "need non-empty user turn" } });

  const sid = body.session_id ?? randomUUID().replace(/-/g, "");
  try {
    await ensureChatSession(sid, body.title, body.run_id);
    const { output, toolTrace } = await promptChatSession(
      sid,
      userText,
      body.title,
      body.run_id,
    );
    res.json({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "pi-coding-agent",
      session_id: sid,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: output },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      tool_trace: toolTrace,
    });
  } catch (err) {
    res.status(500).json({ error: { message: String(err) } });
  }
});

// --- Runs API -----------------------------------------------------------------

app.get("/runs/api/runs", requireLogin, async (_req, res) => {
  try {
    const rows = await db.listRunsSummary({ limit: 500 });
    res.json(
      rows.map((r) => ({
        run_id: r.run_id,
        ts: r.ts,
        pr_url: r.pr_url,
        pr_number: r.pr_number,
        pr_title: r.pr_title || r.pr_url,
        pr_author: r.pr_author || "",
        score: r.score,
        verdict: r.verdict || "BLOCKED",
        emoji: r.emoji || "⚠️",
        verdict_one_liner: r.verdict_one_liner || "",
        duration_s: r.duration_s,
        cost_usd: r.cost_usd,
        human_label: r.human_label,
        source: r.source,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/runs/api/runs/:id", requireLogin, async (req, res) => {
  try {
    const row = await db.getRun(req.params.id);
    if (!row) return res.status(404).json({ error: "run not found" });
    const msgs = (row.messages as any) ?? {};
    let stagingInfo: { is_staged: boolean; staging_pr_url: string | null; staging_pr_number: number | null } | null = null;
    if (row.pr_number && row.pr_url) {
      const repoMatch = String(row.pr_url).match(/github\.com\/([^/]+\/[^/]+)\/pull\//);
      if (repoMatch) {
        stagingInfo = await db.getStagingMergeInfo(row.pr_number as number, repoMatch[1]).catch(() => null);
      }
    }
    res.json({
      ...row,
      pr_title: row.pr_title || row.pr_url,
      pr_author: row.pr_author || "",
      messages: { triage: msgs.triage ?? [], pattern: msgs.pattern ?? [] },
      is_staged: stagingInfo?.is_staged ?? false,
      staging_pr_url: stagingInfo?.staging_pr_url ?? null,
      staging_pr_number: stagingInfo?.staging_pr_number ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post(
  "/runs/api/runs/:id/label",
  requireLogin,
  express.json(),
  async (req, res) => {
    const { human_label, human_notes } = req.body as {
      human_label?: string | null;
      human_notes?: string | null;
    };
    if (human_label && !["ready", "not_ready"].includes(human_label))
      return res
        .status(400)
        .json({ error: "human_label must be ready, not_ready, or null" });
    try {
      await db.addAnnotation(
        req.params.id,
        human_label ?? null,
        human_notes ?? null,
      );
      const row = await db.getRun(req.params.id);
      res.json(row);
    } catch (err: any) {
      if (err.message?.includes("not found"))
        return res.status(404).json({ error: "run not found" });
      res.status(500).json({ error: String(err) });
    }
  },
);

app.get("/runs/api/runs/:id/annotations", requireLogin, async (req, res) => {
  try {
    res.json(await db.listAnnotations(req.params.id));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/runs/api/runs/:id/llm-logs", requireLogin, async (req, res) => {
  const base = process.env.LITELLM_API_BASE?.replace(/\/+$/, "");
  const key = process.env.LITELLM_API_KEY;
  if (!base || !key)
    return res
      .status(503)
      .json({ error: "LITELLM_API_BASE or LITELLM_API_KEY not configured" });
  try {
    const r = await fetch(
      `${base}/spend/logs?session_id=${encodeURIComponent(req.params.id)}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    if (!r.ok) {
      const txt = await r.text();
      return res
        .status(r.status)
        .json({ error: `LiteLLM error ${r.status}: ${txt.slice(0, 300)}` });
    }
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/runs/api/runs/:id/graduate", requireLogin, async (req, res) => {
  const setName = (req.query.set_name as string) ?? "graduated";
  try {
    const row = await db.getRun(req.params.id);
    if (!row) return res.status(404).json({ error: "run not found" });
    if (!row.human_label)
      return res
        .status(400)
        .json({ error: "label this run first (ready / not_ready)" });
    const gradDate = new Date((row.ts as number) * 1000)
      .toISOString()
      .split("T")[0];
    const upserted = await db.upsertEvalPr({
      url: row.pr_url as string,
      setName,
      category: "graduated_from_runs_ui",
      notes: `Graduated from run ${req.params.id} on ${gradDate}.`,
      humanLabel: row.human_label as string,
      humanNotes: row.human_notes as string | null,
      sourceRunId: req.params.id,
    });
    res.json({
      ok: true,
      set_name: setName,
      eval_pr_id: upserted.id,
      url: upserted.url,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Export endpoint ----------------------------------------------------------

app.get("/api/v1/runs/export", requireLogin, async (req, res) => {
  const { label_state, source, since } = req.query as Record<string, string>;
  try {
    const rows = await db.streamRunsForExport({
      labelState: label_state,
      source,
      sinceEpoch: since ? parseFloat(since) : undefined,
    });
    res.setHeader("Content-Type", "application/x-ndjson");
    for (const row of rows) res.write(JSON.stringify(row) + "\n");
    res.end();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Eval-set CRUD endpoints --------------------------------------------------

app.get("/api/v1/eval-sets", requireLogin, async (_req, res) => {
  try {
    res.json(await db.listEvalSets());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/v1/eval-sets/:name/prs", requireLogin, async (req, res) => {
  try {
    res.json(await db.listEvalPrs(req.params.name));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/v1/eval-sets/:name/prs", requireLogin, async (req, res) => {
  const b = req.body as {
    url: string;
    repo?: string;
    category?: string;
    notes?: string;
    human_label?: string;
    human_notes?: string;
    source_run_id?: string;
  };
  if (!b.url) return res.status(400).json({ error: "url required" });
  try {
    res.json(
      await db.upsertEvalPr({
        url: b.url,
        setName: req.params.name,
        repo: b.repo,
        category: b.category,
        notes: b.notes,
        humanLabel: b.human_label,
        humanNotes: b.human_notes,
        sourceRunId: b.source_run_id,
      }),
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.patch("/api/v1/eval-sets/:name/prs/:id", requireLogin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid id" });
  const b = req.body as {
    category?: string;
    notes?: string;
    human_label?: string;
    human_notes?: string;
  };
  try {
    const row = await db.updateEvalPr(req.params.name, id, {
      category: b.category,
      notes: b.notes,
      humanLabel: b.human_label,
      humanNotes: b.human_notes,
    });
    if (!row) return res.status(404).json({ error: "eval_pr not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete(
  "/api/v1/eval-sets/:name/prs/:id",
  requireLogin,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "invalid id" });
    try {
      const ok = await db.deleteEvalPr(req.params.name, id);
      if (!ok) return res.status(404).json({ error: "eval_pr not found" });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

app.get("/api/v1/eval-sets/:name/download", requireLogin, async (req, res) => {
  try {
    const rows = await db.listEvalPrs(req.params.name);
    res.json(
      rows.map((r) => ({
        url: r.url,
        category: r.category,
        notes: r.notes,
        human_label: r.human_label,
        human_notes: r.human_notes,
        source_run_id: r.source_run_id,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Models endpoint ----------------------------------------------------------

app.get("/api/models", requireLogin, (_req, res) => {
  try {
    const all =
      (global as any).__modelRegistry?.getAll?.()?.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name ?? m.id,
      })) ?? [];
    res.json({ models: all });
  } catch {
    res.json({ models: [] });
  }
});

// --- Backfill endpoint --------------------------------------------------------

app.post("/api/v1/backfill", requireLogin, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "20"), 10) || 20, 100);
  const repo = String(req.query.repo ?? "BerriAI/litellm");
  const org = repo.split("/")[0];

  let installationId: number;
  try {
    installationId = await getOrgInstallationId(org);
  } catch (err) {
    res.status(500).json({ error: `could not find installation: ${err}` }); return;
  }

  let token: string;
  try {
    token = await getInstallationToken(installationId);
  } catch (err) {
    res.status(500).json({ error: `could not get token: ${err}` }); return;
  }

  let prs: Awaited<ReturnType<typeof listOpenPrs>>;
  try {
    prs = await listOpenPrs(token, repo, limit);
  } catch (err) {
    res.status(500).json({ error: `could not list PRs: ${err}` }); return;
  }

  const eligible = prs.filter(p => !p.draft);
  res.json({ queued: eligible.length, total_fetched: prs.length, repo });

  // Run sequentially to avoid hammering the LLM
  (async () => {
    for (const pr of eligible) {
      try {
        console.log(`[backfill] reviewing ${pr.html_url}`);
        await reviewPr(pr.html_url, { source: "backfill" });
      } catch (err) {
        console.error(`[backfill] failed for ${pr.html_url}:`, err);
      }
    }
    console.log(`[backfill] done — reviewed ${eligible.length} PRs`);
  })().catch(console.error);
});

// --- Stabilize stage: re-run unrelated CI failures up to N times --------------

// Push an empty commit to trigger PR checks without requiring actions:write.
// contents:write is sufficient and already granted.
async function pushEmptyCommit(
  token: string,
  repoFullName: string,
  branchName: string,
  message: string,
): Promise<string> {
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const refR = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branchName}`,
    { headers: ghHeaders },
  );
  if (!refR.ok) throw new Error(`get ref failed: ${refR.status}`);
  const currentSha = ((await refR.json()) as { object: { sha: string } }).object.sha;

  const commitR = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/commits/${currentSha}`,
    { headers: ghHeaders },
  );
  if (!commitR.ok) throw new Error(`get commit failed: ${commitR.status}`);
  const treeSha = ((await commitR.json()) as { tree: { sha: string } }).tree.sha;

  const newCommitR = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/commits`,
    {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ message, tree: treeSha, parents: [currentSha] }),
    },
  );
  if (!newCommitR.ok) throw new Error(`create commit failed: ${newCommitR.status}`);
  const newSha = ((await newCommitR.json()) as { sha: string }).sha;

  const updateR = await fetch(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branchName}`,
    {
      method: "PATCH",
      headers: ghHeaders,
      body: JSON.stringify({ sha: newSha }),
    },
  );
  if (!updateR.ok) throw new Error(`update ref failed: ${updateR.status}`);
  return newSha;
}

async function waitForChecks(
  token: string,
  repoFullName: string,
  sha: string,
  checkNames: string[],
  timeoutMs = 25 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 30_000));
    const r = await fetch(
      `https://api.github.com/repos/${repoFullName}/commits/${sha}/check-runs?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!r.ok) continue;
    const data = (await r.json()) as { check_runs: Array<{ name: string; status: string }> };
    const active = data.check_runs.filter(
      (cr) =>
        checkNames.includes(cr.name) &&
        (cr.status === "queued" || cr.status === "in_progress"),
    );
    console.log(`[stabilize] waiting: ${active.length} checks still active`);
    if (active.length === 0) return;
  }
  console.warn(`[stabilize] waitForChecks timed out after ${timeoutMs / 60000}min`);
}

async function stabilizePr(
  installationId: number,
  repoFullName: string,
  prNumber: number,
  prUrl: string,
  headRef: string,
  headSha: string,
  initialRunId: string,
  maxLoops = 3,
): Promise<string> {
  let currentRunId = initialRunId;
  let currentSha = headSha;

  for (let loop = 0; loop < maxLoops; loop++) {
    const run = await db.getRun(currentRunId);
    const triage = run?.triage as Record<string, unknown> | null;
    const unrelated: string[] = (triage?.unrelated_failures as string[]) ?? [];

    if (!unrelated.length) {
      console.log(`[stabilize] PR #${prNumber} loop=${loop} no unrelated failures — done`);
      return currentRunId;
    }

    console.log(`[stabilize] PR #${prNumber} loop=${loop} unrelated=${unrelated.join(", ")}`);

    // Refresh token each loop (expires in 1hr; loops can take 20+ min)
    const token = await getInstallationToken(installationId).catch(() => null);
    if (!token) {
      console.warn(`[stabilize] could not get token, aborting`);
      return currentRunId;
    }

    // Push empty commit to re-trigger all PR checks via contents:write.
    // Safer than actions:write — doesn't grant access to workflow_dispatch
    // or fork PR approval. Only fires pull_request triggers.
    // TODO: CircleCI checks are also re-triggered by the new commit automatically.
    currentSha = await pushEmptyCommit(
      token,
      repoFullName,
      headRef,
      `chore: trigger CI re-run [stabilize loop ${loop + 1}/${maxLoops}]`,
    );
    console.log(`[stabilize] PR #${prNumber} loop=${loop} pushed empty commit ${currentSha}, waiting…`);

    await waitForChecks(token, repoFullName, currentSha, unrelated);

    console.log(`[stabilize] PR #${prNumber} loop=${loop} checks settled, re-reviewing`);
    const { runId: newRunId } = await reviewPr(prUrl, {
      source: `webhook_stabilize_${loop + 1}`,
    });
    currentRunId = newRunId;
  }

  console.log(`[stabilize] PR #${prNumber} reached max loops (${maxLoops})`);
  return currentRunId;
}

// --- Staging PRs list ---------------------------------------------------------

app.get("/api/v1/staging-prs", requireLogin, async (req, res) => {
  const repo = (req.query.repo as string) || "BerriAI/litellm";
  const org = repo.split("/")[0];
  let token: string;
  try {
    const installationId = await getOrgInstallationId(org);
    token = await getInstallationToken(installationId);
  } catch (err) {
    return res.status(500).json({ error: `auth failed: ${err}` });
  }
  const r = await fetch(
    `https://api.github.com/repos/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!r.ok)
    return res.status(500).json({ error: `PR list failed: ${r.status}` });
  const prs = (await r.json()) as Array<{
    number: number;
    title: string;
    html_url: string;
    head: { ref: string };
    base: { ref: string };
    created_at: string;
    updated_at: string;
    user: { login: string };
  }>;
  res.json(
    prs
      .filter((p) => p.head.ref.startsWith("litellm_agent_oss_staging_"))
      .map((p) => ({
        number: p.number,
        title: p.title,
        html_url: p.html_url,
        branch: p.head.ref,
        base: p.base.ref,
        created_at: p.created_at,
        updated_at: p.updated_at,
        author: p.user.login,
      })),
  );
});

// --- Auto-merged PRs list -----------------------------------------------------

app.get("/api/v1/auto-merges", requireLogin, async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10) || 100, 500);
  try {
    res.json(await db.listStagingMerges(limit));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Merge PR to agent staging branch -----------------------------------------

app.post("/api/v1/prs/:number/merge-to-agent-branch", requireLogin, async (req, res) => {
  const prNumber = parseInt(req.params.number, 10);
  const repo = req.query.repo as string;
  if (!repo || isNaN(prNumber))
    return res.status(400).json({ error: "repo query param and numeric PR number required" });

  const org = repo.split("/")[0];
  let token: string;
  try {
    const installationId = await getOrgInstallationId(org);
    token = await getInstallationToken(installationId);
  } catch (err) {
    return res.status(500).json({ error: `auth failed: ${err}` });
  }

  const branch = agentBranchName();
  try {
    const result = await mergePrToAgentBranch(token, repo, prNumber, branch);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/api/v1/prs/:number/staging-merge", requireLogin, async (req, res) => {
  const prNumber = parseInt(req.params.number, 10);
  const repo = req.query.repo as string;
  if (!repo || isNaN(prNumber))
    return res.status(400).json({ error: "repo query param and numeric PR number required" });

  const org = repo.split("/")[0];
  let token: string;
  try {
    const installationId = await getOrgInstallationId(org);
    token = await getInstallationToken(installationId);
  } catch (err) {
    return res.status(500).json({ error: `auth failed: ${err}` });
  }

  const reverted = await db.markStagingMergeReverted(prNumber, repo);
  if (!reverted)
    return res.status(404).json({ error: "no active staging merge found for this PR" });

  const branch = agentBranchName();
  try {
    const rebuildResult = await rebuildStagingBranch(token, repo, branch);
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
    await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
      method: "PATCH",
      headers: ghHeaders,
      body: JSON.stringify({ state: "open" }),
    }).catch((err) => console.warn(`[revert] reopen PR #${prNumber} failed:`, err));
    await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({ body: `🤖 **litellm-agent**: Reverted from staging branch \`${branch}\`. PR reopened for re-review.` }),
    }).catch((err) => console.warn(`[revert] comment on PR #${prNumber} failed:`, err));
    res.json({ ok: true, mergesReplayed: rebuildResult.mergesReplayed });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/agent-info", requireLogin, async (_req, res) => {
  let skills: { name: string; title: string; description: string }[] = [];
  try {
    const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md"));
    skills = files.map((f) => {
      const content = readFileSync(resolve(SKILLS_DIR, f), "utf8");
      const fm = parseSkillFrontmatter(content);
      const name = fm["name"] || f.replace(".md", "");
      return { name, title: name, description: fm["description"] || "" };
    });
  } catch {
    /* skills dir missing or unreadable */
  }

  let tools: { name: string; description: string; inputSchema: unknown }[] = [];
  const base = process.env.LITELLM_API_BASE?.replace(/\/+$/, "");
  const key = process.env.LITELLM_API_KEY;
  if (base && key) {
    try {
      const r = await fetch(`${base}/mcp/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      });
      if (r.ok) {
        const text = await r.text();
        // Response is SSE: "event: message\ndata: {...}\n\n"
        const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
        const data = dataLine
          ? (JSON.parse(dataLine.slice(5).trim()) as {
              result?: { tools?: unknown[] };
              tools?: unknown[];
            })
          : {};
        const list = data?.result?.tools ?? data?.tools ?? [];
        tools = (list as { name?: string; description?: string; inputSchema?: unknown }[]).map((t) => ({
          name: t.name ?? "",
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? {},
        }));
      }
    } catch {
      /* proxy unreachable */
    }
  }

  res.json({ tools, skills });
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- OpenAPI / Swagger docs ---------------------------------------------------

const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "PI PR Review Agent",
    version: "0.1.0",
    description: "PR review agent API",
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      cookieAuth: { type: "apiKey", in: "cookie", name: "litellm_bot_session" },
    },
    schemas: {
      Thread: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          updated_at: { type: "string" },
          turns: { type: "array", items: { type: "object" } },
        },
      },
      Run: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          ts: { type: "number" },
          pr_url: { type: "string" },
          pr_number: { type: "integer" },
          pr_title: { type: "string" },
          pr_author: { type: "string" },
          score: { type: "number" },
          verdict: { type: "string" },
          emoji: { type: "string" },
          verdict_one_liner: { type: "string" },
          duration_s: { type: "number" },
          cost_usd: { type: "number" },
          human_label: { type: "string" },
          source: { type: "string" },
        },
      },
      EvalPr: {
        type: "object",
        properties: {
          id: { type: "integer" },
          url: { type: "string" },
          set_name: { type: "string" },
          repo: { type: "string" },
          category: { type: "string" },
          notes: { type: "string" },
          human_label: { type: "string" },
          human_notes: { type: "string" },
          source_run_id: { type: "string" },
        },
      },
      Error: { type: "object", properties: { error: { type: "string" } } },
    },
  },
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  paths: {
    "/healthz": {
      get: {
        tags: ["Health"],
        summary: "Health check",
        security: [],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    },
    "/webhook/github": {
      post: {
        tags: ["Webhooks"],
        summary: "GitHub webhook receiver",
        security: [],
        description:
          "Receives GitHub pull_request events. Triggers PR review on opened/synchronize/reopened.",
        parameters: [
          {
            name: "x-hub-signature-256",
            in: "header",
            schema: { type: "string" },
            description:
              "HMAC SHA-256 signature (required if GITHUB_WEBHOOK_SECRET set)",
          },
          {
            name: "x-github-event",
            in: "header",
            required: true,
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: {
          "202": { description: "Accepted — review triggered" },
          "200": { description: "Skipped (wrong event/action or draft)" },
          "400": { description: "Bad request" },
          "401": { description: "Invalid/missing signature" },
        },
      },
    },
    "/login": {
      post: {
        tags: ["Auth"],
        summary: "Session login",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["username", "password"],
                properties: {
                  username: { type: "string" },
                  password: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "302": { description: "Redirect to /chat on success" },
          "401": { description: "Invalid credentials" },
        },
      },
    },
    "/logout": {
      post: {
        tags: ["Auth"],
        summary: "Session logout",
        responses: { "302": { description: "Redirect to /login" } },
      },
    },
    "/chat/api/threads": {
      get: {
        tags: ["Chat"],
        summary: "List all chat threads",
        responses: {
          "200": {
            description: "Array of threads",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Thread" },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Chat"],
        summary: "Create new chat thread",
        responses: {
          "200": {
            description: "Created thread",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Thread" },
              },
            },
          },
        },
      },
    },
    "/chat/api/threads/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      get: {
        tags: ["Chat"],
        summary: "Get thread by ID",
        responses: {
          "200": {
            description: "Thread",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Thread" },
              },
            },
          },
          "404": {
            description: "Not found",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
      delete: {
        tags: ["Chat"],
        summary: "Delete thread by ID",
        responses: {
          "200": {
            description: "Deleted",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                },
              },
            },
          },
          "404": { description: "Not found" },
        },
      },
    },
    "/chat/api": {
      post: {
        tags: ["Chat"],
        summary: "Send chat message (non-streaming)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: {
                  message: { type: "string" },
                  thread_id: { type: "string" },
                  title: { type: "string" },
                  run_id: {
                    type: "string",
                    description:
                      "Optional run_id to anchor this chat thread to an existing PR review run; enables debug intent.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Agent response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    output: { type: "string" },
                    tool_trace: { type: "array", items: { type: "object" } },
                    thread_id: { type: "string" },
                    available_tools: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Empty message" },
        },
      },
    },
    "/chat/stream": {
      post: {
        tags: ["Chat"],
        summary: "Send chat message (SSE streaming)",
        description:
          "Returns Server-Sent Events stream. Events: delta, tool_start, tool_end, done, error.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["message"],
                properties: {
                  message: { type: "string" },
                  thread_id: { type: "string" },
                  title: { type: "string" },
                  run_id: {
                    type: "string",
                    description:
                      "Optional run_id to anchor this chat thread to an existing PR review run; enables debug intent.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "SSE stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
          "400": { description: "Empty message" },
        },
      },
    },
    "/v1/chat/completions": {
      post: {
        tags: ["OpenAI-compat"],
        summary: "OpenAI-compatible chat completions",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["messages"],
                properties: {
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        role: { type: "string" },
                        content: {
                          oneOf: [
                            { type: "string" },
                            { type: "array", items: { type: "object" } },
                          ],
                        },
                      },
                    },
                  },
                  session_id: { type: "string" },
                  title: { type: "string" },
                  model: { type: "string" },
                  stream: { type: "boolean" },
                  run_id: {
                    type: "string",
                    description:
                      "Optional run_id to anchor this chat thread to an existing PR review run; enables debug intent.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "OpenAI-format completion response" },
          "400": { description: "No user turn" },
          "500": { description: "Agent error" },
        },
      },
    },
    "/runs/api/runs": {
      get: {
        tags: ["Runs"],
        summary: "List runs (last 500)",
        responses: {
          "200": {
            description: "Array of run summaries",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Run" },
                },
              },
            },
          },
        },
      },
    },
    "/runs/api/runs/{id}": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      get: {
        tags: ["Runs"],
        summary: "Get run by ID (full detail)",
        responses: {
          "200": {
            description: "Run detail",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Run" },
              },
            },
          },
          "404": { description: "Not found" },
        },
      },
    },
    "/runs/api/runs/{id}/label": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      post: {
        tags: ["Runs"],
        summary: "Label a run",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  human_label: {
                    type: "string",
                    enum: ["ready", "not_ready", null],
                  },
                  human_notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated run" },
          "400": { description: "Invalid label value" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/runs/api/runs/{id}/annotations": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      get: {
        tags: ["Runs"],
        summary: "List annotations for a run",
        responses: { "200": { description: "Array of annotations" } },
      },
    },
    "/runs/api/runs/{id}/graduate": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "set_name",
          in: "query",
          schema: { type: "string", default: "graduated" },
        },
      ],
      post: {
        tags: ["Runs"],
        summary: "Graduate a labeled run into an eval set",
        responses: {
          "200": {
            description: "Graduated",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    set_name: { type: "string" },
                    eval_pr_id: { type: "integer" },
                    url: { type: "string" },
                  },
                },
              },
            },
          },
          "400": { description: "Run not yet labeled" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/api/v1/runs/export": {
      get: {
        tags: ["Runs"],
        summary: "Export runs as NDJSON",
        parameters: [
          {
            name: "label_state",
            in: "query",
            schema: { type: "string", enum: ["labeled", "unlabeled", "all"] },
          },
          { name: "source", in: "query", schema: { type: "string" } },
          {
            name: "since",
            in: "query",
            schema: { type: "number" },
            description: "Unix epoch float",
          },
        ],
        responses: {
          "200": {
            description: "NDJSON stream",
            content: { "application/x-ndjson": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/api/v1/eval-sets": {
      get: {
        tags: ["Eval Sets"],
        summary: "List all eval sets",
        responses: { "200": { description: "Array of eval set names" } },
      },
    },
    "/api/v1/eval-sets/{name}/prs": {
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: {
        tags: ["Eval Sets"],
        summary: "List PRs in an eval set",
        responses: {
          "200": {
            description: "Array of eval PRs",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/EvalPr" },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Eval Sets"],
        summary: "Add PR to eval set",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["url"],
                properties: {
                  url: { type: "string" },
                  repo: { type: "string" },
                  category: { type: "string" },
                  notes: { type: "string" },
                  human_label: { type: "string" },
                  human_notes: { type: "string" },
                  source_run_id: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Upserted eval PR",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EvalPr" },
              },
            },
          },
          "400": { description: "url required" },
        },
      },
    },
    "/api/v1/eval-sets/{name}/prs/{id}": {
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
      ],
      patch: {
        tags: ["Eval Sets"],
        summary: "Update eval PR",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  category: { type: "string" },
                  notes: { type: "string" },
                  human_label: { type: "string" },
                  human_notes: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated eval PR" },
          "404": { description: "Not found" },
        },
      },
      delete: {
        tags: ["Eval Sets"],
        summary: "Delete eval PR",
        responses: {
          "200": { description: "Deleted" },
          "404": { description: "Not found" },
        },
      },
    },
    "/api/v1/eval-sets/{name}/download": {
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: {
        tags: ["Eval Sets"],
        summary: "Download eval set as JSON array",
        responses: { "200": { description: "JSON array of eval PRs" } },
      },
    },
    "/api/models": {
      get: {
        tags: ["Models"],
        summary: "List available models",
        responses: {
          "200": {
            description: "Model list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    models: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          provider: { type: "string" },
                          id: { type: "string" },
                          name: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["Docs"],
        summary: "OpenAPI spec (JSON)",
        security: [],
        responses: { "200": { description: "OpenAPI 3.0 spec" } },
      },
    },
    "/api-docs": {
      get: {
        tags: ["Docs"],
        summary: "Swagger UI",
        security: [],
        responses: { "200": { description: "Interactive API docs" } },
      },
    },
  },
};

app.get("/openapi.json", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.json(openApiSpec);
});

app.get("/api-docs", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!doctype html>
<html>
<head>
  <title>PI PR Review Agent — API Docs</title>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" >
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>
  window.onload = function() {
    SwaggerUIBundle({
      url: "/openapi.json",
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
      deepLinking: true,
    })
  }
</script>
</body>
</html>`);
});

// --- Blocked-watch poll -------------------------------------------------------

async function pollBlockedWatches(): Promise<void> {
  const expired = await db.listExpiredBlockedWatches();
  if (!expired.length) return;
  console.log(`[blocked-watch] checking ${expired.length} expired watches`);

  for (const run of expired) {
    const prUrl = run.pr_url as string;
    const prNumber = run.pr_number as number;
    const runId = run.run_id as string;
    const watchStartedAt = run.blocked_watch_started_at as Date;

    const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
    if (!match) {
      console.warn(`[blocked-watch] cannot parse repo from ${prUrl}, skipping`);
      continue;
    }
    const repoFullName = match[1];
    const org = repoFullName.split("/")[0];

    try {
      const installationId = await getOrgInstallationId(org);
      const token = await getInstallationToken(installationId);
      const pr = await fetchPr(token, repoFullName, prNumber).catch(() => null);

      if (!pr || pr.state !== "open") {
        console.log(`[blocked-watch] PR #${prNumber} no longer open — deleting run ${runId}`);
        await db.deleteRun(runId);
        continue;
      }

      const prUpdatedAt = new Date(pr.updated_at);
      if (prUpdatedAt > watchStartedAt) {
        console.log(`[blocked-watch] PR #${prNumber} had activity after watch start (${pr.updated_at}) — re-reviewing`);
        try {
          const { runId: newRunId } = await reviewPr(prUrl, { source: "blocked_watch" });
          const finalRunId = await stabilizePr(installationId, repoFullName, prNumber, prUrl, pr.head.ref, pr.head.sha, newRunId);
          const finalRun = await db.getRun(finalRunId);
          const newVerdict = (finalRun?.card as Record<string, unknown> | null)?.verdict;

          if (newVerdict === "READY") {
            // Hook inside reviewPr handled the merge. Check DB to decide anchor cleanup.
            const merged = await db.isStagingMerged(prNumber, repoFullName);
            if (merged) {
              console.log(`[blocked-watch] PR #${prNumber} now READY and merged — deleting anchor run ${runId}`);
              await db.deleteRun(runId);
            } else {
              console.log(`[blocked-watch] PR #${prNumber} now READY but merge pending/capped — resetting watch`);
              await db.resetBlockedWatch(runId);
            }
          } else {
            console.log(`[blocked-watch] PR #${prNumber} re-reviewed: verdict=${newVerdict} — resetting watch`);
            await db.resetBlockedWatch(runId);
          }
        } catch (reviewErr) {
          console.error(`[blocked-watch] re-review failed for PR #${prNumber}:`, reviewErr);
          await db.resetBlockedWatch(runId);
        }
        continue;
      }

      console.log(`[blocked-watch] PR #${prNumber} stale for 7 days — closing and deleting run ${runId}`);
      await fetch(`https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: "🤖 **litellm-agent**: This PR was marked BLOCKED 7 days ago with no subsequent activity. Closing automatically.",
        }),
      }).catch((err) => console.warn(`[blocked-watch] comment failed for PR #${prNumber}:`, err));
      await fetch(`https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: "closed" }),
      }).catch((err) => console.warn(`[blocked-watch] close failed for PR #${prNumber}:`, err));
      await db.deleteRun(runId);
    } catch (err) {
      console.error(`[blocked-watch] error processing PR #${prNumber} run=${runId}:`, err);
    }
  }
}

// --- Auto-merge hook ----------------------------------------------------------

// isFirstTimeAuthor lives in app/automerge_guards.ts so smoke tests can
// import it without dragging in server.ts's top-level DB init / app.listen.

async function autoMergeReadyPr(
  _prUrl: string,
  prNumber: number,
  repo: string,
  runId: string,
  cardText: string,
): Promise<void> {
  const org = repo.split("/")[0];
  const installationId = await getOrgInstallationId(org);
  const token = await getInstallationToken(installationId);
  const prState = await fetchPr(token, repo, prNumber);
  if (prState.state !== "open") {
    console.log(`[auto-merge] PR #${prNumber} is ${prState.state}, skipping`);
    return;
  }
  const authorLogin = prState.user.login;
  const authorType = prState.user.type;
  const isBot = authorType === "Bot" || /\[bot\]$/.test(authorLogin);
  if (!isBot) {
    const firstTime = await isFirstTimeAuthor(token, repo, authorLogin);
    if (firstTime) {
      console.log(`[auto-merge] PR #${prNumber} first-time author ${authorLogin}, skipping`);
      return;
    }
  }
  const { claimed, countToday } = await db.claimStagingMergeSlot(prNumber, repo, DAILY_MERGE_CAP);
  if (!claimed) {
    console.log(`[auto-merge] PR #${prNumber} cap reached or already staged (${countToday}/${DAILY_MERGE_CAP} today)`);
    return;
  }
  console.log(`[auto-merge] PR #${prNumber} READY — merging to staging (${countToday + 1}/${DAILY_MERGE_CAP} today)`);
  const mergeResult = await mergePrToAgentBranch(token, repo, prNumber, agentBranchName(), cardText);
  await db.updateStagingMergeResult(prNumber, repo, {
    stagingPrUrl: mergeResult.staging_pr_url,
    stagingPrNumber: mergeResult.staging_pr_number,
    mergeCommitSha: mergeResult.merge_commit_sha,
    runId,
  });
}

// --- Startup ------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8081;

await db.initDb();
await initRegistry();
initSystemPrompts();
setAutoMergeHook(autoMergeReadyPr);

// Poll every 6 hours for BLOCKED PRs with no activity after 7 days.
const BLOCKED_WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => { pollBlockedWatches().catch(console.error); }, BLOCKED_WATCH_INTERVAL_MS);
pollBlockedWatches().catch(console.error);

// Watchdog: flip karpathy_check rows stuck in "running" past 10 min into
// "killed". The phase-A insertRun in reviewPr writes status="running" before
// awaiting the karpathy E2B sandbox; if the host process is terminated
// mid-await (Render redeploy, OOM), the row never reaches the post-karpathy
// upsert. Without this poll those rows look indistinguishable from in-flight
// reviews. 30-min cadence + 10-min staleness gives a comfortable margin over
// the typical 60-180s karpathy run + 600s sandbox timeout ceiling.
const KARPATHY_STUCK_INTERVAL_MS = 30 * 60 * 1000;
async function pollStuckKarpathy(): Promise<void> {
  try {
    const flipped = await db.flipStuckKarpathyToKilled(600);
    if (flipped > 0) {
      console.log(`[karpathy-watchdog] flipped ${flipped} stuck rows to killed`);
    }
  } catch (e) {
    console.error("[karpathy-watchdog] poll error:", e);
  }
}
setInterval(() => { pollStuckKarpathy().catch(console.error); }, KARPATHY_STUCK_INTERVAL_MS);
pollStuckKarpathy().catch(console.error);

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
