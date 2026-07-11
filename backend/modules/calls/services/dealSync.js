const zoho = require('../../../services/zoho');
const Task = require('../../../models/Task');
const { key10 } = require('./callStore');

const WON_STAGE = process.env.BIGIN_WON_STAGE || 'Closed with Sale';

/** Every deal in Bigin at the "Closed with Sale" stage. */
async function fetchWonDeals() {
  const deals = [];
  let page = 1;

  for (;;) {
    const r = await zoho.apiGet(`/Deals?per_page=200&page=${page}`);
    if (!r.ok) throw new Error(r.error || 'Failed to fetch deals from Bigin');
    const rows = (r.json && r.json.data) || [];
    for (const d of rows) if (d.Stage === WON_STAGE) deals.push(d);
    if (!r.json.info || !r.json.info.more_records) break;
    page += 1;
  }
  return deals;
}

/**
 * Resolve each contact id to a phone number.
 * Uses our own leads DB first (free), then falls back to Bigin for contacts we
 * never imported (they had no follow-up tasks). Zoho calls are throttled+cached.
 */
async function resolveContactPhones(contactIds) {
  const map = new Map(); // contactId -> { phone, name }

  const leads = await Task.find(
    { 'body.Who_Id.id': { $in: contactIds } },
    { phone: 1, 'body.Who_Id': 1 }
  ).lean();

  for (const l of leads) {
    const who = (l.body && l.body.Who_Id) || {};
    const phone = l.phone || who.phone;
    if (who.id && phone) map.set(String(who.id), { phone, name: who.name || null });
  }

  const missing = contactIds.filter((id) => !map.has(String(id)));
  let fetched = 0;
  for (const id of missing) {
    const c = await zoho.getContact(id);
    if (c.ok && c.phone) {
      map.set(String(id), { phone: c.phone, name: c.name || null });
      fetched += 1;
    }
  }

  return { map, missingCount: missing.length, fetchedFromBigin: fetched };
}

/**
 * Build a lookup: normalised phone key -> the deal for that contact.
 * If a contact has several won deals, keep the most recently closed one.
 */
async function buildWonPhoneMap() {
  const deals = await fetchWonDeals();

  const contactIds = [
    ...new Set(deals.map((d) => d.Contact_Name && d.Contact_Name.id).filter(Boolean)),
  ];
  const { map: phoneByContact, missingCount, fetchedFromBigin } =
    await resolveContactPhones(contactIds);

  const byPhone = new Map();
  for (const d of deals) {
    const cid = d.Contact_Name && d.Contact_Name.id;
    if (!cid) continue;
    const contact = phoneByContact.get(String(cid));
    if (!contact || !contact.phone) continue;

    const k = key10(contact.phone);
    if (!k) continue;

    const entry = {
      id: d.id,
      name: d.Deal_Name || null,
      stage: d.Stage,
      closingDate: d.Closing_Date || null,
      amount: Number(d.Amount) || 0,
      ownerName: (d.Owner && d.Owner.name) || null,
      ownerEmail: (d.Owner && d.Owner.email && d.Owner.email.toLowerCase()) || null,
      contactId: String(cid),
      contactName: contact.name || (d.Contact_Name && d.Contact_Name.name) || null,
    };

    const prev = byPhone.get(k);
    if (!prev || String(entry.closingDate || '') > String(prev.closingDate || '')) {
      byPhone.set(k, entry);
    }
  }

  return {
    byPhone,
    dealCount: deals.length,
    contactCount: contactIds.length,
    resolvedPhones: phoneByContact.size,
    missingCount,
    fetchedFromBigin,
  };
}

module.exports = { fetchWonDeals, resolveContactPhones, buildWonPhoneMap, WON_STAGE };
