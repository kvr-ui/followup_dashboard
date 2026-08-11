# Followup Dashboard — API reference

<!-- GENERATED FILE. Edit frontend/src/apiDocs.js and run:
     node frontend/scripts/genApiDocs.mjs -->

Same origin as this dashboard. Locally the API listens on http://localhost:3000 (PORT), and the Vite dev server proxies to it — so relative paths like /api/tasks work from the browser either way.

The same reference is available inside the dashboard under the **API Docs** tab, where every
GET endpoint has a **Run** button that fires the real request with your session token.

## Authenticating

Everything except the webhooks and the public lead ingest needs a JWT.

```bash
TOKEN=$(curl -s http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"kavya","password":"…"}' | jq -r .token)

curl http://localhost:3000/api/tasks -H "Authorization: Bearer $TOKEN"
```

Tokens last 30 days. A `401` means expired or invalid — log in again.

Three access levels appear below, copied from the router that enforces each one:

| Level | Meaning |
| --- | --- |
| **No auth** | Callable without a token: inbound webhooks and the landing-page lead ingest. |
| **Any logged-in user** | Any valid token. The controller scopes a sales rep to their OWN rows — server-side, not hidden in the UI. |
| **Admin only** | `authenticate` + `requireAdmin` at the router. A rep gets `403`. |

## Endpoints

- [Authentication](#authentication)
  - `POST /api/auth/login` — Exchange username + password for a JWT.
  - `GET /api/auth/me` — Who the current token belongs to. Used to restore a session on page load.
- [Follow-ups](#follow-ups)
  - `GET /api/tasks` — Every follow-up, newest first, served from a warm cache. Admins get all; a rep gets their own.
  - `GET /api/tasks/:id` — One follow-up with its full history: notes, status changes, WhatsApp log, and the acquisition block.
  - `PATCH /api/tasks/:id/status` — Move a follow-up along. Writes locally, then pushes to Bigin/Zoho.
  - `POST /api/tasks/:id/notes` — Add a note. Mirrored into Zoho as a note on the contact when a zohoId exists.
  - `POST /api/tasks/:id/whatsapp` — Send a WATI template to this lead's phone and log the send.
- [Ask (data assistant)](#ask-data-assistant)
  - `GET /api/agent/status` — Whether the assistant is configured, which model, and the tools this user may use.
  - `POST /api/agent/chat` — Ask a question. Returns the answer plus the tools it used to get there.
- [Calls](#calls)
  - `GET /api/calls` — Paged call list with filters.
  - `GET /api/calls/stats` — Headline counters: total, with recording, matched to a lead, graded, and per-agent volume.
  - `GET /api/calls/outcomes` — Won/lost totals and the loss-reason breakdown. Reads Deals, so it counts closed deals with no recorded call too.
  - `GET /api/calls/grades` — The Scorecard payload — AI call grades rolled up per rep, per criterion, per call type.
  - `GET /api/calls/journeys` — Closed leads with all their calls attached — a sale is a journey of several calls. Covers won AND lost.
  - `GET /api/calls/:id` — One call with its full transcript and grade breakdown.
  - `GET /api/calls/:id/recording` — Stream the recording as browser-playable audio/mpeg. Supports Range, so the player can seek.
  - `GET /api/calls/pipeline-health` — Is anything falling through the cracks? Read-only view of the audit the scheduler runs.
  - `GET /api/calls/usage` — What the AI pipeline has spent (Sarvam tokens, ElevenLabs audio) and what balance is left.
  - `POST /api/calls/sync` — Pull recent answered calls from TeleCMI now (incremental, idempotent on cmiuid).
- [Installments & Upsells](#installments-upsells)
  - `GET /api/installments` — Won deals with a balance outstanding, longest-overdue first.
  - `GET /api/upsells` — Won deals with Up_Scale set, newest first, priced against the product baseline.
- [Analytics](#analytics)
  - `GET /api/analytics` — Status / priority / due-date rollups and per-rep activity across all follow-ups.
- [Marketing / Ads](#marketing-ads)
  - `GET /api/ads/summary` — Spend, impressions, clicks, CTR, CPC, leads and CPL for a date range.
  - `GET /api/ads/campaigns` — One row per campaign that spent anything in the range, with its metadata.
  - `GET /api/ads/insights` — The stored insight rows behind every number above — the "show me the receipts" endpoint.
  - `GET /api/ads/leads` — The Ad Leads tab: web-form and Meta lead-form submissions, with their attribution.
  - `GET /api/ads/sources` — The Sources tab: which lead source closed the deal, and the campaign behind it.
  - `GET /api/ads/reconciliation` — Does account-level spend agree with the sum of campaign-level spend?
  - `GET /api/ads/campaign-aliases` — The UTM → campaign alias table, plus the worklist it exists to shrink.
  - `POST /api/ads/campaign-aliases` — Create — or overwrite — one alias. Idempotent.
  - `PUT /api/ads/campaign-aliases/:key` — Change what an existing alias points at.
  - `DELETE /api/ads/campaign-aliases/:key` — Untriage a UTM string — put it back on the unresolved worklist.
  - `GET /api/ads/sync/history` — The sync audit trail, newest first — plus whether one is running right now.
  - `POST /api/ads/sync` — Start a full Meta sync now. Answers 202 once the run has STARTED, not when it finishes.
- [Web lead ingest](#web-lead-ingest)
  - `POST /api/leads/web` — Capture a landing-page lead with the UTM tags from the click URL.
  - `GET /api/leads/web` — Stored web leads, newest first.
- [WhatsApp, users & health](#whatsapp-users-health)
  - `GET /api/wati/templates` — Approved WATI template names, for the WhatsApp composer in the task drawer.
  - `GET /api/users` — All dashboard users, oldest first. Password hashes are never returned.
  - `POST /api/users` — Create a sales or admin user.
  - `DELETE /api/users/:id` — Remove a user.
  - `GET /health` — Liveness probe. No auth, no database read.
- [Inbound webhooks](#inbound-webhooks)
  - `POST /webhook` — Zoho Flow posts a follow-up task here. Deduped by contact; a single object or an array both work.
  - `GET /webhook` — Raw stored task bodies, newest first. Predates /api/tasks; kept for debugging.
  - `POST /webhook/call` — TeleCMI posts a finished call here. The call is stored, then transcribed and graded in the background.
  - `POST /webhook/deal` — Bigin posts a deal create/update here — this is what makes a call journey won or lost.

---

## Authentication

Everything except the webhooks and the public lead ingest needs a JWT. Log in once, then send `Authorization: Bearer <token>` on every call. Tokens last 30 days; a 401 means expired, and the dashboard logs you out on it.

### `POST /api/auth/login`

**No auth.** Exchange username + password for a JWT.

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `username` | string | Case-insensitive. |
| `password` | string | Required. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{"username":"…","password":"…"}'
```

```js
const res = await fetch('/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "user": {
    "id": "66f1a2b3c4d5e6f708192a3b",
    "name": "Kavya R",
    "username": "kavya",
    "role": "admin",
    "ownerEmail": null
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | username and password are required |
| `401` | Invalid credentials |

Served by `backend/controllers/authController.js`.

### `GET /api/auth/me`

**Any logged-in user.** Who the current token belongs to. Used to restore a session on page load.

**Request**

```bash
curl 'http://localhost:3000/api/auth/me' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/auth/me', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "user": {
    "id": "66f1…",
    "name": "Kavya R",
    "username": "kavya",
    "role": "admin",
    "ownerEmail": null
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `401` | Not authenticated / Invalid or expired token |

Served by `backend/controllers/authController.js`.

---

## Follow-ups

The Follow-ups tab. A sales user only ever receives tasks they own — the filtering happens on the server (taskController scopes by `Owner.email`), not in the UI.

### `GET /api/tasks`

**Any logged-in user.** Every follow-up, newest first, served from a warm cache. Admins get all; a rep gets their own.

> No query params — the whole list comes down and the dashboard filters it client-side (see frontend/src/taskStats.js). The tab re-polls this every 15s.

**Request**

```bash
curl 'http://localhost:3000/api/tasks' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/tasks', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 412,
  "data": [
    {
      "id": "contact_4876…",
      "zohoId": "4876000000123456",
      "receivedAt": "2026-08-11T06:12:44.101Z",
      "taskCategory": "Counseling call",
      "leadSource": "Facebook Ads",
      "body": {
        "Subject": "Follow up — CA Inter",
        "Status": "Not Started",
        "Priority": "High",
        "Due_Date": "2026-08-12",
        "Owner": {
          "name": "Veera",
          "email": "veera@focasedu.com"
        },
        "Who_Id": {
          "name": "Rahul S",
          "phone": "+919876543210"
        }
      }
    }
  ]
}
```

Served by `backend/controllers/taskController.js`.

### `GET /api/tasks/:id`

**Any logged-in user.** One follow-up with its full history: notes, status changes, WhatsApp log, and the acquisition block.

> `acquisition` says where the lead came from. Its `cost` sub-object is written ONLY for admins — a rep's response has no cost key at all, so ad spend is not inferable from a rep session.

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `:id` | string | The `id` from the list (dedupeKey). A zohoId or Mongo _id is accepted too. |

**Request**

```bash
curl 'http://localhost:3000/api/tasks/:id' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/tasks/:id', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "zohoSync": true,
  "data": {
    "id": "contact_4876…",
    "statusHistory": [
      {
        "status": "In Progress",
        "changedAt": "2026-08-10T09:00:00.000Z",
        "source": "dashboard"
      }
    ],
    "notes": [
      {
        "text": "Asked to call back Tuesday",
        "author": "veera",
        "createdAt": "2026-08-10T09:01:00.000Z",
        "syncedToZoho": true
      }
    ],
    "whatsappLog": [],
    "acquisition": {
      "source": "web",
      "utmCampaign": "ca-inter-aug",
      "campaign": {
        "id": "120210…",
        "name": "CA Inter — Aug"
      },
      "cost": {
        "perLead": 184.5,
        "units": "rupees"
      }
    }
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `403` | Not your task |
| `404` | Task not found |

Served by `backend/controllers/taskController.js`.

### `PATCH /api/tasks/:id/status`

**Any logged-in user.** Move a follow-up along. Writes locally, then pushes to Bigin/Zoho.

> Returns the whole refreshed detail object, same shape as GET /api/tasks/:id.

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `status` | string | e.g. 'Not Started', 'In Progress', 'Completed'. |

**Request**

```bash
curl -X PATCH 'http://localhost:3000/api/tasks/:id/status' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"status":"…"}'
```

```js
const res = await fetch('/api/tasks/:id/status', {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "data": "…full task detail…",
  "zohoSync": {
    "ok": true
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | status is required |
| `403` | Not your task |

Served by `backend/controllers/taskController.js`.

### `POST /api/tasks/:id/notes`

**Any logged-in user.** Add a note. Mirrored into Zoho as a note on the contact when a zohoId exists.

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `text` | string | Non-empty. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/tasks/:id/notes' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"text":"…"}'
```

```js
const res = await fetch('/api/tasks/:id/notes', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "data": "…full task detail…",
  "zohoSync": {
    "ok": true,
    "skipped": false
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | Note text is required |

Served by `backend/controllers/taskController.js`.

### `POST /api/tasks/:id/whatsapp`

**Any logged-in user.** Send a WATI template to this lead's phone and log the send.

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `template` | string | Template name from GET /api/wati/templates. |
| `parameters` | array | Optional `[{ name, value }]` placeholders. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/tasks/:id/whatsapp' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"template":"…","parameters":[]}'
```

```js
const res = await fetch('/api/tasks/:id/whatsapp', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "data": "…full task detail…"
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | template is required / This lead has no phone number / WATI not configured |
| `502` | WATI rejected the send — the attempt is still logged on the task |

Served by `backend/controllers/taskController.js`.

---

## Ask (data assistant)

The Ask tab: a question in plain English, answered by querying this dashboard's own data and — for admins — Bigin live. READ-ONLY; no tool it can call writes anything. Open to reps as well as admins, because access control is applied per TOOL rather than at the router: every tool that reads owned data pins a rep to their own rows server-side, and the ones that cannot be scoped (ad spend, lead PII, provider billing, live Bigin lookups) refuse a rep by name. Needs OPENAI_API_KEY on the server; without it both endpoints still answer and report `configured: false`.

### `GET /api/agent/status`

**Any logged-in user.** Whether the assistant is configured, which model, and the tools this user may use.

**Request**

```bash
curl 'http://localhost:3000/api/agent/status' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/agent/status', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "configured": true,
  "model": "gpt-5",
  "isAdmin": false,
  "tools": [
    "query_tasks",
    "query_calls",
    "query_deals",
    "deal_outcomes",
    "run_aggregation"
  ]
}
```

Served by `backend/modules/agent/controllers/agentController.js`.

### `POST /api/agent/chat`

**Any logged-in user.** Ask a question. Returns the answer plus the tools it used to get there.

> Stateless: send the whole thread as `history` each turn and it comes back extended. Tool traffic from earlier turns is stripped server-side rather than replayed. `trace` is the provenance of the answer — every tool called, its arguments, and for run_aggregation the exact pipeline that ran, owner filter included. Rate limited to AGENT_RATE_MAX (default 20) questions per user per 5 minutes.

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `message` | string | The question. Required, up to 4000 characters. |
| `history` | array | The conversation so far, as `{role: "user"\|"assistant", content}`. Optional; the last 40 turns are kept. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/agent/chat' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"message":"…","history":[]}'
```

```js
const res = await fetch('/api/agent/chat', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "answer": "WhatsApp (organic/DM) closed 82 deals worth ₹14,91,315 …",
  "trace": [
    {
      "tool": "run_aggregation",
      "args": {
        "collection": "deals"
      },
      "ok": true,
      "rows": 8,
      "ms": 41
    }
  ],
  "rounds": 2,
  "tokens": {
    "prompt": 4210,
    "completion": 380,
    "total": 4590
  },
  "model": "gpt-5"
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | Ask a question. / Questions are limited to 4000 characters. |
| `429` | Too many questions — the limit is 20 every 5 minutes. |
| `502` | The model provider could not be reached, or rejected the request. |
| `503` | The assistant is not configured on this server — OPENAI_API_KEY is unset. |

Served by `backend/modules/agent/controllers/agentController.js`.

---

## Calls

The Calls tab and the call drawer. Reps are hard-scoped to their own calls in every handler (callController.ownerScope) — including by id, so a rep cannot open a peer's transcript or stream their recording. Admins may pass `?owner=<email>`.

### `GET /api/calls`

**Any logged-in user.** Paged call list with filters.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `agent` | string | TeleCMI agent extension. |
| `status` | string | transcriptionStatus: pending \| done \| failed … |
| `leadId` | string | Only calls matched to this lead. |
| `search` | string | Matches lead name, lead phone, from, or to. |
| `from / to` | YYYY-MM-DD | Call start date window (`to` is inclusive to 23:59:59). |
| `minDuration` | number | Seconds. Use 30+ to skip rings and misses. |
| `owner` | email | Admin only — ignored (overridden) for a rep. |
| `page` | number | Default 1. |
| `limit` | number | Default 50, capped at 200. |

**Request**

```bash
curl 'http://localhost:3000/api/calls?minDuration=45&from=2026-08-01&to=2026-08-11&limit=20' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls?minDuration=45&from=2026-08-01&to=2026-08-11&limit=20', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 1873,
  "page": 1,
  "data": [
    {
      "_id": "66f2…",
      "cmiuid": "cmi-9f21…",
      "agentExt": "1002",
      "ownerEmail": "veera@focasedu.com",
      "leadName": "Rahul S",
      "leadPhone": "+919876543210",
      "startedAt": "2026-08-11T05:41:00.000Z",
      "duration": 214,
      "hasRecording": true,
      "transcriptionStatus": "done",
      "grade": {
        "score": 78
      }
    }
  ]
}
```

Served by `backend/modules/calls/controllers/callController.js`.

### `GET /api/calls/stats`

**Any logged-in user.** Headline counters: total, with recording, matched to a lead, graded, and per-agent volume.

**Request**

```bash
curl 'http://localhost:3000/api/calls/stats' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls/stats', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "total": 1873,
  "withRecording": 1290,
  "matchedToLead": 1102,
  "graded": 1188,
  "byStatus": {
    "done": 1188,
    "pending": 84,
    "failed": 18
  },
  "byAgent": [
    {
      "agentExt": "1002",
      "calls": 612,
      "minutes": 2140
    }
  ]
}
```

Served by `backend/modules/calls/controllers/callController.js`.

### `GET /api/calls/outcomes`

**Any logged-in user.** Won/lost totals and the loss-reason breakdown. Reads Deals, so it counts closed deals with no recorded call too.

**Request**

```bash
curl 'http://localhost:3000/api/calls/outcomes' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls/outcomes', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "won": 184,
  "lost": 512,
  "wonValue": 4820000,
  "winRate": 26,
  "reasons": [
    {
      "reason": "Budget",
      "count": 143
    },
    {
      "reason": null,
      "count": 61
    }
  ],
  "byOwner": [
    {
      "ownerEmail": "veera@focasedu.com",
      "ownerName": "Veera",
      "won": 41,
      "lost": 96
    }
  ]
}
```

Served by `backend/modules/calls/controllers/callController.js`.

### `GET /api/calls/grades`

**Any logged-in user.** The Scorecard payload — AI call grades rolled up per rep, per criterion, per call type.

> `coverage.eligible` counts calls that CAN be graded (audio exists and is long enough). `noAudio` is reported beside it, not folded in — those rang and were never answered.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `period` | string | today \| yesterday \| 7d \| 30d. Omit for all time. |
| `outcome` | string | won \| lost. Omit for every call, which is the default. |
| `owner` | email | Admin only; a rep always gets their own. |

**Request**

```bash
curl 'http://localhost:3000/api/calls/grades?period=7d' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls/grades?period=7d', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "period": "7d",
  "coverage": {
    "graded": 96,
    "eligible": 104,
    "noAudio": 41,
    "dialled": 168,
    "pct": 92
  },
  "overall": {
    "gradeable": 96,
    "notGradeable": 6,
    "avg": 71,
    "median": 74,
    "bands": {
      "best": 8,
      "good": 51,
      "ok": 27,
      "weak": 10
    }
  },
  "perRep": [
    {
      "name": "Veera",
      "ownerEmail": "veera@focasedu.com",
      "totalCalls": 61,
      "connectedCalls": 44,
      "calls": 38,
      "avg": 76,
      "median": 78,
      "best": 94,
      "worst": 41,
      "bands": {
        "best": 4,
        "good": 22,
        "ok": 9,
        "weak": 3
      },
      "joinedAt": "2026-02-03T06:11:00.000Z"
    }
  ],
  "byCallType": [
    {
      "type": "discovery",
      "calls": 52,
      "avg": 74
    }
  ],
  "byCriterion": [
    {
      "criterion": "discovery",
      "calls": 96,
      "pct": 62
    }
  ],
  "recentDays": [
    {
      "date": "2026-08-11",
      "calls": 14,
      "avg": 73,
      "best": 2
    }
  ],
  "topCalls": [
    {
      "id": "66f2…",
      "lead": "Rahul S",
      "rep": "Veera",
      "score": 94,
      "callType": "closing",
      "summary": "Handled the fee objection and booked the payment.",
      "minutes": 7
    }
  ],
  "bottomCalls": []
}
```

Served by `backend/modules/calls/controllers/callController.js`.

### `GET /api/calls/journeys`

**Any logged-in user.** Closed leads with all their calls attached — a sale is a journey of several calls. Covers won AND lost.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `outcome` | string | won \| lost. Omit for both. |
| `reason` | string | Exact lost reason. |
| `upsold` | string | yes \| no — whether Bigin's Up_Scale is set. |
| `from / to` | YYYY-MM-DD | Deal CLOSING date window. |
| `search` | string | Lead name / phone / deal name. |
| `status` | string | Call-level transcription status. |
| `minDuration` | number | Call-level, seconds. |
| `minCalls` | number | Journeys with at least this many calls. |
| `hasCalls` | string | yes \| no. |
| `owner` | email | Admin only. |
| `page / limit` | number | Default 1 / 50. |

**Request**

```bash
curl 'http://localhost:3000/api/calls/journeys?outcome=lost&minCalls=2&limit=25' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls/journeys?outcome=lost&minCalls=2&limit=25', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 512,
  "withCalls": 288,
  "withoutCalls": 224,
  "page": 1,
  "pages": 11,
  "data": [
    {
      "_id": "4876000000123456",
      "contactName": "Rahul S",
      "phone": "+919876543210",
      "outcome": "lost",
      "lostReason": "Budget",
      "upScale": null,
      "amount": 45000,
      "closingDate": "2026-07-28",
      "ownerEmail": "veera@focasedu.com",
      "products": [
        "CA Inter"
      ],
      "totalCalls": 4,
      "totalDuration": 1841,
      "longestCall": 812,
      "transcribed": 4,
      "pending": 0,
      "avgScore": 63.5,
      "firstCall": "2026-07-14T04:22:00.000Z",
      "lastCall": "2026-07-27T11:05:00.000Z",
      "calls": [
        {
          "_id": "66f2…",
          "startedAt": "2026-07-21T05:41:00.000Z",
          "duration": 214,
          "direction": "outbound",
          "agentExt": "1002",
          "ownerEmail": "veera@focasedu.com",
          "transcriptionStatus": "done",
          "hasRecording": true,
          "score": 61
        }
      ],
      "deal": {
        "id": "4876000000123456",
        "name": "Rahul S — CA Inter",
        "stage": "Closed Lost",
        "ownerName": "Veera",
        "lostReason": "Budget"
      }
    }
  ]
}
```

Served by `backend/modules/calls/controllers/callController.js`.

### `GET /api/calls/:id`

**Any logged-in user.** One call with its full transcript and grade breakdown.

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `:id` | ObjectId | The call's Mongo `_id` from the list. |

**Request**

```bash
curl 'http://localhost:3000/api/calls/:id' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls/:id', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "data": {
    "_id": "66f2…",
    "transcript": [
      {
        "speaker": "agent",
        "text": "Good morning…",
        "start": 0.4
      }
    ],
    "grade": {
      "score": 78,
      "breakdown": {
        "callType": "discovery",
        "criteria": [
          {
            "name": "rapport",
            "score": 8,
            "note": "…"
          }
        ]
      }
    }
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `403` | Not your call |
| `404` | Call not found |

Served by `backend/modules/calls/controllers/callController.js`.

### `GET /api/calls/:id/recording`

**Any logged-in user.** Stream the recording as browser-playable audio/mpeg. Supports Range, so the player can seek.

> Not JSON. Proxied and transcoded through the server so the TeleCMI secret never reaches the browser, then cached. Use it directly as an <audio> src.

**Request**

```bash
curl 'http://localhost:3000/api/calls/:id/recording' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls/:id/recording', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response**

```http
HTTP/1.1 200 OK
Content-Type: audio/mpeg
Cache-Control: private, max-age=86400

<binary audio>
```

**Errors**

| Status | Message |
| --- | --- |
| `403` | Not your call |
| `404` | No recording for this call — or TeleCMI has not published the audio yet |
| `502` | Could not fetch recording |

Served by `backend/modules/calls/controllers/callController.js`.

### `GET /api/calls/pipeline-health`

**Admin only.** Is anything falling through the cracks? Read-only view of the audit the scheduler runs.

> `recoverable` is the number that means something is wrong: calls with audio that nothing is working on. The hourly audit re-queues those. Whole-system, hence admin-only.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `graceMinutes` | number | How long a call may sit unprocessed before it counts as stuck. |

**Request**

```bash
curl 'http://localhost:3000/api/calls/pipeline-health' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls/pipeline-health', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "healthy": false,
  "recoverable": 3,
  "unscorable": {
    "transcribeFailed": 11,
    "gradeFailed": 2
  },
  "pending": {
    "transcription": 8,
    "grading": 1
  }
}
```

Served by `backend/modules/calls/controllers/callController.js`.

### `GET /api/calls/usage`

**Admin only.** What the AI pipeline has spent (Sarvam tokens, ElevenLabs audio) and what balance is left.

> Account-wide billing data, so admin-only. Each provider's balance failure is reported inside its own card — a broken ElevenLabs key never blanks the Sarvam numbers.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `days` | number | Window for the daily series. Clamped to 7–90, default 30. |
| `refresh` | '1' | Force a fresh ElevenLabs balance instead of the cached one. |

**Request**

```bash
curl 'http://localhost:3000/api/calls/usage?days=14' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/calls/usage?days=14', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "days": 14,
  "providers": {
    "sarvam": {
      "label": "Sarvam AI",
      "purpose": "Call grading (LLM)",
      "configured": true,
      "model": "sarvam-105b",
      "unit": "tokens",
      "balance": {
        "remaining": 812000
      },
      "lifetime": {
        "gradedCalls": 1188
      }
    },
    "elevenlabs": {
      "label": "ElevenLabs",
      "purpose": "Call transcription (speech-to-text)",
      "unit": "audio",
      "lifetime": {
        "transcribedCalls": 1206,
        "transcribedSeconds": 402118
      }
    }
  }
}
```

Served by `backend/modules/calls/controllers/usageController.js`.

### `POST /api/calls/sync`

**Admin only.** Pull recent answered calls from TeleCMI now (incremental, idempotent on cmiuid).

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `days` | number | How far back to pull. Default 2. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/calls/sync' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"days":0}'
```

```js
const res = await fetch('/api/calls/sync', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "created": 37,
  "updated": 112,
  "days": 2
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | TeleCMI not configured |
| `409` | A sync is already running |
| `502` | TeleCMI rejected the pull |

Served by `backend/modules/calls/controllers/callController.js`.

---

## Installments & Upsells

Deliberately NOT admin-only, unlike the rest of the calls module: every rep needs their own chase list. The controllers scope non-admins to their own deals.

### `GET /api/installments`

**Any logged-in user.** Won deals with a balance outstanding, longest-overdue first.

**Request**

```bash
curl 'http://localhost:3000/api/installments' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/installments', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 63,
  "totalPending": 1284000,
  "totalPaid": 3536000,
  "upsold": 11,
  "data": [
    {
      "id": "4876…",
      "dealName": "Rahul S — CA Inter",
      "contactName": "Rahul S",
      "contactPhone": "+919876543210",
      "ownerName": "Veera",
      "amount": 45000,
      "paid": 20000,
      "pending": 25000,
      "closingDate": "2026-06-14",
      "upScale": null
    }
  ]
}
```

Served by `backend/modules/calls/controllers/installmentController.js`.

### `GET /api/upsells`

**Any logged-in user.** Won deals with Up_Scale set, newest first, priced against the product baseline.

> `noUpliftCount` is upsells that booked no extra money — almost always a data-entry miss in Bigin.

**Request**

```bash
curl 'http://localhost:3000/api/upsells' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/upsells', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 24,
  "wonCount": 184,
  "upsellRate": 13,
  "totalValue": 1104000,
  "totalUplift": 288000,
  "pendingValue": 214000,
  "noUpliftCount": 2,
  "data": [
    {
      "id": "4876…",
      "dealName": "Rahul S — CA Final",
      "upScale": "CA Final",
      "amount": 62000,
      "uplift": 17000
    }
  ]
}
```

Served by `backend/modules/calls/controllers/upsellController.js`.

---

## Analytics

The Analytics tab. One cached aggregate over every task; admin-only.

### `GET /api/analytics`

**Admin only.** Status / priority / due-date rollups and per-rep activity across all follow-ups.

> Served from a short-lived cache and de-duplicated in flight: two simultaneous callers share one computation rather than queueing a second full scan. Registered sales users with zero tasks are included, so a rep who did nothing shows as a row of zeros rather than vanishing from the table.

**Request**

```bash
curl 'http://localhost:3000/api/analytics' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/analytics', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "totals": {
    "total": 412,
    "completed": 61,
    "overdue": 63,
    "inProgress": 141,
    "salespeople": 5,
    "completionRate": 15
  },
  "users": [
    {
      "email": "veera@focasedu.com",
      "name": "Veera",
      "username": "veera",
      "registered": true,
      "total": 96,
      "completed": 21,
      "inProgress": 34,
      "notStarted": 41,
      "overdue": 12,
      "dueToday": 4,
      "notes": 143,
      "actions": 61,
      "completionRate": 22
    }
  ]
}
```

Served by `backend/controllers/analyticsController.js`.

---

## Marketing / Ads

Everything behind the Marketing, Sources and Ad Leads tabs. ADMIN ONLY WITHOUT EXCEPTION — ad spend, cost per lead and raw lead PII are management data. The gate is one `router.use(authenticate, requireAdmin)` above every handler, so a route added later cannot be born unprotected. TWO CURRENCIES: insight `spend` is in RUPEES, campaign/ad-set budgets are in PAISE. That is Meta's split, and every money response carries a `units` block naming which is which — format from that, never assume.

### `GET /api/ads/summary`

**Admin only.** Spend, impressions, clicks, CTR, CPC, leads and CPL for a date range.

> Scoped to CAMPAIGN-level insight rows. The mirror holds account-level rows for the same days too, so summing across levels would count every rupee twice.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `from / to` | YYYY-MM-DD | Default: the last 30 days. Both are inclusive. |

**Request**

```bash
curl 'http://localhost:3000/api/ads/summary?from=2026-08-01&to=2026-08-11' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/summary?from=2026-08-01&to=2026-08-11', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "data": {
    "range": {
      "from": "2026-08-01",
      "to": "2026-08-11"
    },
    "spend": 184220.5,
    "impressions": 1420331,
    "reach": 918240,
    "clicks": 18442,
    "ctr": 1.2984,
    "cpc": 9.99,
    "leads": 998,
    "cpl": 184.59,
    "insightRows": 231,
    "level": "campaign",
    "units": {
      "spend": "rupees",
      "budget": "paise"
    }
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | Invalid 'from' date: expected YYYY-MM-DD / 'from' is after 'to' |

Served by `backend/modules/ads/routes/ads.js`.

### `GET /api/ads/campaigns`

**Admin only.** One row per campaign that spent anything in the range, with its metadata.

> Only campaigns WITH insight rows in the range appear. A campaign archived at Meta but still carrying spend comes back with `known: false` and a null name — dropping it would lose spend from a table that has to add up to the summary.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `from / to` | YYYY-MM-DD | Default: the last 30 days. |

**Request**

```bash
curl 'http://localhost:3000/api/ads/campaigns' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/campaigns', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 14,
  "data": [
    {
      "campaignId": "120210…",
      "name": "CA Inter — Aug",
      "known": true,
      "status": "ACTIVE",
      "dailyBudget": 250000,
      "spend": 42180.25,
      "clicks": 4120,
      "leads": 231,
      "cpl": 182.6
    }
  ],
  "units": {
    "spend": "rupees",
    "budget": "paise"
  }
}
```

Served by `backend/modules/ads/routes/ads.js`.

### `GET /api/ads/insights`

**Admin only.** The stored insight rows behind every number above — the "show me the receipts" endpoint.

> Returned exactly as stored — nothing is derived or reshaped here.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `from / to` | YYYY-MM-DD | Default: the last 30 days. |
| `level` | string | account \| campaign \| adset \| ad. |
| `campaignId` | string | Narrow to one campaign. |
| `limit` | number | Default 500, 1–5000. |

**Request**

```bash
curl 'http://localhost:3000/api/ads/insights?level=adset&campaignId=120210…&limit=100' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/insights?level=adset&campaignId=120210…&limit=100', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 100,
  "total": 1841,
  "data": [
    {
      "id": "66f3…",
      "level": "adset",
      "entityId": "1234…",
      "campaignId": "120210…",
      "dateStart": "2026-08-11",
      "dateStop": "2026-08-11",
      "spend": 3120.4,
      "impressions": 24110
    }
  ]
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | Invalid level 'x'. Expected one of: account, campaign, adset, ad |

Served by `backend/modules/ads/routes/ads.js`.

### `GET /api/ads/leads`

**Admin only.** The Ad Leads tab: web-form and Meta lead-form submissions, with their attribution.

> Use `unresolved=true` for the fix-me pile, not a null campaign id — an already-triaged "no campaign" lead also has a null id, so filtering on the column alone hands back a stack of already-answered questions. Each row carries a `status`, resolved from the Deal mirror FIRST and the follow-up Task second, because a contact with a closed-won deal has bought whatever their task still says: `won` / `lost` / `pipeline` (a deal exists and is open) / `followup` (a task but no deal) / `none` (nobody picked it up). `status.matchedBy` is carried out because the two joins are NOT equally strong: `lead-id` is Meta's own id on both sides — a fact; `phone` is a 10-digit key a family or a reused handset can share — an inference. A web lead can only ever match by phone. Check `truncated`: `status` and the Meta `linked` filter cannot be expressed in the query, so they are applied after the per-source cap, and a capped page is an upper bound rather than a complete answer.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `from / to` | YYYY-MM-DD | Default: the last 30 days. Half-open on the upper bound, so `to` is fully included. |
| `source` | string | web \| meta. |
| `linked / unlinked` | boolean | Whether the lead is joined to a follow-up task. `unlinked=true` and `linked=false` are the same filter. |
| `unresolved` | boolean | WORKLIST: UTM strings nobody has mapped to a campaign yet. |
| `unmapped` | boolean | Leads an admin already triaged as having no Meta campaign (Google traffic, tests). |
| `campaignId` | string | Resolved campaign. |
| `status` | string | won \| lost \| pipeline \| followup \| none — see the note. |
| `limit` | number | Default 200, 1–1000. Applied PER SOURCE before the merge. |

**Request**

```bash
curl 'http://localhost:3000/api/ads/leads?source=web&unresolved=true&limit=50' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/leads?source=web&unresolved=true&limit=50', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 50,
  "totals": {
    "web": 812,
    "meta": 186,
    "all": 998
  },
  "truncated": false,
  "range": {
    "from": "2026-07-13",
    "to": "2026-08-11"
  },
  "filters": {
    "source": "web",
    "unresolved": true,
    "campaignId": null,
    "status": null,
    "limit": 50
  },
  "data": [
    {
      "id": "66f4…",
      "source": "web",
      "capturedAt": "2026-08-11T05:02:11.000Z",
      "name": "Rahul S",
      "email": "rahul@example.com",
      "phone": "+919876543210",
      "phoneKey": "9876543210",
      "form": "counseling-form",
      "utm": {
        "source": "fb",
        "medium": "paid",
        "campaign": "ca-inter-aug",
        "content": null,
        "term": null
      },
      "campaignId": "120210…",
      "campaignName": "CA Inter — Aug",
      "resolvedBy": "exact",
      "linked": true,
      "task": {
        "id": "66f1…",
        "name": "Rahul S",
        "phone": "+919876543210"
      },
      "status": {
        "state": "won",
        "stage": "Closed with Sale",
        "taskStatus": "Completed",
        "amount": 45000,
        "closingDate": "2026-08-09",
        "matchedBy": "phone"
      }
    }
  ]
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | Invalid source 'x'. Expected 'web' or 'meta'. |
| `400` | Invalid status 'x'. Expected one of won, lost, pipeline, followup, none. |

Served by `backend/modules/ads/routes/ads.js`.

### `GET /api/ads/sources`

**Admin only.** The Sources tab: which lead source closed the deal, and the campaign behind it.

> The default really is all time, unlike every other ads route — you cannot judge a channel on 30 days of a business with 184 lifetime sales. `spend` is the campaign's LIFETIME in the insight mirror while `revenue` is only the window's deals, so `roas` ranks campaigns against each other; it does not audit a return.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `from / to` | YYYY-MM-DD | OPTIONAL here, and both-or-neither. Windows deal CLOSING dates; omit for all time. |

**Request**

```bash
curl 'http://localhost:3000/api/ads/sources' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/sources', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "data": {
    "bySource": [
      {
        "source": "Facebook Ads",
        "won": 61,
        "revenue": 1840000
      }
    ],
    "fromAds": {
      "available": true,
      "wonWithLeadId": 84,
      "tracedToCampaign": 71,
      "unmatchedLeadIds": 13,
      "spendBasis": "campaign lifetime in the insight mirror",
      "campaigns": [
        {
          "campaignId": "120210…",
          "name": "CA Inter — Aug",
          "won": 22,
          "revenue": 684000,
          "spend": 142100.5,
          "roas": 4.81,
          "cac": 6459
        }
      ]
    }
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | Provide both 'from' and 'to', or neither. |

Served by `backend/modules/ads/routes/ads.js`.

### `GET /api/ads/reconciliation`

**Admin only.** Does account-level spend agree with the sum of campaign-level spend?

> Two independent pulls from Meta, so a gap is a real signal with two plausible causes: spend not attached to any campaign, or a sync that did not finish. The endpoint cannot tell them apart and does not try. `comparable: false` means "run a sync", not "reconciled".

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `from / to` | YYYY-MM-DD | Default: the last 30 days. |

**Request**

```bash
curl 'http://localhost:3000/api/ads/reconciliation' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/reconciliation', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "data": {
    "range": {
      "from": "2026-07-13",
      "to": "2026-08-11"
    },
    "accountSpend": 184900,
    "campaignSpend": 184220.5,
    "difference": 679.5,
    "accountRows": 30,
    "campaignRows": 231,
    "comparable": true,
    "units": {
      "spend": "rupees"
    }
  }
}
```

Served by `backend/modules/ads/routes/ads.js`.

### `GET /api/ads/campaign-aliases`

**Admin only.** The UTM → campaign alias table, plus the worklist it exists to shrink.

> An alias is an operator's assertion that a raw `utm_campaign` string means a particular Meta campaign — or that it means no campaign at all. `unresolved` is every tagged UTM that resolved to nothing AND has no alias row, ordered by lead count: that ordering says what the next alias is worth, in leads. A deliberately-unmapped UTM is absent from it, because leaving a triaged string on the worklist forever is the problem the table solves.

**Request**

```bash
curl 'http://localhost:3000/api/ads/campaign-aliases' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/campaign-aliases', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 12,
  "unresolvedLeads": 143,
  "data": [
    {
      "key": "cainteraug",
      "utmCampaign": "CA-Inter Aug",
      "campaignId": "120210…",
      "campaignName": "CA Inter — Aug",
      "mapped": true,
      "campaignKnown": true,
      "note": "Landing page tags it with a space.",
      "leads": 231,
      "spellings": [
        {
          "utmCampaign": "CA-Inter Aug",
          "leads": 190
        },
        {
          "utmCampaign": "ca_inter_aug",
          "leads": 41
        }
      ],
      "createdBy": {
        "id": "66f1…",
        "name": "Kavya R"
      },
      "updatedBy": null,
      "createdAt": "2026-07-02T10:14:00.000Z",
      "updatedAt": "2026-07-02T10:14:00.000Z"
    }
  ],
  "unresolved": [
    {
      "key": "summerpush",
      "utmCampaign": "summer-push",
      "leads": 88
    }
  ]
}
```

Served by `backend/modules/ads/routes/campaignAliases.js`.

### `POST /api/ads/campaign-aliases`

**Admin only.** Create — or overwrite — one alias. Idempotent.

> The key is derived from `utmCampaign`, so posting the same alias twice is one upsert on one row — the second call answers 200 with `created: false` and leaves createdBy/createdAt alone. A campaignId that is not in the mirror is REFUSED: a typo would otherwise attribute leads to a campaign with no name, no spend and no CPL, which looks resolved and shows nothing. Adding an alias changes what FUTURE resolutions do — existing leads keep their stored campaign until `scripts/resolveLeadCampaigns.js` is re-run.

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `utmCampaign` | string | The raw UTM string. Required. The key is derived from it. |
| `campaignId` | string \| null | Meta campaign id. Omit or send null to record "this UTM has no Meta campaign". |
| `note` | string | Why, for the next person. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/ads/campaign-aliases' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"utmCampaign":"…","campaignId":"…","note":"…"}'
```

```js
const res = await fetch('/api/ads/campaign-aliases', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "created": true,
  "data": {
    "key": "summerpush",
    "utmCampaign": "summer-push",
    "campaignId": "120211…",
    "mapped": true,
    "note": null
  },
  "message": "Alias created. Re-run scripts/resolveLeadCampaigns.js to apply it to existing leads."
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | utmCampaign is required. |
| `400` | '…' has no letters or digits, so it cannot be aliased. |
| `400` | No campaign '…' in the mirror. Sync first, or check the id. |

Served by `backend/modules/ads/routes/campaignAliases.js`.

### `PUT /api/ads/campaign-aliases/:key`

**Admin only.** Change what an existing alias points at.

> The raw UTM string is NOT editable here: change it and you have a different alias, so POST that one and DELETE this one.

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `:key` | string | The NORMALIZED key from the list endpoint, not the raw UTM string — the raw one may contain spaces and punctuation a URL path would mangle. |

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `campaignId` | string \| null | Omit to leave it as it is. |
| `note` | string | Omit to leave it as it is. |

**Request**

```bash
curl -X PUT 'http://localhost:3000/api/ads/campaign-aliases/:key' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"campaignId":"…","note":"…"}'
```

```js
const res = await fetch('/api/ads/campaign-aliases/:key', {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "data": {
    "key": "summerpush",
    "utmCampaign": "summer-push",
    "campaignId": null,
    "mapped": false,
    "note": "Google Ads traffic."
  },
  "message": "Alias updated. Re-run scripts/resolveLeadCampaigns.js to apply it to existing leads."
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | No campaign '…' in the mirror. |
| `404` | No alias '…'. |

Served by `backend/modules/ads/routes/campaignAliases.js`.

### `DELETE /api/ads/campaign-aliases/:key`

**Admin only.** Untriage a UTM string — put it back on the unresolved worklist.

> The leads this alias already resolved KEEP their stored campaign until the backfill is re-run — deleting an alias does not silently un-attribute history behind the operator's back. `leads` tells you how big the pile you just put back is.

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `:key` | string | The normalized key. |

**Request**

```bash
curl -X DELETE 'http://localhost:3000/api/ads/campaign-aliases/:key' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/campaign-aliases/:key', {
  method: 'DELETE',
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "deleted": true,
  "data": {
    "key": "summerpush",
    "utmCampaign": "summer-push",
    "campaignId": null,
    "mapped": false
  },
  "leads": 88,
  "message": "Alias deleted. 88 lead(s) still carry its stored result; re-run scripts/resolveLeadCampaigns.js to clear them."
}
```

**Errors**

| Status | Message |
| --- | --- |
| `404` | No alias '…'. |

Served by `backend/modules/ads/routes/campaignAliases.js`.

### `GET /api/ads/sync/history`

**Admin only.** The sync audit trail, newest first — plus whether one is running right now.

> Poll this for progress after POST /api/ads/sync — that call returns before the work finishes.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `limit` | number | Default 50, 1–200. |
| `resource` | string | campaigns \| adsets \| ads \| insights \| leads. |

**Request**

```bash
curl 'http://localhost:3000/api/ads/sync/history' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/ads/sync/history', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 50,
  "running": false,
  "configured": true,
  "cplCache": {
    "entries": 14,
    "ageMs": 41200
  },
  "data": [
    {
      "id": "66f5…",
      "resource": "insights",
      "startedAt": "2026-08-11T04:00:00.000Z",
      "finishedAt": "2026-08-11T04:03:41.000Z",
      "upserted": 231,
      "ok": true
    }
  ]
}
```

Served by `backend/modules/ads/routes/ads.js`.

### `POST /api/ads/sync`

**Admin only.** Start a full Meta sync now. Answers 202 once the run has STARTED, not when it finishes.

> A full sync runs for minutes; holding the request open would hit every proxy timeout between here and the browser. Watch GET /api/ads/sync/history instead. Rate-limited to 5 requests per 5 minutes.

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `from / to` | YYYY-MM-DD | Optional, both-or-neither. Omit to sync the default window. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/ads/sync' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"from":"…"}'
```

```js
const res = await fetch('/api/ads/sync', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "accepted": true,
  "startedAt": "2026-08-11T09:14:22.000Z",
  "range": null
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | Provide both 'from' and 'to', or neither. |
| `409` | A sync is already in progress. Try again once it finishes. |
| `429` | Sync requested too frequently. Please wait a few minutes. |
| `503` | Meta is not configured (set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID). |

Served by `backend/modules/ads/routes/ads.js`.

---

## Web lead ingest

The ONE unauthenticated write surface in this backend — the Focas landing pages post captured leads here. It carries no user session, but it is not open: it owns its own CORS allowlist (CORS_ORIGINS), a shared secret (LEAD_INGEST_TOKEN), and a per-IP rate limit. app.js mounts it ahead of every authenticated router so its openness cannot leak sideways onto a neighbouring route.

### `POST /api/leads/web`

**No auth.** Capture a landing-page lead with the UTM tags from the click URL.

> Any field NOT in that table is DROPPED — that is what stops a caller setting the resolution fields (phoneKey, resolvedCampaignId, resolvedBy, linkedTaskId) itself. A hidden `company` field is a honeypot: if it arrives filled, the response is a normal 202 and nothing is stored, so a bot cannot tell a rejection from an acceptance. Campaign resolution and task linking run before the response, but can never fail it — a lead is worth more than its attribution.

**Headers**

| Name | Description |
| --- | --- |
| `X-Lead-Ingest-Token` | The LEAD_INGEST_TOKEN shared secret. Compared in constant time. |
| `Content-Type` | application/json |

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `name / firstName / lastName` | string | ≤ 200 chars each. |
| `email` | string | ≤ 200. Lenient — an unparseable email is still a lead worth having. |
| `phone` | string \| number | ≤ 40. A number is accepted and stringified. |
| `caStatus / attempt / language` | string | Qualification answers, ≤ 100. |
| `city / state` | string | ≤ 120. |
| `utmSource / utmMedium` | string | ≤ 200. |
| `utmCampaign / utmContent / utmTerm` | string | ≤ 300. |
| `landingUrl / referrer` | string | ≤ 2000. |
| `source` | string | ≤ 120, e.g. 'counseling-form'. |
| `biginContactId` | string | ≤ 120. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/leads/web' \
  -H 'X-Lead-Ingest-Token: <value>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"…","email":"…","phone":0,"caStatus":"…","city":"…","utmSource":"…","utmCampaign":"…","landingUrl":"…","source":"…","biginContactId":"…"}'
```

```js
const res = await fetch('/api/leads/web', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Lead-Ingest-Token': '<value>',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "ok": true,
  "id": "66f4a1b2c3d4e5f607182930"
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | Invalid request — with an `errors` array naming each field |
| `401` | Missing or bad X-Lead-Ingest-Token |
| `429` | Too many submissions. Please try again shortly. (60/min per IP; WEB_LEAD_RATE_MAX) |

Served by `backend/modules/ads/controllers/webLeadController.js`.

### `GET /api/leads/web`

**Admin only.** Stored web leads, newest first.

> Every row is raw lead PII, so JWT + admin. The retired CRM served this openly; that was a defect.

**Query parameters**

| Name | Type | Description |
| --- | --- | --- |
| `limit` | number | Default 500, 1–1000. |

**Request**

```bash
curl 'http://localhost:3000/api/leads/web' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/leads/web', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 500,
  "data": [
    {
      "id": "66f4…",
      "name": "Rahul S",
      "phone": "+919876543210",
      "utmCampaign": "ca-inter-aug",
      "createdAt": "2026-08-11T05:02:11.000Z"
    }
  ]
}
```

Served by `backend/modules/ads/controllers/webLeadController.js`.

---

## WhatsApp, users & health

The remaining surfaces: WATI templates, user administration, and the liveness probe.

### `GET /api/wati/templates`

**Any logged-in user.** Approved WATI template names, for the WhatsApp composer in the task drawer.

> Always 200. `configured: false` with an `error` string is how "WATI is not set up" is reported — the composer says so instead of failing.

**Request**

```bash
curl 'http://localhost:3000/api/wati/templates' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/wati/templates', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "configured": true,
  "templates": [
    {
      "name": "followup_reminder",
      "parameters": [
        "name",
        "date"
      ]
    }
  ],
  "error": null
}
```

Served by `backend/controllers/watiController.js`.

### `GET /api/users`

**Admin only.** All dashboard users, oldest first. Password hashes are never returned.

**Request**

```bash
curl 'http://localhost:3000/api/users' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/users', {
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "users": [
    {
      "id": "66f1…",
      "name": "Veera",
      "username": "veera",
      "role": "sales",
      "ownerEmail": "veera@focasedu.com"
    }
  ]
}
```

Served by `backend/controllers/userController.js`.

### `POST /api/users`

**Admin only.** Create a sales or admin user.

**Request body (JSON)**

| Name | Type | Description |
| --- | --- | --- |
| `name` | string | Required. |
| `username` | string | Required, lowercased, unique. |
| `password` | string | Required. Hashed with bcrypt before storage. |
| `role` | string | 'admin' or 'sales'. Anything else becomes 'sales'. |
| `ownerEmail` | email | Required for sales users — their Zoho Owner email. This is what scopes every rep response. |

**Request**

```bash
curl -X POST 'http://localhost:3000/api/users' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"…","username":"…","password":"…","role":"…","ownerEmail":"…"}'
```

```js
const res = await fetch('/api/users', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ … }),
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "user": {
    "id": "66f6…",
    "name": "Divya",
    "username": "divya",
    "role": "sales",
    "ownerEmail": "divya@focasedu.com"
  }
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | name, username and password are required / ownerEmail is required for sales users |
| `409` | Username already exists |

Served by `backend/controllers/userController.js`.

### `DELETE /api/users/:id`

**Admin only.** Remove a user.

**Path parameters**

| Name | Type | Description |
| --- | --- | --- |
| `:id` | ObjectId | From GET /api/users. |

**Request**

```bash
curl -X DELETE 'http://localhost:3000/api/users/:id' \
  -H 'Authorization: Bearer <YOUR_TOKEN>'
```

```js
const res = await fetch('/api/users/:id', {
  method: 'DELETE',
  headers: {
    Authorization: `Bearer ${token}`,
  },
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true
}
```

**Errors**

| Status | Message |
| --- | --- |
| `400` | You cannot delete your own account |

Served by `backend/controllers/userController.js`.

### `GET /health`

**No auth.** Liveness probe. No auth, no database read.

**Request**

```bash
curl 'http://localhost:3000/health'
```

```js
const res = await fetch('/health', {
});
const json = await res.json();
```

**Response** `200`

```json
{
  "status": "ok"
}
```

Served by `backend/app.js`.

---

## Inbound webhooks

These are called BY third parties, not by you — listed so the whole surface is documented in one place. All three answer immediately and do the slow work after responding, because a webhook sender that times out retries. Bodies are parsed leniently: a malformed or NDJSON body is recovered from the raw bytes rather than 400-ing a lead away (app.js).

### `POST /webhook`

**No auth.** Zoho Flow posts a follow-up task here. Deduped by contact; a single object or an array both work.

> Two fields Zoho Flow never maps — the contact phone and `Task_Category` — are read back from the Bigin API AFTER the 200, then the task is re-upserted.

**Request**

```bash
curl -X POST 'http://localhost:3000/webhook'
```

```js
const res = await fetch('/webhook', {
  method: 'POST',
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "message": "Webhook received",
  "count": 1
}
```

Served by `backend/controllers/webhookController.js`.

### `GET /webhook`

**No auth.** Raw stored task bodies, newest first. Predates /api/tasks; kept for debugging.

> Unauthenticated and returns lead bodies. Use /api/tasks instead — that one is scoped per role. Do not expose this route publicly.

**Request**

```bash
curl 'http://localhost:3000/webhook'
```

```js
const res = await fetch('/webhook', {
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true,
  "count": 412,
  "data": [
    {
      "id": "4876…",
      "receivedAt": "2026-08-11T06:12:44.101Z",
      "body": {}
    }
  ]
}
```

Served by `backend/controllers/webhookController.js`.

### `POST /webhook/call`

**No auth.** TeleCMI posts a finished call here. The call is stored, then transcribed and graded in the background.

> Unrecognised payloads are answered 200 with the field names that arrived, so a changed TeleCMI schema shows up in the logs instead of vanishing into a retry loop.

**Request**

```bash
curl -X POST 'http://localhost:3000/webhook/call'
```

```js
const res = await fetch('/webhook/call', {
  method: 'POST',
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true
}
```

Served by `backend/modules/calls/controllers/callWebhookController.js`.

### `POST /webhook/deal`

**No auth.** Bigin posts a deal create/update here — this is what makes a call journey won or lost.

**Request**

```bash
curl -X POST 'http://localhost:3000/webhook/deal'
```

```js
const res = await fetch('/webhook/deal', {
  method: 'POST',
});
const json = await res.json();
```

**Response** `200`

```json
{
  "success": true
}
```

Served by `backend/modules/calls/controllers/callWebhookController.js`.

