const mongoose = require('mongoose');

const statusChangeSchema = new mongoose.Schema(
  {
    status: String,
    changedAt: { type: Date, default: Date.now },
    source: { type: String, enum: ['webhook', 'dashboard'], default: 'webhook' },
    by: { type: String, default: null }, // username who made a dashboard change
  },
  { _id: false }
);

const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    author: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    syncedToZoho: { type: Boolean, default: false },
  },
  { _id: true }
);

const whatsappLogSchema = new mongoose.Schema(
  {
    template: String,
    number: String,
    sentBy: String,
    sentAt: { type: Date, default: Date.now },
    ok: Boolean,
    error: { type: String, default: null },
  },
  { _id: true }
);

// Summary of each individual task belonging to this contact (kept as history
// so no follow-up is lost when we dedupe by phone).
const relatedTaskSchema = new mongoose.Schema(
  {
    zohoId: String,
    subject: String,
    status: String,
    dueDate: String,
    createdTime: Date,
    ownerName: String,
  },
  { _id: false }
);

// One document per CONTACT (deduped by phone). `body` holds the contact's most
// recent task; `taskHistory` keeps a summary of all their tasks.
const taskSchema = new mongoose.Schema(
  {
    // Unique dedupe key: the phone number when known, else `task:<zohoId>`.
    dedupeKey: { type: String, unique: true, sparse: true, index: true },
    phone: { type: String, default: null, index: true },
    zohoId: { type: String, default: null, index: true }, // latest task's Bigin id
    body: { type: mongoose.Schema.Types.Mixed, required: true },
    receivedAt: { type: Date, default: Date.now },
    statusHistory: { type: [statusChangeSchema], default: [] },
    notes: { type: [noteSchema], default: [] },
    taskHistory: { type: [relatedTaskSchema], default: [] },
    whatsappLog: { type: [whatsappLogSchema], default: [] },
  },
  { timestamps: true }
);

// Dedupe/lookup by contact id (present in every webhook payload).
taskSchema.index({ 'body.Who_Id.id': 1 });

module.exports = mongoose.model('Task', taskSchema);
