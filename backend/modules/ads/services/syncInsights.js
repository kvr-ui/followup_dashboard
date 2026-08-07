// Pull reporting metrics (spend, impressions, clicks, actions) into MetaInsight.
//
// Fetched ONE DAY AT A TIME. Meta will happily aggregate a whole range into a
// single row, but then "spend last Tuesday" is unanswerable, so the daily
// granularity is the point.
//
// Currency: `spend` comes back in MAJOR units (rupees) and is stored as such. The
// budgets on campaigns and ad sets are in MINOR units (paise). That mismatch is
// Meta's, not ours; normalising one to the other here is exactly how a number ends
// up wrong by a factor of a hundred, so both are stored as received and the
// difference is documented at every point it matters.
const MetaCampaign = require('../models/MetaCampaign');
const MetaAdset = require('../models/MetaAdset');
const MetaAd = require('../models/MetaAd');
const MetaInsight = require('../models/MetaInsight');
const meta = require('./metaClient');
const { keepIfKnown, loadKnownIds } = require('./syncHelpers');

// How many days to ask Meta for at once. The connector already retries and
// backs off; this just keeps a 30-day sync from opening 30 sockets.
const DAY_CONCURRENCY = 5;

/** Inclusive list of YYYY-MM-DD days between from and to. */
function eachDay(from, to) {
  const days = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Run an async fn over items with bounded concurrency. */
async function forEachLimit(items, limit, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      await fn(items[index++]);
    }
  });
  await Promise.all(workers);
}

/** Which id identifies the row at this aggregation level. */
function entityIdFor(level, insight) {
  if (level === 'ad') return insight.adId;
  if (level === 'adset') return insight.adsetId;
  if (level === 'campaign') return insight.campaignId;
  return 'account';
}

/**
 * Fetch reporting metrics for a date range and write them to MetaInsight.
 *
 * Fetching and writing are kept separate on purpose: the Meta calls are slow, so
 * holding a DB cursor across them would starve the connection pool and time out
 * concurrent API requests. Every row is gathered first (Graph API only), then
 * written in one batch.
 *
 * The write is an upsert on the natural key (level, entityId, dateStart, dateStop)
 * — the unique index MetaInsight declares. That is what makes a re-sync of the same
 * range REPLACE a day's numbers instead of appending a second copy of them.
 *
 * The retired CRM instead deleted the day and re-inserted it. Same end state, but
 * it left a window in which the day read as zero; the reconciliation endpoint
 * querying during a sync would show a phantom gap. Upserting has no such window.
 * The prune afterwards keeps the other half of delete-and-replace: an entity that
 * reported on a day and no longer does has its stale row removed.
 *
 * @param {{from:string, to:string, level?:'account'|'campaign'|'adset'|'ad'}} params
 * @returns {Promise<number>} rows written
 */
async function syncInsights(params) {
  const level = params.level || 'campaign';
  const days = eachDay(params.from, params.to);

  const [knownCampaigns, knownAdsets, knownAds] = await Promise.all([
    loadKnownIds(MetaCampaign),
    loadKnownIds(MetaAdset),
    loadKnownIds(MetaAd),
  ]);

  const rows = [];

  // Phase 1 — fetch every day from Meta. No DB work in here.
  await forEachLimit(days, DAY_CONCURRENCY, async (day) => {
    const insights = await meta.getInsights({ from: day, to: day, level });
    for (const i of insights) {
      rows.push({
        level,
        entityId: entityIdFor(level, i) || 'unknown',
        dateStart: i.dateStart || day,
        dateStop: i.dateStop || day,
        campaignId: keepIfKnown(i.campaignId, knownCampaigns),
        adsetId: keepIfKnown(i.adsetId, knownAdsets),
        adId: keepIfKnown(i.adId, knownAds),
        spend: i.spend, // rupees, NOT paise
        impressions: i.impressions,
        reach: i.reach,
        clicks: i.clicks,
        ctr: i.ctr,
        cpc: i.cpc,
        cpm: i.cpm,
        frequency: i.frequency,
        actions: i.actions,
        roas: i.roas,
      });
    }
  });

  if (!rows.length) return 0;

  // Phase 2 — one batched write, keyed on the natural index.
  try {
    await MetaInsight.bulkWrite(
      rows.map((r) => ({
        updateOne: {
          filter: {
            level: r.level,
            entityId: r.entityId,
            dateStart: r.dateStart,
            dateStop: r.dateStop,
          },
          update: { $set: r },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  } catch (err) {
    // Two upserts for the same key inside one unordered batch race each other and
    // one loses with E11000. Meta repeating a row shouldn't fail the whole day.
    if (err.code !== 11000) throw err;
  }

  // Phase 3 — prune. Only for days we actually received data for: deleting across
  // the whole requested range would wipe a day's rows whenever Meta returns an
  // empty result for it (common with attribution lag), silently losing numbers
  // until some later sync happened to refill them.
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.dateStart)) byDay.set(r.dateStart, new Set());
    byDay.get(r.dateStart).add(r.entityId);
  }
  for (const [dateStart, entityIds] of byDay) {
    await MetaInsight.deleteMany({
      level,
      dateStart,
      entityId: { $nin: [...entityIds] },
    });
  }

  return rows.length;
}

module.exports = { syncInsights, eachDay };
