// Run an existing Express handler in-process and capture what it would have sent.
//
// WHY NOT JUST REIMPLEMENT THE QUERY
// ----------------------------------
// The agent has to answer "what's my win rate" with the SAME number the Scorecard
// tab shows. Any second implementation of that aggregation is a second definition
// of a win rate, and the two will diverge the first time either is edited — at
// which point the dashboard and the agent disagree and nobody knows which is
// lying. Calling the real handler makes divergence impossible by construction.
//
// WHY NOT AN HTTP CALL TO OURSELVES
// ---------------------------------
// It would mean minting a token for the current user, a loopback round trip per
// tool call, and a server that deadlocks itself if the pool is saturated. This is
// the same function call the router would make, minus the socket.
//
// WHAT THIS IS NOT
// ----------------
// It is not a way around the auth gate. The synthetic request carries the REAL
// `req.user` loaded by `authenticate`, so every `ownerScope(req)` inside those
// handlers pins a sales rep to their own rows exactly as it does over HTTP.
// Router-level gates (`requireAdmin` on /api/ads) are NOT part of the handler, so
// anything behind one must be marked `adminOnly` in the tool table — see the
// dispatcher in tools.js, which refuses those before it ever gets here.

/**
 * @param {Function} handler  an (req, res) Express handler
 * @param {object} opts.user  the authenticated user document
 * @param {object} opts.query the query string the handler should see
 * @param {object} opts.params route params, if the handler reads any
 * @returns {Promise<{status: number, body: any}>}
 */
function invokeController(handler, { user, query = {}, params = {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (status, body) => {
      if (settled) return; // a handler that answers twice is a bug, not a second answer
      settled = true;
      resolve({ status, body });
    };

    let status = 200;
    const res = {
      status(code) {
        status = code;
        return res;
      },
      json(body) {
        finish(status, body);
        return res;
      },
      send(body) {
        finish(status, body);
        return res;
      },
      // Present so a handler that sets a header before answering doesn't throw.
      // Nothing reads them: this response never reaches a socket.
      set() {
        return res;
      },
      setHeader() {
        return res;
      },
      type() {
        return res;
      },
    };

    const req = { user, query, params, headers: {}, get: () => undefined };

    Promise.resolve()
      .then(() => handler(req, res))
      .then(() => {
        // Handlers here always answer. If one returns without doing so, say so
        // rather than leaving the agent's tool call hanging until the round cap.
        if (!settled) {
          settled = true;
          reject(new Error('Handler finished without sending a response'));
        }
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
  });
}

module.exports = { invokeController };
