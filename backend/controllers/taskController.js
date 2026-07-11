const Task = require('../models/Task');
const zoho = require('../services/zoho');
const wati = require('../services/wati');

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
    whatsappLog: doc.whatsappLog || [],
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
/**
 * The list view only renders fields from `body` — it never shows statusHistory,
 * notes, taskHistory or whatsappLog (those are detail-only). Sending them costs
 * us dearly: MongoDB Atlas M0 throttles to ~20ms/document, so every extra byte
 * is real latency.
 */
function serializeList(doc) {
  return {
    id: doc.dedupeKey || doc.zohoId || String(doc._id),
    zohoId: doc.zohoId || null,
    receivedAt: doc.receivedAt,
    body: doc.body,
  };
}

// ---- Task list cache -------------------------------------------------------
// Atlas M0 takes ~25s to return all leads, and the dashboard polls every 15s.
// We serve from an in-memory cache and refresh it in the background, so the UI
// is instant and slow Atlas reads never block a request.
const TASK_CACHE_TTL_MS = Number(process.env.TASK_CACHE_TTL_MS || 30000);
let taskCache = null;
let taskCacheAt = 0;
let taskRefreshing = null;

async function loadTaskList() {
  const docs = await Task.find(
    {},
    { body: 1, receivedAt: 1, dedupeKey: 1, zohoId: 1 } // slim projection
  )
    .sort({ receivedAt: -1 })
    .lean();
  return docs.map(serializeList);
}

async function getCachedTasks() {
  const fresh = taskCache && Date.now() - taskCacheAt < TASK_CACHE_TTL_MS;
  if (fresh) return taskCache;

  if (!taskRefreshing) {
    taskRefreshing = loadTaskList()
      .then((rows) => {
        taskCache = rows;
        taskCacheAt = Date.now();
        return rows;
      })
      .finally(() => {
        taskRefreshing = null;
      });
  }

  // Stale-while-revalidate: hand back the old copy instantly if we have one.
  return taskCache || taskRefreshing;
}

/** Called after any write so the next read reflects it immediately. */
function invalidateTaskCache() {
  taskCacheAt = 0;
}

/** Warm at boot so the first dashboard load isn't the slow one. */
async function warmTaskCache() {
  const rows = await getCachedTasks();
  console.log(`Task list cache warmed: ${rows.length} leads`);
}

async function getTasks(req, res) {
  try {
    let records = await getCachedTasks();

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
  invalidateTaskCache();

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
  invalidateTaskCache();

  res.json({ success: true, data: serialize(doc), zohoSync: sync });
}

// Send a WhatsApp template to this lead's phone via WATI, and log it.
async function sendWhatsapp(req, res) {
  const doc = await loadAccessible(req, res);
  if (!doc) return;

  const { template, parameters } = req.body || {};
  if (!template) {
    return res.status(400).json({ success: false, message: 'template is required' });
  }

  const phone = doc.body && doc.body.Who_Id && doc.body.Who_Id.phone;
  if (!phone) {
    return res.status(400).json({ success: false, message: 'This lead has no phone number' });
  }

  const result = await wati.sendTemplate(phone, template, parameters || []);

  doc.whatsappLog.push({
    template,
    number: result.number || phone,
    sentBy: req.user.username,
    sentAt: new Date(),
    ok: Boolean(result.ok),
    error: result.ok ? null : result.error || (result.skipped ? 'WATI not configured' : 'Failed'),
  });
  await doc.save();

  if (!result.ok) {
    return res.status(result.skipped ? 400 : 502).json({
      success: false,
      message: result.error || 'WATI not configured',
      data: serialize(doc),
    });
  }

  res.json({ success: true, data: serialize(doc) });
}

module.exports = {
  getTasks,
  getTask,
  updateStatus,
  addNote,
  sendWhatsapp,
  invalidateTaskCache,
  warmTaskCache,
};
