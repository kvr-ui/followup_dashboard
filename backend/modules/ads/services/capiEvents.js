// Conversions API — the pure half: which funnel events a Bigin contact has
// reached, and the Meta payload for each. No DB, no network (see capiSync).
//
// THE EVENTS (the UTM Report's funnel rules, services/utmReport)
// ----------
//   Lead      the contact exists              at contact.createdTime
//   MQL       a connected call OR a deal      at the earlier of the two
//   SQL       a deal exists                   at the first deal's creation
//   Purchase  a deal closed with a sale       at that deal's modifiedTime, value = amount (INR)
// Junk is never sent: Meta cannot learn from a negative event.

const crypto = require('crypto');
const { bestDeal } = require('./dealJoin');
const { PLACEHOLDER_PHONES } = require('../../../utils/phone');

// Meta rejects events older than 7 days. An hour of slack so an event never ages
// out between being picked and being sent.
const MAX_AGE_MS = 7 * 24 * 3600 * 1000 - 3600 * 1000;

// Meta lead ids are 15-17 digits; LeadChain's field also holds typed notes.
const META_LEAD_ID = /^\d{12,20}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const time = (v) => (v ? new Date(v).getTime() || 0 : 0);
const earliest = (...ts) => {
  const ok = ts.filter((t) => t > 0);
  return ok.length ? Math.min(...ok) : 0;
};

const dealOpenedAt = (d) => time(d.createdTime) || time(d.createdAt);

/** A test lead: any of its phones is a placeholder number. */
function isTestContact(contact) {
  return (contact.phoneKeys || []).some((k) => PLACEHOLDER_PHONES.has(k));
}

/**
 * The funnel events this contact has reached.
 *
 * @param {object} contact            BiginContact
 * @param {object[]} deals            its deals (any outcome)
 * @param {number} [firstConnectedAt] ms of its first connected call, 0 if none
 * @returns {{event:string, eventTime:Date, value?:number}[]}
 */
function contactEvents(contact, deals = [], firstConnectedAt = 0) {
  const events = [];
  const created = time(contact.createdTime);
  if (created) events.push({ event: 'Lead', eventTime: new Date(created) });

  const sqlAt = earliest(...deals.map(dealOpenedAt));
  const mqlAt = earliest(sqlAt, firstConnectedAt);
  if (mqlAt) events.push({ event: 'MQL', eventTime: new Date(mqlAt) });
  if (sqlAt) events.push({ event: 'SQL', eventTime: new Date(sqlAt) });

  const won = deals.filter((d) => d.outcome === 'won').reduce(bestDeal, null);
  const wonAt = won && (time(won.modifiedTime) || dealOpenedAt(won));
  if (wonAt) {
    events.push({ event: 'Purchase', eventTime: new Date(wonAt), value: Number(won.amount) || 0 });
  }
  return events;
}

const tooOld = (eventTime, now = Date.now()) => now - time(eventTime) > MAX_AGE_MS;

// Meta's normalisation for names: lowercase, letters only.
const nameToken = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}]/gu, '');

/**
 * Meta's user_data for a contact: SHA-256 of normalised phone (91 + 10 digits),
 * email, first/last name and our contact id, plus Meta's own lead id when a deal
 * carries one (not hashed — it is Meta's id). Null when nothing can match.
 */
function userData(contact, deals = []) {
  const ud = {};
  const phones = (contact.phoneKeys || []).filter((k) => !PLACEHOLDER_PHONES.has(k));
  if (phones.length) ud.ph = phones.map((k) => sha256(`91${k}`));
  const email = String(contact.email || '').trim().toLowerCase();
  if (email.includes('@')) ud.em = [sha256(email)];

  const parts = String(contact.name || '').trim().split(/\s+/).map(nameToken).filter(Boolean);
  if (parts.length) ud.fn = [sha256(parts[0])];
  if (parts.length > 1) ud.ln = [sha256(parts[parts.length - 1])];

  const leadId = deals.map((d) => String(d.socialLeadId || '')).find((s) => META_LEAD_ID.test(s));
  if (leadId) ud.lead_id = leadId;

  if (!ud.ph && !ud.em && !ud.lead_id) return null;
  ud.external_id = [sha256(String(contact.zohoId))];
  return ud;
}

/** One Conversions API event, as Meta's /events endpoint takes it. */
function toMetaEvent({ contactId, event, eventTime, value }, user) {
  const custom = { event_source: 'crm', lead_event_source: 'Focas Dashboard' };
  if (event === 'Purchase') Object.assign(custom, { value: value || 0, currency: 'INR' });
  return {
    event_name: event,
    event_time: Math.floor(time(eventTime) / 1000),
    event_id: `${contactId}:${event}`,
    action_source: 'system_generated',
    user_data: user,
    custom_data: custom,
  };
}

module.exports = { MAX_AGE_MS, sha256, isTestContact, contactEvents, tooOld, userData, toMetaEvent };
