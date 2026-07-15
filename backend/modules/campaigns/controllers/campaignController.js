const mongoose = require('mongoose');

const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const Contact = require('../models/Contact');
const MessageEvent = require('../models/MessageEvent');
const Segment = require('../models/Segment');

const sender = require('../services/sender');
const funnel = require('../services/funnel');
const cost = require('../services/cost');
const health = require('../services/health');
const wati = require('../services/watiApi');
const render = require('../services/render');
const links = require('../services/links');

// Read events are timestamped in UTC; "do they read at 9am?" is a question about
// THEIR morning. Getting this wrong shifts the whole histogram by five and a half
// hours and tells you to send at 3am.
const TZ = process.env.CAMPAIGN_TIMEZONE || 'Asia/Kolkata';

const EDITABLE = [
  'name',
  'description',
  'templateName',
  'templateLanguage',
  'templateCategory',
  'variables',
  'audience',
  'ratePerMinute',
  'trackLinks',
  'requiresApproval',
  'abGroupId',
  'abVariant',
  'abSplit',
];

/** Rates, computed the same way everywhere. Percentages of the right denominator. */
function ratesOf(stats) {
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0);
  return {
    // Delivery is of what we SENT. Read/click are of what was DELIVERED — a message
    // that never arrived cannot be read, and including it in the denominator quietly
    // punishes your copywriting for a dead phone number.
    deliveryRate: pct(stats.delivered, stats.sent),
    readRate: pct(stats.read, stats.delivered),
    clickRate: pct(stats.clicked, stats.delivered),
    replyRate: pct(stats.replied, stats.delivered),
    failureRate: pct(stats.failed, stats.sent + stats.failed),
  };
}

function dto(c) {
  const stats = c.stats || {};
  return {
    id: c._id,
    name: c.name,
    description: c.description,
    templateName: c.templateName,
    templateCategory: c.templateCategory,
    status: c.status,
    scheduledAt: c.scheduledAt,
    startedAt: c.startedAt,
    completedAt: c.completedAt,
    createdAt: c.createdAt,
    createdBy: c.createdBy,
    ratePerMinute: c.ratePerMinute,
    trackLinks: c.trackLinks,
    requiresApproval: c.requiresApproval,
    approvedBy: c.approvedBy,
    approvedAt: c.approvedAt,
    parentCampaignId: c.parentCampaignId,
    parentState: c.parentState,
    sequenceId: c.sequenceId,
    abGroupId: c.abGroupId,
    abVariant: c.abVariant,
    stats,
    rates: ratesOf(stats),
    estimatedCost: c.estimatedCost,
    actualCost: c.actualCost,
    currency: cost.CURRENCY,
    lastError: c.lastError,
  };
}

// --- List / overview ----------------------------------------------------------

async function listCampaigns(req, res) {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const campaigns = await Campaign.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    const data = campaigns.map(dto);

    const totals = data.reduce(
      (a, c) => ({
        sent: a.sent + (c.stats.sent || 0),
        delivered: a.delivered + (c.stats.delivered || 0),
        read: a.read + (c.stats.read || 0),
        clicked: a.clicked + (c.stats.clicked || 0),
        replied: a.replied + (c.stats.replied || 0),
        failed: a.failed + (c.stats.failed || 0),
        cost: a.cost + (c.actualCost || 0),
      }),
      { sent: 0, delivered: 0, read: 0, clicked: 0, replied: 0, failed: 0, cost: 0 }
    );

    res.json({
      success: true,
      count: data.length,
      totals,
      rates: ratesOf(totals),
      efficiency: cost.efficiency({ ...totals, cost: totals.cost }),
      sending: data.filter((c) => c.status === 'sending').length,
      data,
    });
  } catch (err) {
    console.error('List campaigns failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load campaigns' });
  }
}

// --- Read one -----------------------------------------------------------------

async function getCampaign(req, res) {
  try {
    const campaign = await Campaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    const [states, variants, children] = await Promise.all([
      funnel.funnelFor(CampaignMessage, campaign._id),
      campaign.abGroupId
        ? Campaign.find({ abGroupId: campaign.abGroupId }).lean()
        : Promise.resolve([]),
      Campaign.find({ parentCampaignId: campaign._id }).lean(),
    ]);

    const c = dto(campaign);

    res.json({
      success: true,
      data: c,
      funnel: states,
      efficiency: cost.efficiency({
        cost: campaign.actualCost || 0,
        delivered: campaign.stats.delivered,
        read: campaign.stats.read,
        clicked: campaign.stats.clicked,
        replied: campaign.stats.replied,
      }),
      // The A/B comparison is only meaningful side by side, so it ships with the arm.
      variants: variants.map(dto),
      // Everything spawned from this campaign — retargets and drip steps. The lineage
      // is the point: six months on, "where did these 300 people come from" has an answer.
      children: children.map(dto),
      variables: campaign.variables,
      audience: campaign.audience,
    });
  } catch (err) {
    console.error('Get campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load campaign' });
  }
}

// --- The delivery board -------------------------------------------------------

async function listMessages(req, res) {
  try {
    const campaignId = new mongoose.Types.ObjectId(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

    let filter = { campaignId };
    if (req.query.state) {
      const stateFilter = funnel.stateFilter(campaignId, req.query.state);
      if (!stateFilter) return res.status(400).json({ success: false, message: 'Unknown state' });
      filter = stateFilter;
    }

    const messages = await CampaignMessage.find(filter)
      .sort({ sentAt: -1, _id: -1 })
      .limit(limit)
      .populate('contactId', 'name phoneKey email tags optedOut')
      .lean();

    const data = messages.map((m) => {
      const c = m.contactId || {};
      return {
        id: m._id,
        contactId: c._id || null,
        name: c.name || null,
        phone: m.phoneKey,
        tags: c.tags || [],
        status: m.status,
        state: funnel.stateOf(m),
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        readAt: m.readAt,
        repliedAt: m.repliedAt,
        clickCount: m.clickCount,
        firstClickAt: m.firstClickAt,
        replyText: m.replyText,
        errorMessage: m.errorMessage,
        skipReason: m.skipReason,
        links: (m.links || []).map((l) => ({ url: l.targetUrl, clicks: l.clicks })),
      };
    });

    res.json({ success: true, count: data.length, truncated: data.length === limit, data });
  } catch (err) {
    console.error('List campaign messages failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load messages' });
  }
}

// --- Create / edit ------------------------------------------------------------

function pick(body) {
  const out = {};
  EDITABLE.forEach((k) => {
    if (body[k] !== undefined) out[k] = body[k];
  });
  return out;
}

async function createCampaign(req, res) {
  try {
    const body = pick(req.body || {});
    if (!body.name || !body.templateName) {
      return res
        .status(400)
        .json({ success: false, message: 'A name and a template are required' });
    }

    // Snapshot the segment's rule onto the campaign. If the segment is edited next
    // week, this campaign must still be able to say what audience it actually meant.
    if (body.audience && body.audience.type === 'segment' && body.audience.segmentId) {
      const seg = await Segment.findById(body.audience.segmentId).lean();
      if (!seg) return res.status(400).json({ success: false, message: 'Segment not found' });
      body.audience.rule = seg.rule;
    }

    const campaign = await Campaign.create({
      ...body,
      status: 'draft',
      createdBy: req.user.username,
    });

    res.json({ success: true, data: dto(campaign.toObject()) });
  } catch (err) {
    console.error('Create campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create campaign' });
  }
}

async function updateCampaign(req, res) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    // A campaign that has started sending cannot be edited. Half its audience has the
    // old copy on their phone; changing the template now would mean two different
    // messages under one name, and the report would describe neither.
    if (!['draft', 'scheduled'].includes(campaign.status)) {
      return res.status(400).json({
        success: false,
        message: `A ${campaign.status} campaign can no longer be edited. Duplicate it instead.`,
      });
    }

    const body = pick(req.body || {});
    if (body.audience && body.audience.type === 'segment' && body.audience.segmentId) {
      const seg = await Segment.findById(body.audience.segmentId).lean();
      if (seg) body.audience.rule = seg.rule;
    }

    Object.assign(campaign, body);
    await campaign.save();

    res.json({ success: true, data: dto(campaign.toObject()) });
  } catch (err) {
    console.error('Update campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update campaign' });
  }
}

async function deleteCampaign(req, res) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    // Sent campaigns are the record of what you did to real people. They are not
    // deletable — cancel stops a live one, and the history stays.
    if (!['draft', 'scheduled', 'cancelled', 'failed'].includes(campaign.status)) {
      return res.status(400).json({
        success: false,
        message: 'A campaign that has sent messages cannot be deleted — it is your record of what went out.',
      });
    }

    await CampaignMessage.deleteMany({ campaignId: campaign._id });
    await campaign.deleteOne();

    res.json({ success: true, message: 'Campaign deleted' });
  } catch (err) {
    console.error('Delete campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete campaign' });
  }
}

// --- Preview ------------------------------------------------------------------

async function previewCampaign(req, res) {
  try {
    const campaign = await Campaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    const preview = await sender.previewAudience(campaign);

    // Show the admin the message a real contact will actually receive, rendered with
    // that contact's real values — before it goes to five thousand people.
    let sample = null;
    if (preview.sample.length) {
      const contact = await Contact.findById(preview.sample[0].id).lean();
      if (contact) {
        const { variables, missing } = render.renderVariables(campaign.variables, contact);
        sample = { contact: contact.name || contact.phoneKey, variables, missing };
      }
    }

    res.json({
      success: true,
      ...preview,
      renderedSample: sample,
      linkTrackingConfigured: links.isConfigured(),
    });
  } catch (err) {
    console.error('Preview campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to preview audience' });
  }
}

// --- Lifecycle ----------------------------------------------------------------

/** Every gate a campaign must clear before a single message leaves. */
async function preflight(campaign) {
  const problems = [];

  const { templates, ok } = await wati.listTemplates();
  if (ok) {
    const t = templates.find((x) => x.name === campaign.templateName);
    if (!t) problems.push(`Template "${campaign.templateName}" does not exist in WATI.`);
    else if (t.status !== 'APPROVED') {
      problems.push(`Template "${campaign.templateName}" is ${t.status} — WhatsApp will reject every message.`);
    } else {
      // A template parameter with no binding renders as a literal "{{1}}" on the
      // contact's phone, or gets the send rejected outright.
      const bound = new Set((campaign.variables || []).map((v) => v.name));
      const unbound = (t.params || []).filter((p) => !bound.has(p));
      if (unbound.length) problems.push(`Template variables with no value: ${unbound.join(', ')}.`);
    }
  }

  if (campaign.requiresApproval && !campaign.approvedAt) {
    problems.push('This campaign needs an approval before it can send.');
  }

  if (!wati.isConfigured()) problems.push('WATI is not configured (WATI_API_URL / WATI_TOKEN).');

  if (campaign.trackLinks && !links.isConfigured()) {
    // Not fatal — the links still work, they just aren't measurable.
    problems.push(
      'PUBLIC_BASE_URL is not set, so links cannot be tracked. The campaign will still send, but you will have no click data.'
    );
  }

  return problems;
}

async function sendNow(req, res) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
      return res
        .status(400)
        .json({ success: false, message: `A ${campaign.status} campaign cannot be started.` });
    }

    const problems = await preflight(campaign);
    // A missing PUBLIC_BASE_URL is a warning, not a blocker — everything else stops the send.
    const blocking = problems.filter((p) => !p.startsWith('PUBLIC_BASE_URL'));
    if (blocking.length && !req.body.force) {
      return res.status(400).json({ success: false, message: blocking[0], problems });
    }

    const result = await sender.materialize(campaign);

    campaign.status = 'sending';
    campaign.startedAt = campaign.startedAt || new Date();
    campaign.lastError = null;
    await campaign.save();

    res.json({
      success: true,
      message: `Sending to ${result.queued} contact(s)${result.skipped ? `, ${result.skipped} skipped` : ''}.`,
      queued: result.queued,
      skipped: result.skipped,
      warnings: problems.filter((p) => p.startsWith('PUBLIC_BASE_URL')),
      data: dto(campaign.toObject()),
    });
  } catch (err) {
    console.error('Send campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to start the campaign' });
  }
}

async function scheduleCampaign(req, res) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    const when = new Date(req.body.scheduledAt);
    if (Number.isNaN(when.getTime()) || when <= new Date()) {
      return res.status(400).json({ success: false, message: 'Pick a time in the future' });
    }

    const problems = await preflight(campaign);
    const blocking = problems.filter((p) => !p.startsWith('PUBLIC_BASE_URL'));
    if (blocking.length) {
      return res.status(400).json({ success: false, message: blocking[0], problems });
    }

    campaign.status = 'scheduled';
    campaign.scheduledAt = when;
    await campaign.save();

    res.json({ success: true, message: `Scheduled for ${when.toLocaleString()}.`, data: dto(campaign.toObject()) });
  } catch (err) {
    console.error('Schedule campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to schedule the campaign' });
  }
}

async function setStatus(req, res, status, verb, allowedFrom) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    // Guard the transition: you can't resume a completed campaign, pause one that isn't
    // sending, or cancel one already finished. Without this a resume drags a terminal
    // campaign back through `sending` and its stats/completedAt go inconsistent.
    if (allowedFrom && !allowedFrom.includes(campaign.status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot ${verb.replace(/d$/, '')} a ${campaign.status} campaign`,
      });
    }

    campaign.status = status;
    if (status === 'cancelled') campaign.completedAt = new Date();
    await campaign.save();

    // Cancelling drops what hasn't gone out. What already went out stays on the
    // record — you cannot unsend a WhatsApp message, and the dashboard must not
    // pretend otherwise.
    if (status === 'cancelled') {
      await CampaignMessage.updateMany(
        { campaignId: campaign._id, status: 'queued' },
        { $set: { status: 'skipped', skipReason: 'campaign_cancelled' } }
      );
    }

    res.json({ success: true, message: `Campaign ${verb}.`, data: dto(campaign.toObject()) });
  } catch (err) {
    console.error(`${verb} campaign failed:`, err.message);
    res.status(500).json({ success: false, message: `Failed to ${verb.replace(/d$/, '')} the campaign` });
  }
}

const pauseCampaign = (req, res) => setStatus(req, res, 'paused', 'paused', ['sending', 'scheduled']);
const resumeCampaign = (req, res) => setStatus(req, res, 'sending', 'resumed', ['paused']);
const cancelCampaign = (req, res) =>
  setStatus(req, res, 'cancelled', 'cancelled', ['draft', 'scheduled', 'sending', 'paused']);

async function approveCampaign(req, res) {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    campaign.approvedBy = req.user.username;
    campaign.approvedAt = new Date();
    await campaign.save();

    res.json({ success: true, message: 'Approved.', data: dto(campaign.toObject()) });
  } catch (err) {
    console.error('Approve campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to approve the campaign' });
  }
}

// --- Duplicate and retarget ---------------------------------------------------

async function duplicateCampaign(req, res) {
  try {
    const source = await Campaign.findById(req.params.id).lean();
    if (!source) return res.status(404).json({ success: false, message: 'Campaign not found' });

    const copy = await Campaign.create({
      name: req.body.name || `${source.name} (copy)`,
      description: source.description,
      templateName: source.templateName,
      templateLanguage: source.templateLanguage,
      templateCategory: source.templateCategory,
      variables: source.variables,
      audience: source.audience,
      ratePerMinute: source.ratePerMinute,
      trackLinks: source.trackLinks,
      status: 'draft',
      createdBy: req.user.username,
    });

    res.json({ success: true, data: dto(copy.toObject()) });
  } catch (err) {
    console.error('Duplicate campaign failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to duplicate the campaign' });
  }
}

/**
 * POST /:id/retarget — the button the whole dashboard exists to put in front of you.
 *
 * Take one funnel state of a finished campaign ("read it, never clicked") and turn
 * those exact people into a new draft campaign. The audience is FROZEN as contact ids
 * rather than stored as a rule, because the rule's answer changes by the minute — a
 * contact who hadn't clicked when you pressed the button may have clicked by the time
 * the campaign sends, and then the audience you approved is not the audience that
 * receives it.
 */
async function retarget(req, res) {
  try {
    const parent = await Campaign.findById(req.params.id).lean();
    if (!parent) return res.status(404).json({ success: false, message: 'Campaign not found' });

    const { state } = req.body;
    const filter = funnel.stateFilter(parent._id, state);
    if (!filter) return res.status(400).json({ success: false, message: 'Unknown funnel state' });

    const contactIds = await CampaignMessage.distinct('contactId', filter);
    if (!contactIds.length) {
      return res.status(400).json({ success: false, message: 'Nobody is in that state — nothing to retarget.' });
    }

    const label = (funnel.FUNNEL_STATES.find((s) => s.key === state) || {}).label || state;

    const campaign = await Campaign.create({
      name: req.body.name || `${parent.name} — ${label}`,
      description: `Retargeting ${contactIds.length} contact(s) who were "${label}" after "${parent.name}".`,
      // Default to the parent's template so the draft is immediately previewable, but
      // this is the field you are MEANT to change. Re-sending the identical message to
      // someone who ignored it once is not a retarget, it is a nag.
      templateName: req.body.templateName || parent.templateName,
      templateLanguage: parent.templateLanguage,
      templateCategory: req.body.templateCategory || parent.templateCategory,
      variables: req.body.variables || parent.variables,
      audience: { type: 'contacts', contactIds },
      parentCampaignId: parent._id,
      parentState: state,
      ratePerMinute: parent.ratePerMinute,
      trackLinks: parent.trackLinks,
      status: 'draft',
      createdBy: req.user.username,
      estimatedCost: cost.estimate(req.body.templateCategory || parent.templateCategory, contactIds.length),
    });

    res.json({
      success: true,
      message: `Draft created with ${contactIds.length} contact(s). Change the template before you send it.`,
      count: contactIds.length,
      data: dto(campaign.toObject()),
    });
  } catch (err) {
    console.error('Retarget failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build the retarget audience' });
  }
}

// --- Timing -------------------------------------------------------------------

/**
 * GET /:id/timing — when does THIS audience actually read and click?
 *
 * Built from read and click events, bucketed by hour in the contact's timezone.
 * Generic "best time to send on WhatsApp" advice is worthless; your audience is
 * students and parents in Tamil Nadu, and they behave like themselves, not like the
 * median of a global benchmark report.
 */
async function timing(req, res) {
  try {
    const campaignId = req.params.id === 'all' ? null : new mongoose.Types.ObjectId(req.params.id);
    const match = { type: { $in: ['read', 'clicked'] } };
    if (campaignId) match.campaignId = campaignId;

    const rows = await MessageEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            hour: { $hour: { date: '$occurredAt', timezone: TZ } },
            type: '$type',
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, read: 0, clicked: 0 }));
    rows.forEach((r) => {
      const bucket = hours[r._id.hour];
      if (bucket) bucket[r._id.type] = r.count;
    });

    const best = [...hours].sort((a, b) => b.clicked + b.read - (a.clicked + a.read))[0];

    res.json({
      success: true,
      timezone: TZ,
      data: hours,
      bestHour: best && best.read + best.clicked > 0 ? best.hour : null,
      total: rows.reduce((a, r) => a + r.count, 0),
    });
  } catch (err) {
    console.error('Timing failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to build the timing chart' });
  }
}

// --- Replies inbox ------------------------------------------------------------

async function inbox(req, res) {
  try {
    const filter = { repliedAt: { $ne: null } };
    if (req.params.id && req.params.id !== 'all') {
      filter.campaignId = new mongoose.Types.ObjectId(req.params.id);
    }

    const messages = await CampaignMessage.find(filter)
      .sort({ repliedAt: -1 })
      .limit(300)
      .populate('contactId', 'name phoneKey ownerEmail lastInboundAt')
      .populate('campaignId', 'name')
      .lean();

    const now = Date.now();

    const data = messages.map((m) => {
      const c = m.contactId || {};
      const lastIn = c.lastInboundAt ? new Date(c.lastInboundAt).getTime() : 0;
      return {
        id: m._id,
        contactId: c._id || null,
        name: c.name || null,
        phone: m.phoneKey,
        ownerEmail: c.ownerEmail || null,
        campaign: (m.campaignId && m.campaignId.name) || null,
        campaignId: m.campaignId && m.campaignId._id,
        replyText: m.replyText,
        repliedAt: m.repliedAt,
        clicked: m.clickCount > 0,
        // Can an agent still send a free-text reply, or does it have to be a paid
        // template? That is a 24-hour clock from THEIR last message, and it is the
        // first thing a rep needs to know before they open the conversation.
        sessionOpen: lastIn > 0 && now - lastIn < 24 * 3600 * 1000,
        sessionExpiresAt: lastIn ? new Date(lastIn + 24 * 3600 * 1000) : null,
      };
    });

    res.json({
      success: true,
      count: data.length,
      sessionOpen: data.filter((d) => d.sessionOpen).length,
      data,
    });
  } catch (err) {
    console.error('Inbox failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load replies' });
  }
}

// --- Templates and health -----------------------------------------------------

async function getTemplates(req, res) {
  try {
    const result = await wati.listTemplates();
    res.json({
      success: true,
      configured: wati.isConfigured(),
      error: result.error || null,
      data: result.templates || [],
    });
  } catch (err) {
    console.error('Get templates failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load templates' });
  }
}

/**
 * POST /api/campaigns/test-send — fire one template to one number, right now.
 *
 * No campaign, no contact row, no tracking. This is the "send it to my own phone so I
 * can see what it looks like" button, and coupling it to the whole campaign machinery
 * would defeat its point — the entire value is that it is instant and disposable.
 * Links are NOT rewritten here: a test is about eyeballing the wording, and a tracked
 * link would pollute a real campaign's click stats with your own test taps.
 */
async function testSend(req, res) {
  try {
    const { phone, templateName, variables } = req.body || {};
    if (!phone || !templateName) {
      return res.status(400).json({ success: false, message: 'A number and a template are required' });
    }

    const parameters = render.toWatiParameters(
      // Accept either the composer's {name: value} map or WATI's [{name,value}] array.
      Array.isArray(variables)
        ? Object.fromEntries(variables.map((v) => [v.name, v.value]))
        : variables || {}
    );

    const result = await wati.sendTemplate(phone, templateName, parameters, 'Test send');
    if (!result.ok) {
      return res.status(502).json({ success: false, message: result.error || 'WATI rejected the test' });
    }

    res.json({ success: true, message: `Test sent to ${result.number}. Check your WhatsApp.` });
  } catch (err) {
    console.error('Test send failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send the test' });
  }
}

async function getHealth(req, res) {
  try {
    res.json({ success: true, ...(await health.check()) });
  } catch (err) {
    console.error('Health check failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to run the health check' });
  }
}

module.exports = {
  listCampaigns,
  getCampaign,
  listMessages,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  previewCampaign,
  sendNow,
  scheduleCampaign,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  approveCampaign,
  duplicateCampaign,
  retarget,
  timing,
  inbox,
  getTemplates,
  testSend,
  getHealth,
};
