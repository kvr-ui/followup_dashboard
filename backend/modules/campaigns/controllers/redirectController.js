/**
 * GET /r/:code — the tracked link.
 *
 * Public, unauthenticated, and the single most valuable endpoint in the module: this
 * is the only place a contact's INTENT is observable. WhatsApp gives us delivery and
 * (unreliably) reads; it never gives us a click. So we own the redirect.
 *
 * Three properties this endpoint must have, in priority order:
 *
 *   1. It must always redirect. A logging failure must never cost a lead their click.
 *      Every write below is best-effort and non-blocking; the 302 is the only thing
 *      that is allowed to fail loudly.
 *   2. It must not credit robots. Meta pre-fetches every URL we send to build the
 *      chat's preview card — that fetch hits this endpoint exactly like a human tap.
 *      Counted naively, every campaign would report a ~100% click rate.
 *   3. It must not become an open redirect. `?u=` style pass-through would let anyone
 *      launder a phishing link through our domain. The destination comes only from
 *      our own database, never from the request.
 */

const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Contact = require('../models/Contact');
const LinkClick = require('../models/LinkClick');
const MessageEvent = require('../models/MessageEvent');
const links = require('../services/links');

const FALLBACK_URL = process.env.CAMPAIGN_FALLBACK_URL || 'https://focasedu.com';

async function redirect(req, res) {
  const { code } = req.params;

  let msg = null;
  try {
    msg = await CampaignMessage.findOne({ 'links.code': code }).lean();
  } catch (err) {
    console.warn('[redirect] lookup failed:', err.message);
  }

  const link = msg && (msg.links || []).find((l) => l.code === code);

  // An unknown code is a dead link in someone's WhatsApp. Send them somewhere real
  // rather than showing a 404 — they clicked in good faith.
  if (!link || !links.isSafeTarget(link.targetUrl)) {
    return res.redirect(302, FALLBACK_URL);
  }

  // Redirect FIRST. The counting happens after the response is on its way, so a slow
  // or broken write can never turn into a slow or broken link.
  res.redirect(302, link.targetUrl);

  const userAgent = req.get('user-agent') || '';
  const bot = links.isBot(userAgent);
  const now = new Date();

  try {
    // Bot hits are recorded, but flagged — thrown away silently they'd be invisible,
    // and one day you WILL want to know why a campaign shows 3,000 clicks.
    await LinkClick.create({
      code,
      campaignId: msg.campaignId,
      messageId: msg._id,
      contactId: msg.contactId,
      phoneKey: msg.phoneKey,
      targetUrl: link.targetUrl,
      clickedAt: now,
      userAgent: userAgent.slice(0, 300),
      ip: (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim(),
      bot,
    });

    if (bot) return;

    const firstClick = !msg.firstClickAt;

    await CampaignMessage.updateOne(
      { _id: msg._id, 'links.code': code },
      {
        $inc: { clickCount: 1, 'links.$.clicks': 1 },
        $set: {
          'links.$.lastClickAt': now,
          ...(link.firstClickAt ? {} : { 'links.$.firstClickAt': now }),
          ...(firstClick ? { firstClickAt: now } : {}),
        },
      }
    );

    await Promise.all([
      // The campaign counter is UNIQUE CLICKERS, not clicks. A contact who opens the
      // link four times is one interested lead, and a click-through rate that can
      // exceed 100% because of them is a broken metric.
      firstClick
        ? Campaign.updateOne({ _id: msg.campaignId }, { $inc: { 'stats.clicked': 1 } })
        : Promise.resolve(),
      firstClick
        ? Contact.updateOne(
            { _id: msg.contactId },
            { $inc: { 'stats.clicked': 1 }, $set: { lastClickAt: now } }
          )
        : Contact.updateOne({ _id: msg.contactId }, { $set: { lastClickAt: now } }),
      // One `clicked` event per message — the unique (watiMessageId, type) index does
      // not apply here (no provider id), so the first-click check is what dedupes it.
      firstClick
        ? MessageEvent.create({
            campaignId: msg.campaignId,
            messageId: msg._id,
            contactId: msg.contactId,
            phoneKey: msg.phoneKey,
            type: 'clicked',
            occurredAt: now,
          }).catch(() => {})
        : Promise.resolve(),
    ]);
  } catch (err) {
    // The contact already has their page. This is our bookkeeping problem.
    console.warn('[redirect] click logging failed:', err.message);
  }
}

module.exports = { redirect };
