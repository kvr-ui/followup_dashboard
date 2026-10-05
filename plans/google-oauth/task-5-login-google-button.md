---
task: 5
name: login-google-button
parallel_group: 3
depends_on: [3]
issue: 34
---

# Task 5: Google button on the login page

## What to build
Add Google sign-in to the FOCAS Sales CRM login page (React 18 + Vite, no auth library). This task is frontend only. Do not touch the backend (tasks 1, 3, 4) or the AdminUsers view (task 6).

Task 3 already added two backend endpoints:
- `GET /api/auth/config` returns `{ googleClientId }`. The value is null when Google is not configured.
- `POST /api/auth/google` takes `{ credential }` and returns `{ token, user }`, the same shape as password login. On failure it returns `{ message }` with status 403 (unknown email or wrong domain) or 503 (unconfigured).

Files to change:
- `frontend/src/components/Login.jsx`. It currently has a `<form className="login-card">` with a logo, a `.login-head` block, an optional `{error && <div className="error">…</div>}`, Username and Password labels, and a submit button. It uses `api` and `setToken` from `../api`, and the `onLogin(user)` prop.
- `frontend/src/styles/views/login.css`. This holds the login styles (`.login-wrap`, `.login-card`, `.login-head`, and so on). They use CSS variables such as `--space-*`, `--border`, `--surface` and `--radius-lg`. Note that `.login-card button` forces width 100% and padding on every button inside the card, so make sure that rule does not distort the Google-rendered button. Google renders into an iframe or div, but check.

Behavior to implement in `Login`:
1. On mount, `useEffect` calls `api('/api/auth/config')` and stores `googleClientId` in state. If the call fails or the value is falsy, render nothing extra and leave the password form exactly as it is today. Swallow the config error silently. It must not set the `.error` box.
2. When `googleClientId` is set, load the Google Identity Services script `https://accounts.google.com/gsi/client` (async, defer). Load it only once. If a `script[src="https://accounts.google.com/gsi/client"]` tag already exists, or `window.google?.accounts?.id` is already present, reuse it instead of adding a second tag. Handle a script load error by hiding the Google section (no crash).
3. Once the script is ready, call `google.accounts.id.initialize({ client_id: googleClientId, callback })`, then `google.accounts.id.renderButton(containerRef.current, { theme: 'outline', size: 'large', width: 300 })`. Keep the width at or below the card's inner width (the card is max 380px with padding). Clean up on unmount where practical, for example by ignoring late script loads after unmount.
4. The `callback` receives `{ credential }`. It clears the error, sets `busy`, and POSTs `{ credential }` to `/api/auth/google` through the existing `api` helper (`method: 'POST'`, `body: { credential }`). On success it calls `setToken(token)` and then `onLogin(user)`, the same as the password path. On failure it calls `setError(err.message)`, which shows in the existing `.error` box. Clear `busy` in a `finally`.
5. Place the Google section inside the card, below the existing submit button. It has an "or" divider (a line, the text "or", a line) followed by a container div for the Google button. Render the divider and container only when `googleClientId` is set.
6. Use the client ID from the runtime `/api/auth/config` response. Do NOT use a `VITE_*` build variable, because one Docker image serves both beta and prod.

Styles (add to `login.css`, matching the existing card look):
- `.login-divider`: flex row, centered text, small muted text (use the same muted color the `.subtle` class uses), with `::before` and `::after` pseudo-lines using `1px solid var(--border)` and a gap of `var(--space-3)` (or the nearest existing spacing token).
- `.login-google`: flex, `justify-content: center`, minimum height around 44px so the layout does not jump while the button loads.

Do not add dependencies. The CSP, if any exists in the repo, may need `accounts.google.com`. Check for it (grep for Content-Security-Policy and helmet in the backend) and only mention it in your commit or PR notes if relevant. Do not edit backend files.

## Acceptance criteria
- [ ] With `googleClientId` set in `/api/auth/config`, the login card shows an "or" divider and the Google button below the password form.
- [ ] With `googleClientId` null, or with the config request failing, the login page looks and behaves exactly as before. There is no divider, no extra script tag, and no error shown.
- [ ] The GSI script is loaded at most once, even across remounts or React StrictMode double effects.
- [ ] Choosing a Google account POSTs `{ credential }` to `/api/auth/google`. On success the token is stored via `setToken` and `onLogin(user)` is called, so the user lands in the app as with password login.
- [ ] A 403 or 503 from `/api/auth/google` shows the server's `message` in the existing `.error` box. The password form still works afterward.
- [ ] The client ID comes only from the runtime config endpoint, with no `VITE_` variable.
- [ ] The divider and button container are styled in `login.css` consistent with the card, and the Google button is not stretched by `.login-card button` rules.
- [ ] `npm run build` in `frontend/` succeeds, and no backend or AdminUsers files are modified.

## Commit convention

Your commit message MUST include `Closes #34` so the task's GitHub issue closes when the commit lands on the default branch.
