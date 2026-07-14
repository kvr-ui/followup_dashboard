const express = require('express');

const { redirect } = require('../controllers/redirectController');

const router = express.Router();

/**
 * GET /r/:code — the tracked link a lead taps inside WhatsApp.
 *
 * Public and unauthenticated by necessity: the person clicking is a prospect on their
 * phone, not a dashboard user. Mounted at the app ROOT rather than under /api or
 * /webhook, because this URL is pasted into a WhatsApp message and every character
 * costs — `focas.in/r/k3Hn9pQ` is a link someone will tap, and
 * `focas.in/api/campaigns/redirect/k3Hn9pQ` is a link that looks like a phishing
 * attempt.
 */
router.get('/r/:code', redirect);

module.exports = router;
