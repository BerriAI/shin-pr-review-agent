# shin-pr-review-agent

![shin-pr-review-agent](banner.svg)

an agent that reviews GitHub PRs: CI triage, diff analysis, and pattern consistency checks, powered by [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) and LiteLLM.

when `POST_COMMENTS=true`, the agent posts its review directly as a GitHub PR comment.

## Features

- accepts PR URLs via chat UI, API, or OpenAI-compatible endpoint
- runs two gather passes (triage + pattern) then feeds both into the agent
- stores all review runs in Postgres for history and replay
- serves a `/chat` UI and a `/runs` history view
- exposes `POST /v1/chat/completions` (OpenAI-shaped) for machine callers

<img width="2076" height="1812" alt="shin-pr-review-agent output" src="https://github.com/user-attachments/assets/f61dda15-6dbb-4b0c-b714-5054bc1c4e97" />

## How it works

Two Python scripts gather context before the agent runs. No `GITHUB_TOKEN` needed — all GitHub API calls go through the LiteLLM MCP proxy.

**Triage pass** (`scripts/gather_pr_triage_data.py`)

Fetches PR metadata and the per-file diff, then resolves all CI check runs (GitHub Actions + CircleCI + classic status API). For each failing check it pulls:

- GitHub annotations (file:line error messages)
- raw job logs (GitHub Actions) or build failure logs (CircleCI), truncated to the failure window
- check results for 3 other open PRs — so the agent knows whether a failure is pre-existing/flaky or specific to this PR

Also extracts the [Greptile](https://greptile.com) confidence score from PR comments if present.

**Pattern pass** (`scripts/gather_pattern_local.py`)

Uses a local git clone — one `git fetch`, no API rate limits. Diffs the PR against `main`, then for each changed file:

- extracts keywords from the filename/path
- greps the docs tree for those keywords and pulls the nearest heading + surrounding excerpt
- reads the first ~1200 chars of sibling files in the same directory

Then runs conflict detection: compares how the docs and the sibling code handle the same patterns (e.g. `verbose_logger` vs `logging.getLogger`, `httpx.AsyncClient` vs `litellm.module_level_aclient`). Mismatches are surfaced as explicit conflict hints.

The agent gets both JSON blobs and produces a structured review.

## Setup

```bash
nvm use 20
npm install
cp .env.example .env
# fill in DATABASE_URL, LITELLM_API_BASE, LITELLM_API_KEY
```

Prerequisites: Node **≥20.6**, PostgreSQL. The app applies SQL migrations on startup.

For the pattern pass, point `LITELLM_CLONE_DIR` at a local clone of the repo being reviewed (defaults to `~/Documents/litellm`).

## Usage

```bash
# watch + reload
npm run dev

# production
npm start
```

Default port **8081** (`PORT` overrides).

**Browser:** open `/chat` to talk to the agent, `/runs` to see saved reviews.

**API:**
```bash
curl http://localhost:8081/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -d '{"model":"x","messages":[{"role":"user","content":"review https://github.com/org/repo/pull/123"}]}'
```

## Auth flags

Both default to off — safe to run locally with no gate.

- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — enables login at `/login`
- `BOT_API_KEYS` — comma-separated bearer tokens for API access

No auth env vars set = no gate. Fine on localhost. Do not expose unauthenticated to the public internet.
