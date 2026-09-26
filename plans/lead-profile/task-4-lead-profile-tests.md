---
task: 4
name: lead-profile-tests
parallel_group: 2
depends_on: [1]
issue: 25
---

# Task 4: Tests for the lead profile endpoint

## What to build

Task 1 added `GET /api/lead-profile/:phoneKey`, which requires authentication. It also exports `buildLeadProfile(phoneKey, user)` from a new backend leads module under `backend/modules/`. The function collects every Task, WebLead, MetaLead, Deal and Call that shares the `phoneKey` (the last 10 digits of the phone), plus the VSL block and acquisition. It returns `{ phoneKey, header, latestTask, olderTasks, webLeads, metaLeads, deals, calls, vsl, acquisition, timeline }`.
- `header.state` is one of `'won' | 'lost' | 'pipeline' | 'followup' | 'none'`. It is worked out by a state helper that task 1 moved out of the ads/leads route.
- `timeline` items are `{ at, type, text, by }`, sorted newest first. `type` is one of `form | task | status | note | whatsapp | call | deal`.
- Status codes:
  - 400: `phoneKey` is not 10 digits.
  - 404: nothing exists on that phoneKey.
  - 403: the caller is a sales rep who owns no Task, Deal or Call on that phoneKey.
- `acquisition` includes a cost key only for admins. For reps the key is absent, not `null`.

Read task 1's code first, so the tests target the real function names and the real stub points.

Write a test script in the same style as the backend's existing tests. See `backend/modules/agent/scripts/testMongoQuery.js`:
- A plain Node script, run as `node modules/<leads-module>/scripts/testLeadProfile.js` from `backend/`.
- No test framework. It has a small `check(name, fn)` helper, a pass count and a failures list, and uses `assert`.
- It prints a summary and exits non-zero on failure.

The backend has no `npm test` script. Add `"test": "node modules/<leads-module>/scripts/testLeadProfile.js"` to `backend/package.json`, chaining `testMongoQuery.js` too if it runs without a DB. Otherwise, document the run command in the script's header comment.

**No production database.** Do not connect to Atlas and do not read `MONGO_URI`. Stub the Mongoose models (`Task`, `WebLead`, `MetaLead`, `Deal`, `Call`) and the VSL and acquisition services before requiring the module under test. Use `require.cache` replacement or monkey-patch the model statics (`find`, `findOne`, `lean`, and so on) so they return fixture arrays. Do not add new dependencies such as mongodb-memory-server unless there is no other way. For the HTTP status cases, call the route handler with fake `req` and `res` objects, or call `buildLeadProfile` if it throws or returns typed errors. Pick whichever matches task 1's design.

Cases to cover:
1. An admin user gets `acquisition` with the cost key present.
2. A sales rep's payload has no cost key anywhere in `acquisition`. Check with `!('cost' in ...)` or `hasOwnProperty`, not an `=== null` or `undefined` check.
3. A rep who owns one Call, but not the Task, gets the full profile, including a colleague's Calls and Deals.
4. A rep who owns no Task, Deal or Call on that phoneKey gets 403.
5. An unknown phoneKey gets 404.
6. A bad phoneKey (too short, non-digits, 11+ digits) gets 400.
7. The timeline is sorted newest first, and it contains at least one entry for each event type that is present in the fixtures.
8. When one data source fails (for example the VSL service throws), the endpoint still returns 200 with the other sections filled and `vsl` set to `null`.
9. The extracted state helper returns the same values as the old ads/leads route logic for won, lost, pipeline, followup and none inputs. Use `git show` on the pre-task-1 commit to copy the original expectations.

**Boundary:** tests only. Do not change endpoint behaviour, and do not touch the frontend. If a test exposes a bug in task 1's code, apply only the smallest possible fix, and describe the bug and the fix in the commit message.

## Acceptance criteria

- [ ] A new test script exists in the repo's plain-Node `check()` style and covers all 9 cases above.
- [ ] The tests never connect to a real MongoDB or Atlas. All models and services are stubbed, and the script runs with no `.env`.
- [ ] Rep payload test asserts the cost key is absent (not merely null/undefined).
- [ ] `cd backend && npm test` runs the new tests. If that is not possible, the script header documents the exact command.
- [ ] All new tests pass, and existing backend test scripts still pass.
- [ ] Endpoint behaviour is unchanged. Any bug fix is minimal and noted in the commit message.
- [ ] No frontend changes.

## Commit convention

Your commit message MUST include `Closes #25` so the task's GitHub issue closes when the commit lands on the default branch.
