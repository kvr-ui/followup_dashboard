const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveWithIndex } = require('../adEntityResolver');
const { normalizeName } = require('../normalizeName');

// The index resolveWithIndex consumes, as buildIndex would assemble it:
// one campaign c1 with ad set s1 holding ads a1/a2, and ad set s2 (empty).
const idx = () => ({
  adsetById: new Map([
    ['120251849943400598', { campaignId: 'c1' }],
    ['222', { campaignId: 'c1' }],
  ]),
  adsetByName: new Map([
    ['Foundation Students 2809', '120251849943400598'],
  ]),
  adsetByNormalized: new Map([
    [normalizeName('Foundation Students 2809'), '120251849943400598'],
  ]),
  adById: new Map([
    ['901', { adsetId: '120251849943400598' }],
    ['902', { adsetId: '120251849943400598' }],
    ['903', { adsetId: '222' }],
  ]),
  adsByAdset: new Map([
    [
      '120251849943400598',
      [
        { id: '901', name: 'Foundation School Students Ad - Amritha', normalizedName: normalizeName('Foundation School Students Ad - Amritha') },
        { id: '902', name: 'Second Ad', normalizedName: normalizeName('Second Ad') },
      ],
    ],
    ['222', [{ id: '903', name: 'Second Ad', normalizedName: normalizeName('Second Ad') }]],
  ]),
});

test('utm_term that is an ad set id resolves by id — the hot path', () => {
  const r = resolveWithIndex(idx(), { utmTerm: ' 120251849943400598 ' });
  assert.deepEqual(r, { adsetId: '120251849943400598', adsetBy: 'id', adId: null, adBy: null });
});

test('utm_term that is an AD id resolves the ad outright, ad set from its parent', () => {
  const r = resolveWithIndex(idx(), { utmTerm: '901' });
  assert.deepEqual(r, { adsetId: '120251849943400598', adsetBy: 'ad-id', adId: '901', adBy: 'term' });
});

test('utm_term falls back to exact, then normalized, ad set name', () => {
  assert.equal(resolveWithIndex(idx(), { utmTerm: 'Foundation Students 2809' }).adsetBy, 'exact');
  const r = resolveWithIndex(idx(), { utmTerm: 'foundation-students-2809' });
  assert.equal(r.adsetId, '120251849943400598');
  assert.equal(r.adsetBy, 'normalized');
});

test('utm_content matches the ad by name WITHIN the resolved ad set only', () => {
  const r = resolveWithIndex(idx(), {
    utmTerm: '120251849943400598',
    utmContent: 'Foundation School Students Ad - Amritha',
  });
  assert.equal(r.adId, '901');
  assert.equal(r.adBy, 'exact');

  // "Second Ad" exists in two ad sets; the resolved ad set picks which one.
  assert.equal(resolveWithIndex(idx(), { utmTerm: '222', utmContent: 'Second Ad' }).adId, '903');

  // No ad set, no ad — a bare name is never matched across all ads.
  const bare = resolveWithIndex(idx(), { utmContent: 'Second Ad' });
  assert.deepEqual(bare, { adsetId: null, adsetBy: null, adId: null, adBy: null });
});

test('utm_content: ad id, then exact, then normalized', () => {
  assert.equal(resolveWithIndex(idx(), { utmTerm: '120251849943400598', utmContent: '902' }).adBy, 'id');
  assert.equal(
    resolveWithIndex(idx(), { utmTerm: '120251849943400598', utmContent: 'second_ad' }).adBy,
    'normalized'
  );
});

test('unresolvable values come back null, not thrown', () => {
  assert.deepEqual(resolveWithIndex(idx(), { utmTerm: '999999', utmContent: 'nope' }), {
    adsetId: null,
    adsetBy: null,
    adId: null,
    adBy: null,
  });
  assert.deepEqual(resolveWithIndex(idx(), {}), { adsetId: null, adsetBy: null, adId: null, adBy: null });
});
