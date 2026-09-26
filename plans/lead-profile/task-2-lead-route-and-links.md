---
task: 2
name: lead-route-and-links
parallel_group: 1
depends_on: []
issue: 23
---

# Task 2: Hash route and lead links in every list

## What to build

**Context.** The frontend is React and Vite, in `frontend/src`. It has no router. `Dashboard` switches tabs through React state, and it saves the current tab in localStorage under `fd_view`. Today, clicking a row in Follow-ups, Ad Leads or VSL Tracking opens the `TaskDetail` drawer through `setSelectedId` or the `onOpenTask` prop. This feature adds a full lead page at `#/lead/<phoneKey>`. `phoneKey` is the last 10 digits of the lead's phone. The lead page will replace the drawer. This task builds only the routing and the links into the page. Task 3 builds the real page.

**Decision.** Use a hash route. Do not add react-router, and do not change the server. The browser Back button returns to the list, and refreshing the page keeps the lead page open.

1. **Hash-route helper.** Add a small module with two exports:
   - `openLead(phoneKey)` sets `location.hash` to `#/lead/<phoneKey>`.
   - `useLeadRoute()` is a hook that reads the hash on mount and listens for `hashchange`. It returns the 10-digit `phoneKey` when the hash matches `#/lead/<10 digits>`, and `null` otherwise.
   - Also export a helper that turns any phone value into its last 10 digits, or into `null` when there are fewer than 10 digits.

2. **Dashboard.** When `useLeadRoute()` returns a key, render a `LeadProfile` placeholder in `<main>` instead of the tab content.
   - The tab row stays visible.
   - Clicking any tab clears the hash, and the list comes back. Clear it with `history.pushState`, or by setting `location.hash = ''`, so that Back still works.
   - The placeholder shows only the phone and a "← Back" link. The link calls `history.back()`, or clears the hash when there is no history.
   - Task 3 replaces the placeholder with the real page. Keep it minimal, in its own component file.

3. **Entry points in all six lists.**
   - **Follow-ups (TaskTable), Ad Leads, VSL Tracking:** a row click, or the existing "open" button, now calls `openLead(key)`. It no longer opens the drawer.
   - **Calls, Installments, Upsells:** the name or phone cell becomes a link that calls `openLead(key)` with `e.stopPropagation()`. Each list keeps its existing row click unchanged. For example, a Calls row still opens CallDetail.
   - **Getting the key:** use the row's `phoneKey` when it has one. Otherwise take the last 10 digits of the phone on the client. For task-shaped rows, get the phone with `getContact(body).phone` from `utils.js`.
   - **Rows with no usable phone** (fewer than 10 digits) stay non-clickable and show no link.

**Boundaries.**
- Do not build the real content of the lead page.
- Do not delete `TaskDetail.jsx`. Task 3 does that. It is fine if TaskDetail is unused or unmounted after this task. Remove its mount only if leaving it causes lint or build noise.
- Do not change the backend. Task 1 owns the backend.
- Keep the tab state in `fd_view` as it works today, so Back lands on the same tab.

## Acceptance criteria
- [ ] From each of the six tabs (Follow-ups, Ad Leads, VSL Tracking, Calls, Installments, Upsells), clicking a lead goes to `#/lead/<10-digit key>` and shows the placeholder with that phone.
- [ ] The browser Back button, and the "← Back" link, return to the same tab the user came from, with that tab's list showing.
- [ ] Refreshing the browser on a `#/lead/<key>` URL shows the lead page again.
- [ ] Clicking a tab while on a lead page clears the hash and shows that tab's list.
- [ ] Clicking a Calls row, anywhere except the name or phone link, still opens CallDetail. The row clicks in Installments and Upsells also behave as they did before.
- [ ] Rows without a usable phone are not clickable and have no link.
- [ ] No new dependencies, and no backend changes.
- [ ] `npm run build` (`vite build`) passes in `frontend/`. Lint passes too if a lint script exists; today there is none. The console shows no new React warnings.

## Commit convention

Your commit message MUST include `Closes #23` so the task's GitHub issue closes when the commit lands on the default branch.
