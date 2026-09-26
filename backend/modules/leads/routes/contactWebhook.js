// POST /webhook/contact — Bigin posts here when a contact is created or edited.
//
// Set up in Bigin as a workflow rule on Contacts, "Create or Edit", with a
// webhook action to this URL. The body only needs the contact id (`id` or
// `contact_id`); the handler re-reads the full record from Bigin.
//
// Public, like /webhook/deal: Bigin can't send our JWT. It answers at once and
// does the Bigin read + upsert in the background.

const express = require('express');
const { normalizeContactPayload, syncContactFromWebhook } = require('../services/contactStore');
const { invalidateLeadListCache } = require('../services/leadList');
const { invalidateFunnelCache } = require('../services/funnel');

const router = express.Router();

router.post('/contact', (req, res) => {
  const payloads = Array.isArray(req.body) ? req.body : [req.body];
  const contacts = payloads.map(normalizeContactPayload).filter(Boolean);

  if (!contacts.length) {
    // Still a 200 — we don't want Bigin retrying while the field names get fixed.
    console.warn(
      'Contact webhook: no contact id. Fields seen:',
      Object.keys(req.body || {}).join(', ')
    );
    return res.status(200).json({
      success: false,
      message: 'Payload received but no contact id found — send `id` or `contact_id`',
      fieldsSeen: Object.keys(req.body || {}),
    });
  }

  res.status(200).json({ success: true, count: contacts.length });

  (async () => {
    for (const c of contacts) {
      try {
        const doc = await syncContactFromWebhook(c);
        console.log(`Contact webhook: ${doc.zohoId} ${doc.name || ''} (${doc.leadSource || 'no source'})`);
      } catch (err) {
        console.warn(`Contact webhook: ${c.id} failed:`, err.message);
      }
    }
    // New MQL: show it on the Leads page and in the Funnel on the next load,
    // not after the 60s cache runs out.
    invalidateLeadListCache();
    invalidateFunnelCache();
  })();
});

module.exports = router;
