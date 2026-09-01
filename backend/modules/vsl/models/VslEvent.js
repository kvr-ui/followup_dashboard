// The VSL player's append-only event log. Owned by focasvsl; READ-ONLY here.
//
// !! NEVER ADD THIS MODEL TO server.js's syncIndexes() CHAIN !!
// See the same warning in VslLead.js — syncIndexes() drops indexes it does not
// know about, and we are a guest in this database.
//
// WHAT YOU CANNOT TRUST IN HERE
// -----------------------------
// focasvsl's event route coerces watchedSeconds, currentTime and videoDuration
// before inserting, but `watchPercentage` reaches the collection straight from
// the browser payload's object spread — so it may be a string, null, or missing
// entirely. Every aggregation over this collection MUST use
// $convert(onError, onNull) rather than $toDouble, which aborts the whole
// pipeline on a single bad row. See services/watchIndex.js.

const mongoose = require('mongoose');
const { getConnection } = require('../services/connection');

const schema = new mongoose.Schema(
  {
    leadId: String,
    videoId: String,
    // 'play_started' | 'pause' | 'progress' | 'seek' | 'milestone' | 'completed' | 'page_exit'
    eventType: String,
    watchedSeconds: Number,
    watchPercentage: Number, // NOT server-sanitised upstream — see the header
    currentTime: Number,
    videoDuration: Number,
    receivedAt: Date,
  },
  {
    strict: false,
    collection: 'vsl_events',
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
  }
);

let model = null;

module.exports = function VslEvent() {
  if (model) return model;
  const conn = getConnection();
  if (!conn) return null;
  model = conn.model('VslEvent', schema);
  return model;
};
