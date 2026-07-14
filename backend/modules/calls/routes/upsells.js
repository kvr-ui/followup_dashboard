const express = require('express');

const { listUpsells } = require('../controllers/upsellController');
const { authenticate } = require('../../../middleware/auth');

const router = express.Router();

// Not requireAdmin: every rep sees their own upsells. The controller scopes them.
router.use(authenticate);

router.get('/', listUpsells);

module.exports = router;
