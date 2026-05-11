-- Track when a BLOCKED PR entered the inactivity monitoring window.
-- If no GitHub activity is detected within 7 days, the PR is closed and
-- the run entry is deleted by the background poll loop.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS blocked_watch_started_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS runs_blocked_watch_idx ON runs (blocked_watch_started_at)
  WHERE blocked_watch_started_at IS NOT NULL;
