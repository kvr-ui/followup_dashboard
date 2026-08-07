const express = require('express');

const { ingestWebLead, listWebLeads } = require('../controllers/webLeadController');
const { rateLimit } = require('../middleware/rateLimit');
const { leadCors, requireIngestToken } = require('../middleware/leadIngest');
const { authenticate, requireAdmin } = require('../../../middleware/auth');

const router = express.Router();

// Per-IP cap on the public ingest endpoint, to blunt floods of junk leads.
// Generous by default so the (single-IP) lead-server forwarder is never
// throttled under real campaign volume; tune with WEB_LEAD_RATE_MAX.
const configuredMax = Number(process.env.WEB_LEAD_RATE_MAX);
const ingestLimiter = rateLimit({
  windowMs: 60_000,
  max: Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 60,
  message: 'Too many submissions. Please try again shortly.',
});

// --- Public write side -------------------------------------------------------
// POST /api/leads/web — the Focas landing pages post captured leads here.
// Unauthenticated by design (no user session exists on a landing page), but
// fenced by three things this route owns: its own CORS allowlist, the
// LEAD_INGEST_TOKEN shared secret, and the per-IP rate limit. Nothing here
// touches `authenticate`, and app.js mounts this router ahead of every
// authenticated one so it cannot pick JWT protection up by accident either.
router.post('/', leadCors, requireIngestToken, ingestLimiter, ingestWebLead);
router.options('/', leadCors);

// --- Private read side -------------------------------------------------------
// GET /api/leads/web — full lead PII, so JWT + admin. (The CRM served this
// openly; that was a defect, and this is where it gets fixed.)
router.get('/', authenticate, requireAdmin, listWebLeads);

module.exports = router;
