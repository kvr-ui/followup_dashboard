const mongoose = require('mongoose');

const transcriptSchema = new mongoose.Schema(
  {
    text: String,
    language: String,
    provider: { type: String, default: 'elevenlabs' },
    model: String,
    // Optional word/segment level detail (with speaker labels when available)
    segments: { type: mongoose.Schema.Types.Mixed, default: null },
    durationSec: Number,
    transcribedAt: Date,
  },
  { _id: false }
);

const gradeSchema = new mongoose.Schema(
  {
    score: Number, // overall, e.g. 0-100
    breakdown: { type: mongoose.Schema.Types.Mixed, default: null },
    summary: String,
    strengths: [String],
    improvements: [String],
    gradedBy: { type: String, enum: ['ai', 'admin'], default: 'ai' },
    gradedAt: Date,
  },
  { _id: false }
);

// The Bigin deal this call belongs to (set for any CLOSED deal — won or lost).
const dealSchema = new mongoose.Schema(
  {
    id: String,
    name: String,
    stage: String,
    closingDate: String,
    amount: Number,
    ownerName: String,
    ownerEmail: String,
    contactId: String,
    contactName: String,
    // Why it was lost (null for won deals, and for lost ones left blank in Bigin).
    lostReason: { type: String, default: null },
  },
  { _id: false }
);

const callSchema = new mongoose.Schema(
  {
    // TeleCMI's unique call id — the dedupe key. Never process the same call twice.
    cmiuid: { type: String, required: true, unique: true, index: true },

    // Set when this call belongs to a lead whose deal was Closed with Sale.
    isClosedWon: { type: Boolean, default: false, index: true },
    // 'won' | 'lost' | 'open' | null — lets us compare winning vs losing calls.
    outcome: { type: String, enum: ['won', 'lost', 'open', null], default: null, index: true },
    deal: { type: dealSchema, default: null },

    from: String,
    to: String,
    direction: { type: String, enum: ['inbound', 'outbound', 'unknown'], default: 'unknown' },

    agent: String, // raw, e.g. "5001_33337563"
    agentExt: { type: String, index: true }, // e.g. "5001"
    ownerEmail: { type: String, default: null, index: true }, // mapped salesperson

    // Matched lead (a Task record) — matched on phone number.
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', default: null, index: true },
    leadPhone: { type: String, default: null, index: true },
    leadName: { type: String, default: null },

    duration: { type: Number, default: 0 }, // seconds
    billedSec: { type: Number, default: 0 },
    startedAt: { type: Date, index: true },

    filename: { type: String, default: null },
    hasRecording: { type: Boolean, default: false },

    transcriptionStatus: {
      type: String,
      enum: ['pending', 'processing', 'done', 'failed', 'skipped'],
      default: 'pending',
      index: true,
    },
    transcriptionError: { type: String, default: null },
    transcriptionAttempts: { type: Number, default: 0 },
    transcript: { type: transcriptSchema, default: null },

    grade: { type: gradeSchema, default: null },
  },
  { timestamps: true }
);

// The journeys view joins every closed deal to its calls on this field. Without
// the index that join scans the whole calls collection once per deal — it took
// ~20s. Indexed, it is a lookup.
callSchema.index({ 'deal.id': 1 });

module.exports = mongoose.model('Call', callSchema);
