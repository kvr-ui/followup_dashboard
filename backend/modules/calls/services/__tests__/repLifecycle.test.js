const test = require('node:test');
const assert = require('node:assert/strict');

const { rollUpLifecycle, speedBucket, dedupeTwins } = require('../repLifecycle');

const REP = 'veera@focasedu.com';
const T0 = new Date('2026-10-01T04:30:00Z'); // 10:00 IST, a Thursday
const at = (mins) => new Date(T0.getTime() + mins * 60000);

const base = () => ({
  ownerEmail: REP,
  after: new Date('2026-09-01T00:00:00Z'),
  before: new Date('2026-11-01T00:00:00Z'),
  contacts: [],
  forms: [],
  calls: [],
  deals: [],
  tasks: [],
});

const contact = (id, key, createdMins = 0) => ({
  zohoId: id,
  name: `Lead ${id}`,
  phoneKeys: [key],
  ownerEmail: REP,
  createdTime: at(createdMins),
});

const call = (key, mins, { direction = 'outbound', duration = 0, by = REP } = {}) => ({
  phoneKeys: [key],
  startedAt: at(mins),
  direction,
  duration,
  ownerEmail: by,
});

const row = (rows, key) => rows.find((r) => r.key === key);

test('speedBucket boundaries', () => {
  assert.equal(speedBucket(null), 'never');
  assert.equal(speedBucket(0), 'lt5m');
  assert.equal(speedBucket(4.9), 'lt5m');
  assert.equal(speedBucket(5), '5to30m');
  assert.equal(speedBucket(30), '30mto2h');
  assert.equal(speedBucket(120), '2to24h');
  assert.equal(speedBucket(1440), 'gt24h');
});

test('lead-in is the earliest form fill in the week before Bigin created the contact', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001', 30)];
  input.forms = [
    { phoneKey: '9000000001', at: at(0) },
    { phoneKey: '9000000001', at: at(-60 * 24 * 30) }, // a month earlier: ignored
  ];
  input.calls = [call('9000000001', 10, { duration: 60 })];
  const { leads } = rollUpLifecycle(input);
  assert.equal(leads[0].leadInSource, 'form');
  assert.equal(leads[0].minsToDial, 10);
});

test('dial vs connect, attempts, and twin collapse', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001')];
  input.calls = [
    call('9000000001', 2),
    call('9000000001', 2.5, { direction: 'unknown' }), // Bigin twin of the first dial
    call('9000000001', 60),
    call('9000000001', 120, { duration: 300 }),
  ];
  const [lead] = rollUpLifecycle(input).leads;
  assert.equal(lead.minsToDial, 2);
  assert.equal(lead.minsToConnect, 120);
  assert.equal(lead.attempts, 3);
  assert.equal(lead.connectedBy, 'dial');
  assert.equal(lead.totalCalls, 3);
});

test('a lead who calls in connects as calledIn; never-called leads land in never', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001'), contact('c2', '9000000002')];
  input.calls = [call('9000000001', 15, { direction: 'inbound', duration: 90 })];
  const { leads, signals } = rollUpLifecycle(input);
  const byId = Object.fromEntries(leads.map((l) => [l.contactId, l]));
  assert.equal(byId.c1.connectedBy, 'callIn');
  assert.equal(byId.c1.firstDialAt, null);
  assert.equal(row(signals.attempts, 'calledIn').leads, 1);
  assert.equal(row(signals.speed, 'never').leads, 2);
});

test('outcomes split junk from lost and the signal rows add up', () => {
  const input = base();
  input.contacts = [
    contact('c1', '9000000001'),
    contact('c2', '9000000002'),
    contact('c3', '9000000003'),
    contact('c4', '9000000004'),
  ];
  input.deals = [
    { contactId: 'c1', outcome: 'won', amount: 20000 },
    { contactPhoneKey: '9000000002', outcome: 'lost', lostReason: 'Too costly' },
    { contactId: 'c3', outcome: 'lost', lostReason: 'Language Issue' },
  ];
  input.calls = [call('9000000001', 3, { duration: 200 }), call('9000000002', 300, { duration: 20 })];
  const { summary, signals } = rollUpLifecycle(input);
  assert.equal(summary.all.leads, 4);
  assert.equal(summary.won.leads, 1);
  assert.equal(summary.lost.leads, 1);
  assert.equal(summary.junk.leads, 1);
  assert.equal(summary.open.leads, 1);
  assert.equal(summary.won.revenue, 20000);
  assert.equal(summary.won.medianMinsToDial, 3);
  for (const rows of Object.values(signals)) {
    if (rows === signals.templates) continue;
    assert.equal(rows.reduce((s, r) => s + r.leads, 0), 4);
  }
  assert.equal(row(signals.speed, 'lt5m').winPct, 100);
});

test('WhatsApp counts only when sent after lead-in and before the first dial', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001'), contact('c2', '9000000002')];
  input.calls = [call('9000000001', 30), call('9000000002', 30)];
  input.tasks = [
    { phoneKey: '9000000001', whatsappLog: [{ template: 'welcome', ok: true, sentAt: at(5) }] },
    { phoneKey: '9000000002', whatsappLog: [{ template: 'welcome', ok: true, sentAt: at(45) }] },
  ];
  const { leads, signals } = rollUpLifecycle(input);
  const byId = Object.fromEntries(leads.map((l) => [l.contactId, l]));
  assert.equal(byId.c1.whatsappFirst, 'welcome');
  assert.equal(byId.c2.whatsappFirst, null);
  assert.equal(row(signals.templates, 'welcome').leads, 1);
});

test('first caller is tagged: this rep, another rep, or unmapped', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001'), contact('c2', '9000000002'), contact('c3', '9000000003')];
  input.calls = [
    call('9000000001', 1, { by: REP }),
    call('9000000002', 1, { by: 'someone@focasedu.com' }),
    call('9000000003', 1, { by: null }),
  ];
  const { signals, summary } = rollUpLifecycle(input);
  assert.equal(row(signals.firstCaller, 'rep').leads, 1);
  assert.equal(row(signals.firstCaller, 'other').leads, 1);
  assert.equal(row(signals.firstCaller, 'unknown').leads, 1);
  assert.equal(summary.all.firstCallByOtherPct, 33.3);
});

test('test phones are dropped and the office DID never joins a call', () => {
  const input = base();
  input.contacts = [contact('c1', '9999999999'), contact('c2', '9000000002')];
  input.contacts[1].phoneKeys.push('7943447443');
  input.calls = [call('7943447443', 1, { duration: 60 })];
  const { leads } = rollUpLifecycle(input);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].contactId, 'c2');
  assert.equal(leads[0].totalCalls, 0);
});

test('leads outside the window are excluded', () => {
  const input = base();
  input.after = at(60);
  input.contacts = [contact('c1', '9000000001')];
  assert.equal(rollUpLifecycle(input).leads.length, 0);
});

test('dedupeTwins keeps calls further apart than the twin window', () => {
  const calls = [
    { at: at(0), direction: 'outbound', talkSec: 0, by: null },
    { at: at(1), direction: 'outbound', talkSec: 40, by: REP },
    { at: at(5), direction: 'outbound', talkSec: 0, by: REP },
  ];
  const kept = dedupeTwins(calls);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].talkSec, 40);
  assert.equal(kept[0].by, REP);
});
