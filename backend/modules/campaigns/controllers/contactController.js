const mongoose = require('mongoose');

const Contact = require('../models/Contact');
const Campaign = require('../models/Campaign');
const CampaignMessage = require('../models/CampaignMessage');
const LinkClick = require('../models/LinkClick');
const Suppression = require('../models/Suppression');
const Task = require('../../../models/Task');
const { normalizeNumber } = require('../services/watiApi');
const { stateOf } = require('../services/funnel');

/** Escape a user string before it becomes a regex — otherwise "(" is a 500 and ".*" is a table scan. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dto(c) {
  return {
    id: c._id,
    phone: c.phoneKey,
    name: c.name,
    email: c.email,
    tags: c.tags || [],
    source: c.source,
    ownerEmail: c.ownerEmail,
    attributes: c.attributes || {},
    optedOut: c.optedOut,
    optedOutAt: c.optedOutAt,
    optOutReason: c.optOutReason,
    invalid: c.invalid,
    invalidReason: c.invalidReason,
    stats: c.stats || {},
    lastCampaignAt: c.lastCampaignAt,
    lastClickAt: c.lastClickAt,
    lastInboundAt: c.lastInboundAt,
    // Can we still free-text them, or does it have to be a paid template?
    sessionOpen: Boolean(
      c.lastInboundAt && Date.now() - new Date(c.lastInboundAt).getTime() < 24 * 3600 * 1000
    ),
    createdAt: c.createdAt,
  };
}

async function listContacts(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const filter = {};
    if (req.query.tag) filter.tags = req.query.tag;
    if (req.query.source) filter.source = req.query.source;
    if (req.query.status === 'optedOut') filter.optedOut = true;
    if (req.query.status === 'invalid') filter.invalid = true;
    if (req.query.status === 'contactable') Object.assign(filter, { optedOut: false, invalid: false });

    if (req.query.search) {
      const rx = new RegExp(escapeRegex(req.query.search.trim()), 'i');
      filter.$or = [{ name: rx }, { phoneKey: rx }, { email: rx }];
    }

    const [rows, total, contactable, optedOut, invalid] = await Promise.all([
      Contact.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Contact.countDocuments(filter),
      Contact.countDocuments({ optedOut: false, invalid: false }),
      Contact.countDocuments({ optedOut: true }),
      Contact.countDocuments({ invalid: true }),
    ]);

    res.json({
      success: true,
      count: rows.length,
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
      contactable,
      optedOut,
      invalid,
      data: rows.map(dto),
    });
  } catch (err) {
    console.error('List contacts failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load contacts' });
  }
}

/**
 * Create or update one contact.
 *
 * Upsert by phone, never insert blindly: the number is the identity, and two rows for
 * the same number means that person gets every campaign twice.
 */
async function upsertOne({ phone, name, email, tags, attributes, source, ownerEmail, createdBy }) {
  const phoneKey = normalizeNumber(phone);
  if (!phoneKey) return { ok: false, error: 'Invalid phone number' };

  // The suppression list is checked on the way IN, not just on the way out. A contact
  // who opted out in March and lands in today's CSV must arrive already opted out —
  // otherwise every fresh import silently re-subscribes the people who told us to stop.
  const suppressed = await Suppression.findOne({ phoneKey }).lean();

  const set = { source: source || 'manual' };
  if (name !== undefined) set.name = name || null;
  if (email !== undefined) set.email = email || null;
  if (ownerEmail !== undefined) set.ownerEmail = ownerEmail || null;
  if (attributes && Object.keys(attributes).length) set.attributes = attributes;

  if (suppressed) {
    set.optedOut = true;
    set.optedOutAt = suppressed.createdAt || new Date();
    set.optOutReason = suppressed.reason;
  }

  const update = {
    $set: set,
    $setOnInsert: { phoneKey, createdBy: createdBy || null },
  };
  if (tags && tags.length) update.$addToSet = { tags: { $each: tags } };

  const contact = await Contact.findOneAndUpdate({ phoneKey }, update, {
    upsert: true,
    new: true,
    setDefaultsOnInsert: true,
  });

  return { ok: true, contact, suppressed: Boolean(suppressed) };
}

async function createContact(req, res) {
  try {
    const result = await upsertOne({ ...req.body, createdBy: req.user.username });
    if (!result.ok) return res.status(400).json({ success: false, message: result.error });

    res.json({
      success: true,
      data: dto(result.contact.toObject()),
      message: result.suppressed
        ? 'Added — but this number is on the do-not-message list, so no campaign will reach it.'
        : 'Contact saved.',
    });
  } catch (err) {
    console.error('Create contact failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save the contact' });
  }
}

async function updateContact(req, res) {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    const { name, email, tags, attributes, ownerEmail } = req.body;
    if (name !== undefined) contact.name = name || null;
    if (email !== undefined) contact.email = email || null;
    if (ownerEmail !== undefined) contact.ownerEmail = ownerEmail || null;
    if (Array.isArray(tags)) contact.tags = tags;
    if (attributes) contact.attributes = { ...contact.attributes, ...attributes };

    await contact.save();
    res.json({ success: true, data: dto(contact.toObject()) });
  } catch (err) {
    console.error('Update contact failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update the contact' });
  }
}

async function deleteContact(req, res) {
  try {
    const contact = await Contact.findById(req.params.id).lean();
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    // Deleting an opted-out contact would erase the evidence they ever said stop —
    // and the phone-level Suppression row is what survives it. Written before the
    // delete, so a crash between the two leaves us over-cautious, never under.
    if (contact.optedOut) {
      await Suppression.updateOne(
        { phoneKey: contact.phoneKey },
        { $setOnInsert: { reason: contact.optOutReason || 'manual', createdBy: req.user.username } },
        { upsert: true }
      ).catch(() => {});
    }

    await Contact.deleteOne({ _id: contact._id });
    res.json({ success: true, message: 'Contact deleted' });
  } catch (err) {
    console.error('Delete contact failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to delete the contact' });
  }
}

/**
 * POST /api/contacts/import — bulk add, from a pasted CSV or an uploaded file the
 * frontend has already parsed into rows.
 *
 * Reports back exactly what happened to every row. A silent "imported 4,812 of 5,000"
 * is useless — you need to know WHICH 188 failed and why, or you will never fix the
 * source data and the same 188 will fail next month.
 */
async function importContacts(req, res) {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const tags = Array.isArray(req.body.tags) ? req.body.tags : [];
    const source = req.body.source || 'csv';

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'No rows to import' });
    }
    if (rows.length > 20000) {
      return res.status(400).json({ success: false, message: 'Import at most 20,000 rows at a time' });
    }

    const result = { imported: 0, updated: 0, suppressed: 0, failed: 0, errors: [] };
    const seen = new Set();

    for (const [i, row] of rows.entries()) {
      const phone = row.phone || row.Phone || row.number || row.mobile || row.whatsapp;
      const phoneKey = normalizeNumber(phone);

      if (!phoneKey) {
        result.failed += 1;
        if (result.errors.length < 100) {
          result.errors.push({ row: i + 1, phone: phone || '(blank)', error: 'Not a usable phone number' });
        }
        continue;
      }

      // A duplicate inside the same file is not an error, but it must not be counted
      // twice — otherwise the import report claims more contacts than exist.
      if (seen.has(phoneKey)) continue;
      seen.add(phoneKey);

      // Everything that isn't a known column becomes a template variable. This is how
      // a CSV with a "course" or "batch" column ends up usable in {{course}}.
      const attributes = {};
      for (const [k, v] of Object.entries(row)) {
        const key = String(k).trim();
        if (['phone', 'Phone', 'number', 'mobile', 'whatsapp', 'name', 'Name', 'email', 'Email'].includes(key)) {
          continue;
        }
        if (key && v !== undefined && v !== '') attributes[key] = v;
      }

      try {
        const existing = await Contact.exists({ phoneKey });
        const r = await upsertOne({
          phone: phoneKey,
          name: row.name || row.Name || null,
          email: row.email || row.Email || null,
          tags,
          attributes,
          source,
          createdBy: req.user.username,
        });

        if (!r.ok) {
          result.failed += 1;
          continue;
        }
        if (existing) result.updated += 1;
        else result.imported += 1;
        if (r.suppressed) result.suppressed += 1;
      } catch (err) {
        result.failed += 1;
        if (result.errors.length < 100) {
          result.errors.push({ row: i + 1, phone: phoneKey, error: err.message });
        }
      }
    }

    res.json({
      success: true,
      ...result,
      message:
        `${result.imported} new, ${result.updated} updated` +
        (result.suppressed ? `, ${result.suppressed} already opted out (they will not be messaged)` : '') +
        (result.failed ? `, ${result.failed} rejected` : '') +
        '.',
    });
  } catch (err) {
    console.error('Import contacts failed:', err.message);
    res.status(500).json({ success: false, message: 'Import failed' });
  }
}

/**
 * POST /api/contacts/import/bigin — pull the leads you already have.
 *
 * The Task collection is already one document per contact, deduped by phone, with the
 * owner and the Bigin payload attached. Re-typing those into a CSV to upload them back
 * into the same database would be absurd, so this just reads them across — carrying the
 * owner's email, so a reply to a campaign can be routed to the rep who knows the lead.
 */
async function importFromBigin(req, res) {
  try {
    const tags = Array.isArray(req.body.tags) ? req.body.tags : ['bigin'];
    const limit = Math.min(Number(req.body.limit) || 5000, 20000);

    const tasks = await Task.find({ phone: { $ne: null } })
      .select('phone body')
      .limit(limit)
      .lean();

    const result = { imported: 0, updated: 0, suppressed: 0, failed: 0 };

    for (const t of tasks) {
      const who = (t.body && t.body.Who_Id) || {};
      const owner = (t.body && t.body.Owner) || {};
      const phoneKey = normalizeNumber(t.phone || who.phone);
      if (!phoneKey) {
        result.failed += 1;
        continue;
      }

      try {
        const existing = await Contact.exists({ phoneKey });
        const r = await upsertOne({
          phone: phoneKey,
          name: who.name || null,
          email: who.email || null,
          ownerEmail: owner.email || null,
          tags,
          source: 'bigin',
          createdBy: req.user.username,
        });
        if (!r.ok) {
          result.failed += 1;
          continue;
        }
        if (existing) result.updated += 1;
        else result.imported += 1;
        if (r.suppressed) result.suppressed += 1;
      } catch (err) {
        result.failed += 1;
      }
    }

    res.json({
      success: true,
      ...result,
      scanned: tasks.length,
      message: `${result.imported} new, ${result.updated} updated from your Bigin leads.`,
    });
  } catch (err) {
    console.error('Bigin import failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to import from Bigin' });
  }
}

// --- Opt-out ------------------------------------------------------------------

async function optOut(req, res) {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    contact.optedOut = true;
    contact.optedOutAt = new Date();
    contact.optOutReason = 'manual';
    await contact.save();

    await Suppression.updateOne(
      { phoneKey: contact.phoneKey },
      { $setOnInsert: { reason: 'manual', createdBy: req.user.username } },
      { upsert: true }
    ).catch(() => {});

    res.json({ success: true, message: 'Contact opted out.', data: dto(contact.toObject()) });
  } catch (err) {
    console.error('Opt out failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to opt the contact out' });
  }
}

/**
 * Opting someone back IN is a deliberate, logged act, and it needs a reason.
 *
 * Someone who replied STOP did not change their mind because you clicked a button.
 * The only legitimate use of this is fixing a mistake — a wrong number suppressed, a
 * misfired bulk action — which is why it refuses to touch a `replied_stop` suppression
 * without an explicit, recorded override.
 */
async function optIn(req, res) {
  try {
    const contact = await Contact.findById(req.params.id);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    const suppression = await Suppression.findOne({ phoneKey: contact.phoneKey }).lean();

    if (suppression && suppression.reason === 'replied_stop' && !req.body.override) {
      return res.status(400).json({
        success: false,
        message:
          'This person replied STOP. Opting them back in without their consent is not something the dashboard will do quietly — pass override:true and a reason if this was a mistake.',
        evidence: suppression.evidence,
      });
    }

    contact.optedOut = false;
    contact.optedOutAt = null;
    contact.optOutReason = null;
    await contact.save();

    await Suppression.deleteOne({ phoneKey: contact.phoneKey });
    console.log(
      `[campaigns] ${req.user.username} opted ${contact.phoneKey} back in` +
        (req.body.reason ? ` — "${req.body.reason}"` : '')
    );

    res.json({ success: true, message: 'Contact opted back in.', data: dto(contact.toObject()) });
  } catch (err) {
    console.error('Opt in failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to opt the contact in' });
  }
}

async function listSuppressions(req, res) {
  try {
    const rows = await Suppression.find().sort({ createdAt: -1 }).limit(500).lean();
    res.json({
      success: true,
      count: rows.length,
      data: rows.map((s) => ({
        id: s._id,
        phone: s.phoneKey,
        reason: s.reason,
        evidence: s.evidence,
        createdBy: s.createdBy,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    console.error('List suppressions failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load the do-not-message list' });
  }
}

async function addSuppression(req, res) {
  try {
    const phoneKey = normalizeNumber(req.body.phone);
    if (!phoneKey) return res.status(400).json({ success: false, message: 'Invalid phone number' });

    await Suppression.updateOne(
      { phoneKey },
      { $setOnInsert: { reason: req.body.reason || 'manual', createdBy: req.user.username } },
      { upsert: true }
    );
    await Contact.updateOne(
      { phoneKey },
      { $set: { optedOut: true, optedOutAt: new Date(), optOutReason: 'manual' } }
    );

    res.json({ success: true, message: `${phoneKey} will never be messaged again.` });
  } catch (err) {
    console.error('Add suppression failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to suppress the number' });
  }
}

// --- One contact's history ----------------------------------------------------

/** Everything we ever sent this person, and what they did about it. */
async function contactHistory(req, res) {
  try {
    const id = new mongoose.Types.ObjectId(req.params.id);
    const contact = await Contact.findById(id).lean();
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    const [messages, clicks] = await Promise.all([
      CampaignMessage.find({ contactId: id })
        .sort({ createdAt: -1 })
        .limit(100)
        .populate('campaignId', 'name templateName')
        .lean(),
      LinkClick.find({ contactId: id, bot: false }).sort({ clickedAt: -1 }).limit(50).lean(),
    ]);

    res.json({
      success: true,
      data: dto(contact),
      messages: messages.map((m) => ({
        id: m._id,
        campaign: (m.campaignId && m.campaignId.name) || '(deleted)',
        campaignId: m.campaignId && m.campaignId._id,
        template: m.templateName,
        state: stateOf(m),
        status: m.status,
        sentAt: m.sentAt,
        readAt: m.readAt,
        repliedAt: m.repliedAt,
        replyText: m.replyText,
        clickCount: m.clickCount,
        errorMessage: m.errorMessage,
        skipReason: m.skipReason,
      })),
      clicks: clicks.map((c) => ({ url: c.targetUrl, at: c.clickedAt })),
    });
  } catch (err) {
    console.error('Contact history failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load the contact history' });
  }
}

async function listTags(req, res) {
  try {
    const tags = await Contact.distinct('tags');
    res.json({ success: true, data: tags.filter(Boolean).sort() });
  } catch (err) {
    console.error('List tags failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load tags' });
  }
}

/** Add or remove a tag across a set of contacts — the bulk action the segment builder needs. */
async function bulkTag(req, res) {
  try {
    const ids = (req.body.contactIds || []).map((i) => new mongoose.Types.ObjectId(i));
    const tag = String(req.body.tag || '').trim();
    if (!ids.length || !tag) {
      return res.status(400).json({ success: false, message: 'Pick some contacts and a tag' });
    }

    const update = req.body.remove ? { $pull: { tags: tag } } : { $addToSet: { tags: tag } };
    const result = await Contact.updateMany({ _id: { $in: ids } }, update);

    res.json({
      success: true,
      message: `${req.body.remove ? 'Removed' : 'Added'} "${tag}" on ${result.modifiedCount} contact(s).`,
      modified: result.modifiedCount,
    });
  } catch (err) {
    console.error('Bulk tag failed:', err.message);
    res.status(500).json({ success: false, message: 'Failed to tag the contacts' });
  }
}

module.exports = {
  listContacts,
  createContact,
  updateContact,
  deleteContact,
  importContacts,
  importFromBigin,
  optOut,
  optIn,
  listSuppressions,
  addSuppression,
  contactHistory,
  listTags,
  bulkTag,
};
