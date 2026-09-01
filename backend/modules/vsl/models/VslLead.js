// One document per lead on the VSL landing page, keyed by normalised phone.
// Owned by the focasvsl project; READ-ONLY here.
//
// !! NEVER ADD THIS MODEL TO server.js's syncIndexes() CHAIN !!
// syncIndexes() DROPS indexes that are not in the schema. Against this
// collection that would delete `phone_unique` — the unique index focasvsl's
// lib/vslSend.ts relies on as its send-idempotency mutex. Deleting it would let
// the VSL WhatsApp a lead the same link twice. Hence autoIndex/autoCreate are
// off below and this file is not exported anywhere near that list.
//
// Exported as a GETTER, not a model: a top-level conn.model(...) would force the
// connection at require() time and throw when VSL_MONGO_URI is unset, which is
// exactly the degradation this module promises not to break. Callers do:
//     const VslLead = require('../models/VslLead')();
//     if (!VslLead) return null;

const mongoose = require('mongoose');
const { getConnection } = require('../services/connection');

const schema = new mongoose.Schema(
  {
    leadId: String, // uuid, the join key to vsl_events
    phone: String, // normalised digits, usually country-code prefixed
    name: String,
    createdAt: Date,
    videoId: String,
    source: String, // 'vsl_page' | 'vsl_link_send'

    firstOpenedAt: Date,
    lastOpenedAt: Date,
    openCount: Number,
    firstPlayAt: Date,
    lastActivityAt: Date,
    lastEventType: String,

    // The LAST value the player reported, not the peak: focasvsl $sets these on
    // every event, so they fall when a lead reopens the video. Read them only as
    // a last resort, and label it — see services/watchIndex.js.
    watchedSeconds: Number,
    watchPercentage: Number,

    linkSentAt: Date,
    linkSendStatus: String,
    reminderState: String,
    reminderSentAt: Date,
  },
  {
    // focasvsl owns this collection and adds fields whenever it likes
    // (linkSendAttempts, reminderDueAt, vslNoteId, ...). Declaring them all here
    // would be a promise we cannot keep; strict:false means a new field upstream
    // is invisible rather than fatal.
    strict: false,
    collection: 'vsl_leads',
    versionKey: false,
    autoIndex: false, // we do not own the indexes on this cluster
    autoCreate: false, // never create the collection from here
  }
);

let model = null;

module.exports = function VslLead() {
  if (model) return model;
  const conn = getConnection();
  if (!conn) return null;
  model = conn.model('VslLead', schema);
  return model;
};
