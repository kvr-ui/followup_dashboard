# Followup Dashboard — TODO

Last updated: 2026-07-14

> Full-project audit added below (security, config/infra, features, code quality).
> Items are ordered by severity. Fix the 🔴 CRITICAL security block **before this goes public.**
>
> **Status (2026-07-14):** all 10 non-security bugs fixed & verified (see 🐛 section).
> Security bugs left untouched by request. One deploy action pending: run the
> phone-key backfill on prod (see the ⚠️ item under the bugs section).

---

## 🔴 CRITICAL — security (fix before public exposure)

- [ ] **`GET /webhook` dumps the entire lead table, unauthenticated** — `routes/webhook.js:11` → `controllers/webhookController.js:59`. Returns every task with full body (names, phones, emails, notes, history), no auth, no pagination. The UI never uses it (it uses `/api/tasks`), but it is live to the internet.
  - Fix: delete the GET route, or gate it behind `authenticate, requireAdmin`.

- [ ] **All three webhooks accept forged data — no secret/signature** — `POST /webhook` (`routes/webhook.js:8`), `POST /webhook/call` + `POST /webhook/deal` (`modules/calls/routes/webhooks.js:12-13`). Anyone with the URL can inject fake leads/deals (poisoning analytics) and force outbound Zoho/Bigin calls (quota drain).
  - Fix: require a shared secret / HMAC header, compare with `crypto.timingSafeEqual`, reject before any work.

- [ ] **Default admin `admin` / `admin123`** — `config/seed.js:11-12`; `backend/.env` still sets `ADMIN_PASSWORD=admin123`. No forced change, and **no change-password endpoint exists** (only `login`/`me`), so it's effectively permanent.
  - Fix: rotate the password now; refuse to boot on a weak/unset `ADMIN_PASSWORD`; ship a change-password endpoint.

---

## 🟠 HIGH — security

- [ ] **JWT hardening** — `authController.js:32` uses `expiresIn: '30d'` (no refresh/revocation); `middleware/auth.js:4` silently falls back to `'dev-secret-change-me'` if `JWT_SECRET` is unset (anyone could forge admin tokens).
  - Fix: throw on startup if `JWT_SECRET` is missing; drop to a short access-token life (1–8h) + refresh; add a token version/`jti` for revocation.

- [ ] **NoSQL operator injection via query params** — `modules/calls/controllers/callController.js:27-30`. `?leadId[$ne]=null` parses to `{ $ne: null }` and flows straight into `Call.find(q)`; same for `agent`, `status`. Also `?owner[$ne]=x` makes `owner` an object so `owner.toLowerCase()` throws a 500 (`callController.js:28,180`).
  - Fix: `String(...)`-coerce every query value (or add `express-mongo-sanitize`, or allow-list).

- [ ] **No CORS restriction / Helmet / rate limiting / body-size limit** — `app.js:17` `cors()` reflects any origin; no `helmet`; no throttle on `POST /api/auth/login` (brute-forceable); no `limit` on `express.json()` (`app.js:25`) and `keepRawBody` buffers a second full copy of every body.
  - Fix: `cors({ origin: <allowlist> })`, `helmet()`, `express-rate-limit` on login + webhooks, `express.json({ limit: '100kb' })`.

- [ ] **No graceful shutdown** — `server.js` has no SIGTERM/SIGINT handler; reconcile/transcribe `setInterval`s (`scheduler.js:169`, `taskSync.js:110`) never clear; node runs as PID 1 in the container. `docker stop` hangs 10s then SIGKILLs mid-write.
  - Fix: capture the `app.listen` server; on SIGTERM stop intervals, `server.close()`, drain, `mongoose.connection.close()`. Add `tini` in the Dockerfile.

- [ ] **No TLS** — Express serves plain HTTP on 7007; bearer tokens + login creds travel cleartext.
  - Fix: front with nginx/Caddy/Traefik for TLS (also solves helmet/gzip/headers).

---

## 🟡 MEDIUM — security & correctness

- [ ] **PII logged by default** — `callWebhookController.js:100,215` logs raw webhook bodies (phones, names, amounts) unless `LOG_WEBHOOK_PAYLOADS=false`. Default it off / redact.
- [ ] **Schema oracle for attackers** — unrecognized webhook payloads echo `fieldsSeen: Object.keys(req.body)` to the unauthenticated caller (`callWebhookController.js:117,230`). Log server-side only.
- [ ] **bcrypt cost 10 + no password policy** — `seed.js:18`, `userController.js:30`. `createUser` accepts a 1-char password. Raise to 12; enforce a minimum policy.
- [ ] **`deleteUser` can remove the last admin** — `userController.js:55-67` only blocks self-deletion. Add a "cannot delete last admin" guard.
- [ ] **Path-traversal via forged `cmiuid`** — `cmiuid` comes from unauthenticated webhooks and is interpolated into a cache path (`audio.js:30`). Chained with the open webhook it escapes `CACHE_DIR`. Validate `^[A-Za-z0-9_-]+$` on ingest; `path.basename` the key.
- [ ] **Prototype-pollution surface** — `app.js:80-106` `tryRecoverJson` parses attacker bodies into `req.body`. Reject `__proto__`/`constructor`/`prototype` keys; don't re-run routes on recovered bodies.
- [ ] **Rotate the MongoDB Atlas password** (shared in chat; contains `@` needing `%40` encoding) and **tighten the Atlas IP allowlist** (currently `0.0.0.0/0`).

---

## 🐛 Bugs / correctness (non-security) — FIXED 2026-07-14

- [x] **Speaker labels inverted** — grader now stores `salesperson_speaker` in `grade.breakdown.salespersonSpeaker` (`gradeCalls.js`); `CallDetail.jsx` uses it (falls back to `speaker_1` for ungraded calls) for both labels and turn styling.
- [x] **Malformed-JSON recovery drops call/deal webhooks** — recovery path now re-mounts `callWebhookRoutes` too (`app.js`).
- [x] **Quota failures become permanent failures** — `transcriptionWorker.js` no longer counts quota/credits/billing errors as attempts; such calls stay `pending` and resume when credits return.
- [x] **Timezone bug (UTC vs IST)** — container now runs `TZ=Asia/Kolkata` (Dockerfile installs `tzdata` + sets `TZ`; compose sets it too), so local-midnight buckets are IST.
- [x] **Cache-invalidation race** — `taskController` and `journeyCache` now use a generation counter: a refresh that started before a write is kept stale instead of overwriting the cache with pre-write data.
- [x] **`gradeCalls.js` per-call resilience** — `gradeOne` wrapped in try/catch; one network error is reported and skipped instead of killing the whole run.
- [x] **`POST /api/calls/sync` running guard** — module-level lock returns 409 on a concurrent sync; lock acquired before the try so an early return can't release another run's lock.
- [x] **`CallDetail` recording fetch** — now waits for the call to load and only fetches `/recording` when `hasRecording` is true (no more guaranteed 404).

### Data-model change — FIXED 2026-07-14 (⚠️ run the backfill on prod)

- [x] **Unindexed regex phone scans** — replaced the three `$regex: '…$'` suffix scans with indexed equality. Calls now store `phoneKeys[]` (strict last-10 of each leg, `Call.js`, indexed); deals store `contactPhoneKey` (`Deal.js`, indexed) plus a compound `{ contactPhoneKey, outcome, modifiedTime }` index for the "latest closed deal for this contact" lookup. `tagCallsForDeal` and `afterCallStored` use them.
- [x] **Phone match by last-10-digits cross-link** — the new `phoneKey()` only produces a key when a number has ≥10 digits (returns `null` otherwise), so a short/landline fragment can no longer loosely match an unrelated number the way a regex suffix did. `key10` (the lead index) is unchanged.
- [ ] **RUN ON PROD after deploy:** `node modules/calls/scripts/backfillPhoneKeys.js` — populates `phoneKeys`/`contactPhoneKey` on existing calls & deals so the new lookups find pre-existing records. Idempotent. (New records get the keys automatically; `server.js` builds the indexes on boot via `syncIndexes()`.)

---

## 🚧 Unfinished features (v2 grading — the headline deliverables)

- [ ] **Wire grading into the product** — grading only exists as a manual CLI script (`modules/calls/scripts/gradeCalls.js`); it is never imported by any scheduler/controller/route. No API endpoint, no UI button, no background job. Grades exist only if someone SSHes in and runs it. **Add a scheduled/queued grading job + an admin "grade" action.**
- [ ] **Journey grading** — does not exist. `gradeCalls.js` grades each call in isolation (it computes `_pos/_total` but never a journey-level score). Add a journey score field + endpoint.
- [ ] **Won-vs-lost score analytics — "the key insight"** — `outcomeStats` (`callController.js:176`) compares won/lost by count/reason/owner/product but **never touches `grade.score`**. Build the "won avg 78 / lost 54, discovery in 82% vs 31%" comparison.
- [ ] **Surface the full grade in the UI** — `CallDetail.jsx:115-124` renders only `score` + `summary`; the stored `breakdown` (per-criterion), `strengths`, and `improvements` (`Call.js:17`) are captured and thrown away.
- [ ] **Validate the single-call rubric** — a real two-rubric (first-call / follow-up) grader with score anchors already exists in `gradeCalls.js`; validate against the 22 transcripts, then productionize per above.
- [ ] **Document the Sarvam dependency** — grading uses Sarvam AI (`SARVAM_API_KEY`, model `sarvam-105b`), absent from `.env.example` and this file's config list.

---

## 🧹 Dead / unused code

- [ ] `services/enrich.js:88` `enrichBody()` — exported, never called.
- [ ] `modules/calls/services/dealSync.js` — whole file used only by the one-off `scripts/linkClosedDeals.js`; superseded by `dealStore.js`.
- [ ] `telecmi.js:102` `recordingUrl`, `dealStore.js:81` `fetchProducts` — exported, unused.
- [ ] Frontend `/api/calls/stats` fetch (`Calls.jsx:34,96`) loads `stats` state that is **never rendered**; the entire `callStats` controller (`callController.js:57`) produces numbers no screen shows. Remove or surface it.

---

## ⚙️ Config / infra gaps

- [ ] **`.env.example` is badly out of date** — documents 13 keys; code reads ~42. Undocumented (incl. secret-bearing): `TELECMI_SECRET, WATI_TOKEN, ELEVENLABS_API_KEY, SARVAM_API_KEY, TELECMI_APP_ID, TELECMI_AGENTS, TELECMI_SYNC_FROM, TELECMI_MIN_DURATION_SEC, TELECMI_BASE_URL, BIGIN_WON_STAGE, BIGIN_LOST_STAGE, TRANSCRIBE_SCOPE, ZOHO_REGION, ZOHO_PRODUCT, CALL/DEAL/TRANSCRIBE_POLL_MINUTES, TRANSCRIBE_BATCH, GRADE_CONCURRENCY, GRADE_OUT, *_CACHE_TTL_MS, RECONCILE_*, CALL_AUDIO_CACHE, LOG_WEBHOOK_PAYLOADS, LIMIT, SARVAM_MODEL, ELEVENLABS_MODEL, CALL_JOBS_ENABLED, TASK_JOBS_ENABLED, TASK_POLL_MINUTES`. Regenerate it from the real list with blank secret values + comments.
- [ ] **Audio cache is ephemeral** — `audio.js:10` defaults `CALL_AUDIO_CACHE` to `os.tmpdir()` inside the container; every restart re-transcodes every recording via ffmpeg. Set `CALL_AUDIO_CACHE=/data/audio` + mount a named volume in `docker-compose.yml`.
- [ ] **No Docker init / signal handling** — add `tini` (`ENTRYPOINT`) so `docker stop` forwards signals (pairs with graceful-shutdown above).
- [ ] **compose: no healthcheck, no resource limits** — add `mem_limit` (e.g. `512m`); consider binding `127.0.0.1:7007` behind the reverse proxy.
- [ ] **Mongo connect has no options** — `config/db.js:14` `mongoose.connect(MONGO_URI)` with nothing. Add `serverSelectionTimeoutMS`, `maxPoolSize` (cap for Atlas M0's connection budget), `socketTimeoutMS`.
- [ ] **No MongoDB backups** — Atlas M0 has none. Schedule `mongodump` to a volume, or upgrade to M2+.
- [ ] **Frontend dev-only vulns** — `npm audit`: 1 high (vite path traversal), 1 moderate (esbuild SSRF). Dev-server-only; prod serves static build. Bump on next dep pass. Backend: 0 vulns.

---

## 🛠 Dev tooling / ops (all missing)

- [ ] No tests, no ESLint, no Prettier, no CI (`.github/workflows`), no pre-commit hooks.
- [ ] No README, no LICENSE, no `.nvmrc`, no `engines` field (pin node 22).
- [ ] No structured logging (all `console.*`; add morgan/pino).
- [ ] No error monitoring — add `process.on('unhandledRejection'/'uncaughtException')` and Sentry (or similar).
- [ ] No `compression` middleware — analytics/journeys payloads are large.
- [ ] No monitoring/alerting — ElevenLabs quota exhaustion (`scheduler.js:139`) only logs; add an alert.

---

## 🔵 Frontend polish

- [ ] No error boundary anywhere — any render throw blanks the whole app.
- [ ] Token in `localStorage` (`api.js:1-9`) + 30-day JWT — XSS-exfiltratable.
- [ ] `App.jsx:30` `if (loading) return null` — blank screen during session restore; add a spinner.
- [ ] Thin loading/empty states (`<p>Loading…</p>`); no skeletons in Analytics/Calls/Products.
- [ ] Accessibility — clickable `<div>`s with no `role`/keyboard handling (`Calls.jsx:211,422`); icon-only buttons with no `aria-label`.
- [ ] Mobile — wide tables and multi-column filter/journey layouts have no responsive handling in markup.

---

## 🗄 Data-model gaps

- [ ] `Task.body` is `Mixed` (`Task.js:76`) — no validation on the core payload; same data denormalized across `body`/`taskHistory`/`statusHistory`, hand-synced in `taskStore.js:26`.
- [ ] No validation on `User.ownerEmail` format, `Note.text` length, `Deal.amount`, grade `score`/`total` (rubric says 0–100, nothing enforces it).
- [x] ~~Add a compound index for `afterCallStored`'s deal lookup~~ — done: `Deal.contactPhoneKey` + compound `{ contactPhoneKey, outcome, modifiedTime }` index; regex replaced with indexed equality (see the bugs section).

---

## 🔴 Original blockers (still open)

- [ ] **Repoint both webhooks to a live URL** — ngrok is stopped, old URLs dead.
  - Bigin (Zoho Flow) → `https://follo.focasedu.in/webhook/deal`
  - TeleCMI (CDR)     → `https://follo.focasedu.in/webhook/call`
- [ ] **Upgrade ElevenLabs to Creator** ($22 first month, then $11/mo — 121k credits). Free tier ran out after 22 calls; **152 calls still pending** (~34k credits). Worker resumes automatically once credits exist (but see the quota-failure bug above).
- [ ] Switch `TRANSCRIBE_SCOPE=won` → `all` once credits allow.
- [ ] Recreate the 3 sales accounts on production (veera, nithish, amrithia) — ensure each has `ownerEmail` set (task filtering depends on it).
- [ ] Reset the 10 `failed` transcriptions to `pending` — the quota-attempt bug that stranded them is fixed, but existing calls already marked `failed` won't self-heal. Flip any whose `transcriptionError` mentions quota/credits back to `pending` (a one-liner `updateMany`), then the worker retries them once credits exist.

---

## ✅ Completed

### v1 — Lead follow-up dashboard
- [x] Node backend + React (Vite) frontend, separate folders
- [x] Bigin task webhook ingest (`POST /webhook`) — instant response, background enrichment
- [x] MongoDB Atlas (production) — deduped by contact id
- [x] Auth: admin + sales roles, JWT, 30-day sessions
- [x] Sales users only see their own leads (filtered by `Owner.email`) — object-level `canAccess` correctly enforced
- [x] Lead table: filters, search, quick tabs, summary cards, overdue highlighting
- [x] Lead detail: status write-back to Bigin, notes, history, contact phone + copy
- [x] Admin analytics: per-salesperson performance
- [x] WhatsApp send via WATI (71 approved templates)
- [x] Docker deployment on port **7007** (multi-stage, non-root, healthcheck, ffmpeg — solid)
- [x] Zoho rate-limit fixes (throttle, retry, no Zoho calls on the read path)

### v2 — Call grading (in progress)
- [x] TeleCMI CDR sync — **701 calls** imported
- [x] Bigin deal sync — **149 won / 2,471 lost**
- [x] Calls matched to leads + deals by phone number
- [x] Deal products auto-fetched from Bigin (related list)
- [x] Audio transcoding via ffmpeg; recording proxied server-side (TeleCMI secret never exposed)
- [x] Admin **Calls** tab: lead journeys, audio player, speaker-split transcript
- [x] Transcription — ElevenLabs `scribe_v2`, auto-detect Tamil/English, diarization; **22 calls transcribed**
- [x] Bigin deal webhook (`POST /webhook/deal`) — verified live
- [x] TeleCMI call webhook (`POST /webhook/call`) — built + tested
- [x] Reconcile polls every 15 min; ElevenLabs quota circuit-breaker; won/lost tagging per call

---

## 📌 Known data facts

- **83 of 149** closed sales have a recorded call — the rest closed via WhatsApp / phone / walk-in.
- Average **2.8 calls** per closed lead (max 11).
- Agent extension mapping: `5001` = veera, `5003` = nithish, `5004` = amrithia.
- Bigin stages: won = `Closed with Sale`, lost = `Closed without Sale`.

## ⚙️ Key config (`backend/.env`)

```
TRANSCRIBE_SCOPE=won          # won | closed | all
TELECMI_MIN_DURATION_SEC=30   # skip misdials
CALL_POLL_MINUTES=15          # TeleCMI reconcile
DEAL_POLL_MINUTES=15          # Bigin reconcile
TRANSCRIBE_POLL_MINUTES=10    # transcription worker
BIGIN_WON_STAGE=Closed with Sale
BIGIN_LOST_STAGE=Closed without Sale
SARVAM_API_KEY=...            # call grading (undocumented — add to .env.example)
```

## 🚀 Deploy

```bash
docker compose up -d --build     # → http://localhost:7007
```
