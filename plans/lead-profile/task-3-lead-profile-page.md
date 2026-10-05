---
task: 3
name: lead-profile-page
parallel_group: 2
depends_on: [1, 2]
issue: 24
---

# Task 3: Lead profile page (replaces TaskDetail drawer)

## What to build

### Context

The dashboard is getting one page per lead, keyed by `phoneKey` (the last 10 digits of the phone). It shows everything known about that person in one place. Two earlier tasks are already done:

- **Task 1** built `GET /api/lead-profile/:phoneKey` (response shape below).
- **Task 2** added the hash route `#/lead/<phoneKey>`, an `openLead()` helper, a `useLeadRoute()` hook, and a placeholder `LeadProfile` component. Dashboard renders that component in `<main>` in place of the tab content. Every list already links to it.

This task replaces the placeholder with the real page and retires the `TaskDetail` drawer.

### API response (from task 1)

```
GET /api/lead-profile/:phoneKey        (authenticated; use the existing api() helper)
400 { success:false, message }  // phoneKey is not 10 digits
403 { success:false, message }  // sales rep owns no Task/Deal/Call on this lead
404 { success:false, message }  // nothing on that phoneKey
200 { success:true, zohoSync, data: {
  phoneKey,
  header:      { name, phone, leadSource, state, ownerName, ownerEmail },
               // state: 'won' | 'lost' | 'pipeline' | 'followup' | 'none'
  latestTask:  <same shape as GET /api/tasks/:id data, incl. acquisition + vsl> | null,
  olderTasks:  [<task, read-only>],
  webLeads:    [WebLead docs],
  metaLeads:   [MetaLead docs],
  deals:       [Deal docs, newest first],
  calls:       [Call docs, newest first],
  vsl:         <VSL block> | null,
  acquisition: <acquisition block; `cost` key present only for admins> | null,
  timeline:    [{ at, type, text, by }]   // newest first
               // type: 'form'|'task'|'status'|'note'|'whatsapp'|'call'|'deal'
}}
```

### Layout (approved by the user)

**Header:** lead name; phone as a `tel:` link plus the existing `CopyButton`; a lead-source badge; a state pill (won / lost / pipeline / followup / none); the owner's name; and a "← Back" control that leaves the route. Task 2 supplies the navigation helper.

**Left column: actions.** These controls act on the **latest Task only** (`latestTask.id`):
- Status change: `PATCH /api/tasks/:id/status`
- Add note: `POST /api/tasks/:id/notes`
- WhatsApp template send: `POST /api/tasks/:id/whatsapp`

Move this logic out of `TaskDetail` into a reusable `TaskActions` component. Keep the WATI template and parameter behaviour exactly as it is today. After any action succeeds, refetch the profile so the header and timeline update. If `latestTask` is null, leave out the actions column and let the main column take the full width.

**Main column,** in this order. A section renders only when it has data.
1. **Timeline:** `timeline[]` newest first. Show the time, a type label or icon, the text, and who did it (`by`).
2. **Deals & Installments:** the lead's deals with their installment details.
3. **Calls:** outcome, duration, and recording player or link. Reuse the pieces of `CallDetail` that already do this.
4. **VSL watch:** reuse the `vslStats` helpers and the markup of TaskDetail's VSL section.
5. **Form answers:** Web leads show their UTM and form fields; Meta leads show `fieldData`. Both render as key-value lists.
6. **Acquisition:** reuse TaskDetail's acquisition section. Show cost only when the `cost` key is present. The server already strips it for reps, so the client adds no role check.
7. **Older tasks:** collapsed by default and read-only (subject, status, dates). Their notes already appear in the timeline.

Use two columns on desktop that stack into one at phone width, with no horizontal scroll. Reuse the existing drawer-section styling (`drawer-section` and similar classes) for the section cards.

### States

- Show a loading state while fetching.
- **403:** show a friendly "Not your lead" message with a way back.
- **404:** show a friendly "No lead found for this number" message with a way back. Treat 400 the same way.
- Other errors show the server `message`.

### TaskDetail retirement

Split TaskDetail's reusable parts (the actions, the VSL section, the acquisition section, and helpers such as the rupee and value formatters) into their own components or modules, and use them in `LeadProfile`. Then delete `TaskDetail.jsx`. Remove the drawer state and the `<TaskDetail>` render from Dashboard. After this change, nothing in the codebase may import `TaskDetail`.

### Decisions (do not revisit)

- Only the latest Task can be edited. Older Tasks are read-only, and all notes are merged into the timeline.
- Sales reps see the full lead, including colleagues' calls and deals.
- Ad cost is admin-only. The server enforces this, so the client just renders whatever it receives.

### Boundaries

- No backend changes. The endpoint belongs to task 1 and its tests to task 4.
- Do not change routing or the list entry points (task 2 did those). The only exception is removing the TaskDetail drawer from Dashboard.
- `CallDetail` stays as the row-click drawer on Calls, Installments and Upsells. Extract parts of it for reuse, but do not remove it.

## Acceptance criteria

- [ ] When an admin opens `#/lead/<phoneKey>` for a lead with full data, the header and all 7 main sections render with real data, in the specified order.
- [ ] Sections with no data are not rendered, and no empty cards appear.
- [ ] A sales rep viewing the same lead sees no ad cost anywhere on the page.
- [ ] Adding a note, changing status and sending a WhatsApp template each succeed against `latestTask.id`. The profile then refetches, and the new entry appears at the top of the timeline.
- [ ] WhatsApp template choice and parameters behave the same as they did in the old drawer.
- [ ] A lead with no Task (for example, ad lead only) shows the page without the actions column.
- [ ] A 403 shows a friendly "Not your lead" message, and a 404 shows a friendly not-found message. Both offer a way back.
- [ ] "← Back" returns to the list the user came from.
- [ ] At phone width (about 375px) the columns stack and the page has no horizontal scroll.
- [ ] `TaskDetail.jsx` is deleted, and a grep for `TaskDetail` in `frontend/src` finds nothing.
- [ ] `npm run build` in `frontend/` passes. If a lint script or config exists, lint also passes.

## Commit convention

Your commit message MUST include `Closes #24` so the task's GitHub issue closes when the commit lands on the default branch.
