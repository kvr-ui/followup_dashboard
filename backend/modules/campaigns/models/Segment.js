const mongoose = require('mongoose');

/**
 * A saved, re-runnable audience definition.
 *
 * The rule is stored as data, not as a Mongo query, and compiled by
 * services/segments.js at use time. Two reasons: a stored Mongo query is a
 * remote-code-execution hole ($where, $function), and a declarative rule can be
 * rendered back into the UI for editing — a raw query cannot.
 *
 * Shape:
 *   {
 *     match: 'all' | 'any',
 *     conditions: [
 *       { field: 'tags',        op: 'in',      value: ['inter-g1'] },
 *       { field: 'engagement',  op: 'is',      value: 'read_no_click', campaignId: '...' },
 *       { field: 'lastCampaignAt', op: 'before', value: '2026-06-01' },
 *       { field: 'attributes.city', op: 'eq',   value: 'Chennai' },
 *     ]
 *   }
 *
 * Opted-out, invalid and suppressed contacts are excluded by the compiler itself
 * and are NOT expressible as a condition — you cannot build an audience that
 * messages someone who asked you to stop, however you write the rule.
 */
const segmentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    description: { type: String, default: '' },
    rule: { type: mongoose.Schema.Types.Mixed, required: true },

    // Cached so the list view doesn't run every segment's query on each page load.
    lastCount: { type: Number, default: null },
    lastCountedAt: { type: Date, default: null },

    // Segments created by "retarget this funnel state" rather than hand-built.
    system: { type: Boolean, default: false },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Segment', segmentSchema);
