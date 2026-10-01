---
task: 1
name: lead-profile-api
parallel_group: 1
depends_on: []
issue: 22
---

# Task 1: Lead profile API endpoint

## What to build

Build a new authenticated endpoint that returns everything the dashboard knows about one lead in a single payload. The lead is identified by phone number. Today the same person's data is spread across the Follow-ups, Calls, Installments, Upsells, Ad Leads and VSL Tracking tabs. A later task (task 3) builds a full-page lead profile on top of this endpoint.

### Background

- The backend is Express + Mongoose, in `backend/`. Newer features live under `backend/modules/<name>/` (see `modules/ads`, `modules/calls`, `modules/vsl`), and routes are mounted in `backend/app.js`.
- Every collection with per-lead data carries a normalized, indexed phone key: the **last 10 digits** of the phone number. The fields are `Task.phoneKey`, `WebLead.phoneKey`, `MetaLead.phoneKey`, `Deal.contactPhoneKey` and `Call.phoneKey`. The phone util in `backend/utils/phone` provides `key10`. Records that share the same 10 digits belong to the same lead; the user confirmed phones are unique per person.
- VSL watch time is stored on a second Mongo cluster. Fetch it with the existing `buildVslBlock` helper from the vsl module. Do not query that cluster directly.

### The endpoint

Create a new backend module, for example `backend/modules/leads/`, that exposes `GET /api/lead-profile/:phoneKey` behind the existing `authenticate` middleware. Mount it in `app.js` with the other authenticated routes, **after** `cors`.

The path must be `/api/lead-profile`, **not** `/api/leads/...`. `/api/leads/web` is already mounted before cors for unauthenticated lead ingest, and a route under `/api/leads/` would collide with it. Leave that ingest route and its unauthenticated status exactly as they are. That is a deliberate choice, so do not add a token to it.

### API contract (shared with tasks 3 and 4; implement exactly)

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

`zohoSync` has the same meaning as on `GET /api/tasks/:id`: whether Zoho is configured.

### Reuse existing code; do not duplicate it

- **Task serialization:** the task controller already has `serialize` (the list/row shape) and `serializeDetail` (the `GET /api/tasks/:id` shape, which uses `detailFor` to attach `acquisition` and `vsl`). Export both from the task controller. Use `serializeDetail(latestTask, user)` for `latestTask` and `serialize` for each entry in `olderTasks`. "Latest" means the newest Task on the phoneKey. Older Tasks are read-only in the UI.
- **Acquisition:** use the existing `buildAcquisition` from the ads module with `includeCost: true` **only** when `user.role === 'admin'`. For sales reps the `cost` key must never be written into the response at all. Hiding it on the frontend is not enough.
- **VSL:** use the existing `buildVslBlock`.
- **Lead state:** the won/lost/pipeline/followup/none derivation lives inside the `GET /api/ads/leads` route today (the `leadStatus` function in the ads routes file). The rule: a deal's normalized `outcome` answers first (won, lost, otherwise pipeline). With no deal, a task means followup. With neither, the state is none. Move this logic into a shared helper in the ads module's services, used by both `GET /api/ads/leads` and the new endpoint. The ads route must return exactly the same values after the move. Read `deal.outcome` as stored and do not re-derive it from the stage string. When a lead has several deals, the newest deal decides the header state.

### Fault tolerance

Fetch every data source in parallel (`Promise.all`): Tasks, WebLeads, MetaLeads, Deals, Calls, VSL and acquisition. Give each fetch its own `.catch` that logs the error and falls back to `null` or `[]`. A failing source then costs only its own section, not the whole response. `detailFor` in the task controller already works this way, so follow the same pattern. Return 404 only when every source came back empty. A source that failed is not the same as a source that returned nothing.

### Access rules

- **Admins** can always open a profile.
- **Sales reps** can open one only if they own at least one record on that phoneKey:
  - a Task: decide ownership with the existing `taskOwnerEmails` / `ownerEmailOf` helpers in `backend/utils/owner`, the same way the tasks list does;
  - a Deal or a Call: compare its `ownerEmail` with the rep's email, case-insensitively.
  
  If they own nothing on the phoneKey, return 403.
- Once a rep is allowed in, they see **everything** on the lead, including colleagues' calls and deals. This is deliberate: a rep calling someone needs to know a colleague already spoke to them. The only thing reps never get is ad cost (see Acquisition above).
- Run the checks in this order: 400 (bad phoneKey), then 404 (no data), then 403 (rep owns nothing).

### Header

`header` summarizes the lead:
- `name`, `phone` and `leadSource`: take them from the best available source, in this order: latest Task, then newest form fill (web or meta), then newest Deal, then newest Call.
- `state`: from the shared state helper.
- `ownerName` and `ownerEmail`: from the latest Task's owner, falling back to the newest Deal's owner.

### Timeline

Merge these events into one array of `{ at, type, text, by }`, sorted **newest first**:
- `form`: each WebLead and MetaLead form fill
- `task`: each Task's creation
- `status`: each entry in a Task's `statusHistory`
- `note`: each Task note
- `whatsapp`: each entry in a Task's `whatsappLog`
- `call`: each Call
- `deal`: each Deal's stage or outcome

`by` is the person who did it, when known, and `null` otherwise. Skip entries with no valid date rather than letting them corrupt the sort.

### Export for tests

Export a `buildLeadProfile(phoneKey, user)` function from the module's service. It should do all of the assembly and access work and return something the route can translate into a status code and body, either `{ status, body }` or a thrown error that carries a status. Keep the route handler a thin wrapper around it. Task 4 writes the tests against this function, so it must be usable without an HTTP server.

### Out of scope

- No frontend work. The hash route and list links are task 2, and the profile page is task 3.
- No test suite. That is task 4, but it depends on the `buildLeadProfile` export above.
- The existing task mutation endpoints (status, notes, whatsapp) do not change. The profile page reuses them against `latestTask`.

## Acceptance criteria

- [ ] `GET /api/lead-profile/:phoneKey` exists, requires authentication, and is mounted after cors. `/api/leads/web` is unchanged and still unauthenticated.
- [ ] A phoneKey that is not exactly 10 digits returns 400 `{ success:false, message }`.
- [ ] A valid phoneKey with no Task, WebLead, MetaLead, Deal or Call returns 404 `{ success:false, message }`.
- [ ] A sales rep who owns no Task, Deal or Call on the phoneKey gets 403 `{ success:false, message }`. The Deal and Call owner check ignores case.
- [ ] An admin gets 200 with the full contract shape above, including `zohoSync`.
- [ ] A rep who owns one Task on the phoneKey gets 200 and also sees Calls and Deals owned by colleagues on the same phoneKey.
- [ ] For a rep, the response contains no `cost` key anywhere: not in `data.acquisition`, and not in `data.latestTask.acquisition`. For an admin, `cost` is present when it is available.
- [ ] `latestTask` matches the shape of `GET /api/tasks/:id` data, including `acquisition` and `vsl`, and comes from the exported `serializeDetail`. `olderTasks` use the exported `serialize`.
- [ ] `deals`, `calls` and `timeline` are sorted newest first. The timeline includes form, task, status, note, whatsapp, call and deal events where the data exists.
- [ ] If one source throws (for example, the VSL cluster is down), the endpoint still returns 200 and only that section is `null` or `[]`.
- [ ] The won/lost/pipeline/followup/none derivation lives in one shared helper. `GET /api/ads/leads` uses it and returns the same `state` values as before the move, and `header.state` uses it too.
- [ ] `buildLeadProfile(phoneKey, user)` is exported and can be called without an HTTP server.
- [ ] The task status, notes and whatsapp endpoints behave as before.
- [ ] The backend starts cleanly with `npm start`. The backend has no automated test suite yet, but if one exists by the time this task runs, it still passes. Existing endpoints (`/api/tasks`, `/api/tasks/:id`, `/api/ads/leads`) respond as before.

## Commit convention

Your commit message MUST include `Closes #22` so the task's GitHub issue closes when the commit lands on the default branch.
