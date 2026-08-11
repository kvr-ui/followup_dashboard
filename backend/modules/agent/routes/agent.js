// The ask-the-data agent's API.
//
// Behind `authenticate` and nothing else, deliberately: this is open to sales
// reps as well as admins, and the scoping happens per TOOL rather than per route
// (see modules/agent/services/tools.js). A rep reaches the same endpoint and gets
// answers about their own book; the admin-only tools refuse them by name.

const express = require('express');
const { authenticate } = require('../../../middleware/auth');
const { chat, status } = require('../controllers/agentController');

const router = express.Router();

router.use(authenticate);

router.get('/status', status);
router.post('/chat', chat);

module.exports = router;
