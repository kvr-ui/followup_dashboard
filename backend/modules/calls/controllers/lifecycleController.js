const { buildRepLifecycle, buildLeadPreCall, listLifecycleOwners } = require('../services/repLifecycle');
const { parseRange, daysAgo, localIso } = require('../../ads/services/adMetrics');

// The Rep Lifecycle tab (admin-only): lead-in -> first call, by outcome, for one
// rep. See services/repLifecycle for which leads count and how.

const DEFAULT_DAYS = 90;

const fail = (res, status, message) => res.status(status).json({ success: false, message });

/** GET /api/calls/rep-lifecycle?owner=&from=&to= */
async function repLifecycle(req, res) {
  const owner = String(req.query.owner || '').trim();
  if (!owner) return fail(res, 400, "Missing 'owner' (the rep's email)");
  const range = parseRange({
    from: req.query.from || daysAgo(DEFAULT_DAYS - 1),
    to: req.query.to || localIso(new Date()),
  });
  if (range.error) return fail(res, 400, range.error);
  try {
    const result = await buildRepLifecycle({ ownerEmail: owner, ...range });
    return res.json({ success: true, owner, range, ...result });
  } catch (err) {
    console.error('[rep lifecycle] failed:', err.message);
    return fail(res, 500, 'Failed to load the rep lifecycle');
  }
}

/** GET /api/calls/rep-lifecycle/owners */
async function repLifecycleOwners(req, res) {
  try {
    return res.json({ success: true, owners: await listLifecycleOwners() });
  } catch (err) {
    console.error('[rep lifecycle] owners failed:', err.message);
    return fail(res, 500, 'Failed to load reps');
  }
}

/** GET /api/calls/rep-lifecycle/lead/:contactId — one lead's pre-call timeline. */
async function repLifecycleLead(req, res) {
  try {
    const lead = await buildLeadPreCall(req.params.contactId);
    if (!lead) return fail(res, 404, 'No such contact');
    return res.json({ success: true, lead });
  } catch (err) {
    console.error('[rep lifecycle] lead failed:', err.message);
    return fail(res, 500, 'Failed to load the lead timeline');
  }
}

module.exports = { repLifecycle, repLifecycleOwners, repLifecycleLead };
