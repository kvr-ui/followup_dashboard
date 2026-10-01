const mongoose = require('mongoose');

// A mirror of Bigin's Contacts module — one document per Bigin contact.
//
// This is the MQL list: a contact created in Bigin is a lead that marketing
// produced, whatever tab it later turns up in. It is written by the contact
// webhook (Bigin workflow on Create / Edit, POST /webhook/contact) and seeded
// once by modules/leads/scripts/backfillContacts.js for the contacts that
// existed before the webhook did.
//
// Only what the Funnel tab needs is kept. The raw lead source is stored as
// typed; the spelling merge happens at read time (funnelSourceName) so that
// fixing a merge rule never needs a re-sync.
const contactSchema = new mongoose.Schema(
  {
    zohoId: { type: String, required: true, unique: true, index: true },

    name: { type: String, default: null },
    phone: { type: String, default: null },
    mobile: { type: String, default: null },
    // Strict last-10-digit keys of phone + mobile — the join key to calls.
    phoneKeys: { type: [String], default: [], index: true },

    // Contacts.Lead_Source1, verbatim (free text in Bigin).
    leadSource: { type: String, default: null },

    ownerName: { type: String, default: null },
    ownerEmail: { type: String, default: null, index: true },

    // Bigin's own timestamps — createdTime decides the MQL month.
    createdTime: { type: Date, default: null, index: true },
    modifiedTime: { type: Date, default: null },

    // 'webhook' | 'backfill' — which path last wrote this row.
    syncedBy: { type: String, default: null },
  },
  { timestamps: true }
);

// Its own collection, NOT `contacts`: another app on this database (the
// WhatsApp CRM) owns that one, with a unique phoneKey index of its own.
module.exports = mongoose.model('BiginContact', contactSchema, 'bigin_contacts');
