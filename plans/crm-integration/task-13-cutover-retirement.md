---
task: 13
name: cutover-retirement
parallel_group: 5
depends_on: [6, 7, 10, 11, 12]
issue: 14
---

# Task 13: Cut over lead capture and retire focas-crm

## What to build

The operational finish: move live lead capture from `crm.focasedu.online` to the
dashboard, confirm nothing is lost, then shut the old service down.

This is the only step that can silently drop real leads, which is why it runs last —
everything it depends on has already been proven against migrated data.

### Deliverable

A runbook, `plans/crm-integration/CUTOVER.md`, precise enough for the operator to
follow without re-deriving anything, plus the configuration changes it calls for.

### Sequence

1. **Verify the dashboard endpoint is live and reachable** at its public URL,
   receiving nothing yet. Confirm the honeypot, rate limit, CORS allowlist and
   shared-secret checks all behave as specified before any real traffic arrives.
2. **Repoint the lead source.** Change the lead server's target URL to the
   dashboard and restart it. The old CRM stays up and running throughout — it
   simply stops receiving.
3. **Dual-running window.** For several days, compare daily lead counts between the
   dashboard and the CRM's Atlas database. Confirm the dashboard's count matches
   what the CRM would have received, and that captured leads are resolving campaigns
   and linking to tasks at the rate the migration report established.
4. **Retire.** Stop the CRM containers, remove its reverse-proxy configuration, and
   take a final archival dump of the Atlas database before decommissioning it.

**Rollback** at any point before step 4 is reverting one environment variable on the
lead server. The runbook must say this explicitly, including who can do it and how
long it takes.

### Configuration

Set the ingest shared secret in the dashboard's environment and on the lead server,
and confirm the CORS allowlist names the real landing-page origin. The dashboard's
public URL must be reachable from wherever the lead server runs — verify this before
step 2, not during it.

### Documentation

- Update the dashboard's deployment documentation to cover the new environment
  variables, the GitHub Packages token the build now needs, and the fact that this
  service now owns public lead capture.
- Record in `focas-crm`'s repository that it is retired, what replaced it, and where
  its data went. Someone will find that repository later and needs to know it is
  dead.
- Note that the ad sync scheduler now runs in the dashboard, so Meta credentials
  live in the dashboard's environment.

### Verification gate

Do not proceed past step 3 until daily counts have matched for the full window. If
they diverge, stop and diagnose — a missing lead is not recoverable, and the CRM is
still running precisely so that it can be rolled back to.

## Acceptance criteria

- [ ] `CUTOVER.md` documents all four steps, the rollback procedure, and the
      verification gate
- [ ] The dashboard's public ingest URL is reachable from the lead server before
      any repoint
- [ ] Honeypot, rate limit, CORS allowlist and shared-secret behaviour are each
      verified against the live endpoint before real traffic is sent
- [ ] The shared secret is set in both the dashboard environment and on the lead
      server
- [ ] The CORS allowlist names the real landing-page origin
- [ ] After the repoint, new leads appear in the dashboard database with campaign
      resolution and task linking working
- [ ] Daily counts match between dashboard and CRM for the full dual-running window
- [ ] A final archival dump of the Atlas database is taken and its location recorded
- [ ] The CRM containers are stopped and its reverse-proxy configuration removed
- [ ] Deployment documentation covers the new environment variables and the build
      token
- [ ] The `focas-crm` repository states that it is retired and what replaced it

## Boundary

This task changes configuration, documentation and infrastructure only. It writes no
application code — the ingest endpoint is task 6, the migration is task 7, and the
UI is tasks 10 through 12. It must not begin until every one of its dependencies has
landed and the migration report has been reviewed by a human.

## Commit convention

Your commit message MUST include `Closes #14` so the task's GitHub
issue closes when the commit lands on the default branch.
