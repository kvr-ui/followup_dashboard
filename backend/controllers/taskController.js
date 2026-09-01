const Task = require('../models/Task');
const zoho = require('../services/zoho');
const wati = require('../services/wati');
const { buildAcquisition } = require('../modules/ads/services/acquisitionView');
const { buildVslBlock } = require('../modules/vsl/services/vslView');
const { peekPhoneWatchMap } = require('../modules/vsl/services/watchIndex');
// Shared with the VSL tracking tab, which drops any row the logged-in rep does
// not own. Two owner-matchers that drift mean a rep sees a colleague's lead in
// one view and a 403 in the other — see utils/owner.js.
const { ownerEmailOf } = require('../utils/owner');

// Sales users may only touch tasks they own; admins may touch any.
function canAccess(user, taskDoc) {
  if (user.role === 'admin') return true;
  const mine = (user.ownerEmail || '').toLowerCase();
  const body = taskDoc.body;
  const bodies = Array.isArray(body) ? body : [body];
  return bodies.some((b) => ownerEmailOf(b) === mine);
}

function serialize(doc, extra) {
  return {
    id: doc.dedupeKey || doc.zohoId || String(doc._id),
    zohoId: doc.zohoId || null,
    receivedAt: doc.receivedAt,
    taskCategory: doc.taskCategory || null,
    taskCategorySource: doc.taskCategorySource || null,
    leadSource: doc.leadSource || null,
    body: doc.body,
    statusHistory: doc.statusHistory || [],
    notes: doc.notes || [],
    taskHistory: doc.taskHistory || [],
    whatsappLog: doc.whatsappLog || [],
    // Where this lead came from, what it answered, and (admins only) what it
    // cost. Null — not an object of nulls — when no ad lead is linked.
    acquisition: (extra && extra.acquisition) || null,
    // Peak watch time on the VSL, joined across a second Atlas cluster on the
    // last 10 digits of the phone. Null — not an object of nulls — when the VSL
    // is unconfigured, the number is too short to join, or this person was never
    // sent the video. Same discipline as `acquisition`: a failed join costs the
    // panel, not the response.
    vsl: (extra && extra.vsl) || null,
  };
}

/**
 * The detail payload, including the acquisition block.
 *
 * Built here rather than inside `serialize` because it needs the CALLER's role:
 * the cost sub-object exists only for admins, and "only for admins" is enforced
 * by never writing the key, not by hiding it in the frontend. Ad spend must not
 * be inferable from a rep's session, and a rep can read their own raw JSON.
 *
 * Every handler that returns a detail payload goes through this — adding a note
 * or changing a status replaces the whole detail object in the UI, so an
 * acquisition block present on GET but missing on PATCH would make the panel
 * vanish mid-call.
 *
 * Never throws: attribution and watch time are both worth less than the lead
 * they hang off, so a failure here costs the panel, not the response.
 */
async function detailFor(doc, user) {
  // Both blocks are optional enrichment on a second data source, so each carries
  // its own catch: a VSL cluster timeout must not cost the acquisition panel, and
  // neither may cost the lead.
  const [acquisition, vsl] = await Promise.all([
    buildAcquisition(doc, { includeCost: user && user.role === 'admin' }).catch((err) => {
      console.warn('Failed to build acquisition block:', err.message);
      return null;
    }),
    buildVslBlock(doc).catch((err) => {
      console.warn('Failed to build VSL watch block:', err.message);
      return null;
    }),
  ]);
  return { acquisition, vsl };
}

async function serializeDetail(doc, user) {
  return serialize(doc, await detailFor(doc, user));
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
    taskCategory: doc.taskCategory || null,
    taskCategorySource: doc.taskCategorySource || null,
    // Denormalised onto the Task when the lead was linked, so the Source column
    // costs one string per row and not a lookup per row. Origin never changes;
    // cost does, which is why only this is carried here.
    leadSource: doc.leadSource || null,
    // The join key for VSL watch time, decorated onto the row in getTasks below.
    // Leaks nothing the row didn't already carry: the phone is in body.Who_Id
    // and the frontend already derives it via getContact().
    phoneKey: doc.phoneKey || null,
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
// Bumped on every write-invalidation. A refresh captures the generation when it
// starts; if a write lands mid-load, the generation moves and the just-loaded
// (pre-write) data is kept stale instead of being marked fresh — otherwise a
// slow read that began before the write could overwrite the cache with old data
// and hide the write for a full TTL.
let taskCacheGen = 0;

async function loadTaskList() {
  const docs = await Task.find(
    {},
    // slim projection — the list view renders only these
    {
      body: 1,
      receivedAt: 1,
      dedupeKey: 1,
      zohoId: 1,
      taskCategory: 1,
      taskCategorySource: 1,
      leadSource: 1,
      phoneKey: 1,
    }
  )
    .sort({ receivedAt: -1 })
    .lean();
  return docs.map(serializeList);
}

async function getCachedTasks() {
  const fresh = taskCache && Date.now() - taskCacheAt < TASK_CACHE_TTL_MS;
  if (fresh) return taskCache;

  if (!taskRefreshing) {
    const startGen = taskCacheGen;
    taskRefreshing = loadTaskList()
      .then((rows) => {
        taskCache = rows;
        // Only mark fresh if no write invalidated us mid-load; otherwise leave it
        // stale so the very next read refreshes again, this time seeing the write.
        taskCacheAt = taskCacheGen === startGen ? Date.now() : 0;
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
  taskCacheGen += 1;
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

    // VSL watch time: a MAP LOOKUP per row, never a query per row — and never an
    // await. This endpoint is polled every 15s by every open browser and must not
    // acquire a dependency on the second Atlas cluster, so `peek` hands back
    // whatever is already built and kicks a refresh behind the response. A cold
    // or unreachable VSL cluster makes the Watched column render a dash and
    // changes nothing else.
    //
    // Decorated HERE rather than inside loadTaskList's cache on purpose: that
    // cache is invalidated by TASK writes only, so watch time baked into it would
    // sit stale for a full TTL with nothing able to bump it.
    const watch = peekPhoneWatchMap();
    if (watch) {
      records = records.map((r) => {
        const w = r.phoneKey ? watch.get(r.phoneKey) : null;
        return w ? { ...r, vslMinutes: w.minutes, vslPercentage: w.percentage } : r;
      });
    }

    res.json({ success: true, count: records.length, data: records });
  } catch (err) {
    console.error('Failed to fetch tasks:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch tasks' });
  }
}

async function getTask(req, res) {
  try {
    const doc = await loadAccessible(req, res);
    if (!doc) return;

    res.json({
      success: true,
      data: await serializeDetail(doc, req.user),
      zohoSync: zoho.isConfigured(),
    });
  } catch (err) {
    console.error('Failed to fetch task:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch task' });
  }
}

async function updateStatus(req, res) {
  try {
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

    res.json({ success: true, data: await serializeDetail(doc, req.user), zohoSync: sync });
  } catch (err) {
    console.error('Failed to update status:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update status' });
  }
}

async function addNote(req, res) {
  try {
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

    res.json({ success: true, data: await serializeDetail(doc, req.user), zohoSync: sync });
  } catch (err) {
    console.error('Failed to add note:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add note' });
  }
}

// Send a WhatsApp template to this lead's phone via WATI, and log it.
async function sendWhatsapp(req, res) {
  try {
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

    const data = await serializeDetail(doc, req.user);

    if (!result.ok) {
      return res.status(result.skipped ? 400 : 502).json({
        success: false,
        message: result.error || 'WATI not configured',
        data,
      });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('Failed to send WhatsApp:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send WhatsApp message' });
  }
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
