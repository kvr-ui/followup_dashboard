// How far back a reconcile poll reaches.
//
// A fixed "last 2 hours" window only heals a gap if we were alive to poll
// through it. We restart, and we have lost closed deals exactly that way: the
// process comes back, looks back 2 hours, sees only fresh records, and never
// learns it missed anything.
//
// So each job keeps a cursor (SyncState) instead. We poll from the cursor, and
// only advance it when a poll SUCCEEDS. Down for three days -> the cursor is
// three days old -> the next poll reaches back three days. Self-healing, with
// no dependence on the webhook ever arriving.
const SyncState = require('../models/SyncState');

const OVERLAP_MIN = Number(process.env.RECONCILE_OVERLAP_MINUTES || 15);
const COLD_START_HOURS = Number(process.env.RECONCILE_COLD_START_HOURS || 2);
const MAX_LOOKBACK_DAYS = Number(process.env.RECONCILE_MAX_LOOKBACK_DAYS || 30);

/**
 * Where should this poll start from?
 *
 * @param job   'calls' | 'deals' | 'tasks'
 * @param seed  async () => ms|null — on the very first run there is no cursor,
 *              so we seed from the newest record we already hold. Without this,
 *              a fresh deploy would cold-start at 2h and skip whatever was
 *              missed before it.
 */
async function sinceFor(job, seed) {
  const state = await SyncState.findOne({ job }).lean();

  let mark = state && state.lastModified ? new Date(state.lastModified).getTime() : null;
  if (!mark && typeof seed === 'function') mark = await seed();

  const now = Date.now();
  const coldStart = now - COLD_START_HOURS * 60 * 60 * 1000;
  const floor = now - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  if (!mark) return Math.max(coldStart, floor);

  // Re-read a little before the cursor (clock skew, out-of-order writes), always
  // sweep at least the cold-start window, and never reach past MAX_LOOKBACK.
  // Every upsert is keyed, so re-reading is free of side effects.
  return Math.max(Math.min(mark - OVERLAP_MIN * 60 * 1000, coldStart), floor);
}

/**
 * Advance the cursor. Call ONLY after a poll fully succeeds.
 *
 * We store the time the poll STARTED, not finished — anything modified while it
 * was running must still be picked up next time.
 */
async function commit(job, startedAt) {
  await SyncState.findOneAndUpdate(
    { job },
    { job, lastModified: startedAt, lastRunAt: new Date() },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

const fmtWindow = (from) =>
  `${new Date(from).toISOString().slice(0, 16).replace('T', ' ')} -> now ` +
  `(${((Date.now() - from) / 36e5).toFixed(1)}h)`;

module.exports = { sinceFor, commit, fmtWindow, OVERLAP_MIN, COLD_START_HOURS, MAX_LOOKBACK_DAYS };
