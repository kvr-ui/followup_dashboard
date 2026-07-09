const Task = require('../models/Task');
const { enrichContact, enrichTaskFields } = require('./enrich');

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

/**
 * Insert or update a contact record from a task payload.
 * Dedupes by phone number (falling back to the task id when there's no phone):
 * the most recent task becomes the visible `body`, and every task for the
 * contact is preserved in `taskHistory`.
 */
async function upsertTask(payload, { enrich = true } = {}) {
  if (!payload || typeof payload !== 'object') return null;

  if (enrich) {
    await enrichContact(payload);
    await enrichTaskFields(payload);
  }

  const phone = payload.Who_Id && payload.Who_Id.phone ? String(payload.Who_Id.phone) : null;
  const zohoId = payload.id ? String(payload.id) : null;
  const dedupeKey = phone || (zohoId ? `task:${zohoId}` : null);
  const now = new Date();
  const status = payload.Status || null;
  const summary = taskSummary(payload);

  // No key at all -> just insert (can't dedupe).
  if (!dedupeKey) {
    return Task.create({
      body: payload,
      phone,
      zohoId,
      receivedAt: now,
      statusHistory: status ? [{ status, changedAt: now, source: 'webhook' }] : [],
      taskHistory: [summary],
    });
  }

  const existing = await Task.findOne({ dedupeKey });

  if (!existing) {
    return Task.create({
      dedupeKey,
      phone,
      zohoId,
      body: payload,
      receivedAt: now,
      statusHistory: status ? [{ status, changedAt: now, source: 'webhook' }] : [],
      taskHistory: [summary],
    });
  }

  // Merge this task into the contact's task history (dedupe by task id).
  const idx = existing.taskHistory.findIndex(
    (h) => h.zohoId && summary.zohoId && h.zohoId === summary.zohoId
  );
  if (idx >= 0) existing.taskHistory[idx] = summary;
  else existing.taskHistory.push(summary);

  // The newest task (by created time) is the visible one.
  const isLatest = createdMs(payload) >= createdMs(existing.body);
  if (isLatest) {
    const prevStatus = (existing.body && existing.body.Status) || null;
    existing.body = payload;
    existing.zohoId = zohoId;
    existing.phone = phone || existing.phone;
    existing.receivedAt = now;
    existing.markModified('body');
    if (status && status !== prevStatus) {
      existing.statusHistory.push({ status, changedAt: now, source: 'webhook' });
    }
  }

  await existing.save();
  return existing;
}

module.exports = { upsertTask, taskSummary };
