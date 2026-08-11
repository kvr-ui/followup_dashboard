// The API reference the "API Docs" tab renders.
//
// ONE table, not prose scattered across components. Every entry is a real
// endpoint from backend/routes and backend/modules/*/routes — the group order
// below deliberately mirrors the dashboard's tab order, so "the Marketing tab
// gets its numbers from here" is answerable by scrolling.
//
// `auth` is the SERVER's rule, copied from the router that enforces it:
//   'public' — no token (webhooks + the landing-page ingest)
//   'user'   — any logged-in user; the controller scopes a rep to their own rows
//   'admin'  — authenticate + requireAdmin at the router
// Getting this wrong in the docs is worse than omitting it, so each entry names
// the file that gates it.

export const BASE_HINT =
  'Same origin as this dashboard. Locally the API listens on http://localhost:3000 ' +
  '(PORT), and the Vite dev server proxies to it — so relative paths like /api/tasks ' +
  'work from the browser either way.';

/** Roles that may call an endpoint, for the badge. */
const ADMIN = 'admin';
const USER = 'user';
const PUBLIC = 'public';

export const GROUPS = [
  // -------------------------------------------------------------------------
  {
    id: 'auth',
    title: 'Authentication',
    blurb:
      'Everything except the webhooks and the public lead ingest needs a JWT. Log in once, ' +
      'then send `Authorization: Bearer <token>` on every call. Tokens last 30 days; a 401 ' +
      'means expired, and the dashboard logs you out on it.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/auth/login',
        auth: PUBLIC,
        summary: 'Exchange username + password for a JWT.',
        source: 'backend/controllers/authController.js',
        body: [
          ['username', 'string', 'Case-insensitive.'],
          ['password', 'string', 'Required.'],
        ],
        response: {
          success: true,
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
          user: {
            id: '66f1a2b3c4d5e6f708192a3b',
            name: 'Kavya R',
            username: 'kavya',
            role: 'admin',
            ownerEmail: null,
          },
        },
        errors: [
          ['400', 'username and password are required'],
          ['401', 'Invalid credentials'],
        ],
      },
      {
        method: 'GET',
        path: '/api/auth/me',
        auth: USER,
        summary: 'Who the current token belongs to. Used to restore a session on page load.',
        source: 'backend/controllers/authController.js',
        response: {
          success: true,
          user: { id: '66f1…', name: 'Kavya R', username: 'kavya', role: 'admin', ownerEmail: null },
        },
        errors: [['401', 'Not authenticated / Invalid or expired token']],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'tasks',
    title: 'Follow-ups',
    blurb:
      'The Follow-ups tab. A sales user only ever receives tasks they own — the filtering ' +
      'happens on the server (taskController scopes by `Owner.email`), not in the UI.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/tasks',
        auth: USER,
        summary:
          'Every follow-up, newest first, served from a warm cache. Admins get all; a rep gets their own.',
        source: 'backend/controllers/taskController.js',
        note:
          'No query params — the whole list comes down and the dashboard filters it client-side ' +
          '(see frontend/src/taskStats.js). The tab re-polls this every 15s.',
        response: {
          success: true,
          count: 412,
          data: [
            {
              id: 'contact_4876…',
              zohoId: '4876000000123456',
              receivedAt: '2026-08-11T06:12:44.101Z',
              taskCategory: 'Counseling call',
              leadSource: 'Facebook Ads',
              body: {
                Subject: 'Follow up — CA Inter',
                Status: 'Not Started',
                Priority: 'High',
                Due_Date: '2026-08-12',
                Owner: { name: 'Veera', email: 'veera@focasedu.com' },
                Who_Id: { name: 'Rahul S', phone: '+919876543210' },
              },
            },
          ],
        },
      },
      {
        method: 'GET',
        path: '/api/tasks/:id',
        auth: USER,
        summary:
          'One follow-up with its full history: notes, status changes, WhatsApp log, and the acquisition block.',
        source: 'backend/controllers/taskController.js',
        params: [
          [
            ':id',
            'string',
            "The `id` from the list (dedupeKey). A zohoId or Mongo _id is accepted too.",
          ],
        ],
        note:
          '`acquisition` says where the lead came from. Its `cost` sub-object is written ONLY for ' +
          'admins — a rep\'s response has no cost key at all, so ad spend is not inferable from a ' +
          'rep session.',
        response: {
          success: true,
          zohoSync: true,
          data: {
            id: 'contact_4876…',
            statusHistory: [{ status: 'In Progress', changedAt: '2026-08-10T09:00:00.000Z', source: 'dashboard' }],
            notes: [{ text: 'Asked to call back Tuesday', author: 'veera', createdAt: '2026-08-10T09:01:00.000Z', syncedToZoho: true }],
            whatsappLog: [],
            acquisition: {
              source: 'web',
              utmCampaign: 'ca-inter-aug',
              campaign: { id: '120210…', name: 'CA Inter — Aug' },
              cost: { perLead: 184.5, units: 'rupees' },
            },
          },
        },
        errors: [
          ['403', 'Not your task'],
          ['404', 'Task not found'],
        ],
      },
      {
        method: 'PATCH',
        path: '/api/tasks/:id/status',
        auth: USER,
        summary: 'Move a follow-up along. Writes locally, then pushes to Bigin/Zoho.',
        source: 'backend/controllers/taskController.js',
        body: [['status', 'string', "e.g. 'Not Started', 'In Progress', 'Completed'."]],
        note: 'Returns the whole refreshed detail object, same shape as GET /api/tasks/:id.',
        response: { success: true, data: '…full task detail…', zohoSync: { ok: true } },
        errors: [
          ['400', 'status is required'],
          ['403', 'Not your task'],
        ],
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/notes',
        auth: USER,
        summary: 'Add a note. Mirrored into Zoho as a note on the contact when a zohoId exists.',
        source: 'backend/controllers/taskController.js',
        body: [['text', 'string', 'Non-empty.']],
        response: { success: true, data: '…full task detail…', zohoSync: { ok: true, skipped: false } },
        errors: [['400', 'Note text is required']],
      },
      {
        method: 'POST',
        path: '/api/tasks/:id/whatsapp',
        auth: USER,
        summary: "Send a WATI template to this lead's phone and log the send.",
        source: 'backend/controllers/taskController.js',
        body: [
          ['template', 'string', 'Template name from GET /api/wati/templates.'],
          ['parameters', 'array', 'Optional `[{ name, value }]` placeholders.'],
        ],
        response: { success: true, data: '…full task detail…' },
        errors: [
          ['400', 'template is required / This lead has no phone number / WATI not configured'],
          ['502', 'WATI rejected the send — the attempt is still logged on the task'],
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'agent',
    title: 'Ask (data assistant)',
    blurb:
      'The Ask tab: a question in plain English, answered by querying this dashboard\'s own ' +
      'data and — for admins — Bigin live. READ-ONLY; no tool it can call writes anything. ' +
      'Open to reps as well as admins, because access control is applied per TOOL rather than ' +
      'at the router: every tool that reads owned data pins a rep to their own rows server-side, ' +
      'and the ones that cannot be scoped (ad spend, lead PII, provider billing, live Bigin ' +
      'lookups) refuse a rep by name. Needs OPENAI_API_KEY on the server; without it both ' +
      'endpoints still answer and report `configured: false`.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/agent/status',
        auth: USER,
        summary: 'Whether the assistant is configured, which model, and the tools this user may use.',
        source: 'backend/modules/agent/controllers/agentController.js',
        response: {
          success: true,
          configured: true,
          model: 'gpt-5',
          isAdmin: false,
          tools: ['query_tasks', 'query_calls', 'query_deals', 'deal_outcomes', 'run_aggregation'],
        },
      },
      {
        method: 'POST',
        path: '/api/agent/chat',
        auth: USER,
        summary: 'Ask a question. Returns the answer plus the tools it used to get there.',
        source: 'backend/modules/agent/controllers/agentController.js',
        body: [
          ['message', 'string', 'The question. Required, up to 4000 characters.'],
          [
            'history',
            'array',
            'The conversation so far, as `{role: "user"|"assistant", content}`. Optional; the last 40 turns are kept.',
          ],
        ],
        note:
          'Stateless: send the whole thread as `history` each turn and it comes back extended. ' +
          'Tool traffic from earlier turns is stripped server-side rather than replayed. ' +
          '`trace` is the provenance of the answer — every tool called, its arguments, and for ' +
          'run_aggregation the exact pipeline that ran, owner filter included. Rate limited to ' +
          'AGENT_RATE_MAX (default 20) questions per user per 5 minutes.',
        response: {
          success: true,
          answer: 'WhatsApp (organic/DM) closed 82 deals worth ₹14,91,315 …',
          trace: [
            {
              tool: 'run_aggregation',
              args: { collection: 'deals' },
              ok: true,
              rows: 8,
              ms: 41,
            },
          ],
          rounds: 2,
          tokens: { prompt: 4210, completion: 380, total: 4590 },
          model: 'gpt-5',
        },
        errors: [
          ['400', 'Ask a question. / Questions are limited to 4000 characters.'],
          ['429', 'Too many questions — the limit is 20 every 5 minutes.'],
          ['502', 'The model provider could not be reached, or rejected the request.'],
          ['503', 'The assistant is not configured on this server — OPENAI_API_KEY is unset.'],
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'calls',
    title: 'Calls',
    blurb:
      'The Calls tab and the call drawer. Reps are hard-scoped to their own calls in every ' +
      'handler (callController.ownerScope) — including by id, so a rep cannot open a peer\'s ' +
      'transcript or stream their recording. Admins may pass `?owner=<email>`.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/calls',
        auth: USER,
        summary: 'Paged call list with filters.',
        source: 'backend/modules/calls/controllers/callController.js',
        query: [
          ['agent', 'string', 'TeleCMI agent extension.'],
          ['status', 'string', 'transcriptionStatus: pending | done | failed …'],
          ['leadId', 'string', 'Only calls matched to this lead.'],
          ['search', 'string', 'Matches lead name, lead phone, from, or to.'],
          ['from / to', 'YYYY-MM-DD', 'Call start date window (`to` is inclusive to 23:59:59).'],
          ['minDuration', 'number', 'Seconds. Use 30+ to skip rings and misses.'],
          ['owner', 'email', 'Admin only — ignored (overridden) for a rep.'],
          ['page', 'number', 'Default 1.'],
          ['limit', 'number', 'Default 50, capped at 200.'],
        ],
        example: '/api/calls?minDuration=45&from=2026-08-01&to=2026-08-11&limit=20',
        response: {
          success: true,
          count: 1873,
          page: 1,
          data: [
            {
              _id: '66f2…',
              cmiuid: 'cmi-9f21…',
              agentExt: '1002',
              ownerEmail: 'veera@focasedu.com',
              leadName: 'Rahul S',
              leadPhone: '+919876543210',
              startedAt: '2026-08-11T05:41:00.000Z',
              duration: 214,
              hasRecording: true,
              transcriptionStatus: 'done',
              grade: { score: 78 },
            },
          ],
        },
      },
      {
        method: 'GET',
        path: '/api/calls/stats',
        auth: USER,
        summary: 'Headline counters: total, with recording, matched to a lead, graded, and per-agent volume.',
        source: 'backend/modules/calls/controllers/callController.js',
        response: {
          success: true,
          total: 1873,
          withRecording: 1290,
          matchedToLead: 1102,
          graded: 1188,
          byStatus: { done: 1188, pending: 84, failed: 18 },
          byAgent: [{ agentExt: '1002', calls: 612, minutes: 2140 }],
        },
      },
      {
        method: 'GET',
        path: '/api/calls/outcomes',
        auth: USER,
        summary: 'Won/lost totals and the loss-reason breakdown. Reads Deals, so it counts closed deals with no recorded call too.',
        source: 'backend/modules/calls/controllers/callController.js',
        response: {
          success: true,
          won: 184,
          lost: 512,
          wonValue: 4820000,
          winRate: 26,
          reasons: [{ reason: 'Budget', count: 143 }, { reason: null, count: 61 }],
          byOwner: [{ ownerEmail: 'veera@focasedu.com', ownerName: 'Veera', won: 41, lost: 96 }],
        },
      },
      {
        method: 'GET',
        path: '/api/calls/grades',
        auth: USER,
        summary: 'The Scorecard payload — AI call grades rolled up per rep, per criterion, per call type.',
        source: 'backend/modules/calls/controllers/callController.js',
        query: [
          ['period', 'string', 'today | yesterday | 7d | 30d. Omit for all time.'],
          ['outcome', 'string', "won | lost. Omit for every call, which is the default."],
          ['owner', 'email', 'Admin only; a rep always gets their own.'],
        ],
        example: '/api/calls/grades?period=7d',
        note:
          '`coverage.eligible` counts calls that CAN be graded (audio exists and is long enough). ' +
          '`noAudio` is reported beside it, not folded in — those rang and were never answered.',
        response: {
          success: true,
          period: '7d',
          coverage: { graded: 96, eligible: 104, noAudio: 41, dialled: 168, pct: 92 },
          overall: {
            gradeable: 96,
            notGradeable: 6,
            avg: 71,
            median: 74,
            // Score bands, not label strings: best ≥90, good ≥70, ok ≥50, weak below.
            bands: { best: 8, good: 51, ok: 27, weak: 10 },
          },
          perRep: [
            {
              name: 'Veera',
              ownerEmail: 'veera@focasedu.com',
              totalCalls: 61, // every attempt, including calls that only rang
              connectedCalls: 44, // attempts that became a conversation
              calls: 38, // the graded, gradeable subset the score reflects
              avg: 76,
              median: 78,
              best: 94,
              worst: 41,
              bands: { best: 4, good: 22, ok: 9, weak: 3 },
              joinedAt: '2026-02-03T06:11:00.000Z',
            },
          ],
          byCallType: [{ type: 'discovery', calls: 52, avg: 74 }],
          // Normalised to a percentage of each criterion's max, weakest first —
          // that ordering IS the coaching priority.
          byCriterion: [{ criterion: 'discovery', calls: 96, pct: 62 }],
          recentDays: [{ date: '2026-08-11', calls: 14, avg: 73, best: 2 }],
          topCalls: [
            {
              id: '66f2…',
              lead: 'Rahul S',
              rep: 'Veera',
              score: 94,
              callType: 'closing',
              summary: 'Handled the fee objection and booked the payment.',
              minutes: 7,
            },
          ],
          bottomCalls: [],
        },
      },
      {
        method: 'GET',
        path: '/api/calls/journeys',
        auth: USER,
        summary:
          'Closed leads with all their calls attached — a sale is a journey of several calls. Covers won AND lost.',
        source: 'backend/modules/calls/controllers/callController.js',
        query: [
          ['outcome', 'string', 'won | lost. Omit for both.'],
          ['reason', 'string', 'Exact lost reason.'],
          ['upsold', 'string', "yes | no — whether Bigin's Up_Scale is set."],
          ['from / to', 'YYYY-MM-DD', 'Deal CLOSING date window.'],
          ['search', 'string', 'Lead name / phone / deal name.'],
          ['status', 'string', 'Call-level transcription status.'],
          ['minDuration', 'number', 'Call-level, seconds.'],
          ['minCalls', 'number', 'Journeys with at least this many calls.'],
          ['hasCalls', 'string', 'yes | no.'],
          ['owner', 'email', 'Admin only.'],
          ['page / limit', 'number', 'Default 1 / 50.'],
        ],
        example: '/api/calls/journeys?outcome=lost&minCalls=2&limit=25',
        response: {
          success: true,
          count: 512,
          withCalls: 288,
          withoutCalls: 224,
          page: 1,
          pages: 11,
          data: [
            {
              _id: '4876000000123456', // the Bigin deal id
              contactName: 'Rahul S',
              phone: '+919876543210',
              outcome: 'lost',
              lostReason: 'Budget',
              upScale: null,
              amount: 45000,
              closingDate: '2026-07-28',
              ownerEmail: 'veera@focasedu.com',
              products: ['CA Inter'],
              totalCalls: 4,
              totalDuration: 1841,
              longestCall: 812,
              transcribed: 4,
              pending: 0,
              avgScore: 63.5,
              firstCall: '2026-07-14T04:22:00.000Z',
              lastCall: '2026-07-27T11:05:00.000Z',
              calls: [
                {
                  _id: '66f2…',
                  startedAt: '2026-07-21T05:41:00.000Z',
                  duration: 214,
                  direction: 'outbound',
                  agentExt: '1002',
                  ownerEmail: 'veera@focasedu.com',
                  transcriptionStatus: 'done',
                  hasRecording: true,
                  score: 61,
                },
              ],
              deal: {
                id: '4876000000123456',
                name: 'Rahul S — CA Inter',
                stage: 'Closed Lost',
                ownerName: 'Veera',
                lostReason: 'Budget',
              },
            },
          ],
        },
      },
      {
        method: 'GET',
        path: '/api/calls/:id',
        auth: USER,
        summary: 'One call with its full transcript and grade breakdown.',
        source: 'backend/modules/calls/controllers/callController.js',
        params: [[':id', 'ObjectId', "The call's Mongo `_id` from the list."]],
        response: {
          success: true,
          data: {
            _id: '66f2…',
            transcript: [{ speaker: 'agent', text: 'Good morning…', start: 0.4 }],
            grade: {
              score: 78,
              breakdown: { callType: 'discovery', criteria: [{ name: 'rapport', score: 8, note: '…' }] },
            },
          },
        },
        errors: [
          ['403', 'Not your call'],
          ['404', 'Call not found'],
        ],
      },
      {
        method: 'GET',
        path: '/api/calls/:id/recording',
        auth: USER,
        summary: 'Stream the recording as browser-playable audio/mpeg. Supports Range, so the player can seek.',
        source: 'backend/modules/calls/controllers/callController.js',
        note:
          'Not JSON. Proxied and transcoded through the server so the TeleCMI secret never reaches ' +
          'the browser, then cached. Use it directly as an <audio> src.',
        rawResponse:
          'HTTP/1.1 200 OK\nContent-Type: audio/mpeg\nCache-Control: private, max-age=86400\n\n<binary audio>',
        errors: [
          ['403', 'Not your call'],
          ['404', 'No recording for this call — or TeleCMI has not published the audio yet'],
          ['502', 'Could not fetch recording'],
        ],
      },
      {
        method: 'GET',
        path: '/api/calls/pipeline-health',
        auth: ADMIN,
        summary: 'Is anything falling through the cracks? Read-only view of the audit the scheduler runs.',
        source: 'backend/modules/calls/controllers/callController.js',
        query: [['graceMinutes', 'number', 'How long a call may sit unprocessed before it counts as stuck.']],
        note:
          '`recoverable` is the number that means something is wrong: calls with audio that nothing ' +
          'is working on. The hourly audit re-queues those. Whole-system, hence admin-only.',
        response: {
          success: true,
          healthy: false,
          recoverable: 3,
          unscorable: { transcribeFailed: 11, gradeFailed: 2 },
          pending: { transcription: 8, grading: 1 },
        },
      },
      {
        method: 'GET',
        path: '/api/calls/usage',
        auth: ADMIN,
        summary: 'What the AI pipeline has spent (Sarvam tokens, ElevenLabs audio) and what balance is left.',
        source: 'backend/modules/calls/controllers/usageController.js',
        query: [
          ['days', 'number', 'Window for the daily series. Clamped to 7–90, default 30.'],
          ['refresh', "'1'", "Force a fresh ElevenLabs balance instead of the cached one."],
        ],
        example: '/api/calls/usage?days=14',
        note:
          'Account-wide billing data, so admin-only. Each provider\'s balance failure is reported ' +
          'inside its own card — a broken ElevenLabs key never blanks the Sarvam numbers.',
        response: {
          success: true,
          days: 14,
          providers: {
            sarvam: {
              label: 'Sarvam AI',
              purpose: 'Call grading (LLM)',
              configured: true,
              model: 'sarvam-105b',
              unit: 'tokens',
              balance: { remaining: 812000 },
              lifetime: { gradedCalls: 1188 },
            },
            elevenlabs: {
              label: 'ElevenLabs',
              purpose: 'Call transcription (speech-to-text)',
              unit: 'audio',
              lifetime: { transcribedCalls: 1206, transcribedSeconds: 402118 },
            },
          },
        },
      },
      {
        method: 'POST',
        path: '/api/calls/sync',
        auth: ADMIN,
        summary: 'Pull recent answered calls from TeleCMI now (incremental, idempotent on cmiuid).',
        source: 'backend/modules/calls/controllers/callController.js',
        body: [['days', 'number', 'How far back to pull. Default 2.']],
        response: { success: true, created: 37, updated: 112, days: 2 },
        errors: [
          ['400', 'TeleCMI not configured'],
          ['409', 'A sync is already running'],
          ['502', 'TeleCMI rejected the pull'],
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'money',
    title: 'Installments & Upsells',
    blurb:
      'Deliberately NOT admin-only, unlike the rest of the calls module: every rep needs their own ' +
      'chase list. The controllers scope non-admins to their own deals.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/installments',
        auth: USER,
        summary: 'Won deals with a balance outstanding, longest-overdue first.',
        source: 'backend/modules/calls/controllers/installmentController.js',
        response: {
          success: true,
          count: 63,
          totalPending: 1284000,
          totalPaid: 3536000,
          upsold: 11,
          data: [
            {
              id: '4876…',
              dealName: 'Rahul S — CA Inter',
              contactName: 'Rahul S',
              contactPhone: '+919876543210',
              ownerName: 'Veera',
              amount: 45000,
              paid: 20000,
              pending: 25000,
              closingDate: '2026-06-14',
              upScale: null,
            },
          ],
        },
      },
      {
        method: 'GET',
        path: '/api/upsells',
        auth: USER,
        summary: 'Won deals with Up_Scale set, newest first, priced against the product baseline.',
        source: 'backend/modules/calls/controllers/upsellController.js',
        note:
          '`noUpliftCount` is upsells that booked no extra money — almost always a data-entry miss in Bigin.',
        response: {
          success: true,
          count: 24,
          wonCount: 184,
          upsellRate: 13,
          totalValue: 1104000,
          totalUplift: 288000,
          pendingValue: 214000,
          noUpliftCount: 2,
          data: [{ id: '4876…', dealName: 'Rahul S — CA Final', upScale: 'CA Final', amount: 62000, uplift: 17000 }],
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'analytics',
    title: 'Analytics',
    blurb: 'The Analytics tab. One cached aggregate over every task; admin-only.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/analytics',
        auth: ADMIN,
        summary: 'Status / priority / due-date rollups and per-rep activity across all follow-ups.',
        source: 'backend/controllers/analyticsController.js',
        note:
          'Served from a short-lived cache and de-duplicated in flight: two simultaneous callers ' +
          'share one computation rather than queueing a second full scan. Registered sales users ' +
          'with zero tasks are included, so a rep who did nothing shows as a row of zeros rather ' +
          'than vanishing from the table.',
        response: {
          success: true,
          totals: {
            total: 412,
            completed: 61,
            overdue: 63,
            inProgress: 141,
            salespeople: 5,
            completionRate: 15,
          },
          users: [
            {
              email: 'veera@focasedu.com',
              name: 'Veera',
              username: 'veera',
              registered: true,
              total: 96,
              completed: 21,
              inProgress: 34,
              notStarted: 41,
              overdue: 12,
              dueToday: 4,
              notes: 143,
              actions: 61,
              completionRate: 22,
            },
          ],
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'ads',
    title: 'Marketing / Ads',
    blurb:
      'Everything behind the Marketing, Sources and Ad Leads tabs. ADMIN ONLY WITHOUT EXCEPTION — ' +
      'ad spend, cost per lead and raw lead PII are management data. The gate is one ' +
      '`router.use(authenticate, requireAdmin)` above every handler, so a route added later ' +
      'cannot be born unprotected. ' +
      'TWO CURRENCIES: insight `spend` is in RUPEES, campaign/ad-set budgets are in PAISE. That is ' +
      "Meta's split, and every money response carries a `units` block naming which is which — " +
      'format from that, never assume.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/ads/summary',
        auth: ADMIN,
        summary: 'Spend, impressions, clicks, CTR, CPC, leads and CPL for a date range.',
        source: 'backend/modules/ads/routes/ads.js',
        query: [
          ['from / to', 'YYYY-MM-DD', 'Default: the last 30 days. Both are inclusive.'],
        ],
        example: '/api/ads/summary?from=2026-08-01&to=2026-08-11',
        note:
          'Scoped to CAMPAIGN-level insight rows. The mirror holds account-level rows for the same ' +
          'days too, so summing across levels would count every rupee twice.',
        response: {
          success: true,
          data: {
            range: { from: '2026-08-01', to: '2026-08-11' },
            spend: 184220.5,
            impressions: 1420331,
            reach: 918240,
            clicks: 18442,
            // Percent, as Meta reports it.
            ctr: 1.2984,
            // null, never Infinity: spend with no clicks/leads has an UNDEFINED
            // cost, and "no data" is the only honest rendering.
            cpc: 9.99,
            leads: 998,
            cpl: 184.59,
            insightRows: 231,
            level: 'campaign',
            units: { spend: 'rupees', budget: 'paise' },
          },
        },
        errors: [['400', "Invalid 'from' date: expected YYYY-MM-DD / 'from' is after 'to'"]],
      },
      {
        method: 'GET',
        path: '/api/ads/campaigns',
        auth: ADMIN,
        summary: 'One row per campaign that spent anything in the range, with its metadata.',
        source: 'backend/modules/ads/routes/ads.js',
        query: [['from / to', 'YYYY-MM-DD', 'Default: the last 30 days.']],
        note:
          'Only campaigns WITH insight rows in the range appear. A campaign archived at Meta but ' +
          'still carrying spend comes back with `known: false` and a null name — dropping it would ' +
          'lose spend from a table that has to add up to the summary.',
        response: {
          success: true,
          count: 14,
          data: [
            {
              campaignId: '120210…',
              name: 'CA Inter — Aug',
              known: true,
              status: 'ACTIVE',
              dailyBudget: 250000,
              spend: 42180.25,
              clicks: 4120,
              leads: 231,
              cpl: 182.6,
            },
          ],
          units: { spend: 'rupees', budget: 'paise' },
        },
      },
      {
        method: 'GET',
        path: '/api/ads/insights',
        auth: ADMIN,
        summary: 'The stored insight rows behind every number above — the "show me the receipts" endpoint.',
        source: 'backend/modules/ads/routes/ads.js',
        query: [
          ['from / to', 'YYYY-MM-DD', 'Default: the last 30 days.'],
          ['level', 'string', 'account | campaign | adset | ad.'],
          ['campaignId', 'string', 'Narrow to one campaign.'],
          ['limit', 'number', 'Default 500, 1–5000.'],
        ],
        example: '/api/ads/insights?level=adset&campaignId=120210…&limit=100',
        note: 'Returned exactly as stored — nothing is derived or reshaped here.',
        response: {
          success: true,
          count: 100,
          total: 1841,
          data: [
            { id: '66f3…', level: 'adset', entityId: '1234…', campaignId: '120210…', dateStart: '2026-08-11', dateStop: '2026-08-11', spend: 3120.4, impressions: 24110 },
          ],
        },
        errors: [['400', "Invalid level 'x'. Expected one of: account, campaign, adset, ad"]],
      },
      {
        method: 'GET',
        path: '/api/ads/leads',
        auth: ADMIN,
        summary: 'The Ad Leads tab: web-form and Meta lead-form submissions, with their attribution.',
        source: 'backend/modules/ads/routes/ads.js',
        query: [
          ['from / to', 'YYYY-MM-DD', 'Default: the last 30 days. Half-open on the upper bound, so `to` is fully included.'],
          ['source', 'string', "web | meta."],
          ['linked / unlinked', 'boolean', 'Whether the lead is joined to a follow-up task. `unlinked=true` and `linked=false` are the same filter.'],
          ['unresolved', 'boolean', 'WORKLIST: UTM strings nobody has mapped to a campaign yet.'],
          ['unmapped', 'boolean', 'Leads an admin already triaged as having no Meta campaign (Google traffic, tests).'],
          ['campaignId', 'string', 'Resolved campaign.'],
          ['status', 'string', 'won | lost | pipeline | followup | none — see the note.'],
          ['limit', 'number', 'Default 200, 1–1000. Applied PER SOURCE before the merge.'],
        ],
        example: '/api/ads/leads?source=web&unresolved=true&limit=50',
        note:
          'Use `unresolved=true` for the fix-me pile, not a null campaign id — an already-triaged ' +
          '"no campaign" lead also has a null id, so filtering on the column alone hands back a ' +
          'stack of already-answered questions. ' +
          'Each row carries a `status`, resolved from the Deal mirror FIRST and the follow-up Task ' +
          'second, because a contact with a closed-won deal has bought whatever their task still ' +
          'says: `won` / `lost` / `pipeline` (a deal exists and is open) / `followup` (a task but no ' +
          'deal) / `none` (nobody picked it up). ' +
          '`status.matchedBy` is carried out because the two joins are NOT equally strong: ' +
          "`lead-id` is Meta's own id on both sides — a fact; `phone` is a 10-digit key a family or " +
          'a reused handset can share — an inference. A web lead can only ever match by phone. ' +
          'Check `truncated`: `status` and the Meta `linked` filter cannot be expressed in the query, ' +
          'so they are applied after the per-source cap, and a capped page is an upper bound rather ' +
          'than a complete answer.',
        response: {
          success: true,
          count: 50,
          totals: { web: 812, meta: 186, all: 998 },
          truncated: false,
          range: { from: '2026-07-13', to: '2026-08-11' },
          filters: {
            source: 'web',
            linked: undefined,
            unresolved: true,
            unmapped: undefined,
            campaignId: null,
            status: null,
            limit: 50,
          },
          data: [
            {
              id: '66f4…',
              source: 'web',
              capturedAt: '2026-08-11T05:02:11.000Z',
              name: 'Rahul S',
              email: 'rahul@example.com',
              phone: '+919876543210',
              phoneKey: '9876543210',
              form: 'counseling-form',
              utm: {
                source: 'fb',
                medium: 'paid',
                campaign: 'ca-inter-aug',
                content: null,
                term: null,
              },
              campaignId: '120210…',
              campaignName: 'CA Inter — Aug',
              // id | exact | normalized | alias | unmapped — HOW the UTM was matched,
              // so the tab can show whether an attribution is a fact, an inference,
              // or an operator's manual mapping. null = resolved to nothing, untriaged.
              resolvedBy: 'exact',
              linked: true,
              task: { id: '66f1…', name: 'Rahul S', phone: '+919876543210' },
              status: {
                state: 'won',
                stage: 'Closed with Sale',
                taskStatus: 'Completed',
                amount: 45000,
                closingDate: '2026-08-09',
                matchedBy: 'phone',
              },
            },
          ],
        },
        errors: [
          ['400', "Invalid source 'x'. Expected 'web' or 'meta'."],
          ['400', "Invalid status 'x'. Expected one of won, lost, pipeline, followup, none."],
        ],
      },
      {
        method: 'GET',
        path: '/api/ads/sources',
        auth: ADMIN,
        summary: 'The Sources tab: which lead source closed the deal, and the campaign behind it.',
        source: 'backend/modules/ads/routes/ads.js',
        query: [
          [
            'from / to',
            'YYYY-MM-DD',
            'OPTIONAL here, and both-or-neither. Windows deal CLOSING dates; omit for all time.',
          ],
        ],
        note:
          'The default really is all time, unlike every other ads route — you cannot judge a channel ' +
          'on 30 days of a business with 184 lifetime sales. `spend` is the campaign\'s LIFETIME in ' +
          'the insight mirror while `revenue` is only the window\'s deals, so `roas` ranks campaigns ' +
          'against each other; it does not audit a return.',
        response: {
          success: true,
          data: {
            bySource: [{ source: 'Facebook Ads', won: 61, revenue: 1840000 }],
            fromAds: {
              available: true,
              wonWithLeadId: 84,
              tracedToCampaign: 71,
              unmatchedLeadIds: 13,
              spendBasis: 'campaign lifetime in the insight mirror',
              campaigns: [
                { campaignId: '120210…', name: 'CA Inter — Aug', won: 22, revenue: 684000, spend: 142100.5, roas: 4.81, cac: 6459 },
              ],
            },
          },
        },
        errors: [['400', "Provide both 'from' and 'to', or neither."]],
      },
      {
        method: 'GET',
        path: '/api/ads/reconciliation',
        auth: ADMIN,
        summary: 'Does account-level spend agree with the sum of campaign-level spend?',
        source: 'backend/modules/ads/routes/ads.js',
        query: [['from / to', 'YYYY-MM-DD', 'Default: the last 30 days.']],
        note:
          'Two independent pulls from Meta, so a gap is a real signal with two plausible causes: ' +
          'spend not attached to any campaign, or a sync that did not finish. The endpoint cannot ' +
          'tell them apart and does not try. `comparable: false` means "run a sync", not "reconciled".',
        response: {
          success: true,
          data: {
            range: { from: '2026-07-13', to: '2026-08-11' },
            accountSpend: 184900.0,
            campaignSpend: 184220.5,
            difference: 679.5,
            accountRows: 30,
            campaignRows: 231,
            comparable: true,
            units: { spend: 'rupees' },
          },
        },
      },
      {
        method: 'GET',
        path: '/api/ads/campaign-aliases',
        auth: ADMIN,
        summary:
          'The UTM → campaign alias table, plus the worklist it exists to shrink.',
        source: 'backend/modules/ads/routes/campaignAliases.js',
        note:
          'An alias is an operator\'s assertion that a raw `utm_campaign` string means a particular ' +
          'Meta campaign — or that it means no campaign at all. `unresolved` is every tagged UTM ' +
          'that resolved to nothing AND has no alias row, ordered by lead count: that ordering says ' +
          'what the next alias is worth, in leads. A deliberately-unmapped UTM is absent from it, ' +
          'because leaving a triaged string on the worklist forever is the problem the table solves.',
        response: {
          success: true,
          count: 12,
          unresolvedLeads: 143,
          data: [
            {
              key: 'cainteraug',
              utmCampaign: 'CA-Inter Aug',
              campaignId: '120210…',
              campaignName: 'CA Inter — Aug',
              mapped: true,
              campaignKnown: true,
              note: 'Landing page tags it with a space.',
              leads: 231,
              spellings: [
                { utmCampaign: 'CA-Inter Aug', leads: 190 },
                { utmCampaign: 'ca_inter_aug', leads: 41 },
              ],
              createdBy: { id: '66f1…', name: 'Kavya R' },
              updatedBy: null,
              createdAt: '2026-07-02T10:14:00.000Z',
              updatedAt: '2026-07-02T10:14:00.000Z',
            },
          ],
          unresolved: [{ key: 'summerpush', utmCampaign: 'summer-push', leads: 88 }],
        },
      },
      {
        method: 'POST',
        path: '/api/ads/campaign-aliases',
        auth: ADMIN,
        summary: 'Create — or overwrite — one alias. Idempotent.',
        source: 'backend/modules/ads/routes/campaignAliases.js',
        body: [
          ['utmCampaign', 'string', 'The raw UTM string. Required. The key is derived from it.'],
          ['campaignId', 'string | null', 'Meta campaign id. Omit or send null to record "this UTM has no Meta campaign".'],
          ['note', 'string', 'Why, for the next person.'],
        ],
        note:
          'The key is derived from `utmCampaign`, so posting the same alias twice is one upsert on ' +
          'one row — the second call answers 200 with `created: false` and leaves createdBy/createdAt ' +
          'alone. A campaignId that is not in the mirror is REFUSED: a typo would otherwise attribute ' +
          'leads to a campaign with no name, no spend and no CPL, which looks resolved and shows ' +
          'nothing. Adding an alias changes what FUTURE resolutions do — existing leads keep their ' +
          'stored campaign until `scripts/resolveLeadCampaigns.js` is re-run.',
        response: {
          success: true,
          created: true,
          data: { key: 'summerpush', utmCampaign: 'summer-push', campaignId: '120211…', mapped: true, note: null },
          message: 'Alias created. Re-run scripts/resolveLeadCampaigns.js to apply it to existing leads.',
        },
        errors: [
          ['400', 'utmCampaign is required.'],
          ['400', "'…' has no letters or digits, so it cannot be aliased."],
          ['400', "No campaign '…' in the mirror. Sync first, or check the id."],
        ],
      },
      {
        method: 'PUT',
        path: '/api/ads/campaign-aliases/:key',
        auth: ADMIN,
        summary: 'Change what an existing alias points at.',
        source: 'backend/modules/ads/routes/campaignAliases.js',
        params: [
          [
            ':key',
            'string',
            'The NORMALIZED key from the list endpoint, not the raw UTM string — the raw one may contain spaces and punctuation a URL path would mangle.',
          ],
        ],
        body: [
          ['campaignId', 'string | null', 'Omit to leave it as it is.'],
          ['note', 'string', 'Omit to leave it as it is.'],
        ],
        note:
          'The raw UTM string is NOT editable here: change it and you have a different alias, so ' +
          'POST that one and DELETE this one.',
        response: {
          success: true,
          data: { key: 'summerpush', utmCampaign: 'summer-push', campaignId: null, mapped: false, note: 'Google Ads traffic.' },
          message: 'Alias updated. Re-run scripts/resolveLeadCampaigns.js to apply it to existing leads.',
        },
        errors: [
          ['400', "No campaign '…' in the mirror."],
          ['404', "No alias '…'."],
        ],
      },
      {
        method: 'DELETE',
        path: '/api/ads/campaign-aliases/:key',
        auth: ADMIN,
        summary: 'Untriage a UTM string — put it back on the unresolved worklist.',
        source: 'backend/modules/ads/routes/campaignAliases.js',
        params: [[':key', 'string', 'The normalized key.']],
        note:
          'The leads this alias already resolved KEEP their stored campaign until the backfill is ' +
          're-run — deleting an alias does not silently un-attribute history behind the operator\'s ' +
          'back. `leads` tells you how big the pile you just put back is.',
        response: {
          success: true,
          deleted: true,
          data: { key: 'summerpush', utmCampaign: 'summer-push', campaignId: null, mapped: false },
          leads: 88,
          message:
            'Alias deleted. 88 lead(s) still carry its stored result; re-run scripts/resolveLeadCampaigns.js to clear them.',
        },
        errors: [['404', "No alias '…'."]],
      },
      {
        method: 'GET',
        path: '/api/ads/sync/history',
        auth: ADMIN,
        summary: 'The sync audit trail, newest first — plus whether one is running right now.',
        source: 'backend/modules/ads/routes/ads.js',
        query: [
          ['limit', 'number', 'Default 50, 1–200.'],
          ['resource', 'string', 'campaigns | adsets | ads | insights | leads.'],
        ],
        note: 'Poll this for progress after POST /api/ads/sync — that call returns before the work finishes.',
        response: {
          success: true,
          count: 50,
          running: false,
          configured: true,
          cplCache: { entries: 14, ageMs: 41200 },
          data: [
            { id: '66f5…', resource: 'insights', startedAt: '2026-08-11T04:00:00.000Z', finishedAt: '2026-08-11T04:03:41.000Z', upserted: 231, ok: true },
          ],
        },
      },
      {
        method: 'POST',
        path: '/api/ads/sync',
        auth: ADMIN,
        summary: 'Start a full Meta sync now. Answers 202 once the run has STARTED, not when it finishes.',
        source: 'backend/modules/ads/routes/ads.js',
        body: [
          ['from / to', 'YYYY-MM-DD', 'Optional, both-or-neither. Omit to sync the default window.'],
        ],
        note:
          'A full sync runs for minutes; holding the request open would hit every proxy timeout ' +
          'between here and the browser. Watch GET /api/ads/sync/history instead. Rate-limited to ' +
          '5 requests per 5 minutes.',
        response: { success: true, accepted: true, startedAt: '2026-08-11T09:14:22.000Z', range: null },
        errors: [
          ['400', "Provide both 'from' and 'to', or neither."],
          ['409', 'A sync is already in progress. Try again once it finishes.'],
          ['429', 'Sync requested too frequently. Please wait a few minutes.'],
          ['503', 'Meta is not configured (set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID).'],
        ],
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'leads',
    title: 'Web lead ingest',
    blurb:
      'The ONE unauthenticated write surface in this backend — the Focas landing pages post ' +
      'captured leads here. It carries no user session, but it is not open: it owns its own CORS ' +
      'allowlist (CORS_ORIGINS), a shared secret (LEAD_INGEST_TOKEN), and a per-IP rate limit. ' +
      'app.js mounts it ahead of every authenticated router so its openness cannot leak sideways ' +
      'onto a neighbouring route.',
    endpoints: [
      {
        method: 'POST',
        path: '/api/leads/web',
        auth: PUBLIC,
        summary: 'Capture a landing-page lead with the UTM tags from the click URL.',
        source: 'backend/modules/ads/controllers/webLeadController.js',
        headers: [
          ['X-Lead-Ingest-Token', 'The LEAD_INGEST_TOKEN shared secret. Compared in constant time.'],
          ['Content-Type', 'application/json'],
        ],
        body: [
          ['name / firstName / lastName', 'string', '≤ 200 chars each.'],
          ['email', 'string', '≤ 200. Lenient — an unparseable email is still a lead worth having.'],
          ['phone', 'string | number', '≤ 40. A number is accepted and stringified.'],
          ['caStatus / attempt / language', 'string', 'Qualification answers, ≤ 100.'],
          ['city / state', 'string', '≤ 120.'],
          ['utmSource / utmMedium', 'string', '≤ 200.'],
          ['utmCampaign / utmContent / utmTerm', 'string', '≤ 300.'],
          ['landingUrl / referrer', 'string', '≤ 2000.'],
          ['source', 'string', "≤ 120, e.g. 'counseling-form'."],
          ['biginContactId', 'string', '≤ 120.'],
        ],
        note:
          'Any field NOT in that table is DROPPED — that is what stops a caller setting the ' +
          'resolution fields (phoneKey, resolvedCampaignId, resolvedBy, linkedTaskId) itself. ' +
          'A hidden `company` field is a honeypot: if it arrives filled, the response is a normal ' +
          '202 and nothing is stored, so a bot cannot tell a rejection from an acceptance. ' +
          'Campaign resolution and task linking run before the response, but can never fail it — ' +
          'a lead is worth more than its attribution.',
        response: { success: true, ok: true, id: '66f4a1b2c3d4e5f607182930' },
        errors: [
          ['400', 'Invalid request — with an `errors` array naming each field'],
          ['401', 'Missing or bad X-Lead-Ingest-Token'],
          ['429', 'Too many submissions. Please try again shortly. (60/min per IP; WEB_LEAD_RATE_MAX)'],
        ],
      },
      {
        method: 'GET',
        path: '/api/leads/web',
        auth: ADMIN,
        summary: 'Stored web leads, newest first.',
        source: 'backend/modules/ads/controllers/webLeadController.js',
        query: [['limit', 'number', 'Default 500, 1–1000.']],
        note: 'Every row is raw lead PII, so JWT + admin. The retired CRM served this openly; that was a defect.',
        response: {
          success: true,
          count: 500,
          data: [{ id: '66f4…', name: 'Rahul S', phone: '+919876543210', utmCampaign: 'ca-inter-aug', createdAt: '2026-08-11T05:02:11.000Z' }],
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'misc',
    title: 'WhatsApp, users & health',
    blurb: 'The remaining surfaces: WATI templates, user administration, and the liveness probe.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/wati/templates',
        auth: USER,
        summary: 'Approved WATI template names, for the WhatsApp composer in the task drawer.',
        source: 'backend/controllers/watiController.js',
        note:
          'Always 200. `configured: false` with an `error` string is how "WATI is not set up" is ' +
          'reported — the composer says so instead of failing.',
        response: {
          success: true,
          configured: true,
          templates: [{ name: 'followup_reminder', parameters: ['name', 'date'] }],
          error: null,
        },
      },
      {
        method: 'GET',
        path: '/api/users',
        auth: ADMIN,
        summary: 'All dashboard users, oldest first. Password hashes are never returned.',
        source: 'backend/controllers/userController.js',
        response: {
          success: true,
          users: [{ id: '66f1…', name: 'Veera', username: 'veera', role: 'sales', ownerEmail: 'veera@focasedu.com' }],
        },
      },
      {
        method: 'POST',
        path: '/api/users',
        auth: ADMIN,
        summary: 'Create a sales or admin user.',
        source: 'backend/controllers/userController.js',
        body: [
          ['name', 'string', 'Required.'],
          ['username', 'string', 'Required, lowercased, unique.'],
          ['password', 'string', 'Required. Hashed with bcrypt before storage.'],
          ['role', 'string', "'admin' or 'sales'. Anything else becomes 'sales'."],
          ['ownerEmail', 'email', "Required for sales users — their Zoho Owner email. This is what scopes every rep response."],
        ],
        response: { success: true, user: { id: '66f6…', name: 'Divya', username: 'divya', role: 'sales', ownerEmail: 'divya@focasedu.com' } },
        errors: [
          ['400', 'name, username and password are required / ownerEmail is required for sales users'],
          ['409', 'Username already exists'],
        ],
      },
      {
        method: 'DELETE',
        path: '/api/users/:id',
        auth: ADMIN,
        summary: 'Remove a user.',
        source: 'backend/controllers/userController.js',
        params: [[':id', 'ObjectId', 'From GET /api/users.']],
        response: { success: true },
        errors: [['400', 'You cannot delete your own account']],
      },
      {
        method: 'GET',
        path: '/health',
        auth: PUBLIC,
        summary: 'Liveness probe. No auth, no database read.',
        source: 'backend/app.js',
        response: { status: 'ok' },
      },
    ],
  },

  // -------------------------------------------------------------------------
  {
    id: 'webhooks',
    title: 'Inbound webhooks',
    blurb:
      'These are called BY third parties, not by you — listed so the whole surface is documented ' +
      'in one place. All three answer immediately and do the slow work after responding, because a ' +
      'webhook sender that times out retries. Bodies are parsed leniently: a malformed or NDJSON ' +
      'body is recovered from the raw bytes rather than 400-ing a lead away (app.js).',
    endpoints: [
      {
        method: 'POST',
        path: '/webhook',
        auth: PUBLIC,
        summary: 'Zoho Flow posts a follow-up task here. Deduped by contact; a single object or an array both work.',
        source: 'backend/controllers/webhookController.js',
        note:
          'Two fields Zoho Flow never maps — the contact phone and `Task_Category` — are read back ' +
          'from the Bigin API AFTER the 200, then the task is re-upserted.',
        response: { success: true, message: 'Webhook received', count: 1 },
      },
      {
        method: 'GET',
        path: '/webhook',
        auth: PUBLIC,
        summary: 'Raw stored task bodies, newest first. Predates /api/tasks; kept for debugging.',
        source: 'backend/controllers/webhookController.js',
        note:
          'Unauthenticated and returns lead bodies. Use /api/tasks instead — that one is scoped ' +
          'per role. Do not expose this route publicly.',
        response: { success: true, count: 412, data: [{ id: '4876…', receivedAt: '2026-08-11T06:12:44.101Z', body: {} }] },
      },
      {
        method: 'POST',
        path: '/webhook/call',
        auth: PUBLIC,
        summary: 'TeleCMI posts a finished call here. The call is stored, then transcribed and graded in the background.',
        source: 'backend/modules/calls/controllers/callWebhookController.js',
        note:
          'Unrecognised payloads are answered 200 with the field names that arrived, so a changed ' +
          'TeleCMI schema shows up in the logs instead of vanishing into a retry loop.',
        response: { success: true },
      },
      {
        method: 'POST',
        path: '/webhook/deal',
        auth: PUBLIC,
        summary: 'Bigin posts a deal create/update here — this is what makes a call journey won or lost.',
        source: 'backend/modules/calls/controllers/callWebhookController.js',
        response: { success: true },
      },
    ],
  },
];

/** Flat list, for search and for the markdown generator. */
export function allEndpoints() {
  return GROUPS.flatMap((g) => g.endpoints.map((e) => ({ ...e, group: g.title, groupId: g.id })));
}

/** The role badge label + class for an endpoint. */
export function authLabel(auth) {
  if (auth === ADMIN) return { text: 'Admin only', cls: 'auth-admin' };
  if (auth === USER) return { text: 'Any logged-in user', cls: 'auth-user' };
  return { text: 'No auth', cls: 'auth-public' };
}

/** A ready-to-paste curl for an endpoint. */
export function curlFor(ep, origin, token) {
  const url = `${origin}${ep.example || ep.path}`;
  const lines = [];
  const method = ep.method === 'GET' ? '' : ` -X ${ep.method}`;
  lines.push(`curl${method} '${url}'`);

  if (ep.auth !== PUBLIC) {
    lines.push(`  -H 'Authorization: Bearer ${token || '<YOUR_TOKEN>'}'`);
  }
  (ep.headers || []).forEach(([name]) => {
    if (name.toLowerCase() === 'content-type') return;
    lines.push(`  -H '${name}: <value>'`);
  });
  if (ep.body) {
    lines.push(`  -H 'Content-Type: application/json'`);
    const sample = {};
    ep.body.forEach(([field, type]) => {
      const key = String(field).split(' / ')[0];
      sample[key] = type.includes('number') ? 0 : type.includes('array') ? [] : '…';
    });
    lines.push(`  -d '${JSON.stringify(sample)}'`);
  }
  return lines.join(' \\\n');
}

/** The same call as a fetch(), in the shape the dashboard itself uses. */
export function fetchFor(ep) {
  const path = ep.example || ep.path;
  const opts = [];
  if (ep.method !== 'GET') opts.push(`method: '${ep.method}'`);
  if (ep.body) {
    const sample = {};
    ep.body.forEach(([field, type]) => {
      const key = String(field).split(' / ')[0];
      sample[key] = type.includes('number') ? 0 : type.includes('array') ? [] : '…';
    });
    opts.push(`body: ${JSON.stringify(sample)}`);
  }

  // The dashboard's own helper already attaches the bearer token and throws on
  // a non-2xx, so in-app code is one line.
  const inApp = opts.length
    ? `const json = await api('${path}', { ${opts.join(', ')} });`
    : `const json = await api('${path}');`;

  const headerLines = [];
  if (ep.auth !== PUBLIC) headerLines.push(`    Authorization: \`Bearer \${token}\`,`);
  if (ep.body) headerLines.push(`    'Content-Type': 'application/json',`);
  (ep.headers || []).forEach(([name]) => {
    if (name.toLowerCase() === 'content-type') return;
    headerLines.push(`    '${name}': '<value>',`);
  });

  const raw = [
    `const res = await fetch('${path}', {`,
    ep.method !== 'GET' ? `  method: '${ep.method}',` : null,
    headerLines.length ? `  headers: {\n${headerLines.join('\n')}\n  },` : null,
    ep.body ? `  body: JSON.stringify({ … }),` : null,
    `});`,
    `const json = await res.json();`,
  ]
    .filter(Boolean)
    .join('\n');

  return { inApp, raw };
}
