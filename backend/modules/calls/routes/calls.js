const express = require('express');

const {
  listCalls,
  listJourneys,
  callStats,
  getCall,
  streamRecording,
  syncCalls,
} = require('../controllers/callController');
const { authenticate, requireAdmin } = require('../../../middleware/auth');

const router = express.Router();

// Call grading is admin-only, enforced on the server (not just hidden in the UI).
router.use(authenticate, requireAdmin);

router.get('/', listCalls);
router.get('/stats', callStats);
router.get('/journeys', listJourneys);
router.post('/sync', syncCalls);
router.get('/:id', getCall);
router.get('/:id/recording', streamRecording);

module.exports = router;
