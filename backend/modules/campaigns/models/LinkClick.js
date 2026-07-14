const mongoose = require('mongoose');

/**
 * One row per click on a tracked /r/<code> link.
 *
 * This collection exists because WhatsApp gives us NOTHING about clicks — no
 * impressions, no link taps, nothing. The only way to know a contact acted on a
 * campaign is to own the redirect. That makes this the single highest-signal
 * table in the module: a read is "the phone was unlocked", a click is intent.
 *
 * Every click is kept, not just the first. A contact who opens the link four times
 * over two days is a different lead from one who tapped it once and bounced.
 */
const linkClickSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, index: true },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', index: true },
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignMessage', index: true },
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', index: true },
    phoneKey: { type: String, default: null },

    targetUrl: { type: String, required: true },
    clickedAt: { type: Date, default: Date.now, index: true },

    // Kept to spot bot/preview traffic. WhatsApp itself pre-fetches link previews
    // from Meta's own crawlers, which is why `bot` exists — an unfiltered click
    // count would credit Meta's scraper as an interested lead.
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
    bot: { type: Boolean, default: false, index: true },
  },
  { timestamps: false }
);

linkClickSchema.index({ campaignId: 1, clickedAt: -1 });

module.exports = mongoose.model('LinkClick', linkClickSchema);
