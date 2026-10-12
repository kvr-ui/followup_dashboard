// UTM Report — landing-page leads grouped by one tracking value at a time
// (utm_source, utm_medium, utm_campaign, utm_content, utm_term, cp1, cp2), each
// row showing how far its leads got: registrations -> demo completed -> sale.
//
// WHICH LEADS
// -----------
// Web leads (WebLead) only, picked by CAPTURE date (a cohort): the outcome shown
// is whatever the deal says today. Test leads on placeholder phones are dropped.
//
// ONE ROW PER VALUE, CASE-INSENSITIVE
// -----------------------------------
// "google", "Google" and " GOOGLE" are one row: the key is the trimmed,
// lowercased value, and the label is its most common spelling. A blank value is
// the "(none)" row. Someone who registers twice under the same value counts once
// (earliest fill wins, deduped by phone key — Ad Performance's rule).
//
// THE FUNNEL
// ----------
//   registrations  leads in the row
//   demo           the lead had a CONNECTED call (services/connectedCalls) OR a
//                  Bigin deal exists — Ad Performance's MQL, so deal ⇒ demo and
//                  sales can never outnumber demos
//   sales          the lead's deal closed with a sale
//   revenue        sum of those deals' amounts, in rupees
//
// The deal join is by the 10-digit phone key (services/dealJoin's best deal).

const WebLead = require('../models/WebLead');
const Deal = require('../../calls/models/Deal');
const { DEAL_FIELDS, indexDeals } = require('./dealJoin');
const { nextDay, money } = require('./adMetrics');
const { loadConnectedSets } = require('./connectedCalls');
const { PLACEHOLDER_PHONES } = require('../../../utils/phone');

// Report tab id -> the WebLead field it groups by.
const DIMENSIONS = {
  source: 'utmSource',
  medium: 'utmMedium',
  campaign: 'utmCampaign',
  content: 'utmContent',
  term: 'utmTerm',
  cp1: 'cp1',
  cp2: 'cp2',
};

const NONE = '(none)';

const emptyCounts = () => ({ registrations: 0, demo: 0, sales: 0, revenue: 0 });

const time = (v) => (v ? new Date(v).getTime() || 0 : 0);

/**
 * The pure roll-up — no DB.
 *
 * @param {object} input
 * @param {object[]} input.webLeads  WebLead docs ({_id, createdAt, phoneKey, utm*, cp1, cp2})
 * @param {object[]} input.deals     Deal docs matched by contactPhoneKey
 * @param {Set<string>} [input.connectedPhones] phone keys with a connected call
 * @returns {{ [dimension: string]: { rows: object[], totals: object } }}
 */
function rollUpUtm(input) {
  const connected = input.connectedPhones || new Set();
  const dealByPhone = indexDeals(
    input.deals.filter((d) => !PLACEHOLDER_PHONES.has(String(d.contactPhoneKey))),
    (d) => d.contactPhoneKey
  );

  const leads = input.webLeads
    .filter((l) => !(l.phoneKey && PLACEHOLDER_PHONES.has(l.phoneKey)))
    .sort((a, b) => time(a.createdAt) - time(b.createdAt) || (String(a._id) < String(b._id) ? -1 : 1));

  // Each lead's funnel flags once, shared by every dimension.
  const flagged = leads.map((lead) => {
    const deal = (lead.phoneKey && dealByPhone.get(lead.phoneKey)) || null;
    const won = Boolean(deal && deal.outcome === 'won');
    return {
      lead,
      demo: Boolean(deal) || Boolean(lead.phoneKey && connected.has(lead.phoneKey)),
      won,
      revenue: won ? Number(deal.amount) || 0 : 0,
    };
  });

  const result = {};
  for (const [dimension, field] of Object.entries(DIMENSIONS)) {
    const rows = new Map();
    const seen = new Set();

    for (const f of flagged) {
      const raw = String(f.lead[field] || '').trim();
      const key = raw.toLowerCase();

      if (f.lead.phoneKey) {
        const dedupKey = `${key}|${f.lead.phoneKey}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
      }

      if (!rows.has(key)) rows.set(key, { key, spellings: new Map(), ...emptyCounts() });
      const row = rows.get(key);
      row.spellings.set(raw, (row.spellings.get(raw) || 0) + 1);
      row.registrations += 1;
      if (f.demo) row.demo += 1;
      if (f.won) row.sales += 1;
      row.revenue += f.revenue;
    }

    const totals = emptyCounts();
    const out = [...rows.values()].map(({ spellings, ...row }) => {
      // Most common spelling; Map order makes the first-seen one win a tie.
      let label = '';
      let best = 0;
      for (const [spelling, n] of spellings) {
        if (n > best) [label, best] = [spelling, n];
      }
      totals.registrations += row.registrations;
      totals.demo += row.demo;
      totals.sales += row.sales;
      totals.revenue += row.revenue;
      return { ...row, label: label || NONE, revenue: money(row.revenue) };
    });

    out.sort((a, b) => b.registrations - a.registrations || b.sales - a.sales || (a.key < b.key ? -1 : 1));
    result[dimension] = { rows: out, totals: { ...totals, revenue: money(totals.revenue) } };
  }
  return result;
}

/** The report for leads captured in `range` ({from, to}, inclusive local dates). */
async function buildUtmReport(range) {
  const after = new Date(`${range.from}T00:00:00`);
  const before = new Date(`${nextDay(range.to)}T00:00:00`);

  const webLeads = await WebLead.find(
    { createdAt: { $gte: after, $lt: before } },
    {
      _id: 1,
      createdAt: 1,
      phoneKey: 1,
      utmSource: 1,
      utmMedium: 1,
      utmCampaign: 1,
      utmContent: 1,
      utmTerm: 1,
      cp1: 1,
      cp2: 1,
    }
  ).lean();

  const phoneKeys = [
    ...new Set(webLeads.map((l) => l.phoneKey).filter((k) => k && !PLACEHOLDER_PHONES.has(k))),
  ];

  const [deals, { connectedPhones }] = await Promise.all([
    phoneKeys.length ? Deal.find({ contactPhoneKey: { $in: phoneKeys } }, DEAL_FIELDS).lean() : [],
    loadConnectedSets({ phoneKeys }),
  ]);

  return rollUpUtm({ webLeads, deals, connectedPhones });
}

module.exports = { buildUtmReport, rollUpUtm, DIMENSIONS };
