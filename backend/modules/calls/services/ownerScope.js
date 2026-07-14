/**
 * Scope a Deal query to whoever is asking.
 *
 * The rep-facing views (instalments, upsells) are the only part of the calls module
 * a non-admin can reach, so the scoping has to hold on the server — not in the UI.
 *
 *   admin        -> everyone, or one rep via ?owner=
 *   sales        -> their own deals, ALWAYS. `?owner=` is ignored for them, so a rep
 *                   can't read a colleague's book by editing the URL.
 *   sales, no
 *   ownerEmail   -> null. They own no deals; returning {} would quietly hand them
 *                   the entire pipeline. Callers must treat null as "empty result",
 *                   not as "no filter".
 */
function ownerScope(req) {
  if (req.user.role === 'admin') {
    return req.query.owner ? { ownerEmail: String(req.query.owner).toLowerCase() } : {};
  }
  const mine = (req.user.ownerEmail || '').toLowerCase();
  return mine ? { ownerEmail: mine } : null;
}

module.exports = { ownerScope };
