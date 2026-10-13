// The custom `cp1` / `cp2` tracking params on a landing-page URL — shared by
// web-lead ingest and the backfill script (scripts/backfillCpParams.js), so a
// new lead and a backfilled one are read the same way.

const MAX = 300; // the ingest FIELDS cap

/**
 * `{ cp1, cp2 }` read off a landing URL's query string. A param that is absent
 * or blank is left out; an unparseable URL yields `{}` rather than throwing.
 */
function cpFromUrl(landingUrl) {
  if (!landingUrl || typeof landingUrl !== 'string') return {};
  let params;
  try {
    // The base only matters for a relative URL ("/lp?cp1=x"); an absolute one ignores it.
    params = new URL(landingUrl, 'https://focasedu.com').searchParams;
  } catch {
    return {};
  }
  const out = {};
  for (const key of ['cp1', 'cp2']) {
    const value = (params.get(key) || '').trim().slice(0, MAX);
    if (value) out[key] = value;
  }
  return out;
}

module.exports = { cpFromUrl };
