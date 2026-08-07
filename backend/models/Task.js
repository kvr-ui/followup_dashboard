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
    // Bigin's custom `Task_Category` picklist (Follow Up, Call Back, Final Follow
    // Up, See Response, ...). Not in the webhook payload — fetched from the API.
    category: { type: String, default: null },
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

    // The last 10 digits of `phone`. `phone` is whatever Bigin sent us — "+91 98765
    // 43210", "09876543210", "9876543210" — so it can't be joined on. This is the
    // fallback key that matches a contact to an ad lead when no click id links them.
    phoneKey: { type: String, default: null, index: true, sparse: true },

    zohoId: { type: String, default: null, index: true }, // latest task's Bigin id

    // The latest task's Task_Category. Lifted out of `body` into a real indexed
    // field so the dashboard can filter and group by it — you can't do that on a
    // Mixed blob without a full collection scan.
    taskCategory: { type: String, default: null, index: true },

    // Where that category came from. Bigin's Task_Category picklist is brand new
    // (2 of 2,000 tasks had it), but for years reps typed the category into the
    // task SUBJECT — "Follow Up", "Call Back", "Followup-NR". Those are inferred,
    // and a guess must never be mistaken for what Bigin actually says.
    taskCategorySource: {
      type: String,
      enum: ['bigin', 'subject', null],
      default: null,
    },

    // Where this contact came from. Denormalised onto the Task so the follow-ups
    // table can render a Source column without one lookup per row. Safe to copy
    // because a lead's ORIGIN never changes — unlike its cost, which is re-derived
    // from ad spend every day and so must never be cached here.
    leadSource: { type: String, enum: ['meta', 'web', null], default: null },

    // The WebLead or MetaLead this contact was matched to. Deliberately un-`ref`ed:
    // it points into one of two collections, so which model to populate from is
    // decided by `leadSource`, not by the schema.
    //
    // Typed Mixed, not ObjectId, because the two collections do not agree on an id
    // type: a WebLead is created here and gets a generated ObjectId, while a
    // MetaLead's `_id` is Meta's own numeric string id (kept verbatim so the Atlas
    // migration is a straight copy). Narrowing this to ObjectId would silently
    // exclude every Meta lead from ever being linked — which is exactly what it
    // did before. Readers must therefore compare with String() rather than
    // `.equals()`, and resolve the collection from `leadSource`.
    linkedLeadId: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
      index: true,
      sparse: true,
    },

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
