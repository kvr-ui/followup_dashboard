const Task = require('../models/Task');
const zoho = require('../services/zoho');
const { enrichBody } = require('../services/enrich');

function ownerEmailOf(task) {
  return task && task.Owner && task.Owner.email
    ? String(task.Owner.email).toLowerCase()
    : null;
}

// Sales users may only touch tasks they own; admins may touch any.
function canAccess(user, taskDoc) {
  if (user.role === 'admin') return true;
  const mine = (user.ownerEmail || '').toLowerCase();
  const body = taskDoc.body;
  const bodies = Array.isArray(body) ? body : [body];
  return bodies.some((b) => ownerEmailOf(b) === mine);
}

function serialize(doc) {
  return {
    id: doc.dedupeKey || doc.zohoId || String(doc._id),
    zohoId: doc.zohoId || null,
    receivedAt: doc.receivedAt,
    body: doc.body,
    statusHistory: doc.statusHistory || [],
    notes: doc.notes || [],
    taskHistory: doc.taskHistory || [],
  };
}

// Load a task by its dedupeKey (falling back to zohoId / Mongo _id) and enforce access.
async function loadAccessible(req, res) {
  const { id } = req.params;
  let doc = await Task.findOne({ dedupeKey: id });
  if (!doc) doc = await Task.findOne({ zohoId: id });
  if (!doc && /^[a-f\d]{24}$/i.test(id)) doc = await Task.findById(id);

  if (!doc) {
    res.status(404).json({ success: false, message: 'Task not found' });
    return null;
  }
  if (!canAccess(req.user, doc)) {
    res.status(403).json({ success: false, message: 'Not your lead' });
    return null;
  }
  return doc;
}

/**
 * List tasks for the dashboard.
 * - Admins see every task.
 * - Sales users see only tasks whose Owner.email matches their ownerEmail.
 */
async function getTasks(req, res) {
  try {
    const all = await Task.find().sort({ receivedAt: -1 });

    // Backfill contact phone/email for any task that doesn't have it yet.
    // enrichBody skips tasks already enriched, so this is a no-op once filled.
    for (const doc of all) {
      if (await enrichBody(doc.body)) {
        doc.markModified('body');
        await doc.save();
      }
    }

    let records = all.map(serialize);

    if (req.user.role !== 'admin') {
      const mine = (req.user.ownerEmail || '').toLowerCase();
      records = records
        .map((r) => {
          if (Array.isArray(r.body)) {
            const filtered = r.body.filter((b) => ownerEmailOf(b) === mine);
            if (filtered.length === 0) return null;
            return { ...r, body: filtered.length === 1 ? filtered[0] : filtered };
          }
          return ownerEmailOf(r.body) === mine ? r : null;
        })
        .filter(Boolean);
    }

    res.json({ success: true, count: records.length, data: records });
  } catch (err) {
    console.error('Failed to fetch tasks:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
  }
}

async function getTask(req, res) {
  const doc = await loadAccessible(req, res);
  if (!doc) return;

  if (await enrichBody(doc.body)) {
    doc.markModified('body');
    await doc.save();
  }

  res.json({ success: true, data: serialize(doc), zohoSync: zoho.isConfigured() });
}

async function updateStatus(req, res) {
  const doc = await loadAccessible(req, res);
  if (!doc) return;

  const { status } = req.body || {};
  if (!status) {
    return res.status(400).json({ success: false, message: 'status is required' });
  }

  // Update the local snapshot + history immediately.
  if (!doc.body || typeof doc.body !== 'object' || Array.isArray(doc.body)) {
    doc.body = { ...(doc.body || {}) };
  }
  doc.body.Status = status;
  doc.markModified('body');
  doc.statusHistory.push({
    status,
    changedAt: new Date(),
    source: 'dashboard',
    by: req.user.username,
  });

  // Best-effort write-back to Zoho.
  let sync = { ok: false, skipped: true };
  if (doc.zohoId) sync = await zoho.updateTaskStatus(doc.zohoId, status);

  await doc.save();

  res.json({ success: true, data: serialize(doc), zohoSync: sync });
}

async function addNote(req, res) {
  const doc = await loadAccessible(req, res);
  if (!doc) return;

  const { text } = req.body || {};
  if (!text || !text.trim()) {
    return res.status(400).json({ success: false, message: 'Note text is required' });
  }

  let sync = { ok: false, skipped: true };
  if (doc.zohoId) {
    sync = await zoho.addNote(doc.zohoId, 'Follow-up note', text.trim());
  }

  doc.notes.push({
    text: text.trim(),
    author: req.user.username,
    createdAt: new Date(),
    syncedToZoho: Boolean(sync.ok),
  });
  await doc.save();

  res.json({ success: true, data: serialize(doc), zohoSync: sync });
}

module.exports = { getTasks, getTask, updateStatus, addNote };
