/**
 * Compile a stored, declarative Segment rule into a Mongo filter on Contact.
 *
 * The rule is DATA, never a query. A stored Mongo query would let anyone who can
 * write a segment run `$where` / `$function` — arbitrary JavaScript, server-side.
 * So we accept a small, closed vocabulary of fields and operators, and anything we
 * do not recognise is dropped rather than passed through.
 *
 * Rule shape:
 *   { match: 'all' | 'any', conditions: [ { field, op, value, campaignId? } ] }
 *
 * Engagement conditions ("read my October blast but never clicked") cannot be
 * expressed as a filter on Contact — they live in CampaignMessage. Those are resolved
 * first, into a set of contact ids, and folded back in as `_id: { $in: [...] }`.
 * That is why compile() is async.
 */

const mongoose = require('mongoose');
const CampaignMessage = require('../models/CampaignMessage');
const { stateFilter } = require('./funnel');

// Everything a condition is allowed to touch. Anything not on this list is ignored.
const FIELDS = {
  tags: { type: 'array' },
  source: { type: 'string' },
  ownerEmail: { type: 'string' },
  name: { type: 'string' },
  email: { type: 'string' },
  phoneKey: { type: 'string' },
  lastCampaignAt: { type: 'date' },
  lastClickAt: { type: 'date' },
  lastInboundAt: { type: 'date' },
  createdAt: { type: 'date' },
  'stats.sent': { type: 'number' },
  'stats.delivered': { type: 'number' },
  'stats.read': { type: 'number' },
  'stats.replied': { type: 'number' },
  'stats.clicked': { type: 'number' },
  'stats.failed': { type: 'number' },
};

function isAllowedField(field) {
  if (FIELDS[field]) return true;
  // Arbitrary CSV columns land under attributes.*, so those are allowed by prefix —
  // but only one level deep, and no operator characters, so `attributes.$where` and
  // `attributes.a.b.$ne` can't sneak through.
  return /^attributes\.[A-Za-z0-9_ -]{1,64}$/.test(field);
}

function toDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Escape a user string before it becomes a regex. Otherwise "(" is a syntax error and ".*" is a scan. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One condition -> one Mongo clause, or null if we don't understand it. */
function clauseFor(cond) {
  if (!cond || !cond.field || !isAllowedField(cond.field)) return null;
  const { field, op, value } = cond;

  switch (op) {
    case 'eq':
      return { [field]: value };
    case 'ne':
      return { [field]: { $ne: value } };
    case 'contains':
      return { [field]: { $regex: escapeRegex(value), $options: 'i' } };
    case 'in':
      return { [field]: { $in: [].concat(value || []) } };
    case 'nin':
      return { [field]: { $nin: [].concat(value || []) } };
    case 'exists':
      return { [field]: { $nin: [null, ''] } };
    case 'missing':
      return { $or: [{ [field]: null }, { [field]: '' }, { [field]: { $exists: false } }] };
    case 'gt':
      return { [field]: { $gt: Number(value) } };
    case 'lt':
      return { [field]: { $lt: Number(value) } };
    case 'before': {
      const d = toDate(value);
      return d ? { [field]: { $lt: d } } : null;
    }
    case 'after': {
      const d = toDate(value);
      return d ? { [field]: { $gt: d } } : null;
    }
    case 'never':
      // "Never messaged" is null, not absent — a contact created before the field
      // existed has no key at all, and $lt would silently skip them.
      return { $or: [{ [field]: null }, { [field]: { $exists: false } }] };
    case 'within_days': {
      const days = Number(value);
      if (!Number.isFinite(days) || days <= 0) return null;
      return { [field]: { $gte: new Date(Date.now() - days * 86400000) } };
    }
    case 'not_within_days': {
      const days = Number(value);
      if (!Number.isFinite(days) || days <= 0) return null;
      const cutoff = new Date(Date.now() - days * 86400000);
      return { $or: [{ [field]: null }, { [field]: { $lt: cutoff } }] };
    }
    default:
      return null;
  }
}

/**
 * Resolve an engagement condition into contact ids.
 *   { field: 'engagement', op: 'is' | 'is_not', value: '<funnel state>', campaignId }
 */
async function engagementIds(cond) {
  if (!cond.campaignId || !mongoose.isValidObjectId(cond.campaignId)) return null;
  const campaignId = new mongoose.Types.ObjectId(cond.campaignId);

  const filter = stateFilter(campaignId, cond.value);
  if (!filter) return null;

  const ids = await CampaignMessage.distinct('contactId', filter);
  return { ids, negate: cond.op === 'is_not' };
}

/**
 * The gate. Applied to EVERY compiled segment, unconditionally, and not expressible
 * as a condition — so there is no rule an admin can write, by accident or on purpose,
 * that messages someone who opted out or a number WhatsApp told us is dead.
 *
 * Suppression (the phone-level list) is enforced at import time, by flipping
 * Contact.optedOut, and again per-message in the sender. This is the middle layer.
 */
const CONTACTABLE = { optedOut: false, invalid: false };

/**
 * Compile a rule into a Contact filter.
 * `includeUncontactable` is for the segment PREVIEW only — never for a send — so an
 * admin can see "412 match, 37 of them opted out" instead of a silently short list.
 */
async function compile(rule, { includeUncontactable = false } = {}) {
  const clauses = [];
  const conditions = (rule && rule.conditions) || [];

  for (const cond of conditions) {
    if (cond && cond.field === 'engagement') {
      const res = await engagementIds(cond);
      if (!res) continue;
      clauses.push({ _id: res.negate ? { $nin: res.ids } : { $in: res.ids } });
      continue;
    }

    // "Can I free-text them right now?" — inside WhatsApp's 24h session window.
    if (cond && cond.field === 'sessionOpen') {
      const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
      clauses.push(
        cond.value === false
          ? { $or: [{ lastInboundAt: null }, { lastInboundAt: { $lt: cutoff } }] }
          : { lastInboundAt: { $gte: cutoff } }
      );
      continue;
    }

    const clause = clauseFor(cond);
    if (clause) clauses.push(clause);
  }

  const match = rule && rule.match === 'any' ? '$or' : '$and';

  // An `any` rule with no usable conditions must match NOTHING. Mongo reads `{}` as
  // "everything", so a typo'd rule would otherwise blast the entire contact list.
  if (!clauses.length) {
    const base = includeUncontactable ? {} : CONTACTABLE;
    return rule && rule.match === 'any' && conditions.length ? { _id: null } : base;
  }

  const body = clauses.length === 1 ? clauses[0] : { [match]: clauses };
  return includeUncontactable ? body : { $and: [CONTACTABLE, body] };
}

module.exports = { compile, clauseFor, isAllowedField, FIELDS, CONTACTABLE };
