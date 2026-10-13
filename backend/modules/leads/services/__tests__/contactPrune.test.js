const test = require('node:test');
const assert = require('node:assert/strict');

const { planPrune } = require('../contactPrune');

const listedAt = new Date('2026-10-13T21:30:00Z');
const row = (zohoId, createdAt = '2026-10-01T00:00:00Z') => ({ zohoId, createdAt });
const mirror = (n) => Array.from({ length: n }, (_, i) => row(String(i)));

test('rows missing from Bigin are deleted', () => {
  const biginIds = new Set(mirror(100).map((r) => r.zohoId).filter((id) => id !== '7'));
  assert.deepEqual(planPrune(mirror(100), biginIds, listedAt, { maxShare: 0.05 }), {
    missing: ['7'],
    refused: null,
  });
});

test('a row created after the listing started is kept', () => {
  const rows = [row('1'), row('2', '2026-10-13T21:31:00Z')];
  const { missing } = planPrune(rows, new Set(['1']), listedAt);
  assert.deepEqual(missing, []);
});

test('an empty Bigin listing deletes nothing', () => {
  const { refused } = planPrune(mirror(10), new Set(), listedAt);
  assert.match(refused, /no contacts/);
});

test('more than the safety share missing is refused unless forced', () => {
  const biginIds = new Set(mirror(100).map((r) => r.zohoId).slice(0, 90));
  assert.match(planPrune(mirror(100), biginIds, listedAt, { maxShare: 0.05 }).refused, /safety limit/);
  const forced = planPrune(mirror(100), biginIds, listedAt, { maxShare: 0.05, force: true });
  assert.equal(forced.refused, null);
  assert.equal(forced.missing.length, 10);
});
