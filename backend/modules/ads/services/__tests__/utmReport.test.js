const test = require('node:test');
const assert = require('node:assert/strict');

const { rollUpUtm } = require('../utmReport');
const { cpFromUrl } = require('../cpParams');

const web = (id, phoneKey, fields = {}, createdAt = '2026-10-01T10:00:00Z') => ({
  _id: id,
  phoneKey,
  createdAt,
  ...fields,
});

test('groups case-insensitively and labels with the most common spelling', () => {
  const { source } = rollUpUtm({
    webLeads: [
      web('1', '9000000001', { utmSource: 'google' }),
      web('2', '9000000002', { utmSource: 'Google' }),
      web('3', '9000000003', { utmSource: ' google ' }),
      web('4', '9000000004', { utmSource: 'META' }),
    ],
    deals: [],
  });
  assert.deepEqual(
    source.rows.map((r) => [r.label, r.registrations]),
    [['google', 3], ['META', 1]]
  );
  assert.equal(source.totals.registrations, 4);
});

test('blank values land in the (none) row', () => {
  const { cp1 } = rollUpUtm({
    webLeads: [web('1', '9000000001'), web('2', '9000000002', { cp1: '  ' })],
    deals: [],
  });
  assert.deepEqual(cp1.rows.map((r) => [r.label, r.registrations]), [['(none)', 2]]);
});

test('one person per row — earliest fill wins, phoneless leads always count', () => {
  const { campaign } = rollUpUtm({
    webLeads: [
      web('2', '9000000001', { utmCampaign: 'B' }, '2026-10-02T10:00:00Z'),
      web('1', '9000000001', { utmCampaign: 'a' }, '2026-10-01T10:00:00Z'),
      web('3', '9000000001', { utmCampaign: 'A' }, '2026-10-03T10:00:00Z'),
      web('4', null, { utmCampaign: 'a' }),
      web('5', null, { utmCampaign: 'a' }),
    ],
    deals: [],
  });
  const byKey = Object.fromEntries(campaign.rows.map((r) => [r.key, r.registrations]));
  assert.deepEqual(byKey, { a: 3, b: 1 });
});

test('demo = connected call or a deal; sales and revenue come from won deals', () => {
  const { medium } = rollUpUtm({
    webLeads: [
      web('1', '9000000001', { utmMedium: 'cpc' }), // connected, no deal
      web('2', '9000000002', { utmMedium: 'cpc' }), // won deal, no call logged
      web('3', '9000000003', { utmMedium: 'cpc' }), // lost deal
      web('4', '9000000004', { utmMedium: 'cpc' }), // nothing
    ],
    deals: [
      { contactPhoneKey: '9000000002', outcome: 'won', amount: 45000.5 },
      { contactPhoneKey: '9000000002', outcome: 'lost', amount: 0 },
      { contactPhoneKey: '9000000003', outcome: 'lost', amount: 30000 },
    ],
    connectedPhones: new Set(['9000000001']),
  });
  const [row] = medium.rows;
  assert.deepEqual(
    { registrations: row.registrations, demo: row.demo, sales: row.sales, revenue: row.revenue },
    { registrations: 4, demo: 3, sales: 1, revenue: 45000.5 }
  );
});

test('placeholder test phones are dropped from leads and deals', () => {
  const { term } = rollUpUtm({
    webLeads: [web('1', '9999999999', { utmTerm: 'x' }), web('2', '9000000001', { utmTerm: 'x' })],
    deals: [{ contactPhoneKey: '9999999999', outcome: 'won', amount: 100 }],
  });
  assert.equal(term.totals.registrations, 1);
  assert.equal(term.totals.sales, 0);
});

test('every dimension is present, including cp1 / cp2', () => {
  const report = rollUpUtm({
    webLeads: [web('1', '9000000001', { cp1: 'hero', cp2: 'v2' })],
    deals: [],
  });
  assert.deepEqual(Object.keys(report), ['source', 'medium', 'campaign', 'content', 'term', 'cp1', 'cp2']);
  assert.equal(report.cp1.rows[0].label, 'hero');
  assert.equal(report.cp2.rows[0].label, 'v2');
});

test('cpFromUrl reads cp1 / cp2 and survives junk', () => {
  assert.deepEqual(cpFromUrl('https://focasedu.com/lp?utm_source=g&cp1=hero%20a&cp2=v2'), {
    cp1: 'hero a',
    cp2: 'v2',
  });
  assert.deepEqual(cpFromUrl('/lp?cp2=only'), { cp2: 'only' });
  assert.deepEqual(cpFromUrl('https://focasedu.com/lp?cp1='), {});
  assert.deepEqual(cpFromUrl('https://focasedu.com/lp'), {});
  assert.deepEqual(cpFromUrl('http://[bad'), {});
  assert.deepEqual(cpFromUrl(undefined), {});
});
