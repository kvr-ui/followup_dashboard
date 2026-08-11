// Pure helpers behind the Marketing and Ad Leads tabs — formatting, lead
// counting, roll-ups, date ranges and the UTM breakdown. Sits alongside
// taskStats.js and, like it, imports nothing: no charting library, no date
// library, no formatting library. The frontend's only dependencies are React
// and react-dom, and this file does not change that.
//
// TWO CURRENCIES, NEVER COLLAPSED
// -------------------------------
// Meta reports insight `spend` in RUPEES (major units) and campaign / ad-set
// budgets in PAISE (minor units). The ads API returns both exactly as Meta
// stores them and tags each response with a `units` block saying which is which
// (see backend/modules/ads/routes/ads.js). So there are two formatters here, as
// there were in the retired CRM, and picking the wrong one makes a figure wrong
// by a factor of a hundred. `formatRupees` for spend / CPC / CPL; `formatPaise`
// for `dailyBudget` and `lifetimeBudget`. Nothing else.

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// Indian digit grouping (2,11,681.84 — lakhs and crores, not thousands), which
// is what an Indian ad account's figures are read in. Two fraction digits, not
// zero: the reconciliation panel and the KPI row have to show the SAME number
// Meta's own account totals carry, and rounding a spend total to whole rupees
// on screen would make it disagree with Ads Manager by a few paise for no gain.
const RUPEES = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const COUNTS = new Intl.NumberFormat('en-IN');

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Money already in MAJOR units (rupees): insight spend, CPC, CPL. */
export function formatRupees(value) {
  const n = finite(value);
  return n == null ? '—' : RUPEES.format(n);
}

/** Money in MINOR units (paise): campaign and ad-set budgets. Divide by 100. */
export function formatPaise(value) {
  const n = finite(value);
  return n == null ? '—' : RUPEES.format(n / 100);
}

export function formatCount(value) {
  const n = finite(value);
  return n == null ? '0' : COUNTS.format(n);
}

/** A percentage that already IS a percentage — Meta reports CTR as 1.23, not 0.0123. */
export function formatPct(value) {
  const n = finite(value);
  return n == null ? '—' : `${n.toFixed(2)}%`;
}

export function formatDay(value) {
  if (!value) return '—';
  const d = new Date(String(value).length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "3 hr ago" — for the sync history's "last run" line. */
export function relativeTime(value) {
  if (!value) return 'never';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'never';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// Lead counting
// ---------------------------------------------------------------------------

// Which Meta `actions` entries count as a lead. Meta's generic `lead` result is
// ALREADY deduplicated across instant-form and pixel sources, so it is used
// alone: summing every action type would count one lead several times over and
// halve the reported cost per lead. This is the same single definition the
// backend's cplCache applies, ported verbatim from the retired CRM's
// insights.ts — if it ever needs to change (a WhatsApp-optimised campaign
// reports `onsite_conversion.messaging_conversation_started_7d` instead), it
// changes in both places or the API and the tab will quietly disagree.
export const LEAD_ACTION_TYPES = new Set(['lead']);

/** Sum the lead-type action values on one insight row. */
export function leadsFromActions(actions) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    // Meta's raw payload says `action_type`; our mirror stores `type`.
    const type = action.type != null ? action.type : action.action_type;
    if (!LEAD_ACTION_TYPES.has(type)) continue;
    const value = Number(action.value);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

const round = (value, places) => {
  const f = 10 ** places;
  return Number.isFinite(value) ? Math.round(value * f) / f : 0;
};

/**
 * Total a set of rows into one set of figures.
 *
 * Accepts either RAW insight rows (leads live in `actions`) or rows that have
 * already been rolled up per campaign by the API (leads live in `leads`), so
 * the campaign table's totals footer and any client-side grouping share one
 * definition instead of two that can drift.
 *
 * What is NOT averaged: `ctr`, `cpc` and `cpl`. Those are ratios, and the mean
 * of a set of ratios is not the ratio of the set — a day with 2 clicks on 10
 * impressions would weigh the same as a day with 2,000 on 10,000. They are
 * recomputed from the summed numerator and denominator, exactly as the API
 * does. Zero denominators give null, not Infinity: a campaign with spend and no
 * leads has an UNDEFINED cost per lead, and "—" is the only honest rendering.
 */
export function rollUp(rows) {
  let spend = 0;
  let impressions = 0;
  let reach = 0;
  let clicks = 0;
  let leads = 0;

  for (const row of rows || []) {
    if (!row) continue;
    const rowSpend = Number(row.spend);
    if (Number.isFinite(rowSpend)) spend += rowSpend;
    impressions += Number(row.impressions) || 0;
    reach += Number(row.reach) || 0;
    clicks += Number(row.clicks) || 0;
    leads += row.actions !== undefined ? leadsFromActions(row.actions) : Number(row.leads) || 0;
  }

  return {
    spend: round(spend, 2),
    impressions,
    reach,
    clicks,
    leads,
    ctr: impressions > 0 ? round((clicks / impressions) * 100, 4) : 0,
    cpc: clicks > 0 ? round(spend / clicks, 2) : null,
    cpl: leads > 0 ? round(spend / leads, 2) : null,
  };
}

// ---------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------
//
// Every date here is 'YYYY-MM-DD' built in LOCAL time. `toISOString()` is banned
// for the same reason the ads API bans it: Meta's insight dates are calendar
// dates in the ad account's timezone (IST), so a date derived in UTC shifts the
// day boundary and makes "This month" start a day early — quietly moving a
// day's spend into the wrong bucket.

export function localIso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localIso(d);
}

/** The three presets the date selector offers. */
export function presetRanges() {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  return [
    { label: 'Last 7 days', from: daysAgo(6), to: localIso(today) },
    { label: 'Last 30 days', from: daysAgo(29), to: localIso(today) },
    { label: 'This month', from: localIso(monthStart), to: localIso(today) },
  ];
}

/** What both tabs open on. Last 30 days, matching the API's own default. */
export function defaultRange() {
  return presetRanges()[1];
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Sort rows by a numeric column.
 *
 * Nulls sink to the bottom in BOTH directions. A campaign with no leads has no
 * cost per lead at all, and floating it to the top of an ascending "cheapest
 * CPL" sort would read as "this campaign is free".
 */
export function sortRows(rows, key, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aNull = av == null;
    const bNull = bv == null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return sign * String(av).localeCompare(String(bv));
    }
    // Name as a stable tie-break, so equal figures don't shuffle between renders.
    return sign * (av - bv) || String(a.name || '').localeCompare(String(b.name || ''));
  });
}

// ---------------------------------------------------------------------------
// Lead attribution
// ---------------------------------------------------------------------------

// How the ads API says a lead's campaign was decided. Shown next to the campaign
// so an admin can tell a fact from an inference from an operator's hand-mapping:
// today 52 of the 80 tagged leads resolve only via `alias`, which is somebody's
// assertion rather than anything Meta told us.
export const RESOLVED_BY = {
  id: { label: 'id', hint: 'the UTM carried the Meta campaign id outright' },
  exact: { label: 'exact', hint: 'utm_campaign matched a Meta campaign name verbatim' },
  normalized: { label: 'normalized', hint: 'matched after case / punctuation normalisation' },
  alias: { label: 'alias', hint: 'no Meta data matched — an admin mapped this UTM by hand' },
  meta: { label: 'meta', hint: 'Meta attached the campaign to this lead itself' },
  unmapped: { label: 'no campaign', hint: 'an admin triaged this UTM as having no Meta campaign' },
};

/**
 * Has this lead been triaged as deliberately having no campaign?
 *
 * The API's `unresolved=true` filter is `resolvedCampaignId: null`, which is
 * true both of a lead nobody has looked at AND of one an admin has already
 * ruled on (Google Ads traffic, test data — recorded as `resolvedBy:
 * 'unmapped'`). Twenty-eight of the current leads are the second kind. They are
 * separated HERE, in the UI, rather than by narrowing the endpoint: "which ad
 * URLs are tagged wrong" is a worklist, and a worklist that keeps re-listing
 * items already dealt with stops being read.
 */
export function isTriagedNoCampaign(lead) {
  return !lead.campaignId && lead.resolvedBy === 'unmapped';
}

/** Unresolved AND untriaged: the leads whose ad URLs actually need fixing. */
export function needsTriage(lead) {
  return !lead.campaignId && lead.resolvedBy == null;
}

// ---------------------------------------------------------------------------
// Lead status
// ---------------------------------------------------------------------------

// What actually happened to a lead, as `status.state` from GET /api/ads/leads.
// The order is the funnel's: closed first, then still-moving, then untouched —
// so the filter dropdown and the badges read in the same sequence everywhere.
export const LEAD_STATUS = {
  won: { label: 'Closed with sale', hint: 'a deal for this contact closed with a sale' },
  lost: { label: 'Closed without sale', hint: 'a deal for this contact closed without a sale' },
  pipeline: { label: 'In pipeline', hint: 'a deal exists for this contact and is still open' },
  followup: { label: 'Following up', hint: 'a follow-up task exists, but no deal yet' },
  none: { label: 'No follow-up', hint: 'nobody has picked this lead up' },
};

export const LEAD_STATES = Object.keys(LEAD_STATUS);

/** The state of a lead row, tolerant of a row served before the API carried one. */
export function statusState(lead) {
  const state = lead && lead.status && lead.status.state;
  return LEAD_STATUS[state] ? state : 'none';
}

/**
 * How the deal behind this status was found, or null when there is no deal.
 *
 * 'lead-id' is Meta's own lead id on both sides — the sale IS this lead's.
 * 'phone' is a 10-digit key match, which a shared handset makes a guess. The
 * badge says so rather than presenting an inference as a closed sale, the same
 * distinction RESOLVED_BY draws for campaign attribution.
 */
export function matchHint(lead) {
  const by = lead && lead.status && lead.status.matchedBy;
  if (by === 'lead-id') return 'matched to the deal by Meta lead id';
  if (by === 'phone') return 'matched to the deal by phone number — may be a shared number';
  return null;
}

// ---------------------------------------------------------------------------
// UTM breakdown
// ---------------------------------------------------------------------------

const UNRESOLVED = '(unresolved)';
const TRIAGED = '(no Meta campaign)';

/**
 * Leads grouped two ways: by source/medium, and by campaign with the spend and
 * cost per lead of whichever Meta campaign each one resolved to.
 *
 * `leads` are rows from GET /api/ads/leads; `campaignRows` are rows from GET
 * /api/ads/campaigns, which carry the spend. The join is on the RESOLVED
 * campaign id, not on the utm_campaign string — the retired CRM matched by
 * campaign NAME and so silently reported nothing whenever a UTM was spelled
 * differently from the Meta campaign. Resolution (including the alias table)
 * has since moved server-side, so the id is available and is the honest key.
 *
 * The CPL here is spend over CAPTURED leads — the people who reached our form —
 * which is a different figure from the campaign table's CPL of spend over Meta's
 * reported `lead` actions. Both are true; they answer different questions, and
 * the tab labels them apart.
 */
export function utmBreakdown(leads, campaignRows) {
  const spendById = new Map();
  for (const row of campaignRows || []) {
    spendById.set(String(row.campaignId), row.spend);
  }

  const bySourceMap = new Map();
  const byCampaignMap = new Map();

  for (const lead of leads || []) {
    // A Meta instant-form lead never passed through a landing page, so it has no
    // UTM at all — it is labelled for what it is rather than dropped, so the
    // breakdown's total matches the lead list's.
    const utm = lead.utm || {};
    const source = lead.source === 'meta' ? 'meta' : utm.source || 'direct';
    const medium = lead.source === 'meta' ? 'instant-form' : utm.medium || '—';
    const sourceKey = `${source} / ${medium}`;
    bySourceMap.set(sourceKey, (bySourceMap.get(sourceKey) || 0) + 1);

    const campaignKey = lead.campaignId
      ? String(lead.campaignId)
      : isTriagedNoCampaign(lead)
        ? TRIAGED
        : UNRESOLVED;
    const entry = byCampaignMap.get(campaignKey) || {
      key: campaignKey,
      campaignId: lead.campaignId || null,
      name: lead.campaignId ? lead.campaignName || lead.campaignId : campaignKey,
      leads: 0,
      resolvedBy: new Set(),
    };
    entry.leads += 1;
    if (lead.resolvedBy) entry.resolvedBy.add(lead.resolvedBy);
    byCampaignMap.set(campaignKey, entry);
  }

  const bySource = [...bySourceMap.entries()]
    .map(([label, count]) => ({ label, leads: count }))
    .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));

  const byCampaign = [...byCampaignMap.values()]
    .map((entry) => {
      const spend = entry.campaignId ? spendById.get(entry.campaignId) : undefined;
      return {
        ...entry,
        resolvedBy: [...entry.resolvedBy].sort(),
        // null, not 0: a campaign we have no spend row for in this range has an
        // UNKNOWN cost per lead, which is not the same as a free one.
        spend: spend == null ? null : spend,
        cpl: spend != null && entry.leads > 0 ? round(spend / entry.leads, 2) : null,
      };
    })
    .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name));

  return { bySource, byCampaign, total: (leads || []).length };
}
