-- Track every PR auto-merged into an agent staging branch.
-- One row per (pr_number, repo) pair — unique index prevents double-staging.
-- The claimStagingMergeSlot CTE uses this table as its atomic counter,
-- so the daily cap check and slot reservation happen in a single statement.

CREATE TABLE IF NOT EXISTS staging_merges (
  id                BIGSERIAL   PRIMARY KEY,
  pr_number         INT         NOT NULL,
  repo              TEXT        NOT NULL,
  run_id            TEXT,
  staging_pr_url    TEXT,
  staging_pr_number INT,
  merge_commit_sha  TEXT,
  merged_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS staging_merges_pr_repo_uidx
  ON staging_merges (pr_number, repo);

CREATE INDEX IF NOT EXISTS staging_merges_date_idx
  ON staging_merges (merged_at);
