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

  assert.deepEqual(totals.counts, { leads: 5, junk: 1, lost: 1, won: 1, pipeline: 1, noDeal: 1, revenue: 5000 });
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
