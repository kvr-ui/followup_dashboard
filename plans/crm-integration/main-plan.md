# Plan: crm-integration

## Goal

Retire the standalone `focas-crm` service and move everything it owns — Meta Ads
sync, UTM lead capture, and all its data — into `Followup_dashboard`, so that
opening a lead shows where it came from and what it cost, alongside the calls,
tasks and deals the dashboard already holds. One service, one database, one
deploy.

## Approach

Two services currently hold two halves of the same lead. `focas-crm`
(TypeScript/ESM, MongoDB Atlas db `meta`, live at `crm.focasedu.online`) knows a
lead's UTM tags, its Meta campaign, and what that campaign spent.
`Followup_dashboard` (CommonJS JS, local Mongo `followup_dashboard`, port 7007)
knows what happened after — Bigin tasks, calls, transcripts, grades, deals. A rep
opening a lead sees only the second half.

The CRM backend is ported to plain CommonJS JS as a new `backend/modules/ads/`
module, following the shape of the existing `backend/modules/calls/`. Its Atlas
data is migrated wholesale into the local database. Leads are matched to Tasks by
Bigin contact id with a phone fallback, and a new Acquisition panel on the lead
detail drawer shows source, campaign, UTM tags, the form's qualification answers,
and an estimated cost. Ad reporting is rebuilt as an admin-only Marketing tab. The
public lead-capture endpoint moves last, behind a dual-write window, after
everything else is proven.

## Decisions & Rejected Alternatives

Written for a future reader asking "why is it built this way?"

- **Retire `focas-crm` completely** — the goal is a single database, and running
  both keeps two copies of the truth. Rejected: keeping the CRM as a secondary
  view (contradicts the single-DB goal outright); keeping only its frontend (two
  frontends and two auth models — JWT vs `x-api-key` — to reconcile forever).

- **Port TypeScript → plain CommonJS JS** rather than adopting TypeScript in the
  dashboard. The dashboard is deliberately build-step-free and dependency-light;
  a mixed JS/TS backend and a `tsc` stage is a permanent tax on every future
  change. Rejected: adding a TS build (mixed backend, plus mongoose 8.5 vs 9.8
  typing differences to reconcile); keeping ported code as ESM `.mjs` (two module
  systems in one backend is a footgun for the next maintainer).

- **Keep `@santhosh785/meta-ads`, wire a GitHub token into the Docker build.** It
  is a maintained connector that already handles Meta's pagination, error mapping
  and rate limits. Rejected: rewriting with plain `fetch` (re-solves problems the
  package already solves, and loses future fixes); vendoring the source (an
  instant fork).

- **Keep Meta's own string id as `_id`** on the five Meta entities. This makes the
  Atlas migration a straight copy with no transformation and keeps every
  `campaignId` / `adsetId` / `adId` cross-reference valid. Rejected: ObjectId plus
  a `metaId` field (every cross-reference needs remapping and every upsert gains a
  lookup, for a purely cosmetic consistency win).

- **Match leads to Tasks on `biginContactId` first, last-10-digit phone second.**
  The id match is exact; phone catches the rest. Rejected: phone only (two family
  members sharing a number collapse into one lead); `biginContactId` only (Meta
  form leads have no Bigin id and could never match); phone-or-email (widest net,
  but shared family email addresses merge distinct people).

- **Resolve `utmCampaign` to a campaign at write time, storing `resolvedBy`.** The
  CRM matches UTM strings to campaign *names* by exact string equality, which
  silently yields a blank CPL whenever tagging drifts. Recording *how* a lead
  resolved makes a wrong number traceable and surfaces bad tagging for fixing at
  source. Rejected: putting Meta's campaign id in every ad URL (requires editing
  every live ad, and historical leads stay unattributed); exact-match only
  (carries today's blank-CPL problem straight across); a hand-maintained mapping
  table (ongoing upkeep on every campaign launch).

- **Cost = campaign spend ÷ Meta-reported lead actions, for the lead's capture
  month.** Meta gives no per-person cost, so any figure is an apportionment; the
  monthly window is stable enough to defend in a review and granular enough to
  reflect that CPL drifts over a campaign's life. The UI always shows the division
  that produced it. Rejected: daily CPL (a day with ₹5,000 spend and one lead
  reports a ₹5,000 lead); lifetime CPL (the same lead is worth a different amount
  every time you open it); adset-level where available (two different denominators
  in one column, so leads stop being comparable).

- **Denominator is Meta's own reported lead actions**, matching Ads Manager and the
  CRM's existing `leadsFromActions()`. Rejected: counting captured rows (won't
  reconcile with Ads Manager, and a capture outage inflates CPL); showing both
  (two numbers confuse reps).

- **Attribution to everyone, rupee figures to admins only**, stripped server-side
  for `role: 'sales'` exactly as `/api/analytics` is already gated. Source,
  campaign, UTMs and qualification answers genuinely help a rep on a call; monthly
  ad spend should not be inferable from a rep login. Rejected: showing cost to all
  (budget becomes inferable by anyone); cost bands (vague and less actionable than
  either a number or nothing).

- **Store the stable link, compute the cost on read.** `source` and the lead↔task
  link never change, so they are denormalized onto `Task` for the list view. Cost
  drifts as the month's spend accrues, so it is computed on demand from a cached
  campaign×month CPL table rebuilt after each sync. Rejected: denormalizing cost
  (a lead captured today has a stored cost that is wrong tomorrow, requiring a
  recompute pass after every sync); computing everything live (an aggregation on
  every drawer open).

- **Unmatched ad leads get their own view; they never auto-create Tasks.** The
  Follow-ups table stays what it is — Bigin-driven — and a lead links itself the
  moment Bigin's webhook arrives. Rejected: auto-creating Tasks (two creation paths
  and a de-dup problem when Bigin catches up); ignoring them (silently losing
  leads and corrupting the spend denominator).

- **Rebuild ad reporting without a chart library.** The dashboard frontend has zero
  dependencies beyond React; tables carry the same information as a spend
  time-series. Rejected: adding Recharts (~500kB into a deliberately empty
  dependency list, plus restyling to the muted palette); folding into the existing
  Analytics tab (which is about rep performance — mixing ad economics in makes it
  a grab-bag).

- **Cut over the public endpoint last, with a dual-write window.** It is the only
  step that can silently drop real leads. Rollback is one environment variable.
  Rejected: proxying the old hostname permanently (a confusing name pointing at the
  dashboard forever); a same-day hard cutover (no safety net if the ported endpoint
  has a bug).

- **Migrate all Atlas data, verified by count.** The capture history is
  irreplaceable and Meta's insights API does not reach back indefinitely. Rejected:
  migrating leads only (older months lose their spend rows, so historical CPL goes
  blank); starting clean (every existing lead shows no attribution — most of what
  was asked for, gone).

- **Harden the ingest beyond a straight port.** The dashboard also holds calls,
  recordings and transcripts, so its public surface deserves more care than the
  CRM's did. Rejected: porting protections as-is (no defence against someone who
  reads the landing page's JS and posts junk within the rate limit); adding a
  captcha (touches the landing pages, adds a third party in the capture path, and
  a captcha failure silently costs real leads).

### Constraints discovered during exploration

These shaped the plan and must not be re-litigated during execution:

1. `Task.dedupeKey` is `contact:<biginContactId>`, **not** phone. `Task.phone`
   exists but is unnormalized and unindexed, unlike `Call.phoneKeys` and
   `Deal.contactPhoneKey`. A `phoneKey` field plus a backfill is required.
2. `MetaInsight.spend` is in **rupees** (major units) while `dailyBudget` /
   `lifetimeBudget` are in **paise** (minor units) — two conventions in one model.
   Both formatters must survive the port.
3. `@santhosh785/meta-ads` is **ESM-only** (`"type": "module"`, no `require`
   export) and must be reached from CommonJS via a cached dynamic `import()`.
4. `GET /api/leads/web` is currently **public** on the CRM and returns full lead
   PII. In the dashboard it goes behind JWT + admin.
5. `app.use(cors())` in the dashboard allows **all origins**. The ingest route gets
   its own explicit allowlist rather than inheriting this.
6. Meta's spend figures settle for 24–48 hours, so recent-day costs shift. This
   caveat belongs in the Marketing tab.

## Tasks

| # | Task | Phase | Depends on | Type | Status |
|---|------|-------|------------|------|--------|
| 1 | Port the ads data models | 1 | — | backend | pending |
| 2 | Wire the private Meta package into the build | 1 | — | mechanical | pending |
| 3 | Add phone-key and lead-link fields to Task | 1 | — | backend | pending |
| 4 | Port the Meta sync engine and scheduler | 2 | 1, 2 | backend | pending |
| 5 | Build the attribution resolvers and CPL cache | 2 | 1, 3 | backend | pending |
| 6 | Port the public web-lead ingest endpoint | 2 | 1, 2 | backend | pending |
| 7 | Migrate the Atlas data and backfill attribution | 3 | 4, 5 | backend | pending |
| 8 | Expose acquisition data on the lead detail API | 3 | 5 | backend | pending |
| 9 | Build the admin ads reporting API | 3 | 4, 5 | backend | pending |
| 10 | Add the Acquisition panel to the lead drawer | 4 | 8 | ui | pending |
| 11 | Add the Source column and filter | 4 | 8 | ui | pending |
| 12 | Build the Marketing and Ad Leads tabs | 4 | 9 | ui | pending |
| 13 | Cut over lead capture and retire focas-crm | 5 | 6, 7, 10, 11, 12 | mechanical | pending |

## Execution phases

- **Phase 1 (parallel):** task-1, task-2, task-3
- **Phase 2 (parallel):** task-4, task-5, task-6
- **Phase 3 (parallel):** task-7, task-8, task-9
- **Phase 4 (parallel):** task-10, task-11, task-12
- **Phase 5:** task-13

Phase 4 is where the thing that was actually asked for becomes visible. Phases 1–3
change no UI and are verified by data counts alone. Stopping after any phase leaves
a working system.

## File ownership

Parallel tasks must not contend for the same file. Ownership is fixed:

| File | Owned by |
|---|---|
| `backend/modules/ads/models/*` | task-1 |
| `Dockerfile`, `docker-compose.yml`, `backend/.npmrc`, `backend/.env.example` | task-2 |
| `backend/models/Task.js`, `backend/services/taskStore.js` | task-3 |
| `backend/modules/ads/services/sync*.js`, `metaClient.js`, `scheduler.js`, `backend/server.js` | task-4 |
| `backend/modules/ads/services/campaignResolver.js`, `leadLinker.js`, `cplCache.js` | task-5 |
| `backend/modules/ads/routes/webLeads.js`, `backend/modules/ads/middleware/rateLimit.js` | task-6 |
| `backend/scripts/*`, `plans/crm-integration/MIGRATION.md` | task-7 |
| `backend/controllers/taskController.js` | task-8 |
| `backend/modules/ads/routes/ads.js` | task-9 |
| `frontend/src/components/TaskDetail.jsx` | task-10 |
| `frontend/src/components/TaskTable.jsx`, `frontend/src/components/Filters.jsx` | task-11 |
| `frontend/src/components/Marketing.jsx`, `AdLeads.jsx`, `frontend/src/adStats.js`, `frontend/src/components/Dashboard.jsx` | task-12 |

`frontend/src/styles.css` is touched by tasks 10, 11 and 12. Each appends a single
clearly-commented block at the end of the file using its own class prefix
(`.acq-`, `.source-`, `.mkt-`) — never editing existing rules.
