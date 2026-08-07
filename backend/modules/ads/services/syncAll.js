// The full Meta → MongoDB sync, and the audit trail around it.
//
// Order is a dependency order, not a preference: campaigns → creatives → ad sets →
// ads → insights. Each stage validates its foreign keys against what is already
// local (see syncHelpers.js), so running ads before ad sets would null out every
// adsetId. Leads run last and are allowed to fail on their own.
//
// Every stage writes an AdSyncRun row — `running` when it starts, then `success`
// with a count or `error` with the message — and the whole run gets one more row
// under the resource `all`. That is the sync history the admin UI reads, and it is
// the only way to answer "why is yesterday missing" after the fact.
const AdSyncRun = require('../models/AdSyncRun');
const meta = require('./metaClient');
const { syncCampaigns } = require('./syncCampaigns');
const { syncCreatives } = require('./syncCreatives');
const { syncAdsets } = require('./syncAdsets');
const { syncAds } = require('./syncAds');
const { syncInsights } = require('./syncInsights');
const { syncAllLeads } = require('./syncLeads');

const INSIGHT_LOOKBACK_DAYS = Number(process.env.AD_INSIGHT_LOOKBACK_DAYS || 30);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raised when a second sync is requested while one is still running. */
class SyncInProgressError extends Error {
  constructor() {
    super('A sync is already in progress. Try again once it finishes.');
    this.name = 'SyncInProgressError';
  }
}

/**
 * Retry a stage when Meta rate-limits us, backing off exponentially. Every stage
 * is idempotent (upsert / upsert-and-prune), so re-running one is always safe.
 */
async function withRateLimitRetry(fn, attempts = 3) {
  let delayMs = 2000;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!meta.isRateLimitError(err) || i >= attempts - 1) throw err;
      console.warn(`[ads sync] rate limited; retrying in ${delayMs}ms (${i + 1}/${attempts - 1})`);
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
}

/** How many records a stage wrote: a count, or the sum of a result object's counts. */
function countOf(result) {
  if (typeof result === 'number') return result;
  if (result && typeof result === 'object') {
    return Object.values(result).reduce((sum, v) => sum + (typeof v === 'number' ? v : 0), 0);
  }
  return 0;
}

/**
 * Run one unit of sync work, recording exactly one AdSyncRun row for it.
 * Errors are logged, written to the row, and re-thrown to the caller — it is the
 * caller (the scheduler, or the admin route) that decides whether to swallow them.
 *
 * @param {string} resource  campaigns | creatives | adsets | ads | insights | leads | all
 * @param {() => Promise<any>} fn
 * @param {{retry?: boolean}} [options]  retry defaults to true; the wrapping `all`
 *        row turns it off so a rate limit doesn't re-run the entire sync.
 */
async function runTracked(resource, fn, options = {}) {
  const run = await AdSyncRun.create({ resource, status: 'running' });
  try {
    const result = options.retry === false ? await fn() : await withRateLimitRetry(fn);
    await AdSyncRun.findByIdAndUpdate(run._id, {
      status: 'success',
      recordsUpserted: countOf(result),
      finishedAt: new Date(),
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ads sync] ${resource} failed:`, message);
    await AdSyncRun.findByIdAndUpdate(run._id, {
      status: 'error',
      error: message,
      finishedAt: new Date(),
    });
    throw err;
  }
}

/** Default insights window: the last 30 days, as LOCAL calendar dates. */
function defaultInsightRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - INSIGHT_LOOKBACK_DAYS);
  // Local YYYY-MM-DD, not UTC. The container runs in IST, so a UTC date shifts
  // the day boundary and the synced window stops matching what the UI filters on.
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: fmt(from), to: fmt(to) };
}

/**
 * Rebuild the cost-per-lead cache off the freshly synced insights.
 *
 * Required lazily and failure-tolerant on purpose: the cache belongs to the
 * attribution work and may not be present yet, and a cache that won't rebuild is a
 * stale dashboard number, not a reason to fail a sync that already wrote its data.
 */
async function rebuildCplCache() {
  try {
    // eslint-disable-next-line global-require
    const cplCache = require('./cplCache');
    await cplCache.rebuild();
  } catch (err) {
    console.warn('[ads sync] CPL cache rebuild skipped:', err.message);
  }
}

// Guards against overlapping runs — the scheduler firing while a manual "Sync now"
// is in flight would have both racing on the same insight rows.
let syncInProgress = false;

/** Is a full sync running right now? */
function isSyncing() {
  return syncInProgress;
}

async function runSyncAll(range) {
  const campaigns = await runTracked('campaigns', syncCampaigns);
  const creatives = await runTracked('creatives', syncCreatives);
  const adsets = await runTracked('adsets', syncAdsets);
  const ads = await runTracked('ads', syncAds);

  // Insights are pulled twice: per campaign for the breakdowns, and at account
  // level for Meta's own totals. The two are compared in the reconciliation
  // endpoint — a gap between them is spend not attached to any campaign.
  const insights = await runTracked('insights', () =>
    syncInsights({ from: range.from, to: range.to, level: 'campaign' })
  );
  const accountInsights = await runTracked('insights:account', () =>
    syncInsights({ from: range.from, to: range.to, level: 'account' })
  );

  // Leads are best-effort: the form ids are configured separately and the
  // permission is separate too, so a failure here must not lose the spend data
  // the four stages above just wrote.
  let leads = 0;
  try {
    leads = await runTracked('leads', syncAllLeads);
  } catch (err) {
    console.warn('[ads sync] leads stage failed, continuing:', err.message);
  }

  await rebuildCplCache();

  return { campaigns, creatives, adsets, ads, insights, accountInsights, leads };
}

/**
 * Full sync. Only one may run at a time; a concurrent call throws
 * SyncInProgressError rather than queueing, so the admin endpoint can say so.
 *
 * @param {{from?:string, to?:string}} [range] insight window, YYYY-MM-DD.
 *        Defaults to the last 30 days.
 */
async function syncAll(range) {
  if (!meta.isConfigured()) {
    throw new Error('Meta is not configured (set META_ACCESS_TOKEN and META_AD_ACCOUNT_ID)');
  }
  if (syncInProgress) throw new SyncInProgressError();

  const window = { ...defaultInsightRange(), ...(range || {}) };

  syncInProgress = true;
  try {
    return await runTracked('all', () => runSyncAll(window), { retry: false });
  } finally {
    syncInProgress = false;
  }
}

module.exports = {
  syncAll,
  runTracked,
  isSyncing,
  SyncInProgressError,
  defaultInsightRange,
};
