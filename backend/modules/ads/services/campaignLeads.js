// The Campaign leads list on the Campaigns tab: every Bigin contact, with its
// campaign, CA status, lead source and how its deal closed.
//
// Bigin only, by design. A contact is the lead; its campaign is the Meta campaign
// id LeadChain stamped on it (Contact.metaCampaignId), its CA status and source
// are the contact's own Bigin fields, and its outcome comes from its deal.
//
// OUTCOME
//   won   the deal is "Closed with Sale"   (Deal.outcome, see dealStore)
//   lost  the deal is "Closed without Sale"
//   open  a deal exists but is still in the pipeline
//   none  no deal at all
// A contact with several deals takes its most recently modified one.
//
// ~7k contacts all time, so the whole range is joined in memory; buildRows and
// applyFilters are pure so they can be tested without Mongo.

const Contact = require('../../leads/models/Contact');
const Deal = require('../../calls/models/Deal');
const MetaCampaign = require('../models/MetaCampaign');
const { istDayStart } = require('../../../utils/dates');

const OUTCOMES = ['won', 'lost', 'open', 'none'];
// Filter value for "contacts with no campaign / CA status / source".
const NONE = '__none';

/** Contacts + deals + campaign name map -> one row per contact. */
function buildRows(contacts, deals, campaignNames) {
  const latestDeal = new Map();
  for (const d of deals) {
    if (!d.contactId) continue;
    const prev = latestDeal.get(d.contactId);
    const t = d.modifiedTime ? new Date(d.modifiedTime).getTime() : 0;
    const pt = prev && prev.modifiedTime ? new Date(prev.modifiedTime).getTime() : 0;
    if (!prev || t > pt) latestDeal.set(d.contactId, d);
  }

  return contacts.map((c) => {
    const d = latestDeal.get(c.zohoId);
    const campaignId = c.metaCampaignId || null;
    return {
      id: c.zohoId,
      name: c.name || null,
      phone: c.phone || c.mobile || (d && d.contactPhone) || null,
      email: c.email || null,
      campaignId,
      campaign: campaignId ? campaignNames.get(campaignId) || campaignId : null,
      caStatus: c.caStatus || null,
      leadSource: c.leadSource || null,
      outcome: d ? d.outcome || 'open' : 'none',
      dealStage: d ? d.stage || null : null,
      amount: d && d.amount ? d.amount : null,
      owner: c.ownerName || (d && d.ownerName) || null,
      ownerEmail: c.ownerEmail || null,
      createdTime: c.createdTime || null,
    };
  });
}

// Exact match on a row field, with NONE meaning "empty".
const matches = (value, want) => (want === NONE ? !value : value === want);

/** Narrow rows by the list's filters. Empty filters pass everything. */
function applyFilters(rows, f = {}) {
  const q = f.q ? String(f.q).trim().toLowerCase() : '';
  const qDigits = q.replace(/\D/g, '');
  return rows.filter((r) => {
    if (f.campaign && !matches(r.campaignId, f.campaign)) return false;
    if (f.caStatus && !matches(r.caStatus, f.caStatus)) return false;
    if (f.source && !matches(r.leadSource, f.source)) return false;
    if (f.outcome && r.outcome !== f.outcome) return false;
    if (f.owner && !matches(r.owner, f.owner)) return false;
    if (q) {
      const inName = (r.name || '').toLowerCase().includes(q);
      const inPhone = qDigits.length >= 3 && (r.phone || '').replace(/\D/g, '').includes(qDigits);
      if (!inName && !inPhone) return false;
    }
    return true;
  });
}

/** Distinct values for the filter dropdowns, with counts, most common first. */
function filterOptions(rows) {
  const tally = (key, label = key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key] || NONE;
      const cur = m.get(k) || { value: k, label: r[key] ? r[label] : null, count: 0 };
      cur.count += 1;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  };
  const outcomes = OUTCOMES.map((o) => ({
    value: o,
    count: rows.filter((r) => r.outcome === o).length,
  }));
  return {
    campaigns: tally('campaignId', 'campaign'),
    caStatuses: tally('caStatus'),
    sources: tally('leadSource'),
    owners: tally('owner'),
    outcomes,
  };
}

/**
 * Load and join every contact created in [from, to] (YYYY-MM-DD, IST days).
 * Returns { rows (filtered, newest first), options (over the whole range) }.
 */
async function loadCampaignLeads({ from, to, ...filters }) {
  const created = {};
  if (from) created.$gte = istDayStart(from);
  if (to) created.$lt = new Date(istDayStart(to).getTime() + 24 * 3600 * 1000);
  const query = Object.keys(created).length ? { createdTime: created } : {};

  const contacts = await Contact.find(query, {
    zohoId: 1,
    name: 1,
    phone: 1,
    mobile: 1,
    email: 1,
    metaCampaignId: 1,
    caStatus: 1,
    leadSource: 1,
    ownerName: 1,
    ownerEmail: 1,
    createdTime: 1,
  })
    .sort({ createdTime: -1 })
    .lean();

  const ids = contacts.map((c) => c.zohoId);
  const campaignIds = [...new Set(contacts.map((c) => c.metaCampaignId).filter(Boolean))];
  const [deals, campaigns] = await Promise.all([
    Deal.find(
      { contactId: { $in: ids } },
      { contactId: 1, contactPhone: 1, outcome: 1, stage: 1, amount: 1, ownerName: 1, modifiedTime: 1 }
    ).lean(),
    MetaCampaign.find({ _id: { $in: campaignIds } }, { name: 1 }).lean(),
  ]);

  const names = new Map(campaigns.map((c) => [String(c._id), c.name]));
  const all = buildRows(contacts, deals, names);
  return { rows: applyFilters(all, filters), options: filterOptions(all), total: all.length };
}

module.exports = { loadCampaignLeads, buildRows, applyFilters, filterOptions, OUTCOMES, NONE };
