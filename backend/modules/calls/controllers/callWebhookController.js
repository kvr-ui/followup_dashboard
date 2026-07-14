const Call = require('../models/Call');
const Deal = require('../models/Deal');
const telecmi = require('../services/telecmi');
const { agentMap, buildLeadIndex, upsertCall, phoneKeysOf } = require('../services/callStore');
const { upsertDeal, shouldTranscribe } = require('../services/dealStore');

/**
 * Normalise a TeleCMI webhook payload into the shape their CDR API returns.
 *
 * The two differ, which is easy to get wrong:
 *   CDR API :  cmiuid   | duration    | agent
 *   Webhook :  cmiuuid  | answeredsec | user
 *
 * Verified against TeleCMI's documented webhook payload:
 *   { type:'cdr', cmiuuid, user:'204_2222223', status:'answered', direction,
 *     from, to, time, answeredsec, record:true, filename, ... }
 */
function normalizeCallPayload(b) {
  if (!b || typeof b !== 'object') return null;

  const cmiuid =
    b.cmiuid || b.cmiuuid || b.call_id || b.conversation_uuid || b.uuid || null;
  if (!cmiuid) return null;

  const agent = b.agent || b.user || b.extension || null;

  return {
    cmiuid: String(cmiuid),
    duration: Number(b.duration ?? b.answeredsec ?? b.billedsec ?? 0),
    billedsec: b.billedsec ?? b.answeredsec ?? 0,
    agent,
    filename: b.filename || null,
    record: b.record === true || b.record === 'true' ? 'true' : 'false',
    from: b.from ?? b.caller ?? null,
    to: b.to ?? b.callee ?? b.destination ?? null,
    time: b.time ?? (b.date ? new Date(b.date).getTime() : Date.now()),
    name: b.name || 'unknown',
    // TeleCMI tells us the direction outright — better than inferring it.
    _direction: b.direction || null,
    _status: b.status || null,
  };
}

/**
 * Background: attach the lead's existing deal outcome to this new call, then
 * decide whether it's worth transcribing.
 *
 * A brand-new call on an already-closed lead must inherit that outcome — the
 * deal webhook fired long ago and won't fire again.
 */
async function afterCallStored(callDoc) {
  try {
    if (!callDoc) return;
    const fresh = await Call.findById(callDoc._id);
    if (!fresh) return;
    if (fresh.transcriptionStatus === 'done' || fresh.transcriptionStatus === 'processing') return;

    // Find the most recently closed deal for any leg of this call — indexed
    // equality on the strict phone keys, served by the compound Deal index.
    const keys = fresh.phoneKeys && fresh.phoneKeys.length ? fresh.phoneKeys : phoneKeysOf(fresh);
    if (keys.length) {
      const deal = await Deal.findOne({
        contactPhoneKey: { $in: keys },
        outcome: { $in: ['won', 'lost'] },
      }).sort({ modifiedTime: -1 });

      if (deal) {
        fresh.outcome = deal.outcome;
        fresh.isClosedWon = deal.outcome === 'won';
        fresh.deal = {
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
      }
    }

    fresh.transcriptionStatus = shouldTranscribe(fresh) ? 'pending' : 'skipped';
    await fresh.save();

    // A new call changes the lead's journey — drop the snapshot.
    require('../services/journeyCache').invalidate();
  } catch (err) {
    console.warn('afterCallStored failed:', err.message);
  }
}

/**
 * POST /webhook/call — TeleCMI fires this when a call completes.
 * Responds immediately; everything slow happens after.
 */
async function receiveCallWebhook(req, res) {
  try {
    if (process.env.LOG_WEBHOOK_PAYLOADS !== 'false') {
      console.log('=== RAW CALL WEBHOOK PAYLOAD ===');
      console.log(JSON.stringify(req.body, null, 2));
      console.log('=== END PAYLOAD ===');
    }

    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const rows = payloads.map(normalizeCallPayload).filter(Boolean);

    if (!rows.length) {
      // 200 so TeleCMI doesn't retry while we adjust the parser.
      console.warn(
        'Call webhook: no recognisable call id. Fields seen:',
        Object.keys(req.body || {}).join(', ')
      );
      return res.status(200).json({
        success: false,
        message: 'Payload received but no call id found',
        fieldsSeen: Object.keys(req.body || {}),
      });
    }

    const agents = agentMap();
    const leadIndex = await buildLeadIndex();

    const saved = [];
    for (const row of rows) {
      const { call } = await upsertCall(row, leadIndex, agents, { minDurationSec: 0 });
      saved.push(call);
    }

    console.log(`Call webhook: ${saved.length} call(s) stored`);
    res.status(200).json({ success: true, count: saved.length });

    // After responding: outcome tagging + transcription queueing.
    saved.forEach(afterCallStored);
  } catch (err) {
    console.error('Call webhook failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to store call' });
  }
}

/**
 * Normalise a deal payload into the Bigin API shape our services expect.
 *
 * Accepts BOTH:
 *  - Bigin's nested API shape:  { id, Deal_Name, Stage, Contact_Name:{id,name}, Owner:{email} }
 *  - Zoho Flow's flat shape:    { deal_id, stage, contact_id, owner_email, ... }
 *
 * Zoho Flow hands you flat variables, and building nested JSON there is a pain —
 * so we take whatever it sends and map it here.
 */
function normalizeDealPayload(b) {
  if (!b || typeof b !== 'object') return null;

  const pick = (...keys) => {
    for (const k of keys) {
      if (b[k] !== undefined && b[k] !== null && b[k] !== '') return b[k];
    }
    return undefined;
  };

  const id = pick('id', 'deal_id', 'dealId', 'pipeline_record_id', 'pipelineRecordId', 'record_id');
  if (!id) return null;

  const contactId = pick('contact_id', 'contactId', 'contactID') ??
    (b.Contact_Name && b.Contact_Name.id);
  const contactName = pick('contact_name', 'contactName') ??
    (b.Contact_Name && b.Contact_Name.name);

  const ownerEmail = pick('owner_email', 'ownerEmail', 'owners_email_address', 'owner_email_address') ??
    (b.Owner && b.Owner.email);
  const ownerName = pick('owner_name', 'ownerName') ?? (b.Owner && b.Owner.name);
  // Zoho Flow sends owner_id but no email. Keep the id so upsertDeal can resolve
  // the email from Bigin — without it the deal has no salesperson to filter by.
  const ownerId = pick('owner_id', 'ownerId') ?? (b.Owner && b.Owner.id);

  // Bigin's CUSTOM fields. Zoho Flow sends only the fields mapped into the Flow, and
  // no custom field is mapped today — so these stay undefined and upsertDeal fetches
  // them by deal id. Left here so that if you DO add them to the Flow, we use them
  // directly and skip the extra API call.
  //
  // undefined (field absent from the payload) and null (field present but empty) mean
  // different things downstream — don't collapse them with `|| null`.
  const reasons = pick('Reasons', 'reasons', 'reason', 'lost_reason', 'lostReason');
  const upScale = pick('Up_Scale', 'up_scale', 'upScale', 'upscale');

  return {
    id: String(id),
    Deal_Name: pick('Deal_Name', 'deal_name', 'dealName', 'name') || null,
    Stage: pick('Stage', 'stage') || null,
    Closing_Date: pick('Closing_Date', 'closing_date', 'closingDate') || null,
    Amount: Number(pick('Amount', 'amount') || 0),
    Reasons: reasons,
    Up_Scale: upScale,
    Owner: {
      id: ownerId ? String(ownerId) : null,
      name: ownerName || null,
      email: ownerEmail || null,
    },
    Contact_Name: contactId ? { id: String(contactId), name: contactName || null } : null,
    Modified_Time:
      pick('Modified_Time', 'modified_time', 'date_and_time_modified', 'modifiedTime') ||
      new Date().toISOString(),
  };
}

/**
 * POST /webhook/deal — Bigin/Zoho Flow fires this when a deal closes.
 * Tags the contact's calls with won/lost and queues transcription.
 */
async function receiveDealWebhook(req, res) {
  try {
    // Log the raw payload — Zoho Flow reshapes field names, so we need to see
    // exactly what arrives before trusting our parser.
    if (process.env.LOG_WEBHOOK_PAYLOADS !== 'false') {
      console.log('=== RAW DEAL WEBHOOK PAYLOAD ===');
      console.log(JSON.stringify(req.body, null, 2));
      console.log('=== END PAYLOAD ===');
    }

    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const deals = payloads.map(normalizeDealPayload).filter(Boolean);

    if (!deals.length) {
      // Still a 200 — we don't want Zoho retrying while we adjust the parser.
      console.warn(
        'Deal webhook: no recognisable deal id. Fields seen:',
        Object.keys(req.body || {}).join(', ')
      );
      return res.status(200).json({
        success: false,
        message: 'Payload received but no deal id found — check field names',
        fieldsSeen: Object.keys(req.body || {}),
      });
    }

    console.log(`Deal webhook: ${deals.length} deal(s)`);
    res.status(200).json({ success: true, count: deals.length });

    // After responding: resolve contact, store deal, re-tag calls.
    (async () => {
      for (const d of deals) {
        try {
          const { deal, tagged } = await upsertDeal(d, 'webhook');
          console.log(
            `  deal ${deal.name} -> ${deal.stage} (${deal.outcome}); tagged ${tagged} call(s)`
          );
        } catch (err) {
          console.warn('  deal upsert failed:', err.message);
        }
      }
    })();
  } catch (err) {
    console.error('Deal webhook failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to store deal' });
  }
}

module.exports = {
  receiveCallWebhook,
  receiveDealWebhook,
  normalizeCallPayload,
  normalizeDealPayload,
};
