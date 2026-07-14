const zoho = require('../../../services/zoho');
const Task = require('../../../models/Task');
const Deal = require('../models/Deal');
const Call = require('../models/Call');
const { phoneKey } = require('./callStore');

const WON_STAGE = process.env.BIGIN_WON_STAGE || 'Closed with Sale';
const LOST_STAGE = process.env.BIGIN_LOST_STAGE || 'Closed without Sale';

// Which calls do we spend money transcribing?
//   won    -> only calls on deals that closed with a sale   (cheapest)
//   closed -> won + lost                                     (enables comparison)
//   all    -> every recorded call                            (full coverage)
const SCOPE = (process.env.TRANSCRIBE_SCOPE || 'won').toLowerCase();
const MIN_DURATION = Number(process.env.TELECMI_MIN_DURATION_SEC || 30);

function outcomeOf(stage) {
  if (stage === WON_STAGE) return 'won';
  if (stage === LOST_STAGE) return 'lost';
  if (/^closed won$/i.test(stage || '')) return 'won';
  if (/^closed lost$/i.test(stage || '')) return 'lost';
  return 'open';
}

/** Should this call be transcribed, given our scope setting? */
function shouldTranscribe(call) {
  if (!call.hasRecording || call.duration < MIN_DURATION) return false;
  if (SCOPE === 'all') return true;
  if (SCOPE === 'closed') return call.outcome === 'won' || call.outcome === 'lost';
  return call.outcome === 'won';
}

/** Resolve a Bigin contact id to a phone (our leads DB first, then Bigin). */
async function contactPhone(contactId, fallbackName) {
  if (!contactId) return null;

  const lead = await Task.findOne(
    { 'body.Who_Id.id': String(contactId) },
    { phone: 1, 'body.Who_Id': 1 }
  ).lean();

  const who = (lead && lead.body && lead.body.Who_Id) || {};
  const phone = (lead && lead.phone) || who.phone;
  if (phone) return { phone, name: who.name || fallbackName || null };

  const c = await zoho.getContact(contactId); // throttled + cached
  if (c.ok && c.phone) return { phone: c.phone, name: c.name || fallbackName || null };
  return null;
}

/** Read the full Bigin deal record. Carries what the webhook payload omits. */
async function fetchDealRecord(dealId) {
  if (!dealId) return null;
  const r = await zoho.apiGet(`/Deals/${dealId}`);
  return (r.ok && r.json && r.json.data && r.json.data[0]) || null;
}

/**
 * What was sold on this deal.
 *
 * The team attaches products in the pipeline, and Bigin stores them in the
 * `Associated_Products` SUBFORM on the deal — not the `/Products` related list
 * we used to read. The subform is also where the money is (list price, quantity,
 * discount, line total), so it's the only source that can answer "which product
 * actually earns".
 *
 * Neither one arrives in the webhook, so this costs a read by deal id.
 */
function productsFromRecord(rec) {
  const rows = (rec && rec.Associated_Products) || [];
  return rows.map((p) => ({
    id: String((p.Product && p.Product.id) || p.id),
    name: (p.Product && p.Product.name) || null,
    quantity: Number(p.Quantity || 0),
    listPrice: Number(p.List_Price || 0),
    discount: Number(p.Discount_Amount || 0),
    total: Number(p.Total || 0), // what the customer actually pays for this line
  }));
}

async function fetchProducts(dealId) {
  return productsFromRecord(await fetchDealRecord(dealId));
}

// owner id -> {email, name}. A handful of salespeople own thousands of deals, so
// this must be cached: uncached, it would be an extra API call on every deal.
const ownerCache = new Map();

/** Bigin writes an unset picklist as the literal "-None-". That is not a reason. */
function cleanReason(v) {
  if (!v) return null;
  const s = String(v).trim();
  return !s || s === '-None-' ? null : s;
}

/**
 * Bigin currency field -> number|null.
 *
 * Not `Number(v) || null`: an instalment genuinely set to 0 is a fact ("nothing
 * left to pay"), and collapsing it to null would make a settled deal look
 * unrecorded — and 0 is exactly how a lead leaves the pending-instalments list.
 * Only a missing/empty/non-numeric value is null.
 */
function cleanMoney(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fill in everything the webhook payload didn't carry.
 *
 * Zoho Flow only sends the fields mapped into the Flow, so every CUSTOM field is
 * missing: `Reasons` (why it was lost), `Up_Scale` (what it was upsold to),
 * `Installment` (the balance still owed), and the `Associated_Products` subform.
 * The owner's email is missing too.
 *
 * All of them live on the deal RECORD, so one read gets the lot:
 *
 *   - products    : every CLOSED deal (the subform is the only source)
 *   - owner email : cached by owner id — one call per NEW salesperson
 *   - lost reason : LOST deals whose payload omitted the field
 *   - up-scale    : any deal whose payload omitted the field
 *   - installment : any deal whose payload omitted the field
 *
 * A closed deal needs the record for products regardless, so the others are
 * free — one API call either way.
 */
async function hydrate(raw, outcome) {
  const owner = raw.Owner || {};
  const ownerId = owner.id ? String(owner.id) : null;
  const closed = outcome === 'won' || outcome === 'lost';

  let email = owner.email ? String(owner.email).toLowerCase() : null;
  let name = owner.name || null;
  let reason = cleanReason(raw.Reasons);
  let upScale = cleanReason(raw.Up_Scale); // same "-None-" convention
  let installment = cleanMoney(raw.Installment); // currency, not a picklist
  let products = [];

  // The poll path seeds the cache, so the webhook path usually pays nothing.
  if (email && ownerId) ownerCache.set(ownerId, { email, name });
  if (!email && ownerId && ownerCache.has(ownerId)) {
    const hit = ownerCache.get(ownerId);
    email = hit.email;
    name = name || hit.name;
  }

  // `undefined` means the payload never had the field (webhook). An explicit
  // null/"-None-" means Bigin told us the picklist is empty — don't ask again.
  const needReason = outcome === 'lost' && raw.Reasons === undefined;
  const needUpScale = raw.Up_Scale === undefined;
  const needInstallment = raw.Installment === undefined;
  const needOwner = !email;
  const needProducts = closed;

  if ((needOwner || needReason || needUpScale || needInstallment || needProducts) && raw.id) {
    const rec = await fetchDealRecord(raw.id);
    if (rec) {
      if (needOwner && rec.Owner && rec.Owner.email) {
        email = String(rec.Owner.email).toLowerCase();
        name = name || rec.Owner.name || null;
        if (ownerId) ownerCache.set(ownerId, { email, name });
      }
      if (needReason) reason = cleanReason(rec.Reasons);
      if (needUpScale) upScale = cleanReason(rec.Up_Scale);
      if (needInstallment) installment = cleanMoney(rec.Installment);
      if (needProducts) products = productsFromRecord(rec);
    }
  }

  return {
    ownerEmail: email,
    ownerName: name,
    products,
    upScale,
    installment,
    // A won deal has no loss reason, whatever Bigin has lying in the field.
    lostReason: outcome === 'lost' ? reason : null,
  };
}

/**
 * Store/refresh a deal from a Bigin record, then re-tag that contact's calls
 * with the outcome and queue any that now qualify for transcription.
 */
async function upsertDeal(raw, source = 'poll') {
  const contactId = raw.Contact_Name && raw.Contact_Name.id;
  const resolved = await contactPhone(contactId, raw.Contact_Name && raw.Contact_Name.name);

  const outcome = outcomeOf(raw.Stage);
  const extra = await hydrate(raw, outcome);

  const doc = {
    zohoId: String(raw.id),
    name: raw.Deal_Name || null,
    stage: raw.Stage || null,
    outcome,
    products: extra.products,
    closingDate: raw.Closing_Date || null,
    amount: Number(raw.Amount) || 0,
    lostReason: extra.lostReason,
    upScale: extra.upScale,
    installment: extra.installment,
    ownerName: extra.ownerName,
    ownerEmail: extra.ownerEmail,
    contactId: contactId ? String(contactId) : null,
    contactName: (resolved && resolved.name) || (raw.Contact_Name && raw.Contact_Name.name) || null,
    contactPhone: (resolved && resolved.phone) || null,
    contactPhoneKey: phoneKey((resolved && resolved.phone) || null),
    modifiedTime: raw.Modified_Time ? new Date(raw.Modified_Time) : new Date(),
    source,
  };

  const deal = await Deal.findOneAndUpdate({ zohoId: doc.zohoId }, doc, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  const tagged = await tagCallsForDeal(deal);

  // The journeys view is served from a snapshot — drop it so a newly closed deal
  // shows up on the next page load instead of after the TTL.
  require('./journeyCache').invalidate();

  return { deal, tagged };
}

/**
 * Attach the deal + outcome to every call for that contact, and queue transcription.
 *
 * Only CLOSED deals tag calls. An "open" deal must never overwrite a won/lost
 * tag — a contact can have several deals (e.g. one closed, one still open), and
 * the open one moving through stages would otherwise wipe out the real outcome.
 */
async function tagCallsForDeal(deal) {
  if (deal.outcome !== 'won' && deal.outcome !== 'lost') return 0;
  const k = deal.contactPhoneKey || phoneKey(deal.contactPhone);
  if (!k) return 0;

  // Indexed equality on the call's precomputed phone keys (any leg matched) —
  // replaces three regex-suffix scans of the whole calls collection.
  const calls = await Call.find({ phoneKeys: k });

  const embedded = {
    id: deal.zohoId,
    name: deal.name,
    stage: deal.stage,
    closingDate: deal.closingDate,
    amount: deal.amount,
    ownerName: deal.ownerName,
    ownerEmail: deal.ownerEmail,
    contactId: deal.contactId,
    contactName: deal.contactName,
    lostReason: deal.lostReason || null,
  };

  let n = 0;
  for (const call of calls) {
    call.deal = embedded;
    call.outcome = deal.outcome;
    call.isClosedWon = deal.outcome === 'won';

    // Don't disturb finished/in-flight work.
    if (call.transcriptionStatus !== 'done' && call.transcriptionStatus !== 'processing') {
      call.transcriptionStatus = shouldTranscribe(call) ? 'pending' : 'skipped';
    }
    await call.save();
    n += 1;
  }
  return n;
}

/** Pull deals modified since a given time (reconcile poll / safety net). */
async function fetchDealsModifiedSince(since) {
  const deals = [];
  let page = 1;

  for (;;) {
    const r = await zoho.apiGet(`/Deals?per_page=200&page=${page}&sort_by=Modified_Time&sort_order=desc`);
    if (!r.ok) throw new Error(r.error || 'Failed to fetch deals');
    const rows = (r.json && r.json.data) || [];
    if (!rows.length) break;

    let reachedOlder = false;
    for (const d of rows) {
      const mt = new Date(d.Modified_Time || d.Created_Time).getTime();
      if (mt < since) {
        reachedOlder = true;
        break;
      }
      deals.push(d);
    }
    if (reachedOlder || !r.json.info || !r.json.info.more_records) break;
    page += 1;
  }
  return deals;
}

module.exports = {
  upsertDeal,
  fetchProducts,
  tagCallsForDeal,
  fetchDealsModifiedSince,
  shouldTranscribe,
  outcomeOf,
  SCOPE,
  WON_STAGE,
  LOST_STAGE,
};
