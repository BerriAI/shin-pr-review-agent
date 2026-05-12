-- Adds the coverage_gap column to runs.
--
-- Stores the output of runCoverageGapCheck() — a structured record of
-- new guards found in the PR diff, the input classes enumerated for each,
-- and which classes lack test coverage. Empty `{}` means the check did
-- not run (e.g. provisional verdict was BLOCKED so karpathy/coverage_gap
-- were short-circuited, or CURSOR_API_KEY was not configured).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS coverage_gap JSONB DEFAULT '{}'::jsonb;
