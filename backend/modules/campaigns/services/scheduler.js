/**
 * The campaigns worker. Three jobs on a timer:
 *
 *   1. launch    — scheduled campaigns whose time has come
 *   2. deliver   — push the queue of every `sending` campaign, at its own rate limit
 *   3. sequences — fire drip steps that have come due
 *
 * In-process `setInterval`, matching modules/calls/services/scheduler.js. That is the
 * house pattern and there is no Redis here, so introducing BullMQ for this would mean
 * introducing Redis for this.
 *
 * ── The thing to know before you scale ───────────────────────────────────────────
 * This is safe to CRASH (the queue lives in Mongo; a restart resumes it) but it is
 * NOT safe to run in two processes at once — two workers would each grab the same
 * `queued` rows and send some contacts twice. The unique (campaignId, contactId)
 * index stops a contact getting two ROWS, but not two SENDS off one row.
 *
 * One process is the current deployment (one container, `node server.js`), so this
 * holds today. If you ever run a second replica, this is the file that breaks first,
 * and the fix is a findOneAndUpdate lease on each message rather than find().
 */

const Campaign = require('../models/Campaign');
const sender = require('./sender');
const sequences = require('./sequences');

const TICK_SECONDS = Number(process.env.CAMPAIGN_TICK_SECONDS || 15);
const SEQUENCE_POLL_MINUTES = Number(process.env.CAMPAIGN_SEQUENCE_MINUTES || 10);

let running = { deliver: false, sequences: false };

/** Move `scheduled` campaigns past their time into `sending`, building the queue first. */
async function launchDue() {
  const due = await Campaign.find({
    status: 'scheduled',
    scheduledAt: { $lte: new Date() },
  });

  for (const campaign of due) {
    try {
      // Belt and braces: an approval-gated campaign must not be launchable by simply
      // waiting for the clock. The API refuses to schedule one, and this refuses to
      // send one — because the two checks fail in different ways.
      if (campaign.requiresApproval && !campaign.approvedAt) {
        campaign.status = 'draft';
        campaign.lastError = 'Scheduled time passed but the campaign was never approved.';
        await campaign.save();
        continue;
      }

      await sender.materialize(campaign);
      campaign.status = 'sending';
      campaign.startedAt = new Date();
      campaign.lastError = null;
      await campaign.save();

      console.log(`[campaigns] launched "${campaign.name}"`);
    } catch (err) {
      campaign.status = 'failed';
      campaign.lastError = err.message.slice(0, 300);
      await campaign.save();
      console.warn(`[campaigns] failed to launch "${campaign.name}":`, err.message);
    }
  }
}

/** Push every sending campaign forward by one tick's worth of its rate limit. */
async function deliverTick() {
  if (running.deliver) return;
  running.deliver = true;

  try {
    await launchDue();

    const active = await Campaign.find({ status: 'sending' });

    for (const campaign of active) {
      // A campaign's rate is per MINUTE; a tick is a fraction of a minute. Always at
      // least 1, so a rate of 5/min still moves on a 15s tick instead of stalling.
      const budget = Math.max(
        1,
        Math.round(((campaign.ratePerMinute || 20) * TICK_SECONDS) / 60)
      );

      try {
        const res = await sender.deliver(campaign, budget);
        if (res.done) console.log(`[campaigns] "${campaign.name}" finished`);
      } catch (err) {
        console.warn(`[campaigns] delivery failed for "${campaign.name}":`, err.message);
        await Campaign.updateOne(
          { _id: campaign._id },
          { $set: { lastError: err.message.slice(0, 300) } }
        );
      }
    }
  } catch (err) {
    console.warn('[campaigns] deliver tick failed:', err.message);
  } finally {
    running.deliver = false;
  }
}

async function sequenceTick() {
  if (running.sequences) return;
  running.sequences = true;

  try {
    const fired = await sequences.fireDue();
    if (fired) console.log(`[campaigns] fired ${fired} sequence step(s)`);
  } catch (err) {
    console.warn('[campaigns] sequence tick failed:', err.message);
  } finally {
    running.sequences = false;
  }
}

function start() {
  if (process.env.CAMPAIGN_JOBS_ENABLED === 'false') {
    console.log('Campaign jobs disabled (CAMPAIGN_JOBS_ENABLED=false)');
    return;
  }

  console.log(`Campaign jobs: deliver/${TICK_SECONDS}s, sequences/${SEQUENCE_POLL_MINUTES}m`);

  setInterval(deliverTick, TICK_SECONDS * 1000);
  setInterval(sequenceTick, SEQUENCE_POLL_MINUTES * 60 * 1000);

  // Stagger the first runs so a boot doesn't fire everything at once.
  setTimeout(deliverTick, 10 * 1000);
  setTimeout(sequenceTick, 45 * 1000);
}

module.exports = { start, deliverTick, sequenceTick, launchDue };
