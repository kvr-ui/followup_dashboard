const express = require('express');

const c = require('../controllers/campaignController');
const { authenticate, requireAdmin } = require('../../../middleware/auth');

const router = express.Router();

// Admin only, all of it, at the router level.
//
// This is not a UI preference. A campaign send spends real money, and every recipient
// is a person whose opinion of the brand is on the line — so unlike instalments and
// upsells (which reps see, scoped to their own book), there is no rep-facing slice of
// this module and therefore no ownerScope() here. If that ever changes, the scoping
// has to be added to the CONTROLLERS, not to the UI.
router.use(authenticate, requireAdmin);

// Collection-level. These sit above /:id so "templates" is never read as an id.
router.get('/templates', c.getTemplates);
router.post('/test-send', c.testSend);
router.get('/health', c.getHealth);
router.get('/inbox', c.inbox);
router.get('/timing/all', c.timing);

router.get('/', c.listCampaigns);
router.post('/', c.createCampaign);

router.get('/:id', c.getCampaign);
router.patch('/:id', c.updateCampaign);
router.delete('/:id', c.deleteCampaign);

router.get('/:id/messages', c.listMessages);
router.get('/:id/timing', c.timing);
router.get('/:id/replies', c.inbox);
router.post('/:id/preview', c.previewCampaign);

// Lifecycle.
router.post('/:id/approve', c.approveCampaign);
router.post('/:id/send', c.sendNow);
router.post('/:id/schedule', c.scheduleCampaign);
router.post('/:id/pause', c.pauseCampaign);
router.post('/:id/resume', c.resumeCampaign);
router.post('/:id/cancel', c.cancelCampaign);

router.post('/:id/duplicate', c.duplicateCampaign);
router.post('/:id/retarget', c.retarget);

module.exports = router;
