const Sequence = require('../models/Sequence');
const Campaign = require('../models/Campaign');
const { FUNNEL_STATES } = require('../services/funnel');
const sequences = require('../services/sequences');

function dto(s, parent) {
  return {
    id: s._id,
    name: s.name,
    parentCampaignId: s.parentCampaignId,
    parentCampaign: parent ? parent.name : null,
    parentStatus: parent ? parent.status : null,
    parentCompletedAt: parent ? parent.completedAt : null,
    active: s.active,
    completedAt: s.completedAt,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    steps: (s.steps || []).map((step) => ({
      id: step._id,
      order: step.order,
      delayHours: step.delayHours,
      templateName: step.templateName,
      templateCategory: step.templateCategory,
      audience: step.audience,
      audienceLabel:
        (FUNNEL_STATES.find((f) => f.key === step.audience) || {}).label || step.audience,
      status: step.status,
      firedAt: step.firedAt,
      campaignId: step.campaignId,
      note: step.note,
      // When this step will actually fire. Null until the parent finishes — a drip
      // has no clock of its own, it hangs off the parent's completion.
      dueAt:
        parent && parent.completedAt
          ? new Date(new Date(parent.completedAt).getTime() + (step.delayHours || 0) * 3600000)
          : null,
    })),
  };
}

async function listSequences(req, res) {
  try {
    const rows = await Sequence.find().sort({ createdAt: -1 }).lean();
    const parents = await Campaign.find({
      _id: { $in: rows.map((r) => r.parentCampaignId) },
    })
      .select('name status completedAt')
      .lean();

    const byId = new Map(parents.map((p) => [String(p._id), p]));

    res.json({
      success: true,
      count: rows.length,
      active: rows.filter((r) => r.active).length,
      data: rows.map((r) => dto(r, byId.get(String(r.parentCampaignId)))),
    });
  } catch (err) {
    console.error('List sequences failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load sequences' });
  }
}

async function createSequence(req, res) {
  try {
    const { name, parentCampaignId, steps } = req.body;

    if (!name || !parentCampaignId || !Array.isArray(steps) || !steps.length) {
      return res.status(400).json({
        success: false,
        message: 'A sequence needs a name, a campaign to follow, and at least one step',
      });
    }

    const parent = await Campaign.findById(parentCampaignId).lean();
    if (!parent) return res.status(404).json({ success: false, message: 'Parent campaign not found' });

    const valid = new Set(FUNNEL_STATES.map((s) => s.key));
    for (const step of steps) {
      if (!step.templateName) {
        return res.status(400).json({ success: false, message: 'Every step needs a template' });
      }
      if (!valid.has(step.audience)) {
        return res.status(400).json({ success: false, message: `Unknown audience "${step.audience}"` });
      }
    }

    const sequence = await Sequence.create({
      name,
      parentCampaignId,
      createdBy: req.user.username,
      steps: steps.map((s, i) => ({
        order: i + 1,
        delayHours: Number(s.delayHours) || 48,
        templateName: s.templateName,
        templateLanguage: s.templateLanguage || '',
        templateCategory: s.templateCategory || 'MARKETING',
        variables: s.variables || [],
        audience: s.audience,
        status: 'pending',
      })),
    });

    res.json({
      success: true,
      data: dto(sequence.toObject(), parent),
      message:
        parent.status === 'completed'
          ? 'Sequence saved. The first step will fire on its schedule.'
          : 'Sequence saved. Nothing fires until the parent campaign has finished sending.',
    });
  } catch (err) {
    console.error('Create sequence failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save the sequence' });
  }
}

/** Pause or resume a drip. Pausing does not undo steps that already fired. */
async function toggleSequence(req, res) {
  try {
    const sequence = await Sequence.findById(req.params.id);
    if (!sequence) return res.status(404).json({ success: false, message: 'Sequence not found' });

    sequence.active = Boolean(req.body.active);
    await sequence.save();

    res.json({
      success: true,
      message: sequence.active
        ? 'Sequence resumed.'
        : 'Sequence paused. Steps that have already fired are still out there — you cannot unsend a WhatsApp message.',
      data: dto(sequence.toObject()),
    });
  } catch (err) {
    console.error('Toggle sequence failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update the sequence' });
  }
}

async function deleteSequence(req, res) {
  try {
    const sequence = await Sequence.findById(req.params.id).lean();
    if (!sequence) return res.status(404).json({ success: false, message: 'Sequence not found' });

    // The campaigns a fired step created are real campaigns with real recipients, and
    // they stay. Deleting the sequence only cancels what hasn't happened yet.
    await Sequence.deleteOne({ _id: sequence._id });

    const fired = (sequence.steps || []).filter((s) => s.status === 'fired').length;
    res.json({
      success: true,
      message: fired
        ? `Sequence deleted. The ${fired} campaign(s) it already sent are kept.`
        : 'Sequence deleted.',
    });
  } catch (err) {
    console.error('Delete sequence failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete the sequence' });
  }
}

/** Fire anything that is due, right now. For testing a drip without waiting for the poll. */
async function runNow(req, res) {
  try {
    const fired = await sequences.fireDue();
    res.json({ success: true, fired, message: `${fired} step(s) fired.` });
  } catch (err) {
    console.error('Run sequences failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to run the sequences' });
  }
}

module.exports = {
  listSequences,
  createSequence,
  toggleSequence,
  deleteSequence,
  runNow,
};
