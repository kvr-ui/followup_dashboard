---
task: 10
name: acquisition-panel
parallel_group: 4
depends_on: [8]
issue: 11
---

# Task 10: Add the Acquisition panel to the lead drawer

## What to build

The feature that was actually asked for: click a lead in the follow-ups list and
see where it came from and what it cost.

A new section in the lead detail drawer (`frontend/src/components/TaskDetail.jsx`),
rendering the `acquisition` object task 8 added to the detail response.

### Placement and structure

The drawer is a stack of sections — status, fields, description, tags, follow-up
history, status audit trail, WhatsApp, notes. Add the Acquisition section after
Tags, so origin information sits with the lead's own attributes rather than in the
middle of its activity history.

Use the existing section and field-grid components already in the file. This must
look like it was always there.

### Content

- **Source** — Meta form or web form, with the specific form label
- **Campaign** — the resolved campaign name
- **Captured** — when the lead was first captured, formatted with the existing
  date-time helper
- **Estimated cost** — the figure, with the division that produced it shown
  directly beneath it in smaller muted text (spend ÷ leads, and the month). The
  wording must make clear this is an apportionment of campaign spend for that
  month, never a per-person figure Meta reported.
- **UTM tags** — source and medium together, then campaign, content and term
- **Landing URL and referrer** — the landing URL truncated, since these are long,
  with the full value available on hover
- **Qualification answers** — CA status, attempt, language, city, state. These come
  from the counseling form and the dashboard has never shown them; they are
  immediately useful before a call.

### Rules

- When `acquisition` is null, render **nothing** — no heading, no empty section. A
  lead with no ad origin should not show a block of dashes.
- When the cost object is absent (a sales-role response), render everything else
  and simply omit the cost row. No placeholder, no "hidden" label.
- When a campaign resolved by normalized string matching rather than exactly,
  indicate the match is inferred. The file already has a precedent for this: the
  task category badge is styled differently and carries an explanatory tooltip when
  it was guessed from the subject line rather than set in Bigin. Follow that
  pattern — it is the established way this codebase expresses "this is a guess."
- Individual missing fields render as the same muted dash the rest of the drawer
  uses.

### Currency

Format rupees using Indian digit grouping, consistent with how the retired CRM
displayed them.

### Styling

The frontend has no CSS framework and no chart library — a single hand-written
stylesheet with CSS custom properties. Append one clearly-commented block at the
end of `frontend/src/styles.css` using an `.acq-` class prefix. **Do not edit any
existing rule** — tasks 11 and 12 are appending their own blocks to the same file
in parallel.

## Acceptance criteria

- [ ] The Acquisition section appears after Tags in the lead drawer
- [ ] Source, campaign, captured time, UTM set, landing URL, referrer and all five
      qualification answers render
- [ ] The cost shows the figure with its spend ÷ leads basis and month beneath it
- [ ] A lead with no ad origin renders no Acquisition section at all
- [ ] Logged in as a sales user, the section renders fully with no cost row and no
      placeholder
- [ ] A campaign matched by normalized string is visually marked as inferred, with
      a tooltip explaining it
- [ ] Individual missing fields render as the drawer's standard muted dash
- [ ] Rupee values use Indian digit grouping
- [ ] All new CSS is one appended block using the `.acq-` prefix, with no existing
      rule modified
- [ ] The drawer's existing sections and actions still work unchanged

## Boundary

This task owns only `TaskDetail.jsx` and its CSS block. It does **not** touch the
task table or filters (task 11), the Dashboard tab navigation, or any new tab
(task 12). It adds no new frontend dependency.

## Commit convention

Your commit message MUST include `Closes #11` so the task's GitHub
issue closes when the commit lands on the default branch.
