const Task = require('../models/Task');
const { enrichContact, enrichTaskFields, normalizeContact } = require('./enrich');

function taskSummary(t) {
  return {
    zohoId: t.id ? String(t.id) : null,
    subject: t.Subject || null,
    status: t.Status || null,
    dueDate: t.Due_Date || null,
    createdTime: t.Created_Time ? new Date(t.Created_Time) : null,
    ownerName: (t.Owner && t.Owner.name) || null,
  };
}

function createdMs(t) {
  const d = t && t.Created_Time ? new Date(t.Created_Time) : null;
  return d && !isNaN(d.getTime()) ? d.getTime() : 0;
}

// Merge a task payload into an existing contact record (add to history, and
// make it the visible task if it's the newest). Preserves already-enriched
// contact fields (phone/email/subject) if this payload doesn't carry them.
function mergeInto(existing, payload, now) {
  const status = payload.Status || null;
  const summary = taskSummary(payload);

  const idx = existing.taskHistory.findIndex(
    (h) => h.zohoId && summary.zohoId && h.zohoId === summary.zohoId
  );
  if (idx >= 0) existing.taskHistory[idx] = summary;
  else existing.taskHistory.push(summary);

  if (createdMs(payload) >= createdMs(existing.body)) {
    const prevStatus = (existing.body && existing.body.Status) || null;
    const prevWho = (existing.body && existing.body.Who_Id) || {};
    const newWho = payload.Who_Id || {};
    payload.Who_Id = {
      ...newWho,
      name: newWho.name || prevWho.name,
      phone: newWho.phone || prevWho.phone,
      email: newWho.email || prevWho.email,
    };
    if (!payload.Subject && existing.body && existing.body.Subject) {
      payload.Subject = existing.body.Subject;
    }
    existing.body = payload;
    existing.zohoId = payload.id ? String(payload.id) : existing.zohoId;
    if (payload.Who_Id.phone) existing.phone = String(payload.Who_Id.phone);
    existing.receivedAt = now;
    existing.markModified('body');
    if (status && status !== prevStatus) {
      existing.statusHistory.push({ status, changedAt: now, source: 'webhook' });
    }
  }
  return existing;
}

/**
 * Insert or update a contact record from a task payload.
 *
 * Dedupe is by CONTACT id (Who_Id.id) — which is present in every payload, so
 * NO Zoho call is needed to find the right record. Enrichment (phone/subject
 * from Zoho) is optional and, for webhooks, deferred to the background so the
 * webhook responds instantly.
 */
async function upsertTask(payload, { enrich = false } = {}) {
  if (!payload || typeof payload !== 'object') return null;

  normalizeContact(payload); // no Zoho — maps Related_To -> Who_Id if needed

  if (enrich) {
    await enrichContact(payload);
    await enrichTaskFields(payload);
  }

  const now = new Date();
  const contactId = payload.Who_Id && payload.Who_Id.id ? String(payload.Who_Id.id) : null;
  const taskId = payload.id ? String(payload.id) : null;
  const status = payload.Status || null;

  // Find the existing record for this contact (by contact id), or by task id
  // for tasks with no contact.
  let existing = null;
  if (contactId) existing = await Task.findOne({ 'body.Who_Id.id': contactId });
  if (!existing && taskId) existing = await Task.findOne({ zohoId: taskId });

  if (existing) {
    mergeInto(existing, payload, now);
    await existing.save();
    return existing;
  }

  const dedupeKey = contactId ? `contact:${contactId}` : taskId ? `task:${taskId}` : null;
  const phone = payload.Who_Id && payload.Who_Id.phone ? String(payload.Who_Id.phone) : null;

  try {
    return await Task.create({
      dedupeKey,
      phone,
      zohoId: taskId,
      body: payload,
      receivedAt: now,
      statusHistory: status ? [{ status, changedAt: now, source: 'webhook' }] : [],
      taskHistory: [taskSummary(payload)],
    });
  } catch (err) {
    // Two payloads for a brand-new contact raced — fall back to merge.
    if (err.code === 11000) {
      const again = contactId
        ? await Task.findOne({ 'body.Who_Id.id': contactId })
        : await Task.findOne({ dedupeKey });
      if (again) {
        mergeInto(again, payload, now);
        await again.save();
        return again;
      }
    }
    throw err;
  }
}

module.exports = { upsertTask, taskSummary };
