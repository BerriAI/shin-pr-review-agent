-- Initial schema for litellm-bot.
--
-- Three tables:
--
--   eval_prs    — curated PR sets the eval harness grades against.
--                 Replaces tests/eval/pr_set*.json. One row per PR per
--                 set_name; (url, set_name) is unique so the same PR can
--                 sit in 'default' AND 'v3-graduated' with potentially
--                 different labels/notes.
--
--   runs        — every PR review the agent produces, regardless of source
--                 (Slack, /chat, eval harness). Carries the full
--                 pydantic_ai message trace as JSONB so any future LLM-judge
--                 or replay tool can reconstruct what the agent saw.
--
--   annotations — append-only label/notes history per run. The "current"
--                 label is also denormalized onto runs.human_label /
--                 runs.human_notes so the list view stays a one-table read.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-running this script
-- against an already-bootstrapped DB is a no-op. Real schema migrations
-- (renames, drops, type changes) get their own numbered files.

CREATE TABLE IF NOT EXISTS eval_prs (
    id            BIGSERIAL    PRIMARY KEY,
    url           TEXT         NOT NULL,
    repo          TEXT         NOT NULL DEFAULT 'BerriAI/litellm',
    -- Logical name for the curated set (e.g. 'default', 'v1', 'v2',
    -- 'graduated-from-runs-ui'). The eval harness picks one set_name to
    -- run against; downloads / API listings filter on it.
    set_name      TEXT         NOT NULL DEFAULT 'default',
    category      TEXT,
    notes         TEXT,
    -- Tri-state ground truth. NULL = "not yet graded", same semantics as
    -- the existing pr_set.json _label_legend.
    human_label   TEXT,
    human_notes   TEXT,
    -- Provenance for graduated entries: pointer back at the run that
    -- produced this row. Nullable for hand-curated entries that never
    -- went through /runs.
    source_run_id TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (url, set_name),
    CHECK (human_label IS NULL OR human_label IN ('ready', 'not_ready'))
);
CREATE INDEX IF NOT EXISTS eval_prs_set_name_idx ON eval_prs (set_name);
CREATE INDEX IF NOT EXISTS eval_prs_url_idx ON eval_prs (url);

CREATE TABLE IF NOT EXISTS runs (
    -- Caller-minted UUID/hex id (matches Logfire trace id when available
    -- so the two systems stay correlatable). Not auto-generated.
    run_id           TEXT         PRIMARY KEY,
    ts               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    pr_url           TEXT         NOT NULL,
    pr_number        INTEGER,
    pr_title         TEXT,
    pr_author        TEXT,
    -- Where the run came from: 'slack' | 'chat' | 'eval' | 'replay' | 'mock'.
    -- Drives the scope badge in the /runs UI and lets the eval harness
    -- query "all eval-source runs since X" without dragging in Slack noise.
    source           TEXT         NOT NULL DEFAULT 'slack',
    channel          TEXT,
    thread_ts        TEXT,
    duration_s       DOUBLE PRECISION,
    logfire_trace_id TEXT,
    model_name       TEXT,
    tokens_in        INTEGER,
    tokens_out       INTEGER,
    cost_usd         DOUBLE PRECISION,
    -- Structured agent payloads. JSONB (not JSON) so we can index/query
    -- specific fields later (e.g. WHERE card->>'verdict' = 'BLOCKED').
    triage           JSONB,
    pattern          JSONB,
    card             JSONB,
    -- Rolled-up tool-trace summary (the chat UI's existing renderer).
    tool_trace       JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Full pydantic_ai messages, dumped via ModelMessagesTypeAdapter.
    -- Round-trips back into ModelMessage[] so any LLM-judge / replay can
    -- reconstruct the agent's view. Default {triage:[], pattern:[]} so
    -- pre-instrumentation rows don't need a migration to load.
    messages         JSONB        NOT NULL DEFAULT '{"triage":[],"pattern":[]}'::jsonb,
    -- Denormalized "latest annotation" for the list view. Canonical
    -- history lives in `annotations`. Updated by the annotation writer.
    human_label      TEXT,
    human_notes      TEXT,
    CHECK (human_label IS NULL OR human_label IN ('ready', 'not_ready'))
);
CREATE INDEX IF NOT EXISTS runs_pr_url_idx ON runs (pr_url);
CREATE INDEX IF NOT EXISTS runs_ts_idx ON runs (ts DESC);
CREATE INDEX IF NOT EXISTS runs_source_idx ON runs (source);

CREATE TABLE IF NOT EXISTS annotations (
    id          BIGSERIAL    PRIMARY KEY,
    run_id      TEXT         NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    human_label TEXT,
    human_notes TEXT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CHECK (human_label IS NULL OR human_label IN ('ready', 'not_ready'))
);
CREATE INDEX IF NOT EXISTS annotations_run_id_idx ON annotations (run_id, created_at DESC);
