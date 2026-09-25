// GET /api/lead-profile/:phoneKey — one lead, every source, one payload.
//
// Mounted at /api/lead-profile, NOT /api/leads/...: /api/leads/web is the
// unauthenticated landing-page ingest, mounted before cors on purpose, and
// nothing authenticated may share its prefix.
//
// Auth only, no admin gate: a sales rep may open a lead they own a Task, Deal or
// Call on. That rule — and every other one — lives in buildLeadProfile, so this
// handler is only a translation from { status, body } to HTTP.

const express = require('express');
const { authenticate } = require('../../../middleware/auth');
const { buildLeadProfile } = require('../services/leadProfile');

const router = express.Router();

router.use(authenticate);

router.get('/:phoneKey', async (req, res) => {
  try {
    const { status, body } = await buildLeadProfile(req.params.phoneKey, req.user);
    res.status(status).json(body);
  } catch (err) {
    console.error('Failed to build lead profile:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load lead profile' });
  }
});

module.exports = router;
