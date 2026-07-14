const express = require('express');

const c = require('../controllers/contactController');
const { authenticate, requireAdmin } = require('../../../middleware/auth');

const router = express.Router();

// Admin only. The contact book IS the send list — anyone who can edit it can decide
// who gets messaged, so it carries the same gate as the campaigns themselves.
router.use(authenticate, requireAdmin);

// Above /:id, so these words are never parsed as an object id.
router.get('/tags', c.listTags);
router.get('/suppressions', c.listSuppressions);
router.post('/suppressions', c.addSuppression);

router.post('/import', c.importContacts);
router.post('/import/bigin', c.importFromBigin);
router.post('/bulk-tag', c.bulkTag);

router.get('/', c.listContacts);
router.post('/', c.createContact);

router.get('/:id/history', c.contactHistory);
router.post('/:id/opt-out', c.optOut);
router.post('/:id/opt-in', c.optIn);

router.patch('/:id', c.updateContact);
router.delete('/:id', c.deleteContact);

module.exports = router;
