---
task: 8
name: acquisition-api
parallel_group: 3
depends_on: [5]
issue: 9
---

# Task 8: Expose acquisition data on the lead detail API

## What to build

The lead-detail endpoint gains an `acquisition` object describing where the lead
came from and — for admins only — what it cost. This is the data behind the feature
that was actually asked for.

### Shape

Add `acquisition` to the single-task detail response in
`backend/controllers/taskController.js`, containing:

- **Source** — whether this lead came from a Meta form or a web form, and the form
  label the capture recorded
- **Captured at** — when the lead was first captured, which is often earlier than
  the Task's own creation
- **Campaign** — the resolved campaign's id and name, plus **how** it resolved.
  Exposing the resolution method matters: a campaign matched by normalized string
  is a weaker claim than one matched by id, and the UI needs to be able to say so.
- **UTM set** — source, medium, campaign, content, term
- **Landing URL and referrer**
- **Qualification answers** — CA status, attempt, language, city, state. The
  dashboard has never had these, and they are immediately useful on a call.
- **Cost** — the estimated figure, plus the campaign spend, lead count and month
  that produced it

When a Task has no linked ad lead, `acquisition` is **null** — not an object of
nulls. The UI renders nothing at all in that case rather than a grid of dashes.

### Cost visibility

The cost sub-object is present only for admins. For a user whose role is sales it
must be **omitted from the response entirely** — not blanked, not zeroed, not left
for the frontend to hide. Ad spend must not be inferable from a rep's session.

Enforce this server-side in the controller, matching how the analytics endpoint is
already admin-gated. Reps keep full access to source, campaign, UTMs, landing page
and qualification answers, all of which help them sell.

The existing role-scoping — a rep may only fetch their own leads at all — is
unchanged and must keep working.

### Cost computation

Read from task 5's CPL cache rather than aggregating per request. The lookup is by
the lead's campaign and the calendar month it was captured in. Return null when
there is no campaign, no insight data, or a zero lead count.

The response carries the inputs alongside the result — spend, lead count, month —
so the UI can show the division that produced the number. This figure is an
apportionment of campaign spend, not a per-person cost Meta reports, and the
interface must never let it read as exact.

### Performance

The detail endpoint must not become materially slower. The link is already stored
on the Task, so resolving the lead is a single indexed lookup and the cost comes
from memory. Do not add an aggregation to this path.

The tasks **list** endpoint is out of scope here beyond one thing: it must return
the denormalized `leadSource` already on each Task, so task 11 can render a Source
column with no extra queries.

## Acceptance criteria

- [ ] The detail response includes `acquisition` with source, form label, captured
      time, campaign with resolution method, UTM set, landing URL, referrer and
      qualification answers
- [ ] A Task with no linked ad lead returns `acquisition` as null
- [ ] An admin response includes cost with its spend, lead count and month
- [ ] A sales response contains **no** cost fields anywhere — verifiable by
      searching the raw response body
- [ ] A rep still cannot fetch a lead they do not own
- [ ] A lead whose campaign has no insight data, or a zero lead count, returns a
      null cost rather than an error or infinity
- [ ] The list endpoint returns `leadSource` per task
- [ ] Detail endpoint latency is not materially worse than before the change

## Boundary

This task is backend only. It does **not** render anything — the Acquisition panel
is task 10 and the Source column is task 11. It does not build the admin reporting
API (task 9), and it does not write the resolvers or CPL cache (task 5).

## Commit convention

Your commit message MUST include `Closes #9` so the task's GitHub
issue closes when the commit lands on the default branch.
