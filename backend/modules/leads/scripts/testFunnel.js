// Guard tests for GET /api/leads-list/funnel — selectFunnel() and friends.
//
//   node modules/leads/scripts/testFunnel.js       (from backend/)
//   npm test                                       (from backend/)
//
// Pure functions over plain fixtures: no database, no .env. A failure here is
// the dashboard's MQL/SQL numbers drifting from the Bigin report.

const assert = require('assert');
const { selectFunnel, funnelSourceName, istMonth } = require('../services/funnel');
const { fromBiginRecord, normalizeContactPayload } = require('../services/contactStore');

const REP_A = 'a@focasedu.com';
const REP_B = 'b@focasedu.com';
const ADMIN = { role: 'admin', ownerEmail: 'admin@focasedu.com' };
const rep = (email) => ({ role: 'sales', ownerEmail: email });
const NOW = new Date('2026-09-25T06:00:00Z');

const contact = (zohoId, createdTime, leadSource, phoneKey, ownerEmail = null) => ({
  zohoId,
  createdTime: new Date(createdTime),
  leadSource,
  phoneKeys: phoneKey ? [phoneKey] : [],
  ownerEmail,
  ownerName: ownerEmail,
});

const SRC = {
  contacts: [
    contact('c1', '2026-09-02T05:00:00Z', 'WhatsApp', '9000000001', REP_A), // 45s call in Sep -> SQL
    contact('c2', '2026-09-03T05:00:00Z', 'whatsapp', '9000000002', REP_A), // 30s call -> not SQL
    contact('c3', '2026-08-31T20:00:00Z', 'ig', '9000000003', REP_B), // 1 Sep IST; call in Sep -> SQL
    contact('c4', '2026-08-10T05:00:00Z', 'Instagram', '9000000004', REP_B), // call only in Sep -> NOT SQL (same-month rule)
    contact('c5', '2026-08-12T05:00:00Z', '', '9000000005'), // Not set, unowned, call in Aug -> SQL
    contact('c6', '2026-07-05T05:00:00Z', 'Student Registration', '9000000006'), // won deal by id
    contact('c7', '2026-01-05T05:00:00Z', 'WhatsApp', '9000000007'), // outside a 4-month window
    contact('c8', '2026-09-05T05:00:00Z', 'Facebook', null, REP_A), // no phone -> MQL only
  ],
  calls: [
    { biginContactId: 'c1', biginDurationSec: 45, startedAt: new Date('2026-09-02T06:00:00Z') },
    { biginContactId: 'c2', biginDurationSec: 30, startedAt: new Date('2026-09-03T06:00:00Z') },
    { biginContactId: 'c3', biginDurationSec: 200, startedAt: new Date('2026-09-01T04:00:00Z') },
    { biginContactId: 'c4', biginDurationSec: 300, startedAt: new Date('2026-09-01T04:00:00Z') },
    { biginContactId: 'c5', biginDurationSec: 31, startedAt: new Date('2026-08-20T04:00:00Z') },
    // Matched on the contact id, never the phone: same number, no contact id.
    { phoneKeys: ['9000000002'], biginDurationSec: 500, startedAt: new Date('2026-09-03T07:00:00Z') },
    // Our TeleCMI duration says 90s, Bigin says 20s: Bigin wins.
    { biginContactId: 'c8', duration: 90, biginDurationSec: 20, startedAt: new Date('2026-09-05T07:00:00Z') },
  ],
  wonDeals: [{ contactId: 'c6' }, { contactPhoneKey: '9000000001' }],
};

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}\n    ${err.stack || err.message}`);
  }
}

const res = selectFunnel(SRC, {}, ADMIN, NOW);
const row = (r, source) => r.sources.find((s) => s.source === source);

check('window: last 3 IST months by default, oldest first', () => {
  assert.deepStrictEqual(res.months, ['2026-07', '2026-08', '2026-09']);
  assert.strictEqual(selectFunnel(SRC, { months: '12' }, ADMIN, NOW).months.length, 12);
  assert.strictEqual(selectFunnel(SRC, { months: '7' }, ADMIN, NOW).months.length, 3);
});

check('MQL month is the IST created month', () => {
  assert.strictEqual(istMonth('2026-08-31T20:00:00Z'), '2026-09');
  assert.strictEqual(row(res, 'Instagram').byMonth['2026-09'].mql, 1);
});

check('SQL needs a Bigin call on the contact, strictly over 30s, in the SAME month', () => {
  assert.deepStrictEqual(res.byMonth['2026-09'], { mql: 4, sql: 2, closed: 1 });
  assert.deepStrictEqual(res.byMonth['2026-08'], { mql: 2, sql: 1, closed: 0 });
});

check('closed: won deal by contact id or phone, any time', () => {
  assert.deepStrictEqual(res.byMonth['2026-07'], { mql: 1, sql: 0, closed: 1 });
  assert.deepStrictEqual(res.total, { mql: 7, sql: 3, closed: 2 });
});

check('sources merge case/short forms; Not set last', () => {
  assert.strictEqual(row(res, 'WhatsApp').total.mql, 2);
  assert.strictEqual(row(res, 'Instagram').total.mql, 2);
  assert.strictEqual(res.sources[res.sources.length - 1].source, 'Not set');
  assert.strictEqual(funnelSourceName(' fb '), 'Facebook');
  assert.strictEqual(funnelSourceName('Whatsapp Dms'), 'WhatsApp DMs');
  assert.strictEqual(funnelSourceName('CA GURU'), 'CA Guru');
  assert.strictEqual(funnelSourceName('mentor_session'), 'Mentor Session');
  assert.strictEqual(funnelSourceName('old Kit student'), 'Old Kit Student');
  assert.strictEqual(funnelSourceName('SAYL'), 'SAYL');
});

check('a rep counts their own contacts plus unowned ones', () => {
  const r = selectFunnel(SRC, {}, rep(REP_A), NOW);
  assert.strictEqual(r.total.mql, 5); // c1, c2, c8 (A) + c5, c6 (unowned)
  assert.deepStrictEqual(r.facets.owners, []);
});

check('admin owner / unassigned filters', () => {
  assert.strictEqual(selectFunnel(SRC, { owner: REP_B }, ADMIN, NOW).total.mql, 2);
  assert.strictEqual(selectFunnel(SRC, { unassigned: '1' }, ADMIN, NOW).total.mql, 2);
  assert.strictEqual(res.facets.owners.length, 2);
});

check('contact record -> mirror fields', () => {
  const f = fromBiginRecord({
    id: 123,
    Full_Name: 'Asha',
    Phone: '+91 90000 00001',
    Mobile: '09000000001',
    Lead_Source1: 'ig',
    Owner: { name: 'Rep A', email: 'A@focasedu.com' },
    Created_Time: '2026-09-01T10:00:00+05:30',
  });
  assert.strictEqual(f.zohoId, '123');
  assert.deepStrictEqual(f.phoneKeys, ['9000000001']);
  assert.strictEqual(f.ownerEmail, REP_A);
  assert.strictEqual(f.createdTime.toISOString(), '2026-09-01T04:30:00.000Z');
});

check('webhook payload: id under common names, else rejected', () => {
  assert.strictEqual(normalizeContactPayload({ contact_id: '9' }).id, '9');
  assert.strictEqual(normalizeContactPayload({ id: 5, lead_source: 'fb' }).Lead_Source1, 'fb');
  assert.strictEqual(normalizeContactPayload({ name: 'x' }), null);
});

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
}
console.log(`${passed} funnel tests passed.`);
