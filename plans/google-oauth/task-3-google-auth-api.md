---
task: 3
name: google-auth-api
parallel_group: 2
depends_on: [1]
issue: 32
---

# Task 3: Google sign-in API endpoints

## What to build
Add Google sign-in to the FOCAS Sales CRM backend (Express + Mongoose). Work is limited to `backend/controllers/authController.js`, `backend/routes/auth.js` and `backend/package.json` (plus lockfile).

Context: Task 1 already added a unique, sparse, lowercase `email` field to the `User` model and added `email` to `publicUser` in `authController.js`. Do not touch the User model or backfill. Today `login` in `authController.js` verifies username/password, then signs a JWT inline: `jwt.sign({ sub: user._id.toString(), role: user.role }, SECRET, { expiresIn: '30d' })` where `SECRET` is imported from `../middleware/auth`. Routes live in `backend/routes/auth.js` (`POST /login`, `GET /me` behind `authenticate`). All error responses use the shape `{ success: false, message }`.

Build:
1. Add the dependency `google-auth-library` to `backend/package.json` (npm install in `backend/`).
2. Extract an `issueToken(user)` helper in `authController.js` containing the exact `jwt.sign` call above, and use it in `login` and in the new Google handler so both flows issue identical tokens. Password login behavior must not change.
3. `GET /api/auth/config` (public, no `authenticate`): respond `{ success: true, googleClientId: process.env.GOOGLE_CLIENT_ID || null }`. Read the env var at request time (not module load) because one Docker image serves both beta and prod, with the client ID supplied at runtime.
4. `POST /api/auth/google` (public), body `{ credential }` (the Google Identity Services ID token). Handler `googleLogin`, in order:
   - `GOOGLE_CLIENT_ID` unset: 503 `{ success: false, message: 'Google sign-in is not configured' }`.
   - `credential` missing/not a non-empty string: 400.
   - Verify with `new OAuth2Client(clientId).verifyIdToken({ idToken: credential, audience: clientId })`, then `getPayload()`. Any verification error (bad signature, expired, wrong audience): 401 `Invalid Google credential`.
   - `!payload.email_verified`: 403.
   - If `GOOGLE_ALLOWED_DOMAIN` is set and `payload.hd` (case-insensitive compare, missing `hd` counts as mismatch) differs from it: 403.
   - `User.findOne({ email: payload.email.toLowerCase() })`; no user: 403 with message `No account for this Google email — ask an admin`.
   - Success: `{ success: true, token: issueToken(user), user: publicUser(user) }` — same shape as password login.
   - Wrap in try/catch; unexpected errors: log and return 500 `{ success: false, message: 'Google sign-in failed' }`.
   Never auto-create users (decision: existing users only).
5. Export the new handlers and register both routes in `backend/routes/auth.js`, unauthenticated.

Out of scope: User model/backfill (task 1), user management API (task 4), env example/docs (task 2), frontend (task 5).

## Acceptance criteria
- [ ] `google-auth-library` is listed in `backend/package.json` dependencies and installs cleanly.
- [ ] `issueToken(user)` exists and is used by both `login` and the Google handler; tokens have payload `{ sub, role }`, signed with `SECRET`, 30d expiry.
- [ ] `GET /api/auth/config` works without a token and returns `{ success: true, googleClientId }` (string when `GOOGLE_CLIENT_ID` is set, `null` otherwise).
- [ ] `POST /api/auth/google` returns 503 when `GOOGLE_CLIENT_ID` is unset.
- [ ] Returns 400 when `credential` is missing.
- [ ] Returns 401 for an invalid/expired/wrong-audience token.
- [ ] Returns 403 when `email_verified` is false.
- [ ] Returns 403 when `GOOGLE_ALLOWED_DOMAIN` is set and `hd` does not match (case-insensitive); no domain restriction when it is unset.
- [ ] Returns 403 `No account for this Google email — ask an admin` when no User has that (lowercased) email; no user is ever created.
- [ ] A valid token for an existing user returns `{ success: true, token, user }` where `user` matches `publicUser` and the token is accepted by `authenticate` (e.g. `GET /api/auth/me`).
- [ ] Existing password login (`POST /api/auth/login`) behaves exactly as before, including its error responses.
- [ ] No changes outside the auth controller, auth routes, and backend package files.

## Commit convention

Your commit message MUST include `Closes #32` so the task's GitHub issue closes when the commit lands on the default branch.
