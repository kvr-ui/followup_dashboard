const test = require('node:test');
const assert = require('node:assert/strict');

const { rollUpPerformance, outcomeOf } = require('../adPerformance');

const base = () => ({
  metaLeads: [],
  webLeads: [],
  deals: [],
  campaigns: [{ _id: 'c1', name: 'Campaign One' }],
  adsets: [{ _id: 's1', name: 'Set One', campaignId: 'c1' }],
  ads: [
    { _id: 'a1', name: 'Ad One', adsetId: 's1', campaignId: 'c1' },
    { _id: 'a2', name: 'Ad Two', adsetId: 's1', campaignId: 'c1' },
  ],
  campaignSpend: [],
  adSpend: null,
});

const meta = (id, adId, phoneKey, createdTime = '2026-10-01T10:00:00+0530') => ({
  _id: id,
  adId,
  campaignId: 'c1',
  phoneKey,
  createdTime,
});

test('outcomeOf splits junk out of lost', () => {
  assert.equal(outcomeOf(null), 'noDeal');
  assert.equal(outcomeOf({ outcome: 'won' }), 'won');
  assert.equal(outcomeOf({ outcome: 'open' }), 'pipeline');
  assert.equal(outcomeOf({ outcome: 'lost', lostReason: 'Price' }), 'lost');
  assert.equal(outcomeOf({ outcome: 'lost', lostReason: 'wrongnumber / not enq' }), 'junk');
});

test('buckets add up and roll up campaign -> ad set -> ad', () => {
  const input = base();
  input.metaLeads = [
    meta('L1', 'a1', '9000000001'),
    meta('L2', 'a1', '9000000002'),
    meta('L3', 'a2', '9000000003'),
    meta('L4', 'a2', '9000000004'),
    meta('L5', 'a2', null),
  ];
  input.deals = [
    { socialLeadId: 'L1', outcome: 'won', amount: 5000 },
    { contactPhoneKey: '9000000002', outcome: 'lost', lostReason: 'Language Issue' },
    { contactPhoneKey: '9000000003', outcome: 'lost', lostReason: 'Too costly' },
    { contactPhoneKey: '9000000004', outcome: 'open' },
  ];
  const { totals, campaigns } = rollUpPerformance(input);

  // mql/sql are 4: the four leads with a deal (deal ⇒ sql ⇒ mql), not the noDeal one.
  assert.deepEqual(totals.counts, {
    leads: 5, mql: 4, sql: 4, junk: 1, lost: 1, won: 1, pipeline: 1, noDeal: 1, revenue: 5000,
  });
  assert.equal(campaigns.length, 1);
  const [c] = campaigns;
  assert.equal(c.name, 'Campaign One');
  assert.equal(c.adsets[0].name, 'Set One');
  const byAd = Object.fromEntries(c.adsets[0].ads.map((a) => [a.id, a.counts]));
  assert.equal(byAd.a1.leads, 2);
  assert.equal(byAd.a1.won, 1);
  assert.equal(byAd.a1.junk, 1);
  assert.equal(byAd.a2.leads, 3);
});

test('same person on the same ad counts once; on another ad counts again', () => {
  const input = base();
  input.metaLeads = [
    meta('L1', 'a1', '9000000001', '2026-10-01T10:00:00+0530'),
    meta('L2', 'a1', '9000000001', '2026-10-02T10:00:00+0530'),
    meta('L3', 'a2', '9000000001', '2026-10-03T10:00:00+0530'),
  ];
  const { campaigns } = rollUpPerformance(input);
  const byAd = Object.fromEntries(campaigns[0].adsets[0].ads.map((a) => [a.id, a.counts.leads]));
  assert.deepEqual(byAd, { a1: 1, a2: 1 });
});

test('placeholder phones are dropped as test leads', () => {
  const input = base();
  input.metaLeads = [meta('L1', 'a1', '9999999999'), meta('L2', 'a1', '9876543210')];
  input.webLeads = [{ _id: 'w1', createdAt: new Date(), resolvedCampaignId: 'c1', phoneKey: '9999999999' }];
  assert.equal(rollUpPerformance(input).totals.counts.leads, 0);
});

test('landing-page leads sit under their campaign, not on an ad', () => {
  const input = base();
  input.webLeads = [{ _id: 'w1', createdAt: new Date(), resolvedCampaignId: 'c1', phoneKey: '9000000009' }];
  input.deals = [{ contactPhoneKey: '9000000009', outcome: 'won', amount: 1200 }];
  const [c] = rollUpPerformance(input).campaigns;
  assert.equal(c.counts.won, 1);
  assert.equal(c.landingPage.counts.won, 1);
  assert.equal(c.adsets.length, 0);
});

test('spend: campaign from campaign rows, ad set/ad from ad rows, null when unsynced', () => {
  const input = base();
  input.metaLeads = [meta('L1', 'a1', '9000000001')];
  input.campaignSpend = [{ entityId: 'c1', spend: 100.5 }, { entityId: 'c2', spend: 40 }];

  let out = rollUpPerformance(input);
  assert.equal(out.totals.spend, 140.5);
  assert.equal(out.campaigns.find((c) => c.id === 'c1').spend, 100.5);
  // Spend with no leads still shows up.
  assert.equal(out.campaigns.find((c) => c.id === 'c2').counts.leads, 0);
  assert.equal(out.campaigns[0].adsets[0].spend, null);
  assert.equal(out.adSpendAvailable, false);

  input.adSpend = [
    { entityId: 'a1', adsetId: 's1', campaignId: 'c1', spend: 60 },
    { entityId: 'a2', adsetId: 's1', campaignId: 'c1', spend: 40.5 },
  ];
  out = rollUpPerformance(input);
  const set = out.campaigns.find((c) => c.id === 'c1').adsets[0];
  assert.equal(set.spend, 100.5);
  assert.deepEqual(Object.fromEntries(set.ads.map((a) => [a.id, a.spend])), { a1: 60, a2: 40.5 });
});

test('funnel flags: bigin is mql, a qualifying call is sql, a deal is both', () => {
  const input = base();
  input.contacts = [
    // A bare Bigin contact: mql by existence, nothing more.
    { zohoId: 'z1', createdTime: new Date('2026-10-01'), phoneKeys: ['9000000021'], metaCampaignId: 'c1', metaAdsetId: 's1' },
    // A contact with a qualifying call matched by contact id.
    { zohoId: 'z2', createdTime: new Date('2026-10-01'), phoneKeys: ['9000000022'], metaCampaignId: 'c1', metaAdsetId: 's1' },
  ];
  // A meta lead with no contact and no call: lead only. Another whose phone has
  // both a contact and a qualifying call.
  input.metaLeads = [meta('L1', 'a1', '9000000023'), meta('L2', 'a1', '9000000024')];
  input.mqlPhones = new Set(['9000000024']);
  input.sqlPhones = new Set(['9000000024']);
  input.sqlContactIds = new Set(['z2']);

  const { totals } = rollUpPerformance(input);
  assert.equal(totals.counts.leads, 4);
  assert.equal(totals.counts.mql, 3); // z1, z2, L2 — not L1
  assert.equal(totals.counts.sql, 2); // z2, L2
});

test('a deal with no phone/contact match still makes the lead mql and sql (monotone)', () => {
  const input = base();
  input.metaLeads = [meta('L1', 'a1', null)];
  input.deals = [{ socialLeadId: 'L1', outcome: 'open', stage: 'Negotiation' }];
  const { totals } = rollUpPerformance(input);
  assert.equal(totals.counts.mql, 1);
  assert.equal(totals.counts.sql, 1);
  assert.ok(totals.counts.leads >= totals.counts.mql);
  assert.ok(totals.counts.mql >= totals.counts.sql);
});

test('stages: open deals break down by raw Bigin stage and sum to pipeline', () => {
  const input = base();
  input.metaLeads = [
    meta('L1', 'a1', '9000000031'),
    meta('L2', 'a1', '9000000032'),
    meta('L3', 'a1', '9000000033'),
    meta('L4', 'a1', '9000000034'),
  ];
  input.deals = [
    { socialLeadId: 'L1', outcome: 'open', stage: 'Qualification' },
    { socialLeadId: 'L2', outcome: 'open', stage: 'Qualification' },
    { socialLeadId: 'L3', outcome: 'open' }, // open with no stage string
    { socialLeadId: 'L4', outcome: 'won', amount: 100 }, // won: not in stages
  ];
  const { totals, campaigns } = rollUpPerformance(input);
  assert.deepEqual(totals.stages, { Qualification: 2, '(no stage)': 1 });
  const sum = Object.values(totals.stages).reduce((a, b) => a + b, 0);
  assert.equal(sum, totals.counts.pipeline);
  const ad = campaigns[0].adsets[0].ads.find((a) => a.id === 'a1');
  assert.deepEqual(ad.stages, { Qualification: 2, '(no stage)': 1 });
});

test('web leads with a resolved ad set / ad land on the ad node, not the landing page', () => {
  const input = base();
  input.webLeads = [
    { _id: 'w1', createdAt: new Date('2026-10-01'), phoneKey: '9000000041', resolvedCampaignId: 'c1', resolvedAdsetId: 's1', resolvedAdId: 'a1' },
    // Ad set resolved, ad not: the ad set's "ad not tracked" bucket.
    { _id: 'w2', createdAt: new Date('2026-10-01'), phoneKey: '9000000042', resolvedCampaignId: 'c1', resolvedAdsetId: 's1', resolvedAdId: null },
    // Campaign only: the landing-page bucket, as before.
    { _id: 'w3', createdAt: new Date('2026-10-01'), phoneKey: '9000000043', resolvedCampaignId: 'c1' },
  ];
  const [c] = rollUpPerformance(input).campaigns;
  assert.equal(c.counts.leads, 3);
  assert.equal(c.landingPage.counts.leads, 1);
  const [set] = c.adsets;
  assert.equal(set.counts.leads, 2);
  assert.equal(set.noAd.counts.leads, 1);
  assert.equal(set.ads.find((a) => a.id === 'a1').counts.leads, 1);
});

test('an adset-resolved web lead counts under the AD SET\'s campaign when the UTM campaign disagrees', () => {
  const input = base();
  input.campaigns.push({ _id: 'c2', name: 'Campaign Two' });
  // utm_campaign resolved to c2, but the ad set s1 belongs to c1 — the id wins.
  input.webLeads = [
    { _id: 'w1', createdAt: new Date('2026-10-01'), phoneKey: '9000000051', resolvedCampaignId: 'c2', resolvedAdsetId: 's1' },
  ];
  const { campaigns } = rollUpPerformance(input);
  const c1 = campaigns.find((c) => c.id === 'c1');
  assert.equal(c1.counts.leads, 1);
  assert.equal(c1.adsets[0].counts.leads, 1);
  assert.ok(!campaigns.find((c) => c.id === 'c2' && c.counts.leads > 0));
});

test('source view: every capture, grouped by utm pair / canonical lead source / meta form', () => {
  const input = base();
  input.webLeads = [
    // Two casing variants of one utm pair merge into one row (first label wins)…
    { _id: 'w1', createdAt: new Date('2026-10-01'), phoneKey: '9000000061', utmSource: 'META', utmMedium: 'Facebook_Mobile_Reels', resolvedCampaignId: 'c1' },
    { _id: 'w2', createdAt: new Date('2026-10-02'), phoneKey: '9000000062', utmSource: 'meta', utmMedium: 'facebook_mobile_reels', resolvedCampaignId: 'c1' },
    // …and an unattributed web lead (no campaign) still counts here.
    { _id: 'w3', createdAt: new Date('2026-10-03'), phoneKey: '9000000063', utmSource: 'google', utmMedium: 'cpc' },
  ];
  input.contacts = [
    // Two spellings of one channel canonicalise to one row; no metaCampaignId, so
    // it is NOT in the tree but IS in the source view.
    { zohoId: 'z1', createdTime: new Date('2026-10-01'), phoneKeys: ['9000000064'], leadSource: 'Whatsapp' },
    { zohoId: 'z2', createdTime: new Date('2026-10-01'), phoneKeys: ['9000000065'], leadSource: 'WhatsApp DMs' },
  ];
  input.metaLeads = [meta('L1', 'a1', '9000000066')];
  input.deals = [{ contactPhoneKey: '9000000063', outcome: 'won', amount: 900 }];

  const { totals, sources, sourceTotals } = rollUpPerformance(input);

  // Tree: w3 (no campaign) and the two unstamped contacts are excluded.
  assert.equal(totals.counts.leads, 3);
  // Source view: everything.
  assert.equal(sourceTotals.counts.leads, 6);
  assert.equal(sourceTotals.counts.won, 1);

  const byKey = Object.fromEntries(sources.map((s) => [s.key, s]));
  assert.equal(byKey['utm:meta|facebook_mobile_reels'].counts.leads, 2);
  assert.equal(byKey['utm:meta|facebook_mobile_reels'].label, 'META · Facebook_Mobile_Reels');
  assert.equal(byKey['utm:google|cpc'].counts.won, 1);
  assert.equal(byKey['src:WhatsApp (organic/DM)'].counts.leads, 2);
  assert.equal(byKey['meta:leadform'].counts.leads, 1);
});

test('source view dedups one person per row, and placeholders stay out of it', () => {
  const input = base();
  input.webLeads = [
    { _id: 'w1', createdAt: new Date('2026-10-01'), phoneKey: '9000000071', utmSource: 'meta', utmMedium: 'reels' },
    { _id: 'w2', createdAt: new Date('2026-10-02'), phoneKey: '9000000071', utmSource: 'meta', utmMedium: 'reels' },
    { _id: 'w3', createdAt: new Date('2026-10-03'), phoneKey: '9999999999', utmSource: 'meta', utmMedium: 'reels' },
  ];
  const { sources } = rollUpPerformance(input);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].counts.leads, 1);
});

test('Bigin contacts count on their ad set (ad not tracked) and join deals by contact id', () => {
  const input = base();
  input.contacts = [
    { zohoId: 'z1', createdTime: new Date('2026-10-01'), phoneKeys: ['9000000011'], metaCampaignId: 'c1', metaAdsetId: 's1' },
    { zohoId: 'z2', createdTime: new Date('2026-10-01'), phoneKeys: ['9000000012'], metaCampaignId: 'c1', metaAdsetId: 's1' },
  ];
  input.deals = [
    { contactId: 'z1', outcome: 'won', amount: 3000 },
    { contactId: 'z2', outcome: 'lost', lostReason: 'Wrong Course/Level' },
  ];
  const [c] = rollUpPerformance(input).campaigns;
  assert.equal(c.id, 'c1');
  const [set] = c.adsets;
  assert.equal(set.ads.length, 0);
  assert.equal(set.counts.leads, 2);
  assert.equal(set.noAd.counts.won, 1);
  assert.equal(set.noAd.counts.junk, 1);
  assert.equal(c.counts.revenue, 3000);
});
