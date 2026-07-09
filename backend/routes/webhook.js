const express = require('express');

const { receiveWebhook, getWebhookData } = require('../controllers/webhookController');

const router = express.Router();

// Receive incoming webhook data
router.post('/', receiveWebhook);

// Fetch stored webhook data (used by the frontend dashboard)
router.get('/', getWebhookData);

module.exports = router;
