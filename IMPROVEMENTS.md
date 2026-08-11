# Followup Dashboard — Improvement Report

Full-project review, 2026-08-08 (branch `fix/call-capture-and-grading`, 160 tracked
files, ~17.6k lines of JS/JSX).

This is a **fresh audit of the whole repo**, not a re-read of `TODO.md`. Where an
item overlaps that file I say so and note whether it is still true in the code
today — several items listed there as open are indeed still open, and a few
listed as "unfinished" have since been built.

**What's already good** — worth stating, because most of the report below is
things to change: the module boundaries (`backend/modules/{calls,ads}`) are clean
and self-contained; the comments explain *why* rather than *what*, which is rare
and valuable; the Docker build correctly uses a build secret rather than an ARG
for the packages token; server-side role scoping (`ownerScope`) is enforced at the
data layer rather than trusted from the client; and `plans/crm-integration/` is a
genuinely good decision record.

---

## Priority summary

| # | Area | Severity | Effort | Why it matters |
|---|---|---|---|---|
| 1 | Unauthenticated data exposure & webhook forgery | 🔴 Critical | S | Live lead PII dump to the internet |
| 2 | Default admin credentials, no password change | 🔴 Critical | S | Effectively permanent `admin`/`admin123` |
| 3 | Missing HTTP hardening (helmet, rate limit, CORS, body limit) | 🟠 High | S | Brute force, DoS, header attacks |
| 4 | Zero automated tests, no CI, no linting | 🟠 High | M | 17.6k lines with no regression net |
| 5 | Boot-time config validation (63 env vars, 33 documented) | 🟠 High | S | Silent misconfiguration in prod |
| 6 | Graceful shutdown & single-instance assumptions | 🟠 High | M | Data loss on deploy; blocks scaling |
| 7 | Observability: structured logs, metrics, real health check | 🟡 Medium | M | 302 `console.*` calls, no error tracking |
| 8 | API shape: pagination, validation, consistent envelope | 🟡 Medium | M | `/api/tasks` returns the whole table |
| 9 | Frontend architecture: routing, data fetching, code splitting | 🟡 Medium | M | Full-list poll every 15s, no URL state |
| 10 | Cost & quota control on AI providers | 🟡 Medium | S | Sarvam/ElevenLabs spend is unbounded |
| 11 | Code-level cleanups (dead code, large files, duplication) | 🟢 Low | M | Maintenance drag |
| 12 | Documentation & process | 🟢 Low | S | `TODO.md` is stale, no CONTRIBUTING |

---

## 1. 🔴 Unauthenticated data exposure and webhook forgery

**Still open, verified in current code.**

### 1a. `GET /webhook` dumps the entire task table with no auth

[backend/routes/webhook.js:11](backend/routes/webhook.js#L11) →
[backend/controllers/webhookController.js:59-65](backend/controllers/webhookController.js#L59-L65)

`Task.find().sort(...).lean()` with no filter, no pagination, no `authenticate`.
The response includes each task's full `body` — names, phone numbers, emails,
notes. The router is mounted at [app.js:51](backend/app.js#L51) with the comment
"Zoho posts here (no auth)", which is true of the POST but silently also applies
to the GET. The frontend never calls it (it uses `/api/tasks`), so **deleting the
route breaks nothing**.

```js
// backend/routes/webhook.js — smallest correct fix
router.post('/', receiveWebhook);
// GET removed: the dashboard reads /api/tasks, which is authenticated + scoped.
```

If you want to keep it for debugging, gate it: `router.get('/', authenticate,
requireAdmin, getWebhookData)` and add a `limit`.

### 1b. Three webhooks accept forged payloads

`POST /webhook` ([routes/webhook.js:8](backend/routes/webhook.js#L8)),
`POST /webhook/call` and `POST /webhook/deal`
([modules/calls/routes/webhooks.js:12-13](backend/modules/calls/routes/webhooks.js#L12-L13))
have no signature or shared secret. Anyone with the URL can inject leads and
deals — which poisons analytics, the scorecard and the grading queue — and can
trigger outbound Zoho/Bigin/TeleCMI calls, draining API quota.

The fix pattern already exists in this repo: `LEAD_INGEST_TOKEN` on
`/api/leads/web` is exactly the right shape. Generalise it into one middleware:

```js
// backend/middleware/webhookAuth.js
const crypto = require('crypto');

function sharedSecret(envKey) {
  return function verify(req, res, next) {
    const expected = process.env[envKey];
    if (!expected) {
      // Same convention as LEAD_INGEST_TOKEN: unset = skipped, but noisy.
      return next();
    }
    const got = String(req.get('X-Webhook-Token') || '');
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    next();
  };
}
```

Apply per-route with distinct env keys (`ZOHO_WEBHOOK_TOKEN`,
`TELECMI_WEBHOOK_TOKEN`, `BIGIN_WEBHOOK_TOKEN`) so rotating one does not
invalidate the others. TeleCMI/Bigin can usually be configured to send a custom
header; if not, fall back to a secret path segment (`/webhook/call/:token`).

### 1c. Related, smaller

- **PII in logs by default** —
  [callWebhookController.js](backend/modules/calls/controllers/callWebhookController.js)
  logs raw webhook bodies unless `LOG_WEBHOOK_PAYLOADS=false`. Invert the default
  and redact phone/email even when on.
- **Schema oracle** — unrecognized payloads echo `fieldsSeen: Object.keys(req.body)`
  back to an unauthenticated caller. Log it server-side, return a bare 400.
- **Prototype pollution** — `tryRecoverJson` ([app.js:104-130](backend/app.js#L104-L130))
  parses attacker-controlled bodies into `req.body` and then **re-runs the webhook
  routers** ([app.js:96-97](backend/app.js#L96-L97)). Reject `__proto__`,
  `constructor` and `prototype` keys before assigning, and prefer
  `JSON.parse(raw, reviver)` with a dropping reviver.

---

## 2. 🔴 Default admin credentials with no way to change them

[backend/config/seed.js:11-13](backend/config/seed.js#L11-L13) falls back to
`admin` / `admin123`, and [backend/.env.example:9](backend/.env.example#L9) ships
that same password as the documented value. There is **no change-password
endpoint anywhere** — `routes/auth.js` exposes only `login` and `me` — so whatever
password was seeded on first boot is permanent short of a direct Mongo write.

Three changes, all small:

1. **Refuse to boot on a weak or unset admin password when `NODE_ENV=production`.**
   Put it in the config validator from §5.
2. **Ship `POST /api/auth/password`** (authenticate, verify current password,
   bcrypt the new one at cost 12) and a matching admin reset in
   `userController`.
3. **Add a `mustChangePassword` flag** on the seeded user and have the frontend
   force the change before rendering the dashboard.

While in that file: `bcrypt.hash(password, 10)` should be 12, and
`createUser` ([controllers/userController.js:30](backend/controllers/userController.js#L30))
currently accepts a one-character password — enforce a minimum length and reject
the top-1000 common passwords.

Also: `deleteUser` only blocks self-deletion, so two admins can lock each other
out and leave the instance admin-less. Add a "cannot delete the last admin"
guard.

---

## 3. 🟠 Missing HTTP hardening

Verified absent from [backend/package.json](backend/package.json) — no `helmet`,
no `express-rate-limit`, no `express-mongo-sanitize`.

| Gap | Location | Fix |
|---|---|---|
| Blanket `cors()` reflects any origin | [app.js:44](backend/app.js#L44) | `cors({ origin: CORS_ORIGINS.split(','), credentials: true })` — reuse the var the lead-ingest router already parses |
| No body size limit; `keepRawBody` buffers a **second** full copy of every body | [app.js:22-27](backend/app.js#L22-L27) | `express.json({ limit: '256kb', verify: keepRawBody })`; skip `keepRawBody` on non-webhook paths |
| Login is brute-forceable | [routes/auth.js](backend/routes/auth.js) | `express-rate-limit` — 5/min per IP on `/api/auth/login`, plus per-username lockout |
| No security headers | [app.js](backend/app.js) | `app.use(helmet())` before the static handler; you already have a `CSP_ENABLED` flag referenced in code, wire it here |
| NoSQL operator injection | [callController.js:41-60](backend/modules/calls/controllers/callController.js#L41-L60) | `?status[$ne]=x` parses to an object and flows into `Call.find(q)`. `String()`-coerce every scalar query param, or add `express-mongo-sanitize` |

The NoSQL one has a second symptom: an object-valued `owner` makes
`String(req.query.owner).toLowerCase()` produce `"[object object]"` in some paths
and throws outright in others — a 500 rather than a 400.

Note `ownerScope` ([callController.js:15-22](backend/modules/calls/controllers/callController.js#L15-L22))
is done correctly — non-admins are hard-pinned server-side with a
matches-nothing sentinel for unmapped accounts. Use that as the template for
every other list endpoint.

---

## 4. 🟠 Zero automated tests, no CI, no linting

There is not a single test file in the repo, no `.eslintrc`/`eslint.config.*`, no
`.prettierrc`, and no `.github/workflows/`. For 17.6k lines running money-adjacent
sync jobs against four external APIs, that is the single biggest structural risk
after the security items — every change is verified by hand, and there is nothing
stopping a regression reaching prod.

You do not need broad coverage. You need tests on the **pure, high-consequence
logic**, which this codebase happens to have neatly isolated:

**Tier 1 — pure functions, no I/O, highest value per test:**
- `backend/utils/phone.js` — `phoneKey()` / `key10`. This is the join key for
  calls↔deals↔leads. A bug here silently mis-attributes revenue.
- `backend/services/taskCategory.js` — subject-line category inference.
- `backend/modules/ads/services/normalizeName.js` — campaign name normalisation.
- `frontend/src/taskStats.js`, `adStats.js`, `utils.js` — bucket boundaries
  (overdue/today/upcoming), which are timezone-sensitive and already caused one
  production bug.

**Tier 2 — integration, `mongodb-memory-server` + `supertest`:**
- Auth: login, `me`, expired token, rep cannot reach `/api/ads` or `/api/users`.
- Ownership scoping: rep A cannot read rep B's calls/installments/upsells.
- Webhook idempotency: posting the same `cmiuid` twice creates one `Call`.
- `tryRecoverJson` NDJSON recovery, including the malformed cases.

**Tooling** — Node 22 has a built-in runner, so this costs one dev dependency
(`supertest`) rather than a whole Jest setup:

```jsonc
// backend/package.json
"scripts": {
  "test": "node --test test/",
  "lint": "eslint .",
  "format": "prettier --write ."
}
```

**CI** — one workflow that runs `npm ci` (with the `read:packages` token as a
repo secret), `npm run lint`, `npm test`, and `docker compose build`. Even
build-only CI would have caught a missing-dependency deploy failure.

**Note on the `@santhosh785/meta-ads` dependency**: it is a private single-author
package on GitHub Packages that the ads sync depends on entirely. If that account
goes away, builds stop. Vendor it into `backend/modules/ads/vendor/` or at
minimum pin an exact version and keep a tarball copy.

---

## 5. 🟠 Config validation at boot

The code reads **63 distinct env vars**; `backend/.env.example` documents **33**.
Undocumented ones include secret-bearing values (`TELECMI_SECRET`,
`TELECMI_APP_ID`, `ELEVENLABS_API_KEY`, `SARVAM_API_KEY`) and behaviour switches
that silently change what runs (`CALL_JOBS_ENABLED`, `TASK_JOBS_ENABLED`,
`GRADE_POLL_MINUTES`, `RECONCILE_MAX_LOOKBACK_DAYS`, `TRANSCRIBE_BATCH`).

Worse than the doc gap is the **silent fallback**:

```js
// backend/middleware/auth.js:4
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
```

A production deploy with a missing `JWT_SECRET` boots happily and accepts tokens
anyone can forge, because that fallback string is in a public-ish repo. Same
pattern in [config/db.js:3-4](backend/config/db.js#L3-L4) — a script whose `.env`
failed to load quietly targets localhost (the log line there is a good mitigation,
but a log is not a guard).

Add `backend/config/env.js`, required first in `server.js`:

```js
// Fail fast and loudly rather than booting into a broken half-configuration.
const REQUIRED_IN_PROD = ['JWT_SECRET', 'MONGO_URI', 'ADMIN_PASSWORD'];
const WEAK = new Set(['admin123', 'change-me-to-a-long-random-string', 'password']);

function loadConfig() {
  const prod = process.env.NODE_ENV === 'production';
  const problems = [];

  if (prod) {
    for (const key of REQUIRED_IN_PROD) {
      if (!process.env[key]) problems.push(`${key} is required in production`);
    }
    if (WEAK.has(process.env.ADMIN_PASSWORD)) problems.push('ADMIN_PASSWORD is a known default');
    if ((process.env.JWT_SECRET || '').length < 32) problems.push('JWT_SECRET must be >= 32 chars');
    if (!process.env.CORS_ORIGINS) problems.push('CORS_ORIGINS must be set in production');
  }

  if (problems.length) {
    console.error('Refusing to start:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }

  // Warn (don't fail) on the optional integrations, naming what stops working.
  if (!process.env.SARVAM_API_KEY) console.warn('SARVAM_API_KEY unset — call grading disabled');
  if (!process.env.LEAD_INGEST_TOKEN) console.warn('LEAD_INGEST_TOKEN unset — lead ingest is unauthenticated');
}
```

Then regenerate `.env.example` from the real list — a one-off script that greps
`process.env.X` across `backend/` (excluding `node_modules`) and diffs against the
file will keep it honest, and can run in CI.

---

## 6. 🟠 Graceful shutdown and single-instance assumptions

### 6a. No shutdown handler

[backend/server.js](backend/server.js) never captures the `app.listen` return
value and installs no `SIGTERM`/`SIGINT` handler. The schedulers install
`setInterval`s that are never cleared
([modules/calls/services/scheduler.js:393-400](backend/modules/calls/services/scheduler.js#L393-L400),
`services/taskSync.js`, `modules/ads/services/scheduler.js`). Node runs as PID 1
in the container, so `docker stop` waits 10s and then SIGKILLs — potentially
mid-write on a call upsert or mid-Meta-sync.

```js
// backend/server.js
const server = app.listen(PORT, () => { /* … */ });

async function shutdown(signal) {
  console.log(`${signal} received — draining`);
  callJobs.stop(); taskJobs.stop(); adJobs.stop();   // each must clearInterval
  server.close(async () => {
    await mongoose.connection.close(false);
    process.exit(0);
  });
  setTimeout(() => { console.error('drain timed out'); process.exit(1); }, 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

Each scheduler needs a matching `stop()` that clears its intervals. Also add
`tini` to the Dockerfile (`RUN apk add --no-cache tini` +
`ENTRYPOINT ["/sbin/tini","--"]`) so signals reach Node properly.

### 6b. The app cannot run more than one replica

This is worth naming explicitly, because it constrains every future deploy
decision:

- **In-memory locks** — `let syncRunning = false`
  ([callController.js:33](backend/modules/calls/controllers/callController.js#L33)),
  `running = { calls: false, … }`
  ([scheduler.js:55](backend/modules/calls/services/scheduler.js#L55)),
  `isSyncing` in the ads module. Two replicas both run the sync.
- **In-process caches** — `journeyCache`, `cplCache`, `warmTaskCache`, alias
  caches. Two replicas serve different numbers for the same query.
- **Schedulers inside the web process** — every replica polls TeleCMI, Bigin and
  Meta on its own timer, multiplying API quota use.
- **Ephemeral audio cache** — `audio.js` defaults `CALL_AUDIO_CACHE` to
  `os.tmpdir()` inside the container, so every restart re-transcodes every
  recording through ffmpeg.

You do not need to fix this now — one container is a legitimate choice at this
scale. But make it deliberate:

- **Short term:** set `CALL_AUDIO_CACHE=/data/audio` and mount a named volume in
  `docker-compose.yml`; document "single replica only" in the README so nobody
  scales it to 2 and quietly doubles the Meta API spend.
- **When you outgrow it:** split the scheduler into a second process/container
  (`node worker.js`, same image, different CMD), move locks to a Mongo
  `findOneAndUpdate` lease document, and move caches to Redis. The module layout
  already makes this a mechanical change — `scheduler.start()` is called from
  exactly one place.

---

## 7. 🟡 Observability

302 `console.*` calls across the backend, unstructured, going to stdout. There is
no request logging, no correlation id, no error tracker, and no metrics.

- **Structured logging** — `pino` with `pino-http`. Attach a request id, redact
  `phone`/`email`/`authorization` centrally rather than per call site (this also
  fixes the PII-in-logs item in §1c properly). Keep the existing `[grade]`,
  `[reconcile outgoing]` prefixes as a `component` field so the log lines stay
  greppable in the same way.
- **Error tracking** — Sentry (or equivalent) on both the Express error handler
  and the React `ErrorBoundary` you already have
  ([frontend/src/components/ErrorBoundary.jsx](frontend/src/components/ErrorBoundary.jsx)).
  Right now a rep hitting a crash produces no signal at all.
- **A real health check** — `/health` ([app.js:64-66](backend/app.js#L64-L66))
  returns `{status:'ok'}` unconditionally, including when Mongo is down. The
  Docker `HEALTHCHECK` therefore reports healthy on a container that can serve
  nothing. Split it:
  - `/health` — liveness, stays trivial (that is correct for Docker restarts).
  - `/ready` — checks `mongoose.connection.readyState === 1`, returns 503
    otherwise. Point the compose healthcheck at this one.
- **Sync visibility** — you already persist `AdSyncRun`. Do the same for the call
  and task reconcile polls, and surface last-run/last-error/backlog-size on an
  admin "System" tab. Today the only way to know grading has stalled is to read
  container logs.

---

## 8. 🟡 API design

**No pagination on the main list endpoint.** `GET /api/tasks`
([taskController.js:129](backend/controllers/taskController.js#L129)) fetches
every task document; the frontend then `flatMap`s them client-side
([Dashboard.jsx:33](frontend/src/components/Dashboard.jsx#L33)) and polls it
**every 15 seconds** ([Dashboard.jsx:45](frontend/src/components/Dashboard.jsx#L45)).
The in-process cache hides the DB cost but not the serialization or transfer cost,
and it grows linearly forever. `/api/calls` does this right (`page`/`limit`) —
apply the same shape to tasks, and move filtering server-side so the
`applyFilters` work in `taskStats.js` runs on an index rather than in the browser.

**No input validation layer.** Query and body params are read ad hoc across ~10
controllers, with the coercion bugs that implies (§3). Add `zod` and validate at
the router boundary:

```js
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['pending','done','failed','skipped']).optional(),
  owner: z.string().email().optional(),
});
router.get('/', validate({ query: listQuery }), listCalls);
```

That single change closes the NoSQL-injection class, the 500-instead-of-400
class, and the unbounded-`limit` class at once.

**Envelope consistency.** Most endpoints return `{success, data}`, some return
bare objects, some use `count`, some `pages`. Pick one and write it down.

**No API documentation.** ~40 endpoints exist with no reference. An OpenAPI spec
(hand-written is fine) would pay for itself the first time the landing-page team
asks what `/api/leads/web` accepts.

---

## 9. 🟡 Frontend architecture

Current state: React 18, no router, no state library, no data-fetching library,
19 components, one 573-line `TaskDetail.jsx`, one 542-line `Calls.jsx`.

- **No routing.** The active tab lives in `localStorage`
  ([Dashboard.jsx:21](frontend/src/components/Dashboard.jsx#L21)) and every
  filter lives in `useState` (`Calls.jsx` alone has 17 `useState` calls for
  filters). Consequences: you cannot link a colleague to a filtered view, the
  back button does nothing, and a refresh loses all filters. Adding
  `react-router` + URL search params fixes all three and *removes* code — the
  `allowed`/redirect logic in `Dashboard.jsx` becomes route guards.
- **Manual data fetching everywhere.** Each component hand-rolls
  loading/error/refetch state. TanStack Query would delete most of it and give
  you caching, dedup, background refetch and stale-while-revalidate for free —
  including replacing the 15s `setInterval` full-table poll with a windowed
  refetch that pauses when the tab is hidden.
- **No code splitting.** Every tab, including the admin-only Marketing/AdLeads
  bundle, ships to every rep on first load. `React.lazy` per tab is a ten-line
  change.
- **Token in `localStorage`** ([api.js:1-10](frontend/src/api.js#L1-L10)) with a
  30-day expiry ([authController.js:32-34](backend/controllers/authController.js#L32-L34))
  and no revocation. Any XSS is a month-long account takeover. Shorten the access
  token to 1–8h, add a refresh token in an `httpOnly` cookie, and add a `jti`/
  token-version field on `User` so a compromised token can be killed.
- **Component size.** `TaskDetail.jsx` (573 lines) and `Calls.jsx` (542) each mix
  data fetching, filter state, formatting helpers and markup. Extract the
  formatters (`mmss`, `shortDate`, `upsellLabel`, `statusBadge` — currently
  defined inline in `Calls.jsx`) into `utils.js`, and pull each tab's fetching
  into a hook.
- **No accessibility or responsive pass.** Worth an hour with keyboard-only
  navigation and a narrow viewport before the next round of users.

---

## 10. 🟡 Cost and quota control on the AI providers

Transcription (ElevenLabs) and grading (Sarvam) are metered, per-call, and driven
by background workers with no spend ceiling. The existing controls are
`TRANSCRIBE_SCOPE`, `TELECMI_MIN_DURATION_SEC`, `TRANSCRIBE_BATCH` and
`GRADE_MAX_ATTEMPTS` — and the current `.env.example` sets the two widest values
(`TRANSCRIBE_SCOPE=all`, `TELECMI_MIN_DURATION_SEC=0`), so every recorded call,
however brief, is paid for.

The backoff design is genuinely good — `gradeBlockedUntil`
([scheduler.js:52](backend/modules/calls/services/scheduler.js#L52)) pauses 30
minutes on provider faults without burning per-call retry budget, and quota
errors don't count as attempts. What's missing is the money view:

- **Record cost per job.** Store `audioSeconds` and `promptTokens`/
  `completionTokens` on the `Call` when transcribing/grading, so spend is
  queryable rather than only visible on a provider invoice.
- **A daily ceiling.** `TRANSCRIBE_DAILY_MAX_MINUTES` / `GRADE_DAILY_MAX_CALLS`,
  checked in the worker. A runaway backfill or a webhook flood currently has no
  brake.
- **Surface the backlog.** Pending-transcription and pending-grade counts on the
  admin System tab (§7) turn "why is the scorecard empty" into a glance.

---

## 11. 🟢 Code-level cleanups

**Dead code** (from `TODO.md`, re-verified):
- `services/enrich.js` → `enrichBody()` exported, never called.
- `modules/calls/services/dealSync.js` — used only by the one-off
  `scripts/linkClosedDeals.js`; superseded by `dealStore.js`.
- `telecmi.js` → `recordingUrl`, `dealStore.js` → `fetchProducts` — exported,
  unused.
- `Calls.jsx` fetches `/api/calls/stats` into a `stats` state that is never
  rendered; the whole `callStats` controller produces numbers no screen shows.
  Either surface it or delete both ends.

**Large files worth splitting:**
| File | Lines | Suggested split |
|---|---|---|
| [modules/ads/routes/ads.js](backend/modules/ads/routes/ads.js) | 831 | Routes are doing controller work — extract `adsController.js`, matching the pattern every other module uses |
| [modules/calls/controllers/callController.js](backend/modules/calls/controllers/callController.js) | 691 | Split list/detail, analytics, and sync into three |
| [frontend/src/components/TaskDetail.jsx](frontend/src/components/TaskDetail.jsx) | 573 | Extract notes, status, WhatsApp panels |

**Structural inconsistency.** Two layouts coexist: flat MVC (`routes/` →
`controllers/` → `services/` → `models/`) and modules (`modules/calls`,
`modules/ads`). The README explains this honestly as history, but new work has to
guess which to follow, and `modules/ads/routes/ads.js` has already drifted (routes
containing controller logic). Either finish the move — `modules/tasks/`,
`modules/users/` — or write the rule down: "anything touching tasks/users/auth
stays flat; new feature areas are modules."

**Scripts directory.** 16 one-off scripts across `backend/scripts/` and
`backend/modules/calls/scripts/` with no index. Add a `scripts/README.md` saying
what each does, whether it is idempotent, and whether it has already been run in
production — `backfillPhoneKeys.js` in particular is still flagged in `TODO.md` as
"RUN ON PROD after deploy" with no record of whether that happened.

---

## 12. 🟢 Documentation and process

- **`TODO.md` is stale.** It is dated 2026-07-15 and still lists "wire grading
  into the product" as unfinished — but `scheduler.js` now has `gradePending()`
  running on `GRADE_POLL_MINUTES` with provider backoff, so that shipped. A stale
  audit file trains people to ignore it. Either update it or fold the still-open
  items into this document and delete it.
- **`fix.md`** (17KB, last touched 2026-07-15) is an untracked-purpose working
  file at the repo root. Move it under `plans/` or delete it.
- **No `CONTRIBUTING.md`** — no stated branch convention, commit format, or
  review expectation, despite the repo clearly using PRs.
- **No `CHANGELOG.md`** — with a single-container deploy and no versioning, there
  is no way to answer "what's actually running in prod right now."
- **No `CODING_STANDARDS.md`** — worth writing given this repo has a genuine and
  unusual house style (long explanatory comments about *why*, which is a real
  asset and should be stated as an expectation rather than left to osmosis).
- **No `.dockerignore` check on `plans/`** — the whole `plans/` and
  `grading-results/` tree may be copied into the image by `COPY backend/ ./`;
  verify and trim.

---

## Suggested sequence

**This week — nothing here takes more than an afternoon:**
1. Delete `GET /webhook` (§1a).
2. Rotate the admin password and the Mongo Atlas password; tighten the Atlas IP
   allowlist off `0.0.0.0/0` (§2).
3. Add `helmet`, `express-rate-limit` on login, a body-size limit, and a real
   CORS allowlist (§3).
4. Add the boot-time config validator — especially the `JWT_SECRET` guard (§5).
5. Add webhook shared secrets (§1b).

**This month:**
6. Graceful shutdown + `tini` + persistent audio cache volume (§6a).
7. Change-password endpoint, shorter token life, bcrypt cost 12 (§2, §9).
8. Tier-1 tests + lint + a CI workflow (§4).
9. `zod` validation at the router boundary — closes the injection class (§8).
10. Structured logging + `/ready` + Sentry (§7).

**Next quarter:**
11. Pagination and server-side filtering on `/api/tasks` (§8).
12. Router + TanStack Query + code splitting on the frontend (§9).
13. Split the scheduler into its own process, if and when you need a second
    replica (§6b).
14. Provider cost tracking and daily ceilings (§10).

---

## One thing I'd push back on

The audit in `TODO.md` correctly identified the critical security items **more
than three weeks ago** (2026-07-15), and the note there says they were "left
untouched by request" while ten non-security bugs were fixed and verified. Since
then the project has added a whole ads module, public lead ingest, and call
grading — meaning the amount of PII sitting behind an unauthenticated `GET
/webhook` has grown considerably, and the service now also holds Meta ad spend
data and lead PII that used to live elsewhere.

Items §1 and §2 are each a single-commit fix. If nothing else in this document
gets done, do those two.
