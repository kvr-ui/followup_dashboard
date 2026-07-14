const Task = require('../models/Task');
const { upsertTask } = require('../services/taskStore');
const { invalidateTaskCache } = require('./taskController');

/**
 * Re-store the task with the fields Zoho Flow didn't send.
 *
 * Two things are missing from the webhook payload — the contact's phone, and
 * `Task_Category` (a custom picklist Zoho Flow simply never maps). Both have to be
 * read back from the Bigin API, which is far too slow to do before responding, so
 * we do it here, after the 200.
 *
 * Note we enrich the ORIGINAL PAYLOAD and re-run upsertTask, rather than enriching
 * the stored document. That distinction is load-bearing: a lead has many tasks but
 * we keep only ONE `body` (their newest). When a webhook arrives for an OLDER task,
 * upsertTask correctly refuses to overwrite `body` — so enriching `body` would fetch
 * the category of the wrong task and drop the incoming one's on the floor. Enriching
 * the payload puts the category on the right task's history entry either way.
 *
 * upsertTask is keyed by contact, so running it twice is safe.
 */
async function enrichInBackground(payload) {
  try {
    if (!payload || !payload.id) return;
    await upsertTask(payload, { enrich: true });
    invalidateTaskCache(); // phone/category are now known — refresh the cached list
  } catch (err) {
    console.warn('Background enrich failed:', err.message);
  }
}

/**
 * Handle an incoming webhook POST request.
 * Stores the task(s) immediately (no Zoho calls) and responds fast, then
 * enriches phone/subject in the background. Deduped by contact id.
 */
async function receiveWebhook(req, res) {
  try {
    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    const saved = [];
    for (const p of payloads) saved.push(await upsertTask(p, { enrich: false }));

    console.log(`Webhook received: ${saved.length} task(s) stored`);
    invalidateTaskCache(); // new lead must show up on the next dashboard poll
    res.status(200).json({ success: true, message: 'Webhook received', count: saved.length });

    // Enrich after responding — does not delay the webhook. Pass the payloads, not
    // the saved docs: see enrichInBackground.
    payloads.forEach(enrichInBackground);
  } catch (err) {
    console.error('Failed to store webhook:', err.message);
    res.status(500).json({ success: false, message: 'Failed to store webhook' });
  }
}

/**
 * Return all stored tasks (newest first) for the dashboard.
 */
async function getWebhookData(req, res) {
  try {
    const tasks = await Task.find().sort({ receivedAt: -1 }).lean();

    const data = tasks.map((t) => ({
      id: t.zohoId || String(t._id),
      receivedAt: t.receivedAt,
      body: t.body,
    }));

    res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (err) {
    console.error('Failed to fetch webhooks:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch webhooks' });
  }
}

module.exports = {
  receiveWebhook,
  getWebhookData,
};
