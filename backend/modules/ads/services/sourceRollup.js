// "Which lead source closed the deal?" — the aggregation behind the Sources tab.
//
// CLOSED DEALS ONLY, AND THAT IS A CORRECTNESS DECISION
// -----------------------------------------------------
// The win rate here is won / (won + lost). Open deals are counted and shown, but
// they are NOT in the denominator, for a reason specific to this mirror: it holds
// every closed deal Bigin has (184 won, ~3.2k lost — a complete match) but only a
// fraction of the open ones, because a deal enters the mirror when it is worked,
// not when it is created. Dividing by "all deals" would therefore divide by a
// number that depends on how much of the open pipeline happens to have been
// synced, and every channel's win rate would drift as the mirror filled up.
// Closed-only is both the honest denominator and a stable one.
//
// GROUPED ON THE STORED KEY
// -------------------------
// `Deal.leadSourceKey` was canonicalised when the deal was written, not here.
// That keeps this a plain indexed $group, and it means editing the canonical
// rules never silently rewrites last quarter's numbers — a backfill does, and
// you can see it run.
//
// THE META HALF
// -------------
// A won deal whose contact carries Meta's own lead id can be traced to the exact
// campaign that produced it: Deal.socialLeadId -> MetaLead._id -> campaignId ->
// MetaCampaign.name, with spend from MetaInsight. Every hop is an id. When the
// MetaLead mirror is empty (the lead stage of the ad sync has no forms
// configured) this half reports itself as unavailable rather than returning an
// empty table that reads like "no Meta sales" — those are very different claims.

const Deal = require('../../calls/models/Deal');
const MetaCampaign = require('../models/MetaCampaign');
const MetaInsight = require('../models/MetaInsight');
const MetaLead = require('../models/MetaLead');
const { isPaidMeta, NO_SOURCE } = require('./leadSourceName');

// Atlas M0 charges ~20ms a document and this walks the whole deal collection.
// The underlying data moves at the speed of a sales team, so a minute of
// staleness costs nothing and saves the scan on every tab switch.
const TTL_MS = Number(process.env.SOURCE_ROLLUP_TTL_MS || 60000);

const cache = new Map(); // range key -> { at, payload }
let inFlight = new Map(); // range key -> promise (concurrent opens share one scan)

function invalidate() {
  cache.clear();
}

/**
 * `closingDate` is a plain 'YYYY-MM-DD' STRING in Bigin, not an instant — it is
 * a calendar date in the team's timezone. Compared as a string for that reason:
 * parsing it to a Date would re-introduce the timezone the field never had, and
 * shift a deal closed at 11pm IST into the previous day.
 */
function dateFilter(from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return range;
}

async function buildRollup({ from, to }) {
  const closing = dateFilter(from, to);

  // A date window is a window on WHEN THE SALE HAPPENED, so it can only apply to
  // deals that have a closing date. An open deal has none; including it under a
  // date filter would silently drop the whole open column whenever a range is set.
  const match = closing ? { closingDate: closing } : {};

  const rows = await Deal.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$leadSourceKey', NO_SOURCE] },
        deals: { $sum: 1 },
        won: { $sum: { $cond: [{ $eq: ['$outcome', 'won'] }, 1, 0] } },
        lost: { $sum: { $cond: [{ $eq: ['$outcome', 'lost'] }, 1, 0] } },
        open: { $sum: { $cond: [{ $eq: ['$outcome', 'open'] }, 1, 0] } },
        revenue: { $sum: { $cond: [{ $eq: ['$outcome', 'won'] }, '$amount', 0] } },
        // How much of this channel could be traced to an ad at all — the column
        // that says whether the Meta table below is speaking for the channel or
        // for a corner of it.
        wonWithMetaId: {
          $sum: {
            $cond: [
              { $and: [{ $eq: ['$outcome', 'won'] }, { $ne: ['$socialLeadId', null] }] },
              1,
              0,
            ],
          },
        },
        // Every raw spelling that fed this row, so the UI can show what the
        // canonical name is standing in for without a second query.
        rawValues: { $addToSet: '$leadSource' },
      },
    },
    { $sort: { revenue: -1, won: -1 } },
  ]);

  const sources = rows.map((r) => {
    const closed = r.won + r.lost;
    return {
      source: r._id,
      deals: r.deals,
      won: r.won,
      lost: r.lost,
      open: r.open,
      closed,
      revenue: Math.round(r.revenue * 100) / 100,
      avgSale: r.won ? Math.round((r.revenue / r.won) * 100) / 100 : null,
      // Null, not 0, when nothing has closed in this channel yet: "0%" is a
      // claim that it loses, "—" is the truth that it hasn't finished a deal.
      winRate: closed ? Math.round((1000 * r.won) / closed) / 10 : null,
      wonWithMetaId: r.wonWithMetaId,
      paidMeta: isPaidMeta(r._id),
      rawValues: (r.rawValues || []).filter(Boolean).sort(),
    };
  });

  const totals = sources.reduce(
    (a, s) => ({
      deals: a.deals + s.deals,
      won: a.won + s.won,
      lost: a.lost + s.lost,
      open: a.open + s.open,
      revenue: a.revenue + s.revenue,
      wonWithMetaId: a.wonWithMetaId + s.wonWithMetaId,
    }),
    { deals: 0, won: 0, lost: 0, open: 0, revenue: 0, wonWithMetaId: 0 }
  );
  totals.closed = totals.won + totals.lost;
  totals.winRate = totals.closed ? Math.round((1000 * totals.won) / totals.closed) / 10 : null;
  totals.revenue = Math.round(totals.revenue * 100) / 100;
  totals.paidMetaRevenue = sources
    .filter((s) => s.paidMeta)
    .reduce((a, s) => a + s.revenue, 0);

  return { sources, totals };
}

/**
 * Won deals, back to the Meta campaign that produced the lead.
 * Returns `{ available: false, reason }` when the chain cannot be walked, so the
 * UI can say WHY it is empty instead of implying Meta sold nothing.
 */
async function buildMetaRollup({ from, to }) {
  const closing = dateFilter(from, to);
  const match = { outcome: 'won', socialLeadId: { $ne: null } };
  if (closing) match.closingDate = closing;

  const wonWithId = await Deal.find(match, {
    socialLeadId: 1,
    amount: 1,
    name: 1,
    closingDate: 1,
  }).lean();

  const mirrored = await MetaLead.estimatedDocumentCount();
  if (!mirrored) {
    return {
      available: false,
      reason:
        'The Meta lead mirror is empty, so no sale can be traced past the lead id. ' +
        'Campaigns, ads and spend are synced; leads are not — set META_LEAD_FORM_IDS ' +
        'or META_PAGE_ID and re-run the ad sync.',
      wonWithLeadId: wonWithId.length,
      campaigns: [],
    };
  }

  const leads = await MetaLead.find(
    { _id: { $in: wonWithId.map((d) => d.socialLeadId) } },
    { campaignId: 1 }
  ).lean();
  const campaignOf = new Map(leads.map((l) => [String(l._id), l.campaignId || null]));

  const grouped = new Map();
  let unmatched = 0;
  for (const deal of wonWithId) {
    const campaignId = campaignOf.get(String(deal.socialLeadId));
    if (campaignId === undefined) {
      // The id is real but Meta never gave us that lead — an unsynced form.
      unmatched += 1;
      continue;
    }
    const key = campaignId || 'unknown';
    const e = grouped.get(key) || { campaignId: campaignId || null, won: 0, revenue: 0 };
    e.won += 1;
    e.revenue += deal.amount || 0;
    grouped.set(key, e);
  }

  const ids = [...grouped.values()].map((g) => g.campaignId).filter(Boolean);
  const [names, spendRows] = await Promise.all([
    MetaCampaign.find({ _id: { $in: ids } }, { name: 1 }).lean(),
    MetaInsight.aggregate([
      { $match: { level: 'campaign', entityId: { $in: ids } } },
      { $group: { _id: '$entityId', spend: { $sum: '$spend' } } },
    ]),
  ]);
  const nameOf = new Map(names.map((c) => [String(c._id), c.name]));
  const spendOf = new Map(spendRows.map((r) => [String(r._id), r.spend]));

  const campaigns = [...grouped.values()]
    .map((g) => {
      const spend = g.campaignId ? spendOf.get(String(g.campaignId)) || 0 : 0;
      return {
        campaignId: g.campaignId,
        name: g.campaignId ? nameOf.get(String(g.campaignId)) || null : null,
        won: g.won,
        revenue: Math.round(g.revenue * 100) / 100,
        spend: Math.round(spend * 100) / 100,
        // Spend is the campaign's LIFETIME in the insight mirror while revenue is
        // only the deals closed in the selected window. The two cover different
        // periods on purpose — Meta's insight history is shorter than the CRM's —
        // so these rank campaigns against each other, they do not audit a return.
        roas: spend ? Math.round((g.revenue / spend) * 100) / 100 : null,
        cac: g.won && spend ? Math.round(spend / g.won) : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  return {
    available: true,
    wonWithLeadId: wonWithId.length,
    tracedToCampaign: wonWithId.length - unmatched,
    unmatchedLeadIds: unmatched,
    spendBasis: 'campaign lifetime in the insight mirror',
    campaigns,
  };
}

/**
 * The whole payload for the Sources tab, cached per date range.
 * @param {{from?: string, to?: string}} [range] 'YYYY-MM-DD' closing-date window
 */
async function getSourceRollup(range = {}) {
  const from = range.from || null;
  const to = range.to || null;
  const key = `${from || ''}..${to || ''}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.payload;
  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    const [rollup, meta] = await Promise.all([
      buildRollup({ from, to }),
      buildMetaRollup({ from, to }),
    ]);

    // Attribution coverage. The rollup's own honesty check: a channel breakdown
    // is only worth what the share of deals carrying a channel is worth, and a
    // panel that shows the split without the coverage invites reading a 60%-known
    // sample as the whole business.
    const attributed = rollup.totals.deals - (rollup.sources.find((s) => s.source === NO_SOURCE)?.deals || 0);

    const payload = {
      range: { from, to },
      ...rollup,
      coverage: {
        dealsWithSource: attributed,
        dealsTotal: rollup.totals.deals,
        pct: rollup.totals.deals ? Math.round((1000 * attributed) / rollup.totals.deals) / 10 : null,
      },
      meta,
      generatedAt: new Date().toISOString(),
    };

    cache.set(key, { at: Date.now(), payload });
    return payload;
  })().finally(() => {
    inFlight.delete(key);
  });

  inFlight.set(key, promise);
  return promise;
}

module.exports = { getSourceRollup, invalidate };
