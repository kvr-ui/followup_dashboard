// Guard tests for GET /api/leads-list — groupLeads() and selectRows().
//
//   node modules/leads/scripts/testLeadList.js     (from backend/)
//   npm test                                       (from backend/)
//
// Pure functions over plain fixtures: no database, no .env. A failure here is a
// rep seeing a colleague's lead, or one person showing up as three rows.

const assert = require('assert');
const { groupLeads, selectRows } = require('../services/leadList');

const REP_A = 'a@focasedu.com';
const REP_B = 'b@focasedu.com';
const REP_CALLS = 'calls@focasedu.com';

const PK_ALL = '9000000001'; // task (A) + web form + meta form + deal (B)
const PK_FRESH = '9000000002'; // web form only — nobody owns it
const PK_CALLED = '9000000003'; // meta form, claimed by a call from REP_CALLS
const PK_WON = '9000000004'; // deal only, won, owned by B
const PK_CALL_ONLY = '9000000005'; // a call and nothing else — not a lead

const SOURCES = {
  tasks: [
    {
      phoneKey: PK_ALL,
      phone: '+91 90000 00001',
      leadSource: 'web',
      receivedAt: new Date('2026-09-10T10:00:00Z'),
      body: [
        {
          Status: 'Open',
          Due_Date: '2026-09-20',
          Owner: { name: 'Rep A', email: REP_A },
          Who_Id: { name: 'Asha Patel' },
          Created_Time: '2026-09-01T15:30:00+05:30',
          Modified_Time: '2026-09-12T13:30:00+05:30',
        },
        { Status: 'Completed', Due_Date: '2026-09-02', Owner: { name: 'Rep A', email: REP_A } },
        { Status: 'Open', Due_Date: '2026-09-15', Owner: { name: 'Rep A', email: REP_A } },
      ],
    },
  ],
  webLeads: [
    { phoneKey: PK_ALL, name: 'Asha P', createdAt: new Date('2026-08-30T06:00:00Z'), utmCampaign: 'aug', resolvedCampaignId: 'c1' },
    { phoneKey: PK_FRESH, name: 'Fresh Lead', phone: '9000000002', createdAt: new Date('2026-09-18T06:00:00Z'), utmCampaign: 'sept-raw' },
  ],
  metaLeads: [
    { _id: 'm1', phoneKey: PK_ALL, createdTime: '2026-08-29T05:00:00+0000', campaignId: 'c1', fieldData: [] },
    {
      _id: 'm2',
      phoneKey: PK_CALLED,
      createdTime: '2026-09-05T05:00:00+0000',
      campaignId: 'c-unknown',
      fieldData: [{ name: 'full_name', values: ['Called Person'] }],
    },
  ],
  deals: [
    { contactPhoneKey: PK_ALL, ownerEmail: REP_B, ownerName: 'Rep B', outcome: 'open', modifiedTime: new Date('2026-09-11T00:00:00Z') },
    {
      contactPhoneKey: PK_WON,
      contactName: 'Winner',
      ownerEmail: REP_B,
      ownerName: 'Rep B',
      outcome: 'won',
      leadSourceKey: 'Meta Ads',
      modifiedTime: new Date('2026-09-14T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
    },
  ],
  calls: [
    { phoneKeys: [PK_CALLED], ownerEmail: REP_CALLS },
    { phoneKeys: [PK_CALL_ONLY], ownerEmail: REP_A },
  ],
  campaigns: [{ _id: 'c1', name: 'August Promo' }],
};

const ADMIN = { role: 'admin', ownerEmail: 'admin@focasedu.com' };
const rep = (email) => ({ role: 'sales', ownerEmail: email });

const ROWS = groupLeads(SOURCES);
const byKey = (rows, key) => rows.find((r) => r.phoneKey === key);
const keys = (res) => res.rows.map((r) => r.phoneKey).sort();

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

// ---- grouping --------------------------------------------------------------

check('one row per phoneKey; call-only numbers are not leads', () => {
  assert.deepStrictEqual(ROWS.map((r) => r.phoneKey).sort(), [PK_ALL, PK_FRESH, PK_CALLED, PK_WON].sort());
});

check('a merged row takes the task name, owner and the deal state', () => {
  const r = byKey(ROWS, PK_ALL);
  assert.strictEqual(r.name, 'Asha Patel');
  assert.strictEqual(r.ownerEmail, REP_A);
  assert.strictEqual(r.state, 'pipeline');
  assert.strictEqual(r.source, 'Web form');
  assert.deepStrictEqual(r.counts, { tasks: 1, forms: 2, deals: 1 });
});

check('next follow-up is the earliest OPEN due date', () => {
  assert.strictEqual(byKey(ROWS, PK_ALL).nextFollowUp, '2026-09-15');
  assert.strictEqual(byKey(ROWS, PK_FRESH).nextFollowUp, null);
});

check('created is the earliest record; last activity the newest', () => {
  const r = byKey(ROWS, PK_ALL);
  assert.strictEqual(new Date(r.createdAt).toISOString(), '2026-08-29T05:00:00.000Z');
  assert.strictEqual(new Date(r.lastActivity).toISOString(), '2026-09-12T08:00:00.000Z');
});

check('campaign resolves to the Meta campaign name, else the raw UTM / id', () => {
  assert.strictEqual(byKey(ROWS, PK_FRESH).campaign, 'sept-raw');
  assert.strictEqual(byKey(ROWS, PK_CALLED).campaign, 'c-unknown');
  assert.strictEqual(byKey(ROWS, PK_WON).campaign, null);
});

check('unassigned only when no task, deal or call owner exists', () => {
  assert.strictEqual(byKey(ROWS, PK_FRESH).unassigned, true);
  assert.strictEqual(byKey(ROWS, PK_CALLED).unassigned, false);
  assert.strictEqual(byKey(ROWS, PK_ALL).unassigned, false);
});

// ---- scope -----------------------------------------------------------------

check('admin sees every lead, with owner facets', () => {
  const res = selectRows(ROWS, {}, ADMIN);
  assert.strictEqual(res.total, 4);
  assert.ok(res.facets.owners.length >= 2);
});

check('a rep sees their own leads plus unassigned ones, never a colleague\'s', () => {
  assert.deepStrictEqual(keys(selectRows(ROWS, {}, rep(REP_A))), [PK_ALL, PK_FRESH].sort());
  assert.deepStrictEqual(keys(selectRows(ROWS, {}, rep(REP_B))), [PK_ALL, PK_FRESH, PK_WON].sort());
  assert.deepStrictEqual(keys(selectRows(ROWS, {}, rep(REP_CALLS))), [PK_CALLED, PK_FRESH].sort());
});

check('a rep with no ownerEmail sees only unassigned leads', () => {
  assert.deepStrictEqual(keys(selectRows(ROWS, {}, { role: 'sales', ownerEmail: '' })), [PK_FRESH]);
});

check('a rep cannot widen scope with ?owner=, and gets no owner facet', () => {
  const res = selectRows(ROWS, { owner: REP_B }, rep(REP_A));
  assert.deepStrictEqual(keys(res), [PK_ALL, PK_FRESH].sort());
  assert.deepStrictEqual(res.facets.owners, []);
});

check('internal owner sets never leave the service', () => {
  selectRows(ROWS, {}, ADMIN).rows.forEach((r) => assert.ok(!('_owners' in r)));
});

// ---- filters, sort, page ---------------------------------------------------

check('filters: status, source, owner, unassigned', () => {
  assert.deepStrictEqual(keys(selectRows(ROWS, { status: 'won' }, ADMIN)), [PK_WON]);
  assert.deepStrictEqual(keys(selectRows(ROWS, { source: 'Meta Ads' }, ADMIN)), [PK_WON]);
  assert.deepStrictEqual(keys(selectRows(ROWS, { owner: REP_CALLS }, ADMIN)), [PK_CALLED]);
  assert.deepStrictEqual(keys(selectRows(ROWS, { unassigned: '1' }, ADMIN)), [PK_FRESH]);
});

check('search matches name or phone digits', () => {
  assert.deepStrictEqual(keys(selectRows(ROWS, { q: 'asha' }, ADMIN)), [PK_ALL]);
  assert.deepStrictEqual(keys(selectRows(ROWS, { q: '00002' }, ADMIN)), [PK_FRESH]);
});

check('created date range is inclusive, in IST days', () => {
  assert.deepStrictEqual(keys(selectRows(ROWS, { from: '2026-09-05', to: '2026-09-18' }, ADMIN)), [PK_CALLED, PK_FRESH].sort());
});

check('sorts by next follow-up with blanks last, and pages', () => {
  const res = selectRows(ROWS, { sort: 'nextFollowUp', limit: '2', page: '1' }, ADMIN);
  assert.strictEqual(res.rows[0].phoneKey, PK_ALL);
  assert.strictEqual(res.rows.length, 2);
  assert.strictEqual(res.total, 4);
  assert.strictEqual(selectRows(ROWS, { limit: '2', page: '3' }, ADMIN).rows.length, 0);
});

check('default sort is newest activity first', () => {
  const res = selectRows(ROWS, {}, ADMIN);
  assert.strictEqual(res.rows[0].phoneKey, PK_FRESH);
});

if (failures.length) {
  console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}\n`));
  process.exit(1);
}
console.log(`${passed} lead-list tests passed.`);
