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

/**
 * Store/refresh a deal from a Bigin record, then re-tag that contact's calls
 * with the outcome and queue any that now qualify for transcription.
 */
async function upsertDeal(raw, source = 'poll') {
  const contactId = raw.Contact_Name && raw.Contact_Name.id;
  const resolved = await contactPhone(contactId, raw.Contact_Name && raw.Contact_Name.name);

  const outcome = outcomeOf(raw.Stage);

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
    ownerName: (raw.Owner && raw.Owner.name) || null,
    ownerEmail: (raw.Owner && raw.Owner.email && raw.Owner.email.toLowerCase()) || null,
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
