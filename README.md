# FOCAS Sales Dashboard

Lead-followup and sales-intelligence dashboard for Focas. Node/Express + MongoDB
backend, React (Vite) frontend, shipped as one Docker image that runs as a single
container.

What it does:

- Mirrors **Bigin** (Zoho) follow-up tasks, contacts and deals into Mongo and shows
  them as a follow-up board, funnel, sources and analytics.
- Syncs **TeleCMI** call recordings, transcribes them (**ElevenLabs** Scribe) and
  grades the sales calls (**Sarvam**).
- Syncs **WATI** WhatsApp chats for the Rep Lifecycle tab.
- Owns **public lead capture** (`POST /api/leads/web`) and **Meta Ads sync**, and
  sends CRM funnel stages back to Meta through the **Conversions API**. These used to
  live in a separate, now-retired service, `focas-crm` (see
  `plans/crm-integration/`).
- Reads **VSL** watch time from a second, read-only Atlas cluster.
- Has an **Ask** tab: an OpenAI-backed, read-only assistant over all of the above.

---

## Contents

1. [Repo layout](#repo-layout)
2. [Local development](#local-development)
3. [Production: servers and deploys](#production-servers-and-deploys)
4. [Background jobs](#background-jobs)
5. [Environment variables](#environment-variables)
6. [Feature notes](#feature-notes)
7. [Known gotchas](#known-gotchas)
8. [Tests and scripts](#tests-and-scripts)
9. [Handover checklist](#handover-checklist)
10. [More documentation](#more-documentation)

---

## Repo layout

```
backend/               Express API + Mongo models (CommonJS, no build step)
  server.js            Boot: DB → seed admin → syncIndexes() → start schedulers
  app.js               Express app and route mounting
  routes/ controllers/ services/ models/   original flat MVC (tasks, users, auth, analytics)
  modules/             self-contained feature modules:
    ads/               Meta Ads sync, Conversions API, public lead ingest
    agent/             the Ask tab (OpenAI tool-calling, read-only)
    calls/             TeleCMI/Bigin calls, deals, transcription, grading, nightly jobs
    leads/             lead list, lead profile, funnel, Bigin contacts
    vsl/               VSL watch time (second, read-only Mongo connection)
    wati/              WhatsApp chat sync
  scripts/             one-off reports and backfills
frontend/              React (Vite) SPA, built to frontend/dist and served by the backend
  src/components/      one file per tab (FollowUps, Calls, Scorecard, Marketing, …)
  src/apiDocs.js       source of truth for the API docs
docs/API.md            generated API reference (do not hand-edit)
plans/                 design records for larger features (crm-integration, google-oauth, lead-profile)
TODO.md                open security/correctness items, ordered by severity
fix.md, IMPROVEMENTS.md  older full-codebase audits (Jul/Aug 2026), kept for context;
                         some items in them have since been fixed
grading-results/       output of a call-grading test run, not used by the app
```

## Local development

Requirements: Node 22 (what the Docker image uses), a local MongoDB (`mongod`).

```bash
# Backend
cd backend
cp .env.example .env        # fill in values — see Environment variables
npm install
npm run dev                 # nodemon, http://localhost:3000

# Frontend (second terminal)
cd frontend
npm install
npm run dev                 # Vite dev server, http://localhost:5173
```

`MONGO_URI` defaults to `mongodb://127.0.0.1:27017/followup_dashboard`. On first
boot an admin user is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

> **Careful:** if your local `.env` points `MONGO_URI` at the production Atlas
> database, local runs read **and write** live data, and the background jobs will
> run against it. Set `CALL_JOBS_ENABLED=false` and `TASK_JOBS_ENABLED=false`
> locally unless you mean it, and leave `CAPI_ENABLED` off.

## Production: servers and deploys

### Where things run

Everything lives on the **`focas`** server (SSH host alias `focas`), managed by
**Coolify** (v4). Host nginx + certbot terminate TLS in front of it; the Coolify
proxy is not used.

| What | Domain | Branch | Port (localhost) | Coolify app |
|---|---|---|---|---|
| Dashboard — **prod** | https://followup.focasedu.online | `main` | 7008 | `iiwluohdnhtcozrsmw8iohy3` |
| Dashboard — **beta** | https://beta.focasedu.online | `beta` | 7009 | `nhtopdpksmilzbrldy5ax3vj` |
| Lead server (`kvr-ui/utm` repo) | leads.focasedu.online | `main` | 7010 | `eay8iovfebqqxa2atfiockjd` |

- Repo: `github.com/kvr-ui/followup_dashboard`.
- **Database:** MongoDB Atlas, database `followup_dashboard`. **Beta and prod share
  the same database.** Beta therefore has its own `JWT_SECRET` but has
  `CALL_JOBS_ENABLED=false`, `TASK_JOBS_ENABLED=false`, no `SYNC_INTERVAL_MINUTES` and
  no CAPI settings, so the background jobs run only once (on prod).
- **Lead server:** takes the website's `/focas` and `/workout-batch` form posts and
  forwards them to Bigin and to this dashboard's `/api/leads/web`. Failed posts
  are kept in `/app/data/failed-leads.jsonl` (Coolify volume). An older copy still
  runs in Docker on the Hostinger VPS that serves focasedu.com (31.97.228.184).
  Nobody has SSH access to that box.

### How to deploy

```
feature work → push to `beta` → auto-deploys to beta.focasedu.online → test
            → merge `beta` into `main` → auto-deploys to followup.focasedu.online
```

There is no GitHub webhook, because the deploying account has push rights but not
admin rights on the repo. Instead, a poller on the `focas` server checks the
branches every minute and triggers a Coolify deploy when a branch moves:

- script: `/usr/local/bin/coolify-autodeploy`
- systemd timer: `coolify-autodeploy.timer`
- targets (app ↔ branch): `/etc/coolify-autodeploy/targets`
- token: `/etc/coolify-autodeploy/env` (`COOLIFY_TOKEN`)

To redeploy by hand, either use the Coolify UI or run
`POST /api/v1/deploy?uuid=<app uuid>` with that token.

### Changing env vars on the server

Each app's env vars are Coolify app environment variables (one app per branch).
Change them in the Coolify UI, then redeploy. The poller's `COOLIFY_TOKEN` can only
deploy: API calls that edit env vars return 403. Past edits were made with
`docker exec -i coolify php artisan tinker` on the server.

### Health check

```bash
curl https://followup.focasedu.online/health      # {"status":"ok"}
```

### Running the Docker image yourself

```bash
cp backend/.env.example backend/.env   # fill in
docker compose build && docker compose up -d
curl http://127.0.0.1:7007/health
```

`docker-compose.yml` builds a two-stage image (frontend build → backend runtime),
publishes port `7007` and sets `TZ=Asia/Kolkata`. **Keep `TZ` set to IST.** The
overdue / today / upcoming task buckets use server-local midnight, so with the wrong
timezone, tasks due in the evening (IST) land in the wrong bucket. The container serves plain HTTP only; put a
TLS-terminating proxy in front.

## Background jobs

All jobs are in-process timers started from `server.js`. There is no external cron.
The code assumes **a single instance**: locks and caches are held in memory, so
running two prod replicas would duplicate the paid API calls and the sends.

| Job | Where | Default schedule | Switch |
|---|---|---|---|
| Bigin task reconcile | `services/taskSync.js` | every `TASK_POLL_MINUTES` | `TASK_JOBS_ENABLED` |
| TeleCMI inbound + outbound call reconcile | `modules/calls/services/scheduler.js` | every `CALL_POLL_MINUTES` | `CALL_JOBS_ENABLED` |
| Bigin call cross-check | same | every `BIGIN_CALL_POLL_MINUTES` (10) | `CALL_JOBS_ENABLED` |
| Bigin deal reconcile | same | every `DEAL_POLL_MINUTES` | `CALL_JOBS_ENABLED` |
| Transcribe pending calls (ElevenLabs) | same | every `TRANSCRIBE_POLL_MINUTES` | `CALL_JOBS_ENABLED` |
| Grade transcribed calls (Sarvam) | same | every `GRADE_POLL_MINUTES` | `CALL_JOBS_ENABLED` |
| Pipeline audit | same | every `PIPELINE_AUDIT_MINUTES` | `CALL_JOBS_ENABLED` |
| WATI chat sync | same | every `WATI_SYNC_MIN` | `CALL_JOBS_ENABLED` |
| Nightly Bigin re-sync (last 48 h) | same | 02:00 IST (`NIGHTLY_BIGIN_HOUR_IST`) | `CALL_JOBS_ENABLED` |
| Nightly prune of contacts deleted in Bigin | same | 03:00 IST (`NIGHTLY_CONTACT_PRUNE_HOUR_IST`) | `CALL_JOBS_ENABLED` |
| Meta Ads sync | `modules/ads/services/scheduler.js` | every `SYNC_INTERVAL_MINUTES` (1440 = daily) | unset/0 = off |
| Conversions API sweep | `modules/ads/services/capiSync.js` | every `CAPI_INTERVAL_MINUTES` (15) | `CAPI_ENABLED` |

On boot the call jobs start one after another over the first three minutes,
because a call must be transcribed before it can be graded. If ElevenLabs reports
its quota is used up, transcription pauses for an hour.

## Environment variables

`backend/.env.example` is the reference, with comments explaining each variable.
Summary:

| Area | Variables |
|---|---|
| Core | `PORT`, `MONGO_URI`, `JWT_SECRET`, `ADMIN_NAME` / `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` |
| Job switches | `CALL_JOBS_ENABLED`, `TASK_JOBS_ENABLED` (set `false` on beta and usually locally) |
| Google sign-in (optional) | `GOOGLE_CLIENT_ID`, `GOOGLE_ALLOWED_DOMAIN` |
| WhatsApp / WATI | `WATI_API_URL`, `WATI_TOKEN`, `WATI_SYNC_MIN` |
| Zoho / Bigin | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ACCOUNTS_URL`, `ZOHO_API_URL`, `ZOHO_MODULE`, `BIGIN_CALL_POLL_MINUTES` |
| TeleCMI | `TELECMI_APP_ID`, `TELECMI_SECRET`, `TELECMI_AGENTS`, `TELECMI_USER_PASSWORD`, `TELECMI_MIN_DURATION_SEC` |
| Transcription / grading | `ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL`, `TRANSCRIBE_SCOPE`, `SARVAM_API_KEY`, `SARVAM_MODEL`, `SARVAM_TOKEN_ALLOWANCE`, `GRADE_MAX_ATTEMPTS` |
| Meta Ads sync | `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_API_VERSION`, `SYNC_INTERVAL_MINUTES`, `META_LEAD_FORM_IDS`, `META_PAGE_ID`, `AD_INSIGHT_LOOKBACK_DAYS`, `AD_SYNC_FIRST_RUN_DELAY_MS` |
| Meta Conversions API | `CAPI_ENABLED`, `META_PIXEL_ID`, `META_CAPI_TOKEN`, `META_TEST_EVENT_CODE`, `CAPI_INTERVAL_MINUTES` |
| Public lead ingest | `CORS_ORIGINS`, `WEB_LEAD_RATE_MAX`, `LEAD_INGEST_TOKEN` |
| VSL watch time | `VSL_MONGO_URI`, `VSL_MONGO_DB`, plus optional cache/timeout tuning |
| Ask assistant | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `OPENAI_MAX_OUTPUT_TOKENS`, `AGENT_MAX_ROUNDS`, `AGENT_RATE_MAX`, `BIGIN_COQL_ENABLED` |
| Job tuning (optional) | `TASK_POLL_MINUTES`, `CALL_POLL_MINUTES`, `DEAL_POLL_MINUTES`, `TRANSCRIBE_POLL_MINUTES`, `GRADE_POLL_MINUTES`, `PIPELINE_AUDIT_MINUTES`, `NIGHTLY_BIGIN_HOUR_IST`, `NIGHTLY_CONTACT_PRUNE_HOUR_IST`, `NIGHTLY_BIGIN_LOOKBACK_HOURS` |

> `TELECMI_APP_ID`, `TELECMI_SECRET`, `TELECMI_AGENTS` and the job-tuning variables
> are read by the code but not yet listed in `.env.example`. Copy their values from
> the prod Coolify app. `TELECMI_AGENTS` maps TeleCMI extensions to reps; run
> `node modules/calls/scripts/linkClosedDeals.js` to generate it.

Every optional integration fails safe: if its keys are unset, that feature is
switched off and the rest of the app keeps working.

## Feature notes

### API docs

Every endpoint is in [`docs/API.md`](docs/API.md) (auth level, params, examples,
errors) and in the dashboard's **API Docs** tab, where each GET endpoint has a
**Run** button. Both are generated from `frontend/src/apiDocs.js`. After editing it,
run:

```bash
npm --prefix frontend run docs
```

Auth: everything except the webhooks and `POST /api/leads/web` needs a JWT
(`Authorization: Bearer …`, 30-day tokens). Roles are **admin** and **rep**; reps
only see their own rows, and the server enforces this, not the client.

### Inbound webhooks

| Endpoint | Sender |
|---|---|
| `POST /webhook` | Zoho Flow — follow-up tasks |
| `POST /webhook/call` | TeleCMI — finished calls |
| `POST /webhook/deal` | Bigin — deal create/update (marks a call journey won or lost) |
| `POST /webhook/contact` | Bigin — contacts (the Funnel's MQL list) |

If you move the domain, update these URLs in Zoho Flow, Bigin and TeleCMI.

### Public lead capture

`POST /api/leads/web` receives leads from the lead server, not from browsers
directly.

- `CORS_ORIGINS` — browser origin allowlist; prod value `https://focasedu.com`. It
  doesn't apply to the lead server's server-to-server posts, because those send no
  `Origin` header.
- `LEAD_INGEST_TOKEN` — shared secret sent as `X-Lead-Ingest-Token`. **It is unset in prod
  on purpose** (see [Known gotchas](#known-gotchas)).
- `WEB_LEAD_RATE_MAX` — requests/minute per IP (default 60). All traffic comes from
  the lead server's single IP, so this caps the total, not each visitor.

`GET /api/leads/web` (full lead PII) is admin-only.

### Meta Ads sync and Conversions API

- The connector is in-repo at `backend/modules/ads/meta/` (plain CommonJS, no
  registry token needed). The sync runs **on prod only**. If beta and prod ran it
  at the same time against the shared DB, they would hit Meta's ad-account rate limit.
- **Instant-form leads are not synced yet:** neither `META_PAGE_ID` nor
  `META_LEAD_FORM_IDS` is set, so the `MetaLead` collection stays empty and
  ad-level lead counts look near zero. To fix this, set one of them; the token also
  needs `leads_retrieval` and a page token.
- **Conversions API** (`capiSync.js`) sends every Bigin contact's funnel stages
  (Lead, MQL, SQL, Purchase) to the Focas Website Pixel. It's enabled **on prod only**.
  Don't enable it on beta: a stale `META_TEST_EVENT_CODE` sends **real** events.
  Use it on beta only for a supervised test while a Test Events session is open in
  Events Manager.

### VSL watch time (second, read-only cluster)

The VSL landing page (a separate project, `focasvsl`) writes `vsl_leads` /
`vsl_events` into its own Atlas cluster. The **VSL Tracking** tab and the lead
drawer read them through a second Mongoose connection that never writes. If
`VSL_MONGO_URI` is unset, the feature is hidden and nothing breaks.

Before changing `backend/modules/vsl/`:

- **Never add its models to the `syncIndexes()` chain in `server.js`.** That call would
  drop the VSL project's `phone_unique` index, which stops leads from being sent their link twice.
- **Minutes watched is the peak from the event log, not `vsl_leads.watchedSeconds`.**
  That field is overwritten on every beacon and *falls* when a lead reopens the video.

### The Ask tab

`backend/modules/agent/` answers cross-tab questions by querying this dashboard's
data and, for admins, Bigin live. It needs `OPENAI_API_KEY`; without it, the tab
shows a "not configured" message.

- **Read-only.** No tool it can call writes anywhere.
- **Reps get scoped access.** Each tool injects the rep's `ownerEmail` on the server;
  `run_aggregation` prepends that filter, refuses write/JS stages and can't read
  `users`. Ad spend, lead PII, billing and live-Bigin lookups are admin-only.
- Every answer carries a trace of the tools and pipelines that produced it, and the
  token spend shows on the **AI Usage** tab.
- `BIGIN_COQL_ENABLED` is off because the Zoho refresh token lacks
  `ZohoBigin.coql.READ`. To turn it on, re-authorise with that scope and then set it to `1`.

### Google sign-in

1. In Google Cloud (FOCAS Workspace org): OAuth consent screen → **Internal**, app
   name **FOCAS Sales CRM**.
2. Credentials → OAuth client ID → **Web application**. Authorized JavaScript
   origins: `https://beta.focasedu.online`, `https://followup.focasedu.online`,
   `http://localhost:5173`, `http://localhost:7007`. No redirect URIs.
3. Set `GOOGLE_CLIENT_ID` and `GOOGLE_ALLOWED_DOMAIN` on both Coolify apps (and
   locally), then redeploy.

The client ID is public; there is no secret. An empty `GOOGLE_CLIENT_ID` hides the
button. Only existing users can sign in this way: their login email (Admin → Users)
must match their Google account.

## Known gotchas

- **Lead ingest is unauthenticated on purpose.** `LEAD_INGEST_TOKEN` is unset in
  prod. Setting it would break the lead server and website forms until they send the
  same header. If you decide to set it, change both sides at the same time.
- **Test phone numbers distort reports.** When joining calls to leads by phone,
  exclude `9999999999` (the "focas test" contact, ~277 unrelated calls),
  `9876543210` (webhook test contact) and `7943447443` (the office DID, which appears
  on every outbound TeleCMI call). If a single lead has a huge call count, check these numbers first.
- **Shared DB between beta and prod.** Anything you test on beta changes prod data.
- **Default admin password.** `admin` / `admin123` comes from `.env.example`. Make sure
  prod uses a different one.
- **Known security debt** is listed in `TODO.md`: unsigned webhooks and the open
  `GET /webhook`. Read it before exposing anything new.
- **Phone keys:** call/deal `phoneKey` is the last 10 digits; WATI numbers carry a
  `91` prefix. Normalise before joining.

## Tests and scripts

```bash
cd backend
npm test        # unit tests + agent guard + lead profile/list/funnel checks (no API keys needed)
node modules/agent/scripts/testChatLoop.js   # Ask tool loop with the model stubbed
```

Useful maintenance scripts, run from `backend/`:

| Script | Purpose |
|---|---|
| `modules/calls/scripts/backfillCalls.js` | Pull historical TeleCMI calls |
| `modules/calls/scripts/requeueSkipped.js --apply` | Re-queue calls skipped before a scope/duration change |
| `modules/calls/scripts/retryFailedTranscriptions.js` | Retry failed transcriptions |
| `modules/calls/scripts/resetGradeAttempts.js` | Let calls that hit the grading retry limit be graded again |
| `modules/leads/scripts/backfillContacts.js` | Re-mirror Bigin contacts |
| `modules/leads/scripts/pruneDeletedContacts.js` | Manual version of the nightly prune |
| `modules/wati/scripts/backfillWatiChats.js` | Backfill WhatsApp chats |
| `scripts/importFromBigin.js` | Import tasks from Bigin |

Read the top of each script before running it. They connect to whatever
`MONGO_URI` points at.

## Handover checklist

Do these before the previous developer leaves. **Don't put secrets in this repo.**

- [ ] GitHub: give the new developer access to `kvr-ui/followup_dashboard` and
      `kvr-ui/utm`.
- [ ] SSH access to the `focas` server and a Coolify login.
- [ ] MongoDB Atlas access (main cluster, plus the VSL cluster for read-only).
- [ ] Account owners and logins for each service: Zoho/Bigin, TeleCMI, WATI, Meta Business (ad
      account, pixel, page), ElevenLabs, Sarvam, OpenAI, Google Cloud (OAuth client),
      DNS registrar for `focasedu.online`.
- [ ] Where secrets are stored (Coolify env vars are the live copy). Note any
      password manager or vault here: `______________`.
- [ ] Hostinger VPS (focasedu.com, old lead server): who has access: `______________`.

## More documentation

- `docs/API.md` — full API reference
- `plans/crm-integration/main-plan.md` — why the CRM was folded into this dashboard
- `plans/crm-integration/MIGRATION.md` — one-time Atlas migration and attribution backfill
- `plans/crm-integration/CUTOVER.md` — moving lead capture here and retiring `focas-crm`
- `plans/crm-integration/FOCAS_CRM_RETIREMENT.md` — what `focas-crm` was and where its data went
- `plans/google-oauth/`, `plans/lead-profile/` — design records for those features
- `TODO.md` — open security/correctness/feature items
