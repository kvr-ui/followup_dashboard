// Ad Performance — per campaign / ad set / ad: how many leads came in, how far
// down the funnel they got (MQL / SQL), how many were junk, how many closed with
// a sale and without one, against the spend. Plus the same funnel grouped by
// source / medium, for "which channel works best".
//
// WHICH LEADS
// -----------
// Three sources:
//   meta   Meta instant-form leads synced from the Graph API (MetaLead) — needs
//          the leads_retrieval permission, so may be empty.
//   bigin  Bigin contacts LeadChain stamped with the Meta campaign and ad set ids
//          (Contact.metaCampaignId / metaAdsetId). LeadChain cannot map the ad
//          id, so these stop at the ad set. Joins to its deal by contact id.
//   web    landing-page leads. One whose utm_term resolved to an ad set (and
//          utm_content to an ad — services/adEntityResolver) counts on that ad
//          set / ad like any other lead; one that only resolved a campaign sits
//          under it in a separate "landing page" bucket rather than being guessed
//          onto an ad.
//
// Leads are picked by CAPTURE date (a cohort): the outcome shown is whatever the
// deal says today. Spend is windowed on the same dates.
//
// TWO VIEWS, TWO UNIVERSES
// ------------------------
// The campaign tree counts only ad-attributed leads (a campaign, ad set or ad was
// resolved). The source / medium view counts EVERY capture — including web leads
// with no campaign and Bigin contacts LeadChain never stamped — grouped by UTM
// source·medium (web), canonical Lead_Source1 (bigin, services/leadSourceName) or
// "Meta lead form". So the source view's totals are the larger ones, by design.
//
// ONE PERSON, ONE LEAD PER BUCKET
// -------------------------------
// Someone who fills the same ad's form twice is one lead, not two — the earliest
// fill counts. The same person on two different ads counts once on each, since
// each ad did bring them in. The source view dedups per source row the same way.
//
// THE BUCKETS ADD UP — THE FUNNEL OVERLAPS
// ----------------------------------------
// leads = won + lost + junk + pipeline + noDeal, with no overlap. Junk is a
// closed-without-sale deal whose lost reason is a junk one (funnel.isJunkReason —
// the same rule the Funnel tab uses), and is NOT also counted in `lost`.
//
// `mql` and `sql` are NOT buckets — they are cumulative funnel counters that
// overlap the buckets (leads ≥ mql ≥ sql):
//   mql  the lead exists as a Bigin contact (a bigin lead IS one; a web/meta
//        lead is one when a contact shares its phone key)
//   sql  the lead has any deal, or any call strictly longer than
//        SQL_MIN_CALL_SEC — leadState.funnelStage's rule, with NO time window
//        (deliberately NOT the Funnel tab's same-calendar-month rule, which
//        would punish ads launched late in a month). deal ⇒ sql ⇒ mql, always,
//        so the funnel is monotone even when a deal joined by Meta's lead id has
//        no phone-matched contact.
//
// `stages` on a node is the open-deal pipeline broken down by the raw Bigin
// stage string; its values sum to counts.pipeline.
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
const Call = require('../../calls/models/Call');
const { isJunkReason } = require('../../leads/services/funnel');
const { DEAL_FIELDS, indexDeals } = require('./dealJoin');
const { rangeFilter, nextDay, money } = require('./adMetrics');
const { canonicalSource } = require('./leadSourceName');
const { SQL_MIN_CALL_SEC } = require('./leadState');
const { PLACEHOLDER_PHONES, OFFICE_DID } = require('../../../utils/phone');

const UNKNOWN = 'unknown';

const emptyCounts = () => ({
  leads: 0,
  mql: 0,
  sql: 0,
  junk: 0,
  lost: 0,
  won: 0,
  pipeline: 0,
  noDeal: 0,
  revenue: 0,
});

/** Which bucket a lead's deal puts it in. */
function outcomeOf(deal) {
  if (!deal) return 'noDeal';
  if (deal.outcome === 'won') return 'won';
  if (deal.outcome === 'lost') return isJunkReason(deal.lostReason) ? 'junk' : 'lost';
  return 'pipeline';
}

/**
 * The funnel flags for one lead. `deal ⇒ sql ⇒ mql` is enforced here, not hoped
 * for — see the file header.
 */
function funnelFlags(lead, deal, sets) {
  const sql =
    Boolean(deal) ||
    Boolean(lead.phoneKey && sets.sqlPhones.has(lead.phoneKey)) ||
    (lead.source === 'bigin' && sets.sqlContactIds.has(lead.id));
  const mql =
    sql || lead.source === 'bigin' || Boolean(lead.phoneKey && sets.mqlPhones.has(lead.phoneKey));
  return { mql, sql };
}

const NO_FLAGS = { mql: false, sql: false };

/** Count one lead onto a node ({counts, stages}). */
function applyLead(node, bucket, deal, flags = NO_FLAGS) {
  const c = node.counts;
  c.leads += 1;
  c[bucket] += 1;
  if (bucket === 'won') c.revenue += Number(deal.amount) || 0;
  if (flags.mql) c.mql += 1;
  if (flags.sql) c.sql += 1;
  if (bucket === 'pipeline') {
    const stage = (deal && deal.stage) || '(no stage)';
    node.stages.set(stage, (node.stages.get(stage) || 0) + 1);
  }
}

const emptyNode = () => ({ counts: emptyCounts(), stages: new Map() });

const time = (v) => (v ? new Date(v).getTime() || 0 : 0);

/**
 * Normalise the three lead sources into one shape, drop test leads, and sort by
 * capture time. NOT deduped — each roll-up dedups by its own bucket (dedupBy),
 * because "one person per ad" and "one person per source row" are different keys.
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
      hasCampaign: Boolean(c.metaCampaignId),
      leadSource: c.leadSource,
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
      hasCampaign: true,
    });
  }
  for (const l of webLeads) {
    all.push({
      source: 'web',
      id: String(l._id),
      capturedAt: l.createdAt,
      phoneKey: l.phoneKey || null,
      campaignId: l.resolvedCampaignId ? String(l.resolvedCampaignId) : null,
      adsetId: l.resolvedAdsetId ? String(l.resolvedAdsetId) : null,
      adId: l.resolvedAdId ? String(l.resolvedAdId) : null,
      hasCampaign: Boolean(l.resolvedCampaignId),
      utmSource: l.utmSource,
      utmMedium: l.utmMedium,
    });
  }

  all.sort((a, b) => time(a.capturedAt) - time(b.capturedAt) || (a.id < b.id ? -1 : 1));

  return all.filter((lead) => !(lead.phoneKey && PLACEHOLDER_PHONES.has(lead.phoneKey)));
}

/** One lead per (bucket, phone), earliest fill wins. A lead with no phone always counts. */
function dedupBy(leads, bucketOf) {
  const seen = new Set();
  const kept = [];
  for (const lead of leads) {
    if (lead.phoneKey) {
      const key = `${bucketOf(lead)}|${lead.phoneKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(lead);
  }
  return kept;
}

/** The source / medium row a lead belongs to — see the file header. */
function sourceRowOf(lead) {
  if (lead.source === 'web') {
    const s = String(lead.utmSource || '').trim();
    const m = String(lead.utmMedium || '').trim();
    return {
      key: `utm:${s.toLowerCase() || '-'}|${m.toLowerCase() || '-'}`,
      label: `${s || '(no source)'} · ${m || '(no medium)'}`,
    };
  }
  if (lead.source === 'bigin') {
    const name = canonicalSource(lead.leadSource);
    return { key: `src:${name}`, label: name };
  }
  return { key: 'meta:leadform', label: 'Meta lead form' };
}

/**
 * The pure roll-up: leads + deals + names + spend in, campaign tree AND source /
 * medium rows out. No DB.
 *
 * @param {object} input
 * @param {object[]} input.metaLeads   MetaLead docs ({_id, createdTime, adId, campaignId, phoneKey})
 * @param {object[]} input.webLeads    WebLead docs ({_id, createdAt, phoneKey, utmSource, utmMedium,
 *        resolvedCampaignId, resolvedAdsetId, resolvedAdId})
 * @param {object[]} [input.contacts]  Contact docs ({zohoId, createdTime, phoneKeys, metaCampaignId,
 *        metaAdsetId, leadSource})
 * @param {object[]} input.deals       Deal docs matched by socialLeadId, contactId or contactPhoneKey
 * @param {object[]} input.campaigns   MetaCampaign {_id, name}
 * @param {object[]} input.adsets      MetaAdset {_id, name, campaignId}
 * @param {object[]} input.ads         MetaAd {_id, name, adsetId, campaignId}
 * @param {object[]} input.campaignSpend  campaign-level insight rows {entityId, spend}
 * @param {object[]|null} input.adSpend   ad-level insight rows {entityId, adsetId, campaignId, spend};
 *        null when ad-level spend has never been synced, so ad set / ad spend is unknown, not zero.
 * @param {Set<string>} [input.mqlPhones]     phone keys that have a Bigin contact
 * @param {Set<string>} [input.sqlPhones]     phone keys with a qualifying (> SQL_MIN_CALL_SEC) call
 * @param {Set<string>} [input.sqlContactIds] Bigin contact ids with a qualifying call
 */
function rollUpPerformance(input) {
  const adById = new Map(input.ads.map((a) => [String(a._id), a]));
  const adsetName = new Map(input.adsets.map((a) => [String(a._id), a.name]));
  const adsetCampaign = new Map(input.adsets.map((a) => [String(a._id), a.campaignId]));
  const campaignName = new Map(input.campaigns.map((c) => [String(c._id), c.name]));

  const sets = {
    mqlPhones: input.mqlPhones || new Set(),
    sqlPhones: input.sqlPhones || new Set(),
    sqlContactIds: input.sqlContactIds || new Set(),
  };

  const dealByLeadId = indexDeals(input.deals, (d) => d.socialLeadId);
  const dealByContactId = indexDeals(input.deals, (d) => d.contactId);
  const dealByPhone = indexDeals(
    input.deals.filter((d) => !PLACEHOLDER_PHONES.has(String(d.contactPhoneKey))),
    (d) => d.contactPhoneKey
  );
  const dealFor = (lead) =>
    (lead.source === 'meta' && dealByLeadId.get(lead.id)) ||
    (lead.source === 'bigin' && dealByContactId.get(lead.id)) ||
    (lead.phoneKey && dealByPhone.get(lead.phoneKey)) ||
    null;

  const campaigns = new Map();
  const campaignNode = (id) => {
    if (!campaigns.has(id)) {
      campaigns.set(id, {
        id,
        name: id === UNKNOWN ? null : campaignName.get(id) || null,
        ...emptyNode(),
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
        ...emptyNode(),
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
        ...emptyNode(),
        spend: input.adSpend ? 0 : null,
      });
    }
    return adset.ads.get(id);
  };

  const allLeads = normaliseLeads(input.metaLeads, input.webLeads, adById, input.contacts);

  // --- The campaign tree — ad-attributed leads only --------------------------
  // A web lead whose ad set resolved counts under THAT ad set's campaign: the ad
  // set id is Meta's own data, a name/alias campaign match is an inference, and
  // when they disagree the id wins (see services/adEntityResolver).
  const treeCampaignOf = (lead) =>
    lead.source === 'web' && lead.adsetId
      ? String(adsetCampaign.get(lead.adsetId) || lead.campaignId || UNKNOWN)
      : lead.campaignId;
  const treeEligible = (lead) =>
    lead.source === 'meta' || Boolean(lead.hasCampaign || (lead.source === 'web' && lead.adsetId));
  // The dedup bucket. Meta / Bigin leads keep the historical key (campaign + ad)
  // so existing numbers do not shift; a web lead that resolved an ad set dedups
  // per ad-set/ad node, an unresolved one per landing page, as before.
  const treeBucket = (lead) => {
    if (lead.source !== 'web') return `ad:${lead.campaignId}:${lead.adId}`;
    return lead.adsetId
      ? `ad:${treeCampaignOf(lead)}:${lead.adsetId}:${lead.adId || '-'}`
      : `lp:${lead.campaignId}`;
  };

  const totals = emptyNode();

  for (const lead of dedupBy(allLeads.filter(treeEligible), treeBucket)) {
    const deal = dealFor(lead);
    const bucket = outcomeOf(deal);
    const flags = funnelFlags(lead, deal, sets);

    const campaign = campaignNode(treeCampaignOf(lead));
    applyLead(totals, bucket, deal, flags);
    applyLead(campaign, bucket, deal, flags);
    if (lead.source === 'web' && !lead.adsetId) {
      if (!campaign.landingPage) campaign.landingPage = emptyNode();
      applyLead(campaign.landingPage, bucket, deal, flags);
    } else {
      const adset = adsetNode(campaign, lead.adsetId);
      applyLead(adset, bucket, deal, flags);
      // A lead that names its ad set but not its ad (every Bigin/LeadChain lead,
      // and a web lead whose utm_content matched nothing) counts on the ad set
      // only, in an explicit "ad not tracked" bucket.
      if (!lead.adId || lead.adId === UNKNOWN) {
        if (!adset.noAd) adset.noAd = emptyNode();
        applyLead(adset.noAd, bucket, deal, flags);
      } else {
        applyLead(adNode(adset, lead.adId), bucket, deal, flags);
      }
    }
  }

  // --- The source / medium view — every capture ------------------------------
  const sourceRows = new Map();
  const sourceTotals = emptyNode();
  for (const lead of dedupBy(allLeads, (l) => sourceRowOf(l).key)) {
    const deal = dealFor(lead);
    const bucket = outcomeOf(deal);
    const flags = funnelFlags(lead, deal, sets);
    const { key, label } = sourceRowOf(lead);
    if (!sourceRows.has(key)) {
      // First-seen label wins — leads are sorted earliest-first, so a later
      // casing variant of the same utm pair does not flap the display name.
      sourceRows.set(key, { key, label, kind: key.split(':')[0], ...emptyNode() });
    }
    applyLead(sourceRows.get(key), bucket, deal, flags);
    applyLead(sourceTotals, bucket, deal, flags);
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
  // Open-deal stage breakdown, biggest stage first; null when nothing is open so
  // the API says "no pipeline" rather than sending an empty object to expand.
  const stagesOf = (m) =>
    m.size
      ? Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
      : null;
  const byWeight = (a, b) => b.counts.leads - a.counts.leads || (b.spend || 0) - (a.spend || 0);

  const tree = [...campaigns.values()]
    .map((c) => ({
      id: c.id,
      name: c.name,
      counts: roundCounts(c.counts),
      stages: stagesOf(c.stages),
      spend: money(c.spend),
      landingPage: c.landingPage
        ? { counts: roundCounts(c.landingPage.counts), stages: stagesOf(c.landingPage.stages) }
        : null,
      adsets: [...c.adsets.values()]
        .map((s) => ({
          id: s.id,
          name: s.name,
          counts: roundCounts(s.counts),
          stages: stagesOf(s.stages),
          spend: s.spend === null ? null : money(s.spend),
          noAd: s.noAd ? { counts: roundCounts(s.noAd.counts), stages: stagesOf(s.noAd.stages) } : null,
          ads: [...s.ads.values()]
            .map((a) => ({
              id: a.id,
              name: a.name,
              counts: roundCounts(a.counts),
              stages: stagesOf(a.stages),
              spend: a.spend === null ? null : money(a.spend),
            }))
            .sort(byWeight),
        }))
        .sort(byWeight),
    }))
    .sort(byWeight);

  const sources = [...sourceRows.values()]
    .map((r) => ({
      key: r.key,
      label: r.label,
      kind: r.kind, // 'utm' (web), 'src' (Bigin Lead_Source1), 'meta' (lead form)
      counts: roundCounts(r.counts),
      stages: stagesOf(r.stages),
    }))
    .sort((a, b) => b.counts.leads - a.counts.leads || a.label.localeCompare(b.label));

  return {
    totals: { counts: roundCounts(totals.counts), stages: stagesOf(totals.stages), spend: money(totalSpend) },
    campaigns: tree,
    sources,
    sourceTotals: { counts: roundCounts(sourceTotals.counts), stages: stagesOf(sourceTotals.stages) },
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
    // ALL web leads in range — the source view counts the unattributed ones too;
    // rollUpPerformance keeps the campaign tree to the attributed subset.
    WebLead.find(
      { createdAt: { $gte: after, $lt: before } },
      {
        _id: 1,
        createdAt: 1,
        phoneKey: 1,
        utmSource: 1,
        utmMedium: 1,
        resolvedCampaignId: 1,
        resolvedAdsetId: 1,
        resolvedAdId: 1,
      }
    ).lean(),
    // ALL Bigin contacts in range, for the same reason.
    Contact.find(
      { createdTime: { $gte: after, $lt: before } },
      { zohoId: 1, createdTime: 1, phoneKeys: 1, metaCampaignId: 1, metaAdsetId: 1, leadSource: 1 }
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
        ...webLeads.map((l) => l.resolvedAdId),
        ...adSpendRows.map((r) => r.entityId),
      ].filter(Boolean)
    ),
  ];

  const [dealsById, dealsByContact, dealsByPhone, ads, mqlContacts, sqlCalls] = await Promise.all([
    socialIds.length ? Deal.find({ socialLeadId: { $in: socialIds } }, DEAL_FIELDS).lean() : [],
    contactIds.length ? Deal.find({ contactId: { $in: contactIds } }, DEAL_FIELDS).lean() : [],
    phoneKeys.length ? Deal.find({ contactPhoneKey: { $in: phoneKeys } }, DEAL_FIELDS).lean() : [],
    adIds.length
      ? MetaAd.find({ _id: { $in: adIds } }, { name: 1, adsetId: 1, campaignId: 1 }).lean()
      : [],
    // MQL: does a Bigin contact (from ANY time, not just the range) share the
    // lead's phone key?
    phoneKeys.length
      ? Contact.find({ phoneKeys: { $in: phoneKeys } }, { phoneKeys: 1 }).lean()
      : [],
    // SQL: a call strictly longer than SQL_MIN_CALL_SEC, whenever it happened
    // (decision: no time window). The $or is a prefilter — the authoritative
    // rule is leadList's callSeconds (Bigin's duration when logged there, the
    // TeleCMI one otherwise), applied in JS below, so a call with a long TeleCMI
    // leg but a 20s Bigin log does NOT qualify.
    phoneKeys.length || contactIds.length
      ? Call.find(
          {
            $and: [
              {
                $or: [
                  { duration: { $gt: SQL_MIN_CALL_SEC } },
                  { biginDurationSec: { $gt: SQL_MIN_CALL_SEC } },
                ],
              },
              {
                $or: [
                  ...(phoneKeys.length ? [{ phoneKeys: { $in: phoneKeys } }] : []),
                  ...(contactIds.length ? [{ biginContactId: { $in: contactIds } }] : []),
                ],
              },
            ],
          },
          { phoneKeys: 1, biginContactId: 1, duration: 1, biginDurationSec: 1 }
        ).lean()
      : [],
  ]);

  const mqlPhones = new Set();
  for (const c of mqlContacts) for (const k of c.phoneKeys || []) mqlPhones.add(k);

  const callSeconds = (c) => Number(c.biginDurationSec != null ? c.biginDurationSec : c.duration) || 0;
  const sqlPhones = new Set();
  const sqlContactIds = new Set();
  for (const call of sqlCalls) {
    if (!(callSeconds(call) > SQL_MIN_CALL_SEC)) continue;
    for (const k of call.phoneKeys || []) {
      if (k && k !== OFFICE_DID && !PLACEHOLDER_PHONES.has(k)) sqlPhones.add(k);
    }
    if (call.biginContactId) sqlContactIds.add(String(call.biginContactId));
  }

  const adsetIds = [
    ...new Set(
      [
        ...ads.map((a) => a.adsetId),
        ...contacts.map((c) => c.metaAdsetId),
        ...webLeads.map((l) => l.resolvedAdsetId),
        ...adSpendRows.map((r) => r.adsetId),
      ].filter(Boolean)
    ),
  ];
  const adsets = adsetIds.length
    ? await MetaAdset.find({ _id: { $in: adsetIds } }, { name: 1, campaignId: 1 }).lean()
    : [];

  const campaignIds = [
    ...new Set(
      [
        ...metaLeads.map((l) => l.campaignId),
        ...webLeads.map((l) => l.resolvedCampaignId),
        ...contacts.map((c) => c.metaCampaignId),
        ...ads.map((a) => a.campaignId),
        ...adsets.map((a) => a.campaignId),
        ...campaignSpend.map((r) => r.entityId),
        ...adSpendRows.map((r) => r.campaignId),
      ]
        .filter(Boolean)
        .map(String)
    ),
  ];
  const campaigns = campaignIds.length
    ? await MetaCampaign.find({ _id: { $in: campaignIds } }, { name: 1 }).lean()
    : [];

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
    mqlPhones,
    sqlPhones,
    sqlContactIds,
  });
}

module.exports = { buildAdPerformance, rollUpPerformance, outcomeOf, PLACEHOLDER_PHONES };
