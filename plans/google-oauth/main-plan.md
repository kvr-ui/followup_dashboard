# Plan: google-oauth

## Goal

Let FOCAS staff sign in to the Sales CRM with their Google Workspace account, alongside the existing username/password login. Only users an admin has already created can sign in; their Google email must match the user's new login `email`. A successful Google sign-in issues the same 30-day JWT the password login issues today, so nothing downstream changes.

## Approach

Google Identity Services (GIS) ID-token flow. The login page asks the backend for the Google client ID at runtime, renders Google's button, and POSTs the returned ID token to a new `POST /api/auth/google`. The backend verifies the token with `google-auth-library` (audience, `email_verified`, `hd` domain), looks up the user by `email`, and issues the existing JWT. Users get a new unique `email` field, backfilled at boot from `ownerEmail` / `ADMIN_EMAIL` and editable by admins.

## Decisions & Rejected Alternatives

- **Google only** — staff are on Google Workspace. Rejected: Zoho OAuth, Google + Zoho, Microsoft (not needed; more surface).
- **Existing users only, matched by email** — keeps the admin-controlled role model intact; no unknown account can get in. Rejected: auto-create for the domain (bypasses admin role assignment), pending-approval accounts (extra workflow for little gain).
- **New dedicated `email` field** — login identity is separate from the Zoho mapping (`ownerEmail`), and admins may have no `ownerEmail`. Rejected: reusing `ownerEmail` (mixes two concerns).
- **Keep password login** — fallback for the seeded admin and if Google config breaks. Rejected: Google-only, or Google with admin-only password fallback.
- **GIS ID-token flow** — no redirect/callback routes, no client secret, and beta/prod only need their origins whitelisted. Rejected: server-side auth-code redirect flow (client secret plus per-environment callback config).
- **Client ID served at runtime** via `GET /api/auth/config`, not a build-time `VITE_` variable — one Docker image serves both beta and prod and reads `.env` at runtime. The Google button is hidden when `GOOGLE_CLIENT_ID` is unset.
- **Domain lock** — `GOOGLE_ALLOWED_DOMAIN` checks the token's `hd` claim, on top of the email match, as defense in depth. The consent screen is also set to Internal.
- **Email backfill at boot plus admin edit** — an idempotent migration copies `ownerEmail` → `email`, and admins can fix emails in the Users screen. Rejected: manual-only (every user would need hand edits before Google login works).

## Tasks

| # | Task | Phase | Depends on | Status |
|---|------|-------|------------|--------|
| 1 | User login email field and boot backfill | 1 | — | pending |
| 2 | Google config and setup docs | 1 | — | pending |
| 3 | Google sign-in API endpoints | 2 | 1 | pending |
| 4 | Admin user email create/update API | 2 | 1 | pending |
| 5 | Google button on the login page | 3 | 3 | pending |
| 6 | Email field in admin user management UI | 3 | 4 | pending |

## Execution phases

- **Phase 1 (parallel):** task-1, task-2
- **Phase 2 (parallel):** task-3, task-4
- **Phase 3 (parallel):** task-5, task-6
