const WebLead = require('../models/WebLead');
const { phoneKey } = require('../../../utils/phone');

// Public web-lead capture, ported from the retired focas-crm
// (backend/src/routes/webLeads.ts). The CRM validated with Zod; the dashboard
// does not depend on Zod and should not start, so the same schema is expressed
// here as a plain field table.

// Every field the endpoint accepts, with its length cap. Anything NOT in this
// table is dropped, which is what keeps a caller from setting the resolution
// fields (phoneKey / resolvedCampaignId / resolvedBy / linkedTaskId) itself —
// those are ours to write, never the submitter's.
const FIELDS = {
  name: 200,
  firstName: 200,
  lastName: 200,
  email: 200, // lenient: an unparseable email is still a lead worth having
  phone: 40,

  // Counseling-form qualification answers.
  caStatus: 100,
  attempt: 100,
  language: 100,
  city: 120,
  state: 120,

  // Attribution carried in from the ad click.
  utmSource: 200,
  utmMedium: 200,
  utmCampaign: 300,
  utmContent: 300,
  utmTerm: 300,
  landingUrl: 2000,
  referrer: 2000,

  biginContactId: 120,
  source: 120, // e.g. "counseling-form"
};

// The honeypot. A hidden field real users never see and never fill; bots fill
// every input they find. Never stored — it is not in FIELDS.
const HONEYPOT = 'company';

/**
 * Validate + shape the submitted body.
 *
 * Deliberately lenient — only length caps, no format checks. The one widening
 * over the Zod original: a number is accepted and stringified, because a lead
 * server that posts `phone: 9876543210` is still handing us a real lead.
 *
 * @returns {{ data: object } | { errors: string[] }}
 */
function parseLead(body) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const data = {};
  const errors = [];

  for (const [field, max] of Object.entries(FIELDS)) {
    const raw = src[field];
    if (raw === undefined || raw === null) continue;

    let value;
    if (typeof raw === 'string') value = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) value = String(raw);
    else {
      errors.push(`${field} must be a string`);
      continue;
    }

    if (value.length > max) {
      errors.push(`${field} must be at most ${max} characters`);
      continue;
    }

    // Empty strings become undefined so a missing field and a blank one are
    // stored identically (and both render as "—" in the UI).
    if (value === '') continue;

    data[field] = value;
  }

  return errors.length ? { errors } : { data };
}

// An attribution service that is not on disk yet is a deployment fact, not a
// per-lead incident — say it once instead of stack-tracing on every capture.
const warnedMissing = new Set();

function warnAttribution(step, leadId, err) {
  if (err && err.code === 'MODULE_NOT_FOUND') {
    if (warnedMissing.has(step)) return;
    warnedMissing.add(step);
    console.warn(
      `Web lead attribution: ${step} is unavailable — leads are still being captured, unattributed.`,
    );
    return;
  }
  console.warn(`Web lead ${leadId}: ${step} failed:`, err.message);
}

/**
 * Attribute a stored lead: which campaign did it come from, and which Task is
 * it? Both resolvers belong to task 5 and are required LAZILY so this route
 * boots (and keeps capturing leads) even if they are missing or broken.
 *
 * NOTHING in here may throw. A lead is worth more than its attribution: the row
 * is already saved by the time this runs, and a failure here costs us a join,
 * not a customer.
 */
async function attribute(lead) {
  const update = {};

  try {
    if (lead.utmCampaign) {
      const { resolveCampaign } = require('../services/campaignResolver');
      const result = await resolveCampaign(lead.utmCampaign);
      update.resolvedCampaignId = (result && result.campaignId) || null;
      update.resolvedBy = (result && result.resolvedBy) || null;
    }
  } catch (err) {
    warnAttribution('campaign resolution', lead._id, err);
  }

  // Separate try block on purpose — a broken linker must not throw away a
  // campaign that resolved fine.
  try {
    const { linkLead } = require('../services/leadLinker');
    const link = await linkLead(lead);
    if (link && link.taskId) update.linkedTaskId = link.taskId;
  } catch (err) {
    warnAttribution('task linking', lead._id, err);
  }

  if (!Object.keys(update).length) return;

  try {
    await WebLead.updateOne({ _id: lead._id }, { $set: update });
  } catch (err) {
    warnAttribution('storing attribution', lead._id, err);
  }
}

/**
 * POST /api/leads/web — public. The Focas landing pages (via the lead server)
 * post captured leads here, along with the UTM tags from the click URL.
 */
async function ingestWebLead(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // Honeypot first, before validation — a bot must not be able to tell a
    // rejection from an acceptance (not even via a 400 on an over-long value),
    // or it learns the trap and retries. Accept silently, store nothing.
    // A blank honeypot is what a real submission looks like (the field is in
    // the form markup, just hidden), so only a filled one is a bot.
    const trap = body[HONEYPOT];
    const trapped = typeof trap === 'string' ? trap !== '' : trap !== undefined && trap !== null;
    if (trapped) {
      return res.status(202).json({ success: true, ok: true });
    }

    const parsed = parseLead(body);
    if (parsed.errors) {
      return res
        .status(400)
        .json({ success: false, message: 'Invalid request', errors: parsed.errors });
    }

    // Derived here rather than in attribute(): it is pure string work that
    // cannot fail, so the join key is on the row even if attribution dies.
    const data = { ...parsed.data, phoneKey: phoneKey(parsed.data.phone) };

    const lead = await WebLead.create(data);

    // Awaited so the row is attributed by the time we answer, but wrapped so
    // that no failure inside can turn a captured lead into an error response.
    await attribute(lead).catch((err) =>
      console.warn(`Web lead ${lead._id}: attribution failed:`, err.message),
    );

    // `ok` is kept alongside the dashboard's `success` for the lead server,
    // which was written against the CRM's response shape.
    return res.status(201).json({ success: true, ok: true, id: lead.id });
  } catch (err) {
    console.error('Web lead ingest failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to capture lead' });
  }
}

/**
 * GET /api/leads/web — stored web leads, newest first.
 *
 * NOT public: every row is raw lead PII. The CRM served this openly; that was a
 * defect, and it is fixed here (JWT + admin, enforced by the router).
 */
async function listWebLeads(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
    const leads = await WebLead.find().sort({ createdAt: -1 }).limit(limit);
    return res.json({ success: true, count: leads.length, data: leads });
  } catch (err) {
    console.error('List web leads failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to list web leads' });
  }
}

module.exports = { ingestWebLead, listWebLeads, parseLead, FIELDS };
