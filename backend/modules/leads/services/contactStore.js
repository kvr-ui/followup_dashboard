// Writing Bigin contacts into our Contact mirror.
//
// Two writers, one shape: the contact webhook (live) and the backfill script
// (once). Both go through fromBiginRecord -> upsertContact, keyed on the Bigin
// contact id, so a contact edited in Bigin overwrites itself rather than
// becoming a second MQL.

const Contact = require('../models/Contact');
const zoho = require('../../../services/zoho');
const { phoneKey } = require('../../../utils/phone');

const toDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
};

const text = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

/** A Bigin Contacts record (REST shape) -> our Contact fields. */
function fromBiginRecord(rec) {
  if (!rec || !rec.id) return null;
  const name =
    text(rec.Full_Name) || text([rec.First_Name, rec.Last_Name].filter(Boolean).join(' '));
  const phone = text(rec.Phone);
  const mobile = text(rec.Mobile);
  const owner = rec.Owner || {};
  return {
    zohoId: String(rec.id),
    name,
    phone,
    mobile,
    phoneKeys: [...new Set([phoneKey(phone), phoneKey(mobile)].filter(Boolean))],
    leadSource: text(rec.Lead_Source1),
    ownerName: text(owner.name),
    ownerEmail: text(owner.email) ? owner.email.trim().toLowerCase() : null,
    createdTime: toDate(rec.Created_Time),
    modifiedTime: toDate(rec.Modified_Time),
  };
}

/**
 * A webhook body -> a Bigin-shaped record. Bigin workflow webhooks and Zoho Flow
 * both let whoever sets them up rename the parameters, so the common spellings
 * are accepted. Only the id is required: the webhook handler re-reads the full
 * record from Bigin anyway.
 */
function normalizeContactPayload(b) {
  if (!b || typeof b !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      if (b[k] !== undefined && b[k] !== null && b[k] !== '') return b[k];
    }
    return undefined;
  };
  const id = pick('id', 'contact_id', 'contactId', 'Contact_Id', 'record_id', 'recordId');
  if (!id) return null;
  return {
    id: String(id),
    Full_Name: pick('Full_Name', 'full_name', 'name', 'contact_name'),
    First_Name: pick('First_Name', 'first_name'),
    Last_Name: pick('Last_Name', 'last_name'),
    Phone: pick('Phone', 'phone'),
    Mobile: pick('Mobile', 'mobile'),
    Lead_Source1: pick('Lead_Source1', 'lead_source1', 'Lead_Source', 'lead_source', 'leadSource'),
    Created_Time: pick('Created_Time', 'created_time', 'createdTime'),
    Modified_Time: pick('Modified_Time', 'modified_time', 'modifiedTime'),
    Owner: b.Owner || {
      name: pick('owner_name', 'ownerName'),
      email: pick('owner_email', 'ownerEmail'),
    },
  };
}

/** Upsert by Bigin id. Returns the stored document. */
async function upsertContact(fields, syncedBy) {
  const { zohoId, createdTime, ...rest } = fields;
  const update = { $set: { ...rest, syncedBy } };
  // Created_Time decides the MQL month. A record without one (a thin webhook body
  // and no Bigin read) must not overwrite a known date; a brand-new one is stamped
  // "now" — the webhook fires on create, so that is the right month.
  if (createdTime) update.$set.createdTime = createdTime;
  else update.$setOnInsert = { createdTime: new Date() };
  return Contact.findOneAndUpdate({ zohoId }, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  }).lean();
}

/**
 * The webhook path: prefer Bigin's own copy of the record (the webhook body may
 * carry only some fields, renamed), fall back to the body if Zoho is down.
 */
async function syncContactFromWebhook(payloadRecord) {
  const r = await zoho.apiGet(`/Contacts/${encodeURIComponent(payloadRecord.id)}`);
  const fresh = r.ok && r.json && r.json.data && r.json.data[0];
  if (fresh) return upsertContact(fromBiginRecord(fresh), 'webhook');

  if (!r.skipped) console.warn(`  contact ${payloadRecord.id}: Bigin read failed, using webhook body`);
  // A partial body must not blank out what an earlier full sync stored: keep
  // only the fields it actually carries.
  const fields = fromBiginRecord(payloadRecord);
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || (Array.isArray(v) && !v.length)) delete fields[k];
  }
  return upsertContact({ createdTime: null, ...fields }, 'webhook');
}

module.exports = { fromBiginRecord, normalizeContactPayload, upsertContact, syncContactFromWebhook };
