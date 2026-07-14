// Cached snapshot of every closed lead + its calls.
//
// Why a snapshot rather than caching each query: the journeys view is filtered
// and paged a dozen different ways, so a per-query cache would miss on almost
// every click — page 2 is a different key from page 1, and you'd pay the full
// ~1.4s join again. Instead we build the whole set ONCE and then filter and page
// it in memory. It's small (about 2,700 leads / ~1.3 MB), so this is cheap.
//
// Same shape as the task-list cache in controllers/taskController.js:
// stale-while-revalidate, warmed at boot, invalidated on write.
const Deal = require('../models/Deal');

const TTL_MS = Number(process.env.JOURNEY_CACHE_TTL_MS || 60000);

let cache = null;
let cachedAt = 0;
let refreshing = null;
// See taskController's taskCacheGen: guards against a refresh that began before a
// deal/call write completing after invalidate() and re-marking stale data fresh.
let generation = 0;

/** The expensive bit: join every closed deal to its calls. Runs once per TTL. */
async function loadJourneys() {
  const t0 = Date.now();
  const rows = await buildJourneys();
  console.log(`[journeys] snapshot rebuilt: ${rows.length} leads in ${Date.now() - t0}ms`);
  return rows;
}

async function buildJourneys() {
  return Deal.aggregate([
    { $match: { outcome: { $in: ['won', 'lost'] } } },
    {
      $lookup: {
        from: 'calls',
        let: { dealId: '$zohoId' },
        pipeline: [
          // Uses the calls index on deal.id — without it this is a full scan
          // per deal, which is what made the endpoint take 20 seconds.
          { $match: { $expr: { $eq: ['$deal.id', '$$dealId'] } } },
          { $sort: { startedAt: 1 } },
          {
            $project: {
              startedAt: 1, duration: 1, direction: 1, agentExt: 1,
              ownerEmail: 1, transcriptionStatus: 1, hasRecording: 1,
              score: '$grade.score',
            },
          },
        ],
        as: 'calls',
      },
    },
    {
      $addFields: {
        totalCalls: { $size: '$calls' },
        totalDuration: { $sum: '$calls.duration' },
        longestCall: { $max: '$calls.duration' },
        transcribed: {
          $size: {
            $filter: { input: '$calls', cond: { $eq: ['$$this.transcriptionStatus', 'done'] } },
          },
        },
        pending: {
          $size: {
            $filter: { input: '$calls', cond: { $eq: ['$$this.transcriptionStatus', 'pending'] } },
          },
        },
        avgScore: { $avg: '$calls.score' },
        firstCall: { $min: '$calls.startedAt' },
        lastCall: { $max: '$calls.startedAt' },
      },
    },
    // Newest closed deals first: sort by close date, then by the deal's last
    // update and its most recent call as tie-breakers.
    { $sort: { closingDate: -1, modifiedTime: -1, lastCall: -1 } },
    {
      $project: {
        _id: '$zohoId',
        contactName: 1,
        phone: '$contactPhone',
        outcome: 1,
        lostReason: 1,
        upScale: 1,
        amount: 1,
        closingDate: 1,
        ownerEmail: 1,
        products: 1,
        totalCalls: 1,
        totalDuration: 1,
        longestCall: 1,
        transcribed: 1,
        pending: 1,
        avgScore: 1,
        firstCall: 1,
        lastCall: 1,
        calls: 1,
        deal: {
          id: '$zohoId',
          name: '$name',
          stage: '$stage',
          amount: '$amount',
          closingDate: '$closingDate',
          ownerName: '$ownerName',
          ownerEmail: '$ownerEmail',
          contactName: '$contactName',
          lostReason: '$lostReason',
          upScale: '$upScale',
          products: '$products',
        },
      },
    },
  ]);
}

async function getJourneys() {
  const fresh = cache && Date.now() - cachedAt < TTL_MS;
  if (fresh) return cache;

  if (!refreshing) {
    const startGen = generation;
    refreshing = loadJourneys()
      .then((rows) => {
        cache = rows;
        // If a write invalidated us mid-load, keep this (pre-write) snapshot stale
        // so the next read rebuilds with the write included.
        cachedAt = generation === startGen ? Date.now() : 0;
        return rows;
      })
      .finally(() => {
        refreshing = null;
      });
  }

  // Stale-while-revalidate: hand back the old copy instantly if we have one, so
  // a webhook or a slow Atlas read never makes the dashboard hang.
  return cache || refreshing;
}

/** Called after any deal/call write, so the next read reflects it immediately. */
function invalidate() {
  cachedAt = 0;
  generation += 1;
}

async function warm() {
  const rows = await getJourneys();
  console.log(`Journey cache warmed: ${rows.length} closed leads`);
}

module.exports = { getJourneys, invalidate, warm };
