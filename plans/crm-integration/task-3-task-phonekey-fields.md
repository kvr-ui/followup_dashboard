---
task: 3
name: task-phonekey-fields
parallel_group: 1
depends_on: []
issue: 4
---

# Task 3: Add phone-key and lead-link fields to Task

## What to build

The dashboard's `Task` model is keyed on the Bigin contact id and carries a raw,
unnormalized `phone` string with no index. Ad leads must be matched to Tasks by
phone as a fallback, and the follow-ups list must be able to show a lead's source
without any per-row lookup. This task adds the three stable fields that make both
possible, and populates them going forward.

### New fields on `backend/models/Task.js`

- `phoneKey` — String, indexed, sparse. The last 10 digits of the contact's phone
  number. This is the fallback join key between a Task and an ad lead.
- `leadSource` — String, one of `meta` | `web` | null. Denormalized so the
  follow-ups table can render a Source column without a lookup per row. It is
  stable — a lead's origin never changes — which is why it is safe to denormalize
  here, unlike cost.
- `linkedLeadId` — ObjectId, indexed, sparse. The `WebLead` or `MetaLead` this Task
  was matched to, or null.

### Phone normalization

The codebase already has a phone-key helper — the last-10-digit normalizer used for
call-to-deal matching in the calls module. **Reuse it. Do not write a second
implementation.** If it is not currently exported in a way this code can reach,
promote it to a shared location and update its existing callers to import from
there, keeping behaviour identical.

The rule it implements: strip non-digits, take the last 10 characters, and return
null if fewer than 10 digits remain.

### Populate on write

In the task-upsert path in `backend/services/taskStore.js`, derive and set
`phoneKey` from the contact's phone whenever a Task is created or merged. The
existing function already extracts the phone from the webhook payload's contact
object; normalize that same value.

Both the create path and the merge path must set it — a Task that existed before
this change and is later updated by a webhook should gain its `phoneKey` then,
without waiting for a backfill.

### Backfill script

Write `backend/scripts/backfillPhoneKeys.js` that walks existing Tasks, derives
`phoneKey` from the stored phone, and reports how many were updated and how many
had no usable phone. The calls module already contains a phone-key backfill script
— follow its structure, its logging style, and how it opens and closes its
database connection.

The script must be idempotent: running it twice changes nothing the second time.

## Acceptance criteria

- [ ] `Task` declares `phoneKey`, `leadSource` and `linkedLeadId` with the indexes
      described above
- [ ] Exactly one phone-normalization implementation exists in the backend; the
      calls module and this code both use it
- [ ] Creating a Task from a webhook payload with a phone sets `phoneKey` to its
      last 10 digits
- [ ] Merging a webhook into an existing Task that lacks `phoneKey` sets it
- [ ] A payload with no phone, or a phone with fewer than 10 digits, leaves
      `phoneKey` null rather than storing a partial value
- [ ] `node backend/scripts/backfillPhoneKeys.js` populates existing Tasks and
      prints updated / skipped counts
- [ ] Running the backfill a second time reports zero further updates
- [ ] The server boots and the existing task index build still succeeds

## Boundary

This task does **not** populate `leadSource` or `linkedLeadId` — it only declares
them. The matching logic that fills them is task 5, and the one-time backfill that
applies it to historical data is task 7. This task does not touch the ads module,
any route, or any frontend file.

## Commit convention

Your commit message MUST include `Closes #4` so the task's GitHub
issue closes when the commit lands on the default branch.
