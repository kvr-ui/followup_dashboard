const path = require('path');
const express = require('express');
const cors = require('cors');

const webhookRoutes = require('./routes/webhook');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const taskRoutes = require('./routes/tasks');
const analyticsRoutes = require('./routes/analytics');
const watiRoutes = require('./routes/wati');
const callRoutes = require('./modules/calls/routes/calls'); // v2: call grading
const installmentRoutes = require('./modules/calls/routes/installments'); // v2: pending payments
const upsellRoutes = require('./modules/calls/routes/upsells'); // v2: upsold leads
const callWebhookRoutes = require('./modules/calls/routes/webhooks'); // v2: TeleCMI + Bigin deal webhooks
const campaignRoutes = require('./modules/campaigns/routes/campaigns'); // v3: WhatsApp campaigns
const contactRoutes = require('./modules/campaigns/routes/contacts'); // v3: the send list
const segmentRoutes = require('./modules/campaigns/routes/segments'); // v3: saved audiences
const sequenceRoutes = require('./modules/campaigns/routes/sequences'); // v3: drips
const campaignWebhookRoutes = require('./modules/campaigns/routes/webhooks'); // v3: WATI status events
const redirectRoutes = require('./modules/campaigns/routes/redirect'); // v3: /r/<code> click tracking

const app = express();

// Middleware
app.use(cors());

// Keep a copy of the raw request body so we can recover from senders
// that post malformed / concatenated JSON.
const keepRawBody = (req, res, buf) => {
  req.rawBody = buf.toString('utf8');
};

app.use(express.json({ verify: keepRawBody }));
app.use(express.urlencoded({ extended: true, verify: keepRawBody }));

// Serve the built React frontend (run `npm run build` in ../frontend).
// In development, use the Vite dev server (npm run dev) which proxies to this API.
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

// API routes
app.use('/webhook', webhookRoutes); // Zoho posts here (no auth)
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes); // admin-only
app.use('/api/tasks', taskRoutes); // auth + role-based filtering
app.use('/api/analytics', analyticsRoutes); // admin-only
app.use('/api/wati', watiRoutes);
app.use('/api/calls', callRoutes); // admin-only
app.use('/api/installments', installmentRoutes); // auth + role-based filtering (reps see their own)
app.use('/api/upsells', upsellRoutes); // auth + role-based filtering (reps see their own)
app.use('/webhook', callWebhookRoutes); // /webhook/call (TeleCMI), /webhook/deal (Bigin)

// v3: WhatsApp campaigns. Admin-only, every route — a send spends money and puts the
// brand in front of a real person, so there is no rep-facing slice of this module.
app.use('/api/campaigns', campaignRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/segments', segmentRoutes);
app.use('/api/sequences', sequenceRoutes);

app.use('/webhook', campaignWebhookRoutes); // /webhook/wati (delivery, read, reply)

// /r/<code> — the tracked links inside the WhatsApp messages we send. Public by
// necessity (a lead tapping a link is not logged in) and mounted at the root because
// the URL goes in the message itself, where every character is read by a human.
app.use('/', redirectRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Handle JSON parse errors gracefully instead of crashing.
// Some webhook senders post NDJSON (one JSON object per line) or otherwise
// malformed bodies; we try to recover the payload from the raw body.
app.use((err, req, res, next) => {
  const isParseError =
    err.type === 'entity.parse.failed' || err instanceof SyntaxError;

  if (isParseError && req.rawBody !== undefined) {
    const recovered = tryRecoverJson(req.rawBody);
    if (recovered !== undefined) {
      req.body = recovered;
      return next();
    }

    console.warn('Received a body that could not be parsed as JSON:');
    console.warn(req.rawBody);
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON payload',
    });
  }

  return next(err);
});

// Re-run the webhook routes after a successful recovery. Every webhook router must
// be re-mounted here — otherwise a recovered TeleCMI/Bigin/WATI body would fall
// through to the task router and be silently dropped (it matches no route there).
app.use('/webhook', webhookRoutes);
app.use('/webhook', callWebhookRoutes);
app.use('/webhook', campaignWebhookRoutes);

/**
 * Attempt to parse a raw body that failed strict JSON parsing.
 * Handles NDJSON (multiple JSON objects separated by newlines) and
 * trailing-newline / whitespace noise.
 */
function tryRecoverJson(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Straight parse (in case the failure was elsewhere).
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // fall through
  }

  // NDJSON: one JSON object per line -> return an array of objects.
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1) {
    const objects = [];
    for (const line of lines) {
      try {
        objects.push(JSON.parse(line));
      } catch (_) {
        return undefined; // give up if any line is not valid JSON
      }
    }
    return objects.length === 1 ? objects[0] : objects;
  }

  return undefined;
}

module.exports = app;
