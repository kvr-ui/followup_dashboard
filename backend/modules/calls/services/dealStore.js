const zoho = require('../../../services/zoho');
const Task = require('../../../models/Task');
const Deal = require('../models/Deal');
const Call = require('../models/Call');
const { key10 } = require('./callStore');

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

/**
 * Fetch what was sold on this deal.
 * Products are a related list in Bigin (not a field), so they can never arrive
 * via the webhook — we look them up by deal id.
 */
async function fetchProducts(dealId) {
  if (!dealId) return [];
  const r = await zoho.apiGet(`/Deals/${dealId}/Products`);
  if (!r.ok || !r.json || !r.json.data) return [];
  return r.json.data.map((p) => ({
    id: String(p.id),
    name: p.Product_Name || null,
    category: p.Product_Category || null,
    unitPrice: Number(p.Unit_Price ?? p.price ?? 0),
  }));
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
 * Fill in what the payload didn't carry: the owner's email, and why a lost deal
 * was lost.
 *
 * The POLL path gets both from the Bigin API for free. The WEBHOOK path gets
 * neither — Zoho Flow sends owner_id/owner_name but no email, and no `Reasons`
 * field at all. Both are things the dashboard needs (the owner filter, and the
 * loss breakdown), so we re-read the deal by id to get them.
 *
 * One read fills both, and only when something is actually missing:
 *   - owner email: cached by owner id, so it costs one call per NEW salesperson
 *   - lost reason: only fetched for LOST deals whose payload omitted the field
 * A poll that already carries `Reasons` (even as null) never triggers a read.
 */
async function hydrate(raw, outcome) {
  const owner = raw.Owner || {};
  const ownerId = owner.id ? String(owner.id) : null;

  let email = owner.email ? String(owner.email).toLowerCase() : null;
  let name = owner.name || null;
  let reason = cleanReason(raw.Reasons);

  // The poll path seeds the cache, so the webhook path usually pays nothing.
  if (email && ownerId) ownerCache.set(ownerId, { email, name });
  if (!email && ownerId && ownerCache.has(ownerId)) {
    const hit = ownerCache.get(ownerId);
    email = hit.email;
    name = name || hit.name;
  }

  // `undefined` means the payload never had the field (webhook). An explicit
  // null/"-None-" means Bigin told us there is no reason — don't go asking again.
  const needReason = outcome === 'lost' && raw.Reasons === undefined;
  const needOwner = !email;

  if ((needOwner || needReason) && raw.id) {
    const r = await zoho.apiGet(`/Deals/${raw.id}`);
    const rec = r.ok && r.json && r.json.data && r.json.data[0];
    if (rec) {
      if (needOwner && rec.Owner && rec.Owner.email) {
        email = String(rec.Owner.email).toLowerCase();
        name = name || rec.Owner.name || null;
        if (ownerId) ownerCache.set(ownerId, { email, name });
      }
      if (needReason) reason = cleanReason(rec.Reasons);
    }
  }

  return {
    ownerEmail: email,
    ownerName: name,
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

  // Only worth an extra API call for deals that actually closed.
  const products = outcome === 'won' || outcome === 'lost' ? await fetchProducts(raw.id) : [];

  const doc = {
    zohoId: String(raw.id),
    name: raw.Deal_Name || null,
    stage: raw.Stage || null,
    outcome,
    products,
    closingDate: raw.Closing_Date || null,
    amount: Number(raw.Amount) || 0,
    lostReason: extra.lostReason,
    ownerName: extra.ownerName,
    ownerEmail: extra.ownerEmail,
    contactId: contactId ? String(contactId) : null,
    contactName: (resolved && resolved.name) || (raw.Contact_Name && raw.Contact_Name.name) || null,
    contactPhone: (resolved && resolved.phone) || null,
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
  if (!deal.contactPhone) return 0;
  const k = key10(deal.contactPhone);
  if (!k) return 0;

  // Find the contact's calls by matching either leg of the call.
  const calls = await Call.find({
    $or: [
      { leadPhone: { $regex: `${k}$` } },
      { to: { $regex: `${k}$` } },
      { from: { $regex: `${k}$` } },
    ],
  });

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
