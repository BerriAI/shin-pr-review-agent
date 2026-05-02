-- Adds the karpathy_check column to runs.
--
-- Output of `karpathy_check.run_karpathy_check()` — the senior-engineer
-- pre-merge review (merge_gate + findings). Empty `{}` means the check
-- did not run for this PR (e.g. fused verdict was BLOCKED so we
-- short-circuited).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, so re-running this migration
-- against an already-bootstrapped DB is a no-op.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS karpathy_check JSONB DEFAULT '{}'::jsonb;
