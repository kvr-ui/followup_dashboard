// What the agent is allowed to read, and what the data actually MEANS.
//
// This file is the single source of truth for two things that must never drift
// apart:
//
//   1. the collection allowlist + per-collection owner scoping that
//      mongoQuery.js enforces, and
//   2. the schema description injected into the model's system prompt.
//
// Keeping them in one table is the point. If they lived separately, someone
// would eventually document a collection the guard doesn't allow (the model
// writes a query that is always rejected) or — far worse — allow one nobody
// documented the scoping rule for.
//
// `users` is deliberately absent and must stay absent: it holds bcrypt password
// hashes, and no question a sales dashboard can ask is worth putting those one
// aggregation away from a model's output.

const Task = require('../../../models/Task');
const Call = require('../../calls/models/Call');
const Deal = require('../../calls/models/Deal');
const ApiUsage = require('../../calls/models/ApiUsage');
const WebLead = require('../../ads/models/WebLead');
const MetaLead = require('../../ads/models/MetaLead');
const MetaInsight = require('../../ads/models/MetaInsight');
const MetaCampaign = require('../../ads/models/MetaCampaign');
const MetaAd = require('../../ads/models/MetaAd');
const MetaAdset = require('../../ads/models/MetaAdset');

// Per-collection rules.
//
//   model        the mongoose model to aggregate through
//   adminOnly    ad spend, lead PII and provider billing — management data, and
//                already admin-gated at /api/ads and /api/calls/usage. A rep
//                reaching it through the agent would be a way around that gate.
//   ownerField   the field a sales rep is pinned to. `null` on an adminOnly
//                collection is not "unscoped" — the rep never gets there at all.
//   ownerCI      the stored value's case is not guaranteed (Bigin sends whatever
//                the rep's profile holds), so the pin has to be case-insensitive.
const COLLECTIONS = {
  tasks: {
    model: Task,
    adminOnly: false,
    // Tasks keep the raw Bigin payload in `body`, which is sometimes ONE task
    // object and sometimes an ARRAY of them (one document per contact, deduped
    // by phone). Dot notation matches both shapes, which is why the pin is
    // written against the nested path rather than a lifted field.
    ownerField: 'body.Owner.email',
    ownerCI: true,
    // …and because dot notation keeps the WHOLE document when any one entry in
    // that array matches, the array itself has to be filtered afterwards too.
    // See ownerStages() in mongoQuery.js.
    bodyArrayOwnerFilter: true,
    summary:
      'One document per CONTACT (deduped by phone), holding their follow-up tasks from Bigin.',
    fields: {
      phone: 'string — as Bigin sent it, e.g. "+91 98765 43210". Not joinable; use phoneKey.',
      phoneKey: 'string — last 10 digits of phone. THE join key to calls/deals/leads.',
      zohoId: 'string — Bigin id of the contact\'s most recent task.',
      taskCategory:
        'string — Bigin Task_Category picklist: "Follow Up", "Call Back", "Final Follow Up", "See Response", …',
      taskCategorySource:
        '"bigin" | "subject" | null — "subject" means the category was INFERRED from the task subject, not stated by Bigin. Say so if you report on it.',
      leadSource: '"meta" | "web" | null — which capture channel this contact came from.',
      linkedLeadId: 'the matching webleads._id or metaleads._id. Resolve which by leadSource.',
      'body.Subject': 'string — the task subject line.',
      'body.Status': 'string — "Not Started", "In Progress", "Completed", …',
      'body.Due_Date': 'string YYYY-MM-DD.',
      'body.Owner.email': 'string — the sales rep who owns the follow-up.',
      'body.Owner.name': 'string — that rep\'s display name.',
      'body.Who_Id.id': 'string — the Bigin CONTACT id.',
      statusHistory: 'array of {status, changedAt, source, by} — every status change.',
      notes: 'array of {text, author, createdAt}.',
      taskHistory:
        'array of {zohoId, subject, status, dueDate, createdTime, ownerName, category} — ALL of this contact\'s tasks, not just the latest.',
      whatsappLog: 'array of {template, number, sentBy, sentAt, ok, error} — WATI sends.',
      createdAt: 'Date.',
      updatedAt: 'Date.',
    },
  },

  calls: {
    model: Call,
    adminOnly: false,
    ownerField: 'ownerEmail',
    ownerCI: true,
    summary:
      'Every phone call, from TeleCMI (inbound) and Bigin (outbound), with its transcript and AI grade.',
    fields: {
      cmiuid: 'string — unique call id. Bigin-sourced rows look like "bigin:<record id>".',
      source: '"telecmi" | "bigin". Neither feed is complete alone; both are ingested.',
      direction: '"inbound" | "outbound" | "unknown".',
      from: 'string — caller number.',
      to: 'string — dialled number.',
      phoneKeys: 'array of 10-digit strings — every leg of the call. Join key to deals/tasks.',
      ownerEmail: 'string — the rep who handled it.',
      agentExt: 'string — their extension, e.g. "5001".',
      leadId: 'ObjectId → tasks._id, matched by phone.',
      leadName: 'string.',
      duration: 'number — SECONDS.',
      startedAt: 'Date.',
      hasRecording: 'boolean.',
      outcome:
        '"won" | "lost" | "open" | null — the outcome of the DEAL this call belongs to, copied here.',
      isClosedWon: 'boolean — shorthand for outcome === "won".',
      'deal.id': 'string — the Bigin deal id. Join key to deals.zohoId.',
      'deal.amount': 'number — that deal\'s value.',
      'deal.lostReason': 'string | null.',
      transcriptionStatus:
        '"pending" | "processing" | "done" | "failed" | "skipped". Only "done" calls have a transcript, and only transcribed calls can be graded — quote this when a count looks low.',
      'transcript.text': 'string — the full transcript.',
      'transcript.language': 'string — auto-detected, e.g. "ta", "en".',
      'grade.score': 'number 0–100, or null if ungraded.',
      'grade.summary': 'string — the AI\'s one-paragraph verdict.',
      'grade.strengths': 'array of strings.',
      'grade.improvements': 'array of strings.',
      'grade.breakdown': 'object — per-rubric-section scores.',
      'grade.gradedAt': 'Date.',
    },
  },

  deals: {
    model: Deal,
    adminOnly: false,
    ownerField: 'ownerEmail',
    ownerCI: true,
    summary: 'Every Bigin deal — won, lost or still open — with what was sold and what is owed.',
    fields: {
      zohoId: 'string — the Bigin deal id.',
      name: 'string.',
      stage: 'string — the raw Bigin stage.',
      outcome: '"won" | "lost" | "open" — normalised from stage. Prefer this over stage.',
      closingDate: 'string YYYY-MM-DD. A calendar date, compared as a STRING — "2026-07" prefixes work.',
      amount: 'number — deal value in rupees.',
      lostReason:
        'string | null — Bigin\'s Reasons picklist ("Consistent NR", "Financial Aid", "Class Timing Issue", …). Only meaningful when outcome === "lost". Free text, and the picklist grows.',
      upScale: 'string | null — the course the lead was UPSOLD to. Non-null means an upsell happened.',
      installment:
        'number | null — the balance still OWED on a won deal. NOT the amount paid (paid = amount - installment). null means "never set", 0 means "paid off" — these are DIFFERENT and must not be collapsed.',
      ownerEmail: 'string — the rep who owns the deal.',
      ownerName: 'string.',
      contactId: 'string — Bigin contact id.',
      contactName: 'string.',
      contactPhoneKey: 'string — last 10 digits. Join key to calls.phoneKeys / tasks.phoneKey.',
      leadSource:
        'string | null — EXACTLY what a rep typed ("ig", "Whatsapp Dms"). The audit trail; do not group on it.',
      leadSourceKey: 'string | null — the canonical form. GROUP ON THIS.',
      socialLeadId:
        'string | null — Meta\'s own lead id. The exact join from a SALE back to the ad that paid for it: matches metaleads._id.',
      products:
        'array of {id, name, quantity, listPrice, discount, total}. `total` is the line revenue after discount. In practice ONLY won deals carry products (lost deals are ~4% populated) — never compute a win rate from this.',
      modifiedTime: 'Date.',
    },
  },

  webleads: {
    model: WebLead,
    adminOnly: true,
    ownerField: null,
    summary: 'Leads captured by the Focas landing-page forms, with their UTM attribution.',
    fields: {
      name: 'string.',
      email: 'string.',
      phone: 'string.',
      phoneKey: 'string — last 10 digits. Join key.',
      city: 'string.',
      state: 'string.',
      caStatus: 'string — where the lead is in their CA journey.',
      attempt: 'string.',
      language: 'string.',
      utmSource: 'string.',
      utmMedium: 'string.',
      utmCampaign: 'string — raw, as it appeared in the URL.',
      utmContent: 'string.',
      landingUrl: 'string.',
      referrer: 'string.',
      source: 'string — which form, e.g. "counseling-form".',
      biginContactId: 'string — the contact created in Bigin for this lead.',
      resolvedCampaignId: 'string | null — metacampaigns._id this lead was attributed to.',
      resolvedBy:
        '"exact" | "normalized" | "id" | "alias" | "unmapped" | null — HOW it was attributed. "unmapped" means nobody has mapped that utm_campaign yet, so its spend is unattributed.',
      linkedTaskId: 'ObjectId → tasks._id.',
      createdAt: 'Date.',
    },
  },

  metaleads: {
    model: MetaLead,
    adminOnly: true,
    ownerField: null,
    summary: 'Leads submitted through Meta instant forms, mirrored from the Marketing API.',
    fields: {
      _id: 'string — Meta\'s own lead id. Matches deals.socialLeadId.',
      createdTime: 'string — ISO timestamp.',
      adId: 'string → metaads._id.',
      formId: 'string.',
      campaignId: 'string → metacampaigns._id.',
      phoneKey: 'string — last 10 digits, extracted from fieldData.',
      fieldData: 'array of {name, values} — the raw answers. Field names vary per form.',
    },
  },

  metainsights: {
    model: MetaInsight,
    adminOnly: true,
    ownerField: null,
    summary:
      'Meta ad performance. ONE ROW PER ENTITY PER DATE RANGE — always $match a level before summing, or you double-count account rows against campaign rows.',
    fields: {
      level: '"account" | "campaign" | "adset" | "ad". ALWAYS filter on this.',
      entityId: 'string — the id of the thing this row measures, at that level.',
      dateStart: 'string YYYY-MM-DD.',
      dateStop: 'string YYYY-MM-DD.',
      campaignId: 'string.',
      adsetId: 'string.',
      adId: 'string.',
      spend: 'number — rupees for THIS row\'s date range only. Sum across rows for a period.',
      impressions: 'number.',
      reach: 'number.',
      clicks: 'number.',
      ctr: 'number — percent, per row. Do NOT average these; recompute clicks/impressions.',
      cpc: 'number — per row. Same warning.',
      cpm: 'number — per row. Same warning.',
      actions:
        'array of {action_type, value}. Lead count is the entry with action_type === "lead" — Meta\'s deduplicated form+pixel figure.',
    },
  },

  metacampaigns: {
    model: MetaCampaign,
    adminOnly: true,
    ownerField: null,
    summary: 'Meta campaigns.',
    fields: {
      _id: 'string — Meta campaign id.',
      name: 'string.',
      objective: 'string.',
      status: 'string.',
      effectiveStatus: 'string — the status Meta actually applies, including parent pauses.',
      dailyBudget: 'number — in PAISE, not rupees.',
      lifetimeBudget: 'number — in PAISE.',
      createdTime: 'string.',
    },
  },

  metaadsets: {
    model: MetaAdset,
    adminOnly: true,
    ownerField: null,
    summary: 'Meta ad sets.',
    fields: {
      _id: 'string — Meta adset id.',
      name: 'string.',
      campaignId: 'string → metacampaigns._id.',
      status: 'string.',
      effectiveStatus: 'string.',
      dailyBudget: 'number — PAISE.',
      optimizationGoal: 'string.',
      startTime: 'string.',
      endTime: 'string.',
    },
  },

  metaads: {
    model: MetaAd,
    adminOnly: true,
    ownerField: null,
    summary: 'Individual Meta ads.',
    fields: {
      _id: 'string — Meta ad id.',
      name: 'string.',
      adsetId: 'string → metaadsets._id.',
      campaignId: 'string → metacampaigns._id.',
      status: 'string.',
      effectiveStatus: 'string.',
      creativeId: 'string.',
    },
  },

  apiusages: {
    model: ApiUsage,
    adminOnly: true,
    ownerField: null,
    summary: 'Daily AI provider spend ledger — one row per provider per day.',
    fields: {
      provider: '"sarvam" (grading) | "elevenlabs" (transcription) | "openai" (this agent).',
      day: 'string YYYY-MM-DD, local time.',
      requests: 'number.',
      failures: 'number.',
      promptTokens: 'number — Sarvam and OpenAI.',
      completionTokens: 'number — Sarvam and OpenAI.',
      totalTokens: 'number — Sarvam and OpenAI.',
      audioSeconds: 'number — ElevenLabs only.',
      lastAt: 'Date.',
    },
  },
};

/** Collections this user may aggregate over. */
function allowedCollections(scope) {
  return Object.keys(COLLECTIONS).filter((name) => scope.isAdmin || !COLLECTIONS[name].adminOnly);
}

/**
 * The schema reference injected into the system prompt.
 *
 * Only the collections this user can actually reach are described. Documenting
 * ad spend to a rep who will be refused it just teaches the model to write
 * queries that bounce, and burns the round trip finding out.
 */
function describeSchema(scope) {
  const lines = [];

  for (const name of allowedCollections(scope)) {
    const c = COLLECTIONS[name];
    lines.push(`### ${name}`);
    lines.push(c.summary);
    if (!scope.isAdmin && c.ownerField) {
      lines.push(
        `SCOPED: you are answering for one sales rep, so every query on this collection is ` +
          `automatically filtered to \`${c.ownerField}\` = their address. You cannot see other reps' rows.`
      );
    }
    for (const [field, desc] of Object.entries(c.fields)) {
      lines.push(`- \`${field}\` ${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { COLLECTIONS, allowedCollections, describeSchema };
