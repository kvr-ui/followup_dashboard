/**
 * The funnel states a campaign message can be in, and the Mongo filter for each.
 *
 * This file is the module's one opinion about what the data MEANS, and everything
 * else — the dashboard, the segment builder, the retarget buttons, the drip steps —
 * reads its definitions from here. Defining them in one place is what stops the
 * "read" number on the campaign page from disagreeing with the "read" audience the
 * retarget button actually builds.
 *
 * ── The important call: a CLICK OUTRANKS A READ. ──────────────────────────────
 * WhatsApp's `read` event only fires if the contact has blue ticks switched on, and
 * a large minority of people don't. So `read` is a floor, never a truth: someone can
 * open the message, tap the link, and buy the course without ever emitting a `read`.
 * Ranking a click above a read means those people land in `clicked_no_reply` (your
 * hottest audience) instead of being written off in `delivered_not_read`.
 *
 * The states are ORDERED and mutually exclusive — every message has exactly one, and
 * the first matching state wins. Overlapping states would double-count contacts into
 * two retarget audiences and message the same person twice.
 */

// Highest intent first. `first match wins` — see stateOf() below.
const FUNNEL_STATES = [
  {
    key: 'replied',
    label: 'Replied',
    hint: 'They wrote back. Nothing to retarget — this is a conversation now.',
    filter: () => ({ repliedAt: { $ne: null } }),
  },
  {
    key: 'clicked_no_reply',
    label: 'Clicked, no reply',
    hint: 'Your hottest segment. They acted on the link and went quiet. Call them, do not blast them.',
    filter: () => ({ repliedAt: null, clickCount: { $gt: 0 } }),
  },
  {
    key: 'read_no_click',
    label: 'Read, no click',
    hint: 'The message landed and the offer did not. Change the hook, not the audience.',
    filter: () => ({ repliedAt: null, clickCount: 0, readAt: { $ne: null } }),
  },
  {
    key: 'delivered_not_read',
    label: 'Delivered, not read',
    hint: 'Arrived, no blue tick. Try a different hour — but remember some people have read receipts off, so this bucket is noisier than it looks.',
    filter: () => ({
      repliedAt: null,
      clickCount: 0,
      readAt: null,
      deliveredAt: { $ne: null },
    }),
  },
  {
    key: 'sent_not_delivered',
    label: 'Sent, not delivered',
    hint: 'WhatsApp took it but never handed it over — phone off, or the number is dead.',
    filter: () => ({
      status: { $nin: ['failed', 'skipped', 'queued', 'sending'] },
      repliedAt: null,
      clickCount: 0,
      readAt: null,
      deliveredAt: null,
      sentAt: { $ne: null },
    }),
  },
  {
    key: 'failed',
    label: 'Failed',
    hint: 'WhatsApp rejected it. Usually not on WhatsApp, or the template was rejected. Clean these out of your list.',
    filter: () => ({ status: 'failed' }),
  },
  {
    key: 'skipped',
    label: 'Skipped',
    hint: 'We refused to send: opted out, suppressed, or a known-bad number. Shown so the audience maths still adds up.',
    filter: () => ({ status: 'skipped' }),
  },
  {
    key: 'queued',
    label: 'Not sent yet',
    hint: 'Still in the send queue.',
    filter: () => ({ status: { $in: ['queued', 'sending'] } }),
  },
];

const BY_KEY = new Map(FUNNEL_STATES.map((s) => [s.key, s]));

/** The Mongo filter for one state within one campaign. */
function stateFilter(campaignId, key) {
  const state = BY_KEY.get(key);
  if (!state) return null;
  return { campaignId, ...state.filter() };
}

/** Which state a given message document is in. Same order, same rules, in memory. */
function stateOf(msg) {
  if (msg.repliedAt) return 'replied';
  if (msg.clickCount > 0) return 'clicked_no_reply';
  if (msg.readAt) return 'read_no_click';
  if (msg.deliveredAt) return 'delivered_not_read';
  if (msg.status === 'failed') return 'failed';
  if (msg.status === 'skipped') return 'skipped';
  if (msg.sentAt) return 'sent_not_delivered';
  return 'queued';
}

/**
 * Count every state for a campaign in ONE aggregation.
 *
 * Deliberately not eight countDocuments() calls: the campaign page would then fire
 * eight round-trips that can disagree with each other if a webhook lands mid-read.
 */
async function funnelFor(CampaignMessage, campaignId) {
  const rows = await CampaignMessage.aggregate([
    { $match: { campaignId } },
    {
      $project: {
        state: {
          $switch: {
            branches: [
              { case: { $ne: ['$repliedAt', null] }, then: 'replied' },
              { case: { $gt: ['$clickCount', 0] }, then: 'clicked_no_reply' },
              { case: { $ne: ['$readAt', null] }, then: 'read_no_click' },
              { case: { $ne: ['$deliveredAt', null] }, then: 'delivered_not_read' },
              { case: { $eq: ['$status', 'failed'] }, then: 'failed' },
              { case: { $eq: ['$status', 'skipped'] }, then: 'skipped' },
              { case: { $ne: ['$sentAt', null] }, then: 'sent_not_delivered' },
            ],
            default: 'queued',
          },
        },
      },
    },
    { $group: { _id: '$state', count: { $sum: 1 } } },
  ]);

  const counts = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  return FUNNEL_STATES.map((s) => ({
    key: s.key,
    label: s.label,
    hint: s.hint,
    count: counts[s.key] || 0,
    // Not every state is worth chasing. `replied` belongs to a human; `queued`
    // hasn't happened yet. The UI reads this to decide whether to show the button.
    retargetable: !['replied', 'skipped', 'queued'].includes(s.key),
  }));
}

module.exports = { FUNNEL_STATES, stateFilter, stateOf, funnelFor };
