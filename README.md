# Followup Dashboard

Lead-followup and sales-intelligence dashboard for Focas. Node/Express + MongoDB
backend, React (Vite) frontend, built as one Docker image and deployed as a single
container on port `7007` (behind a reverse proxy for TLS).

It ingests Bigin CRM tasks, syncs and transcribes TeleCMI call recordings, grades
sales calls, runs WhatsApp campaigns via WATI — and, since the `crm-integration`
plan (see `plans/crm-integration/`), it also **owns public lead capture and Meta
Ads sync**, both of which used to live in a separate, now-retired service
(`focas-crm`). See `plans/crm-integration/CUTOVER.md` for the cutover that made
this the case, and `plans/crm-integration/FOCAS_CRM_RETIREMENT.md` for what that
service was and where its data went.

## Structure

```
backend/    Express API + Mongo models (CommonJS, no build step)
frontend/   React (Vite) SPA, built to frontend/dist and served by the backend
```

`backend/modules/` holds the self-contained feature modules (`calls/`, `campaigns/`,
`ads/`); everything else is the original flat MVC layout (`routes/` → `controllers/`
→ `services/` → `models/`).

## API

Every endpoint is documented in [`docs/API.md`](docs/API.md) — auth level, query
params, request/response examples and error codes.

The same reference is in the dashboard itself, under the **API Docs** tab, where
every GET endpoint has a **Run** button that fires the real request with your
session token. That tab is the source of truth: both it and the markdown file are
generated from `frontend/src/apiDocs.js`, so they cannot drift apart. After editing
that table, regenerate the file:

```bash
npm --prefix frontend run docs
```

## Local development

```bash
# Backend
cd backend
cp .env.example .env        # fill in real values — see below
npm install
npm run dev                 # nodemon, http://localhost:3000 by default

# Frontend
cd frontend
npm install
npm run dev                 # Vite dev server
```

A local MongoDB (`mongod`) is required; `MONGO_URI` in `.env` defaults to
`mongodb://127.0.0.1:27017/followup_dashboard`.

## Production deployment (Docker)

```bash
export GITHUB_PACKAGES_TOKEN=ghp_xxx   # see "GitHub Packages token" below
docker compose build
cp backend/.env.example backend/.env   # fill in real values — see below
docker compose up -d
curl http://127.0.0.1:7007/health      # {"status":"ok"}
```

`docker-compose.yml` builds a two-stage image (frontend build → backend runtime,
see `Dockerfile`), publishes port `7007`, sets `TZ=Asia/Kolkata` (the "overdue /
today / upcoming" task buckets use server-local midnight — get this wrong and
evening-IST tasks land in the wrong bucket), and reads runtime config from
`backend/.env` via `env_file`. Front it with a TLS-terminating reverse proxy
(nginx/Caddy/Traefik) — the container itself only serves plain HTTP.

### GitHub Packages token (build-time only)

The backend depends on `@santhosh785/meta-ads` (the Meta Marketing API connector,
also used by the now-retired `focas-crm`), published to **GitHub Packages**, not
npmjs.org. `backend/.npmrc` points the `@santhosh785` scope there and resolves the
token from `GITHUB_PACKAGES_TOKEN` at install time.

- **Local `npm install`/`npm ci`:** `export GITHUB_PACKAGES_TOKEN=<PAT with read:packages scope>`
  before running.
- **Docker build:** supplied as a **build secret**, not a build ARG/ENV — see the
  `RUN --mount=type=secret` step in `Dockerfile`. This keeps the token out of every
  image layer and the build history. `docker-compose.yml`'s `secrets:` block
  sources it from the `GITHUB_PACKAGES_TOKEN` environment variable in the shell
  running `docker compose build` — export it there, it is never written to a file
  in this repo.

Get a token with `read:packages` scope from whoever administers the
`@santhosh785` GitHub org/account. Without it, both `npm ci` and `docker compose
build` fail resolving `@santhosh785/meta-ads`.

## Environment variables

Full reference with inline comments: `backend/.env.example`. Summary by area:

| Area | Variables |
|---|---|
| Core | `PORT`, `MONGO_URI`, `JWT_SECRET`, `ADMIN_NAME`/`ADMIN_USERNAME`/`ADMIN_PASSWORD`/`ADMIN_EMAIL` |
| WhatsApp / WATI | `WATI_API_URL`, `WATI_TOKEN` |
| Zoho/Bigin write-back (optional) | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ACCOUNTS_URL`, `ZOHO_API_URL`, `ZOHO_MODULE` |
| **Meta Ads sync** (new — see below) | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_API_VERSION`, `SYNC_INTERVAL_MINUTES`, `META_LEAD_FORM_IDS`, `META_PAGE_ID`, `AD_INSIGHT_LOOKBACK_DAYS`, `AD_SYNC_FIRST_RUN_DELAY_MS` |
| **Public lead ingest** (new — see below) | `CORS_ORIGINS`, `WEB_LEAD_RATE_MAX`, `LEAD_INGEST_TOKEN` |
| **Ask assistant** (new — see below) | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `OPENAI_MAX_OUTPUT_TOKENS`, `AGENT_MAX_ROUNDS`, `AGENT_RATE_MAX`, `BIGIN_COQL_ENABLED` |
| Build-time only | `GITHUB_PACKAGES_TOKEN` (see above — not a runtime var, not in `backend/.env`) |

### This service now owns public lead capture

`POST /api/leads/web` is the endpoint the Focas landing pages' lead-capture forms
post to (via a server-side lead forwarder, not directly from the browser). It
replaced `crm.focasedu.online`'s equivalent route. Before pointing real traffic at
it, set:

- `CORS_ORIGINS` — comma-separated allowlist of browser origins allowed to call it
  directly. Production value: `https://focasedu.com` (the real landing-page
  origin — this is not a placeholder, it's what the retired CRM's own production
  config used). Note this does **not** gate the server-to-server lead-forwarder
  traffic, which carries no browser `Origin` header at all — see
  `plans/crm-integration/CUTOVER.md` for why.
- `LEAD_INGEST_TOKEN` — shared secret the lead forwarder must send as
  `X-Lead-Ingest-Token`. This is new hardening the retired CRM never had. Unset =
  the check is skipped (fine for local dev only) and the server logs a boot
  warning.
- `WEB_LEAD_RATE_MAX` — per-IP requests/minute on the endpoint (default 60).
  Since real traffic arrives via a single-IP forwarder rather than individual
  browsers, this caps the forwarder's aggregate rate, not each visitor's.

`GET /api/leads/web` (the read side, full lead PII) is admin-JWT-gated — the CRM
served this openly, which was a defect this port fixed.

The full go-live sequence (verification before traffic, the repoint itself, a
dual-running verification window, and retiring the old service) is
`plans/crm-integration/CUTOVER.md`.

### The ad sync scheduler now runs here too

`backend/modules/ads/services/scheduler.js` polls the Meta Marketing API on
`SYNC_INTERVAL_MINUTES` (1440 = daily; unset or 0 disables it — a sync can still be
triggered manually via the admin API) to keep campaigns/ad sets/ads/creatives/daily
insights/instant-form leads in sync. This used to run inside `focas-crm`; Meta
credentials (`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`) now live in **this**
service's environment, not that one's — that service no longer exists.

### The Ask tab — a data assistant over everything above

`backend/modules/agent/` backs the **Ask** tab: a chat box that answers questions
about the business by querying this dashboard's own data, and — for admins — Bigin
live when the local mirror doesn't carry the answer. It exists because the useful
questions cross tabs. "Which campaign produced the cheapest closed deal last month,
and how did those reps' calls score?" spans Marketing, Sources, Analytics and
Scorecard, so in practice nobody asks it.

Set `OPENAI_API_KEY` to switch it on. Without a key the tab loads and says it is
unconfigured; nothing else in the dashboard depends on it.

**It is read-only.** No tool it can call writes to Mongo, to Bigin, or anywhere
else. The only outbound writes in the module are the HTTP POSTs that carry the
question to OpenAI and (when enabled) a COQL SELECT to Bigin.

**Reps get it too, scoped.** Access control is applied per *tool*, not at the
router:

- Tools over owned data (`query_calls`, `query_deals`, `list_installments`, …)
  inject the rep's `ownerEmail` server-side. The model cannot pass it, override
  it, or ask for someone else's.
- `run_aggregation` — the escape hatch that runs a model-written aggregation —
  prepends that filter to the pipeline, refuses every stage that writes or
  executes JavaScript, and cannot reach the `users` collection at all.
- Ad spend, lead PII, provider billing and the live-Bigin lookups are admin-only.
  The last of those is not because Bigin holds management data, but because a
  live CRM search takes criteria the *model* wrote, and there is no owner filter
  we can reliably impose on it.

Every answer carries a trace of the tools that produced it — and for a
hand-written aggregation, the exact pipeline that ran, owner filter included. A
figure on a sales dashboard that nobody can check is a figure nobody will act on.

Two things worth knowing before trusting a number from it: the model is instructed
never to answer from memory (every figure must come from a tool result in that
conversation), and tool results say when they were truncated. Its token spend
appears on the **AI Usage** tab next to Sarvam and ElevenLabs.

Guard tests, which need no API key:

```bash
cd backend
node modules/agent/scripts/testMongoQuery.js   # the aggregation guard — no DB needed
node modules/agent/scripts/testChatLoop.js     # the tool-calling loop, model stubbed
```

`BIGIN_COQL_ENABLED` is off because the deployed Zoho refresh token lacks the
`ZohoBigin.coql.READ` scope. Re-authorise with it and set the flag to give the
agent one-query CRM access; until then it uses per-module search/get/fields calls,
which the current scopes allow.

## More documentation

- `plans/crm-integration/main-plan.md` — why the CRM was folded into this
  dashboard, and every alternative that was considered and rejected
- `plans/crm-integration/MIGRATION.md` — the one-time Atlas data migration and
  attribution backfill
- `plans/crm-integration/CUTOVER.md` — moving live lead-capture traffic and
  retiring `focas-crm`
- `TODO.md` — open security/correctness/feature items, ordered by severity
