const test = require('node:test');
const assert = require('node:assert/strict');

const { rollUpLifecycle, speedBucket, dedupeTwins, analyseLead } = require('../repLifecycle');

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
  for (const [key, rows] of Object.entries(signals)) {
    // templates and topics are multi/partial by design; vsl is null with no VSL cluster.
    if (!rows || key === 'templates' || key === 'topics') continue;
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

// ---- before the first call: WATI chat and VSL ------------------------------

const item = (mins, kind, extra = {}) => ({ at: at(mins), kind, ...extra });

test('lead-in moves to the first WhatsApp message in the week before Bigin', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001', 20)];
  input.chats = [{ phoneKey: '9000000001', items: [item(0, 'lead', { text: 'Hi' })] }];
  input.calls = [call('9000000001', 25, { duration: 60 })];
  const [lead] = rollUpLifecycle(input).leads;
  assert.equal(lead.leadInSource, 'whatsapp');
  assert.equal(lead.minsToDial, 25);
});

test('chat: bot answers vs enquiries, rep chat, cut off at the first dial', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001')];
  input.chats = [
    {
      phoneKey: '9000000001',
      items: [
        item(0, 'lead', { text: 'Hi' }),
        item(1, 'flow', { state: 'started', name: 'Contact Onboarding v3' }),
        item(2, 'bot', { text: 'Which group?' }),
        item(3, 'lead', { text: '2' }), // a bot answer, not an enquiry
        item(4, 'flow', { state: 'ended', name: 'Contact Onboarding v3' }),
        item(5, 'bot', { text: 'https://www.focasedu.online/vsl?phone=91900' }),
        item(6, 'lead', { text: 'I need details about last attempt kit' }),
        item(7, 'rep', { text: 'May i call now ?' }),
        item(30, 'lead', { text: 'What is the fee?' }), // after the first dial: ignored
      ],
    },
  ];
  input.calls = [call('9000000001', 10, { duration: 120 })];
  const { leads, signals } = rollUpLifecycle(input);
  const [lead] = leads;
  assert.equal(lead.firstMover, 'lead');
  assert.equal(lead.bot, 'completed');
  assert.equal(lead.botFlow, 'Contact Onboarding v3');
  assert.equal(lead.botAnswers, 1);
  assert.equal(lead.leadMsgs, 2);
  assert.equal(lead.firstEnquiry, 'I need details about last attempt kit');
  assert.deepEqual(lead.topics.sort(), ['attempt', 'details', 'kit']);
  assert.equal(lead.repChat, 'yes');
  assert.equal(lead.askedToCall, true);
  assert.equal(lead.vslLinkSent, true);
  assert.equal(row(signals.bot, 'completed').leads, 1);
  assert.equal(row(signals.topics, 'fees'), undefined);
});

test('chat: not synced vs no chat; unfinished bot; greetings only', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001'), contact('c2', '9000000002'), contact('c3', '9000000003')];
  input.chats = [
    { phoneKey: '9000000002', items: [] },
    {
      phoneKey: '9000000003',
      items: [item(1, 'flow', { state: 'started', name: 'Onb' }), item(2, 'lead', { text: '1' }), item(9, 'flow', { state: 'expired', name: 'Onb' }), item(10, 'lead', { text: 'ok' })],
    },
  ];
  const { leads, signals } = rollUpLifecycle(input);
  const byId = Object.fromEntries(leads.map((l) => [l.contactId, l]));
  assert.equal(byId.c1.bot, 'unsynced');
  assert.equal(byId.c2.firstMover, 'none');
  assert.equal(byId.c2.bot, 'none');
  assert.equal(byId.c3.firstMover, 'us');
  assert.equal(byId.c3.bot, 'unfinished');
  assert.deepEqual(byId.c3.topics, ['none']);
  assert.equal(row(signals.bot, 'unsynced').leads, 1);
});

test('VSL: peak before the first dial, bucket edges, no record', () => {
  const input = base();
  input.vslAvailable = true;
  input.contacts = [contact('c1', '9000000001'), contact('c2', '9000000002'), contact('c3', '9000000003')];
  input.vsl = [
    {
      phoneKey: '9000000001',
      firstOpenedAt: at(2),
      events: [
        { at: at(3), type: 'play_started', pct: 0 },
        { at: at(5), type: 'milestone', pct: 25 },
        { at: at(60), type: 'completed', pct: 100 }, // after the dial
      ],
    },
    { phoneKey: '9000000002', firstOpenedAt: at(2), events: [] },
  ];
  input.calls = [call('9000000001', 10)];
  const { leads, signals } = rollUpLifecycle(input);
  const byId = Object.fromEntries(leads.map((l) => [l.contactId, l]));
  assert.equal(byId.c1.vsl, '25to75');
  assert.equal(byId.c1.vslPeakPct, 25);
  assert.equal(byId.c2.vsl, 'openedNoPlay');
  assert.equal(byId.c3.vsl, 'noLink');
  assert.equal(signals.vsl.reduce((s, r) => s + r.leads, 0), 3);
});

test('VSL signal is null when the VSL cluster is not configured', () => {
  const input = base();
  input.contacts = [contact('c1', '9000000001')];
  const { signals, leads } = rollUpLifecycle(input);
  assert.equal(signals.vsl, null);
  assert.equal(leads[0].vsl, null);
});

test('timeline runs lead-in to first connect, in order', () => {
  const lead = analyseLead({
    contact: contact('c1', '9000000001'),
    formTimes: [],
    calls: [call('9000000001', 10), call('9000000001', 20, { duration: 90 }), call('9000000001', 99, { duration: 30 })],
    deal: null,
    whatsapp: [],
    chat: [item(1, 'lead', { text: 'hello' }), item(15, 'rep', { text: 'call?' }), item(50, 'lead', { text: 'late' })],
    vsl: { firstOpenedAt: at(4), events: [{ at: at(5), type: 'play_started', pct: 0 }] },
    vslAvailable: true,
    taskHistory: [{ createdTime: at(12), subject: 'CB', category: 'Call Back' }],
    withTimeline: true,
  });
  const kinds = lead.timeline.map((t) => t.kind);
  assert.deepEqual(kinds, ['leadIn', 'lead', 'vsl', 'vsl', 'call', 'task', 'rep', 'call']);
  assert.ok(lead.timeline.every((t, i, a) => i === 0 || a[i - 1].at <= t.at));
});
