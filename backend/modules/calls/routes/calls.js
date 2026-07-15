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
} = require('../controllers/callController');
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
router.get('/:id', getCall);
router.get('/:id/recording', streamRecording);

// Pulling fresh calls from TeleCMI is an admin-only write.
router.post('/sync', requireAdmin, syncCalls);

module.exports = router;
