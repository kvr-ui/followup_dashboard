---
task: 6
name: admin-users-email-ui
parallel_group: 3
depends_on: [4]
issue: 35
---

# Task 6: Email field in admin user management UI

## What to build

Context: the FOCAS Sales CRM (React 18 + Vite frontend) is gaining Google sign-in. Each user now has a login `email`, which is matched against their Google account. It is separate from `ownerEmail`, which is the Zoho Owner email used to match webhook leads. Task 4 already added the backend support:

- `GET /api/users` returns an `email` field for each user.
- `POST /api/users` accepts an optional `email`. If omitted, the server defaults it to `ownerEmail`.
- `PATCH /api/users/:id` accepts `{ email }` and/or `{ ownerEmail }` and returns `{ user }`. It responds 409 with a message on a duplicate email. An empty string clears the email.

Your job is frontend only, in `frontend/src/components/AdminUsers.jsx`. Do NOT touch the backend (tasks 1, 3, 4) or the Login page (task 5).

Current state of the component: it imports `api` from `../api` (a fetch wrapper that sends the Bearer token and throws an `Error` whose `.message` is the server's `message`, with `.status` set). It uses `Section` and `DataTable` from `./ui/`. The component keeps `users`, `form`, `error`, `notice`, `busy` state, and a module-level `EMPTY = { name, username, password, role: 'sales', ownerEmail }`. Errors render as `{error && <div className="error">{error}</div>}` and success as `<div className="notice">`. Create goes through `handleCreate`, which POSTs `form`, resets to `EMPTY` and calls `loadUsers()`. The users table has columns Name, Username, Role, Owner email and an actions column (Delete button with class `link-danger`, shown for non-admin users).

Build:

1. Create form: add `email: ''` to `EMPTY`. Add an optional text/email input labelled "Login email (Google)" using the same `<label>` + `<input type="email">` pattern as the other fields, wired through `update('email', ...)`. It is not required. Add a short hint (for example a placeholder or small `subtle` text under the input) saying that if left blank it defaults to the Zoho owner email. Because the form body is sent as-is, an empty `email` must be fine (the server treats it as absent); if you prefer, omit `email` from the POST body when it is blank.

2. Users table: add an "Email" column (place it after Owner email, before the actions column) showing `u.email || '—'` with the `subtle` class like the Owner email cell. Add inline edit for it:
   - Track which row is being edited and its draft value in component state (e.g. `editingId`, `editValue`, plus a saving flag).
   - Non-editing row shows the email and an "Edit" button (a link-style button, matching the existing `link-danger` button styling approach; reuse an existing link-button class if one exists in the styles, otherwise add a minimal class in the stylesheet already imported by the file, `frontend/src/styles/views/reports.css`).
   - Clicking Edit swaps the cell to an `<input type="email">` prefilled with the current email, with Save and Cancel buttons. Enter may save and Escape may cancel (optional nicety).
   - Save calls `api(`/api/users/${u.id}`, { method: 'PATCH', body: { email: editValue.trim() } })`. On success, replace that user in `users` state with the returned `user` (do not refetch the whole list), clear the editing state, and optionally set a `notice`. Clearing the input and saving sends an empty string, which clears the email.
   - On failure (including the 409 duplicate case), call `setError(err.message)` so the message shows in the existing `.error` banner, keep the row in edit mode so the admin can correct it, and clear `error`/`notice` at the start of each save attempt, as `handleCreate` does.
   - Cancel just exits edit mode without a request.

3. Match the existing styling and kit components (`Section`, `DataTable`, existing class names). Do not add new dependencies.

## Acceptance criteria
- [ ] The create form has an optional "Login email (Google)" input, `email` is part of the form's `EMPTY` state, and a hint states it defaults to the Zoho owner email when blank.
- [ ] Creating a user with the login email blank still works; creating with a value sends it to `POST /api/users`.
- [ ] The users table has an Email column showing each user's `email` (or an em dash when empty).
- [ ] Each row has an Edit control that turns the email cell into an input with Save and Cancel; Cancel makes no request.
- [ ] Save sends `PATCH /api/users/:id` with `{ email }`, updates that row in place from the returned `user` on success, and exits edit mode.
- [ ] Saving an empty value clears the email (sends an empty string).
- [ ] A server error such as a 409 duplicate email shows its message in the existing `.error` banner and leaves the row in edit mode.
- [ ] No backend files or the Login page are modified; the frontend builds (`npm run build` in `frontend`) with no new lint or console errors.

## Commit convention

Your commit message MUST include `Closes #35` so the task's GitHub issue closes when the commit lands on the default branch.
