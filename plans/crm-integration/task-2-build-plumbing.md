---
task: 2
name: build-plumbing
parallel_group: 1
depends_on: []
issue: 3
---

# Task 2: Wire the private Meta package into the build

## What to build

The Meta Ads sync depends on `@santhosh785/meta-ads`, a package published to
**GitHub Packages** under a private scope. The dashboard's Docker build currently
runs a plain `npm ci` with no registry authentication, so adding the dependency
would break the build. This task makes the build able to install it, and declares
every new environment variable the ads module will need.

### npm registry authentication

Add an `.npmrc` for the backend that points the `@santhosh785` scope at GitHub
Packages and reads its token from an environment variable — never a literal token
committed to the repository.

Add `@santhosh785/meta-ads` to `backend/package.json` dependencies and generate the
matching lockfile entry.

### Docker build

The token must reach `npm ci` without being baked into an image layer. Use a Docker
build secret mounted at the npm config path for the install step only, so the
credential never appears in the final image or its history. The Dockerfile already
uses `# syntax=docker/dockerfile:1`, which supports this.

Update `docker-compose.yml` so the build passes the secret through, and document in
the compose file's comments where the token comes from — a GitHub personal access
token with `read:packages` scope.

The existing multi-stage structure (frontend build stage, then backend runtime
stage) must be preserved, along with the ffmpeg/tzdata install, the IST timezone,
the non-root user, and the healthcheck.

### Environment variables

Add these to `backend/.env.example`, each with an explanatory comment in the style
of the existing entries:

- `META_ACCESS_TOKEN` — Meta Marketing API access token
- `META_AD_ACCOUNT_ID` — the ad account to sync
- `META_API_VERSION` — Graph API version, e.g. `v24.0`
- `SYNC_INTERVAL_MINUTES` — ad sync cadence; 1440 is daily, unset disables the
  scheduler
- `CORS_ORIGINS` — comma-separated origin allowlist for the public lead ingest
- `WEB_LEAD_RATE_MAX` — per-IP ingest requests per minute, default 60
- `LEAD_INGEST_TOKEN` — shared secret required on server-to-server lead posts

Do not add real values. `.env.example` is committed; `.env` is not.

## Acceptance criteria

- [ ] `backend/.npmrc` maps the `@santhosh785` scope to GitHub Packages and reads
      its auth token from an environment variable, with no literal token in the file
- [ ] `@santhosh785/meta-ads` appears in `backend/package.json` dependencies with a
      matching lockfile entry
- [ ] The Dockerfile installs backend dependencies using a mounted build secret, so
      no token is present in any image layer
- [ ] `docker-compose.yml` passes the secret to the build and comments explain the
      required token scope
- [ ] All seven new variables are present in `backend/.env.example` with comments
      and no real values
- [ ] `docker build` succeeds when the token is supplied, and fails with a clear
      registry authentication error when it is not
- [ ] The built image runs and `/health` responds, confirming nothing in the
      existing multi-stage build regressed

## Boundary

This task is pure build and configuration plumbing. It does **not** import or call
the Meta package anywhere — task 4 writes the first code that uses it. It does not
create models, routes or services.

## Commit convention

Your commit message MUST include `Closes #3` so the task's GitHub
issue closes when the commit lands on the default branch.
