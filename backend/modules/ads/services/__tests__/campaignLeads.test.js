const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRows, applyFilters, filterOptions, NONE } = require('../campaignLeads');

const contacts = [
  { zohoId: 'c1', name: 'Asha', phone: '9876501234', metaCampaignId: '111', caStatus: 'Inter', leadSource: 'Meta', ownerName: 'Priya', createdTime: new Date('2026-10-02') },
  { zohoId: 'c2', name: 'Ravi', mobile: '9000000001', metaCampaignId: '222', caStatus: 'Final', leadSource: 'Website', ownerName: 'Kumar' },
  { zohoId: 'c3', name: 'Meena', phone: '9000000002', leadSource: 'Meta' },
  { zohoId: 'c4', name: 'Open One', phone: '9000000003', metaCampaignId: '111', caStatus: 'Inter' },
];
const deals = [
  { contactId: 'c1', outcome: 'lost', stage: 'Closed without Sale', modifiedTime: new Date('2026-10-03') },
  { contactId: 'c1', outcome: 'won', stage: 'Closed with Sale', amount: 25000, modifiedTime: new Date('2026-10-05') },
  { contactId: 'c2', outcome: 'lost', stage: 'Closed without Sale', modifiedTime: new Date('2026-10-04') },
  { contactId: 'c4', outcome: 'open', stage: 'Qualified', modifiedTime: new Date('2026-10-04') },
];
const names = new Map([['111', 'Aug Promo']]);
const rows = buildRows(contacts, deals, names);
const byId = (id) => rows.find((r) => r.id === id);

test('latest deal wins and no deal is "none"', () => {
  assert.equal(byId('c1').outcome, 'won');
  assert.equal(byId('c1').amount, 25000);
  assert.equal(byId('c2').outcome, 'lost');
  assert.equal(byId('c3').outcome, 'none');
  assert.equal(byId('c4').outcome, 'open');
});

test('campaign name resolves, else raw id, else null; phone falls back to mobile', () => {
  assert.equal(byId('c1').campaign, 'Aug Promo');
  assert.equal(byId('c2').campaign, '222');
  assert.equal(byId('c3').campaign, null);
  assert.equal(byId('c2').phone, '9000000001');
});

test('each filter narrows rows', () => {
  const ids = (f) => applyFilters(rows, f).map((r) => r.id).sort();
  assert.deepEqual(ids({}), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(ids({ campaign: '111' }), ['c1', 'c4']);
  assert.deepEqual(ids({ campaign: NONE }), ['c3']);
  assert.deepEqual(ids({ caStatus: 'Inter' }), ['c1', 'c4']);
  assert.deepEqual(ids({ source: 'Meta' }), ['c1', 'c3']);
  assert.deepEqual(ids({ outcome: 'won' }), ['c1']);
  assert.deepEqual(ids({ outcome: 'lost' }), ['c2']);
  assert.deepEqual(ids({ owner: 'Kumar' }), ['c2']);
  assert.deepEqual(ids({ q: 'mee' }), ['c3']);
  assert.deepEqual(ids({ q: '00003' }), ['c4']);
  assert.deepEqual(ids({ campaign: '111', outcome: 'open' }), ['c4']);
});

test('filter options count every value including empty', () => {
  const o = filterOptions(rows);
  assert.deepEqual(o.campaigns.map((c) => [c.value, c.label, c.count]), [['111', 'Aug Promo', 2], ['222', '222', 1], [NONE, null, 1]]);
  assert.deepEqual(o.outcomes.map((x) => x.count), [1, 1, 1, 1]);
});

test('dropdown counts are faceted: each applies the other filters, not its own', () => {
  const o = filterOptions(rows, { caStatus: 'Inter' });
  // Outcome counts are within CA Status = Inter (c1 won, c4 open).
  assert.deepEqual(o.outcomes.map((x) => [x.value, x.count]), [['won', 1], ['lost', 0], ['open', 1], ['none', 0]]);
  // CA Status counts ignore their own filter, so other values stay pickable.
  assert.deepEqual(o.caStatuses.map((c) => [c.value, c.count]), [['Inter', 2], ['Final', 1], [NONE, 1]]);
});

test('a selected value with no matches is still listed', () => {
  const o = filterOptions(rows, { caStatus: 'Final', campaign: '111' });
  assert.ok(o.caStatuses.some((c) => c.value === 'Final' && c.count === 0));
});
