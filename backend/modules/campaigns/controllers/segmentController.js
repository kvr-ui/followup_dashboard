const Segment = require('../models/Segment');
const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const segments = require('../services/segments');
const { FUNNEL_STATES } = require('../services/funnel');

function dto(s) {
  return {
    id: s._id,
    name: s.name,
    description: s.description,
    rule: s.rule,
    lastCount: s.lastCount,
    lastCountedAt: s.lastCountedAt,
    system: s.system,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
  };
}

async function listSegments(req, res) {
  try {
    const rows = await Segment.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, count: rows.length, data: rows.map(dto) });
  } catch (err) {
    console.error('List segments failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load segments' });
  }
}

/**
 * Count a rule without saving it — the live "412 contacts match" under the builder.
 *
 * Returns BOTH numbers: how many match, and how many of those we are not allowed to
 * message. Showing only the reachable count would quietly hide the fact that a third
 * of the audience has opted out, which is exactly the thing you need to see.
 */
async function previewRule(req, res) {
  try {
    const rule = req.body.rule || (req.body.id ? (await Segment.findById(req.body.id).lean()).rule : null);
    if (!rule) return res.status(400).json({ success: false, message: 'No rule to preview' });

    const [contactable, everyone] = await Promise.all([
      segments.compile(rule, { includeUncontactable: false }),
      segments.compile(rule, { includeUncontactable: true }),
    ]);

    const [count, total, sample] = await Promise.all([
      Contact.countDocuments(contactable),
      Contact.countDocuments(everyone),
      Contact.find(contactable).limit(20).lean(),
    ]);

    res.json({
      success: true,
      count,
      excluded: Math.max(total - count, 0),
      sample: sample.map((c) => ({
        id: c._id,
        name: c.name,
        phone: c.phoneKey,
        tags: c.tags,
        lastCampaignAt: c.lastCampaignAt,
      })),
    });
  } catch (err) {
    console.error('Preview segment failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to count the segment' });
  }
}

async function createSegment(req, res) {
  try {
    const { name, description, rule } = req.body;
    if (!name || !rule) {
      return res.status(400).json({ success: false, message: 'A name and a rule are required' });
    }

    const filter = await segments.compile(rule);
    const lastCount = await Contact.countDocuments(filter);

    const segment = await Segment.create({
      name,
      description: description || '',
      rule,
      lastCount,
      lastCountedAt: new Date(),
      createdBy: req.user.username,
    });

    res.json({ success: true, data: dto(segment.toObject()) });
  } catch (err) {
    console.error('Create segment failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save the segment' });
  }
}

async function updateSegment(req, res) {
  try {
    const segment = await Segment.findById(req.params.id);
    if (!segment) return res.status(404).json({ success: false, message: 'Segment not found' });

    const { name, description, rule } = req.body;
    if (name) segment.name = name;
    if (description !== undefined) segment.description = description;
    if (rule) {
      segment.rule = rule;
      segment.lastCount = await Contact.countDocuments(await segments.compile(rule));
      segment.lastCountedAt = new Date();
    }

    await segment.save();
    res.json({ success: true, data: dto(segment.toObject()) });
  } catch (err) {
    console.error('Update segment failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update the segment' });
  }
}

async function deleteSegment(req, res) {
  try {
    await Segment.deleteOne({ _id: req.params.id });
    res.json({ success: true, message: 'Segment deleted' });
  } catch (err) {
    console.error('Delete segment failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete the segment' });
  }
}

/**
 * GET /api/segments/schema — what the rule builder is allowed to offer.
 *
 * The UI reads its field list, operators and funnel states from here rather than
 * hard-coding them, so the builder cannot drift out of step with what the compiler
 * on the server will actually accept.
 */
async function schema(req, res) {
  try {
    const [tags, campaigns, attributeKeys] = await Promise.all([
      Contact.distinct('tags'),
      Campaign.find({ 'stats.sent': { $gt: 0 } })
        .select('name createdAt')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      // Whatever columns people actually uploaded. Sampled, not scanned — the point
      // is to populate a dropdown, not to be exhaustive over a million documents.
      Contact.aggregate([
        { $sample: { size: 500 } },
        { $project: { keys: { $objectToArray: { $ifNull: ['$attributes', {}] } } } },
        { $unwind: '$keys' },
        { $group: { _id: '$keys.k' } },
        { $limit: 50 },
      ]),
    ]);

    res.json({
      success: true,
      fields: [
        { field: 'tags', label: 'Tag', type: 'array', ops: ['in', 'nin'], options: tags.filter(Boolean).sort() },
        { field: 'source', label: 'Source', type: 'string', ops: ['eq', 'ne'], options: ['manual', 'csv', 'bigin', 'wati', 'inbound'] },
        { field: 'name', label: 'Name', type: 'string', ops: ['contains', 'exists', 'missing'] },
        { field: 'email', label: 'Email', type: 'string', ops: ['contains', 'exists', 'missing'] },
        { field: 'ownerEmail', label: 'Owner (rep)', type: 'string', ops: ['eq', 'ne', 'exists'] },
        { field: 'lastCampaignAt', label: 'Last messaged', type: 'date', ops: ['before', 'after', 'never', 'within_days', 'not_within_days'] },
        { field: 'lastClickAt', label: 'Last clicked', type: 'date', ops: ['after', 'never', 'within_days'] },
        { field: 'createdAt', label: 'Added on', type: 'date', ops: ['before', 'after', 'within_days'] },
        { field: 'stats.clicked', label: 'Total clicks', type: 'number', ops: ['gt', 'lt', 'eq'] },
        { field: 'stats.replied', label: 'Total replies', type: 'number', ops: ['gt', 'lt', 'eq'] },
        { field: 'stats.sent', label: 'Messages sent', type: 'number', ops: ['gt', 'lt', 'eq'] },
        { field: 'sessionOpen', label: 'Inside the 24h reply window', type: 'boolean', ops: ['eq'] },
        {
          field: 'engagement',
          label: 'How they behaved in a campaign',
          type: 'engagement',
          ops: ['is', 'is_not'],
          states: FUNNEL_STATES.map((s) => ({ key: s.key, label: s.label })),
          campaigns: campaigns.map((c) => ({ id: c._id, name: c.name })),
        },
        ...attributeKeys.map((k) => ({
          field: `attributes.${k._id}`,
          label: k._id,
          type: 'string',
          ops: ['eq', 'ne', 'contains', 'exists', 'missing'],
        })),
      ],
      // Opt-outs and dead numbers are excluded from every segment by the compiler and
      // are deliberately NOT offered as a field — there must be no way to build an
      // audience that messages someone who asked you to stop.
      note: 'Opted-out and unreachable contacts are always excluded from a segment. That is not something a rule can switch off.',
    });
  } catch (err) {
    console.error('Segment schema failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load the segment builder' });
  }
}

module.exports = {
  listSegments,
  previewRule,
  createSegment,
  updateSegment,
  deleteSegment,
  schema,
};
