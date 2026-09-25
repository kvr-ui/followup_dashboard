// GET /api/leads-list — every lead, one row per phone, scoped to the caller.
//
// Mounted at /api/leads-list, NOT /api/leads/...: /api/leads/web is the
// unauthenticated landing-page ingest (see leadProfile.js route). Auth only —
// the admin / rep scope lives in buildLeadList.

const express = require('express');
const { authenticate } = require('../../../middleware/auth');
const { buildLeadList } = require('../services/leadList');

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

module.exports = router;
