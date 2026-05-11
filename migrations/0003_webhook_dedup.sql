CREATE TABLE IF NOT EXISTS webhook_reviewed (
  pr_number  INTEGER      NOT NULL,
  head_sha   TEXT         NOT NULL,
  repo       TEXT         NOT NULL DEFAULT '',
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pr_number, head_sha, repo)
);
