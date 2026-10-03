const express = require('express');

const { login, me, config, googleLogin } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/login', login);
router.get('/config', config);
router.post('/google', googleLogin);
router.get('/me', authenticate, me);

module.exports = router;
