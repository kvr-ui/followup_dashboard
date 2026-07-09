const express = require('express');

const { getTemplates } = require('../controllers/watiController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.get('/templates', authenticate, getTemplates);

module.exports = router;
