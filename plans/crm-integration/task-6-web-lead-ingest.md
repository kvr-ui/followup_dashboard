---
task: 6
name: web-lead-ingest
parallel_group: 2
depends_on: [1, 2]
issue: 7
---

# Task 6: Port the public web-lead ingest endpoint

## What to build

The public endpoint that Focas landing pages post captured leads to, ported from
`focas-crm/backend/src/routes/webLeads.ts` and its rate-limit middleware into
`backend/modules/ads/`.

This is the only unauthenticated write surface in the dashboard, and the dashboard
holds far more than the CRM did — leads, calls, recordings, transcripts. It gets
the CRM's existing protections plus one more.

### The ingest route

Accepts a lead payload: name parts, email, phone, the counseling-form
qualification answers (CA status, attempt, language, city, state), the full UTM
set, landing URL and referrer, an optional Bigin contact id, and a form source
label.

Behaviour that must be preserved exactly from the source:

- **Honeypot.** A hidden `company` field that real users never fill. When it is
  present, respond `202` and store **nothing** — the bot must not learn it was
  rejected, or it will retry.
- **Empty-string normalization.** Blank strings become undefined so a missing field
  and an empty one are stored identically and render the same way.
- **Lenient validation.** Field length caps, but nothing that drops a real lead for
  an odd-looking value. An unparseable email is still a lead worth having.
- **Rate limit.** Per-IP, per-minute, capped by `WEB_LEAD_RATE_MAX` (default 60).
  It must be generous enough that the single-IP server-to-server forwarder is never
  throttled under real campaign volume.

Validation is hand-rolled to match the dashboard's conventions — the CRM used Zod,
which is not a dashboard dependency and should not become one.

### New hardening

- **Explicit CORS allowlist.** The route sets its own allowed origins from
  `CORS_ORIGINS`. It must not inherit the dashboard's blanket permissive CORS.
- **Shared secret.** Requests must carry a token header checked against
  `LEAD_INGEST_TOKEN`. The lead server is server-to-server and can hold a secret.
  When the variable is unset the check is skipped, so local development and the
  dual-write cutover window are not blocked — but log a warning at boot when it is
  unset in production.

### On capture

Resolve the lead's campaign from its UTM tags and attempt to link it to an existing
Task, storing `phoneKey`, `resolvedCampaignId`, `resolvedBy` and `linkedTaskId`.
Use the task-5 services — do not reimplement the logic.

A resolution or linking failure must never cause the lead to be lost. Store the
lead first, then attribute; if attribution throws, log it and still return success.
**A lead is worth more than its attribution.**

### Mounting

Mount the ingest route in `backend/app.js` explicitly **before** any authentication
middleware, so it can neither inherit JWT protection nor accidentally bypass it for
neighbouring routes.

The read side is separate and is **not** public: listing stored web leads returns
full lead PII and goes behind JWT plus admin. Note that this endpoint is currently
public on the CRM — that is a defect being fixed in the move, not a behaviour to
preserve.

## Acceptance criteria

- [ ] A valid lead posted to the ingest endpoint is stored and returns success
- [ ] A payload with the honeypot field filled returns `202` and stores nothing
- [ ] Blank string fields are stored as absent, not as empty strings
- [ ] Exceeding the per-IP rate limit returns `429`
- [ ] A request from an origin outside `CORS_ORIGINS` is not granted CORS headers
- [ ] With `LEAD_INGEST_TOKEN` set, a request lacking the header is rejected; with
      it unset, requests are accepted and a warning was logged at boot
- [ ] A captured lead has `phoneKey`, `resolvedCampaignId` and `resolvedBy`
      populated where resolvable
- [ ] A lead whose UTM resolves to no campaign is still stored, with a null
      resolution
- [ ] Forcing the attribution step to throw still stores the lead and returns
      success
- [ ] The ingest route works with no `Authorization` header present
- [ ] Listing stored web leads without a valid admin JWT is rejected

## Boundary

This task owns the ingest and list routes, the rate-limit middleware, and their
mounting in `app.js`. It does **not** write the campaign resolver or lead linker —
it calls task 5's. It does not build the admin reporting API (task 9) or perform
the production cutover (task 13); this endpoint ships live but receiving nothing
until then.

## Commit convention

Your commit message MUST include `Closes #7` so the task's GitHub
issue closes when the commit lands on the default branch.
