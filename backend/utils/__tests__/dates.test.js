const test = require('node:test');
const assert = require('node:assert/strict');
const { toDate, istShift, istDayKey, istMonth, istParts, istDayStart, IST_OFFSET_MS } = require('../dates');

test('toDate: empty and invalid inputs are null, never an Invalid Date', () => {
  assert.equal(toDate(null), null);
  assert.equal(toDate(undefined), null);
  assert.equal(toDate(''), null);
  assert.equal(toDate(0), null);
  assert.equal(toDate(false), null);
  assert.equal(toDate('not a date'), null);
  assert.equal(toDate(new Date('garbage')), null);
});

test('toDate: Date passthrough, timestamps and ISO strings', () => {
  const d = new Date('2026-10-01T04:30:00Z');
  assert.equal(toDate(d), d);
  assert.equal(toDate(d.getTime()).getTime(), d.getTime());
  assert.equal(toDate('2026-10-01T04:30:00Z').getTime(), d.getTime());
  assert.equal(toDate('2026-10-01T10:00:00+05:30').getTime(), d.getTime());
});

test('toDate: Meta offsets without a colon parse as the same instant', () => {
  assert.equal(toDate('2026-10-01T10:00:00+0530').getTime(), Date.parse('2026-10-01T04:30:00Z'));
  assert.equal(toDate('2026-10-01T10:00:00-0400').getTime(), Date.parse('2026-10-01T14:00:00Z'));
});

test('istShift moves the instant by the IST offset', () => {
  const d = new Date('2026-08-31T20:00:00Z');
  assert.equal(istShift(d).getTime(), d.getTime() + IST_OFFSET_MS);
  assert.equal(istShift(null), null);
});

test('istDayKey / istMonth use the IST calendar, not UTC', () => {
  assert.equal(istDayKey('2026-08-31T19:00:00Z'), '2026-09-01');
  assert.equal(istDayKey('2026-08-31T18:29:59Z'), '2026-08-31');
  assert.equal(istMonth('2026-08-31T20:00:00Z'), '2026-09');
  assert.equal(istMonth('2026-08-31T18:00:00Z'), '2026-08');
  assert.equal(istDayKey(null), null);
  assert.equal(istMonth(''), null);
  assert.match(istDayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('istParts gives the IST hour and weekday', () => {
  // 2026-08-31 is a Monday. 19:00Z is 00:30 IST on Tuesday.
  assert.deepEqual(istParts('2026-08-31T19:00:00Z'), { hour: 0, weekday: 2 });
  assert.deepEqual(istParts('2026-08-31T04:00:00Z'), { hour: 9, weekday: 1 });
  assert.equal(istParts('nope'), null);
});

test('istDayStart is midnight IST and rejects anything but YYYY-MM-DD', () => {
  assert.equal(istDayStart('2026-09-01').toISOString(), '2026-08-31T18:30:00.000Z');
  assert.equal(istDayStart('2026-9-1'), null);
  assert.equal(istDayStart('2026-09-01T00:00'), null);
  assert.equal(istDayStart(''), null);
  assert.equal(istDayStart(undefined), null);
  assert.equal(istDayStart('2026-13-40'), null);
});
