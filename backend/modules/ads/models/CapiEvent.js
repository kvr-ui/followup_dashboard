const mongoose = require('mongoose');

// The Conversions API ledger — one row per (mode, contact, funnel event) we have
// sent to Meta, or decided never to send. The sweep (services/capiSync) reads it
// to skip what is already done, so each stage reaches Meta once.
//
// _id is `<mode>:<zohoId>:<event>`. The mode ('live' | 'test') is part of the key
// because beta and prod share this database: beta's test-code sends must never
// mark an event done for prod. The event_id Meta sees is `<zohoId>:<event>`,
// without the mode, so Meta dedupes anything we resend.
const capiEventSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    mode: { type: String, enum: ['live', 'test'], required: true },
    contactId: { type: String, required: true },
    // Duplicate Bigin contacts share a phone; one person must convert once.
    phoneKey: { type: String, default: null },
    event: { type: String, enum: ['Lead', 'MQL', 'SQL', 'Purchase'], required: true },
    eventTime: { type: Date, required: true },
    value: { type: Number, default: null },

    // 'skipped_too_old' = the stage happened outside Meta's 7-day window.
    status: { type: String, enum: ['sent', 'failed', 'skipped_too_old'], required: true },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    sentAt: { type: Date, default: null },
    fbtraceId: { type: String, default: null },
  },
  { timestamps: true, _id: false }
);

capiEventSchema.index({ mode: 1, event: 1, phoneKey: 1, status: 1 });
capiEventSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('CapiEvent', capiEventSchema, 'capi_events');
