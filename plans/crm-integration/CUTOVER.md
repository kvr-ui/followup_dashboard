# Lead-capture cutover + focas-crm retirement runbook

Moves live public lead capture from `crm.focasedu.online` (the retired `focas-crm`
service) to this dashboard's `POST /api/leads/web`, then decommissions the CRM.
Companion to [`MIGRATION.md`](./MIGRATION.md), which already moved the CRM's
historical data — this runbook only moves the **live traffic** that MIGRATION.md's
dump necessarily left behind (the CRM kept running during that migration).

**Why this is the last step and the most dangerous one.** Every other task in this
plan is verified against a static, already-captured dataset — get it wrong and
re-run it. This one is verified against leads that are happening *right now*. A bug
here doesn't corrupt a record, it means a real prospect's phone number never reaches
anyone. That is why the sequence below repoints traffic while leaving the CRM
running and idle, purely so it stays available as an instant rollback target, and
why step 3 is a hard stop, not a formality.

**Status of this document.** Written and the local/config half executed by an agent
scoped to documentation and local repo configuration only. Steps 2–4 below touch
live hosts (the lead server, the CRM's VPS, its nginx, its Atlas cluster) and were
**not executed** — they are written precisely enough for an operator with the
relevant access to run them without re-deriving anything. Each step says who needs
to run it and how to verify it landed.

---

## 0. Terms, access, and facts this runbook assumes

| Term | Value | Source |
|---|---|---|
| Dashboard ingest URL | `https://follo.focasedu.in/api/leads/web` | The dashboard's existing public domain — already reverse-proxied for the Bigin (`/webhook/deal`) and TeleCMI (`/webhook/call`) webhooks per `TODO.md`. **Confirm this is still the live domain before step 1** — nothing in this repo pins it (no nginx config is committed here, unlike focas-crm's `deploy/nginx/`). |
| Dashboard health check | `GET /health` → `{"status":"ok"}` | `backend/app.js` |
| Landing-page origin (CORS) | `https://focasedu.com` | focas-crm's own production `.env.example` (`CORS_ORIGINS=https://focasedu.com`) — this is the value that must carry over, not a guess |
| Lead server's target-URL variable | `LEADS_API_URL` | `focas-crm/DEPLOY.md` §6, which is how the CRM itself was originally cut over from an ngrok tunnel — same variable, same mechanism, this time pointed at the dashboard |
| Current value of that variable | `https://crm.focasedu.online/api/leads/web` | same |
| CRM containers | `focas-crm-backend`, `focas-crm-web` | `focas-crm/docker-compose.yml` |
| CRM host repo path | `~/crm_by_focasedu` | `focas-crm/DEPLOY.md` |
| CRM nginx vhost | `/etc/nginx/sites-available/crm.focasedu.online` (symlinked from `sites-enabled`) | `focas-crm/deploy/nginx/crm.focasedu.online.conf` |
| CRM's Atlas connection string | `focas-crm/.env` → `DATABASE_URL` (db name `meta`) | `MIGRATION.md` §0 |
| Migration baseline (for step 3's rate check) | 159 web leads; 52/80 tagged leads resolved a campaign (65%, all via `alias`); 77/159 linked to a Task (48%, all by Bigin contact id) | `MIGRATION.md` appendix, 2026-08-07 run |

**Who can run what.** Step 1 (verification) and the dashboard-side half of
Configuration below can be done by whoever has access to the dashboard's `.env` and
a shell that can reach its public URL. Steps 2–4 additionally need SSH/deploy access
to the lead server (step 2, and the rollback), and to the CRM's VPS (step 4). If
that is more than one person, do not start step 2 until both are confirmed
reachable — a repoint that nobody can roll back is not a repoint, it's a gamble.

---

## Configuration

Both of these are prerequisites for step 1, not something step 1 discovers.

### 1. The shared secret — `LEAD_INGEST_TOKEN`

The CRM never had an equivalent (it relied on CORS + rate limiting only — see
"Harden the ingest beyond a straight port" in `main-plan.md`). This is new.

```bash
# Generate once, use in both places:
openssl rand -hex 32
```

- **Dashboard side:** set `LEAD_INGEST_TOKEN=<value>` in the dashboard's `backend/.env`
  (see `backend/.env.example`, which documents this) and restart the dashboard
  container/process. Until this is set, `requireIngestToken` skips the check
  entirely and the endpoint is unauthenticated (fine for local dev, **not**
  acceptable before real traffic — the middleware logs a boot warning in this
  state, `backend/modules/ads/middleware/leadIngest.js`).
- **Lead server side:** set the matching value in whatever env var the lead
  server's forwarder reads to build its request headers, and confirm it sends it
  as `X-Lead-Ingest-Token` on every POST. (This repo does not contain the lead
  server's code, so the exact variable name there is whatever that codebase
  calls it — the header name and value are what must match.)

Verify both sides agree **before** step 1's shared-secret check, not by that check
— that check only proves the dashboard enforces *some* secret correctly, not that
it's the same one the lead server will send.

### 2. The CORS allowlist — `CORS_ORIGINS`

```
CORS_ORIGINS=https://focasedu.com
```

Set in the dashboard's `backend/.env`. This is the real landing-page origin (the
CRM's own production config used this exact value — see the table above), not a
placeholder. Add `https://www.focasedu.com` too if the landing pages are ever
served from the `www` host as well; the CRM's config did not, so this runbook
doesn't assume it.

> **CORS does not gate the lead server's traffic.** `leadCors` only sets
> `Access-Control-Allow-Origin` when a request carries a browser-supplied
> `Origin` header — a server-to-server POST from the lead server (no browser
> involved) has no `Origin` header, sails through regardless of this allowlist,
> and is authenticated by `LEAD_INGEST_TOKEN` alone. This was confirmed against a
> local instance while writing this runbook (§ Verification performed below):
> a POST with `Origin: https://evil.example.com` and a valid token still returned
> `201` and stored the lead — CORS just omitted the `Access-Control-Allow-Origin`
> header, which is what stops a *browser* from reading the response, not what
> stops the request from being processed. `CORS_ORIGINS` matters if the landing
> page ever posts directly from client JS instead of through the lead server; it
> is not a substitute for the shared secret.

### 3. nginx / X-Forwarded-For — read before step 1, this is load-bearing

Issue #7's agent flagged this and it applies here without modification:

> **The per-IP rate limiter trusts `X-Forwarded-For` as given.**
> `backend/modules/ads/middleware/rateLimit.js` takes the *last* hop of
> `X-Forwarded-For` as the client IP. Behind a reverse proxy that **sets** this
> header itself (overwriting anything the client sent), that's correct and is
> what makes the limiter meaningful. If the dashboard is ever reachable **without**
> going through such a proxy — direct to the Node process, or through a proxy that
> blindly forwards a client-supplied `X-Forwarded-For` — the header is entirely
> attacker-controlled and the rate limiter can be bypassed by rotating it. This is
> not this route's access control (the shared secret is); it exists only to blunt
> junk floods. But an rate limiter that can't be trusted to count correctly can
> also under-count during step 3's dual-running comparison, so confirm before
> go-live that whatever sits in front of `follo.focasedu.in` **sets**
> `X-Forwarded-For` (e.g. nginx's default `proxy_set_header X-Forwarded-For
> $proxy_add_x_forwarded_for;`, as used in `focas-crm/deploy/nginx/crm.focasedu.online.conf`)
> rather than passing a client-supplied value through unchanged.

---

## Sequence

### Step 1 — Verify the dashboard endpoint, before it receives anything

Run from a machine that can reach the dashboard's public URL (ideally the lead
server itself, which also satisfies the reachability check below).

**Reachability first** (this is the "must be reachable from wherever the lead
server runs — verify before step 2, not during it" requirement):

```bash
DASHBOARD_URL=https://follo.focasedu.in
curl -sS -o /dev/null -w "health: %{http_code}\n" "$DASHBOARD_URL/health"
```

Expect `health: 200`. If this fails from the lead server's host specifically
(firewall, DNS, TLS), fix that before anything else — every check below is moot if
step 2's target is unreachable from where it needs to be reached from.

**Then the four checks the acceptance criteria name.** All four were run against a
local instance while writing this runbook (§ below) and behaved exactly as
described; the commands here are the same ones, pointed at the real URL. Values in
`<angle brackets>` must be filled in with the real deployed values.

```bash
DASHBOARD_URL=https://follo.focasedu.in
TOKEN=<the real LEAD_INGEST_TOKEN>
ORIGIN=https://focasedu.com

# a) Shared secret — missing token must be rejected
curl -sS -o /dev/null -w "no token:    %{http_code}\n" -X POST "$DASHBOARD_URL/api/leads/web" \
  -H "Content-Type: application/json" -H "Origin: $ORIGIN" \
  -d '{"name":"cutover-check","phone":"0000000000"}'
# expect 401

# b) Shared secret — wrong token must be rejected
curl -sS -o /dev/null -w "wrong token: %{http_code}\n" -X POST "$DASHBOARD_URL/api/leads/web" \
  -H "Content-Type: application/json" -H "Origin: $ORIGIN" -H "X-Lead-Ingest-Token: wrong" \
  -d '{"name":"cutover-check","phone":"0000000000"}'
# expect 401

# c) CORS preflight for the real landing-page origin must be allowed
curl -sS -D - -o /dev/null -X OPTIONS "$DASHBOARD_URL/api/leads/web" \
  -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: POST" | grep -i access-control
# expect Access-Control-Allow-Origin: https://focasedu.com, plus Allow-Methods/Headers/Max-Age

# d) Honeypot — a filled trap field must be silently accepted and NOT stored
curl -sS -o /dev/null -w "honeypot:    %{http_code}\n" -X POST "$DASHBOARD_URL/api/leads/web" \
  -H "Content-Type: application/json" -H "Origin: $ORIGIN" -H "X-Lead-Ingest-Token: $TOKEN" \
  -d '{"name":"cutover-bot-check","phone":"0000000000","company":"anything here means bot"}'
# expect 202, and this lead must NOT appear in `GET /api/leads/web` (admin) or the dashboard UI

# e) Rate limit — confirm it engages (defaults to 60/min; do not run this loop
#    against production with a low WEB_LEAD_RATE_MAX unless you intend to test it)
for i in $(seq 1 65); do
  curl -sS -o /dev/null -w "%{http_code} " -X POST "$DASHBOARD_URL/api/leads/web" \
    -H "Content-Type: application/json" -H "Origin: $ORIGIN" -H "X-Lead-Ingest-Token: $TOKEN" \
    -d "{\"name\":\"rl-check-$i\",\"phone\":\"000000$i\",\"company\":\"trap\"}"
done; echo
# expect a run of 201/202s then 429s once WEB_LEAD_RATE_MAX is exceeded, with a
# Retry-After header on the 429 responses. Note this uses the honeypot (d) so the
# probe rows are never actually stored as leads.
```

Do not proceed to step 2 until (a)–(e) all match expectations **and** the real
`GET /api/leads/web` (admin JWT) confirms none of these probe rows landed as real
leads.

#### Verification performed (local, while writing this runbook)

Run against a scratch instance of this exact code (`backend/server.js`, scratch
Mongo db, `CORS_ORIGINS=https://landing.focasedu.com`, a scratch
`LEAD_INGEST_TOKEN`, `WEB_LEAD_RATE_MAX=3`) — **not** the live public URL, per this
task's scope:

| Check | Result |
|---|---|
| Missing token | `401 {"success":false,"message":"Unauthorized"}` |
| Wrong token | `401 {"success":false,"message":"Unauthorized"}` |
| Correct token, allowed origin | `201`, `Access-Control-Allow-Origin` echoed, lead stored |
| Correct token, disallowed origin | `201`, lead **still stored** (no `Access-Control-Allow-Origin` header — see the CORS note above), because the token is what gates it |
| Honeypot filled (`company` set) | `202 {"success":true,"ok":true}`, **not** stored (`webleads` count unaffected) |
| Preflight `OPTIONS` for allowed origin | `204`, `Access-Control-Allow-Origin`/`-Methods`/`-Headers`/`-Max-Age` all present |
| Rate limit (`WEB_LEAD_RATE_MAX=3`) | 4th+ request in-window: `429`, `Retry-After` header present, body `{"success":false,"message":"Too many submissions. Please try again shortly."}` |

The scratch database was dropped and the scratch server stopped after this check;
nothing from it persists. This confirms the code behaves as this section
describes — it does not stand in for step 1 against the real deployment, which
still has to be run for real once the real `CORS_ORIGINS` and `LEAD_INGEST_TOKEN`
are set.

---

### Step 2 — Repoint the lead source

**Live-host action. Not performed by this task.**

1. On the lead server, set `LEADS_API_URL=https://follo.focasedu.in/api/leads/web`
   (was `https://crm.focasedu.online/api/leads/web`).
2. Restart the lead server process so it picks up the new value.
3. The CRM (`focas-crm-backend`/`focas-crm-web` containers, and its nginx vhost)
   stays running, untouched. It simply stops receiving traffic — nothing in this
   step touches the CRM.
4. Immediately after restart, send one real-shaped test submission through the
   actual landing-page form (not curl) and confirm by hand that it appears in the
   dashboard's Follow-ups table / admin `GET /api/leads/web`, and does **not**
   appear as a new row in the CRM's Atlas `webleads` collection.

### Step 3 — Dual-running window (several days) — THE VERIFICATION GATE

**Do not proceed to step 4 until this section says pass, for the full window.**
A missing lead is not recoverable, and the CRM is being kept running specifically
so this can still be rolled back if the numbers don't add up.

**What "dual-running" means here:** both services stay up, but only the dashboard
receives traffic after step 2. So the comparison is not "which of the two got more
leads today" — it's two separate checks:

**3a. Confirm the CRM truly stopped receiving.**

```bash
# On/from a host that can reach Atlas — read-only.
DAY=2026-08-11   # the day being checked
mongosh "$ATLAS_SRC" --quiet --eval "
  const start = new Date('${DAY}T00:00:00Z'), end = new Date('${DAY}T23:59:59.999Z');
  print('CRM webleads that day (expect 0 after repoint):',
    db.webleads.countDocuments({ createdAt: { \$gte: start, \$lte: end } }));"
```

Anything nonzero here after step 2 has landed means something is still posting to
the CRM (a cached DNS entry, a second lead-server instance, a hardcoded URL
somewhere) — find and fix it before trusting any dashboard-side count.

**3b. Confirm the dashboard's daily count is in the range the CRM would have
produced.** The CRM's own history is the baseline — pull its recent pre-cutover
daily average from the same Atlas database (read-only, and safe to run even after
step 2, since older data doesn't change):

```bash
mongosh "$ATLAS_SRC" --quiet --eval "
  db.webleads.aggregate([
    { \$match: { createdAt: { \$gte: new Date(Date.now() - 30*24*3600*1000) } } },
    { \$group: { _id: { \$dateToString: { format: '%Y-%m-%d', date: '\$createdAt' } }, n: { \$sum: 1 } } },
    { \$sort: { _id: 1 } },
  ]).forEach(printjson);"
```

Then, each day of the window, on the dashboard side:

```bash
DAY=2026-08-11
mongosh "$DASH_DST" --quiet --eval "
  const start = new Date('${DAY}T00:00:00Z'), end = new Date('${DAY}T23:59:59.999Z');
  const total = db.webleads.countDocuments({ createdAt: { \$gte: start, \$lte: end } });
  const resolved = db.webleads.countDocuments({ createdAt: { \$gte: start, \$lte: end }, resolvedCampaignId: { \$ne: null } });
  const linked = db.webleads.countDocuments({ createdAt: { \$gte: start, \$lte: end }, linkedTaskId: { \$ne: null } });
  print('dashboard webleads', total, '| campaign-resolved', resolved, '| linked-to-task', linked);"
```

**Pass criteria, checked every day of the window:**

- `3a` reads `0` for every day since the repoint.
- `3b`'s dashboard daily total is in the same ballpark as the CRM's own recent
  daily average (allow for normal day-to-day ad-spend variation — this is a
  sanity check for "did leads stop arriving somewhere," not a demand for an exact
  match).
- Leads that carry `utmCampaign` resolve a campaign at roughly the rate
  `MIGRATION.md` established (65% via alias) — a sharp drop means a new UTM
  tagging pattern has appeared that the alias table doesn't cover yet; check the
  admin `GET /api/ads/campaign-aliases` unresolved list.
- Leads link to a Task at roughly the migration's rate (48%, all by
  `biginContactId` in that run) — a sharp drop means the Bigin webhook that
  creates the Task isn't keeping pace with lead capture, or `phoneKey`
  derivation broke.
- **Known, accepted gap:** if any Meta instant-form leads arrive during this
  window (there were 0 at migration time, so this is new territory), they will
  **not** link by phone — `syncLeads.js` does not yet write `MetaLead.phoneKey`
  on the ongoing sync path (only the one-time backfill script derives it). This
  is a pre-existing gap, not something this cutover introduced; it does not block
  go/no-go by itself, but note it and file/track a fix if instant-form leads
  start actually flowing.

**If any of these diverge:** stop. Do not proceed to step 4. Diagnose with the
dashboard's server logs (attribution failures are logged, never thrown — see
`webLeadController.js`'s `attribute()`) and, if leads are genuinely not being
captured, revert step 2 (see Rollback below) while you fix it.

### Step 4 — Retire

**Live-host action. Not performed by this task. Only after step 3 has passed for
the full window.**

1. **Final archival dump of Atlas**, before anything is stopped or removed:

   ```bash
   cd /path/with/space   # gitignored, not this repo — see MIGRATION.md's same caveat
   DUMP_DIR="./focas-crm-final-dump-$(date +%Y%m%d)"
   mongodump --uri="$ATLAS_SRC" --out="$DUMP_DIR" 2>&1 | tee "${DUMP_DIR}.log"
   grep 'done dumping' "${DUMP_DIR}.log"
   ```

   Move `$DUMP_DIR` to durable, access-controlled storage (it contains customer
   phone numbers — same handling as `MIGRATION.md`'s `./crm-dump`). **Record where
   it ends up** — in this file's Appendix below, and in the retirement notice
   (`FOCAS_CRM_RETIREMENT.md`) once it's copied into the `focas-crm` repo.

2. **Stop the CRM containers:**

   ```bash
   cd ~/crm_by_focasedu
   docker compose down
   ```

3. **Remove its reverse-proxy configuration:**

   ```bash
   sudo rm /etc/nginx/sites-enabled/crm.focasedu.online
   sudo nginx -t && sudo systemctl reload nginx
   ```

   (Leave `/etc/nginx/sites-available/crm.focasedu.online` in place or archive it
   — removing the `sites-enabled` symlink is what actually stops nginx serving it;
   deleting the available file too is a nice-to-have cleanup, not a requirement.)

4. **Decommission the Atlas cluster** only after the dump in (1) is confirmed
   readable from its new home. Consider leaving the cluster paused/idle rather
   than deleted for a further grace period — a dump is a point-in-time archive,
   the live cluster is a live one, and the difference has already mattered once in
   this project (`MIGRATION.md`'s own "why this is not repeatable" note).

5. Copy `FOCAS_CRM_RETIREMENT.md` (in this same directory) into the `focas-crm`
   repository as its `README.md` (replacing the current one) or as a new
   `RETIRED.md` linked from the top of the existing `README.md` — either way, it
   must be the first thing a future reader of that repo sees.

---

## Rollback

**At any point before step 4, rollback is reverting one environment variable on
the lead server and restarting it:**

```bash
# On the lead server:
LEADS_API_URL=https://crm.focasedu.online/api/leads/web
# restart the lead server process
```

That's it. The CRM was never stopped before step 4, so it is already listening and
ready the moment traffic points back at it. No dashboard-side action, no data
migration, no config change anywhere else.

- **Who can do it:** anyone with the deploy/SSH access already required to do step
  2 in the first place — this is not a specialized recovery procedure, it's the
  same access, run in reverse.
- **How long it takes:** the time to edit one environment variable and restart one
  process — a few minutes, not a maintenance window.
- **What it does NOT undo:** any leads the dashboard already captured during the
  time it was live stay in the dashboard's database (they are not lost, just no
  longer being added to). Rollback stops new leads from going to the dashboard; it
  does not need to, and does not, claw back what already arrived there correctly.

After step 4, rollback is no longer a config change — the CRM containers and proxy
are gone. Recovery at that point means redeploying the CRM from its repo and Atlas
dump, which is why step 3's gate exists: to make sure that's never actually needed.

---

## Acceptance criteria — status

Restating the issue's checklist with what this document/task actually closes out,
versus what is pending live execution:

- [x] `CUTOVER.md` documents all four steps, the rollback procedure, and the
      verification gate
- [ ] **(pending operator)** The dashboard's public ingest URL is reachable from
      the lead server before any repoint
- [ ] **(pending operator)** Honeypot, rate limit, CORS allowlist and
      shared-secret behaviour verified against the *live* endpoint before real
      traffic is sent (verified against a local instance of the same code — see
      "Verification performed" above — as the groundwork for this)
- [ ] **(pending operator)** The shared secret is set in both the dashboard
      environment and on the lead server (documented in `backend/.env.example`
      and this file's Configuration section; not set on any live host by this task)
- [ ] **(pending operator)** The CORS allowlist names the real landing-page origin
      on the live dashboard environment (the correct value, `https://focasedu.com`,
      is documented here and in `backend/.env.example`; not set on any live host)
- [ ] **(pending operator)** After the repoint, new leads appear in the dashboard
      database with campaign resolution and task linking working
- [ ] **(pending operator)** Daily counts match between dashboard and CRM for the
      full dual-running window
- [ ] **(pending operator)** A final archival dump of the Atlas database is taken
      and its location recorded
- [ ] **(pending operator)** The CRM containers are stopped and its reverse-proxy
      configuration removed
- [x] Deployment documentation covers the new environment variables and the build
      token (`README.md`, `backend/.env.example`)
- [ ] **(pending operator, template ready)** The `focas-crm` repository states
      that it is retired and what replaced it — notice drafted in
      `FOCAS_CRM_RETIREMENT.md`, ready to copy in; not yet copied into that
      (separate) repository

---

## Appendix — fill in as steps 2–4 are actually run

| Field | Value |
|---|---|
| Step 2 performed on | _(date, by whom)_ |
| Dual-running window | _(start date)_ – _(end date)_ |
| Step 3 daily counts | _(link to a log, or paste the table)_ |
| Step 4 performed on | _(date, by whom)_ |
| Final Atlas dump location | _(path / bucket / storage system)_ |
| Atlas cluster decommissioned on | _(date, or "kept paused until ___")_ |
