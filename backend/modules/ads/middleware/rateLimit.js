// Tiny in-memory, per-IP sliding-window rate limiter (no external dependency).
// Ported from the retired focas-crm (backend/src/middleware/rateLimit.ts).
//
// Suitable for a single-instance deployment; for multi-instance, front the API
// with a shared limiter (e.g. at the reverse proxy) instead.

// Best-effort client IP: prefer the proxy-appended (last) X-Forwarded-For hop.
//
// Caveat, deliberately kept from the source: with no reverse proxy in front,
// X-Forwarded-For is attacker-controlled, so a determined flooder can rotate the
// header and slip the limit. That is acceptable here — this limiter exists to
// blunt junk-lead floods, NOT as an access control. The access control on the
// public ingest route is the LEAD_INGEST_TOKEN shared secret. Preferring the
// header is what makes the limiter useful at all in the real deployment, where
// every request reaches the app from the proxy's single socket address.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Build a rate-limiting middleware.
 *
 * @param {object}  options
 * @param {number}  options.windowMs  sliding window size, in milliseconds
 * @param {number}  options.max       max requests per IP per window
 * @param {string} [options.message]  body message returned on 429
 */
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();

  // Prune stale IPs so the map doesn't grow unbounded.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of hits) {
      const fresh = arr.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(ip, fresh);
      else hits.delete(ip);
    }
  }, windowMs);
  // Never hold the process open just for the pruner.
  if (timer.unref) timer.unref();

  return function rateLimiter(req, res, next) {
    const ip = clientIp(req);
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);

    if (arr.length >= max) {
      hits.set(ip, arr);
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        success: false,
        message: message || 'Too many requests. Please try again later.',
      });
    }

    arr.push(now);
    hits.set(ip, arr);
    next();
  };
}

module.exports = { rateLimit, clientIp };
