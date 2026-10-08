// Ad Performance — per campaign / ad set / ad: how many leads came in, how many
// were junk, how many closed with a sale and without one, against the spend.
//
// WHICH LEADS
// -----------
// Three sources:
//   meta   Meta instant-form leads synced from the Graph API (MetaLead) — needs
//          the leads_retrieval permission, so may be empty.
//   bigin  Bigin contacts LeadChain stamped with the Meta campaign and ad set ids
//          (Contact.metaCampaignId / metaAdsetId). LeadChain cannot map the ad
//          id, so these stop at the ad set. Joins to its deal by contact id.
//   web    landing-page leads whose UTM resolved to a Meta campaign. A landing-page lead
// knows its campaign but never its ad, so it sits under its campaign in a
// separate "landing page" bucket rather than being guessed onto an ad.
//
// Leads are picked by CAPTURE date (a cohort): the outcome shown is whatever the
// deal says today. Spend is windowed on the same dates.
//
// ONE PERSON, ONE LEAD PER BUCKET
// -------------------------------
// Someone who fills the same ad's form twice is one lead, not two — the earliest
// fill counts. The same person on two different ads counts once on each, since
// each ad did bring them in.
//
// THE BUCKETS ADD UP
// ------------------
// leads = won + lost + junk + pipeline + noDeal, with no overlap. Junk is a
// closed-without-sale deal whose lost reason is a junk one (funnel.isJunkReason —
// the same rule the Funnel tab uses), and is NOT also counted in `lost`.
//
// The deal join is the Ad Leads tab's: Meta's own lead id first, the 10-digit
// phone key as the fallback (services/dealJoin).

const MetaLead = require('../models/MetaLead');
const WebLead = require('../models/WebLead');
const MetaCampaign = require('../models/MetaCampaign');
const MetaAdset = require('../models/MetaAdset');
const MetaAd = require('../models/MetaAd');
const MetaInsight = require('../models/MetaInsight');
const Deal = require('../../calls/models/Deal');
const Contact = require('../../leads/models/Contact');
const { isJunkReason } = require('../../leads/services/funnel');
const { DEAL_FIELDS, indexDeals } = require('./dealJoin');
const { rangeFilter, nextDay, money } = require('./adMetrics');

// Test contacts, never real leads — and a phone join on them would hand one
// person's deal to every test submission.
const PLACEHOLDER_PHONES = new Set(['9999999999', '9876543210']);

const UNKNOWN = 'unknown';

const emptyCounts = () => ({ leads: 0, junk: 0, lost: 0, won: 0, pipeline: 0, noDeal: 0, revenue: 0 });

/** Which bucket a lead's deal puts it in. */
function outcomeOf(deal) {
  if (!deal) return 'noDeal';
  if (deal.outcome === 'won') return 'won';
  if (deal.outcome === 'lost') return isJunkReason(deal.lostReason) ? 'junk' : 'lost';
  return 'pipeline';
}

function addTo(counts, bucket, deal) {
  counts.leads += 1;
  counts[bucket] += 1;
  if (bucket === 'won') counts.revenue += Number(deal.amount) || 0;
}

const time = (v) => (v ? new Date(v).getTime() || 0 : 0);

/**
 * Normalise both lead sources into one shape, drop test leads, and keep only the
 * earliest lead per (bucket, phone).
 */
function normaliseLeads(metaLeads, webLeads, adById, contacts = []) {
  const all = [];
  for (const c of contacts) {
    all.push({
      source: 'bigin',
      id: String(c.zohoId),
      capturedAt: c.createdTime,
      phoneKey: (c.phoneKeys && c.phoneKeys[0]) || null,
      campaignId: String(c.metaCampaignId || UNKNOWN),
      adsetId: String(c.metaAdsetId || UNKNOWN),
      adId: UNKNOWN,
    });
  }
  for (const l of metaLeads) {
    const ad = l.adId ? adById.get(String(l.adId)) : null;
    all.push({
      source: 'meta',
      id: String(l._id),
      capturedAt: l.createdTime,
      phoneKey: l.phoneKey || null,
      campaignId: String(l.campaignId || (ad && ad.campaignId) || UNKNOWN),
      adsetId: String((ad && ad.adsetId) || UNKNOWN),
      adId: String(l.adId || UNKNOWN),
    });
  }
  for (const l of webLeads) {
    all.push({
      source: 'web',
      id: String(l._id),
      capturedAt: l.createdAt,
      phoneKey: l.phoneKey || null,
      campaignId: String(l.resolvedCampaignId),
      adsetId: null,
      adId: null,
    });
  }

  all.sort((a, b) => time(a.capturedAt) - time(b.capturedAt) || (a.id < b.id ? -1 : 1));

  const seen = new Set();
  const kept = [];
  for (const lead of all) {
    if (lead.phoneKey && PLACEHOLDER_PHONES.has(lead.phoneKey)) continue;
    if (lead.phoneKey) {
      const bucket = lead.source === 'web' ? `lp:${lead.campaignId}` : `ad:${lead.campaignId}:${lead.adId}`;
      const key = `${bucket}|${lead.phoneKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(lead);
  }
  return kept;
}

/**
 * The pure roll-up: leads + deals + names + spend in, campaign tree out. No DB.
 *
 * @param {object} input
 * @param {object[]} input.metaLeads   MetaLead docs ({_id, createdTime, adId, campaignId, phoneKey})
 * @param {object[]} input.webLeads    WebLead docs ({_id, createdAt, resolvedCampaignId, phoneKey})
 * @param {object[]} [input.contacts]  Contact docs carrying Meta ids ({zohoId, createdTime, phoneKeys, metaCampaignId, metaAdsetId})
 * @param {object[]} input.deals       Deal docs matched by socialLeadId or contactPhoneKey
 * @param {object[]} input.campaigns   MetaCampaign {_id, name}
 * @param {object[]} input.adsets      MetaAdset {_id, name, campaignId}
 * @param {object[]} input.ads         MetaAd {_id, name, adsetId, campaignId}
 * @param {object[]} input.campaignSpend  campaign-level insight rows {entityId, spend}
 * @param {object[]|null} input.adSpend   ad-level insight rows {entityId, adsetId, campaignId, spend};
 *        null when ad-level spend has never been synced, so ad set / ad spend is unknown, not zero.
 */
function rollUpPerformance(input) {
  const adById = new Map(input.ads.map((a) => [String(a._id), a]));
  const adsetName = new Map(input.adsets.map((a) => [String(a._id), a.name]));
  const adsetCampaign = new Map(input.adsets.map((a) => [String(a._id), a.campaignId]));
  const campaignName = new Map(input.campaigns.map((c) => [String(c._id), c.name]));

  const dealByLeadId = indexDeals(input.deals, (d) => d.socialLeadId);
  const dealByContactId = indexDeals(input.deals, (d) => d.contactId);
  const dealByPhone = indexDeals(
    input.deals.filter((d) => !PLACEHOLDER_PHONES.has(String(d.contactPhoneKey))),
    (d) => d.contactPhoneKey
  );

  const campaigns = new Map();
  const campaignNode = (id) => {
    if (!campaigns.has(id)) {
      campaigns.set(id, {
        id,
        name: id === UNKNOWN ? null : campaignName.get(id) || null,
        counts: emptyCounts(),
        spend: 0,
        adsets: new Map(),
        landingPage: null,
      });
    }
    return campaigns.get(id);
  };
  const adsetNode = (campaign, id) => {
    if (!campaign.adsets.has(id)) {
      campaign.adsets.set(id, {
        id,
        name: id === UNKNOWN ? null : adsetName.get(id) || null,
        counts: emptyCounts(),
        spend: input.adSpend ? 0 : null,
        ads: new Map(),
      });
    }
    return campaign.adsets.get(id);
  };
  const adNode = (adset, id) => {
    if (!adset.ads.has(id)) {
      const ad = adById.get(id);
      adset.ads.set(id, {
        id,
        name: id === UNKNOWN ? null : (ad && ad.name) || null,
        counts: emptyCounts(),
        spend: input.adSpend ? 0 : null,
      });
    }
    return adset.ads.get(id);
  };

  const totals = emptyCounts();

  for (const lead of normaliseLeads(input.metaLeads, input.webLeads, adById, input.contacts)) {
    const deal =
      (lead.source === 'meta' && dealByLeadId.get(lead.id)) ||
      (lead.source === 'bigin' && dealByContactId.get(lead.id)) ||
      (lead.phoneKey && dealByPhone.get(lead.phoneKey)) ||
      null;
    const bucket = outcomeOf(deal);

    const campaign = campaignNode(lead.campaignId);
    addTo(totals, bucket, deal);
    addTo(campaign.counts, bucket, deal);
    if (lead.source === 'web') {
      if (!campaign.landingPage) campaign.landingPage = { counts: emptyCounts() };
      addTo(campaign.landingPage.counts, bucket, deal);
    } else {
      const adset = adsetNode(campaign, lead.adsetId);
      addTo(adset.counts, bucket, deal);
      // A lead that names its ad set but not its ad (every Bigin/LeadChain lead)
      // counts on the ad set only, in an explicit "ad not tracked" bucket.
      if (lead.adId === UNKNOWN) {
        if (!adset.noAd) adset.noAd = emptyCounts();
        addTo(adset.noAd, bucket, deal);
      } else {
        addTo(adNode(adset, lead.adId).counts, bucket, deal);
      }
    }
  }

  // Spend. Campaign totals come from campaign-level rows — the same numbers the
  // Marketing tab shows. Ad set and ad spend come from ad-level rows.
  let totalSpend = 0;
  for (const row of input.campaignSpend) {
    const spend = Number(row.spend) || 0;
    if (!spend) continue;
    campaignNode(String(row.entityId)).spend += spend;
    totalSpend += spend;
  }
  for (const row of input.adSpend || []) {
    const spend = Number(row.spend) || 0;
    if (!spend) continue;
    const ad = adById.get(String(row.entityId));
    const adsetId = String(row.adsetId || (ad && ad.adsetId) || UNKNOWN);
    const campaignId = String(
      row.campaignId || (ad && ad.campaignId) || adsetCampaign.get(adsetId) || UNKNOWN
    );
    const adset = adsetNode(campaignNode(campaignId), adsetId);
    adset.spend += spend;
    adNode(adset, String(row.entityId)).spend += spend;
  }

  const roundCounts = (c) => ({ ...c, revenue: money(c.revenue) });
  const byWeight = (a, b) => b.counts.leads - a.counts.leads || (b.spend || 0) - (a.spend || 0);

  const tree = [...campaigns.values()]
    .map((c) => ({
      id: c.id,
      name: c.name,
      counts: roundCounts(c.counts),
      spend: money(c.spend),
      landingPage: c.landingPage ? { counts: roundCounts(c.landingPage.counts) } : null,
      adsets: [...c.adsets.values()]
        .map((s) => ({
          id: s.id,
          name: s.name,
          counts: roundCounts(s.counts),
          spend: s.spend === null ? null : money(s.spend),
          noAd: s.noAd ? { counts: roundCounts(s.noAd) } : null,
          ads: [...s.ads.values()]
            .map((a) => ({
              id: a.id,
              name: a.name,
              counts: roundCounts(a.counts),
              spend: a.spend === null ? null : money(a.spend),
            }))
            .sort(byWeight),
        }))
        .sort(byWeight),
    }))
    .sort(byWeight);

  return {
    totals: { counts: roundCounts(totals), spend: money(totalSpend) },
    campaigns: tree,
    adSpendAvailable: Boolean(input.adSpend),
  };
}

/** Load everything for a range and roll it up. */
async function buildAdPerformance(range) {
  const after = new Date(`${range.from}T00:00:00`);
  const before = new Date(`${nextDay(range.to)}T00:00:00`);

  const [metaLeads, webLeads, contacts, campaignSpend, adSpendRows, anyAdSpend] = await Promise.all([
    MetaLead.find(
      { createdTime: { $gte: range.from, $lt: nextDay(range.to) } },
      { _id: 1, createdTime: 1, adId: 1, campaignId: 1, phoneKey: 1 }
    ).lean(),
    WebLead.find(
      {
        createdAt: { $gte: after, $lt: before },
        resolvedCampaignId: { $ne: null },
        resolvedBy: { $ne: 'unmapped' },
      },
      { _id: 1, createdAt: 1, resolvedCampaignId: 1, phoneKey: 1 }
    ).lean(),
    Contact.find(
      {
        createdTime: { $gte: after, $lt: before },
        metaCampaignId: { $ne: null },
      },
      { zohoId: 1, createdTime: 1, phoneKeys: 1, metaCampaignId: 1, metaAdsetId: 1 }
    ).lean(),
    MetaInsight.find({ level: 'campaign', ...rangeFilter(range) }, { entityId: 1, spend: 1 })
      .sort({ entityId: 1, dateStart: 1, dateStop: 1 })
      .lean(),
    MetaInsight.find(
      { level: 'ad', ...rangeFilter(range) },
      { entityId: 1, adsetId: 1, campaignId: 1, spend: 1 }
    )
      .sort({ entityId: 1, dateStart: 1, dateStop: 1 })
      .lean(),
    MetaInsight.exists({ level: 'ad' }),
  ]);

  const socialIds = [...new Set(metaLeads.map((l) => String(l._id)))];
  const contactIds = contacts.map((c) => String(c.zohoId));
  const phoneKeys = [
    ...new Set(
      [...metaLeads, ...webLeads, ...contacts.map((c) => ({ phoneKey: (c.phoneKeys || [])[0] }))]
        .map((l) => l.phoneKey)
        .filter((k) => k && !PLACEHOLDER_PHONES.has(k))
    ),
  ];
  const adIds = [
    ...new Set(
      [
        ...metaLeads.map((l) => l.adId),
        ...adSpendRows.map((r) => r.entityId),
      ].filter(Boolean)
    ),
  ];

  const [dealsById, dealsByContact, dealsByPhone, ads] = await Promise.all([
    socialIds.length ? Deal.find({ socialLeadId: { $in: socialIds } }, DEAL_FIELDS).lean() : [],
    contactIds.length ? Deal.find({ contactId: { $in: contactIds } }, DEAL_FIELDS).lean() : [],
    phoneKeys.length ? Deal.find({ contactPhoneKey: { $in: phoneKeys } }, DEAL_FIELDS).lean() : [],
    adIds.length
      ? MetaAd.find({ _id: { $in: adIds } }, { name: 1, adsetId: 1, campaignId: 1 }).lean()
      : [],
  ]);

  const adsetIds = [
    ...new Set(
      [...ads.map((a) => a.adsetId), ...contacts.map((c) => c.metaAdsetId), ...adSpendRows.map((r) => r.adsetId)].filter(
        Boolean
      )
    ),
  ];
  const campaignIds = [
    ...new Set(
      [
        ...metaLeads.map((l) => l.campaignId),
        ...webLeads.map((l) => l.resolvedCampaignId),
        ...contacts.map((c) => c.metaCampaignId),
        ...ads.map((a) => a.campaignId),
        ...campaignSpend.map((r) => r.entityId),
        ...adSpendRows.map((r) => r.campaignId),
      ]
        .filter(Boolean)
        .map(String)
    ),
  ];

  const [adsets, campaigns] = await Promise.all([
    adsetIds.length
      ? MetaAdset.find({ _id: { $in: adsetIds } }, { name: 1, campaignId: 1 }).lean()
      : [],
    campaignIds.length ? MetaCampaign.find({ _id: { $in: campaignIds } }, { name: 1 }).lean() : [],
  ]);

  // A deal reached by both joins appears twice; indexDeals keeps one per key, so
  // the duplicate is harmless.
  return rollUpPerformance({
    metaLeads,
    webLeads,
    deals: [...dealsById, ...dealsByContact, ...dealsByPhone],
    contacts,
    campaigns,
    adsets,
    ads,
    campaignSpend,
    adSpend: anyAdSpend ? adSpendRows : null,
  });
}

module.exports = { buildAdPerformance, rollUpPerformance, outcomeOf, PLACEHOLDER_PHONES };
