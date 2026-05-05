import { randomUUID, timingSafeEqual, createHmac } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import * as db from "./db.js";
import {
  initRegistry,
  initSystemPrompts,
  reviewPr,
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

// --- Debug logger -------------------------------------------------------------
const _DBG_T0 = Date.now();
function dbg(tag: string, ...rest: unknown[]): void {
  const ms = Date.now() - _DBG_T0;
  // eslint-disable-next-line no-console
  console.log(`[debug +${ms}ms] ${tag}`, ...rest);
}

// --- Auth config --------------------------------------------------------------

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const BOT_API_KEYS = new Set(
  (process.env.BOT_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean)
);
const SESSION_AUTH = !!(ADMIN_USERNAME && ADMIN_PASSWORD);
const AUTH_ENABLED = SESSION_AUTH || BOT_API_KEYS.size > 0;
const SESSION_SECRET = process.env.SESSION_SECRET ?? randomUUID();

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
  if (SESSION_AUTH && (req.session as any)?.user === ADMIN_USERNAME) return next();
  const accept = req.headers.accept ?? "";
  if (SESSION_AUTH && accept.includes("text/html") && req.method === "GET") {
    res.redirect(303, "/login"); return;
  }
  res.status(401).json({ error: "login required" });
}

// --- Express app --------------------------------------------------------------

function verifyGithubSignature(rawBody: Buffer, sigHeader: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const actual = Buffer.from(sigHeader, "utf8");
  const exp = Buffer.from(expected, "utf8");
  if (actual.length !== exp.length) return false;
  return timingSafeEqual(actual, exp);
}

const app = express();
app.use(express.json({
  limit: "10mb",
  verify: (req: any, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: false }));

if (SESSION_AUTH) {
  app.use(session({
    secret: SESSION_SECRET,
    name: "litellm_bot_session",
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax", httpOnly: true },
  }));
}

// --- GitHub webhook -----------------------------------------------------------

app.post("/webhook/github", (req, res) => {
  const sigRaw = req.headers["x-hub-signature-256"];
  const sig = Array.isArray(sigRaw) ? sigRaw[0] : sigRaw;
  const eventRaw = req.headers["x-github-event"];
  const event = Array.isArray(eventRaw) ? eventRaw[0] : eventRaw;

  if (GITHUB_WEBHOOK_SECRET) {
    if (!sig) { res.status(401).json({ error: "missing signature" }); return; }
    const rawBody: Buffer = (req as any).rawBody;
    if (!rawBody || !verifyGithubSignature(rawBody, sig, GITHUB_WEBHOOK_SECRET)) {
      res.status(401).json({ error: "invalid signature" }); return;
    }
  }

  if (event !== "pull_request") {
    res.json({ skipped: true, reason: `event=${event}` }); return;
  }

  const payload = req.body as {
    action?: string;
    pull_request?: { html_url?: string; draft?: boolean; number?: number };
  };
  const action = payload.action ?? "";
  const pr = payload.pull_request;

  if (!["opened", "synchronize", "reopened"].includes(action)) {
    res.json({ skipped: true, reason: `action=${action}` }); return;
  }
  if (!pr?.html_url) {
    res.status(400).json({ error: "missing pull_request.html_url" }); return;
  }
  if (pr.draft) {
    res.json({ skipped: true, reason: "draft PR" }); return;
  }

  res.status(202).json({ ok: true, pr_url: pr.html_url });

  reviewPr(pr.html_url, { source: "webhook" }).catch((err) => {
    console.error(`[webhook] reviewPr failed for ${pr.html_url}:`, err);
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
  const { username, password } = req.body as { username?: string; password?: string };
  if (SESSION_AUTH && username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    (req.session as any).user = username;
    res.redirect("/chat");
  } else {
    res.status(401).send(
      `<!doctype html><html><body>Invalid credentials. <a href="/login">Try again</a></body></html>`
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
  res.json({ id: t.id, title: t.title, updated_at: t.updated_at, turns: t.turns });
});

app.delete("/chat/api/threads/:id", requireLogin, (req, res) => {
  if (!deleteThread(req.params.id)) return res.status(404).json({ error: "thread not found" });
  res.json({ ok: true });
});

// --- Chat API endpoint --------------------------------------------------------

app.post("/chat/api", requireLogin, async (req, res) => {
  const { message, thread_id, title } = req.body as {
    message?: string; thread_id?: string; title?: string;
  };
  if (!message?.trim()) return res.status(400).json({ error: "message is empty" });

  const tid = thread_id ?? randomUUID().replace(/-/g, "");
  const t0 = Date.now();
  dbg(`POST /chat/api: ENTER tid=${tid} msgLen=${message.length} preview="${message.slice(0, 80)}"`);
  try {
    await ensureChatSession(tid, title);
    dbg(`POST /chat/api: ensureChatSession done (${Date.now() - t0}ms), calling promptChatSession`);
    const { output, toolTrace, availableTools } = await promptChatSession(tid, message, title);
    dbg(`POST /chat/api: promptChatSession resolved (${Date.now() - t0}ms total) outputLen=${output.length}`);
    res.json({ output, tool_trace: toolTrace, thread_id: tid, available_tools: availableTools });
  } catch (err) {
    dbg(`POST /chat/api: THREW after ${Date.now() - t0}ms`, err);
    res.json({ output: `⚠️ agent failed: ${err}`, tool_trace: [], thread_id: tid });
  }
});

// --- Streaming chat (SSE) -----------------------------------------------------

app.post("/chat/stream", requireLogin, async (req, res) => {
  const { message, thread_id, title } = req.body as {
    message?: string; thread_id?: string; title?: string;
  };
  if (!message?.trim()) return res.status(400).json({ error: "message is empty" });

  const tid = thread_id ?? randomUUID().replace(/-/g, "");
  const t0 = Date.now();
  dbg(`POST /chat/stream: ENTER tid=${tid} msgLen=${message.length} preview="${message.slice(0, 80)}"`);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (obj: object) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    await ensureChatSession(tid, title);
    dbg(`POST /chat/stream: ensureChatSession done (${Date.now() - t0}ms), calling promptChatSessionStreaming`);
    const { output, toolTrace, availableTools } = await promptChatSessionStreaming(
      tid, message, title,
      (event) => send(event)
    );
    dbg(`POST /chat/stream: promptChatSessionStreaming resolved (${Date.now() - t0}ms total)`);
    send({ type: "done", output, tool_trace: toolTrace, thread_id: tid, available_tools: availableTools });
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
    messages?: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>;
    session_id?: string; title?: string; model?: string; stream?: boolean;
  };
  const msgs = body?.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  function flatContent(c: unknown): string {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("");
    return "";
  }
  const userText = flatContent(lastUser?.content);
  if (!userText.trim()) return res.status(400).json({ error: { message: "need non-empty user turn" } });

  const sid = body.session_id ?? randomUUID().replace(/-/g, "");
  try {
    await ensureChatSession(sid, body.title);
    const { output, toolTrace } = await promptChatSession(sid, userText, body.title);
    res.json({
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "pi-coding-agent",
      session_id: sid,
      choices: [{ index: 0, message: { role: "assistant", content: output }, finish_reason: "stop" }],
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
    res.json(rows.map((r) => ({
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
    })));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get("/runs/api/runs/:id", requireLogin, async (req, res) => {
  try {
    const row = await db.getRun(req.params.id);
    if (!row) return res.status(404).json({ error: "run not found" });
    const msgs = (row.messages as any) ?? {};
    res.json({
      ...row,
      pr_title: row.pr_title || row.pr_url,
      pr_author: row.pr_author || "",
      messages: { triage: msgs.triage ?? [], pattern: msgs.pattern ?? [] },
    });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post("/runs/api/runs/:id/label", requireLogin, express.json(), async (req, res) => {
  const { human_label, human_notes } = req.body as { human_label?: string | null; human_notes?: string | null };
  if (human_label && !["ready", "not_ready"].includes(human_label))
    return res.status(400).json({ error: "human_label must be ready, not_ready, or null" });
  try {
    await db.addAnnotation(req.params.id, human_label ?? null, human_notes ?? null);
    const row = await db.getRun(req.params.id);
    res.json(row);
  } catch (err: any) {
    if (err.message?.includes("not found")) return res.status(404).json({ error: "run not found" });
    res.status(500).json({ error: String(err) });
  }
});

app.get("/runs/api/runs/:id/annotations", requireLogin, async (req, res) => {
  try { res.json(await db.listAnnotations(req.params.id)); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post("/runs/api/runs/:id/graduate", requireLogin, async (req, res) => {
  const setName = (req.query.set_name as string) ?? "graduated";
  try {
    const row = await db.getRun(req.params.id);
    if (!row) return res.status(404).json({ error: "run not found" });
    if (!row.human_label) return res.status(400).json({ error: "label this run first (ready / not_ready)" });
    const gradDate = new Date((row.ts as number) * 1000).toISOString().split("T")[0];
    const upserted = await db.upsertEvalPr({
      url: row.pr_url as string,
      setName,
      category: "graduated_from_runs_ui",
      notes: `Graduated from run ${req.params.id} on ${gradDate}.`,
      humanLabel: row.human_label as string,
      humanNotes: row.human_notes as string | null,
      sourceRunId: req.params.id,
    });
    res.json({ ok: true, set_name: setName, eval_pr_id: upserted.id, url: upserted.url });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// --- Export endpoint ----------------------------------------------------------

app.get("/api/v1/runs/export", requireLogin, async (req, res) => {
  const { label_state, source, since } = req.query as Record<string, string>;
  try {
    const rows = await db.streamRunsForExport({
      labelState: label_state, source,
      sinceEpoch: since ? parseFloat(since) : undefined,
    });
    res.setHeader("Content-Type", "application/x-ndjson");
    for (const row of rows) res.write(JSON.stringify(row) + "\n");
    res.end();
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// --- Eval-set CRUD endpoints --------------------------------------------------

app.get("/api/v1/eval-sets", requireLogin, async (_req, res) => {
  try { res.json(await db.listEvalSets()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get("/api/v1/eval-sets/:name/prs", requireLogin, async (req, res) => {
  try { res.json(await db.listEvalPrs(req.params.name)); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post("/api/v1/eval-sets/:name/prs", requireLogin, async (req, res) => {
  const b = req.body as {
    url: string; repo?: string; category?: string; notes?: string;
    human_label?: string; human_notes?: string; source_run_id?: string;
  };
  if (!b.url) return res.status(400).json({ error: "url required" });
  try {
    res.json(await db.upsertEvalPr({
      url: b.url, setName: req.params.name, repo: b.repo,
      category: b.category, notes: b.notes,
      humanLabel: b.human_label, humanNotes: b.human_notes,
      sourceRunId: b.source_run_id,
    }));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.patch("/api/v1/eval-sets/:name/prs/:id", requireLogin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid id" });
  const b = req.body as { category?: string; notes?: string; human_label?: string; human_notes?: string };
  try {
    const row = await db.updateEvalPr(req.params.name, id, {
      category: b.category, notes: b.notes,
      humanLabel: b.human_label, humanNotes: b.human_notes,
    });
    if (!row) return res.status(404).json({ error: "eval_pr not found" });
    res.json(row);
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.delete("/api/v1/eval-sets/:name/prs/:id", requireLogin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "invalid id" });
  try {
    const ok = await db.deleteEvalPr(req.params.name, id);
    if (!ok) return res.status(404).json({ error: "eval_pr not found" });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get("/api/v1/eval-sets/:name/download", requireLogin, async (req, res) => {
  try {
    const rows = await db.listEvalPrs(req.params.name);
    res.json(rows.map((r) => ({
      url: r.url, category: r.category, notes: r.notes,
      human_label: r.human_label, human_notes: r.human_notes,
      source_run_id: r.source_run_id,
    })));
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// --- Models endpoint ----------------------------------------------------------

app.get("/api/models", requireLogin, (_req, res) => {
  try {
    const all = (global as any).__modelRegistry?.getAll?.()?.map((m: any) => ({
      provider: m.provider, id: m.id, name: m.name ?? m.id,
    })) ?? [];
    res.json({ models: all });
  } catch { res.json({ models: [] }); }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// --- OpenAPI / Swagger docs ---------------------------------------------------

const openApiSpec = {
  openapi: "3.0.3",
  info: { title: "PI PR Review Agent", version: "0.1.0", description: "PR review agent API" },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      cookieAuth: { type: "apiKey", in: "cookie", name: "litellm_bot_session" },
    },
    schemas: {
      Thread: {
        type: "object",
        properties: {
          id: { type: "string" }, title: { type: "string" }, updated_at: { type: "string" },
          turns: { type: "array", items: { type: "object" } },
        },
      },
      Run: {
        type: "object",
        properties: {
          run_id: { type: "string" }, ts: { type: "number" }, pr_url: { type: "string" },
          pr_number: { type: "integer" }, pr_title: { type: "string" }, pr_author: { type: "string" },
          score: { type: "number" }, verdict: { type: "string" }, emoji: { type: "string" },
          verdict_one_liner: { type: "string" }, duration_s: { type: "number" },
          cost_usd: { type: "number" }, human_label: { type: "string" }, source: { type: "string" },
        },
      },
      EvalPr: {
        type: "object",
        properties: {
          id: { type: "integer" }, url: { type: "string" }, set_name: { type: "string" },
          repo: { type: "string" }, category: { type: "string" }, notes: { type: "string" },
          human_label: { type: "string" }, human_notes: { type: "string" }, source_run_id: { type: "string" },
        },
      },
      Error: { type: "object", properties: { error: { type: "string" } } },
    },
  },
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  paths: {
    "/healthz": {
      get: {
        tags: ["Health"], summary: "Health check", security: [],
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } } },
      },
    },
    "/webhook/github": {
      post: {
        tags: ["Webhooks"], summary: "GitHub webhook receiver", security: [],
        description: "Receives GitHub pull_request events. Triggers PR review on opened/synchronize/reopened.",
        parameters: [
          { name: "x-hub-signature-256", in: "header", schema: { type: "string" }, description: "HMAC SHA-256 signature (required if GITHUB_WEBHOOK_SECRET set)" },
          { name: "x-github-event", in: "header", required: true, schema: { type: "string" } },
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
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
        tags: ["Auth"], summary: "Session login", security: [],
        requestBody: { required: true, content: { "application/x-www-form-urlencoded": { schema: { type: "object", required: ["username", "password"], properties: { username: { type: "string" }, password: { type: "string" } } } } } },
        responses: { "302": { description: "Redirect to /chat on success" }, "401": { description: "Invalid credentials" } },
      },
    },
    "/logout": {
      post: {
        tags: ["Auth"], summary: "Session logout",
        responses: { "302": { description: "Redirect to /login" } },
      },
    },
    "/chat/api/threads": {
      get: {
        tags: ["Chat"], summary: "List all chat threads",
        responses: { "200": { description: "Array of threads", content: { "application/json": { schema: { type: "array", items: { "$ref": "#/components/schemas/Thread" } } } } } },
      },
      post: {
        tags: ["Chat"], summary: "Create new chat thread",
        responses: { "200": { description: "Created thread", content: { "application/json": { schema: { "$ref": "#/components/schemas/Thread" } } } } },
      },
    },
    "/chat/api/threads/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        tags: ["Chat"], summary: "Get thread by ID",
        responses: {
          "200": { description: "Thread", content: { "application/json": { schema: { "$ref": "#/components/schemas/Thread" } } } },
          "404": { description: "Not found", content: { "application/json": { schema: { "$ref": "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        tags: ["Chat"], summary: "Delete thread by ID",
        responses: {
          "200": { description: "Deleted", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } },
          "404": { description: "Not found" },
        },
      },
    },
    "/chat/api": {
      post: {
        tags: ["Chat"], summary: "Send chat message (non-streaming)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["message"], properties: { message: { type: "string" }, thread_id: { type: "string" }, title: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "Agent response", content: { "application/json": { schema: { type: "object", properties: { output: { type: "string" }, tool_trace: { type: "array", items: { type: "object" } }, thread_id: { type: "string" }, available_tools: { type: "array", items: { type: "string" } } } } } } },
          "400": { description: "Empty message" },
        },
      },
    },
    "/chat/stream": {
      post: {
        tags: ["Chat"], summary: "Send chat message (SSE streaming)",
        description: "Returns Server-Sent Events stream. Events: delta, tool_start, tool_end, done, error.",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["message"], properties: { message: { type: "string" }, thread_id: { type: "string" }, title: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } },
          "400": { description: "Empty message" },
        },
      },
    },
    "/v1/chat/completions": {
      post: {
        tags: ["OpenAI-compat"], summary: "OpenAI-compatible chat completions",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object", required: ["messages"],
                properties: {
                  messages: { type: "array", items: { type: "object", properties: { role: { type: "string" }, content: { oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }] } } } },
                  session_id: { type: "string" }, title: { type: "string" }, model: { type: "string" }, stream: { type: "boolean" },
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
        tags: ["Runs"], summary: "List runs (last 500)",
        responses: { "200": { description: "Array of run summaries", content: { "application/json": { schema: { type: "array", items: { "$ref": "#/components/schemas/Run" } } } } } },
      },
    },
    "/runs/api/runs/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        tags: ["Runs"], summary: "Get run by ID (full detail)",
        responses: {
          "200": { description: "Run detail", content: { "application/json": { schema: { "$ref": "#/components/schemas/Run" } } } },
          "404": { description: "Not found" },
        },
      },
    },
    "/runs/api/runs/{id}/label": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      post: {
        tags: ["Runs"], summary: "Label a run",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { human_label: { type: "string", enum: ["ready", "not_ready", null] }, human_notes: { type: "string" } } } } } },
        responses: {
          "200": { description: "Updated run" },
          "400": { description: "Invalid label value" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/runs/api/runs/{id}/annotations": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: {
        tags: ["Runs"], summary: "List annotations for a run",
        responses: { "200": { description: "Array of annotations" } },
      },
    },
    "/runs/api/runs/{id}/graduate": {
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        { name: "set_name", in: "query", schema: { type: "string", default: "graduated" } },
      ],
      post: {
        tags: ["Runs"], summary: "Graduate a labeled run into an eval set",
        responses: {
          "200": { description: "Graduated", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" }, set_name: { type: "string" }, eval_pr_id: { type: "integer" }, url: { type: "string" } } } } } },
          "400": { description: "Run not yet labeled" },
          "404": { description: "Run not found" },
        },
      },
    },
    "/api/v1/runs/export": {
      get: {
        tags: ["Runs"], summary: "Export runs as NDJSON",
        parameters: [
          { name: "label_state", in: "query", schema: { type: "string", enum: ["labeled", "unlabeled", "all"] } },
          { name: "source", in: "query", schema: { type: "string" } },
          { name: "since", in: "query", schema: { type: "number" }, description: "Unix epoch float" },
        ],
        responses: { "200": { description: "NDJSON stream", content: { "application/x-ndjson": { schema: { type: "string" } } } } },
      },
    },
    "/api/v1/eval-sets": {
      get: {
        tags: ["Eval Sets"], summary: "List all eval sets",
        responses: { "200": { description: "Array of eval set names" } },
      },
    },
    "/api/v1/eval-sets/{name}/prs": {
      parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
      get: {
        tags: ["Eval Sets"], summary: "List PRs in an eval set",
        responses: { "200": { description: "Array of eval PRs", content: { "application/json": { schema: { type: "array", items: { "$ref": "#/components/schemas/EvalPr" } } } } } },
      },
      post: {
        tags: ["Eval Sets"], summary: "Add PR to eval set",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" }, repo: { type: "string" }, category: { type: "string" }, notes: { type: "string" }, human_label: { type: "string" }, human_notes: { type: "string" }, source_run_id: { type: "string" } } } } },
        },
        responses: { "200": { description: "Upserted eval PR", content: { "application/json": { schema: { "$ref": "#/components/schemas/EvalPr" } } } }, "400": { description: "url required" } },
      },
    },
    "/api/v1/eval-sets/{name}/prs/{id}": {
      parameters: [
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
      ],
      patch: {
        tags: ["Eval Sets"], summary: "Update eval PR",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { category: { type: "string" }, notes: { type: "string" }, human_label: { type: "string" }, human_notes: { type: "string" } } } } } },
        responses: { "200": { description: "Updated eval PR" }, "404": { description: "Not found" } },
      },
      delete: {
        tags: ["Eval Sets"], summary: "Delete eval PR",
        responses: { "200": { description: "Deleted" }, "404": { description: "Not found" } },
      },
    },
    "/api/v1/eval-sets/{name}/download": {
      parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
      get: {
        tags: ["Eval Sets"], summary: "Download eval set as JSON array",
        responses: { "200": { description: "JSON array of eval PRs" } },
      },
    },
    "/api/models": {
      get: {
        tags: ["Models"], summary: "List available models",
        responses: { "200": { description: "Model list", content: { "application/json": { schema: { type: "object", properties: { models: { type: "array", items: { type: "object", properties: { provider: { type: "string" }, id: { type: "string" }, name: { type: "string" } } } } } } } } } },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["Docs"], summary: "OpenAPI spec (JSON)", security: [],
        responses: { "200": { description: "OpenAPI 3.0 spec" } },
      },
    },
    "/api-docs": {
      get: {
        tags: ["Docs"], summary: "Swagger UI", security: [],
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

// --- Startup ------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8081;

await db.initDb();
await initRegistry();
initSystemPrompts();

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
