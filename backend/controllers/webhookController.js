const Task = require('../models/Task');
const { upsertTask } = require('../services/taskStore');
const { enrichBody } = require('../services/enrich');

// Fetch phone/subject from Zoho for a stored record, in the background.
// Throttled + retried inside the Zoho service, so it never blocks the webhook
// and never floods Zoho. Errors are swallowed — the task is already saved.
async function enrichInBackground(doc) {
  try {
    if (!doc || !doc._id) return;
    const fresh = await Task.findById(doc._id);
    if (!fresh) return;
    const changed = await enrichBody(fresh.body);
    if (changed) {
      const phone = fresh.body && fresh.body.Who_Id && fresh.body.Who_Id.phone;
      if (phone) fresh.phone = String(phone);
      fresh.markModified('body');
      await fresh.save();
    }
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
    res.status(200).json({ success: true, message: 'Webhook received', count: saved.length });

    // Enrich after responding — does not delay the webhook.
    saved.filter(Boolean).forEach(enrichInBackground);
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
