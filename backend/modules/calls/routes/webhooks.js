const express = require('express');

const {
  receiveCallWebhook,
  receiveDealWebhook,
} = require('../controllers/callWebhookController');

const router = express.Router();

// Public (no auth) — TeleCMI and Bigin post here.
// Both respond immediately and do the slow work in the background.
router.post('/call', receiveCallWebhook);
router.post('/deal', receiveDealWebhook);

module.exports = router;
