import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

let _pool: pg.Pool | null = null;

export async function initDb(): Promise<pg.Pool> {
  if (_pool) return _pool;
  const dsn = process.env.DATABASE_URL;
  if (!dsn) throw new Error("DATABASE_URL is required");
  _pool = new Pool({ connectionString: dsn, max: 10, idleTimeoutMillis: 30000 });
  await bootstrapSchema();
  return _pool;
}

export async function closeDb(): Promise<void> {
  if (_pool) { await _pool.end(); _pool = null; }
}

function pool(): pg.Pool {
  if (!_pool) throw new Error("db.initDb() has not been called");
  return _pool;
}

async function bootstrapSchema(): Promise<void> {
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const client = await pool().connect();
  try {
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

// --- Run helpers ---

export async function insertRun(record: Record<string, unknown>): Promise<void> {
  const sql = `
    INSERT INTO runs (
      run_id, ts, pr_url, pr_number, pr_title, pr_author,
      source, channel, thread_ts, duration_s, logfire_trace_id,
      model_name, tokens_in, tokens_out, cost_usd,
      triage, pattern, card, tool_trace, messages,
      human_label, human_notes, karpathy_check
    ) VALUES (
      $1, COALESCE(to_timestamp($2), NOW()), $3, $4, $5, $6,
      $7, $8, $9, $10, $11,
      $12, $13, $14, $15,
      $16, $17, $18, $19, $20,
      $21, $22, $23
    )
    ON CONFLICT (run_id) DO UPDATE SET
      ts = EXCLUDED.ts, pr_url = EXCLUDED.pr_url,
      pr_number = EXCLUDED.pr_number, pr_title = EXCLUDED.pr_title,
      pr_author = EXCLUDED.pr_author, source = EXCLUDED.source,
      channel = EXCLUDED.channel, thread_ts = EXCLUDED.thread_ts,
      duration_s = EXCLUDED.duration_s, logfire_trace_id = EXCLUDED.logfire_trace_id,
      model_name = EXCLUDED.model_name, tokens_in = EXCLUDED.tokens_in,
      tokens_out = EXCLUDED.tokens_out, cost_usd = EXCLUDED.cost_usd,
      triage = EXCLUDED.triage, pattern = EXCLUDED.pattern,
      card = EXCLUDED.card, tool_trace = EXCLUDED.tool_trace,
      messages = EXCLUDED.messages, karpathy_check = EXCLUDED.karpathy_check
  `;
  await pool().query(sql, [
    record.run_id, record.ts ?? null, record.pr_url, record.pr_number ?? null,
    record.pr_title ?? null, record.pr_author ?? null,
    record.source ?? "chat", record.channel ?? null, record.thread_ts ?? null,
    record.duration_s ?? null, record.logfire_trace_id ?? null,
    record.model_name ?? null, record.tokens_in ?? null, record.tokens_out ?? null,
    record.cost_usd ?? null,
    JSON.stringify(record.triage ?? {}), JSON.stringify(record.pattern ?? {}),
    JSON.stringify(record.card ?? {}), JSON.stringify(record.tool_trace ?? []),
    JSON.stringify(record.messages ?? { triage: [], pattern: [] }),
    record.human_label ?? null, record.human_notes ?? null,
    JSON.stringify(record.karpathy_check ?? {}),
  ]);
}

export async function listRunsSummary(opts: {
  source?: string; labelState?: string; sinceEpoch?: number; limit?: number;
} = {}): Promise<Record<string, unknown>[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  function add(clause: string, val: unknown) {
    args.push(val);
    where.push(clause.replace("$?", `$${args.length}`));
  }
  if (opts.source) add("source = $?", opts.source);
  if (opts.sinceEpoch != null) add("ts >= to_timestamp($?)", opts.sinceEpoch);
  if (opts.labelState === "labeled") where.push("human_label IS NOT NULL");
  else if (opts.labelState === "unlabeled") where.push("human_label IS NULL");
  else if (opts.labelState === "ready" || opts.labelState === "not_ready")
    add("human_label = $?", opts.labelState);

  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  args.push(opts.limit ?? 500);
  const sql = `
    SELECT run_id,
           EXTRACT(EPOCH FROM ts)::float8 AS ts,
           pr_url, pr_number, pr_title, pr_author,
           source, duration_s, cost_usd, human_label,
           card->>'score' AS score_str,
           card->>'verdict' AS verdict,
           card->>'emoji' AS emoji,
           card->>'verdict_one_liner' AS verdict_one_liner
    FROM runs ${whereSql}
    ORDER BY ts DESC LIMIT $${args.length}
  `;
  const { rows } = await pool().query(sql, args);
  return rows.map((r) => ({
    ...r,
    score: parseInt(r.score_str ?? "0", 10) || 0,
    score_str: undefined,
  }));
}

export async function getRun(runId: string): Promise<Record<string, unknown> | null> {
  const sql = `
    SELECT run_id, EXTRACT(EPOCH FROM ts)::float8 AS ts,
           pr_url, pr_number, pr_title, pr_author,
           source, channel, thread_ts, duration_s, logfire_trace_id,
           model_name, tokens_in, tokens_out, cost_usd,
           triage, pattern, card, tool_trace, messages,
           human_label, human_notes, karpathy_check
    FROM runs WHERE run_id = $1
  `;
  const { rows } = await pool().query(sql, [runId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    ...r,
    triage: typeof r.triage === "string" ? JSON.parse(r.triage) : (r.triage ?? {}),
    pattern: typeof r.pattern === "string" ? JSON.parse(r.pattern) : (r.pattern ?? {}),
    card: typeof r.card === "string" ? JSON.parse(r.card) : (r.card ?? {}),
    tool_trace: typeof r.tool_trace === "string" ? JSON.parse(r.tool_trace) : (r.tool_trace ?? []),
    messages: typeof r.messages === "string" ? JSON.parse(r.messages) : (r.messages ?? { triage: [], pattern: [] }),
    karpathy_check: typeof r.karpathy_check === "string" ? JSON.parse(r.karpathy_check) : (r.karpathy_check ?? {}),
  };
}

export async function addAnnotation(
  runId: string, label: string | null, notes: string | null
): Promise<Record<string, unknown>> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const { rows: [ann] } = await client.query(
      `INSERT INTO annotations (run_id, human_label, human_notes)
       VALUES ($1, $2, $3)
       RETURNING id, EXTRACT(EPOCH FROM created_at)::float8 AS created_at`,
      [runId, label, notes]
    );
    const { rowCount } = await client.query(
      `UPDATE runs SET human_label = $2, human_notes = $3 WHERE run_id = $1`,
      [runId, label, notes]
    );
    if (!rowCount) { await client.query("ROLLBACK"); throw new Error(`run not found: ${runId}`); }
    await client.query("COMMIT");
    return { id: ann.id, run_id: runId, human_label: label, human_notes: notes, created_at: ann.created_at };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function listAnnotations(runId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await pool().query(
    `SELECT id, run_id, human_label, human_notes,
            EXTRACT(EPOCH FROM created_at)::float8 AS created_at
     FROM annotations WHERE run_id = $1 ORDER BY created_at DESC`,
    [runId]
  );
  return rows;
}

export async function streamRunsForExport(opts: {
  labelState?: string; source?: string; sinceEpoch?: number;
} = {}): Promise<Record<string, unknown>[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  function add(clause: string, val: unknown) {
    args.push(val);
    where.push(clause.replace("$?", `$${args.length}`));
  }
  if (opts.source) add("source = $?", opts.source);
  if (opts.sinceEpoch != null) add("ts >= to_timestamp($?)", opts.sinceEpoch);
  if (opts.labelState === "labeled") where.push("human_label IS NOT NULL");
  else if (opts.labelState === "unlabeled") where.push("human_label IS NULL");
  else if (opts.labelState === "ready" || opts.labelState === "not_ready")
    add("human_label = $?", opts.labelState);
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const sql = `
    SELECT run_id, EXTRACT(EPOCH FROM ts)::float8 AS ts,
           pr_url, pr_number, pr_title, pr_author,
           source, channel, thread_ts, duration_s, logfire_trace_id,
           model_name, tokens_in, tokens_out, cost_usd,
           triage, pattern, card, tool_trace, messages,
           human_label, human_notes, karpathy_check
    FROM runs ${whereSql} ORDER BY ts DESC
  `;
  const { rows } = await pool().query(sql, args);
  return rows;
}

// --- Eval-set helpers ---

export async function listEvalSets(): Promise<Record<string, unknown>[]> {
  const { rows } = await pool().query(`
    SELECT set_name,
           COUNT(*)::int AS pr_count,
           SUM(CASE WHEN human_label IS NOT NULL THEN 1 ELSE 0 END)::int AS labeled_count,
           EXTRACT(EPOCH FROM MAX(updated_at))::float8 AS updated_at
    FROM eval_prs GROUP BY set_name ORDER BY set_name
  `);
  return rows;
}

export async function listEvalPrs(setName: string): Promise<Record<string, unknown>[]> {
  const { rows } = await pool().query(`
    SELECT id, url, repo, set_name, category, notes,
           human_label, human_notes, source_run_id,
           EXTRACT(EPOCH FROM created_at)::float8 AS created_at,
           EXTRACT(EPOCH FROM updated_at)::float8 AS updated_at
    FROM eval_prs WHERE set_name = $1 ORDER BY id
  `, [setName]);
  return rows;
}

export async function upsertEvalPr(opts: {
  url: string; setName: string; repo?: string; category?: string | null;
  notes?: string | null; humanLabel?: string | null; humanNotes?: string | null;
  sourceRunId?: string | null;
}): Promise<Record<string, unknown>> {
  const { rows: [row] } = await pool().query(`
    INSERT INTO eval_prs (url, repo, set_name, category, notes, human_label, human_notes, source_run_id, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (url, set_name) DO UPDATE SET
      repo = EXCLUDED.repo,
      category = COALESCE(EXCLUDED.category, eval_prs.category),
      notes = COALESCE(EXCLUDED.notes, eval_prs.notes),
      human_label = COALESCE(EXCLUDED.human_label, eval_prs.human_label),
      human_notes = COALESCE(EXCLUDED.human_notes, eval_prs.human_notes),
      source_run_id = COALESCE(EXCLUDED.source_run_id, eval_prs.source_run_id),
      updated_at = NOW()
    RETURNING id, url, repo, set_name, category, notes, human_label, human_notes, source_run_id,
              EXTRACT(EPOCH FROM created_at)::float8 AS created_at,
              EXTRACT(EPOCH FROM updated_at)::float8 AS updated_at
  `, [opts.url, opts.repo ?? "BerriAI/litellm", opts.setName, opts.category ?? null,
      opts.notes ?? null, opts.humanLabel ?? null, opts.humanNotes ?? null, opts.sourceRunId ?? null]);
  return row;
}

export async function deleteEvalPr(setName: string, prId: number): Promise<boolean> {
  const { rowCount } = await pool().query(
    "DELETE FROM eval_prs WHERE set_name = $1 AND id = $2", [setName, prId]
  );
  return (rowCount ?? 0) > 0;
}

export async function startBlockedWatch(runId: string): Promise<void> {
  await pool().query(
    `UPDATE runs SET blocked_watch_started_at = NOW() WHERE run_id = $1 AND blocked_watch_started_at IS NULL`,
    [runId],
  );
}

export async function resetBlockedWatch(runId: string): Promise<void> {
  await pool().query(
    `UPDATE runs SET blocked_watch_started_at = NOW() WHERE run_id = $1`,
    [runId],
  );
}

export async function listExpiredBlockedWatches(): Promise<Record<string, unknown>[]> {
  const { rows } = await pool().query(`
    SELECT run_id,
           pr_url, pr_number,
           EXTRACT(EPOCH FROM blocked_watch_started_at)::float8 AS blocked_watch_started_at_epoch,
           blocked_watch_started_at
    FROM runs
    WHERE card->>'verdict' = 'BLOCKED'
      AND blocked_watch_started_at IS NOT NULL
      AND blocked_watch_started_at < NOW() - INTERVAL '7 days'
  `);
  return rows;
}

export async function deleteRun(runId: string): Promise<boolean> {
  const { rowCount } = await pool().query(
    `DELETE FROM runs WHERE run_id = $1`,
    [runId],
  );
  return (rowCount ?? 0) > 0;
}

// Returns true if this (pr_number, head_sha, repo) is new — caller should proceed.
// Returns false if already claimed — caller should skip.
export async function claimWebhookReview(prNumber: number, headSha: string, repo: string): Promise<boolean> {
  const { rowCount } = await pool().query(
    `INSERT INTO webhook_reviewed (pr_number, head_sha, repo) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [prNumber, headSha, repo]
  );
  return (rowCount ?? 0) > 0;
}

export async function updateEvalPr(setName: string, prId: number, opts: {
  category?: string | null; notes?: string | null;
  humanLabel?: string | null; humanNotes?: string | null;
}): Promise<Record<string, unknown> | null> {
  const sets: string[] = [];
  const args: unknown[] = [];
  function add(field: string, val: unknown) {
    args.push(val);
    sets.push(`${field} = $${args.length}`);
  }
  if (opts.category != null) add("category", opts.category);
  if (opts.notes != null) add("notes", opts.notes);
  if (opts.humanLabel != null) add("human_label", opts.humanLabel);
  if (opts.humanNotes != null) add("human_notes", opts.humanNotes);
  sets.push("updated_at = NOW()");
  args.push(setName); args.push(prId);
  if (sets.length === 1) {
    const { rows: [r] } = await pool().query(`
      SELECT id, url, repo, set_name, category, notes, human_label, human_notes, source_run_id,
             EXTRACT(EPOCH FROM created_at)::float8 AS created_at,
             EXTRACT(EPOCH FROM updated_at)::float8 AS updated_at
      FROM eval_prs WHERE set_name = $1 AND id = $2
    `, [setName, prId]);
    return r ?? null;
  }
  const { rows: [row] } = await pool().query(`
    UPDATE eval_prs SET ${sets.join(", ")}
    WHERE set_name = $${args.length - 1} AND id = $${args.length}
    RETURNING id, url, repo, set_name, category, notes, human_label, human_notes, source_run_id,
              EXTRACT(EPOCH FROM created_at)::float8 AS created_at,
              EXTRACT(EPOCH FROM updated_at)::float8 AS updated_at
  `, args);
  return row ?? null;
}
