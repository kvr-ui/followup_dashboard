// Date handling and insight roll-ups for the ads reporting API.
//
// Lifted out of routes/ads.js verbatim so a SECOND caller — the ask-the-data
// agent's ad tools (modules/agent/services/tools.js) — can produce the same
// numbers as the Marketing tab by running the same code, rather than by
// re-implementing CTR and cost-per-lead and hoping the two definitions stay in
// step. The router's own header already refuses to compute anything a service
// computes; this is that rule applied to the router itself.
//
// TWO CURRENCIES, DELIBERATELY UNRECONCILED
// -----------------------------------------
// Insight `spend` is in RUPEES (major units). Campaign/ad-set budgets are in
// PAISE (minor units). That is Meta's split, not ours, and normalising one to
// the other is precisely how a figure ends up wrong by a factor of a hundred.
// Both are returned exactly as stored, and the *_UNITS blocks name which is
// which.

const MetaInsight = require('../models/MetaInsight');
const cplCache = require('./cplCache');

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------
//
// Insight rows are keyed on `dateStart`/`dateStop`, which are Meta's CALENDAR
// dates in the ad account's timezone (IST) — plain 'YYYY-MM-DD' strings, not
// instants. So every date here is computed in LOCAL time and compared as a
// string. `toISOString()` is banned in this file for exactly the reason the CPL
// cache and the sync both spell out: the container runs in IST, and a date
// derived in UTC shifts the day boundary, making "this month" start a day early
// and quietly moving a day's spend into the wrong bucket.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;

/** Format a Date as local 'YYYY-MM-DD'. */
function localIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localIso(d);
}

/** The day after `date`, as 'YYYY-MM-DD'. Used for exclusive upper bounds. */
function nextDay(date) {
  const d = new Date(`${date}T00:00:00`); // local, not UTC
  d.setDate(d.getDate() + 1);
  return localIso(d);
}

/**
 * A well-formed calendar date, rejecting the ones that only LOOK well-formed:
 * '2026-02-31' parses happily and rolls over to March, so it is round-tripped
 * through a local Date and compared back.
 */
function isValidDate(value) {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00`);
  return Number.isFinite(d.getTime()) && localIso(d) === value;
}

/**
 * The from/to range for a request.
 *
 * Omitted => the last 30 calendar days INCLUDING today (so `from` is 29 days
 * back), which is the window the retired CRM's date picker called "Last 30 days"
 * and the one the Marketing tab opens on.
 *
 * @returns {{from: string, to: string}|{error: string}}
 */
function parseRange(query) {
  const rawFrom = query.from;
  const rawTo = query.to;

  const from = rawFrom == null || rawFrom === '' ? daysAgo(DEFAULT_RANGE_DAYS - 1) : String(rawFrom);
  const to = rawTo == null || rawTo === '' ? localIso(new Date()) : String(rawTo);

  if (!isValidDate(from)) return { error: `Invalid 'from' date: expected YYYY-MM-DD, got '${from}'` };
  if (!isValidDate(to)) return { error: `Invalid 'to' date: expected YYYY-MM-DD, got '${to}'` };
  if (from > to) return { error: `Invalid range: 'from' (${from}) is after 'to' (${to})` };

  return { from, to };
}

/**
 * The Mongo filter for "insight rows inside this range".
 *
 * Both ends are bounded because a row is a period, not a point: `dateStart >=
 * from` alone would let a hypothetical multi-day row leak spend from beyond `to`
 * into the total. The sync writes one row per day, so in practice
 * dateStart === dateStop, but the totals must not depend on that.
 */
function rangeFilter({ from, to }) {
  return { dateStart: { $gte: from }, dateStop: { $lte: to } };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// Everything the roll-ups read off an insight row. `actions` is the expensive
// one (an array per row), and it is the only way to count leads.
const METRIC_FIELDS = {
  entityId: 1,
  campaignId: 1,
  dateStart: 1,
  dateStop: 1,
  spend: 1,
  impressions: 1,
  reach: 1,
  clicks: 1,
  actions: 1,
};

/**
 * Insight rows for a filter, in a FIXED order.
 *
 * The sort is not cosmetic. Floating-point addition is not associative, so an
 * unordered scan can total the same rows to a slightly different last decimal
 * between two identical requests — unexplainable drift on a money figure. Sorted
 * on the model's own natural key, the same one the CPL cache sorts on.
 */
function readMetrics(filter) {
  return MetaInsight.find(filter, METRIC_FIELDS)
    .sort({ entityId: 1, dateStart: 1, dateStop: 1 })
    .lean();
}

const round = (value, places) => {
  const factor = 10 ** places;
  return Number.isFinite(value) ? Math.round(value * factor) / factor : 0;
};
const money = (value) => round(value, 2);

/**
 * Roll a set of insight rows into one set of totals.
 *
 * Note what is NOT summed: Meta's per-row `ctr`, `cpc` and `cpm`. Those are
 * ratios, and the mean of a set of ratios is not the ratio of the set — a day
 * with 2 clicks on 10 impressions weighs the same as a day with 2,000 on 10,000.
 * They are recomputed from the summed numerator and denominator instead.
 *
 * Leads come from `cplCache.leadsFromActions`, which counts Meta's `lead` action
 * type and nothing else. That is deliberate and shared: Meta's generic `lead`
 * result is already deduplicated across form and pixel sources, so summing every
 * action type would count one lead several times and halve the reported CPL. Any
 * change to that definition belongs in the CPL cache, where it is made once.
 */
function rollUp(rows) {
  let spend = 0;
  let impressions = 0;
  let reach = 0;
  let clicks = 0;
  let leads = 0;

  for (const row of rows) {
    const rowSpend = Number(row.spend);
    if (Number.isFinite(rowSpend)) spend += rowSpend;
    impressions += Number(row.impressions) || 0;
    reach += Number(row.reach) || 0;
    clicks += Number(row.clicks) || 0;
    leads += cplCache.leadsFromActions(row.actions);
  }

  return {
    spend: money(spend),
    impressions,
    reach,
    clicks,
    leads,
    // Percent, as Meta reports it.
    ctr: impressions > 0 ? round((clicks / impressions) * 100, 4) : 0,
    // Cost per click / per lead. Zero denominators return null, not Infinity:
    // a campaign with spend and no leads has an UNDEFINED cost per lead, and
    // "no data" is the only honest rendering — `₹Infinity` on an admin's screen
    // is a bug report waiting to happen. Same rule the CPL cache applies.
    cpc: clicks > 0 ? money(spend / clicks) : null,
    cpl: leads > 0 ? money(spend / leads) : null,
  };
}

// Which unit each money field is in. Sent with every response that carries
// money so the frontend never has to remember the rupees/paise split.
const SPEND_UNITS = { spend: 'rupees', cpc: 'rupees', cpl: 'rupees' };
const BUDGET_UNITS = { dailyBudget: 'paise', lifetimeBudget: 'paise' };

module.exports = {
  DEFAULT_RANGE_DAYS,
  localIso,
  daysAgo,
  nextDay,
  isValidDate,
  parseRange,
  rangeFilter,
  readMetrics,
  round,
  money,
  rollUp,
  SPEND_UNITS,
  BUDGET_UNITS,
};
