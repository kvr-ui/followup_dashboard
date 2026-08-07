---
task: 5
name: attribution-resolvers
parallel_group: 2
depends_on: [1, 3]
issue: 6
---

# Task 5: Build the attribution resolvers and CPL cache

## What to build

Three services under `backend/modules/ads/services/` that turn raw ad-lead records
into answerable questions: which campaign did this lead come from, which Task is
this lead, and what did that campaign's leads cost.

### Campaign resolver

A web lead's only campaign signal is the free-text `utmCampaign` string. The
retired CRM matched it against campaign *names* by exact string equality, which
silently produced a blank cost whenever tagging drifted. This resolver tries harder
and — critically — **records how it succeeded** so a questionable number can be
traced later.

Given a UTM campaign string, attempt in order:

1. The string is all digits and matches a `MetaCampaign` id → resolved by `id`
2. Exact match against a campaign name → resolved by `exact`
3. Normalized match — lowercase both sides and strip every non-alphanumeric
   character — → resolved by `normalized`
4. Otherwise unresolved

Return both the campaign id and the method. A null result is a legitimate outcome
that callers must handle, not an error.

### Lead linker

Given an ad lead, find its Task:

1. If the lead carries a Bigin contact id, match it against the Task whose webhook
   payload holds that contact id. This is exact and is always preferred.
2. Otherwise match on `phoneKey`.

For a Meta form lead the phone is not a top-level field — it must be extracted from
the lead's `fieldData`, an array of name/value entries whose field naming varies by
form. Handle the common phone field-name variants and normalize the result with the
shared phone-key helper (the same one task 3 established — reuse it, do not write
another).

The linker must also work in reverse: given a newly-created Task, find an existing
unlinked ad lead for it. Both directions write the same three fields —
`WebLead.linkedTaskId`, `Task.linkedLeadId` and `Task.leadSource`.

Matching must be conservative. When two leads could match one Task, prefer the
Bigin-id match; if still ambiguous, prefer the most recently captured lead and do
not silently merge the others.

### CPL cache

An in-memory table keyed by campaign and calendar month, holding that campaign's
spend and lead count for the month, used to compute a lead's estimated cost without
an aggregation on every read.

Build it by aggregating `MetaInsight` rows at campaign level, grouped by campaign
and by the month of the row's start date. Spend is summed directly. Leads are
summed from the `actions` array, counting only Meta's own `lead` action type —
this is deliberately Meta's deduplicated figure so the numbers reconcile with Ads
Manager. Port this action-counting logic and its action-type set from the CRM's
insights library.

Expose a lookup that takes a campaign id and a month and returns spend, lead count
and the derived cost per lead, or null when there is no data or the lead count is
zero. Never divide by zero and never return `Infinity`.

Provide a rebuild function for task 4's sync to call after a successful run, and a
warm function for boot. Follow the existing cache-warming pattern in the codebase —
the dashboard already warms two caches at startup and logs a warning rather than
failing when a warm fails.

## Acceptance criteria

- [ ] The resolver returns both a campaign id and the method used, and handles all
      four outcomes including the unresolved case
- [ ] A UTM string differing from a campaign name only in case, spacing or
      punctuation resolves as `normalized`
- [ ] The linker prefers a Bigin contact id match over a phone match
- [ ] A Meta lead's phone is correctly extracted from `fieldData` across the common
      field-name variants
- [ ] Linking writes `WebLead.linkedTaskId`, `Task.linkedLeadId` and
      `Task.leadSource` consistently in both directions
- [ ] The reverse direction works: creating a Task that matches a previously
      unlinked lead links them
- [ ] The CPL cache returns null — never `Infinity` or `NaN` — for a campaign-month
      with spend but zero leads
- [ ] The lead count uses only Meta's `lead` action type, not a sum of every action
- [ ] A hand-checked campaign-month's spend and lead count match Ads Manager for
      that month
- [ ] Rebuilding the cache twice produces identical results
- [ ] Exactly one phone-normalization implementation exists in the backend

## Boundary

This task writes services only. It does **not** expose any HTTP route — the API
that consumes these is task 8 (lead detail) and task 9 (admin reporting). It does
**not** run the one-time backfill over historical data; that is task 7, which calls
into these services. It does not modify `Task.js` or `taskStore.js` (task 3) or any
sync service (task 4).

## Commit convention

Your commit message MUST include `Closes #6` so the task's GitHub
issue closes when the commit lands on the default branch.
