# Plan: lead-profile

## Goal

One page per lead, keyed by phone number, that shows everything the dashboard knows about that person: follow-up tasks, notes, status history, WhatsApp sends, calls, deals and installments, VSL watch time, form answers, and acquisition. Clicking a lead in any tab opens it. Today the same person's data is split across Follow-ups, Calls, Installments, Upsells, Ad Leads and VSL Tracking.

## Approach

- **Backend:** a new authenticated endpoint, `GET /api/lead-profile/:phoneKey`. It gathers every Task, WebLead, MetaLead, Deal and Call that shares the `phoneKey` (last 10 digits, already on every collection and indexed), plus the VSL block. It returns one payload, including a merged, date-sorted timeline.
- **Frontend:** a full page at hash route `#/lead/<phoneKey>`, rendered inside Dashboard in place of the tab content. It replaces the TaskDetail drawer. Actions (status, note, WhatsApp) act on the latest Task through the existing task endpoints.

### API contract (shared by tasks 1, 3 and 4)

```
GET /api/lead-profile/:phoneKey        (authenticate)
400 { success:false, message } — phoneKey is not 10 digits
404 { success:false, message } — nothing on that phoneKey
403 { success:false, message } — sales rep owns no Task/Deal/Call on it
200 { success:true, zohoSync, data: {
  phoneKey,
  header:  { name, phone, leadSource, state, ownerName, ownerEmail },
           // state: 'won'|'lost'|'pipeline'|'followup'|'none'
  latestTask:  <same shape as GET /api/tasks/:id data, incl. acquisition + vsl> | null,
  olderTasks:  [<serialize() shape, read-only>],
  webLeads:    [WebLead docs],
  metaLeads:   [MetaLead docs],
  deals:       [Deal docs, newest first],
  calls:       [Call docs, newest first],
  vsl:         <buildVslBlock result> | null,
  acquisition: <buildAcquisition result; cost key only for admins> | null,
  timeline:    [{ at, type, text, by }]   // newest first
               // type: 'form'|'task'|'status'|'note'|'whatsapp'|'call'|'deal'
}}
```

## Decisions & Rejected Alternatives

- **Identity is `phoneKey` (last 10 digits).** The user confirmed phones are unique per person, so everything with the same 10 digits belongs to one lead. Rejected: keying on Task id (that splits one person across tasks and form fills).
- **A full page, not a drawer.** The user chose a page they can bookmark. Rejected: extending the existing TaskDetail drawer, which was recommended as less work and familiar to the team.
- **Hash route `#/lead/<phoneKey>`.** Refresh, sharing and Back all work with no new dependency and no server change. Rejected: react-router with `/lead/:phone`, which needs a new library and an SPA fallback on the server.
- **Opened from all six lists.** Follow-ups, Ad Leads and VSL row clicks now open the page. Calls, Installments and Upsells get a clickable name/phone link, and their row click (CallDetail) is unchanged.
- **Only the latest Task is editable.** Status, notes and WhatsApp act on the newest Task. Older Tasks are read-only, and all notes are merged into the timeline. Rejected: one editable card per Task, which is more error-prone for reps.
- **Sales reps see the full lead, including colleagues' calls and deals.** A rep calling someone needs to know a colleague already spoke to them. Ad cost stays admin-only, and the key is never written for reps. Rejected: filtering to the rep's own records.
- **Access guard (added during planning).** A rep may open a profile only if they own at least one Task, Deal or Call on that phoneKey. Without this, typing any number into the URL would expose a stranger's data, and today reps have no access to ad lead data.
- **Endpoint path `/api/lead-profile`.** `/api/leads/web` is already mounted (before cors) for unauthenticated lead ingest, so reusing `/api/leads/:x` would collide.

## Tasks

| # | Task | Phase | Depends on | Status |
|---|------|-------|------------|--------|
| 1 | Lead profile API endpoint | 1 | — | pending |
| 2 | Hash route and lead links in every list | 1 | — | pending |
| 3 | Lead profile page (replaces TaskDetail drawer) | 2 | 1, 2 | pending |
| 4 | Tests for the lead profile endpoint | 2 | 1 | pending |

## Execution phases

- **Phase 1 (parallel):** task-1, task-2
- **Phase 2 (parallel):** task-3, task-4
