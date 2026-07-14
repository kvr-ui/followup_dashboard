const express = require('express');

const c = require('../controllers/segmentController');
const { authenticate, requireAdmin } = require('../../../middleware/auth');

const router = express.Router();

router.use(authenticate, requireAdmin);

router.get('/schema', c.schema); // above /:id
router.post('/preview', c.previewRule);

router.get('/', c.listSegments);
router.post('/', c.createSegment);
router.patch('/:id', c.updateSegment);
router.delete('/:id', c.deleteSegment);

module.exports = router;
