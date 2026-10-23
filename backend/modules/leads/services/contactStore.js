// Writing Bigin contacts into our Contact mirror.
//
// Three writers, one shape: the contact webhook (live), the reconcile poll
// (safety net for missed webhooks) and the backfill script (once). All go
// through fromBiginRecord -> upsertContact, keyed on the Bigin contact id, so a
// contact edited in Bigin overwrites itself rather than becoming a second MQL.

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

// LeadChain writes the Meta ad that produced a lead into two REUSED Bigin
// fields (there was no spare custom field): Mailing_Country = campaign id,
// Description = ad set id. LeadChain offers no ad id, so the ad is not tracked. Only an all-digit value is a
// Meta id — anything else is a real country or note someone typed, and is ignored.
const metaId = (v) => {
  const s = text(v);
  return s && /^\d{6,25}$/.test(s) ? s : null;
};

// Every Bigin field fromBiginRecord reads — list endpoints return only what is asked for.
const CONTACT_FIELDS = [
  'Full_Name',
  'First_Name',
  'Last_Name',
  'Phone',
  'Mobile',
  'Email',
  'Lead_Source1',
  'Owner',
  'Created_Time',
  'Modified_Time',
  // Meta campaign / ad set ids LeadChain writes into reused address fields — see metaId.
  'Mailing_Country',
  'Description',
].join(',');

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
    email: text(rec.Email) ? rec.Email.trim().toLowerCase() : null,
    leadSource: text(rec.Lead_Source1),
    metaCampaignId: metaId(rec.Mailing_Country),
    metaAdsetId: metaId(rec.Description),
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
    Email: pick('Email', 'email'),
    Lead_Source1: pick('Lead_Source1', 'lead_source1', 'Lead_Source', 'lead_source', 'leadSource'),
    Mailing_Country: pick('Mailing_Country', 'mailing_country'),
    Description: pick('Description', 'description'),
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

/**
 * Contacts created or edited in Bigin since `since` (ms), newest first — the
 * reconcile poll's read. Zoho Flow drops some webhook deliveries (one of its
 * egress hosts stopped reaching us on 2026-10-22), so the poll is what makes a
 * missed one arrive late instead of never.
 */
async function fetchContactsModifiedSince(since) {
  const contacts = [];
  let page = 1;
  let pageToken = null;

  // Bounded so a paging bug cannot spin forever against Zoho's rate limit.
  for (let i = 0; i < 100; i += 1) {
    const qs = pageToken ? `page_token=${encodeURIComponent(pageToken)}` : `page=${page}`;
    const r = await zoho.apiGet(
      `/Contacts?fields=${CONTACT_FIELDS}&per_page=200&sort_by=Modified_Time&sort_order=desc&${qs}`
    );
    if (!r.ok) throw new Error(r.error || 'Failed to fetch contacts');
    const rows = (r.json && r.json.data) || [];
    if (!rows.length) break;

    let reachedOlder = false;
    for (const c of rows) {
      const mt = new Date(c.Modified_Time || c.Created_Time).getTime();
      if (mt < since) {
        reachedOlder = true;
        break;
      }
      contacts.push(c);
    }
    const info = r.json.info || {};
    if (reachedOlder || !info.more_records) break;
    // Past 2,000 records Bigin v2 pages by token, as in the backfill.
    pageToken = info.next_page_token || null;
    page += 1;
  }
  return contacts;
}

module.exports = {
  CONTACT_FIELDS,
  fromBiginRecord,
  normalizeContactPayload,
  upsertContact,
  syncContactFromWebhook,
  fetchContactsModifiedSince,
};
