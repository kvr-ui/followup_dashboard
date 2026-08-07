---
task: 1
name: ads-models
parallel_group: 1
depends_on: []
issue: 2
---

# Task 1: Port the ads data models

## What to build

A new `backend/modules/ads/models/` directory holding the eight Mongoose models
that the retired `focas-crm` service used, rewritten from ESM TypeScript into plain
CommonJS JavaScript on mongoose 8.5, matching the conventions of the existing
`backend/modules/calls/models/`.

The source of truth for the schema shapes is `focas-crm/backend/src/models.ts`.
Port the shapes faithfully — this task is a translation, not a redesign.

Models to create:

- `MetaCampaign` — name, objective, status, effectiveStatus, dailyBudget,
  lifetimeBudget, createdTime, updatedTime
- `MetaAdset` — name, campaignId, status, effectiveStatus, dailyBudget,
  lifetimeBudget, optimizationGoal, billingEvent, startTime, endTime
- `MetaAd` — name, adsetId, campaignId, status, effectiveStatus, creativeId
- `MetaCreative` — name, title, body, imageUrl, videoId, callToActionType,
  linkUrl, urlTags
- `MetaInsight` — level, entityId, dateStart, dateStop, campaignId, adsetId, adId,
  spend, impressions, reach, clicks, ctr, cpc, cpm, frequency, actions, roas
- `MetaLead` — createdTime, adId, formId, campaignId, fieldData
- `WebLead` — the lead capture record (see below)
- `AdSyncRun` — resource, status, recordsUpserted, error, startedAt, finishedAt

### Rules that must not be varied

- **The five Meta entities** (`MetaCampaign`, `MetaAdset`, `MetaAd`,
  `MetaCreative`, `MetaLead`) use Meta's own string id as `_id`, declared as
  `_id: { type: String }`. This is deliberate: it makes the data migration a
  straight copy and keeps every cross-reference valid. Do not switch to ObjectId.
- `MetaInsight` and `AdSyncRun` use ordinary generated ObjectIds.
- Every schema gets the shared JSON transform that exposes a virtual `id` and
  deletes `_id` and `__v`, ported from `applyJsonTransform` in the source file.
- The Meta mirror schemas track only an updated-style `syncedAt` timestamp
  (`timestamps: { createdAt: false, updatedAt: 'syncedAt' }`), not the usual pair.
- Reuse the existing-model guard pattern so repeated requires don't attempt to
  recompile a model.
- The model formerly called `SyncRun` is named **`AdSyncRun`** here, so it does not
  collide with the dashboard's existing `SyncState` job-cursor model.

### Indexes

Port every index from the source, including the compound unique index on
`MetaInsight` over `{ level, entityId, dateStart, dateStop }` — re-syncs depend on
it to replace rather than duplicate rows.

### New fields on WebLead

Beyond the ported fields (name, firstName, lastName, email, phone, caStatus,
attempt, language, city, state, utmSource, utmMedium, utmCampaign, utmContent,
utmTerm, landingUrl, referrer, biginContactId, source, createdAt), add four fields
that later tasks populate:

- `phoneKey` — String, indexed. Last-10 digits of the phone number.
- `resolvedCampaignId` — String, indexed. The `MetaCampaign._id` this lead's UTM
  resolved to, or null.
- `resolvedBy` — String, one of `exact` | `normalized` | `id` | null. Records how
  the campaign was resolved so a questionable number is traceable.
- `linkedTaskId` — ObjectId, indexed. The matched Task, or null.

Add the same `phoneKey` field to `MetaLead`, since Meta form leads are matched by
phone extracted from their `fieldData`.

Populating these fields is **not** this task's job — task 5 writes the resolvers
and task 7 backfills. This task only declares them.

## Acceptance criteria

- [ ] Eight model files exist under `backend/modules/ads/models/`, each exporting a
      single compiled Mongoose model
- [ ] The five Meta entity models declare `_id` as a String
- [ ] `MetaInsight` carries the compound unique index over level, entityId,
      dateStart and dateStop
- [ ] `WebLead` declares `phoneKey`, `resolvedCampaignId`, `resolvedBy` and
      `linkedTaskId`; `MetaLead` declares `phoneKey`
- [ ] Every model's `toJSON` exposes `id` and omits `_id` and `__v`
- [ ] The sync-run model is named `AdSyncRun` and does not shadow `SyncState`
- [ ] `node -e "require('./backend/modules/ads/models/MetaInsight')"` succeeds for
      each model with no connection open
- [ ] Requiring every model twice in one process does not throw an
      OverwriteModelError

## Boundary

This task creates model files only. It does **not** touch `backend/server.js`,
`backend/app.js`, any sync service, any route, or the existing `Task` model —
those belong to tasks 3, 4, 6 and 9.

## Commit convention

Your commit message MUST include `Closes #2` so the task's GitHub
issue closes when the commit lands on the default branch.
