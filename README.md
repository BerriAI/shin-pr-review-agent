# shin-pr-review-agent

![shin-pr-review-agent](banner.svg)

an agent that reviews GitHub PRs: triage + pattern analysis, powered by [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) and LiteLLM.

when `POST_COMMENTS=true`, the agent posts its review directly as a GitHub PR comment.

## Features

- accepts PR URLs via chat UI, API, or OpenAI-compatible endpoint
- runs triage + pattern review pipeline via pi-coding-agent
- stores all review runs in Postgres for history and replay
- serves a `/chat` UI and a `/runs` history view
- exposes `POST /v1/chat/completions` (OpenAI-shaped) for machine callers

<img width="2076" height="1812" alt="shin-pr-review-agent output" src="https://github.com/user-attachments/assets/f61dda15-6dbb-4b0c-b714-5054bc1c4e97" />

## Setup

```bash
nvm use 20
npm install
cp .env.example .env
# fill in DATABASE_URL, LITELLM_API_BASE, LITELLM_API_KEY
```

Prerequisites: Node **≥20.6**, PostgreSQL. The app applies SQL migrations on startup.

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
# OpenAI-shaped
curl http://localhost:8081/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -d '{"model":"x","messages":[{"role":"user","content":"review https://github.com/org/repo/pull/123"}]}'
```

## Auth flags

Both default to off — safe to run locally with no gate.

- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — enables login at `/login`
- `BOT_API_KEYS` — comma-separated bearer tokens for API access

No auth env vars set = no gate. Fine on localhost. Do not expose unauthenticated to the public internet.
