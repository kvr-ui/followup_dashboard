const Task = require('../models/Task');
const { enrichContact, enrichTaskFields, normalizeContact } = require('./enrich');
const { resolveCategory } = require('./taskCategory');
const { phoneKey } = require('../utils/phone');
const { linkTask } = require('../modules/ads/services/leadLinker');

function taskSummary(t) {
  const { category } = resolveCategory(t);
  return {
    zohoId: t.id ? String(t.id) : null,
    subject: t.Subject || null,
    status: t.Status || null,
    dueDate: t.Due_Date || null,
    createdTime: t.Created_Time ? new Date(t.Created_Time) : null,
    ownerName: (t.Owner && t.Owner.name) || null,
    category,
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

    // The lead's category is the NEWEST task's category — and we only get here when
    // this payload IS the newest. Never let a Bigin value be downgraded by a guess
    // from the subject line.
    const resolved = resolveCategory(payload);
    if (resolved.category || existing.taskCategorySource !== 'bigin') {
      existing.taskCategory = resolved.category;
      existing.taskCategorySource = resolved.source;
    }

    existing.receivedAt = now;
    existing.markModified('body');
    if (status && status !== prevStatus) {
      existing.statusHistory.push({ status, changedAt: now, source: 'webhook' });
    }
  }

  // Keep the match key in step with the phone we hold. Done OUTSIDE the
  // newest-task branch on purpose: a contact stored before this field existed
  // must gain its key on the next webhook of any age, not wait for a backfill.
  // Only ever overwrite with a real key — a payload missing the phone must not
  // erase one we already derived.
  const key = phoneKey((payload.Who_Id && payload.Who_Id.phone) || existing.phone);
  if (key) existing.phoneKey = key;

  return existing;
}

/**
 * Attach this contact to the ad lead it came from, if one is waiting.
 *
 * This is the REVERSE direction of the link. The forward one — a lead arriving
 * and looking for its contact — runs in the ingest route, but it only helps when
 * the contact already exists. The common ordering is the other way round: someone
 * fills the ad form, and Bigin creates the contact seconds or days later. Without
 * this call that lead stays unlinked until the one-shot backfill is re-run by
 * hand, which is not a thing that happens on a schedule.
 *
 * Called on every upsert rather than only on create, so a contact that gains a
 * Bigin id after being matched on phone alone can be upgraded to the stronger
 * match — `applyLink` handles the re-point. Both callers of `upsertTask` are
 * incremental (a single webhook, or the poller's modified-since window), so the
 * matcher's two or three reads per contact are bounded.
 */
async function linkAdLead(doc) {
  if (!doc) return doc;

  try {
    const result = await linkTask(doc);
    if (result) {
      // `linkTask` writes straight to the collection, so mirror the outcome onto
      // the in-memory document we are about to hand back — otherwise the caller
      // returns a contact that reads as unattributed until something loads it again.
      doc.linkedLeadId = result.leadId;
      doc.leadSource = result.leadSource;
    }
  } catch (err) {
    // A lead link is derived data; the contact is not. Never let attribution fail
    // the webhook carrying the contact itself — a dropped contact is unrecoverable,
    // a dropped link is one `linkLeadsToTasks.js` run away.
    console.warn(`[taskStore] ad-lead link failed for ${doc._id}: ${err.message}`);
  }

  return doc;
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

  // A payload with neither a task id nor a contact id identifies nothing. Storing
  // it creates a phantom lead: no name, no phone, empty body, impossible to match
  // to anything ever again. An empty `{}` POST to /webhook used to do exactly that.
  // Drop it rather than pollute the leads table.
  const hasTaskId = Boolean(payload.id);
  const hasContactId = Boolean(payload.Who_Id && payload.Who_Id.id);
  if (!hasTaskId && !hasContactId) return null;

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
    return await linkAdLead(existing);
  }

  const dedupeKey = contactId ? `contact:${contactId}` : taskId ? `task:${taskId}` : null;
  const phone = payload.Who_Id && payload.Who_Id.phone ? String(payload.Who_Id.phone) : null;

  const resolved = resolveCategory(payload);

  try {
    const created = await Task.create({
      dedupeKey,
      phone,
      // null (not a truncated fragment) when the number is unusable — a 6-digit
      // key would loosely match unrelated numbers ending the same way.
      phoneKey: phoneKey(phone),
      zohoId: taskId,
      taskCategory: resolved.category,
      taskCategorySource: resolved.source,
      body: payload,
      receivedAt: now,
      statusHistory: status ? [{ status, changedAt: now, source: 'webhook' }] : [],
      taskHistory: [taskSummary(payload)],
    });
    return await linkAdLead(created);
  } catch (err) {
    // Two payloads for a brand-new contact raced — fall back to merge.
    if (err.code === 11000) {
      const again = contactId
        ? await Task.findOne({ 'body.Who_Id.id': contactId })
        : await Task.findOne({ dedupeKey });
      if (again) {
        mergeInto(again, payload, now);
        await again.save();
        return await linkAdLead(again);
      }
    }
    throw err;
  }
}

module.exports = { upsertTask, taskSummary };
