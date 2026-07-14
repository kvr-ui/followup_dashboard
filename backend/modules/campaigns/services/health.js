/**
 * Is the WhatsApp number healthy enough to keep sending?
 *
 * This is the boring page nobody opens until the day nothing sends. Worth building
 * anyway, because WhatsApp's enforcement is *silent and retroactive*: Meta lowers a
 * number's quality rating based on blocks and reports, cuts its daily send limit,
 * and eventually restricts it — and the only signal you get in WATI's UI is that
 * campaigns start failing.
 *
 * ── An honest limitation ─────────────────────────────────────────────────────────
 * WATI does not expose the number's quality rating or messaging tier through their
 * public API. Meta shows it in Business Manager; WATI shows it in their own console.
 * So we CANNOT read the official rating here, and this file does not pretend to.
 *
 * What we can do is watch the inputs Meta scores you on, from our own data:
 *   - the failure rate         (rising = numbers rejecting you)
 *   - the opt-out rate         (the single strongest predictor of a rating cut)
 *   - the read rate            (falling = your content is being ignored)
 *   - template approval status (a REJECTED template kills a scheduled campaign dead)
 *
 * Treat the verdict as a smoke alarm, not a thermometer. If it goes red, open
 * Business Manager and look at the real number.
 */

const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Suppression = require('../models/Suppression');
const Contact = require('../models/Contact');
const wati = require('./watiApi');

const WINDOW_DAYS = Number(process.env.CAMPAIGN_HEALTH_WINDOW_DAYS || 7);

// Meta's own published thresholds are not public, so these are conservative bands
// drawn from what the ecosystem reports. They're meant to make you look, not to
// tell you exactly where the line is.
const THRESHOLDS = {
  failureRate: { warn: 5, bad: 12 }, // %
  optOutRate: { warn: 1, bad: 3 }, // % of delivered — this is the one Meta punishes
  readRate: { warn: 25, bad: 12 }, // % of delivered, LOW is bad
};

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

async function check() {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400000);

  const [sent, delivered, read, failed, optOuts, templatesRes, activeCampaigns, contactable] =
    await Promise.all([
      CampaignMessage.countDocuments({ sentAt: { $gte: since } }),
      CampaignMessage.countDocuments({ deliveredAt: { $gte: since } }),
      CampaignMessage.countDocuments({ readAt: { $gte: since } }),
      CampaignMessage.countDocuments({ failedAt: { $gte: since } }),
      Suppression.countDocuments({ createdAt: { $gte: since }, reason: 'replied_stop' }),
      wati.listTemplates(),
      Campaign.find({ status: { $in: ['draft', 'scheduled', 'sending', 'paused'] } })
        .select('name templateName status')
        .lean(),
      Contact.countDocuments({ optedOut: false, invalid: false }),
    ]);

  const attempted = sent + failed;
  const failureRate = pct(failed, attempted);
  const deliveryRate = pct(delivered, sent);
  const readRate = pct(read, delivered);
  const optOutRate = pct(optOuts, delivered);

  const templates = templatesRes.templates || [];
  const byName = new Map(templates.map((t) => [t.name, t]));
  const warnings = [];

  // --- Template problems. The most actionable check on this page. -----------------
  for (const c of activeCampaigns) {
    const t = byName.get(c.templateName);
    if (!templatesRes.ok) break; // WATI unreachable — don't cry wolf about every template
    if (!t) {
      warnings.push({
        level: 'bad',
        title: `Template "${c.templateName}" no longer exists`,
        detail: `Campaign "${c.name}" is ${c.status} and will fail on every send. It was probably deleted in WATI.`,
      });
    } else if (t.status !== 'APPROVED') {
      warnings.push({
        level: 'bad',
        title: `Template "${c.templateName}" is ${t.status}`,
        detail: `Campaign "${c.name}" is ${c.status}. WhatsApp will reject every message until this template is approved again.`,
      });
    }
  }

  const rejected = templates.filter((t) => t.status === 'REJECTED');
  if (rejected.length) {
    warnings.push({
      level: 'warn',
      title: `${rejected.length} template(s) rejected by WhatsApp`,
      detail: rejected.map((t) => t.name).join(', '),
    });
  }

  // --- The rates Meta actually scores you on ---------------------------------------
  if (attempted >= 20 && failureRate >= THRESHOLDS.failureRate.bad) {
    warnings.push({
      level: 'bad',
      title: `${failureRate}% of sends are failing`,
      detail:
        'Mostly dead numbers or people who never had WhatsApp. Clean the list — Meta counts these against the number.',
    });
  } else if (attempted >= 20 && failureRate >= THRESHOLDS.failureRate.warn) {
    warnings.push({
      level: 'warn',
      title: `${failureRate}% of sends are failing`,
      detail: 'Above normal. Check the failed rows on your recent campaigns for a pattern.',
    });
  }

  if (delivered >= 50 && optOutRate >= THRESHOLDS.optOutRate.bad) {
    warnings.push({
      level: 'bad',
      title: `${optOutRate}% of people who received a message opted out`,
      detail:
        'This is the number that gets a WhatsApp number restricted. Stop sending marketing templates and look hard at who you are messaging and how often.',
    });
  } else if (delivered >= 50 && optOutRate >= THRESHOLDS.optOutRate.warn) {
    warnings.push({
      level: 'warn',
      title: `${optOutRate}% opt-out rate`,
      detail: 'Rising opt-outs are the earliest warning you get before a rating cut.',
    });
  }

  if (delivered >= 50 && readRate > 0 && readRate <= THRESHOLDS.readRate.bad) {
    warnings.push({
      level: 'warn',
      title: `Only ${readRate}% of delivered messages were read`,
      detail:
        'Worth taking with salt — read receipts are optional and many people turn them off. Trust the click rate over this.',
    });
  }

  const verdict = warnings.some((w) => w.level === 'bad')
    ? 'bad'
    : warnings.length
      ? 'warn'
      : 'ok';

  return {
    verdict,
    windowDays: WINDOW_DAYS,
    watiConfigured: wati.isConfigured(),
    templatesReadable: Boolean(templatesRes.ok),
    metrics: {
      sent,
      delivered,
      read,
      failed,
      optOuts,
      failureRate,
      deliveryRate,
      readRate,
      optOutRate,
      contactable,
    },
    templates: {
      total: templates.length,
      approved: templates.filter((t) => t.status === 'APPROVED').length,
      pending: templates.filter((t) => t.status === 'PENDING').length,
      rejected: rejected.length,
    },
    warnings,
    // Said out loud on the page, because a health dashboard that implies it can see
    // something it cannot is worse than no health dashboard.
    caveat:
      'WATI does not expose the number’s official quality rating or messaging tier over its API. These figures are inferred from your own send data. If this goes red, open WhatsApp Business Manager and check the real rating.',
  };
}

module.exports = { check, THRESHOLDS };
