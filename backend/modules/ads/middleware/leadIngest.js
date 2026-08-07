const crypto = require('crypto');

// Guards for the ONE unauthenticated write surface in this backend: the public
// web-lead ingest endpoint. The dashboard behind it holds leads, call
// recordings and transcripts, so this route does not get to lean on the app's
// defaults — it declares its own CORS policy and its own shared secret.

// ---- CORS -------------------------------------------------------------------

// Origins allowed to call the ingest endpoint from a browser (the Focas landing
// pages). Comma-separated in CORS_ORIGINS; "*" allows any origin.
const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Strict, route-local CORS.
 *
 * app.js calls `app.use(cors())` — blanket `Access-Control-Allow-Origin: *`.
 * This route must NOT inherit that. It is mounted ahead of that middleware, and
 * this handler additionally strips any CORS headers already on the response
 * before deciding for itself, so the property survives a future reordering of
 * app.js rather than depending on it.
 */
function leadCors(req, res, next) {
  const origin = req.headers.origin;

  // Belt and braces: drop anything a broader CORS middleware may have set.
  res.removeHeader('Access-Control-Allow-Origin');
  res.removeHeader('Access-Control-Allow-Credentials');

  // The response differs by Origin, so it must never be cached across origins.
  res.setHeader('Vary', 'Origin');

  if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Lead-Ingest-Token');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  // Answer the preflight either way: an origin that was not allowlisted simply
  // gets no Access-Control-Allow-Origin back, and the browser blocks the call.
  if (req.method === 'OPTIONS') return res.sendStatus(204);

  next();
}

// ---- Shared secret ----------------------------------------------------------

const TOKEN_HEADER = 'x-lead-ingest-token';
const INGEST_TOKEN = String(process.env.LEAD_INGEST_TOKEN || '');

// Boot-time warning: this module is required from app.js, which server.js
// requires after dotenv, so this runs exactly once at startup.
if (!INGEST_TOKEN) {
  const detail =
    'LEAD_INGEST_TOKEN is not set — the public web-lead ingest endpoint ' +
    '(POST /api/leads/web) accepts unauthenticated writes from anyone who can ' +
    `reach it. Set LEAD_INGEST_TOKEN and have the lead server send it in the ${TOKEN_HEADER} header.`;
  if (process.env.NODE_ENV === 'production') {
    console.warn(`SECURITY WARNING: ${detail}`);
  } else {
    console.warn(`Warning: ${detail} (unset is fine for local development.)`);
  }
}

// Constant-time compare that does not leak the secret's length.
function tokenMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Shared-secret guard. The lead server is server-to-server and can hold a
 * secret, so the ingest endpoint is not really public — it is unauthenticated
 * only in the sense that it carries no user session.
 *
 * When LEAD_INGEST_TOKEN is unset the check is skipped, so local development
 * and the dual-write cutover window (task 13) are never blocked. Boot logs a
 * warning in that case (above).
 */
function requireIngestToken(req, res, next) {
  if (!INGEST_TOKEN) return next();

  const provided = req.get(TOKEN_HEADER);
  if (provided && tokenMatches(provided, INGEST_TOKEN)) return next();

  return res.status(401).json({ success: false, message: 'Unauthorized' });
}

module.exports = { leadCors, requireIngestToken, allowedOrigins, TOKEN_HEADER };
