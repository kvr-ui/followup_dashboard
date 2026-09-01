// How much of the VSL each lead has actually watched.
//
// WHY NOT JUST READ vsl_leads.watchedSeconds
// ------------------------------------------
// Because it is not a peak, it is a snapshot. focasvsl's event route $sets it on
// every beacon, so a lead who watched 12 minutes on Monday and reopened the page
// on Tuesday reads as 8 SECONDS. Reporting that would tell the sales team their
// most engaged leads are their coldest. The honest number is the maximum ever
// recorded, which lives in the append-only vsl_events log.
//
// WHY ONE GLOBAL MAP RATHER THAN A LOOKUP PER LEAD
// ------------------------------------------------
// vsl_events has no index but _id_ (focasvsl's ensure-indexes.mjs only builds
// them on vsl_leads, and we are a read-only guest here — we cannot add one). So
// a per-request { leadId: { $in: [...] } } is a FULL COLLECTION SCAN too — the
// same scan this file does, just paid once per drawer open instead of once per
// TTL. One shared map is therefore strictly cheaper, and it serves the tracking
// tab, the lead drawer and the follow-ups column alike.
//
// HOW THE SCAN COST IS AVOIDED AFTER BOOT
// ---------------------------------------
// vsl_events is append-only and its _id is a time-ordered ObjectId, and _id_ is
// an index that already exists. So the full $group runs ONCE at boot (off the
// request path, like warmJourneyCache), and every refresh after it matches only
// { _id: { $gt: <watermark rewound 5 minutes> } } — an INDEXED RANGE SCAN over
// the handful of events since last time — then folds the result into the map
// with Math.max.
//
// The rewind costs nothing because a max-fold is idempotent, and it closes the
// one real hole: ObjectId monotonicity is second-granular and per-process, so two
// focasvsl instances can interleave _ids within a one-second window. Re-reading
// five minutes of events and re-maxing them changes nothing.
//
// And because the fold only ever takes the maximum, this map CANNOT exhibit the
// regression that makes vsl_leads.watchedSeconds untrustworthy. That is the whole
// point of the feature.

const { Types } = require('mongoose');
const { isConfigured } = require('./connection');
const { phoneKey } = require('../../../utils/phone');

const TTL_MS = Number(process.env.VSL_WATCH_TTL_MS || 60000);

// How far back to rewind the watermark on an incremental refresh. Covers clock
// skew and interleaved _ids from concurrent focasvsl instances.
const REWIND_MS = 5 * 60 * 1000;

const ZERO_ID = Types.ObjectId.createFromTime(0);

/**
 * The $group that turns an event log into one peak row per lead.
 *
 * $convert(onError, onNull) — NOT $toDouble — is load-bearing. focasvsl's event
 * route coerces watchedSeconds/currentTime/videoDuration before inserting but
 * lets `watchPercentage` through from the raw browser payload, so a string or a
 * null is genuinely possible in this collection. $toDouble ABORTS THE ENTIRE
 * AGGREGATION on one such row, which would take the whole feature down until
 * someone deleted the document. $convert yields 0 for that row and moves on.
 *
 * `events` counts only rows past `countFrom`, so the 5-minute rewind overlap is
 * re-maxed (harmless) without being re-counted (which would inflate the total a
 * little more on every single refresh).
 */
function peakStages(countFrom) {
  const num = (field) => ({
    $max: { $convert: { input: field, to: 'double', onError: 0, onNull: 0 } },
  });
  return [
    {
      $group: {
        _id: '$leadId',
        seconds: num('$watchedSeconds'),
        percentage: num('$watchPercentage'),
        duration: num('$videoDuration'),
        firstEventAt: { $min: '$receivedAt' },
        lastEventAt: { $max: '$receivedAt' },
        completed: { $max: { $cond: [{ $eq: ['$eventType', 'completed'] }, 1, 0] } },
        played: { $max: { $cond: [{ $eq: ['$eventType', 'play_started'] }, 1, 0] } },
        events: { $sum: { $cond: [{ $gt: ['$_id', countFrom] }, 1, 0] } },
        maxId: { $max: '$_id' },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let peaks = null; // Map<leadId, peak>
let byPhoneKey = null; // Map<phoneKey, { leadId, seconds, minutes, percentage }>
let watermark = null; // highest vsl_events _id folded in so far
let builtAt = 0;
let buildMs = 0;
let refreshing = null;
let lastError = null;

/** Fold one aggregation row into the map. Max on every value, min on the first date. */
function fold(map, row) {
  const prev = map.get(row._id);
  if (!prev) {
    map.set(row._id, {
      seconds: row.seconds || 0,
      percentage: row.percentage || 0,
      duration: row.duration || 0,
      events: row.events || 0,
      firstEventAt: row.firstEventAt || null,
      lastEventAt: row.lastEventAt || null,
      completed: Boolean(row.completed),
      played: Boolean(row.played),
    });
    return;
  }
  prev.seconds = Math.max(prev.seconds, row.seconds || 0);
  prev.percentage = Math.max(prev.percentage, row.percentage || 0);
  prev.duration = Math.max(prev.duration, row.duration || 0);
  prev.events += row.events || 0;
  prev.completed = prev.completed || Boolean(row.completed);
  prev.played = prev.played || Boolean(row.played);
  if (row.firstEventAt && (!prev.firstEventAt || row.firstEventAt < prev.firstEventAt)) {
    prev.firstEventAt = row.firstEventAt;
  }
  if (row.lastEventAt && (!prev.lastEventAt || row.lastEventAt > prev.lastEventAt)) {
    prev.lastEventAt = row.lastEventAt;
  }
}

/**
 * The phoneKey -> watch map the follow-ups column reads.
 *
 * One read of vsl_leads (one document per lead, no aggregation) joined to the
 * peak map by leadId. Keyed by the STRICT last-10-digit key, the same one
 * Task.phoneKey holds — a lead whose number is shorter than 10 digits simply has
 * no entry rather than being loosely matched to somebody else.
 */
async function buildPhoneIndex(peakMap) {
  const VslLead = require('../models/VslLead')();
  if (!VslLead) return new Map();

  const leads = await VslLead.find({}, { leadId: 1, phone: 1, watchedSeconds: 1, watchPercentage: 1 })
    .lean()
    .exec();

  const map = new Map();
  for (const lead of leads) {
    const pk = phoneKey(lead.phone);
    if (!pk) continue;
    const peak = peakMap.get(lead.leadId);
    // The peak when we have events; the lead's own (overwritable) value only as a
    // last resort, for rows that predate event logging.
    const seconds = peak ? peak.seconds : Number(lead.watchedSeconds) || 0;
    const percentage = peak ? peak.percentage : Number(lead.watchPercentage) || 0;
    const prev = map.get(pk);
    // Two VSL leads can share a phone tail; keep the more engaged one.
    if (prev && prev.seconds >= seconds) continue;
    map.set(pk, {
      leadId: lead.leadId,
      seconds,
      minutes: Math.round((seconds / 60) * 10) / 10,
      percentage,
    });
  }
  return map;
}

/** Full scan, or an indexed range scan when we already have a watermark. */
async function rebuild() {
  const VslEvent = require('../models/VslEvent')();
  if (!VslEvent) return;

  const t0 = Date.now();
  const incremental = Boolean(peaks && watermark);

  const pipeline = [];
  let countFrom = ZERO_ID;
  if (incremental) {
    countFrom = watermark;
    const rewound = Types.ObjectId.createFromTime(
      Math.floor((watermark.getTimestamp().getTime() - REWIND_MS) / 1000)
    );
    pipeline.push({ $match: { _id: { $gt: rewound } } });
  }
  pipeline.push(...peakStages(countFrom));

  const rows = await VslEvent.aggregate(pipeline).exec();

  const map = incremental ? peaks : new Map();
  let highest = watermark;
  for (const row of rows) {
    if (row._id == null) continue; // an event with no leadId is not a lead
    fold(map, row);
    if (row.maxId && (!highest || row.maxId > highest)) highest = row.maxId;
  }

  peaks = map;
  watermark = highest;
  byPhoneKey = await buildPhoneIndex(map);
  builtAt = Date.now();
  buildMs = builtAt - t0;
  lastError = null;

  // The tripwire. If a refresh ever takes about as long as the cold build, the
  // watermark is not being applied and it is scanning the whole log every minute.
  console.log(
    `[vsl] peak map ${incremental ? 'refreshed' : 'built'}: ${map.size} leads, ` +
      `${rows.length} changed, ${byPhoneKey.size} phone keys in ${buildMs}ms`
  );
}

/** One rebuild at a time; concurrent callers share it. */
function startRefresh() {
  if (refreshing) return refreshing;
  refreshing = rebuild()
    .catch((err) => {
      lastError = err.message;
      console.warn('[vsl] peak map refresh failed:', err.message);
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function isStale() {
  return !peaks || Date.now() - builtAt >= TTL_MS;
}

// ---------------------------------------------------------------------------
// Accessors — the difference between these two is load-bearing
// ---------------------------------------------------------------------------

/**
 * The map, awaiting a cold build if there isn't one yet.
 * For the VSL tab and the lead drawer, where the number IS the answer.
 */
async function getPeakMap() {
  if (!isConfigured()) return new Map();
  if (!peaks) {
    await startRefresh();
    return peaks || new Map();
  }
  if (isStale()) startRefresh(); // stale-while-revalidate: serve now, refresh behind
  return peaks;
}

/** Same, for the phoneKey-keyed view. */
async function getPhoneWatchMap() {
  if (!isConfigured()) return new Map();
  await getPeakMap();
  return byPhoneKey || new Map();
}

/**
 * The phoneKey map if we already have one, or null. NEVER awaits, never throws.
 *
 * This exists solely for GET /api/tasks, which every open browser polls every 15
 * seconds and which the whole dashboard blocks on. That endpoint must not acquire
 * a dependency on a second Atlas cluster: a cold or unreachable VSL cluster makes
 * the Watched column render a dash, and nothing else.
 */
function peekPhoneWatchMap() {
  if (!isConfigured()) return null;
  if (isStale()) startRefresh(); // kicked, never awaited
  return byPhoneKey;
}

/** Warmed at boot so the first tab open isn't the slow one. */
async function warm() {
  if (!isConfigured()) return;
  await startRefresh();
}

/** Diagnostics for GET /api/vsl/status. */
function stats() {
  return {
    leads: peaks ? peaks.size : 0,
    phoneKeys: byPhoneKey ? byPhoneKey.size : 0,
    builtAt: builtAt ? new Date(builtAt).toISOString() : null,
    buildMs,
    stale: isStale(),
    error: lastError,
  };
}

module.exports = { getPeakMap, getPhoneWatchMap, peekPhoneWatchMap, warm, stats };
