const express = require('express');

const { getAnalytics } = require('../controllers/analyticsController');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticate, requireAdmin, getAnalytics);

module.exports = router;
