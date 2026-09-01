// One shaping of a VSL row, shared by the tracking tab and the lead drawer.
//
// Engagement, minutes and lead source are all derived HERE and only here. If the
// tab computed "watched" one way and the drawer another, a rep would open a lead
// the table called engaged and find a panel that disagreed — and there would be
// no way to tell which was lying.

const { canonicalSource } = require('../../ads/services/leadSourceName');
const { phoneKey } = require('../../../utils/phone');
const { isConfigured } = require('./connection');
const { getPeakMap } = require('./watchIndex');

// The country code focasvsl prepends to a bare 10-digit number. Used only to
// build an EQUALITY probe that can use vsl_leads' phone_unique index; a suffix
// scan is the always-correct fallback when the guess misses.
const CC = (process.env.VSL_PHONE_CC || '91').replace(/\D/g, '');

// What the tab and drawer read off a vsl_leads document.
const LEAD_FIELDS = {
  _id: 0,
  leadId: 1,
  phone: 1,
  name: 1,
  createdAt: 1,
  source: 1,
  firstOpenedAt: 1,
  lastOpenedAt: 1,
  openCount: 1,
  firstPlayAt: 1,
  lastActivityAt: 1,
  lastEventType: 1,
  watchedSeconds: 1,
  watchPercentage: 1,
  linkSentAt: 1,
  linkSendStatus: 1,
  reminderState: 1,
  reminderSentAt: 1,
};

/** "Watched enough to count" — one threshold, quoted by every card and filter. */
const WATCHED_SECONDS = 30;
const WATCHED_PERCENT = 10;

/**
 * The watch block.
 *
 * `basis` is the honesty field, and it is not decoration:
 *   'events' — the peak from the event log. The number we stand behind.
 *   'lead'   — this lead has no events at all, so it is vsl_leads.watchedSeconds:
 *              the value focasvsl OVERWRITES on every beacon, meaning it reflects
 *              the last session rather than the longest. The UI labels it.
 *   'none'   — nothing was ever recorded.
 * Same discipline as taskCategorySource: a number we inferred must never pass as
 * one we measured.
 */
function shapeWatch(lead, peak) {
  if (peak && peak.events > 0) {
    return {
      seconds: Math.round(peak.seconds),
      minutes: Math.round((peak.seconds / 60) * 10) / 10,
      percentage: Math.round(peak.percentage),
      videoDuration: Math.round(peak.duration) || null,
      events: peak.events,
      completed: peak.completed,
      firstEventAt: peak.firstEventAt || null,
      lastEventAt: peak.lastEventAt || null,
      basis: 'events',
    };
  }

  const seconds = Math.max(0, Number(lead.watchedSeconds) || 0);
  if (seconds > 0) {
    return {
      seconds: Math.round(seconds),
      minutes: Math.round((seconds / 60) * 10) / 10,
      percentage: Math.round(Math.max(0, Number(lead.watchPercentage) || 0)),
      videoDuration: null,
      events: 0,
      completed: false,
      firstEventAt: null,
      lastEventAt: null,
      basis: 'lead',
    };
  }

  return {
    seconds: 0,
    minutes: 0,
    percentage: 0,
    videoDuration: null,
    events: 0,
    completed: false,
    firstEventAt: null,
    lastEventAt: null,
    basis: 'none',
  };
}

/**
 * How far down the funnel this lead got. Derived server-side, once, so the
 * summary cards, the filter and the badge can never disagree.
 *
 * 'sent' vs 'opened' is a real business distinction, not a cosmetic one:
 * focasvsl's reminder job chases a lead who opened but never pressed play.
 */
function engagementOf(lead, watch) {
  if (watch.seconds > 0 && (watch.percentage >= WATCHED_PERCENT || watch.seconds >= WATCHED_SECONDS)) {
    return 'watched';
  }
  if (lead.firstPlayAt || (watch.basis === 'events' && watch.seconds > 0)) return 'played';
  if (lead.firstOpenedAt || lead.openCount > 0) return 'opened';
  if (lead.linkSentAt) return 'sent';
  return 'none';
}

/**
 * Which channel this lead came from.
 *
 * Deal.leadSourceKey is ALREADY canonicalSource() output, written at upsert time
 * — so it is used as-is, and canonicalSource is applied only to the raw value for
 * older rows that predate that backfill.
 *
 * The Task fallback is a DIFFERENT VOCABULARY, not a second source for the same
 * value: Task.leadSource is which ad collection the lead was linked to
 * ('meta'/'web'), whereas the Bigin channel is what a rep actually recorded. So
 * `basis` says which one answered — a 'meta'-derived label must not read as
 * something Bigin asserted.
 */
function resolveLeadSource(deal, taskRow) {
  if (deal) {
    const key = deal.leadSourceKey || canonicalSource(deal.leadSource);
    if (key) return { key, raw: deal.leadSource || null, basis: 'deal' };
  }
  if (taskRow && taskRow.leadSource) {
    const label = taskRow.leadSource === 'meta' ? 'Meta (ad lead)' : 'Web (ad lead)';
    return { key: label, raw: taskRow.leadSource, basis: 'task' };
  }
  return { key: null, raw: null, basis: 'none' };
}

/** Newest deal wins when a phone key has several. */
function indexDeals(deals) {
  const map = new Map();
  for (const deal of deals) {
    if (!deal.contactPhoneKey) continue;
    const prev = map.get(deal.contactPhoneKey);
    if (!prev || new Date(deal.modifiedTime || 0) > new Date(prev.modifiedTime || 0)) {
      map.set(deal.contactPhoneKey, deal);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// The drawer block
// ---------------------------------------------------------------------------

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Contact phone off a Task body — the same field names frontend getContact() tries. */
function contactPhoneOf(body) {
  const bodies = Array.isArray(body) ? body : [body];
  for (const task of bodies) {
    if (!task || typeof task !== 'object') continue;
    const who = task.Who_Id || {};
    const phone =
      task.Phone || task.Mobile || task.Contact_Number || task.Phone_Number || who.phone || who.Phone;
    if (phone) return phone;
  }
  return null;
}

// How long the lead drawer will wait for the VSL cluster before giving up on the
// panel. The connection already fails server selection in ~3s, but a cluster that
// is REACHABLE AND SLOW would not trip that at all — it would just hold the
// drawer open. Watch time is the least important thing on that screen, so it gets
// a hard ceiling and never the rep's patience.
const DRAWER_TIMEOUT_MS = Number(process.env.VSL_DRAWER_TIMEOUT_MS || 2500);

/** Resolve to `null` rather than hanging, if the work outruns its budget. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[vsl] watch block timed out after ${ms}ms — panel omitted`);
        resolve(null);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The `vsl` block on a lead-detail response, or null.
 *
 * Null — never an object of nulls — on EVERY unhappy path: unconfigured, a phone
 * too short to join, no VSL record for this person, or a VSL cluster too slow to
 * answer in time. The drawer renders the section only when this is truthy, so "we
 * have nothing" shows as an absent panel rather than a row of dashes.
 */
function buildVslBlock(taskDoc) {
  if (!isConfigured() || !taskDoc) return Promise.resolve(null);
  return withTimeout(loadVslBlock(taskDoc), DRAWER_TIMEOUT_MS);
}

async function loadVslBlock(taskDoc) {
  const VslLead = require('../models/VslLead')();
  if (!VslLead) return null;

  const pk = taskDoc.phoneKey || phoneKey(taskDoc.phone) || phoneKey(contactPhoneOf(taskDoc.body));
  if (!pk) return null; // under 10 digits — unjoinable by design, never key10()

  // Equality first so it can use vsl_leads' phone_unique index.
  const candidates = CC ? [pk, CC + pk] : [pk];
  let lead = await VslLead.findOne({ phone: { $in: candidates } }, LEAD_FIELDS).lean();
  if (!lead) {
    // The prefix guess missed — a foreign number, or one stored in 00 form. An
    // unindexed scan, but bounded by LEAD count (not events) and only reached
    // when the fast path found nothing.
    lead = await VslLead.findOne({ phone: new RegExp(`${escapeRe(pk)}$`) }, LEAD_FIELDS).lean();
  }
  if (!lead) return null; // never sent the video — section absent, not empty

  const peak = (await getPeakMap()).get(lead.leadId) || null;
  const watch = shapeWatch(lead, peak);

  // Lead source off the deal, exactly as the tab does, so both panels agree.
  const Deal = require('../../calls/models/Deal');
  const deal = await Deal.findOne(
    { contactPhoneKey: pk },
    { contactPhoneKey: 1, leadSource: 1, leadSourceKey: 1, modifiedTime: 1 }
  )
    .sort({ modifiedTime: -1 })
    .lean();

  return {
    leadId: lead.leadId,
    phone: lead.phone || null,
    name: lead.name || null,
    source: lead.source || null,
    createdAt: lead.createdAt || null,
    linkSentAt: lead.linkSentAt || null,
    linkSendStatus: lead.linkSendStatus || null,
    firstOpenedAt: lead.firstOpenedAt || null,
    lastOpenedAt: lead.lastOpenedAt || null,
    openCount: lead.openCount || 0,
    firstPlayAt: lead.firstPlayAt || null,
    lastActivityAt: lead.lastActivityAt || null,
    lastEventType: lead.lastEventType || null,
    reminderState: lead.reminderState || null,
    reminderSentAt: lead.reminderSentAt || null,
    watch,
    engagement: engagementOf(lead, watch),
    leadSource: resolveLeadSource(deal, { leadSource: taskDoc.leadSource }),
  };
}

module.exports = {
  buildVslBlock,
  shapeWatch,
  engagementOf,
  resolveLeadSource,
  indexDeals,
  contactPhoneOf,
  LEAD_FIELDS,
  WATCHED_SECONDS,
  WATCHED_PERCENT,
};
