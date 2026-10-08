// Rep Lifecycle — what happens between a lead arriving and its first call, for
// one rep's leads, split by how the lead ended up (won / lost / junk / open).
// The question it answers: what happens before the first call on the leads a
// rep goes on to close with a sale, and what happens on the ones they lose?
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
// The earliest sign of the lead in the week before Bigin created it: a form
// fill (WebLead / MetaLead), the lead's first WhatsApp message, or the
// onboarding bot starting on them. Else Bigin's createdTime. The week's cap
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
// BEFORE THE FIRST CALL
// ---------------------
// Everything from lead-in up to the first dial (or up to now, if never dialled):
//   WhatsApp  the WATI chat (wati_chats, synced by modules/wati): who messaged
//             first, the onboarding bot (started / completed), what the lead
//             asked outside the bot (keyword topics), and whether a human
//             chatted before calling.
//   VSL       the focasvsl cluster: was the link opened, and the peak watch %
//             reached before the call (the event log's max, never the
//             overwritable vsl_leads value — see vsl/services/watchIndex).
//
// Test phones and the office DID never join (utils/phone).

const Contact = require('../../leads/models/Contact');
const WebLead = require('../../ads/models/WebLead');
const MetaLead = require('../../ads/models/MetaLead');
const Deal = require('../models/Deal');
const Call = require('../models/Call');
const Task = require('../../../models/Task');
const WatiChat = require('../../wati/models/WatiChat');
const { topicsOf, isGreeting, TOPICS } = require('../../wati/services/enquiryTopics');
const vslConnection = require('../../vsl/services/connection');
const { isJunkReason } = require('../../leads/services/funnel');
const { DEAL_FIELDS, bestDeal } = require('../../ads/services/dealJoin');
const { nextDay } = require('../../ads/services/adMetrics');
const { PLACEHOLDER_PHONES, OFFICE_DID, phoneKey } = require('../../../utils/phone');

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;
const FORM_LOOKBACK_MS = 7 * DAY_MS;
// A TeleCMI row and its Bigin twin start within seconds of each other.
const TWIN_WINDOW_MS = 90 * 1000;
const IST_OFFSET_MS = 330 * MIN_MS;
const VSL_TIMEOUT_MS = 10000;
const TIMELINE_MAX = 120;

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

const VSL_BUCKETS = [
  { key: 'noLink', label: 'No VSL record' },
  { key: 'notOpened', label: 'Link not opened' },
  { key: 'openedNoPlay', label: 'Opened, not played' },
  { key: 'lt25', label: 'Watched under 25%' },
  { key: '25to75', label: 'Watched 25–75%' },
  { key: 'gt75', label: 'Watched over 75%' },
];

// 'unsynced' = we have no WATI copy of this lead's chat yet (not "no chat").
const UNSYNCED = { key: 'unsynced', label: 'Chat not synced yet' };

const BOT_BUCKETS = [
  { key: 'none', label: 'No bot' },
  { key: 'unfinished', label: 'Bot started, not finished' },
  { key: 'completed', label: 'Bot completed' },
  UNSYNCED,
];

const FIRST_MOVER_BUCKETS = [
  { key: 'lead', label: 'Lead messaged first' },
  { key: 'us', label: 'We messaged first' },
  { key: 'none', label: 'No WhatsApp chat' },
  UNSYNCED,
];

const REP_CHAT_BUCKETS = [
  { key: 'yes', label: 'Rep chatted before calling' },
  { key: 'no', label: 'No rep chat before the call' },
  UNSYNCED,
];

const TOPIC_BUCKETS = [
  ...TOPICS.map((t) => ({ key: t.key, label: t.label })),
  { key: 'other', label: 'Other question' },
  { key: 'none', label: 'No enquiry (greetings / bot answers only)' },
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

function vslBucket(v) {
  if (!v.vslRecord) return 'noLink';
  if (!v.vslOpened) return 'notOpened';
  if (!v.vslPlayed) return 'openedNoPlay';
  if (v.vslPeakPct < 25) return 'lt25';
  return v.vslPeakPct < 75 ? '25to75' : 'gt75';
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
 * The WhatsApp side of [from, to): bot, who moved first, what the lead asked,
 * whether a human chatted. `items` null = chat not synced.
 */
function analyseChat(items, from, to) {
  if (!items) {
    return {
      chatSynced: false,
      firstMover: 'unsynced',
      bot: 'unsynced',
      botFlow: null,
      botAnswers: 0,
      leadMsgs: 0,
      firstEnquiry: null,
      topics: [],
      repMsgs: 0,
      repChat: 'unsynced',
      askedToCall: false,
      vslLinkSent: false,
    };
  }
  let flowActive = false;
  let botStarted = false;
  let botCompleted = false;
  let botFlow = null;
  let firstMover = null;
  let botAnswers = 0;
  let repMsgs = 0;
  let askedToCall = false;
  let vslLinkSent = false;
  const enquiries = [];

  for (const i of items) {
    if (i.at < from || i.at >= to) continue;
    if (i.kind === 'flow') {
      if (i.state === 'started') {
        flowActive = true;
        botStarted = true;
        botFlow = botFlow || i.name || null;
        if (!firstMover) firstMover = 'us';
      } else {
        flowActive = false;
        if (i.state === 'ended') botCompleted = true;
      }
      continue;
    }
    if (i.kind === 'ticket') continue;
    if (!firstMover) firstMover = i.kind === 'lead' ? 'lead' : 'us';
    if (i.kind === 'lead') {
      // A reply inside a bot flow answers the bot's question; outside it, the
      // lead is asking us something.
      if (flowActive) botAnswers += 1;
      else enquiries.push(i.text || '');
    } else if (i.kind === 'rep') {
      repMsgs += 1;
      if (/\bcall/i.test(i.text || '')) askedToCall = true;
    } else if (i.kind === 'bot') {
      botStarted = true;
    }
    if (i.kind !== 'lead' && /focasedu\.online\/vsl/i.test(i.text || '')) vslLinkSent = true;
  }

  const questions = enquiries.filter((t) => !isGreeting(t));
  let topics = topicsOf(questions);
  if (!topics.length) topics = questions.length ? ['other'] : ['none'];

  return {
    chatSynced: true,
    firstMover: firstMover || 'none',
    bot: botCompleted ? 'completed' : botStarted ? 'unfinished' : 'none',
    botFlow,
    botAnswers,
    leadMsgs: enquiries.length,
    firstEnquiry: questions[0] ? questions[0].slice(0, 160) : null,
    topics,
    repMsgs,
    repChat: repMsgs > 0 ? 'yes' : 'no',
    askedToCall,
    vslLinkSent,
  };
}

/**
 * The VSL side: opened / played / peak % before `to`. `vsl` null = no VSL
 * record for this phone; `available` false = VSL cluster not configured.
 */
function analyseVsl(vsl, from, to, available) {
  if (!available) return { vsl: null, vslRecord: false, vslOpened: false, vslPlayed: false, vslPeakPct: null };
  if (!vsl) return { vsl: 'noLink', vslRecord: false, vslOpened: false, vslPlayed: false, vslPeakPct: null };
  const events = (vsl.events || []).filter((e) => e.at && e.at >= from && e.at < to);
  const openedAt = toDate(vsl.firstOpenedAt);
  const opened = Boolean(openedAt && openedAt < to) || events.length > 0;
  const played = events.some((e) => e.type === 'play_started' || e.pct > 0);
  const peak = Math.min(100, events.reduce((m, e) => Math.max(m, Number(e.pct) || 0), 0));
  const out = { vslRecord: true, vslOpened: opened, vslPlayed: played, vslPeakPct: played ? Math.round(peak) : null };
  out.vsl = vslBucket({ ...out, vslPeakPct: peak });
  return out;
}

/**
 * One lead's facts. No DB.
 *
 * @param {object} p
 * @param {object} p.contact    BiginContact
 * @param {Date[]} p.formTimes  form-fill times for the contact's phones
 * @param {object[]} p.calls    raw Call docs for the contact (any order)
 * @param {object|null} p.deal  best deal for the contact
 * @param {object[]} p.whatsapp dashboard whatsappLog entries for the contact's phones
 * @param {object[]|null} [p.chat] WATI chat items (oldest first), null = not synced
 * @param {object|null} [p.vsl] {linkSentAt, firstOpenedAt, events:[{at,type,pct}]}, null = no record
 * @param {boolean} [p.vslAvailable]
 * @param {object[]} [p.taskHistory] Task.taskHistory entries, for the timeline
 * @param {boolean} [p.withTimeline] add the pre-call timeline
 * @param {Date} [p.now]
 */
function analyseLead({
  contact,
  formTimes,
  calls,
  deal,
  whatsapp,
  chat = null,
  vsl = null,
  vslAvailable = false,
  taskHistory = [],
  withTimeline = false,
  now = new Date(),
}) {
  const created = toDate(contact.createdTime);
  const inLookback = (t) => t && (!created || (t <= created && created - t <= FORM_LOOKBACK_MS));

  const forms = formTimes.filter(inLookback).sort((a, b) => a - b);
  const chatStart = (chat || []).find(
    (i) => (i.kind === 'lead' || (i.kind === 'flow' && i.state === 'started')) && inLookback(i.at)
  );
  const candidates = [
    forms[0] && { at: forms[0], source: 'form' },
    chatStart && { at: chatStart.at, source: 'whatsapp' },
    created && { at: created, source: 'bigin' },
  ].filter(Boolean);
  if (!candidates.length) return null;
  const first = candidates.reduce((a, b) => (b.at < a.at ? b : a));
  const leadInAt = first.at;
  const leadInSource = first.source;

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

  // The pre-call window: lead-in up to the first dial.
  const cutoff = firstDial ? firstDial.at : now;
  const chatFacts = analyseChat(chat, leadInAt, cutoff);
  // A VSL page visit can come before the form, so VSL looks back the same week.
  const vslFacts = analyseVsl(vsl, new Date(leadInAt.getTime() - FORM_LOOKBACK_MS), cutoff, vslAvailable);

  const mins = (t) => (t ? Math.round(((t - leadInAt) / MIN_MS) * 10) / 10 : null);
  const { hour, weekday } = istParts(leadInAt);
  const keys = (contact.phoneKeys || []).filter((k) => !isTestKey(k));

  const lead = {
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
    ...chatFacts,
    ...vslFacts,
    outcome: outcomeOf(deal),
    stage: deal ? deal.stage || null : null,
    lostReason: deal ? deal.lostReason || null : null,
    amount: deal && deal.outcome === 'won' ? Number(deal.amount) || 0 : 0,
  };

  if (withTimeline) {
    lead.timeline = buildTimeline({ lead, chat, vsl, taskHistory, calls: timeline, connectIdx });
  }
  return lead;
}

/**
 * Everything in time order from lead-in to the first connect (or the first dial,
 * or now): chat, bot, VSL, tasks, and the dials themselves.
 */
function buildTimeline({ lead, chat, vsl, taskHistory, calls, connectIdx }) {
  const start = lead.leadInAt;
  const endCall = connectIdx >= 0 ? calls[connectIdx] : calls.find((c) => c.direction !== 'inbound');
  const end = endCall ? endCall.at : new Date(8.64e15);
  const inWindow = (at) => at && at >= start && at <= end;
  const out = [{ at: start, kind: 'leadIn', text: `Lead in (${lead.leadInSource})` }];

  for (const i of chat || []) {
    if (!inWindow(i.at)) continue;
    if (i.kind === 'ticket' && !i.topic) continue;
    const text =
      i.kind === 'flow'
        ? `Bot ${i.state}: ${i.name || ''}`.trim()
        : i.kind === 'ticket'
          ? `Chat opened · ${i.topic}`
          : i.kind === 'template'
            ? `Template${i.name ? ` ${i.name}` : ''}: ${i.text || ''}`
            : i.text || '';
    out.push({ at: i.at, kind: i.kind, text: text.slice(0, 300) });
  }

  if (vsl) {
    const linkAt = toDate(vsl.linkSentAt);
    if (inWindow(linkAt)) out.push({ at: linkAt, kind: 'vsl', text: 'VSL link sent' });
    const openedAt = toDate(vsl.firstOpenedAt);
    if (inWindow(openedAt)) out.push({ at: openedAt, kind: 'vsl', text: 'VSL opened' });
    let played = false;
    let shown = 0;
    for (const e of (vsl.events || []).slice().sort((a, b) => a.at - b.at)) {
      if (!inWindow(e.at)) continue;
      const p = Math.min(100, Math.round(Number(e.pct) || 0));
      if (e.type === 'play_started' && !played) {
        played = true;
        out.push({ at: e.at, kind: 'vsl', text: 'VSL play started' });
      } else if ((e.type === 'milestone' || e.type === 'completed') && p > shown) {
        shown = p;
        out.push({ at: e.at, kind: 'vsl', text: `VSL watched ${p}%` });
      }
    }
  }

  for (const t of taskHistory || []) {
    const at = toDate(t.createdTime);
    if (!inWindow(at)) continue;
    out.push({ at, kind: 'task', text: `Task: ${t.subject || ''}${t.category ? ` (${t.category})` : ''}` });
  }

  for (const c of calls) {
    if (!inWindow(c.at)) continue;
    const talk = c.talkSec > 0 ? `connected ${Math.round(c.talkSec)}s` : 'no answer';
    const what = c.direction === 'inbound' ? 'Lead called in' : 'Dial';
    out.push({ at: c.at, kind: 'call', text: `${what} · ${talk}${c.by ? ` · ${c.by}` : ''}` });
  }

  out.sort((a, b) => a.at - b.at);
  return out.length > TIMELINE_MAX ? [...out.slice(0, TIMELINE_MAX - 1), out[out.length - 1]] : out;
}

const emptyRow = (key, label) => ({ key, label, leads: 0, won: 0, lost: 0, junk: 0, open: 0, revenue: 0 });

function tally(rows, key, lead) {
  const row = rows.get(key);
  if (!row) return;
  row.leads += 1;
  row[lead.outcome] += 1;
  row.revenue += lead.amount;
}

const bucketMap = (buckets) => new Map(buckets.map((b) => [b.key, emptyRow(b.key, b.label)]));

const finish = (rows) =>
  [...rows.values()]
    // An empty "not synced" row is noise once every chat is in.
    .filter((r) => !(r.key === 'unsynced' && r.leads === 0))
    .map((r) => ({ ...r, winPct: pct(r.won, r.leads) }));

function summarise(leads, rep) {
  const dialled = leads.filter((l) => l.firstDialAt);
  const synced = leads.filter((l) => l.chatSynced);
  const withVsl = leads.filter((l) => l.vsl);
  return {
    leads: leads.length,
    revenue: leads.reduce((s, l) => s + l.amount, 0),
    medianMinsToDial: median(dialled.map((l) => l.minsToDial)),
    medianMinsToConnect: median(leads.map((l) => l.minsToConnect)),
    medianAttempts: median(leads.filter((l) => l.connectedBy === 'dial').map((l) => l.attempts)),
    neverCalledPct: pct(leads.length - dialled.length, leads.length),
    whatsappFirstPct: pct(leads.filter((l) => l.whatsappFirst).length, leads.length),
    firstCallByOtherPct: pct(dialled.filter((l) => l.firstCallBy && l.firstCallBy !== rep).length, dialled.length),
    chatSyncedPct: pct(synced.length, leads.length),
    leadFirstPct: pct(synced.filter((l) => l.firstMover === 'lead').length, synced.length),
    botCompletedPct: pct(synced.filter((l) => l.bot === 'completed').length, synced.length),
    repChattedPct: pct(synced.filter((l) => l.repChat === 'yes').length, synced.length),
    medianLeadMsgs: median(synced.map((l) => l.leadMsgs)),
    vslPlayedPct: pct(withVsl.filter((l) => l.vslPlayed).length, withVsl.length),
    vsl25Pct: pct(withVsl.filter((l) => l.vslPeakPct >= 25).length, withVsl.length),
  };
}

const push = (map, key, v) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(v);
};

/** Index every input by contact id / phone key, once. */
function indexInputs(input) {
  const idx = {
    forms: new Map(),
    callsByKey: new Map(),
    callsById: new Map(),
    dealsById: new Map(),
    dealsByKey: new Map(),
    wa: new Map(),
    tasks: new Map(),
    chats: new Map(),
    vsl: new Map(),
  };
  for (const f of input.forms || []) push(idx.forms, f.phoneKey, toDate(f.at));
  for (const c of input.calls || []) {
    for (const k of c.phoneKeys || []) if (!isTestKey(k)) push(idx.callsByKey, k, c);
    if (c.biginContactId) push(idx.callsById, String(c.biginContactId), c);
  }
  for (const d of input.deals || []) {
    if (d.contactId) push(idx.dealsById, String(d.contactId), d);
    if (d.contactPhoneKey && !isTestKey(d.contactPhoneKey)) push(idx.dealsByKey, d.contactPhoneKey, d);
  }
  for (const t of input.tasks || []) {
    for (const m of t.whatsappLog || []) push(idx.wa, t.phoneKey, m);
    for (const h of t.taskHistory || []) push(idx.tasks, t.phoneKey, h);
  }
  for (const c of input.chats || []) {
    idx.chats.set(c.phoneKey, (c.items || []).map((i) => ({ ...i, at: toDate(i.at) })).filter((i) => i.at));
  }
  for (const v of input.vsl || []) idx.vsl.set(v.phoneKey, v);
  return idx;
}

/** One contact's slice of the indexed inputs, analysed. Null for a test contact. */
function leadFor(contact, idx, input, extra = {}) {
  const allKeys = contact.phoneKeys || [];
  if (allKeys.some((k) => PLACEHOLDER_PHONES.has(k))) return null;
  const keys = allKeys.filter((k) => !isTestKey(k));
  const id = String(contact.zohoId);

  const calls = new Set(idx.callsById.get(id) || []);
  const deals = new Set(idx.dealsById.get(id) || []);
  const formTimes = [];
  const whatsapp = [];
  const taskHistory = [];
  let chat = null;
  let vsl = null;
  for (const k of keys) {
    for (const c of idx.callsByKey.get(k) || []) calls.add(c);
    for (const d of idx.dealsByKey.get(k) || []) deals.add(d);
    formTimes.push(...(idx.forms.get(k) || []));
    whatsapp.push(...(idx.wa.get(k) || []));
    taskHistory.push(...(idx.tasks.get(k) || []));
    if (idx.chats.has(k)) chat = [...(chat || []), ...idx.chats.get(k)];
    const v = idx.vsl.get(k);
    if (v) {
      vsl = vsl
        ? {
            linkSentAt: [vsl.linkSentAt, v.linkSentAt].filter(Boolean).sort((a, b) => toDate(a) - toDate(b))[0] || null,
            firstOpenedAt:
              [vsl.firstOpenedAt, v.firstOpenedAt].filter(Boolean).sort((a, b) => toDate(a) - toDate(b))[0] || null,
            events: [...vsl.events, ...v.events],
          }
        : v;
    }
  }
  if (chat) chat.sort((a, b) => a.at - b.at);

  return analyseLead({
    contact,
    formTimes,
    calls: [...calls],
    deal: [...deals].reduce(bestDeal, null),
    whatsapp,
    chat,
    vsl,
    vslAvailable: Boolean(input.vslAvailable),
    taskHistory,
    now: input.now || new Date(),
    ...extra,
  });
}

/**
 * The pure roll-up. No DB.
 *
 * @param {object} input
 * @param {string} input.ownerEmail  the rep
 * @param {Date} input.after         lead-in window start (inclusive)
 * @param {Date} input.before        lead-in window end (exclusive)
 * @param {object[]} input.contacts  BiginContact {zohoId, name, phoneKeys, ownerEmail, createdTime}
 * @param {object[]} input.forms     {phoneKey, at} form fills (WebLead createdAt / MetaLead createdTime)
 * @param {object[]} input.calls     Call {startedAt, direction, duration, biginDurationSec, ownerEmail, phoneKeys, biginContactId}
 * @param {object[]} input.deals     Deal (DEAL_FIELDS)
 * @param {object[]} input.tasks     Task {phoneKey, whatsappLog, taskHistory}
 * @param {object[]} [input.chats]   WatiChat {phoneKey, items}
 * @param {object[]} [input.vsl]     {phoneKey, linkSentAt, firstOpenedAt, events:[{at,type,pct}]}
 * @param {boolean} [input.vslAvailable]
 */
function rollUpLifecycle(input) {
  const rep = lower(input.ownerEmail);
  const idx = indexInputs(input);

  const leads = [];
  for (const contact of input.contacts) {
    const lead = leadFor(contact, idx, input);
    if (!lead || lead.leadInAt < input.after || lead.leadInAt >= input.before) continue;
    leads.push(lead);
  }
  leads.sort((a, b) => b.leadInAt - a.leadInAt);

  const speed = bucketMap(SPEED_BUCKETS);
  const slot = bucketMap(SLOTS);
  const weekday = new Map(
    [1, 2, 3, 4, 5, 6, 0].map((d) => [String(d), emptyRow(String(d), WEEKDAYS[d])])
  );
  const attempts = bucketMap(ATTEMPT_BUCKETS);
  const whatsapp = new Map([
    ['yes', emptyRow('yes', 'Dashboard template before first call')],
    ['no', emptyRow('no', 'No dashboard template before first call')],
  ]);
  const templates = new Map();
  const firstCaller = new Map([
    ['rep', emptyRow('rep', 'This rep')],
    ['other', emptyRow('other', 'Another rep')],
    ['unknown', emptyRow('unknown', 'Unmapped agent')],
    ['never', emptyRow('never', 'Never called')],
  ]);
  const vsl = bucketMap(VSL_BUCKETS);
  const bot = bucketMap(BOT_BUCKETS);
  const firstMover = bucketMap(FIRST_MOVER_BUCKETS);
  const repChat = bucketMap(REP_CHAT_BUCKETS);
  const topics = bucketMap(TOPIC_BUCKETS);

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
    if (lead.vsl) tally(vsl, lead.vsl, lead);
    tally(bot, lead.bot, lead);
    tally(firstMover, lead.firstMover, lead);
    tally(repChat, lead.repChat, lead);
    for (const t of lead.topics) tally(topics, t, lead);
  }

  const summary = { all: summarise(leads, rep) };
  for (const o of OUTCOMES) summary[o] = summarise(leads.filter((l) => l.outcome === o), rep);

  const chatsAt = (input.chats || []).map((c) => c.fetchedAt && new Date(c.fetchedAt)).filter(Boolean);

  return {
    summary,
    signals: {
      speed: finish(speed),
      attempts: finish(attempts),
      firstMover: finish(firstMover),
      bot: finish(bot),
      topics: finish(topics).filter((r) => r.leads > 0).sort((a, b) => b.leads - a.leads),
      repChat: finish(repChat),
      vsl: input.vslAvailable ? finish(vsl) : null,
      slot: finish(slot),
      weekday: finish(weekday),
      whatsapp: finish(whatsapp),
      templates: finish(templates).sort((a, b) => b.leads - a.leads),
      firstCaller: finish(firstCaller),
    },
    sources: {
      vslAvailable: Boolean(input.vslAvailable),
      vslError: input.vslError || null,
      chatsSyncedUpTo: chatsAt.length ? new Date(Math.max(...chatsAt)) : null,
    },
    leads,
  };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * VSL records and their events for these phone keys, from the focasvsl cluster.
 * Never throws: an unreachable or unconfigured cluster costs the VSL columns only.
 */
async function loadVsl(keys) {
  if (!vslConnection.isConfigured()) return { available: false, rows: [] };
  if (!keys.length) return { available: true, rows: [] };
  try {
    const VslLead = require('../../vsl/models/VslLead')();
    const VslEvent = require('../../vsl/models/VslEvent')();
    if (!VslLead || !VslEvent) return { available: false, rows: [] };

    const phones = keys.flatMap((k) => [k, `91${k}`, `+91${k}`]);
    const vslLeads = await withTimeout(
      VslLead.find({ phone: { $in: phones } }, { leadId: 1, phone: 1, linkSentAt: 1, firstOpenedAt: 1 }).lean(),
      VSL_TIMEOUT_MS,
      'VSL leads'
    );
    const ids = [...new Set(vslLeads.map((l) => l.leadId).filter(Boolean))];
    // vsl_events has no leadId index (we are a read-only guest there), so this
    // is a scan; it is bounded by maxTimeMS and only runs on an admin tab load.
    const events = ids.length
      ? await withTimeout(
          VslEvent.find(
            { leadId: { $in: ids } },
            { _id: 0, leadId: 1, eventType: 1, watchPercentage: 1, receivedAt: 1 }
          )
            .maxTimeMS(VSL_TIMEOUT_MS)
            .lean(),
          VSL_TIMEOUT_MS + 2000,
          'VSL events'
        )
      : [];

    const eventsByLead = new Map();
    for (const e of events) {
      push(eventsByLead, e.leadId, {
        at: toDate(e.receivedAt),
        type: e.eventType,
        pct: Number(e.watchPercentage) || 0,
      });
    }
    const byKey = new Map();
    for (const l of vslLeads) {
      const k = phoneKey(l.phone);
      if (!k) continue;
      const row = byKey.get(k) || { phoneKey: k, linkSentAt: null, firstOpenedAt: null, events: [] };
      const earliest = (a, b) => (!a ? b : !b ? a : toDate(a) <= toDate(b) ? a : b);
      row.linkSentAt = earliest(row.linkSentAt, l.linkSentAt || null);
      row.firstOpenedAt = earliest(row.firstOpenedAt, l.firstOpenedAt || null);
      row.events.push(...(eventsByLead.get(l.leadId) || []).filter((e) => e.at));
      byKey.set(k, row);
    }
    return { available: true, rows: [...byKey.values()] };
  } catch (err) {
    console.warn('[rep lifecycle] VSL load failed:', err.message);
    return { available: false, rows: [], error: err.message };
  }
}

/** Everything the roll-up needs for these contacts. */
async function loadInputs(contacts, callsSince) {
  const ids = contacts.map((c) => String(c.zohoId));
  const keys = [
    ...new Set(contacts.flatMap((c) => c.phoneKeys || []).filter((k) => k && !isTestKey(k))),
  ];
  if (!ids.length) {
    return { forms: [], calls: [], deals: [], tasks: [], chats: [], vsl: [], vslAvailable: vslConnection.isConfigured() };
  }

  const callOr = [{ biginContactId: { $in: ids } }];
  if (keys.length) callOr.push({ phoneKeys: { $in: keys } });

  const [webLeads, metaLeads, calls, deals, tasks, chats, vsl] = await Promise.all([
    keys.length ? WebLead.find({ phoneKey: { $in: keys } }, { phoneKey: 1, createdAt: 1 }).lean() : [],
    keys.length ? MetaLead.find({ phoneKey: { $in: keys } }, { phoneKey: 1, createdTime: 1 }).lean() : [],
    Call.find(
      { $or: callOr, ...(callsSince ? { startedAt: { $gte: callsSince } } : {}) },
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
    keys.length
      ? Task.find({ phoneKey: { $in: keys } }, { phoneKey: 1, whatsappLog: 1, taskHistory: 1 }).lean()
      : [],
    keys.length ? WatiChat.find({ phoneKey: { $in: keys } }, { phoneKey: 1, items: 1, fetchedAt: 1 }).lean() : [],
    loadVsl(keys),
  ]);

  return {
    forms: [
      ...webLeads.map((l) => ({ phoneKey: l.phoneKey, at: l.createdAt })),
      ...metaLeads.map((l) => ({ phoneKey: l.phoneKey, at: l.createdTime })),
    ],
    calls,
    deals,
    tasks,
    chats,
    vsl: vsl.rows,
    vslAvailable: vsl.available,
    vslError: vsl.error || null,
  };
}

const CONTACT_FIELDS = { zohoId: 1, name: 1, phoneKeys: 1, ownerEmail: 1, createdTime: 1 };

/** Load one rep's cohort for a from/to range (YYYY-MM-DD) and roll it up. */
async function buildRepLifecycle({ ownerEmail, from, to }) {
  const after = new Date(`${from}T00:00:00`);
  const before = new Date(`${nextDay(to)}T00:00:00`);
  const owner = new RegExp(`^${escapeRe(String(ownerEmail).trim())}$`, 'i');

  // Contact creation trails lead-in by up to the lookback, so a contact created
  // a few days after `to` can still have its lead-in inside the window.
  const created = { $gte: after, $lt: new Date(before.getTime() + FORM_LOOKBACK_MS) };

  const wonDeals = await Deal.find({ ownerEmail: owner, outcome: 'won' }, { contactId: 1 }).lean();
  const wonContactIds = [...new Set(wonDeals.map((d) => d.contactId).filter(Boolean).map(String))];

  const contacts = await Contact.find(
    {
      createdTime: created,
      $or: [{ ownerEmail: owner }, ...(wonContactIds.length ? [{ zohoId: { $in: wonContactIds } }] : [])],
    },
    CONTACT_FIELDS
  ).lean();

  const inputs = await loadInputs(contacts, new Date(after.getTime() - FORM_LOOKBACK_MS));
  return rollUpLifecycle({ ownerEmail, after, before, contacts, ...inputs });
}

/** One lead's facts plus its pre-call timeline, for the tab's expanded row. */
async function buildLeadPreCall(contactId) {
  const contact = await Contact.findOne({ zohoId: String(contactId) }, CONTACT_FIELDS).lean();
  if (!contact) return null;
  const inputs = await loadInputs([contact], null);
  const input = { contacts: [contact], ...inputs };
  return leadFor(contact, indexInputs(input), input, { withTimeline: true });
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
  buildLeadPreCall,
  listLifecycleOwners,
  rollUpLifecycle,
  analyseLead,
  analyseChat,
  analyseVsl,
  speedBucket,
  dedupeTwins,
};
