---
task: 1
name: user-email-backfill
parallel_group: 1
depends_on: []
issue: 30
---

# Task 1: User login email field and boot backfill

## What to build

Background: the FOCAS Sales CRM (Express + Mongoose backend in `backend/`, React/Vite frontend) is getting Google sign-in (plan `google-oauth`). Only existing users may sign in with Google, and the Google account email must match a new login `email` field on the User model. This task ONLY adds that field and populates it for existing and seeded users. It adds no Google endpoints (task 3), no user create/update API changes (task 4), no env/docs changes (task 2), and no frontend work (tasks 5, 6).

Current state, for orientation:
- `backend/models/User.js` defines `name`, `username` (unique, lowercase), `passwordHash`, `role` (`admin`|`sales`), and `ownerEmail` (lowercase, default null; the Zoho `Owner.email` used to match a sales user's leads).
- `backend/config/seed.js` exports a single default function `seedAdmin` that creates an admin from `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_NAME`, `ADMIN_EMAIL` (currently stored only as `ownerEmail`) when no admin exists.
- `backend/server.js` does `const seedAdmin = require('./config/seed');` and chains `.then(seedAdmin)` after the DB connection.
- `backend/controllers/authController.js` has `publicUser(u)` returning `id, name, username, role, ownerEmail`; it is used by login and `/api/auth/me` (and likely by the users controller; check usages).

Changes to make:

1. User model: add an `email` field: `String`, `lowercase: true`, `trim: true`, `unique: true`, `sparse: true`. Do NOT set a default (and never null): leave it `undefined` for users without one, because a sparse unique index still indexes explicit `null` values and would make users collide. Keep `ownerEmail` exactly as is. The two fields are deliberately separate: `ownerEmail` matches Zoho leads, `email` is the login/Google identity.

2. Backfill in `backend/config/seed.js`: add an idempotent function (e.g. `backfillUserEmails`) and export it while keeping the default export as `seedAdmin`, so `require('./config/seed')` in `server.js` still returns the `seedAdmin` function. For example, `module.exports = seedAdmin; module.exports.backfillUserEmails = backfillUserEmails;`. Behavior:
   - For every user that has no `email` but has an `ownerEmail`, set `email = ownerEmail` (lowercased), unless another user already has that email. In that case log a warning naming the user and email and skip it. Never throw on duplicates; handle a duplicate-key error (code 11000) defensively too.
   - Admin special case: if no admin user has an `email` and `ADMIN_EMAIL` is set, the admin whose username matches `ADMIN_USERNAME` (default `admin`, lowercased) may receive `email = ADMIN_EMAIL.toLowerCase()`, subject to the same uniqueness check.
   - Running it repeatedly must change nothing after the first run and produce no errors.
   - `seedAdmin` should also set `email` (from `ADMIN_EMAIL`, lowercased) when creating a new admin, in addition to the existing `ownerEmail`. If `ADMIN_EMAIL` is unset, omit `email` entirely (do not pass null).

3. Wire the backfill into `backend/server.js` to run at boot right after `seedAdmin` (e.g. `.then(seedAdmin).then(backfillUserEmails)`), with failures logged by the existing boot error handling and not preventing unrelated startup behavior beyond what a seed failure already does.

4. Add `email: u.email` to `publicUser` in `backend/controllers/authController.js` so `/api/auth/me`, login responses, and any endpoint using `publicUser` (such as `/api/users`) include it. If the users controller builds its own response shape instead of using `publicUser`, add `email` there too (response only, no create/update logic changes).

Important: the beta and prod deployments share the SAME MongoDB database. Deploying this to beta builds the index and runs the backfill against prod's users while prod still runs the old code, so the change must be purely additive: no field renames or removals, and nothing that breaks old code reading the users collection.

Make sure the sparse unique index is created (Mongoose `autoIndex` or `User.init()`/`syncIndexes` as the project already does for other indexes); confirm it does not fail against existing data where no user has an email.

## Acceptance criteria
- [ ] `User` schema has `email` (String, lowercase, trimmed, unique, sparse) with no default; `ownerEmail` is unchanged.
- [ ] The `email` sparse unique index exists in MongoDB, and multiple users without `email` can coexist without duplicate-key errors.
- [ ] `backfillUserEmails` is exported from `backend/config/seed.js` alongside the default `seedAdmin` export; `require('./config/seed')` in `server.js` still yields `seedAdmin`.
- [ ] On boot, users with `ownerEmail` and no `email` get `email = ownerEmail`; users that already have an email are untouched.
- [ ] If an email is already used by another user, the backfill logs a warning and skips that user without crashing.
- [ ] Restarting the server twice is idempotent: no changes on later runs and no duplicate-key errors.
- [ ] A newly seeded admin gets `email` from `ADMIN_EMAIL`; with `ADMIN_EMAIL` unset no `email` is stored. An existing admin without email matching `ADMIN_USERNAME` is backfilled from `ADMIN_EMAIL` when set.
- [ ] The backfill runs at boot after `seedAdmin` in `server.js`.
- [ ] `/api/auth/me`, the login response, and `/api/users` responses include `email`.
- [ ] Existing username/password login still works unchanged.
- [ ] No Google endpoints, user create/update API changes, env/docs changes, or frontend changes are included.

## Commit convention

Your commit message MUST include `Closes #30` so the task's GitHub issue closes when the commit lands on the default branch.
