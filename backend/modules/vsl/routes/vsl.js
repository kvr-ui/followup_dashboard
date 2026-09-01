const express = require('express');

const { listVslLeads, vslStatus } = require('../controllers/vslController');
const { authenticate } = require('../../../middleware/auth');

const router = express.Router();

// Deliberately NOT requireAdmin, unlike the ads tabs this sits next to: every rep
// needs to know whether the lead they are about to call has watched the video.
// The controller scopes non-admins to VSL leads matching follow-ups they OWN, so
// a rep never sees another rep's book — and never sees a watcher who isn't in the
// dashboard at all.
router.use(authenticate);

router.get('/status', vslStatus);
router.get('/leads', listVslLeads);

module.exports = router;
