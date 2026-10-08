// Rep Lifecycle — what happens between a lead arriving and its first call, for
// one rep's leads, split by how the lead ended up (won / lost / junk / open).
// The question it answers: what does a rep do before the first call on the
// leads they go on to close with a sale, and what do they do on the ones they lose?
//
// WHICH LEADS
// -----------
// Bigin contacts the rep owns, plus any contact whose WON deal the rep owns (a
// sale they closed on a lead that sits under someone else). Picked by LEAD-IN
// date (a cohort): the outcome is whatever the deal says today, so a lead from
// last week with no decision yet shows as Open rather than vanishing.
//
// LEAD-IN TIME
// ------------
// The earliest form fill (WebLead / MetaLead) for the contact's phone in the
// week before Bigin created it, else Bigin's createdTime. The week's cap
// stops someone who enquired a year ago from looking like a year-slow first call.
//
// FIRST CALL
// ----------
// Every call on the lead counts, whoever made it, and the rep who made the
// first dial is recorded. A dial is any call that is not inbound. A connect is
// any call with talk time (TeleCMI or Bigin duration). A TeleCMI row and its
// Bigin twin for the same call are collapsed into one, so they don't count as
// two attempts.
//
// Test phones and the office DID never join (utils/phone).

const Contact = require('../../leads/models/Contact');
const WebLead = require('../../ads/models/WebLead');
const MetaLead = require('../../ads/models/MetaLead');
const Deal = require('../models/Deal');
const Call = require('../models/Call');
const Task = require('../../../models/Task');
const { isJunkReason } = require('../../leads/services/funnel');
const { DEAL_FIELDS, bestDeal } = require('../../ads/services/dealJoin');
const { nextDay } = require('../../ads/services/adMetrics');
const { PLACEHOLDER_PHONES, OFFICE_DID } = require('../../../utils/phone');

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;
const FORM_LOOKBACK_MS = 7 * DAY_MS;
// A TeleCMI row and its Bigin twin start within seconds of each other.
const TWIN_WINDOW_MS = 90 * 1000;
const IST_OFFSET_MS = 330 * MIN_MS;

const OUTCOMES = ['won', 'lost', 'junk', 'open'];

const SPEED_BUCKETS = [
  { key: 'lt5m', label: 'Under 5 min', max: 5 },
  { key: '5to30m', label: '5–30 min', max: 30 },
  { key: '30mto2h', label: '30 min – 2 hr', max: 120 },
  { key: '2to24h', label: '2–24 hr', max: 24 * 60 },
  { key: 'gt24h', label: 'Over 24 hr', max: Infinity },
  { key: 'never', label: 'Never called' },
];

// IST hour ranges, [from, to).
const SLOTS = [
  { key: 'night', label: 'Night (12–8 am)', from: 0, to: 8 },
  { key: 'morning', label: 'Morning (8 am–12 pm)', from: 8, to: 12 },
  { key: 'afternoon', label: 'Afternoon (12–4 pm)', from: 12, to: 16 },
  { key: 'evening', label: 'Evening (4–8 pm)', from: 16, to: 20 },
  { key: 'late', label: 'Late (8 pm–12 am)', from: 20, to: 24 },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ATTEMPT_BUCKETS = [
  { key: '1', label: 'First dial' },
  { key: '2', label: '2nd dial' },
  { key: '3', label: '3rd dial' },
  { key: '4-5', label: '4–5 dials' },
  { key: '6+', label: '6+ dials' },
  { key: 'calledIn', label: 'Lead called in' },
  { key: 'never', label: 'Never connected' },
];

const lower = (v) => (v ? String(v).trim().toLowerCase() : '');

/** Meta's createdTime is '2026-10-01T10:00:00+0530'; give the offset its colon. */
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(String(value).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? null : d;
}

const isTestKey = (k) => PLACEHOLDER_PHONES.has(k) || k === OFFICE_DID;

function istParts(date) {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return { hour: d.getUTCHours(), weekday: d.getUTCDay() };
}

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function outcomeOf(deal) {
  if (!deal) return 'open';
  if (deal.outcome === 'won') return 'won';
  if (deal.outcome === 'lost') return isJunkReason(deal.lostReason) ? 'junk' : 'lost';
  return 'open';
}

function speedBucket(mins) {
  if (mins == null) return 'never';
  return SPEED_BUCKETS.find((b) => b.max != null && mins < b.max).key;
}

function slotOf(hour) {
  return SLOTS.find((s) => hour >= s.from && hour < s.to).key;
}

function attemptBucket(lead) {
  if (!lead.firstConnectAt) return 'never';
  if (lead.connectedBy === 'callIn') return 'calledIn';
  const n = lead.attempts;
  if (n <= 3) return String(n);
  return n <= 5 ? '4-5' : '6+';
}

/** Collapse a TeleCMI row and its Bigin twin into one call. Input sorted by time. */
function dedupeTwins(calls) {
  const kept = [];
  for (const call of calls) {
    const prev = kept[kept.length - 1];
    const sameDir =
      prev &&
      (prev.direction === call.direction || prev.direction === 'unknown' || call.direction === 'unknown');
    if (prev && sameDir && call.at - prev.at <= TWIN_WINDOW_MS) {
      prev.talkSec = Math.max(prev.talkSec, call.talkSec);
      if (prev.direction === 'unknown') prev.direction = call.direction;
      if (!prev.by) prev.by = call.by;
      continue;
    }
    kept.push({ ...call });
  }
  return kept;
}

/**
 * One lead's pre-call facts. No DB.
 *
 * @param {object} p
 * @param {object} p.contact   BiginContact
 * @param {Date[]} p.formTimes form-fill times for the contact's phones
 * @param {object[]} p.calls   raw Call docs for the contact (any order)
 * @param {object|null} p.deal best deal for the contact
 * @param {object[]} p.whatsapp whatsappLog entries for the contact's phones
 */
function analyseLead({ contact, formTimes, calls, deal, whatsapp }) {
  const created = toDate(contact.createdTime);
  const forms = formTimes
    .filter((t) => t && (!created || (t <= created && created - t <= FORM_LOOKBACK_MS)))
    .sort((a, b) => a - b);
  const leadInAt = forms[0] || created;
  if (!leadInAt) return null;
  const leadInSource = forms[0] ? 'form' : 'bigin';

  const timeline = dedupeTwins(
    calls
      .map((c) => ({
        at: toDate(c.startedAt),
        direction: c.direction || 'unknown',
        talkSec: Math.max(Number(c.duration) || 0, Number(c.biginDurationSec) || 0),
        by: lower(c.ownerEmail) || null,
      }))
      .filter((c) => c.at && c.at >= leadInAt)
      .sort((a, b) => a.at - b.at)
  );

  const firstDial = timeline.find((c) => c.direction !== 'inbound') || null;
  const connectIdx = timeline.findIndex((c) => c.talkSec > 0);
  const connect = connectIdx >= 0 ? timeline[connectIdx] : null;
  const dialsBefore = timeline.slice(0, connectIdx >= 0 ? connectIdx : timeline.length).filter(
    (c) => c.direction !== 'inbound'
  ).length;

  let connectedBy = null;
  let attempts = dialsBefore;
  if (connect) {
    connectedBy = connect.direction === 'inbound' ? 'callIn' : 'dial';
    if (connectedBy === 'dial') attempts += 1;
  }

  const waFirst = whatsapp
    .map((m) => ({ ...m, at: toDate(m.sentAt) }))
    .filter((m) => m.ok && m.at && m.at >= leadInAt && (!firstDial || m.at < firstDial.at))
    .sort((a, b) => a.at - b.at)[0];

  const mins = (t) => (t ? Math.round(((t - leadInAt) / MIN_MS) * 10) / 10 : null);
  const { hour, weekday } = istParts(leadInAt);
  const keys = (contact.phoneKeys || []).filter((k) => !isTestKey(k));

  return {
    contactId: String(contact.zohoId),
    name: contact.name || null,
    phoneKey: keys[0] || null,
    owner: lower(contact.ownerEmail) || null,
    leadInAt,
    leadInSource,
    hour,
    weekday,
    firstDialAt: firstDial ? firstDial.at : null,
    minsToDial: mins(firstDial && firstDial.at),
    firstCallBy: firstDial ? firstDial.by : null,
    firstConnectAt: connect ? connect.at : null,
    minsToConnect: mins(connect && connect.at),
    connectedBy,
    attempts,
    totalCalls: timeline.length,
    whatsappFirst: waFirst ? waFirst.template || 'unknown' : null,
    outcome: outcomeOf(deal),
    stage: deal ? deal.stage || null : null,
    lostReason: deal ? deal.lostReason || null : null,
    amount: deal && deal.outcome === 'won' ? Number(deal.amount) || 0 : 0,
  };
}

const emptyRow = (key, label) => ({ key, label, leads: 0, won: 0, lost: 0, junk: 0, open: 0, revenue: 0 });

function tally(rows, key, lead) {
  const row = rows.get(key);
  if (!row) return;
  row.leads += 1;
  row[lead.outcome] += 1;
  row.revenue += lead.amount;
}

const finish = (rows) =>
  [...rows.values()].map((r) => ({ ...r, winPct: pct(r.won, r.leads) }));

function summarise(leads, rep) {
  const dialled = leads.filter((l) => l.firstDialAt);
  return {
    leads: leads.length,
    revenue: leads.reduce((s, l) => s + l.amount, 0),
    medianMinsToDial: median(dialled.map((l) => l.minsToDial)),
    medianMinsToConnect: median(leads.map((l) => l.minsToConnect)),
    medianAttempts: median(leads.filter((l) => l.connectedBy === 'dial').map((l) => l.attempts)),
    neverCalledPct: pct(leads.length - dialled.length, leads.length),
    whatsappFirstPct: pct(leads.filter((l) => l.whatsappFirst).length, leads.length),
    firstCallByOtherPct: pct(dialled.filter((l) => l.firstCallBy && l.firstCallBy !== rep).length, dialled.length),
  };
}

/**
 * The pure roll-up: contacts + forms + calls + deals + WhatsApp in, lifecycle out.
 *
 * @param {object} input
 * @param {string} input.ownerEmail  the rep
 * @param {Date} input.after         lead-in window start (inclusive)
 * @param {Date} input.before        lead-in window end (exclusive)
 * @param {object[]} input.contacts  BiginContact {zohoId, name, phoneKeys, ownerEmail, createdTime}
 * @param {object[]} input.forms     {phoneKey, at} form fills (WebLead createdAt / MetaLead createdTime)
 * @param {object[]} input.calls     Call {startedAt, direction, duration, biginDurationSec, ownerEmail, phoneKeys, biginContactId}
 * @param {object[]} input.deals     Deal (DEAL_FIELDS)
 * @param {object[]} input.tasks     Task {phoneKey, whatsappLog}
 */
function rollUpLifecycle(input) {
  const rep = lower(input.ownerEmail);
  const push = (map, key, v) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(v);
  };

  const formsByKey = new Map();
  for (const f of input.forms) push(formsByKey, f.phoneKey, toDate(f.at));

  const callsByKey = new Map();
  const callsById = new Map();
  for (const c of input.calls) {
    for (const k of c.phoneKeys || []) if (!isTestKey(k)) push(callsByKey, k, c);
    if (c.biginContactId) push(callsById, String(c.biginContactId), c);
  }

  const dealsById = new Map();
  const dealsByKey = new Map();
  for (const d of input.deals) {
    if (d.contactId) push(dealsById, String(d.contactId), d);
    if (d.contactPhoneKey && !isTestKey(d.contactPhoneKey)) push(dealsByKey, d.contactPhoneKey, d);
  }

  const waByKey = new Map();
  for (const t of input.tasks) for (const m of t.whatsappLog || []) push(waByKey, t.phoneKey, m);

  const leads = [];
  for (const contact of input.contacts) {
    const allKeys = contact.phoneKeys || [];
    if (allKeys.some((k) => PLACEHOLDER_PHONES.has(k))) continue;
    const keys = allKeys.filter((k) => !isTestKey(k));
    const id = String(contact.zohoId);

    const calls = new Set(callsById.get(id) || []);
    const deals = new Set(dealsById.get(id) || []);
    const formTimes = [];
    const whatsapp = [];
    for (const k of keys) {
      for (const c of callsByKey.get(k) || []) calls.add(c);
      for (const d of dealsByKey.get(k) || []) deals.add(d);
      formTimes.push(...(formsByKey.get(k) || []));
      whatsapp.push(...(waByKey.get(k) || []));
    }

    const lead = analyseLead({
      contact,
      formTimes,
      calls: [...calls],
      deal: [...deals].reduce(bestDeal, null),
      whatsapp,
    });
    if (!lead || lead.leadInAt < input.after || lead.leadInAt >= input.before) continue;
    leads.push(lead);
  }
  leads.sort((a, b) => b.leadInAt - a.leadInAt);

  const speed = new Map(SPEED_BUCKETS.map((b) => [b.key, emptyRow(b.key, b.label)]));
  const slot = new Map(SLOTS.map((s) => [s.key, emptyRow(s.key, s.label)]));
  const weekday = new Map(
    [1, 2, 3, 4, 5, 6, 0].map((d) => [String(d), emptyRow(String(d), WEEKDAYS[d])])
  );
  const attempts = new Map(ATTEMPT_BUCKETS.map((b) => [b.key, emptyRow(b.key, b.label)]));
  const whatsapp = new Map([
    ['yes', emptyRow('yes', 'WhatsApp before first call')],
    ['no', emptyRow('no', 'No WhatsApp before first call')],
  ]);
  const templates = new Map();
  const firstCaller = new Map([
    ['rep', emptyRow('rep', 'This rep')],
    ['other', emptyRow('other', 'Another rep')],
    ['unknown', emptyRow('unknown', 'Unmapped agent')],
    ['never', emptyRow('never', 'Never called')],
  ]);

  for (const lead of leads) {
    tally(speed, speedBucket(lead.minsToDial), lead);
    tally(slot, slotOf(lead.hour), lead);
    tally(weekday, String(lead.weekday), lead);
    tally(attempts, attemptBucket(lead), lead);
    tally(whatsapp, lead.whatsappFirst ? 'yes' : 'no', lead);
    if (lead.whatsappFirst) {
      if (!templates.has(lead.whatsappFirst)) {
        templates.set(lead.whatsappFirst, emptyRow(lead.whatsappFirst, lead.whatsappFirst));
      }
      tally(templates, lead.whatsappFirst, lead);
    }
    let who = 'never';
    if (lead.firstDialAt) who = !lead.firstCallBy ? 'unknown' : lead.firstCallBy === rep ? 'rep' : 'other';
    tally(firstCaller, who, lead);
  }

  const summary = { all: summarise(leads, rep) };
  for (const o of OUTCOMES) summary[o] = summarise(leads.filter((l) => l.outcome === o), rep);

  return {
    summary,
    signals: {
      speed: finish(speed),
      slot: finish(slot),
      weekday: finish(weekday),
      attempts: finish(attempts),
      whatsapp: finish(whatsapp),
      templates: finish(templates).sort((a, b) => b.leads - a.leads),
      firstCaller: finish(firstCaller),
    },
    leads,
  };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Load one rep's cohort for a from/to range (YYYY-MM-DD) and roll it up. */
async function buildRepLifecycle({ ownerEmail, from, to }) {
  const after = new Date(`${from}T00:00:00`);
  const before = new Date(`${nextDay(to)}T00:00:00`);
  const owner = new RegExp(`^${escapeRe(String(ownerEmail).trim())}$`, 'i');

  // Contact creation trails lead-in by up to the form lookback, so a contact
  // created a few days after `to` can still have its lead-in inside the window.
  const created = { $gte: after, $lt: new Date(before.getTime() + FORM_LOOKBACK_MS) };

  const wonDeals = await Deal.find({ ownerEmail: owner, outcome: 'won' }, { contactId: 1 }).lean();
  const wonContactIds = [...new Set(wonDeals.map((d) => d.contactId).filter(Boolean).map(String))];

  const contacts = await Contact.find(
    {
      createdTime: created,
      $or: [{ ownerEmail: owner }, ...(wonContactIds.length ? [{ zohoId: { $in: wonContactIds } }] : [])],
    },
    { zohoId: 1, name: 1, phoneKeys: 1, ownerEmail: 1, createdTime: 1 }
  ).lean();

  const ids = contacts.map((c) => String(c.zohoId));
  const keys = [
    ...new Set(contacts.flatMap((c) => c.phoneKeys || []).filter((k) => k && !isTestKey(k))),
  ];
  if (!ids.length) return rollUpLifecycle({ ownerEmail, after, before, contacts: [], forms: [], calls: [], deals: [], tasks: [] });

  const callOr = [{ biginContactId: { $in: ids } }];
  if (keys.length) callOr.push({ phoneKeys: { $in: keys } });

  const [webLeads, metaLeads, calls, deals, tasks] = await Promise.all([
    keys.length ? WebLead.find({ phoneKey: { $in: keys } }, { phoneKey: 1, createdAt: 1 }).lean() : [],
    keys.length ? MetaLead.find({ phoneKey: { $in: keys } }, { phoneKey: 1, createdTime: 1 }).lean() : [],
    Call.find(
      { $or: callOr, startedAt: { $gte: new Date(after.getTime() - FORM_LOOKBACK_MS) } },
      {
        startedAt: 1,
        direction: 1,
        duration: 1,
        biginDurationSec: 1,
        ownerEmail: 1,
        phoneKeys: 1,
        biginContactId: 1,
      }
    ).lean(),
    Deal.find(
      {
        $or: [
          { contactId: { $in: ids } },
          ...(keys.length ? [{ contactPhoneKey: { $in: keys } }] : []),
        ],
      },
      { ...DEAL_FIELDS, ownerEmail: 1 }
    ).lean(),
    keys.length ? Task.find({ phoneKey: { $in: keys } }, { phoneKey: 1, whatsappLog: 1 }).lean() : [],
  ]);

  return rollUpLifecycle({
    ownerEmail,
    after,
    before,
    contacts,
    forms: [
      ...webLeads.map((l) => ({ phoneKey: l.phoneKey, at: l.createdAt })),
      ...metaLeads.map((l) => ({ phoneKey: l.phoneKey, at: l.createdTime })),
    ],
    calls,
    deals,
    tasks,
  });
}

/** Everyone who owns Bigin contacts, busiest first — the tab's rep picker. */
async function listLifecycleOwners() {
  const rows = await Contact.aggregate([
    { $match: { ownerEmail: { $nin: [null, ''] } } },
    { $group: { _id: { $toLower: '$ownerEmail' }, name: { $first: '$ownerName' }, contacts: { $sum: 1 } } },
    { $sort: { contacts: -1 } },
  ]);
  return rows.map((r) => ({ email: r._id, name: r.name || r._id, contacts: r.contacts }));
}

module.exports = {
  buildRepLifecycle,
  listLifecycleOwners,
  rollUpLifecycle,
  analyseLead,
  speedBucket,
  dedupeTwins,
};
