# Followup Dashboard — Comprehensive System Report

_Generated 2026-07-15. Based on a full-codebase analysis (backend architecture, frontend, security verification, and correctness bug hunt)._

## 1. Executive Summary

**What the system is:** A single-tenant lead-followup and sales-intelligence dashboard for an education company (Focas). Node/Express + MongoDB backend, React (Vite) frontend, deployed as one Docker container on port 7007. It ingests Bigin CRM webhooks into a lead/task board, syncs TeleCMI call recordings, transcribes them (ElevenLabs) and grades sales calls (Sarvam AI), and runs WhatsApp campaigns through WATI. Built in three waves: v1 (lead board), v2 (call grading), v3 (WhatsApp campaigns, currently paused).

**Current state:** The system is functionally rich and, in its newer modules, genuinely well-engineered — the campaigns queue is crash-safe and idempotent by design, the reconcile jobs self-heal via committed cursors, and the segment rule engine is injection-hardened. The existing `TODO.md` is an unusually honest and accurate audit; its claims were confirmed against current code.

**The gating problem is security, not correctness.** The application is not safe to expose publicly in its current form. Four High-severity issues share one root cause: an unauthenticated, unsigned webhook surface. Everything behind JWT auth is well-guarded (object-level access control is correct), but the public edges leak the entire lead database and accept forged data.

**Second concern is the uncommitted work-in-progress.** The instant-grade fast-path being added in `callWebhookController.js` introduces a double-transcribe race that spends scarce, paid ElevenLabs/Sarvam credits twice on the same call. This should be fixed before committing.

**Assumptions:** single production instance (the code assumes one process throughout); low current data volume (hundreds of leads, ~700 calls) — several "fine for now" findings become real at 10x; small team; India-region Zoho/Bigin. The live deployment environment, actual traffic, and WATI/ElevenLabs billing state could not be assessed.

---

## 2. Architecture & Design

**Structure.** Two conventions coexist: legacy flat MVC for v1 (`routes/` -> `controllers/` -> `services/` -> `models/`) and self-contained modules for v2/v3 (`modules/calls/`, `modules/campaigns/`, each with its own routes/controllers/services/models). The modules correctly reuse shared top-level services (`zoho.js`, `lookback.js`) and the `Task` model. Boot sequence in `server.js` is clean: DB -> seed admin -> `syncIndexes()` on 9 models -> start three schedulers -> warm two caches.

The dependency direction is respected almost everywhere. Notable design-level issues:

- **Single-process assumption is baked in everywhere (High).** Every cache, lock, dedupe map, and job-overlap guard is a module-level in-memory singleton — task cache, analytics cache, journey cache, Zoho token cache, the `syncRunning` sync lock, all three schedulers' `running` flags. The campaigns scheduler documents honestly that two replicas would double-send; the same limitation silently applies to every reconciler and every paid API path (WATI, ElevenLabs, Sarvam). Hard ceiling of one process — horizontal scaling causes duplicate sends and duplicate paid calls. Fine today; a wall later.

- **Duplicated clients and utilities that can drift (Medium):**
  - _Two phone-normalization schemes with incompatible output_ — `callStore.key10/phoneKey` produces last-10-digits (`9876543210`), while `wati.normalizeNumber` prepends `91` (`919876543210`). Both fields are named `phoneKey`. Any future attempt to join a campaign Contact to a Call/Deal by phone will silently never match. This is the most dangerous of the duplications because the shared name hides it.
  - _Two Zoho/Bigin OAuth clients_ — the region-aware `services/zoho.js` vs. a hand-rolled one in `scripts/importFromBigin.js` (hardcodes India DC).
  - _Two WATI clients_ — `services/wati.js` and `modules/campaigns/services/watiApi.js` re-implement `watiFetch` (the split of `sendTemplate` is justified — campaigns need the message id — but the low-level HTTP layer is needlessly duplicated).
  - _Four hand-rolled copies_ of the same stale-while-revalidate cache pattern; the generation-guard correctness fix exists in only two of them.

- **Fragile control flow in `app.js:74-101`.** The malformed-JSON recovery path re-mounts all three webhook routers a second time and relies on falling out of a 4-arg error handler into them. It works, but adding a webhook router and forgetting the second mount would silently drop recovered bodies.

**What's genuinely well done** (so the above is in proportion): idempotent campaign sends via a unique `(campaignId, contactId)` index; `MessageEvent` partial-unique index that correctly prevents webhook double-counting; the forward-only funnel status ladder with click-outranks-read ordering; self-healing reconcilers via `SyncState` cursors committed only on success; the injection-proof segment compiler.

---

## 3. Security

Every `TODO.md` claim was verified against current code and all routes enumerated. Confirmed live:

| Severity | Issue | Location |
|---|---|---|
| **High** | `GET /webhook` returns every lead's full body (names, phones, emails) unauthenticated | `backend/controllers/webhookController.js:59` |
| **High** | `POST /webhook`, `/webhook/call`, `/webhook/deal` accept forged data — no HMAC/signature | `backend/routes/webhook.js:8`, `backend/modules/calls/routes/webhooks.js:12` |
| **High** | Path traversal via `cmiuid` — unauthenticated webhook value flows into a file-write path (`../../...`) | `backend/modules/calls/services/audio.js:30` |
| **High** | JWT: 30-day expiry, fallback secret `'dev-secret-change-me'` if `JWT_SECRET` unset -> forgeable admin tokens | `backend/middleware/auth.js:4` |
| **High** | Default `admin`/`admin123`, no change-password endpoint exists | `backend/config/seed.js:11` |
| Med-High | `cors()` all-origins, no helmet, no rate limiting, unbounded `express.json` + `keepRawBody` double-buffers every body | `backend/app.js:25-34` |
| Medium | NoSQL operator injection via query params (`?leadId[$ne]=`) into `Call.find(q)` | `backend/modules/calls/controllers/callController.js:51` |
| Medium | Raw webhook payloads (PII) logged by default; `fieldsSeen` echoed to anonymous callers | `backend/modules/calls/controllers/callWebhookController.js:142` |
| Low | `createUser` accepts a 1-char password; WATI webhook token compared with non-constant-time `===` | `backend/controllers/userController.js:11` |

**Why the High items cluster:** they are all the public edge of the app. Everything behind `authenticate` is correctly guarded — no route is missing auth by accident, object-level access control (`canAccess`, `canSeeCall`, `ownerScope`) is correctly enforced on every id-based route, and there are no IDOR gaps for sales-role users.

**Checked and cleared** (things you do NOT have): no committed secrets (`.env` is git-ignored; only `.env.example` is tracked); no SSRF; no command injection in the ffmpeg spawn (fixed argv, no shell); no CSV-injection surface; no ReDoS (all user regex input is escaped); no mass-assignment (campaign updates use an explicit allowlist). The `/r/:code` redirect is NOT an open redirect — destinations are DB-only and validated to http/https.

**Minor new findings:** NoSQL operator injection also exists in the admin contact-list filters (`contactController.js:50`); `/r/:code` trusts client `X-Forwarded-For` for the stored click IP (analytics spoofing only).

---

## 4. Bugs / Correctness

The `TODO.md` bug list (10 items) was verified as genuinely fixed. These are new bugs, not in TODO:

1. ✅ FIXED — **High — Double-transcribe/double-grade race in the uncommitted fast-path.** The new `gradeCallNow` in `callWebhookController.js:53` transcribes+grades synchronously off the webhook, with no atomic lease. `transcribeCall` reads status from an in-memory doc and only then writes `'processing'`. The scheduler's `runBatch` snapshots its 10-call batch minutes earlier; its stale doc still says `'pending'`, so it re-downloads and re-transcribes the same call, overwriting the transcript and spending ElevenLabs + Sarvam credits twice — on exactly the resource TODO flags as scarce (152 calls pending, limited credits). Fix: lease with `findOneAndUpdate({_id, transcriptionStatus:'pending'}, {$set:{transcriptionStatus:'processing'}})` and proceed only if a doc came back.

2. ✅ FIXED — **High — No reaper for `processing` state.** `transcriptionWorker.js:29` sets `'processing'` before the long download/transcribe call, but every selector only queries `'pending'`. A crash or deploy mid-flight strands the call at `'processing'` forever — silent permanent gaps in coverage. Add a timeout that re-queues `processing` calls older than N minutes. (Compounds with the missing graceful shutdown — no SIGTERM handler, intervals never cleared, so deploys kill in-flight work.)

3. ✅ FIXED — **Medium — A/B split math is wrong for any ratio other than 50/50.** `sender.js:50`: arm A takes buckets `[0,share)`, arm B takes `[100-share,100)` — a clean partition only when `share===50`. A 70/30 test double-sends to 40% of contacts; a sub-50 split drops contacts entirely. Correct is B: `bucket >= share`. Gated today only because the A/B UI isn't built, but the API path is live.

4. ✅ FIXED — **Medium — Four unhandled-rejection sites on the task write path.** `getTask`, `updateStatus`, `addNote`, `sendWhatsapp` in `taskController.js` have no try/catch (every other controller does). A transient Mongo error leaves the request hanging until timeout.

5. ✅ FIXED — **Low/Medium — `campaign.stats.queued` inflates permanently.** At-send-time skips (opt-out, deleted contact) in `sender.js:222` don't update `Campaign.stats`, so a campaign finishes showing `queued: 40` forever. Display only; the live funnel aggregation is correct.

6. ✅ FIXED — **Low — Aggregate `failureRate` is hardcoded to 0** on the campaigns list (`campaignController.js:112`). Per-campaign is correct.

7. ✅ FIXED — **Low — `resume` doesn't validate current status** — can bounce a completed/cancelled campaign back through `sending`.

8. ✅ FIXED — **Low — The uncommitted scorecard re-sort has a keying gap.** `joinedMap` in `callController.js:526` is keyed by `ownerEmail` only, but rows key by `repKey` (which falls back to extension->email mapping). An extension-only rep gets `joinedAt=null` and sorts to the bottom regardless of tenure. Also note this change replaces score-ranked ordering with join-date ordering entirely — confirm that's intended.

9. ✅ FIXED — **Low — CSV import** doesn't handle capitalized phone headers (`Mobile`, `Number`, `WhatsApp`) — they're neither used as the phone source nor excluded, so the number leaks into template variables.

**On the uncommitted `Scorecard.jsx` change:** the "Day by day" table and its `recentDays` rendering were removed. Confirm the backend `gradeAnalytics` no longer computes `recentDays`, or it's now dead payload.

---

## 5. Frontend

- ✅ FIXED — **No error boundary anywhere (High).** A single render throw white-screens the entire SPA. Several unguarded nested accesses can trigger it on one malformed API record: `c.stats.sent` on every Contacts row (`Contacts.jsx:213`), `detail.statusHistory.length`/`detail.notes.length` in TaskDetail, `campaign.stats.sent` in CampaignDetail. Add a boundary + optional chaining.
- ✅ FIXED — **Stale-response races (Medium).** Detail drawers (`CallDetail`, `ContactDetail`, `TaskDetail`, `CampaignDetail`) refetch on id change with no cancellation — a slow earlier response overwrites a newer one after fast clicking. The correct `cancelled`-flag pattern already exists in `CampaignComposer.jsx:77` and just isn't applied elsewhere.
- ✅ FIXED — **`CampaignDetail` re-fires network calls every 8s** because the whole `campaign` object is in a dep array that changes on every poll tick (`CampaignDetail.jsx:72`).
- ✅ FIXED — **Index keys on editable lists (Medium)** — Segments condition rows and SequenceForm steps use `key={i}`; removing a middle row misassigns input state to neighbors.
- ✅ FIXED — **Non-atomic create-then-send** in CampaignComposer leaves orphan draft campaigns on transient send failure.
- **Unbounded client-side fetch+filter** on Dashboard (all tasks, re-polled every 15s), Upsells, Installments, Products, CampaignInbox. Fine now, degrades linearly. Contacts.jsx does it right with server-side pagination — use it as the model.
- ✅ FIXED (deleted) — **Confirmed dead code:** `CampaignForm.jsx` (427 lines) — not imported anywhere.
- **a11y:** clickable `<div>`/`<tr>` with no role/tabIndex/keyboard handling throughout.

---

## 6. Performance

Current volumes are small, so most of this is latent:

- **Unbounded `find()` full scans** on `Task` (task cache, analytics, callStore) and all closed deals (journey cache) — comments already acknowledge ~25s Atlas M0 scans. These are the scaling cliff.
- **Per-request in-memory filtering** — non-admin task requests load the entire shared lead cache and filter by owner in JS (`taskController.js:140`). Should be a DB-level owner filter.
- **Unanchored `/.../i` regex search** defeats indexes -> collection scan on every search keystroke (calls and contacts search).
- **N individual `.save()`s in a loop** in `tagCallsForDeal`.
- **Audio cache defaults to `os.tmpdir()`** inside the container — every restart re-transcodes every recording via ffmpeg. Mount a volume.
- No `compression` middleware on large analytics/journey payloads.

---

## 7. Testing & Tooling

None of it exists. No tests, no ESLint/Prettier, no CI, no pre-commit hooks, no README/LICENSE, no `engines` pin, no structured logging (all `console.*`), no error monitoring (`unhandledRejection`/`uncaughtException` handlers absent — which is what makes bugs #4 and #1 dangerous). The only tests ever written (campaigns smoke test + classifier unit test, 26+17 assertions) live in a scratch dir outside the repo. `.env.example` documents 13 keys while the code reads ~42, including secret-bearing ones.

This is the single biggest structural gap: a codebase this feature-rich, handling money-spending external APIs, with zero automated verification, means every one of the bugs above shipped undetected and the next one will too.

---

## 8. Prioritized Recommendations

**Quick wins (high impact, low effort) — do before any public exposure:**

1. Gate or delete `GET /webhook` (`/api/tasks` already supersedes it). _One line._
2. Fail startup if `JWT_SECRET` or `ADMIN_PASSWORD` is unset/weak in production. _A few lines; kills two High items._
3. `String()`-coerce webhook `cmiuid` + `path.basename` it before the cache path. _Kills the path-traversal High._
4. Add HMAC/shared-secret verification on the three webhooks (`req.rawBody` is already captured). _Kills the forgery High._
5. Add `helmet()`, `express-rate-limit` on `/login` + webhooks, `express.json({ limit: '1mb' })`, restrict `cors({ origin: ... })`.
6. Default `LOG_WEBHOOK_PAYLOADS` off; drop `fieldsSeen` from responses.
7. Delete `CampaignForm.jsx`.

**Before committing the current WIP:**

8. Add the atomic lease to `gradeCallNow` (bug #1) — this is money.
9. Fix the `joinedAt` keying gap or confirm the scorecard re-sort is intended (bug #8).

**Medium-term (high impact, moderate effort):**

10. `processing`-state reaper + graceful SIGTERM shutdown (bug #2). These pair naturally.
11. Wrap the four task write-handlers in try/catch, or add a central async error middleware + `unhandledRejection` handler (bug #4).
12. Fix the A/B split math before building the A/B UI (bug #3).
13. Introduce a test harness — even just the two existing scratch tests moved in-repo, plus a smoke test per module. Add ESLint.
14. Regenerate `.env.example` from the real key list; add Mongo connection options and a named volume for the audio cache.

**Longer-term (architectural):**

15. Reconcile the two `phoneKey` schemes before building the WhatsApp-thread-to-lead linking feature — it will silently never match otherwise.
16. If >1 process is ever needed: move locks/dedupe to Mongo leases (`findOneAndUpdate`). Until then, document the single-process constraint at the top of `server.js` so it isn't violated accidentally.
17. Extract the four duplicated cache implementations and the duplicated WATI/Zoho HTTP layers into shared helpers.

---

**Bottom line:** the correctness engineering here is above average for a solo/small-team project — the hard concurrency and idempotency problems in the newest modules are solved well. The gap is the security perimeter and the total absence of automated verification. Items 1-7 (roughly a day of work) move this from "must not be public" to "defensibly public"; the WIP fixes (8-9) protect the API budget right now.
