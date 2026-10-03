---
task: 2
name: google-config-docs
parallel_group: 1
depends_on: []
issue: 31
---

# Task 2: Google config and setup docs

## What to build

The FOCAS Sales CRM is gaining Google sign-in using the Google Identity Services (GIS) ID-token flow: the browser gets an ID token from Google, and the backend verifies it. This task is config and docs only. Do not change any code. Other tasks own the User model, the auth endpoints, the user API and the frontend; do not touch them.

One Docker image serves both beta (https://beta.focasedu.online, built from the `beta` branch) and prod (https://followup.focasedu.online, built from `main`). Config is read at runtime from the environment (`backend/.env` locally and in the Docker `env_file`; on the servers the same variables are set on each deployment), so the docs must say to set the two variables on both the beta and prod servers.

### 1. `backend/.env.example`

Add a new block with two variables, following the file's existing style (a `# --- Title ---` header and short comment lines above each variable). Put it after the "Initial admin account" block (after `ADMIN_EMAIL=...`) and before the WhatsApp / WATI block. Content:

- Header such as `# --- Google sign-in ---`.
- `GOOGLE_CLIENT_ID=` with a comment: the OAuth client ID is public (it is also sent to the browser), taken from a Google Cloud "Web application" OAuth client. Leaving it empty disables Google sign-in and hides the "Sign in with Google" button; password login keeps working.
- `GOOGLE_ALLOWED_DOMAIN=` with a comment: the Google Workspace domain (e.g. `focasedu.com`, no `@`) that is checked against the ID token's `hd` claim. Accounts from any other domain are rejected.

Both values are left blank in the example file.

### 2. Main `README.md` (repo root)

Add a new `## Google sign-in setup` section. Insert it after the `## Environment variables` section (after the "Ask assistant" subsection, i.e. directly before `## More documentation`). Do not rewrite or reflow any other section. Also add one row to the environment-variables summary table: `| Google sign-in (optional) | GOOGLE_CLIENT_ID, GOOGLE_ALLOWED_DOMAIN |` (with the variable names in backticks, matching the other rows).

The section is a numbered list of steps:

1. Open the Google Cloud console and create or pick a project under the FOCAS Google Workspace organisation.
2. APIs & Services -> OAuth consent screen: set User type to **Internal** and App name to **FOCAS Sales CRM**. Fill in the support and developer contact emails and save.
3. APIs & Services -> Credentials -> Create credentials -> **OAuth client ID** -> Application type **Web application**.
4. Under **Authorized JavaScript origins** add all four:
   - `https://beta.focasedu.online`
   - `https://followup.focasedu.online`
   - `http://localhost:5173` (Vite dev server)
   - `http://localhost:7007` (Docker / backend-served build)
5. Leave **Authorized redirect URIs** empty. The ID-token flow needs no redirect URIs.
6. Copy the Client ID. Set `GOOGLE_CLIENT_ID=<that client id>` and `GOOGLE_ALLOWED_DOMAIN=<workspace domain>` in the environment of both the beta and prod apps (on the servers these are Coolify app environment variables, one app per branch), and in local `backend/.env` for development. Then redeploy/restart so the new values are read.

Follow with short notes:
- The client ID is public; there is no client secret to configure.
- Leaving `GOOGLE_CLIENT_ID` empty disables Google sign-in and hides the button.
- Google sign-in only works for users who already exist: each user must have a login email set (Admin -> Users) that matches their Google account email. Anyone without a matching user is rejected.

Keep the tone and formatting consistent with the rest of the README (plain Markdown, concise).

## Acceptance criteria

- [ ] `backend/.env.example` contains `GOOGLE_CLIENT_ID=` and `GOOGLE_ALLOWED_DOMAIN=`, both empty, each with a short comment covering the points above (public client ID from a "Web application" OAuth client; allowed domain checked against the `hd` claim; empty client ID disables Google sign-in and hides the button).
- [ ] `README.md` has a `## Google sign-in setup` section with the numbered steps above, including all four authorized JavaScript origins, the "no redirect URIs" note, and "set both env vars on beta and prod and restart the container".
- [ ] The README section notes that users need a login email set (Admin -> Users) matching their Google account.
- [ ] The env-var summary table in `README.md` has a Google sign-in row.
- [ ] No other README content, and no code, is changed. `git diff --stat` shows only `backend/.env.example` and `README.md`.
- [ ] No real secrets or real client IDs are committed.

## Commit convention

Your commit message MUST include `Closes #31` so the task's GitHub issue closes when the commit lands on the default branch.
