const path = require('path');
const express = require('express');
const cors = require('cors');

const webhookRoutes = require('./routes/webhook');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const taskRoutes = require('./routes/tasks');
const analyticsRoutes = require('./routes/analytics');
const watiRoutes = require('./routes/wati');

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

// Re-run the webhook route after a successful recovery.
app.use('/webhook', webhookRoutes);

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
