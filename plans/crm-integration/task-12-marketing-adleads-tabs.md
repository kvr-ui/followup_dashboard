---
task: 12
name: marketing-adleads-tabs
parallel_group: 4
depends_on: [9]
issue: 13
---

# Task 12: Build the Marketing and Ad Leads tabs

## What to build

Two new admin-only tabs that replace the ad reporting lost when `focas-crm` is
retired, plus the shared calculation helpers behind them.

Both tabs are built in one task because both register themselves in the same
Dashboard navigation file, and splitting them would put two parallel agents in
conflict over it.

### Marketing tab

An admin-only screen containing:

- **KPI row** — spend, leads, cost per lead, click-through rate for the selected
  date range. Reuse the existing summary-card component if its shape fits rather
  than building a second one.
- **Campaign performance table** — sortable, one row per campaign: spend,
  impressions, clicks, CTR, CPC, leads, CPL.
- **UTM breakdown** — leads grouped by source/medium, and by campaign with spend
  and CPL where the campaign resolved.
- **Spend reconciliation** — Meta's account total against the sum of campaigns,
  with the difference. Carry over the explanation the retired CRM showed: small
  gaps are normal because Meta's figures settle for 24–48 hours, and spend not tied
  to a campaign appears only in the account total.
- **Sync controls** — a "Sync now" button and recent sync history with status and
  record counts.
- **A date range selector** with presets (last 7 days, last 30 days, this month),
  defaulting to last 30 days.

**No charting library.** The frontend has zero dependencies beyond React and stays
that way; tables carry the same information as a spend time-series. Do not add
Recharts or any alternative.

### Ad Leads tab

An admin-only list of every captured web and Meta lead: contact details, capture
time, source, UTM tags, resolved campaign, and whether it linked to a follow-up
task — with a way to open the linked task.

Must support filtering to **unlinked leads** and to leads whose **UTM resolved to
nothing**. Both lists are directly actionable: the first is leads nobody is working,
the second tells you which ad URLs are tagged wrong.

### Shared helpers

Put the aggregation and formatting logic in `frontend/src/adStats.js`, alongside the
existing `taskStats.js`. Port the totals and per-campaign roll-up logic from the
retired CRM's insights library, including counting leads from Meta's `lead` action
type only.

**Currency:** spend is in rupees, campaign budgets are in paise. The retired CRM had
two distinct formatters for exactly this reason. Port both and use each in the right
place — collapsing them makes a figure wrong by a factor of a hundred.

Format rupees with Indian digit grouping.

### Navigation

Register both tabs in `frontend/src/components/Dashboard.jsx`, added to the admin
role's allowed views only. The file already computes an allowed-views array per role
and redirects when a stored view is no longer permitted — follow that exactly, so a
rep with a stale stored tab is redirected rather than shown an empty screen.

### Styling

Match the dashboard's existing visual language — muted palette, CSS custom
properties, the established card and table conventions. Append one clearly-commented
block at the end of `frontend/src/styles.css` using an `.mkt-` class prefix. **Do
not edit any existing rule** — tasks 10 and 11 are appending their own blocks to the
same file in parallel.

## Acceptance criteria

- [ ] Marketing and Ad Leads tabs appear for admins and are absent for sales users
- [ ] A sales user with a stored Marketing view is redirected to follow-ups rather
      than shown an empty screen
- [ ] The KPI row shows spend, leads, CPL and CTR for the selected range
- [ ] The campaign table sorts by each of its numeric columns
- [ ] The UTM breakdown groups by source/medium and by campaign
- [ ] Reconciliation shows account total, campaign total and difference, with the
      settling-period explanation
- [ ] "Sync now" triggers a sync and the history updates with its result
- [ ] The date selector offers the three presets and defaults to last 30 days
- [ ] Ad Leads lists both lead types and can filter to unlinked and to
      unresolved-campaign leads
- [ ] A linked lead can be opened to its follow-up task
- [ ] Spend renders in rupees and budgets in paise, each with the correct formatter
- [ ] Rupee values use Indian digit grouping
- [ ] `frontend/package.json` gains no new dependency
- [ ] All new CSS is one appended block using the `.mkt-` prefix, with no existing
      rule modified
- [ ] Marketing spend totals reconcile with Meta Ads Manager for the same range

## Boundary

This task owns the two new components, `adStats.js`, the Dashboard navigation
change, and its CSS block. It does **not** touch the lead detail drawer (task 10) or
the task table and filters (task 11). It adds no backend change — task 9's endpoints
already exist.

## Commit convention

Your commit message MUST include `Closes #13` so the task's GitHub
issue closes when the commit lands on the default branch.
