const express = require('express');

const { listInstallments } = require('../controllers/installmentController');
const { authenticate } = require('../../../middleware/auth');

const router = express.Router();

// Deliberately NOT requireAdmin, unlike the rest of the calls module: every rep
// needs their own pending-payment list. The controller scopes non-admins to their
// own deals.
router.use(authenticate);

router.get('/', listInstallments);

module.exports = router;
