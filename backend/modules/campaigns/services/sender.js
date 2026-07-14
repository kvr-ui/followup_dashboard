/**
 * Building the send list, and sending it.
 *
 * Two jobs, deliberately split:
 *
 *   materialize(campaign) — turn an audience definition into one CampaignMessage row
 *                           per contact, up front, in the database.
 *   deliver(campaign)     — walk those rows and actually call WATI, slowly.
 *
 * Materialising first is what makes the sender safe to crash. If the process dies
 * halfway through a 5,000-person blast, the queue is still sitting in Mongo with
 * 3,000 rows marked `queued` and 2,000 marked `sent`, and the next tick picks up
 * exactly where it stopped. A sender that streamed straight from a cursor to WATI
 * would, on restart, have no idea who it had already messaged — and the only two
 * options then are to skip people or to message them twice.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Contact = require('../models/Contact');
const MessageEvent = require('../models/MessageEvent');
const Suppression = require('../models/Suppression');
const Segment = require('../models/Segment');

const wati = require('./watiApi');
const segments = require('./segments');
const links = require('./links');
const render = require('./render');
const cost = require('./cost');

// A contact messaged by two campaigns in the same hour reads it as spam and blocks
// the number — and one block is worth more damage than one extra send is worth
// revenue. 0 disables the cap.
const FATIGUE_HOURS = Number(process.env.CAMPAIGN_FATIGUE_HOURS || 0);

/**
 * Which A/B arm a contact belongs to. Hashed, not random, and seeded with the test's
 * id — so the same contact lands in the same arm every time the audience is rebuilt,
 * and a re-run after a crash can't move someone from A to B (which would send them
 * both arms and poison the result).
 */
function bucketOf(contactId, abGroupId) {
  const h = crypto.createHash('md5').update(`${abGroupId}:${contactId}`).digest();
  return h.readUInt32BE(0) % 100;
}

function inThisArm(campaign, contactId) {
  if (!campaign.abGroupId) return true;
  const bucket = bucketOf(contactId, campaign.abGroupId);
  const share = Number(campaign.abSplit) || 50;
  // A takes the bottom of the range, B takes the top. Two arms, no overlap, no gap.
  return campaign.abVariant === 'B' ? bucket >= 100 - share : bucket < share;
}

/** The Contact filter for a campaign's audience. */
async function audienceFilter(campaign, { includeUncontactable = false } = {}) {
  const a = campaign.audience || {};

  if (a.type === 'contacts') {
    const ids = (a.contactIds || []).map((id) => new mongoose.Types.ObjectId(id));
    const base = { _id: { $in: ids } };
    return includeUncontactable ? base : { ...base, ...segments.CONTACTABLE };
  }

  if (a.type === 'all') {
    return includeUncontactable ? {} : { ...segments.CONTACTABLE };
  }

  // 'segment'. Prefer the rule snapshotted onto the campaign over the live Segment:
  // editing a segment must not retroactively rewrite what an already-sent campaign
  // says its audience was.
  let rule = a.rule;
  if (!rule && a.segmentId) {
    const seg = await Segment.findById(a.segmentId).lean();
    rule = seg && seg.rule;
  }
  if (!rule) return { _id: null }; // no rule = nobody, never everybody
  return segments.compile(rule, { includeUncontactable });
}

/** How many people a campaign would go to, without building anything. */
async function previewAudience(campaign) {
  const [contactable, everyone] = await Promise.all([
    audienceFilter(campaign, { includeUncontactable: false }),
    audienceFilter(campaign, { includeUncontactable: true }),
  ]);

  const [matched, total, sample] = await Promise.all([
    Contact.countDocuments(contactable),
    Contact.countDocuments(everyone),
    Contact.find(contactable).limit(200).lean(),
  ]);

  // Only the A/B arm's slice actually gets messaged.
  const inArm = campaign.abGroupId
    ? sample.filter((c) => inThisArm(campaign, String(c._id))).length / (sample.length || 1)
    : 1;

  const recipients = campaign.abGroupId ? Math.round(matched * inArm) : matched;

  return {
    recipients,
    matched,
    // The gap between the two is the honest bit: "412 match, 37 of them opted out".
    excluded: Math.max(total - matched, 0),
    sample: sample.slice(0, 20).map((c) => ({
      id: c._id,
      name: c.name,
      phoneKey: c.phoneKey,
      tags: c.tags,
    })),
    // Which template variables are going to come out blank, and for how many people.
    variableAudit: render.auditVariables(campaign.variables, sample),
    estimatedCost: cost.estimate(campaign.templateCategory, recipients),
    currency: cost.CURRENCY,
  };
}

/**
 * Build the queue. Idempotent: the unique (campaignId, contactId) index means running
 * this twice adds nobody twice, so a retry after a partial failure is always safe.
 */
async function materialize(campaign) {
  const filter = await audienceFilter(campaign);
  const cursor = Contact.find(filter).select('_id phoneKey').lean().cursor();

  const fatigueCutoff = FATIGUE_HOURS
    ? new Date(Date.now() - FATIGUE_HOURS * 3600 * 1000)
    : null;

  let batch = [];
  let queued = 0;
  let skipped = 0;

  const flush = async () => {
    if (!batch.length) return;

    // The phone-level suppression list is the last word, and it is checked against
    // the NUMBER, not the contact — because a fresh CSV import creates a brand new
    // contact row for someone who opted out last month, and Contact.optedOut on that
    // new row is false.
    const keys = batch.map((c) => c.phoneKey);
    const suppressed = new Set(
      await Suppression.distinct('phoneKey', { phoneKey: { $in: keys } })
    );

    const recentlyMessaged = fatigueCutoff
      ? new Set(
          await CampaignMessage.distinct('contactId', {
            contactId: { $in: batch.map((c) => c._id) },
            sentAt: { $gte: fatigueCutoff },
          }).then((ids) => ids.map(String))
        )
      : new Set();

    const docs = batch.map((c) => {
      let skipReason = null;
      if (suppressed.has(c.phoneKey)) skipReason = 'suppressed';
      else if (recentlyMessaged.has(String(c._id))) skipReason = 'fatigue';

      if (skipReason) skipped += 1;
      else queued += 1;

      return {
        campaignId: campaign._id,
        contactId: c._id,
        phoneKey: c.phoneKey,
        templateName: campaign.templateName,
        // Skipped rows are WRITTEN, not omitted. A campaign that quietly drops 340
        // people and reports an audience of 2,660 is lying about its own reach.
        status: skipReason ? 'skipped' : 'queued',
        skipReason,
      };
    });

    try {
      await CampaignMessage.insertMany(docs, { ordered: false });
    } catch (err) {
      // E11000 = this contact already has a row for this campaign. That is the
      // idempotency guard doing its job on a re-run, not a failure.
      if (err.code !== 11000 && !err.writeErrors) throw err;
    }

    batch = [];
  };

  for await (const c of cursor) {
    if (!c.phoneKey) continue;
    if (!inThisArm(campaign, String(c._id))) continue;
    batch.push(c);
    if (batch.length >= 500) await flush();
  }
  await flush();

  // Recount from the collection rather than trusting the counters above: a re-run
  // adds nothing, and its local `queued` would otherwise report 0 and look broken.
  const [totalQueued, totalSkipped] = await Promise.all([
    CampaignMessage.countDocuments({ campaignId: campaign._id, status: 'queued' }),
    CampaignMessage.countDocuments({ campaignId: campaign._id, status: 'skipped' }),
  ]);

  await Campaign.updateOne(
    { _id: campaign._id },
    {
      $set: {
        'stats.audienceSize': totalQueued + totalSkipped,
        'stats.queued': totalQueued,
        'stats.skipped': totalSkipped,
        estimatedCost: cost.estimate(campaign.templateCategory, totalQueued),
      },
    }
  );

  return { queued: totalQueued, skipped: totalSkipped, added: queued, blocked: skipped };
}

/** Send one queued message. Never throws — a single bad number must not stop the batch. */
async function sendOne(campaign, msg) {
  const contact = await Contact.findById(msg.contactId).lean();
  if (!contact) {
    await CampaignMessage.updateOne(
      { _id: msg._id },
      { $set: { status: 'skipped', skipReason: 'contact_deleted' } }
    );
    return { ok: false };
  }

  // Re-check the gate at the moment of sending. Someone can reply STOP while a
  // 5,000-person campaign is halfway through its queue, and the audience was built
  // an hour ago. This is the check that actually honours that.
  if (contact.optedOut || contact.invalid) {
    await CampaignMessage.updateOne(
      { _id: msg._id },
      { $set: { status: 'skipped', skipReason: contact.optedOut ? 'opted_out' : 'invalid' } }
    );
    return { ok: false, skipped: true };
  }

  const { variables } = render.renderVariables(campaign.variables, contact);
  const tracked = campaign.trackLinks ? links.trackUrls(variables) : { variables, links: [] };

  await CampaignMessage.updateOne(
    { _id: msg._id },
    {
      $set: {
        status: 'sending',
        renderedVariables: tracked.variables,
        links: tracked.links,
        templateName: campaign.templateName,
      },
      $inc: { attempts: 1 },
    }
  );

  const res = await wati.sendTemplate(
    contact.phoneKey,
    campaign.templateName,
    render.toWatiParameters(tracked.variables),
    `${campaign.name} (${String(campaign._id).slice(-6)})`.slice(0, 64)
  );

  const now = new Date();

  if (!res.ok) {
    await CampaignMessage.updateOne(
      { _id: msg._id },
      {
        $set: {
          status: 'failed',
          failedAt: now,
          errorMessage: String(res.error || 'Send failed').slice(0, 300),
        },
      }
    );
    await Campaign.updateOne({ _id: campaign._id }, { $inc: { 'stats.failed': 1, 'stats.queued': -1 } });
    await Contact.updateOne({ _id: contact._id }, { $inc: { 'stats.failed': 1 } });
    return { ok: false };
  }

  const messageCost = cost.costPerMessage(campaign.templateCategory);

  await CampaignMessage.updateOne(
    { _id: msg._id },
    {
      $set: {
        status: 'sent',
        sentAt: now,
        watiMessageId: res.messageId || null,
        watiTicketId: res.ticketId || null,
        cost: messageCost,
      },
    }
  );

  await Promise.all([
    Campaign.updateOne(
      { _id: campaign._id },
      { $inc: { 'stats.sent': 1, 'stats.queued': -1, actualCost: messageCost } }
    ),
    Contact.updateOne(
      { _id: contact._id },
      {
        $inc: { 'stats.sent': 1 },
        $set: { lastCampaignAt: now, lastOutboundAt: now },
      }
    ),
    MessageEvent.create({
      campaignId: campaign._id,
      messageId: msg._id,
      contactId: contact._id,
      phoneKey: contact.phoneKey,
      watiMessageId: res.messageId || null,
      type: 'sent',
      occurredAt: now,
    }).catch(() => {}), // duplicate event on a retry — the unique index did its job
  ]);

  return { ok: true };
}

/** Run `tasks` with bounded concurrency. WATI rate-limits, and a 50-wide fan-out gets 429s. */
async function pool(items, size, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * One tick of one campaign: send at most `budget` messages, then stop.
 *
 * The throttle is the whole reason this is a queue and not a for-loop. WhatsApp
 * scores a number on how fast it sends and how people react; a cold number that
 * fires 5,000 marketing templates in ninety seconds gets its quality rating cut and
 * its daily limit slashed, and then NOTHING sends — not this campaign, not the
 * follow-up calls, not next month's. Slow is not a nicety here.
 */
async function deliver(campaign, budget) {
  const queued = await CampaignMessage.find({ campaignId: campaign._id, status: 'queued' })
    .limit(budget)
    .lean();

  if (!queued.length) {
    const remaining = await CampaignMessage.countDocuments({
      campaignId: campaign._id,
      status: { $in: ['queued', 'sending'] },
    });
    if (!remaining) {
      await Campaign.updateOne(
        { _id: campaign._id },
        { $set: { status: 'completed', completedAt: new Date() } }
      );
      return { sent: 0, done: true };
    }
    return { sent: 0, done: false };
  }

  let sent = 0;
  await pool(queued, 3, async (msg) => {
    const res = await sendOne(campaign, msg);
    if (res.ok) sent += 1;
  });

  return { sent, done: false };
}

module.exports = {
  materialize,
  deliver,
  previewAudience,
  audienceFilter,
  sendOne,
  bucketOf,
  inThisArm,
};
