// Ingest calls from Bigin's Calls module.
//
// WHY THIS EXISTS
// TeleCMI's REST API (/v2/answered, /v2/missed) returns ONLY inbound traffic to the DID.
// Verified against a live account: the console listed 22 outgoing calls for a day while
// /v2/answered returned 2, and every direction filter (call_type/direction/type) was
// silently ignored. Reps place outbound calls from Bigin via PhoneBridge, so those legs —
// the majority of a sales day — exist only here. Bigin also mirrors the inbound calls, so
// it is a superset; TeleCMI is kept as the source for inbound because its rows carry the
// cmiuid and a recording path we already download reliably.
//
// Every connected call in Bigin carries a Voice_Recording__s URL, so once ingested these
// calls flow through the existing transcribe -> grade pipeline unchanged (nothing in it
// filters on direction).

const Call = require('../models/Call');
const zoho = require('../../../services/zoho');
const { key10 } = require('../../../utils/phone');
const { agentMap, buildLeadIndex, phoneKeysOf } = require('./callStore');

// Inbound calls exist in BOTH systems. TeleCMI and Bigin timestamp the same call a second
// or two apart and disagree on duration (they measure different legs — 40s vs 29s on one
// observed call), so we match on phone + a time window rather than anything exact.
const DEDUPE_WINDOW_MS = 3 * 60 * 1000;

/**
 * Pull the customer's number out of a Bigin call record.
 * Dialled_Number is unreliable: null on outbound, and the office DID on inbound. The
 * Subject line carries the real number for both ("Outgoing call to Lachu (+919344578528)",
 * "Incoming call from P.GUGAN (918098830120)"), so parse that first.
 */
function phoneOf(row) {
  const m = String(row.Subject || '').match(/\((\+?\d[\d\s-]{7,})\)/);
  if (m) return m[1].replace(/[\s-]/g, '');
  // Inbound records do put the caller in Dialled_Number occasionally; use it only when
  // it is not the DID we dial out from.
  const dn = String(row.Dialled_Number || '').replace(/\D/g, '');
  const caller = String(row.Caller_ID || '').replace(/\D/g, '');
  if (dn && dn !== caller) return dn;
  return null;
}

const directionOf = (row) => {
  const t = String(row.Call_Type || '').toLowerCase();
  if (t.startsWith('out')) return 'outbound';
  if (t.startsWith('in')) return 'inbound';
  return 'unknown';
};

/** Map a Bigin Calls record onto our Call shape. */
function toCallDoc(row, leadIndex, extByEmail) {
  const phone = phoneOf(row);
  const lead = phone ? leadIndex.get(key10(phone)) : null;
  const ownerEmail = (row.Owner && row.Owner.email) || null;
  const recordingUrl = row.Voice_Recording__s || null;
  const duration = Number(row.Call_Duration_in_seconds) || 0;

  return {
    cmiuid: `bigin:${row.id}`,
    source: 'bigin',
    biginCallId: String(row.id),
    direction: directionOf(row),
    from: directionOf(row) === 'inbound' ? phone : row.Caller_ID || null,
    to: directionOf(row) === 'inbound' ? row.Caller_ID || null : phone,
    agentExt: (ownerEmail && extByEmail[ownerEmail]) || null,
    ownerEmail,
    leadId: lead ? lead._id : null,
    leadPhone: phone,
    // Prefer our own lead name; fall back to whatever Bigin calls the contact.
    leadName: (lead && lead.name) || (row.Who_Id && row.Who_Id.name) || null,
    duration,
    billedSec: duration,
    startedAt: row.Call_Start_Time ? new Date(row.Call_Start_Time) : null,
    recordingUrl,
    // A Bigin call is transcribable exactly when Zoho kept audio for it. Unanswered
    // dials have a record but no recording, matching TeleCMI's duration-0 rows.
    hasRecording: Boolean(recordingUrl) && duration > 0,
    phoneKeys: phoneKeysOf({ leadPhone: phone, to: phone, from: phone }),
  };
}

/**
 * Find the TeleCMI row for the same physical call, if we already have it.
 * Returns the existing Call doc, or null.
 */
async function findTelecmiTwin(doc) {
  if (!doc.startedAt || !doc.leadPhone) return null;
  const k = key10(doc.leadPhone);
  if (!k) return null;

  return Call.findOne({
    source: 'telecmi',
    phoneKeys: k,
    startedAt: {
      $gte: new Date(doc.startedAt.getTime() - DEDUPE_WINDOW_MS),
      $lte: new Date(doc.startedAt.getTime() + DEDUPE_WINDOW_MS),
    },
  });
}

/**
 * The mirror of findTelecmiTwin, used by the OUTGOING TeleCMI poll.
 *
 * Bigin and TeleCMI both know about every outbound call, so whichever poll runs second
 * must find the other's row. Without this the same call exists twice — once with a
 * recording and once without — and the rep's call count doubles.
 */
async function findBiginTwin({ startedAt, leadPhone }) {
  if (!startedAt || !leadPhone) return null;
  const k = key10(leadPhone);
  if (!k) return null;

  return Call.findOne({
    source: 'bigin',
    phoneKeys: k,
    startedAt: {
      $gte: new Date(new Date(startedAt).getTime() - DEDUPE_WINDOW_MS),
      $lte: new Date(new Date(startedAt).getTime() + DEDUPE_WINDOW_MS),
    },
  });
}

/**
 * Insert or update one Bigin call.
 * Returns { action: 'created' | 'updated' | 'linked' }.
 *   linked  -> it was the same call TeleCMI already gave us; we enriched that row
 *              instead of creating a duplicate.
 */
async function upsertBiginCall(row, leadIndex, extByEmail, { minDurationSec = 0 } = {}) {
  const doc = toCallDoc(row, leadIndex, extByEmail);

  const existing = await Call.findOne({ cmiuid: doc.cmiuid });
  if (existing) {
    // Refresh metadata; never touch transcript/grade progress.
    const { cmiuid, ...rest } = doc;
    Object.assign(existing, rest);
    await existing.save();
    return { call: existing, action: 'updated' };
  }

  // Same call, already ingested from TeleCMI? Link rather than duplicate. The TeleCMI row
  // stays authoritative (it owns the cmiuid and a proven recording path); we only add what
  // Bigin knows better — the rep who owns it and the contact's name.
  const twin = await findTelecmiTwin(doc);
  if (twin) {
    twin.biginCallId = doc.biginCallId;
    if (!twin.ownerEmail && doc.ownerEmail) twin.ownerEmail = doc.ownerEmail;
    if (!twin.leadName && doc.leadName) twin.leadName = doc.leadName;
    if (!twin.recordingUrl && doc.recordingUrl) twin.recordingUrl = doc.recordingUrl;
    await twin.save();
    return { call: twin, action: 'linked' };
  }

  // A Bigin row is NEVER queued for transcription on its own, even when Zoho has audio
  // for it. TeleCMI's per-agent out_cdr feed carries the same calls WITH a `filename`,
  // and that path downloads with the app credentials we already have — whereas the Zoho
  // recording URL needs a PhoneBridge OAuth scope. Queueing here would mean every
  // outbound call failing on that scope and, because the transcribe job is shared,
  // stalling inbound calls too. So Bigin gets the call LISTED immediately and the
  // outgoing poll flips it to `pending` the moment it attaches a filename.
  const call = await Call.create({
    ...doc,
    transcriptionStatus: 'skipped',
    transcriptionError: doc.hasRecording ? 'Awaiting TeleCMI recording' : 'No recording',
  });
  return { call, action: 'created' };
}

/**
 * Fetch Bigin calls that started on or after `since`.
 * Sorted newest-first and stops at the first page that predates the window.
 */
async function fetchCallsSince(since) {
  const out = [];
  const cutoff = new Date(since).getTime();

  for (let page = 1; page <= 20; page++) {
    const r = await zoho.apiGet(
      `/Calls?per_page=200&page=${page}&sort_by=Call_Start_Time&sort_order=desc`
    );
    if (!r.ok) throw new Error(r.error || 'Failed to fetch Bigin calls');

    const rows = (r.json && r.json.data) || [];
    if (!rows.length) break;

    let reachedOlder = false;
    for (const row of rows) {
      const t = new Date(row.Call_Start_Time || row.Created_Time).getTime();
      if (!t || t < cutoff) {
        reachedOlder = true;
        continue; // keep scanning this page — ordering can wobble across records
      }
      out.push(row);
    }
    if (reachedOlder || rows.length < 200) break;
  }
  return out;
}

/** Reverse of agentMap(): salesperson email -> TeleCMI extension. */
function extensionsByEmail() {
  const byExt = agentMap();
  const out = {};
  for (const [ext, email] of Object.entries(byExt)) if (email) out[email] = ext;
  return out;
}

/**
 * Ingest every Bigin call since `since`. Returns a tally.
 */
async function syncSince(since, { minDurationSec = 0 } = {}) {
  if (!zoho.isConfigured()) return { skipped: true, created: 0, linked: 0, updated: 0 };

  const rows = await fetchCallsSince(since);
  const leadIndex = await buildLeadIndex();
  const extByEmail = extensionsByEmail();

  const tally = { created: 0, linked: 0, updated: 0, queued: 0, total: rows.length };
  for (const row of rows) {
    const { call, action } = await upsertBiginCall(row, leadIndex, extByEmail, { minDurationSec });
    tally[action] += 1;
    if (action === 'created' && call.transcriptionStatus === 'pending') tally.queued += 1;
  }
  return tally;
}

module.exports = {
  syncSince,
  fetchCallsSince,
  upsertBiginCall,
  findBiginTwin,
  toCallDoc,
  phoneOf,
  extensionsByEmail,
};
