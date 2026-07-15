/**
 * POST /webhook/wati — inbound WhatsApp events.
 *
 * This is the file that turns a send count into a funnel. Everything the dashboard
 * knows about delivery, reads, replies and opt-outs arrives here.
 *
 * ── Three rules this handler follows, each learned the hard way ──────────────────
 *
 * 1. STORE THE RAW BODY BEFORE UNDERSTANDING IT. WATI's payloads differ per event
 *    type, are under-documented, and change without notice. If we only kept our
 *    parsed interpretation, the day a new shape arrives we'd have silently dropped
 *    the data with no way to replay it. So: write raw, then parse.
 *
 * 2. ALWAYS ANSWER 200. A webhook that 500s gets retried — and a retry storm from
 *    WATI during a 5,000-message campaign will bury the server. We accept the event,
 *    then deal with our own problems on our own time.
 *
 * 3. NEVER MOVE A MESSAGE BACKWARDS. Events arrive out of order: `delivered` lands
 *    after `read` more often than you'd think. Status is a rank that only climbs;
 *    the timestamps carry the real times.
 */

const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Contact = require('../models/Contact');
const MessageEvent = require('../models/MessageEvent');
const Suppression = require('../models/Suppression');
const WatiWebhook = require('../models/WatiWebhook');
const { normalizeNumber } = require('../services/watiApi');

// A status webhook can only be attributed to a message we sent recently. Without a
// window, a `read` event with a mangled id would attach itself to a campaign from
// last March and quietly inflate its numbers forever.
const STATUS_WINDOW_HOURS = Number(process.env.CAMPAIGN_ATTRIBUTION_HOURS || 72);
// Replies get a longer one — people do answer a campaign a week later, and that
// reply is genuinely attributable to it.
const REPLY_WINDOW_DAYS = Number(process.env.CAMPAIGN_REPLY_ATTRIBUTION_DAYS || 14);

/**
 * Map a WATI eventType to one of ours by KEYWORD, not by an exact string.
 *
 * This is deliberately not a lookup table, because WATI's real event names are a
 * moving target. The live account fires: templateMessageSent, sentMessageDELIVERED,
 * sentMessageREAD, sentMessageREPLIED, message, newContactMessageReceived,
 * templateMessageFailed, sessionMessageFailed, ctaButtonClicked — PLUS a parallel
 * "v2" set (sentMessageDELIVERED_v2, …) that carries the same meaning in a different
 * payload shape. An exact-match table would silently drop half of those the moment
 * WATI renamed one or shipped a v3, and a dropped status event means an empty funnel
 * with no error to point at. Keywords survive the renames.
 *
 * ORDER MATTERS. "sentMessageREPLIED" contains both "sent" and "repli"; "sentMessage
 * DELIVERED" contains "sent" and "deliver". The specific signal has to be tested
 * before the generic "sent", or every status would collapse to 'sent'.
 */
function classify(rawEventType) {
  const s = String(rawEventType || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s) return undefined;

  // Agent-typed outbound free-text. Not a campaign event, and it must be ruled out
  // before the "sent" keyword below claims it.
  if (s.includes('session') && (s.includes('sent') || s.includes('message'))) {
    if (s.includes('fail')) return null; // a failed agent message still isn't ours
    return null;
  }

  if (s.includes('fail')) return 'failed';
  if (s.includes('repli')) return 'replied';
  if (s.includes('read')) return 'read';
  if (s.includes('deliver')) return 'delivered';

  // A tap on a template's built-in URL/quick-reply button. This is a genuine click
  // signal, and for templates whose links live in the button (not in a variable) it
  // is the ONLY click signal — the /r/ redirect only sees URLs we injected ourselves.
  if (s.includes('button') || s.includes('cta')) return 'clicked';

  // Inbound message from the contact. "message" exactly, or "newContactMessage…".
  if (s === 'message' || s.includes('received') || s.includes('newcontact')) return 'replied';

  // templateMessageSent — our own send, echoed back. Harmless (idempotent, forward-
  // only) but recorded so the sent count reconciles even for messages fired elsewhere.
  if (s.includes('sent')) return 'sent';

  // callStatus, paymentCaptured — real WATI events, just nothing to do with campaigns.
  return undefined;
}

function eventTypeOf(body) {
  const byName = classify(body.eventType || body.type || body.event);
  if (byName !== undefined) return byName;

  // Fallback: some payloads carry the state in a status field instead of the name.
  const status = String(body.status || body.statusString || '').toLowerCase();
  if (['sent', 'delivered', 'read', 'failed'].includes(status)) return status;

  return undefined; // unknown — caller stores it raw and moves on
}

/** WATI is inconsistent about where the message id lives. Look everywhere it has been. */
function messageIdOf(body) {
  return (
    body.whatsappMessageId ||
    body.messageId ||
    body.id ||
    (body.message && (body.message.whatsappMessageId || body.message.id)) ||
    null
  );
}

function phoneOf(body) {
  const raw =
    body.waId || body.whatsappNumber || body.phone || body.senderNumber || body.number || null;
  return raw ? normalizeNumber(raw) : null;
}

function textOf(body) {
  return body.text || body.body || (body.message && body.message.text) || '';
}

/**
 * Did they ask us to stop?
 *
 * Deliberately generous, and deliberately NOT a substring match. "STOP" as a whole
 * word is an opt-out; "don't stop sending me these" is not, and a naive
 * `text.includes('stop')` would suppress a happy customer. Anchored, short messages
 * only — nobody writes a paragraph to unsubscribe.
 */
const OPT_OUT_RE = /^\s*(stop|unsubscribe|opt\s*out|optout|remove\s*me|do\s*not\s*(message|contact|disturb)|dnd|no\s*more\s*(messages|msgs))\s*[.!]*\s*$/i;

function isOptOut(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (t.length > 40) return false;
  return OPT_OUT_RE.test(t);
}

/**
 * Find the CampaignMessage an event belongs to.
 *
 * The provider message id is the real answer. The phone-number fallback exists
 * because WATI's send response does not always include an id — and without a
 * fallback, those campaigns would show zero delivered forever.
 *
 * The fallback is LAST-TOUCH within a time window: the most recent campaign message
 * we sent to that number. It is an inference, not a fact, and it is why the window
 * exists. An event that can't be tied to a recent send is left unattributed rather
 * than pinned on the nearest campaign.
 */
async function resolveMessage(watiMessageId, phoneKey, type) {
  if (watiMessageId) {
    const hit = await CampaignMessage.findOne({ watiMessageId });
    if (hit) return hit;
  }

  if (!phoneKey) return null;

  const windowMs =
    type === 'replied'
      ? REPLY_WINDOW_DAYS * 86400000
      : STATUS_WINDOW_HOURS * 3600 * 1000;

  return CampaignMessage.findOne({
    phoneKey,
    sentAt: { $ne: null, $gte: new Date(Date.now() - windowMs) },
  }).sort({ sentAt: -1 });
}

/** Apply an event to a message, its contact, and its campaign. Forward-only. */
async function applyEvent(msg, type, body, occurredAt) {
  // A CTA/button tap is a click, not a status. It never moves the status ladder (a
  // click must not demote a message that was already replied), it just records intent.
  // The unique (watiMessageId, 'clicked') event index upstream means a repeated tap on
  // the same message is already deduped before we get here — so this is a first click.
  if (type === 'clicked') {
    const isFirst = !msg.clickCount;
    await CampaignMessage.updateOne(
      { _id: msg._id },
      {
        $inc: { clickCount: 1 },
        ...(msg.firstClickAt ? {} : { $set: { firstClickAt: occurredAt } }),
      }
    );
    if (isFirst) {
      // stats.clicked is UNIQUE clickers, so it only moves on the first click — same
      // rule the /r/ redirect follows, so the two click sources stay consistent.
      await Promise.all([
        Campaign.updateOne({ _id: msg.campaignId }, { $inc: { 'stats.clicked': 1 } }),
        Contact.updateOne(
          { _id: msg.contactId },
          { $inc: { 'stats.clicked': 1 }, $set: { lastClickAt: occurredAt } }
        ),
      ]);
    }
    return;
  }

  const stampField = {
    sent: 'sentAt',
    delivered: 'deliveredAt',
    read: 'readAt',
    replied: 'repliedAt',
    failed: 'failedAt',
  }[type];

  const set = {};
  // The timestamp is recorded even when the status doesn't move — a `delivered` that
  // arrives after a `read` still tells us when delivery happened, and that's what the
  // best-send-time histogram is built from.
  if (stampField && !msg[stampField]) set[stampField] = occurredAt;

  if (type === 'replied') {
    if (!msg.replyText) set.replyText = String(textOf(body)).slice(0, 500);
  }
  if (type === 'failed') {
    set.errorMessage = String(body.failedDetail || body.error || 'WhatsApp rejected the message').slice(0, 300);
    set.errorCode = String(body.errorCode || body.failedCode || '') || null;
  }

  // Backfill the stages a later event PROVES already happened. A reply cannot occur
  // unless the message was delivered and seen; a read cannot occur unless it was
  // delivered. WATI does not reliably send every intermediate event — and `read`
  // never fires at all if the contact has read receipts switched off — so without
  // this the funnel shows impossible states like "1 replied, 0 delivered". Each
  // backfill is guarded by the stamp being absent, which is also what stops it
  // double-counting when the real delivered/read webhook turns up later (by then the
  // stamp is set, and the forward-only status means that event no longer advances).
  const backfillInc = {};
  const implied = type === 'replied' ? ['delivered', 'read'] : type === 'read' ? ['delivered'] : [];
  for (const stage of implied) {
    const field = stage === 'delivered' ? 'deliveredAt' : 'readAt';
    if (!msg[field] && !set[field]) {
      set[field] = occurredAt;
      backfillInc[`stats.${stage}`] = 1;
    }
  }

  const advances = CampaignMessage.advances(msg.status, type);
  if (advances) set.status = type;

  if (Object.keys(set).length) {
    await CampaignMessage.updateOne({ _id: msg._id }, { $set: set });
  }

  // Campaign and contact counters move only on a real forward transition (so a
  // retried webhook can't inflate them), plus any stages a reply/read just proved.
  const inc = { ...backfillInc };
  if (advances) {
    if (type === 'delivered') inc['stats.delivered'] = 1;
    if (type === 'read') inc['stats.read'] = 1;
    if (type === 'replied') inc['stats.replied'] = 1;
    if (type === 'failed') {
      inc['stats.failed'] = 1;
      inc['stats.queued'] = -1;
    }
  }

  if (Object.keys(inc).length) {
    await Promise.all([
      Campaign.updateOne({ _id: msg.campaignId }, { $inc: inc }),
      Contact.updateOne({ _id: msg.contactId }, { $inc: inc }),
    ]);
  }
}

/** A number WhatsApp says is unreachable is a number we must stop paying to message. */
const DEAD_NUMBER_RE = /not.*(exist|valid|whatsapp)|invalid.*number|no.*whatsapp|unreachable/i;

async function handleFailure(msg, body) {
  const detail = String(body.failedDetail || body.error || '');
  if (!DEAD_NUMBER_RE.test(detail)) return;

  await Promise.all([
    Contact.updateOne(
      { _id: msg.contactId },
      { $set: { invalid: true, invalidReason: detail.slice(0, 200) } }
    ),
    Suppression.updateOne(
      { phoneKey: msg.phoneKey },
      { $setOnInsert: { reason: 'invalid_number', evidence: detail.slice(0, 200) } },
      { upsert: true }
    ).catch(() => {}),
  ]);
}

async function optOut(contactId, phoneKey, text, campaignId) {
  await Promise.all([
    Contact.updateOne(
      contactId ? { _id: contactId } : { phoneKey },
      {
        $set: {
          optedOut: true,
          optedOutAt: new Date(),
          optOutReason: 'replied_stop',
        },
      }
    ),
    // The phone-level record. This is the one that survives a contact being deleted
    // or re-imported from a fresh CSV next month.
    Suppression.updateOne(
      { phoneKey },
      {
        $setOnInsert: {
          reason: 'replied_stop',
          evidence: String(text).slice(0, 200),
          campaignId: campaignId || null,
        },
      },
      { upsert: true }
    ).catch(() => {}),
  ]);

  console.log(`[campaigns] ${phoneKey} opted out ("${String(text).trim().slice(0, 30)}")`);
}

async function receive(req, res) {
  const body = req.body || {};

  // Answer first. Everything below is our problem, not WATI's, and a slow handler
  // during a big campaign turns into a retry storm.
  res.json({ success: true });

  const type = eventTypeOf(body);
  const watiMessageId = messageIdOf(body);
  const phoneKey = phoneOf(body);

  const record = await WatiWebhook.create({
    eventType: String(body.eventType || body.type || 'unknown'),
    watiMessageId,
    phoneKey,
    body,
    handled: false,
  }).catch(() => null);

  const finish = async (reason) => {
    if (record) {
      await WatiWebhook.updateOne(
        { _id: record._id },
        { $set: { handled: !reason, reason: reason || null } }
      ).catch(() => {});
    }
  };

  try {
    if (type === undefined) return finish('unknown_event');
    if (type === null) return finish('ignored_event'); // known, but not ours
    if (!phoneKey && !watiMessageId) return finish('no_identifier');

    const occurredAt = body.timestamp
      ? new Date(Number(body.timestamp) * (String(body.timestamp).length > 10 ? 1 : 1000))
      : new Date();
    const when = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;

    // An inbound message always updates the contact's session window, even when it
    // has nothing to do with a campaign — the 24-hour free-text window is a property
    // of the CONTACT, and the inbox needs it whoever they were talking to.
    if (type === 'replied' && phoneKey) {
      await Contact.updateOne({ phoneKey }, { $set: { lastInboundAt: when } });
    }

    const msg = await resolveMessage(watiMessageId, phoneKey, type);

    // An opt-out counts whether or not we can tie it to a campaign. Someone who says
    // STOP has said STOP; making that conditional on our attribution logic working
    // is exactly the bug that gets a number banned.
    const text = textOf(body);
    if (type === 'replied' && isOptOut(text)) {
      const contact = msg ? { _id: msg.contactId } : await Contact.findOne({ phoneKey }).lean();
      if (contact || phoneKey) {
        await optOut(contact && contact._id, phoneKey, text, msg && msg.campaignId);
      }
    }

    if (!msg) return finish('no_matching_message');

    // The idempotency gate. WATI retries; the unique (watiMessageId, type) index makes
    // the second delivery of the same event a no-op instead of a double count.
    if (watiMessageId) {
      try {
        await MessageEvent.create({
          campaignId: msg.campaignId,
          messageId: msg._id,
          contactId: msg.contactId,
          phoneKey: msg.phoneKey,
          watiMessageId,
          type,
          occurredAt: when,
          raw: body,
        });
      } catch (err) {
        if (err.code === 11000) return finish('duplicate');
        throw err;
      }
    } else {
      await MessageEvent.create({
        campaignId: msg.campaignId,
        messageId: msg._id,
        contactId: msg.contactId,
        phoneKey: msg.phoneKey,
        type,
        occurredAt: when,
        raw: body,
      });
    }

    await applyEvent(msg, type, body, when);
    if (type === 'failed') await handleFailure(msg, body);

    return finish(null);
  } catch (err) {
    console.warn('[wati webhook] failed:', err.message);
    return finish(`error: ${err.message}`.slice(0, 200));
  }
}

module.exports = { receive, isOptOut, eventTypeOf, classify };
