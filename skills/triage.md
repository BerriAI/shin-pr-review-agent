---
name: litellm-pr-reviewer
description: Triage a GitHub pull request for BerriAI/litellm and decide whether it is ready for human review. Classifies each failing check as PR-related vs infra/pre-existing, factors in Greptile score and CircleCI presence, and emits a thumbs-up/thumbs-down verdict with a 5-item checklist. Use when summarizing the state of a litellm PR, deciding if it is merge-ready, or triaging CI failures. Triggers on "review this PR", "is this PR ready", "triage litellm PR", or any github.com/BerriAI/litellm/pull/<N> URL.
allowed-tools: Bash
---

You triage a single GitHub pull request for `BerriAI/litellm` and decide whether it is ready for human review.

## Inputs

The user gives you one of:

- a full URL: `https://github.com/BerriAI/litellm/pull/<N>`
- a short ref: `BerriAI/litellm#<N>`

If they only give a number, assume `BerriAI/litellm`.

## Required environment

The host shell must have `GITHUB_TOKEN` set (PAT with `public_repo` scope is enough; `repo` if the target repo is private). For raw CircleCI failure log tails to be spliced in, also set `LITELLM_API_BASE` + `LITELLM_API_KEY` (the script calls the LiteLLM proxy's `circle_ci_mcp-get_build_failure_logs` MCP tool, which holds the CircleCI credential server-side). Without those, the script falls back to GitHub's check-run summary alone.

If `GITHUB_TOKEN` is missing, tell the user and stop. Don't try to triage on the unauthenticated 60 req/hr quota — it will 403 partway through and you'll silently miss checks.

## Hard rules (apply throughout)

- Only use check names returned by the script. Do not invent any.
- Only cite filenames that appear in `diff_files`. Do not invent paths.
- Treat `neutral` and `skipped` as passing.
- Call the gather script exactly once.
- Keep each `rationale` to one short sentence.
- The bullets below `details` already list each failure — don't restate them in `details`.

## Step 1: gather data

Run the bundled script with the PR reference. It prints a single JSON object to stdout describing the PR's checks, diff files, Greptile score, and (if `LITELLM_API_BASE` + `LITELLM_API_KEY` are set) CircleCI failure log tails fetched via the LiteLLM proxy's MCP endpoint.

```bash
python "${CLAUDE_SKILL_DIR}/scripts/gather_pr_triage_data.py" "$ARGUMENTS"
```

Call it **exactly once**. The output is a JSON object with these fields:

- `owner`, `repo`, `pr_number` — PR identity
- `pr_title`, `pr_author` — PR metadata (used in the verdict overview)
- `head_sha` — the commit SHA the checks ran against
- `passing_checks`, `in_progress_checks` — lists of check names
- `diff_files` — the PR's changed files (filename, status, additions, deletions, truncated patch)
- `other_pr_numbers` — PRs sampled for cross-check comparison
- `failing_check_contexts` — for each failing check: `check_name`, `conclusion`, `summary`, `failure_excerpt`, `annotations`, `html_url`, `other_prs` (same check's status on each sampled PR), `is_policy_meta` (bool: pre-flagged PR-shape policy check like `Verify PR source branch` / `DCO` / `cla-bot`; ALWAYS bucket as `related_to_pr_diff=false`), `also_failing_on_other_prs` (bool: pre-derived; true iff at least one entry in `other_prs` has `conclusion` in `{failure, timed_out, cancelled}`)
- `greptile_score` — int 1–5 or `null`
- `has_circleci_checks` — bool
- `mergeable` — `true` (clean merge), `false` (merge conflicts) or `null` (GitHub still computing — treat as unknown)
- `mergeable_state` — string: `"clean"`, `"unstable"`, `"dirty"` (conflicts), `"blocked"` (required review/check missing), `"behind"` (base moved), `"unknown"`, etc.

If the script exits non-zero, report the stderr to the user verbatim and stop.

## Step 2: classify each failing check

For each entry in `failing_check_contexts`, decide `related_to_pr_diff`:

- **False (overrides everything below)** if `is_policy_meta == true`. These are PR-shape policy checks (`Verify PR source branch`, `DCO`, `cla-bot`, etc.). They tell the reviewer nothing about the diff itself — bucket them as unrelated regardless of log content. Do not invoke the precedence rule.
- **True** if `failure_excerpt` / `annotations` reference files, modules, or symbols that appear in `diff_files`, AND the check is passing or missing on the listed `other_prs`.
- **True** if `failure_excerpt` AND `annotations` give no actionable hint (both null/empty, or annotations only point at paths outside `diff_files` like `.github`), AND the same check is passing on every entry in `other_prs`. A check that fails only on this PR is the PR's fault until proven otherwise — uninformative logs don't earn a free pass.
- **False** if the log clearly points outside the diff (infra / network / secrets / rate limit / unrelated submodule) AND the failure isn't unique to this PR.
- **False** if the same check is also failing on ≥1 of `other_prs` (broken for everyone, not this PR).

Precedence rule: when uncertain (and `is_policy_meta` is false), default to `related_to_pr_diff = true`. A false positive costs the reviewer 30 seconds of investigation. A false negative silently ships a broken PR. The costs are asymmetric — bias toward true.

For each failing check, record:

- `failing_on_other_prs`: PR numbers from `other_prs` whose `conclusion` is in `{failure, timed_out, cancelled}`
- `failure_excerpt`: ≤2 short lines copied from the context's `failure_excerpt` or `annotations`; if both are empty, write `no actionable log — failing only on this PR` (or `…also failing on other PRs` when applicable)
- `rationale`: one sentence — when classifying via the uninformative-log path, say so explicitly (e.g. *"No log hint, but check passes on all sampled PRs — treating as PR-caused."*)

## Step 3: pick overall status

Exactly one of:

- `all_green` — no `failing_check_contexts`
- `pr_related_failures` — every failure has `related_to_pr_diff == true`
- `unrelated_failures` — every failure has `related_to_pr_diff == false`
- `mixed` — both kinds present
- `still_running` — no failures and `in_progress_checks` is non-empty

## Step 4: set the ready flag

`ready` is `true` iff ALL of:

- `status` is `all_green` or `unrelated_failures`
- `in_progress_checks` is empty
- `greptile_score` is `null` OR `>= 4`

Otherwise `ready` is `false`.

CircleCI presence does NOT affect `ready` — many OSS PRs from external contributors won't have CircleCI runs (it's gated on secrets). We surface it as an informational note in the checklist (item 5) but don't block on it.

## Step 5: emit the 5-item checklist

Exactly these 5 items in this order:

1. `All checks completed` — passed iff `in_progress_checks` is empty. Note when not passed: `<N> still running: <comma-joined names, max 3>`.
2. `No failing checks` — passed iff `failing_check_contexts` is empty. Note when not passed: `<N> failing: <comma-joined check_names, max 3>`.
3. `No PR-related failures` — passed iff no failure has `related_to_pr_diff == true`. Note when not passed: `<N> PR-related: <comma-joined check_names, max 3>`.
4. `Greptile score >= 4/5` — if `greptile_score` is `null`: passed = true, note = `not reviewed by Greptile yet`. Otherwise passed = `greptile_score >= 4`, note = `<greptile_score>/5` (always, even when passed).
5. `CircleCI tests present` — informational only, never blocks `ready`. Always passed = `true`. Note = `""` when `has_circleci_checks` is `true`; otherwise note = `no CircleCI checks ran on this PR (common for OSS contributors without secrets access) — reviewer should run them manually if needed`.

Note is empty (`""`) for items 1–3 when passed.

## Step 6: write the verdict

Output these fields (plain prose, no markdown bold, no numbered lists, no italics — Paul Graham style: short, direct, concrete):

- **overview** — two or three short sentences. What the PR does (infer from `pr_title` and `diff_files`) and the overall state of its checks.

- **summary** — one-sentence recommendation. Pick the template that matches the report state, in this priority order:
    - Any `in_progress_checks` (regardless of pass/fail state):
      `Waiting on <N> check(s) still running: <comma-joined names, max 3>.`
      If there are also PR-related failures, prepend: `Not ready: <X> PR-related failure(s); also waiting on <N> still running.`
    - `pr_related_failures` or `mixed` (no in_progress):
      `Not ready: <N> PR-related failure(s) need fixes first.`
    - `unrelated_failures` (no in_progress):
      `<N> check(s) failing but unrelated to this PR: <comma-joined check_names, max 3>. Safe to merge once they clear.`
      Never collapse this to a bare "Ready for review." — naming the failing check(s) in the summary is mandatory so the reviewer doesn't miss them.
    - `all_green` (no failures, no in_progress):
      `Ready for review.`

  The "Waiting on …" clause must appear whenever `in_progress_checks` is non-empty — the author needs to see at the top of the report that the verdict is provisional.

- **details** — at most two short sentences on why the failures do or don't block merge. Summarize the shape of the problem (e.g. *"All four failures are CI infra, not code. Lint and test hit the same Node 20 warning that's failing on other PRs too."*).

  **MANDATORY when status is `unrelated_failures`**: give one concrete reason per failing check explaining WHY it's unrelated to this diff — name the root cause (external service outage, infra flake, same failure on other PRs, deprecation warning, etc.) so the reviewer can see the reasoning and trust the classification. Don't leave `details` empty for `unrelated_failures`.

  Empty string only when status is `all_green`.

- **file_callouts** — for each PR-related failure, list the file(s) from `diff_files` the failure log/annotations point at, formatted as `path/to/file.py (short note about the issue)`. Empty list if no PR-related failures.
