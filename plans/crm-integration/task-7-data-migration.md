---
task: 7
name: data-migration
parallel_group: 3
depends_on: [4, 5]
issue: 8
---

# Task 7: Migrate the Atlas data and backfill attribution

## What to build

The one-time move of every record from the retired CRM's MongoDB Atlas database
into the local dashboard database, plus the backfill scripts that give historical
leads their attribution — and a report that proves the move worked.

The capture history is irreplaceable: Meta's insights API does not reach back
indefinitely, so the spend rows for older months exist nowhere else once the CRM is
gone.

### Migration runbook

Write `plans/crm-integration/MIGRATION.md` — the operator's copy-pasteable
procedure. Because task 1 preserved Meta's ids as `_id`, this is a straight
collection copy with no transformation: dump the Atlas database, restore it into
the local one with the namespaces remapped, verify counts.

The runbook must state which collections move, how to verify each one's count
matches before and after, and how to roll back (the Atlas data is untouched by a
dump, so rollback is simply not proceeding).

### Backfill scripts

Three scripts under `backend/scripts/`, each idempotent, each printing what it did.
Follow the structure and logging style of the existing backfill script in the calls
module — how it connects, batches, reports and closes.

- **Resolve lead campaigns.** Walk every web lead, run task 5's campaign resolver
  over its UTM string, and store the resolved campaign and method. Report a
  breakdown by resolution method and list the distinct unresolved UTM strings — that
  list is directly actionable, because it tells the operator which ad URLs are
  tagged wrong.
- **Link leads to tasks.** Walk every ad lead, run task 5's linker, and write the
  link on both sides along with the Task's source. Report matched and unmatched
  counts, split by which matching rule succeeded.
- **Attribution report.** Read-only. Prints the state of the world: total leads by
  type, how many resolved a campaign and by which method, how many linked to a
  Task and by which rule, how many Tasks now carry a source, and the unresolved
  UTM list.

The report script is the **phase gate**. It is how a human decides whether the
matching rules are good enough on real data before any UI is built on top of them.
If it shows a poor match rate, the resolver needs tuning before phase 4 — that is
exactly why this task sits before the UI tasks rather than after.

### Ordering

The scripts have a required order: phone keys (task 3's script) must run before
linking, and campaign resolution before the report is meaningful. Encode that order
in the runbook, and have each script fail loudly with a clear message if it is run
before its prerequisite.

## Acceptance criteria

- [ ] `MIGRATION.md` contains the full dump-and-restore procedure with namespace
      remapping, verification and rollback
- [ ] Every collection's document count matches between Atlas and local after the
      restore
- [ ] Meta entity documents retain their original ids as `_id`, and cross-references
      between campaigns, adsets and ads still resolve after the move
- [ ] The campaign-resolution script populates the resolved campaign and method,
      and reports a breakdown by method plus the distinct unresolved UTM strings
- [ ] The linking script writes the link on both the lead and the Task, and reports
      matched and unmatched counts split by matching rule
- [ ] The report script runs read-only and prints every figure listed above
- [ ] Each script produces zero further changes on a second run
- [ ] Each script exits with a clear message if run out of order
- [ ] A hand-picked lead known to have come from a specific campaign is verifiably
      linked to the right Task and the right campaign after the backfill

## Boundary

This task owns the runbook and the backfill scripts, and calls into task 5's
resolvers. It does **not** write the matching logic itself, add any API, or touch
the frontend. It does not perform the production cutover of the lead-capture
endpoint — that is task 13.

## Commit convention

Your commit message MUST include `Closes #8` so the task's GitHub
issue closes when the commit lands on the default branch.
