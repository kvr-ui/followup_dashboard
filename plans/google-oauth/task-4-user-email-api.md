---
task: 4
name: user-email-api
parallel_group: 2
depends_on: [1]
issue: 33
---

# Task 4: Admin user email create/update API

## What to build
Context: the FOCAS Sales CRM is adding Google sign-in. Task 1 added a unique, sparse, lowercase login `email` field to the `User` model (separate from `ownerEmail`, which is the Zoho Owner email used to match leads to a sales user) and exposed `email` in `publicUser` (exported from `backend/controllers/authController.js`). Google login matches users on `email`, so admins need a way to set it.

Work in the admin-only users API. `backend/routes/users.js` already applies `authenticate` and `requireAdmin` to every route; `backend/controllers/userController.js` holds `createUser`, `listUsers` and `deleteUser`.

1. `createUser` (`POST /api/users`): accept an optional `email` in the body. If `email` is omitted or empty and `ownerEmail` is present, default `email` to `ownerEmail`. Store it trimmed and lowercased. If another user already has that email, respond 409 with a clear message such as `Email already in use by another user`. Keep the existing validation unchanged: `name`, `username` and `password` required, `ownerEmail` required for sales users, and the existing username-conflict 409. When no email results, do not store null or an empty string; leave the field unset so the sparse unique index works. Also handle a Mongo duplicate-key error (code 11000) on `email` from a race and return the same 409.

2. New `updateUser` controller, exported and wired as `PATCH /api/users/:id` in `backend/routes/users.js` (inside the existing admin-guarded router). It accepts `email` and/or `ownerEmail` in the body. Only fields present in the body are changed.
   - Values are trimmed; `email` and `ownerEmail` are lowercased.
   - An empty string clears the field. For `email`, remove it from the document (`$unset` or `user.email = undefined`), not null or `''`, so the sparse unique index is unaffected. For `ownerEmail`, follow the model's existing convention for "no owner email" (the create path uses `null`).
   - If the new `email` belongs to a different user, return 409 with the same clear message. Excluding the user being updated, so re-saving their own email is fine.
   - Unknown id returns 404 `User not found`. A malformed ObjectId should also return 404 (or 400), not a 500.
   - Success returns `{ success: true, user: publicUser(user) }`.
   - Consider rejecting a body with neither field with 400.
   - Handle duplicate-key error 11000 as 409; other errors as 500 with a logged message, matching the existing style.

Out of scope (do not touch): the User model and backfill (task 1), auth endpoints (task 3), the frontend AdminUsers UI (task 6), password changes and role edits.

## Acceptance criteria
- [ ] `POST /api/users` with an `email` stores it trimmed and lowercased and returns it via `publicUser`.
- [ ] `POST /api/users` without `email` but with `ownerEmail` defaults `email` to the lowercased `ownerEmail`.
- [ ] `POST /api/users` without either leaves `email` unset (no null or empty string stored).
- [ ] `POST /api/users` with an email already used by another user returns 409 with a clear message; existing username 409 and 400 validations still behave as before.
- [ ] `PATCH /api/users/:id` is registered in `backend/routes/users.js` behind the existing authenticate and requireAdmin middleware (non-admins get 403).
- [ ] `PATCH` can set or change `email` and/or `ownerEmail`, lowercased and trimmed, and returns `{ success: true, user: publicUser(user) }`.
- [ ] `PATCH` with `email: ""` unsets the field (verified in the DB: the key is absent, not null or empty); `ownerEmail: ""` clears it per the model convention.
- [ ] `PATCH` with an email belonging to another user returns 409; setting a user's own current email succeeds.
- [ ] `PATCH` with an unknown or malformed id returns 404 (or 400 for malformed), never 500.
- [ ] `updateUser` is exported from `userController.js`; no changes to the User model, auth controller/routes or frontend.

## Commit convention

Your commit message MUST include `Closes #33` so the task's GitHub issue closes when the commit lands on the default branch.
