import { randomUUID, timingSafeEqual } from "node:crypto";
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

const app = express();
app.use(express.json({ limit: "10mb" }));
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

// --- Startup ------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 8081;

await db.initDb();
await initRegistry();
initSystemPrompts();

app.listen(PORT, () => {
  console.log(`listening on http://localhost:${PORT}`);
});
