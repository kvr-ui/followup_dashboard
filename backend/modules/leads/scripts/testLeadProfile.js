// Guard tests for GET /api/lead-profile/:phoneKey — buildLeadProfile() and the
// leadState() helper it (and the Ad Leads tab) both call.
//
//   node modules/leads/scripts/testLeadProfile.js     (from backend/)
//   npm test                                          (from backend/)
//
// No database, no test framework, and NO .env: every Mongoose model
// (Task/WebLead/MetaLead/Deal/Call) has its `find` statics monkey-patched to
// read from the small fixtures below, and the VSL / acquisition services are
// monkey-patched the same way, all BEFORE leadProfile.js (or the taskController
// it uses for latestTask) is first required — so every module that later does
// `require('.../acquisitionView')` etc. gets the very same, already-patched
// exports object back out of Node's module cache.
//
// A failure here is a rep seeing another rep's ad spend, or a lead drawer that
// 404s when the data was just slow — so these are worth running every time.

const assert = require('assert');

// ---------------------------------------------------------------------------
// Fixture phone keys
// ---------------------------------------------------------------------------

const PK_FULL = '9000000001'; // everything: task, forms, deal, call
const PK_VSL_FAIL = '9000000099'; // a deal only; VSL service throws for this key
const PK_TASK_FAILS = '9000000077'; // Task.find rejects; nothing else matches
const PK_UNKNOWN = '9999999999'; // matches nothing anywhere

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const TASK_OWNER_EMAIL = 'owner@focasedu.com';
const DEAL_OWNER_EMAIL = 'dealowner@focasedu.com';
const CALL_OWNER_EMAIL = 'calls-owner@focasedu.com';
const REP_WITH_NOTHING = 'nobody@focasedu.com';

const TASKS = [
  {
    _id: 't1',
    dedupeKey: 'dk-t1',
    zohoId: 'zoho-t1',
    phoneKey: PK_FULL,
    phone: '+91-9000000001',
    receivedAt: new Date('2026-09-01T10:00:00Z'),
    createdAt: new Date('2026-09-01T09:00:00Z'),
    updatedAt: new Date('2026-09-05T09:00:00Z'),
    taskCategory: 'followup',
    taskCategorySource: 'system',
    leadSource: 'web',
    linkedLeadId: null,
    body: {
      Subject: 'Call back tomorrow',
      Status: 'Open',
      Owner: { name: 'Owner Rep', email: TASK_OWNER_EMAIL },
      Who_Id: { name: 'Asha Patel' },
      Created_By: { name: 'System' },
    },
    statusHistory: [
      { status: 'Open', changedAt: new Date('2026-09-02T08:00:00Z'), source: 'dashboard', by: TASK_OWNER_EMAIL },
    ],
    notes: [{ text: 'Asked for a brochure', author: TASK_OWNER_EMAIL, createdAt: new Date('2026-09-03T08:00:00Z') }],
    whatsappLog: [{ template: 'welcome', ok: true, sentAt: new Date('2026-09-01T11:00:00Z'), sentBy: 'system' }],
    taskHistory: [],
  },
];

const WEB_LEADS = [
  {
    _id: 'w1',
    phoneKey: PK_FULL,
    createdAt: new Date('2026-08-30T06:00:00Z'),
    name: 'Asha Patel',
    phone: '9000000001',
    source: 'landing-page',
    utmCampaign: 'aug-promo',
  },
];

const META_LEADS = [
  {
    _id: 'm1',
    phoneKey: PK_FULL,
    createdTime: '2026-08-29T05:00:00+0000',
    formId: 'form123',
    fieldData: [],
  },
];

const DEALS = [
  {
    _id: 'd1',
    contactPhoneKey: PK_FULL,
    contactName: 'Asha Patel',
    ownerEmail: DEAL_OWNER_EMAIL,
    ownerName: 'Deal Owner',
    outcome: 'open',
    stage: 'Proposal',
    modifiedTime: new Date('2026-09-04T12:00:00Z'),
    amount: 0,
  },
  {
    _id: 'd2',
    contactPhoneKey: PK_VSL_FAIL,
    contactName: 'Ravi Kumar',
    ownerEmail: 'someoneelse@focasedu.com',
    outcome: 'won',
    stage: 'Closed Won',
    modifiedTime: new Date('2026-09-06T12:00:00Z'),
    amount: 50000,
  },
];

const CALLS = [
  {
    _id: 'c1',
    phoneKeys: [PK_FULL],
    ownerEmail: CALL_OWNER_EMAIL,
    leadName: 'Asha Patel',
    leadPhone: '9000000001',
    direction: 'outbound',
    duration: 125,
    startedAt: new Date('2026-09-04T15:00:00Z'),
    createdAt: new Date('2026-09-04T15:00:00Z'),
    grade: { score: 8 },
  },
];

// ---------------------------------------------------------------------------
// Model stubs — monkey-patch the statics buildLeadProfile actually calls.
// ---------------------------------------------------------------------------

/** A fake query supporting the same `.sort().lean()` / `.lean()` chains the
 * real code uses, backed by a plain array (or a rejection, for the 503 case). */
function fakeQuery(rowsOrError) {
  let rows = rowsOrError instanceof Error ? null : rowsOrError;
  const err = rowsOrError instanceof Error ? rowsOrError : null;
  return {
    sort(spec) {
      if (err) return this;
      const [[field, dir]] = Object.entries(spec);
      rows = rows.slice().sort((a, b) => {
        const av = a[field] ? new Date(a[field]).getTime() : 0;
        const bv = b[field] ? new Date(b[field]).getTime() : 0;
        return dir === -1 ? bv - av : av - bv;
      });
      return this;
    },
    lean() {
      return err ? Promise.reject(err) : Promise.resolve(rows);
    },
  };
}

const Task = require('../../../models/Task');
const WebLead = require('../../ads/models/WebLead');
const MetaLead = require('../../ads/models/MetaLead');
const Deal = require('../../calls/models/Deal');
const Call = require('../../calls/models/Call');

Task.find = (filter) => {
  const key = filter && filter.phoneKey;
  if (key === PK_TASK_FAILS) return fakeQuery(new Error('tasks collection unreachable'));
  return fakeQuery(TASKS.filter((t) => t.phoneKey === key));
};
WebLead.find = (filter) => fakeQuery(WEB_LEADS.filter((w) => w.phoneKey === (filter && filter.phoneKey)));
MetaLead.find = (filter) => fakeQuery(META_LEADS.filter((m) => m.phoneKey === (filter && filter.phoneKey)));
Deal.find = (filter) => fakeQuery(DEALS.filter((d) => d.contactPhoneKey === (filter && filter.contactPhoneKey)));
Call.find = (filter) =>
  fakeQuery(CALLS.filter((c) => Array.isArray(c.phoneKeys) && c.phoneKeys.includes(filter && filter.phoneKeys)));

// ---------------------------------------------------------------------------
// Service stubs — VSL watch block and ad-lead acquisition block.
// ---------------------------------------------------------------------------

const vslView = require('../../vsl/services/vslView');
const acquisitionView = require('../../ads/services/acquisitionView');

const VSL_THROWS_FOR = new Set([PK_VSL_FAIL]);

vslView.buildVslBlock = async (arg) => {
  const pk = arg && arg.phoneKey;
  if (VSL_THROWS_FOR.has(pk)) throw new Error('VSL cluster timed out');
  if (pk !== PK_FULL) return null;
  return { leadId: 'vsl-1', watch: { seconds: 90 }, engagement: 'watched' };
};

acquisitionView.buildAcquisition = async (source, options) => {
  if (!source) return null;
  const includeCost = Boolean(options && options.includeCost);
  const block = {
    source: 'web',
    leadId: 'lead-x',
    formLabel: 'landing-page',
    campaign: null,
    utm: { source: null, medium: null, campaign: null, content: null, term: null },
    qualification: { caStatus: null, attempt: null, language: null, city: null, state: null },
  };
  if (includeCost) block.cost = { estimated: 499, basis: 'campaign-month-apportionment' };
  return block;
};

// Everything above must be patched before this first require, since
// leadProfile.js (and, transitively, taskController.js) destructure these
// exports at require time.
const { buildLeadProfile } = require('../services/leadProfile');
const { leadState } = require('../../ads/services/leadState');

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const ADMIN = { role: 'admin', ownerEmail: 'admin@focasedu.com' };
const REP_TASK_OWNER = { role: 'sales', ownerEmail: TASK_OWNER_EMAIL };
const REP_CALL_OWNER = { role: 'sales', ownerEmail: CALL_OWNER_EMAIL };
const REP_NOTHING = { role: 'sales', ownerEmail: REP_WITH_NOTHING };

// ---------------------------------------------------------------------------
// Tiny async test runner, in the repo's check()-with-a-failures-list style.
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
const tests = [];

/** Registers a (possibly async) case; nothing runs until run() below. */
function check(name, fn) {
  tests.push({ name, fn });
}

/** Silences console.warn/error for the duration of an expected-failure case,
 * so a 404/403/503 test doesn't spam [lead-profile] warnings into the report. */
async function quietly(fn) {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
    } catch (err) {
      failures.push(`${name}\n    ${err.stack || err.message}`);
    }
  }

  if (failures.length) {
    console.error(`\n${failures.length} FAILED, ${passed} passed\n`);
    failures.forEach((f) => console.error(`  ✗ ${f}\n`));
    process.exit(1);
  }
  console.log(`${passed} lead-profile tests passed.`);
}

// ---------------------------------------------------------------------------
// 1 & 2 — cost key: present for admins, absent (not null) for reps
// ---------------------------------------------------------------------------

check('admin payload has acquisition.cost', async () => {
  const { status, body } = await buildLeadProfile(PK_FULL, ADMIN);
  assert.strictEqual(status, 200);
  assert.ok(body.data.acquisition, 'expected an acquisition block');
  assert.ok('cost' in body.data.acquisition, 'admin acquisition is missing cost');
  assert.ok(body.data.latestTask.acquisition, 'expected latestTask.acquisition');
  assert.ok('cost' in body.data.latestTask.acquisition, 'admin latestTask.acquisition is missing cost');
});

check('rep payload has no cost key anywhere in acquisition', async () => {
  const { status, body } = await buildLeadProfile(PK_FULL, REP_TASK_OWNER);
  assert.strictEqual(status, 200);
  assert.ok(body.data.acquisition, 'expected an acquisition block');
  assert.ok(!('cost' in body.data.acquisition), 'rep acquisition leaked a cost key');
  assert.ok(body.data.latestTask.acquisition, 'expected latestTask.acquisition');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(body.data.latestTask.acquisition, 'cost'),
    'rep latestTask.acquisition leaked a cost key'
  );
});

// ---------------------------------------------------------------------------
// 3 — a rep who owns only a Call still gets the full profile
// ---------------------------------------------------------------------------

check('a rep who owns only a Call gets the full profile, including colleagues\' deals', async () => {
  const { status, body } = await buildLeadProfile(PK_FULL, REP_CALL_OWNER);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.data.deals.length, 1);
  assert.strictEqual(body.data.deals[0].ownerEmail, DEAL_OWNER_EMAIL);
  assert.strictEqual(body.data.calls.length, 1);
  assert.ok(body.data.latestTask, 'expected the (unowned) task to still be included');
});

// ---------------------------------------------------------------------------
// 4 — a rep who owns nothing on the key gets 403
// ---------------------------------------------------------------------------

check('a rep who owns no Task, Deal or Call gets 403', async () => {
  const { status, body } = await quietly(() => buildLeadProfile(PK_FULL, REP_NOTHING));
  assert.strictEqual(status, 403);
  assert.strictEqual(body.success, false);
});

// ---------------------------------------------------------------------------
// 5 — unknown phoneKey gets 404
// ---------------------------------------------------------------------------

check('an unknown phoneKey gets 404', async () => {
  const { status, body } = await quietly(() => buildLeadProfile(PK_UNKNOWN, ADMIN));
  assert.strictEqual(status, 404);
  assert.strictEqual(body.success, false);
});

// ---------------------------------------------------------------------------
// 6 — a bad phoneKey gets 400
// ---------------------------------------------------------------------------

for (const bad of ['123', '12345678901', 'abcde12345', '', '900000000a']) {
  check(`a bad phoneKey (${JSON.stringify(bad)}) gets 400`, async () => {
    const { status } = await buildLeadProfile(bad, ADMIN);
    assert.strictEqual(status, 400);
  });
}

// ---------------------------------------------------------------------------
// 7 — the timeline is newest-first and covers every event type present
// ---------------------------------------------------------------------------

check('the timeline is sorted newest first and covers every event type present', async () => {
  const { status, body } = await buildLeadProfile(PK_FULL, ADMIN);
  assert.strictEqual(status, 200);
  const timeline = body.data.timeline;
  assert.ok(timeline.length >= 7, `expected at least 7 timeline entries, got ${timeline.length}`);

  for (let i = 1; i < timeline.length; i += 1) {
    const prev = new Date(timeline[i - 1].at).getTime();
    const cur = new Date(timeline[i].at).getTime();
    assert.ok(prev >= cur, `timeline is not newest-first at index ${i}`);
  }

  const expectedTypes = ['form', 'task', 'status', 'note', 'whatsapp', 'call', 'deal'];
  const seenTypes = new Set(timeline.map((e) => e.type));
  for (const type of expectedTypes) {
    assert.ok(seenTypes.has(type), `no timeline entry of type "${type}"`);
  }
});

// ---------------------------------------------------------------------------
// 8 — a failing data source degrades gracefully instead of failing the request
// ---------------------------------------------------------------------------

check('a VSL failure still returns 200 with the other sections filled and vsl: null', async () => {
  const { status, body } = await quietly(() => buildLeadProfile(PK_VSL_FAIL, ADMIN));
  assert.strictEqual(status, 200);
  assert.strictEqual(body.data.vsl, null);
  assert.strictEqual(body.data.deals.length, 1);
  assert.strictEqual(body.data.deals[0].outcome, 'won');
});

// Bonus: task 1's own documented rule — a would-be 404 becomes a 503 when a
// source that could have held the answer actually failed rather than came back
// empty. Not one of the 9 required cases, but cheap to check and explicitly
// called out as current, intended behaviour.
check('a failed source that would otherwise 404 returns 503 instead', async () => {
  const { status, body } = await quietly(() => buildLeadProfile(PK_TASK_FAILS, ADMIN));
  assert.strictEqual(status, 503);
  assert.strictEqual(body.success, false);
});

// ---------------------------------------------------------------------------
// 9 — leadState() matches the pre-extraction ads/routes logic exactly
// ---------------------------------------------------------------------------

check('leadState: a won deal wins regardless of the task', () => {
  assert.strictEqual(leadState({ body: { Status: 'Open' } }, { outcome: 'won' }), 'won');
  assert.strictEqual(leadState(null, { outcome: 'won' }), 'won');
});

check('leadState: a lost deal is lost regardless of the task', () => {
  assert.strictEqual(leadState({ body: { Status: 'Open' } }, { outcome: 'lost' }), 'lost');
  assert.strictEqual(leadState(null, { outcome: 'lost' }), 'lost');
});

check('leadState: any other deal outcome is pipeline', () => {
  assert.strictEqual(leadState(null, { outcome: 'open' }), 'pipeline');
  assert.strictEqual(leadState({ body: { Status: 'Open' } }, { outcome: 'open' }), 'pipeline');
});

check('leadState: a task with no deal is followup', () => {
  assert.strictEqual(leadState({ body: { Status: 'Open' } }, null), 'followup');
});

check('leadState: neither a task nor a deal is none', () => {
  assert.strictEqual(leadState(null, null), 'none');
});

run();
