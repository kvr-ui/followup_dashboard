const Task = require('../models/Task');
const { upsertTask } = require('../services/taskStore');

/**
 * Handle an incoming webhook POST request.
 * The body may be a single task object or an array of task objects
 * (see the NDJSON recovery in app.js). Records are deduped by phone number.
 */
async function receiveWebhook(req, res) {
  try {
    const payloads = Array.isArray(req.body) ? req.body : [req.body];
    // Sequential to avoid two payloads racing on the same dedupe key.
    const saved = [];
    for (const p of payloads) saved.push(await upsertTask(p));

    console.log(`Webhook received: ${saved.length} task(s) stored`);

    res.status(200).json({
      success: true,
      message: 'Webhook received',
      count: saved.length,
    });
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
