const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  MAX_AGE_MS,
  isTestContact,
  contactEvents,
  tooOld,
  userData,
  toMetaEvent,
} = require('../capiEvents');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const contact = (fields = {}) => ({
  zohoId: '111',
  name: 'Ravi Kumar',
  phoneKeys: ['9000000001'],
  email: 'Ravi@Example.com ',
  createdTime: '2026-10-10T05:00:00Z',
  ...fields,
});
const ms = (s) => new Date(s).getTime();
const names = (events) => events.map((e) => e.event);

test('a bare contact is only a Lead, at its created time', () => {
  const events = contactEvents(contact());
  assert.deepEqual(names(events), ['Lead']);
  assert.equal(events[0].eventTime.toISOString(), '2026-10-10T05:00:00.000Z');
});

test('a connected call alone makes an MQL, not an SQL', () => {
  const events = contactEvents(contact(), [], ms('2026-10-11T00:00:00Z'));
  assert.deepEqual(names(events), ['Lead', 'MQL']);
  assert.equal(events[1].eventTime.toISOString(), '2026-10-11T00:00:00.000Z');
});

test('a deal makes MQL + SQL; MQL takes the earlier of call and deal', () => {
  const deals = [{ outcome: 'open', createdTime: '2026-10-12T00:00:00Z' }];
  const events = contactEvents(contact(), deals, ms('2026-10-11T00:00:00Z'));
  assert.deepEqual(names(events), ['Lead', 'MQL', 'SQL']);
  assert.equal(events[1].eventTime.toISOString(), '2026-10-11T00:00:00.000Z');
  assert.equal(events[2].eventTime.toISOString(), '2026-10-12T00:00:00.000Z');
});

test('SQL falls back to the mirror createdAt when Bigin created time is missing', () => {
  const events = contactEvents(contact(), [{ outcome: 'open', createdAt: '2026-10-12T00:00:00Z' }]);
  assert.equal(events.find((e) => e.event === 'SQL').eventTime.toISOString(), '2026-10-12T00:00:00.000Z');
});

test('a won deal is a Purchase with its amount; lost deals are not', () => {
  const deals = [
    { outcome: 'lost', createdTime: '2026-10-11T00:00:00Z', modifiedTime: '2026-10-12T00:00:00Z', amount: 9 },
    { outcome: 'won', createdTime: '2026-10-12T00:00:00Z', modifiedTime: '2026-10-13T00:00:00Z', amount: 25000 },
  ];
  const purchase = contactEvents(contact(), deals).find((e) => e.event === 'Purchase');
  assert.equal(purchase.value, 25000);
  assert.equal(purchase.eventTime.toISOString(), '2026-10-13T00:00:00.000Z');
  assert.equal(contactEvents(contact(), [deals[0]]).some((e) => e.event === 'Purchase'), false);
});

test('placeholder phones mark a test contact', () => {
  assert.equal(isTestContact(contact({ phoneKeys: ['9999999999'] })), true);
  assert.equal(isTestContact(contact()), false);
});

test('the 7-day window', () => {
  const now = ms('2026-10-14T00:00:00Z');
  assert.equal(tooOld(new Date(now - MAX_AGE_MS + 1000), now), false);
  assert.equal(tooOld(new Date(now - 7 * 24 * 3600 * 1000), now), true);
});

test('user_data hashes normalised phone, email and names', () => {
  const ud = userData(contact({ name: "  Ravi  O'Brien Kumar " }), [{ socialLeadId: '1234567890123456' }]);
  assert.deepEqual(ud.ph, [sha('919000000001')]);
  assert.deepEqual(ud.em, [sha('ravi@example.com')]);
  assert.deepEqual(ud.fn, [sha('ravi')]);
  assert.deepEqual(ud.ln, [sha('kumar')]);
  assert.deepEqual(ud.external_id, [sha('111')]);
  assert.equal(ud.lead_id, '1234567890123456');
});

test('user_data ignores note-like lead ids and placeholder phones; null when unmatchable', () => {
  const ud = userData(contact(), [{ socialLeadId: 'called twice' }]);
  assert.equal(ud.lead_id, undefined);
  assert.equal(userData(contact({ phoneKeys: ['9999999999'], email: null })), null);
});

test('Meta event: id without mode, Purchase carries INR value', () => {
  const ev = toMetaEvent(
    { contactId: '111', event: 'Purchase', eventTime: new Date('2026-10-13T00:00:00Z'), value: 25000 },
    { ph: ['x'] }
  );
  assert.equal(ev.event_id, '111:Purchase');
  assert.equal(ev.event_time, ms('2026-10-13T00:00:00Z') / 1000);
  assert.equal(ev.action_source, 'system_generated');
  assert.deepEqual(ev.custom_data, {
    event_source: 'crm',
    lead_event_source: 'Focas Dashboard',
    value: 25000,
    currency: 'INR',
  });
  const lead = toMetaEvent({ contactId: '111', event: 'Lead', eventTime: new Date() }, { ph: ['x'] });
  assert.equal(lead.custom_data.value, undefined);
});
