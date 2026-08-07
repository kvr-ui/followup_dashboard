// Cost per lead, by campaign and calendar month.
//
// Meta reports no per-person cost, so any figure a lead detail shows is an
// apportionment: the campaign's spend for a month divided by the leads that
// campaign produced that month. The month is the unit because a day with ₹5,000
// spend and one lead would report a ₹5,000 lead, and a lifetime figure would make
// the same lead worth something different every time it is opened.
//
// The division itself is trivial; what is not trivial is doing it on every drawer
// open. So the two inputs — spend and lead count per campaign per month — are
// aggregated once into an in-memory table and looked up in O(1). The table is
// rebuilt after each successful ad sync and warmed at boot, matching how the
// dashboard already treats the task list and journeys caches.
//
// The result is DERIVED, never stored on the lead: spend for the current month
// accrues daily and Meta's figures settle for 24-48 hours, so a cost written onto
// a lead would be wrong by tomorrow.

const MetaInsight = require('../models/MetaInsight');

// Which Meta `actions` count as a "lead". Ported verbatim from the retired CRM's
// frontend/src/lib/insights.ts, and the reason is worth keeping: Meta's generic
// `lead` result is ALREADY deduplicated across form and pixel sources, so it
// alone is what Ads Manager shows. Summing every action type instead would count
// one lead several times and quietly halve the reported CPL. If a campaign ever
// optimises for a different result (WhatsApp campaigns report
// "onsite_conversion.messaging_conversation_started_7d"), add that type here —
// this set is the single place that decision lives.
const LEAD_ACTION_TYPES = new Set(['lead']);

/**
 * Sum the lead-type action values on one insight row.
 *
 * Tolerant about shape on purpose: the Meta package normalises entries to
 * `{ type, value }`, but rows copied straight out of the CRM's Atlas database
 * can carry Graph API's raw `{ action_type, value }` with a string value.
 */
function leadsFromActions(actions) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const type = action.type != null ? action.type : action.action_type;
    if (!LEAD_ACTION_TYPES.has(type)) continue;
    const value = Number(action.value);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

// campaignId + '|' + 'YYYY-MM'  ->  { spend, leads }
let table = new Map();
let builtAt = 0;
let building = null;
let lazyRebuildStarted = false;

const key = (campaignId, month) => `${campaignId}|${month}`;

/**
 * 'YYYY-MM' from a 'YYYY-MM-DD' insight date, a month that is already one, or a
 * Date.
 *
 * Dates are formatted in LOCAL time, not via toISOString(). Meta's `dateStart`
 * is a calendar day in the ad account's timezone (IST), and a lead captured at
 * 01 Aug 00:30 IST is 31 Jul 19:00 UTC — reading its month in UTC would bill it
 * to the previous month's spend and give the wrong cost. This is the same bug the
 * CRM's insights.ts calls out in its `iso()` helper.
 */
function monthOf(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }
  const text = String(value);
  return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : null;
}

async function build() {
  const next = new Map();

  // Campaign level only. Account-level rows would double-count every campaign,
  // and adset/ad rows would split one campaign's leads across several rows for no
  // gain — the lookup key is the campaign.
  //
  // Sorted on the model's own compound natural key so the summation order is
  // fixed. Floating-point addition is not associative, so an unordered scan can
  // return a spend that differs in the last decimal place between two rebuilds of
  // identical data — which is exactly the kind of unexplainable drift a money
  // figure must not have.
  const cursor = MetaInsight.find(
    { level: 'campaign' },
    { campaignId: 1, entityId: 1, dateStart: 1, spend: 1, actions: 1 }
  )
    .sort({ entityId: 1, dateStart: 1, dateStop: 1 })
    .lean()
    .cursor();

  let rows = 0;
  for await (const row of cursor) {
    // `campaignId` is nulled by the sync when the campaign is not in our mirror
    // (an archived parent); at campaign level `entityId` IS the campaign id, so
    // it is the reliable fallback.
    const campaignId = row.campaignId || row.entityId;
    const month = monthOf(row.dateStart);
    if (!campaignId || campaignId === 'unknown' || !month) continue;

    const bucketKey = key(campaignId, month);
    let bucket = next.get(bucketKey);
    if (!bucket) {
      bucket = { spend: 0, leads: 0 };
      next.set(bucketKey, bucket);
    }

    const spend = Number(row.spend);
    if (Number.isFinite(spend)) bucket.spend += spend;
    bucket.leads += leadsFromActions(row.actions);
    rows += 1;
  }

  // Spend is rupees (major units — unlike the budget fields, which are paise).
  // Round once, here, so every consumer divides the same number and two rebuilds
  // of the same data are byte-identical.
  for (const bucket of next.values()) {
    bucket.spend = Math.round(bucket.spend * 100) / 100;
  }

  return { next, rows };
}

/**
 * Recompute the whole table. Called by the ad sync after a successful run.
 * Concurrent callers share one build; the swap at the end is atomic, so readers
 * never see a half-filled table.
 */
async function rebuild() {
  if (!building) {
    building = build()
      .then(({ next, rows }) => {
        table = next;
        builtAt = Date.now();
        console.log(`[cpl] rebuilt: ${next.size} campaign-months from ${rows} insight rows`);
      })
      .finally(() => {
        building = null;
      });
  }
  return building;
}

/**
 * Boot-time warm. Never throws — a cold CPL table costs a null estimate on the
 * lead drawer, which is not worth failing a deploy over. Mirrors how the task and
 * journey caches are warmed in server.js.
 *
 * Exported under BOTH names deliberately: `warm` matches the journey cache's
 * exported name, which is the convention server.js already imports by
 * (`{ warm: warmJourneyCache }`), while `warmCplCache` is the self-describing
 * name for a plain `require(...).warmCplCache()` call.
 */
async function warmCplCache() {
  try {
    await rebuild();
  } catch (err) {
    console.warn('cpl cache warm failed:', err.message);
  }
}

/**
 * @param {string} campaignId a Meta campaign id (MetaCampaign._id)
 * @param {string} month 'YYYY-MM' — the month the lead was captured in
 * @returns {{spend: number, leads: number, cpl: number}|null}
 */
function lookup(campaignId, month) {
  if (!campaignId) return null;
  const normalizedMonth = monthOf(month);
  if (!normalizedMonth) return null;

  if (!builtAt) {
    // Never built — most likely a process that skipped the boot warm. Kick one
    // off so the NEXT read has an answer, but stay synchronous and return null
    // rather than putting an aggregation on a request path.
    if (!lazyRebuildStarted) {
      lazyRebuildStarted = true;
      rebuild().catch((err) => {
        // Released, not latched: a rebuild that failed because Mongo was still
        // connecting must be retried by the next read, or one unlucky first
        // request would leave the cache cold for the life of the process.
        lazyRebuildStarted = false;
        console.warn('cpl cache lazy rebuild failed:', err.message);
      });
    }
    return null;
  }

  const bucket = table.get(key(String(campaignId), normalizedMonth));
  if (!bucket) return null;

  // A campaign-month can genuinely have spend and no leads — a brand campaign, or
  // a lead campaign that simply did not convert. Its cost per lead is undefined,
  // not infinite, and "no data" is the only honest thing to show. Returning
  // Infinity here would render as "₹Infinity" on a rep's screen.
  if (!(bucket.leads > 0)) return null;
  if (!Number.isFinite(bucket.spend)) return null;

  return { spend: bucket.spend, leads: bucket.leads, cpl: bucket.spend / bucket.leads };
}

/** Diagnostics for the admin reporting API. */
function stats() {
  return { entries: table.size, builtAt: builtAt ? new Date(builtAt).toISOString() : null };
}

module.exports = {
  rebuild,
  warmCplCache,
  warm: warmCplCache,
  lookup,
  stats,
  monthOf,
  leadsFromActions,
  LEAD_ACTION_TYPES,
};
