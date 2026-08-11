const express = require('express');

const {
  listCalls,
  listJourneys,
  callStats,
  outcomeStats,
  gradeAnalytics,
  getCall,
  streamRecording,
  syncCalls,
  pipelineHealth,
} = require('../controllers/callController');
const { apiUsage } = require('../controllers/usageController');
const { authenticate, requireAdmin } = require('../../../middleware/auth');

const router = express.Router();

// Everything here needs a logged-in user. The READ endpoints are open to sales reps
// too, but each controller hard-scopes a non-admin to their OWN ownerEmail (a rep can
// only ever see their own calls/scores/recordings) — enforced on the server, not just
// hidden in the UI.
router.use(authenticate);

router.get('/', listCalls);
router.get('/stats', callStats);
router.get('/outcomes', outcomeStats); // won/lost + why we lose
router.get('/grades', gradeAnalytics); // scorecard from AI call grades (self-scoped for reps)
router.get('/journeys', listJourneys);
// Whole-system, not per-rep: how many calls are stuck or will never be scored.
router.get('/pipeline-health', requireAdmin, pipelineHealth);
// AI spend (Sarvam tokens + ElevenLabs minutes) and the providers' remaining balance.
// Account-wide billing data, so admin-only — and declared BEFORE '/:id' or the id
// route would swallow it.
router.get('/usage', requireAdmin, apiUsage);
router.get('/:id', getCall);
router.get('/:id/recording', streamRecording);

// Pulling fresh calls from TeleCMI is an admin-only write.
router.post('/sync', requireAdmin, syncCalls);

module.exports = router;
