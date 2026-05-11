-- Adds observability columns to runs.
--
-- These persist every signal that drives a verdict or auto-merge decision so
-- the `/runs` chat LLM can answer "why did this PR (not) merge?" from the DB
-- row alone:
--   * gate_results       — full evaluations from every deterministic gate
--                          (greptile / size / logging-screenshot), pass or
--                          fail. Empty `[]` means the gates have not yet run.
--   * fuse_trace         — ordered list of fuse() rules with fired/weight/
--                          label, so we can reconstruct the verdict without
--                          re-running fuse.
--   * automerge_decision — outcome of autoMergeReadyPr() on every exit path
--                          (merged / skipped / failed) plus reason+evidence.
--                          NULL means auto-merge was never attempted (verdict
--                          not READY).
--   * merge_error        — raw error message when the merge API throws.
--   * timing             — per-phase elapsed_ms (gather / gates / triage /
--                          karpathy / fuse / total). Empty `{}` means the run
--                          predates the timing instrumentation.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, so re-running this migration against
-- an already-bootstrapped DB is a no-op.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS gate_results       JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS fuse_trace         JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS automerge_decision JSONB;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS merge_error        TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS timing             JSONB NOT NULL DEFAULT '{}'::jsonb;
