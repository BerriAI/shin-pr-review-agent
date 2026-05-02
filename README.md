# shin-pr-review-agent

Small HTTP server that chats with GitHub PRs: triage + pattern review, powered by [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) and LiteLLM.

## What you need

- Node **≥20.6**
- **PostgreSQL** (`DATABASE_URL`)
- A **LiteLLM** deployment (`LITELLM_API_BASE`, `LITELLM_API_KEY`)

Copy `.env.example` → `.env` and fill it in. The app applies SQL migrations on startup.

## Run

```bash
npm install
npm run dev    # watch + reload
# or
npm start
```

Default port **8081** (`PORT` overrides).

## Use it

**Browser:** `/chat` (talk to the agent), `/runs` (saved reviews).

**Auth:** If you set `ADMIN_USERNAME` / `ADMIN_PASSWORD` or `BOT_API_KEYS`, routes are locked. Log in via `/login`, or send `Authorization: Bearer <key>` for APIs.

**Machines:** `POST /chat/api` or `POST /v1/chat/completions` (OpenAI-shaped: last user message is the prompt). Same auth as above.

**No auth env vars = no gate.** Fine on localhost. Stupid on the public internet.

## What it does

You give it a PR URL (or ask in chat). It runs the review pipeline, stores runs in Postgres, and can show history in the UI.

That’s the deal.
