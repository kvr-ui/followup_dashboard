---
task: 9
name: ads-admin-api
parallel_group: 3
depends_on: [4, 5]
issue: 10
---

# Task 9: Build the admin ads reporting API

## What to build

The endpoints behind the Marketing and Ad Leads tabs, in
`backend/modules/ads/routes/ads.js`. Every route requires a valid JWT **and** the
admin role — reps have no access to any of it. Follow the gating pattern the
analytics and users routes already use.

### Endpoints

- **Summary** — headline totals for a date range: spend, leads, cost per lead,
  impressions, clicks, click-through rate. Scope the aggregation to campaign-level
  insight rows so account-level rows do not double-count the totals; this is a
  correctness trap the retired CRM had to handle explicitly.
- **Campaign performance** — per campaign over a date range: spend, impressions,
  clicks, click-through rate, cost per click, leads, cost per lead. Leads come from
  Meta's `lead` action type only, consistent with the CPL cache.
- **Insights** — the underlying rows, filterable by date range, level and campaign,
  for drill-down.
- **Ad leads** — web and Meta leads with their resolved campaign, whether they
  linked to a Task, and which Task. Must support filtering to unlinked leads and to
  leads whose UTM resolved to nothing, since both lists are directly actionable.
- **Sync history** — recent `AdSyncRun` rows.
- **Trigger sync** — starts a full sync on demand. Returns promptly rather than
  blocking until the sync finishes, and refuses to start a second run while one is
  already in flight.

### Reconciliation

Include a comparison of Meta's account-level spend total against the sum of
campaign-level spend for the same range. The retired CRM had this and it earns its
place: a gap means either spend not tied to a campaign, or a sync problem. Return
both figures and their difference and let the UI explain it.

### Currency

Insight spend is in rupees; campaign budgets are in paise. Return them as stored
and let the frontend format each correctly. Do not normalize them here — silently
converting one is how a figure ends up wrong by a factor of a hundred.

### Date ranges

Accept an explicit from/to range. Where a caller omits it, default to the last 30
days. Dates are calendar dates in the server's local timezone, which the container
runs in IST — a range computed in UTC shifts the day boundary and makes "this
month" start a day early.

## Acceptance criteria

- [ ] Every route rejects a request with no JWT, and rejects a valid sales-role JWT
- [ ] Summary totals use campaign-level rows only and do not double-count
- [ ] Campaign performance returns spend, impressions, clicks, CTR, CPC, leads and
      CPL per campaign
- [ ] Lead counts use Meta's `lead` action type only
- [ ] Ad leads can be filtered to unlinked leads and to unresolved-campaign leads
- [ ] Triggering a sync returns promptly and creates an `AdSyncRun` row
- [ ] Triggering a second sync while one is running is refused with a clear message
- [ ] Reconciliation returns account total, campaign total and the difference
- [ ] Spend and budget values are returned in their stored units, unconverted
- [ ] An omitted date range defaults to the last 30 days, computed in local time
- [ ] Summary spend for a known range matches Meta Ads Manager for that range

## Boundary

This task is backend only and owns just its route file plus its mounting. It does
**not** build any UI — Marketing and Ad Leads tabs are task 12. It does not write
sync services (task 4), resolvers or the CPL cache (task 5), and it does not touch
the lead detail endpoint (task 8).

## Commit convention

Your commit message MUST include `Closes #10` so the task's GitHub
issue closes when the commit lands on the default branch.
