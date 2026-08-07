---
task: 11
name: source-column-filter
parallel_group: 4
depends_on: [8]
issue: 12
---

# Task 11: Add the Source column and filter

## What to build

A Source column in the follow-ups table and a matching filter, so paid-versus-organic
is visible at a glance without opening leads one at a time.

### The column

Add a Source column to `frontend/src/components/TaskTable.jsx`, positioned between
Category and Contact — grouping it with the lead's classification rather than its
workflow state.

It renders the denormalized `leadSource` already present on each task in the list
response (task 8 ensures the list returns it). This is a plain field read — **no
lookup, no fetch, no computation per row.** The table renders every open follow-up
and must not get slower.

Values: a Meta badge, a Web badge, or the standard muted dash for leads with no ad
origin. Use the existing badge component and the muted-dash convention the table
already uses for empty values. The two sources should be visually distinguishable
at a glance but must not shout — this table's existing colour is already carrying
meaning through the overdue and due-today row highlighting, and the palette is
deliberately muted.

**No cost anywhere in the list.** Cost is admin-only and requires the CPL lookup;
it stays in the detail drawer. There is deliberately nothing to role-gate in the
table.

### The filter

Add a Source select to `frontend/src/components/Filters.jsx`, alongside the
existing Status and Priority selects and matching their markup exactly. Options:
All, Meta, Web, and Untracked — where Untracked means no ad origin, which is itself
a useful thing to isolate.

Wire it into the existing filter state and the filtering logic the same way the
current filters are wired. Filtering happens client-side over the already-loaded
task list, consistent with how the other filters work — do not add a server round
trip.

The filter must compose correctly with the existing filters and with the due-date
tabs: selecting "Overdue" and "Meta" shows overdue Meta leads, not one or the other.

### Styling

Append one clearly-commented block at the end of `frontend/src/styles.css` using a
`.source-` class prefix. **Do not edit any existing rule** — tasks 10 and 12 are
appending their own blocks to the same file in parallel.

## Acceptance criteria

- [ ] A Source column appears between Category and Contact in the follow-ups table
- [ ] Meta and web leads show distinguishable badges; leads with no ad origin show
      the table's standard muted dash
- [ ] The column reads the denormalized source field with no per-row lookup or fetch
- [ ] No cost or spend value appears anywhere in the table
- [ ] A Source select appears in the filter bar with All, Meta, Web and Untracked
- [ ] Selecting a source filters the visible rows correctly, including Untracked
- [ ] The source filter composes with the status, priority and owner filters and
      with the due-date tabs
- [ ] Table render performance with the full task list is unchanged
- [ ] All new CSS is one appended block using the `.source-` prefix, with no
      existing rule modified

## Boundary

This task owns only `TaskTable.jsx` and `Filters.jsx` plus its CSS block. It does
**not** touch the lead detail drawer (task 10), the Dashboard tab navigation, or
any new tab (task 12). It adds no backend change — the list response already
carries the field.

## Commit convention

Your commit message MUST include `Closes #12` so the task's GitHub
issue closes when the commit lands on the default branch.
