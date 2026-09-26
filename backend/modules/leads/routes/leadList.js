// GET /api/leads-list — every lead, one row per phone, scoped to the caller.
// GET /api/leads-list/funnel — Bigin contacts per source and month, MQL vs SQL.
//
// Mounted at /api/leads-list, NOT /api/leads/...: /api/leads/web is the
// unauthenticated landing-page ingest (see leadProfile.js route). Auth only —
// the admin / rep scope lives in buildLeadList.

const express = require('express');
const { authenticate } = require('../../../middleware/auth');
const { buildLeadList } = require('../services/leadList');
const { buildFunnel } = require('../services/funnel');

const router = express.Router();

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { status, body } = await buildLeadList(req.query, req.user);
    res.status(status).json(body);
  } catch (err) {
    console.error('Failed to build lead list:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load leads' });
  }
});

// MQL vs SQL by lead source and month — definitions in services/funnel.js.
router.get('/funnel', async (req, res) => {
  try {
    const { status, body } = await buildFunnel(req.query, req.user);
    res.status(status).json(body);
  } catch (err) {
    console.error('Failed to build lead funnel:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load the funnel' });
  }
});

module.exports = router;
