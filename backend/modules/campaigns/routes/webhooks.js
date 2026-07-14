const express = require('express');

const { receive } = require('../controllers/watiWebhookController');

const router = express.Router();

/**
 * POST /webhook/wati — public and unauthenticated, because it has to be: WATI's
 * servers post here and they hold no credential of ours.
 *
 * Protected instead by a shared secret in the URL, if you set one. WATI's webhook
 * config gives you a URL field and nothing else — no custom headers, no signing
 * secret, no HMAC — so a token in the query string is the only lever they hand you.
 * It is weak (it will sit in access logs and proxies) but it is strictly better than
 * an open endpoint that anyone who guesses the path can post fake `read` events to.
 *
 * With WATI_WEBHOOK_TOKEN unset the endpoint is open. server.js says so at boot
 * rather than letting it be a silent default.
 */
const TOKEN = process.env.WATI_WEBHOOK_TOKEN || null;

function checkToken(req, res, next) {
  if (!TOKEN) return next();

  const given = req.query.token || req.get('x-webhook-token');
  if (given === TOKEN) return next();

  // 200, not 403. A 4xx makes WATI retry, and a retry storm of rejected calls is
  // worse than the calls themselves. Refuse quietly, log loudly.
  console.warn('[wati webhook] rejected a request with a bad token');
  return res.status(200).json({ success: false, message: 'Bad token' });
}

router.post('/wati', checkToken, receive);

module.exports = router;
