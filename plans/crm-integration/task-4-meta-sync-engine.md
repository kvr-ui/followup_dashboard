---
task: 4
name: meta-sync-engine
parallel_group: 2
depends_on: [1, 2]
issue: 5
---

# Task 4: Port the Meta sync engine and scheduler

## What to build

The service that pulls campaigns, adsets, ads, creatives, insights and leads from
the Meta Marketing API into the local database on a schedule, ported from
`focas-crm/backend/src/sync/*` and `scheduler.ts` into plain CommonJS JavaScript
under `backend/modules/ads/services/`.

### The ESM bridge

`@santhosh785/meta-ads` is **ESM-only** — it declares `"type": "module"` and
exposes no CommonJS entry point, so `require()` will not work. Create a single
`metaClient.js` that reaches it through a cached dynamic `import()` and exposes
ordinary CommonJS functions to the rest of the module. Every other file in the ads
module must go through this bridge; no other file should contain a dynamic import.

The bridge also owns constructing the Meta client from `META_ACCESS_TOKEN`,
`META_AD_ACCOUNT_ID` and `META_API_VERSION`.

### Sync services

One file per resource, mirroring the source layout: campaigns, adsets, ads,
creatives, insights and leads, plus a `syncAll` that orchestrates them in
dependency order (campaigns before adsets before ads).

Each sync upserts into its model keyed on Meta's id, which is the `_id` — so an
upsert is a single operation with no lookup. Insights key on their compound natural
index rather than an id, so a re-sync of the same date range replaces rows instead
of duplicating them.

Every run records an `AdSyncRun` row: `running` on start, then `success` with a
record count or `error` with the message. A failed sync must never crash the
process — log it, record it, move on.

**Currency care:** `spend` from Meta is in major units (rupees) and is stored as
such; `dailyBudget` and `lifetimeBudget` are in minor units (paise). Preserve this
distinction exactly as the source does. Do not normalize them to a common unit.

### Scheduler

Port the interval scheduler. When `SYNC_INTERVAL_MINUTES` is set and positive, run
a full sync on that cadence; when unset or zero, log that auto-sync is disabled and
start nothing.

One deliberate change from the source: the CRM waits a full interval before its
first run, which leaves a fresh deploy up to a day stale. Run once shortly after
boot — delayed enough not to slow startup — and then on the interval.

### Server wiring

In `backend/server.js`, add the ads models to the existing `syncIndexes()` boot
chain, and start the ad scheduler alongside the existing call and task schedulers.
Follow the surrounding style exactly: the existing schedulers are started inside
the listen callback, and cache warmers are called outside the scheduler start so
they still run when polling is switched off.

## Acceptance criteria

- [ ] `metaClient.js` is the only file performing a dynamic import of the Meta
      package, and caches the resolved module
- [ ] Six resource sync services plus `syncAll` exist and upsert into the task-1
      models
- [ ] Re-running an insights sync over the same date range updates rows rather than
      creating duplicates
- [ ] `spend` is stored in rupees and budgets in paise, unchanged from the source
      behaviour
- [ ] Every sync run creates exactly one `AdSyncRun` row ending in `success` or
      `error`
- [ ] A sync failure logs, records an `error` run, and leaves the process alive
- [ ] The scheduler starts only when `SYNC_INTERVAL_MINUTES` is set and positive,
      and logs clearly when disabled
- [ ] A manual run against real credentials produces a `success` run with a
      non-zero record count, and campaign rows appear in the database
- [ ] Total spend for a known date range matches Meta Ads Manager for that range
- [ ] The server boots with all ads indexes built and all three schedulers started

## Boundary

This task owns the sync services, the scheduler and the `server.js` wiring. It does
**not** create HTTP routes — the admin sync-trigger endpoint is task 9. It does not
write the campaign resolver, the lead linker or the CPL cache — those are task 5.
It does not create or modify models.

## Commit convention

Your commit message MUST include `Closes #5` so the task's GitHub
issue closes when the commit lands on the default branch.
