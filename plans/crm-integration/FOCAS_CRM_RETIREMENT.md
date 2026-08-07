# focas-crm is retired

**This copy lives in `Followup_dashboard/plans/crm-integration/FOCAS_CRM_RETIREMENT.md`
because it was written from that repository. It needs to be copied into THIS
repository** (`focas-crm`) — as the new `README.md`, or as a `RETIRED.md` linked
from the top of the existing one — **so that someone who finds this repo later
sees it immediately.** See `Followup_dashboard/plans/crm-integration/CUTOVER.md`
step 4.5 for that instruction. Nothing in the `focas-crm` repo itself was modified
to produce this file.

---

## Status: retired

This service — Meta Ads sync, UTM lead capture (`crm.focasedu.online`), and the
Atlas database behind it — has been folded into `Followup_dashboard` and shut
down. Do not deploy, restart, or point anything at this service again. If you are
looking for any of the following, it now lives in `Followup_dashboard`:

| What | Where it is now |
|---|---|
| Public lead capture (the landing pages' UTM/counseling-form POST) | `Followup_dashboard` — `POST /api/leads/web` (`backend/modules/ads/routes/webLeads.js`) |
| Meta Ads sync (campaigns/adsets/ads/creatives/insights/instant-form leads) | `Followup_dashboard` — `backend/modules/ads/services/` (`syncAll.js`, `metaClient.js`, `scheduler.js`) |
| Meta credentials (`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, etc.) | `Followup_dashboard`'s environment (`backend/.env`) — this service's `.env` no longer matters |
| Ad reporting / campaign spend & CPL | `Followup_dashboard`'s admin "Marketing" and "Ad Leads" tabs |
| This service's historical data (all Meta mirror collections + captured web leads) | Migrated wholesale into `Followup_dashboard`'s MongoDB — see below |

## What replaced it, and why

`Followup_dashboard` is a lead-followup dashboard that already held everything
that happens *after* a lead is captured (Bigin tasks, calls, transcripts, grades,
deals). This service held everything about *where a lead came from* (UTM tags, the
Meta campaign, what it cost) — but in a separate database, so nobody looking at a
lead in the dashboard could see how it was acquired. The fix was to move this
service's data and responsibilities into the dashboard rather than keep
integrating two databases indefinitely. Full rationale, including the specific
alternatives considered and rejected, is in `Followup_dashboard`'s
`plans/crm-integration/main-plan.md`.

## Where the data went

Every collection this service wrote to its Atlas database (`meta`) was migrated —
not resampled, not summarized, all of it — into `Followup_dashboard`'s own MongoDB,
under the same names except one rename (`syncruns` → `adsyncruns`). Meta's own
entity ids (`_id` on campaigns/adsets/ads/creatives) were preserved exactly, so
every cross-reference in the original data still resolves after the move.

The full procedure, with verification queries and the counts from the actual run,
is `Followup_dashboard`'s `plans/crm-integration/MIGRATION.md`. The counts that
moved (2026-08-07): 27 campaigns, 48 ad sets, 179 ads, 1445 creatives, 265 daily
insight rows, 0 Meta instant-form leads, 159 web leads, 81 sync-run records — all
verified count-for-count against the dump, with zero dangling cross-references.

**A final archival dump of this service's Atlas database was taken as part of
retirement**, independent of the migration dump above (which was taken while this
service was still running). Its location:

> _(operator: fill in after running `CUTOVER.md` step 4 — path/bucket/storage
> system and the date it was taken)_

## Live traffic cutover

The public lead-capture endpoint (`crm.focasedu.online/api/leads/web`) was the
last thing still pointed at this service, since it's the one piece that can drop a
real, unrecoverable lead if moved carelessly. It was cut over last, behind a
multi-day dual-running window where this service stayed up (idle) purely as a
rollback target while daily lead counts were compared against
`Followup_dashboard`. Full runbook: `Followup_dashboard`'s
`plans/crm-integration/CUTOVER.md`.

- Repointed on: _(operator: fill in)_
- Dual-running / verification window: _(operator: fill in)_
- Containers stopped, nginx vhost removed on: _(operator: fill in)_

## If you're debugging something old

- A lead captured before the cutover: it's in `Followup_dashboard`'s `webleads`
  collection now, same `_id` it always had.
- A campaign/adset/ad/creative/insight row: same, in the correspondingly-named
  collection, same `_id`.
- This service's git history and code are untouched and still readable here for
  archaeology — the CommonJS port that replaced it
  (`Followup_dashboard/backend/modules/ads/`) is a rewrite of this service's
  `backend/src/`, not a copy, so behavior should match but line-for-line diffs
  won't.
