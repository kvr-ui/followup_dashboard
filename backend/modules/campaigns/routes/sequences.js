const express = require('express');

const c = require('../controllers/sequenceController');
const { authenticate, requireAdmin } = require('../../../middleware/auth');

const router = express.Router();

router.use(authenticate, requireAdmin);

router.post('/run', c.runNow); // above /:id

router.get('/', c.listSequences);
router.post('/', c.createSequence);
router.patch('/:id', c.toggleSequence);
router.delete('/:id', c.deleteSequence);

module.exports = router;
