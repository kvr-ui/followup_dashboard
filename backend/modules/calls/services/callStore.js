const Task = require('../../../models/Task');
const Call = require('../models/Call');

// Map a TeleCMI agent extension to a salesperson's owner email.
// Configure in .env, e.g.  TELECMI_AGENTS=5001=veera@x.com,5003=nithish@x.com
function agentMap() {
  const raw = process.env.TELECMI_AGENTS || '';
  const map = {};
  raw.split(',').forEach((pair) => {
    const [ext, email] = pair.split('=').map((s) => (s || '').trim());
    if (ext && email) map[ext] = email.toLowerCase();
  });
  return map;
}

// Normalise any phone to its last 10 digits — robust across +91 / 91 / bare formats.
function key10(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d || null;
}

// A *strict* match key for cross-linking a call to a deal: the last 10 digits,
// but ONLY when the number has 10+ digits. Unlike key10, a shorter fragment is
// rejected (returns null) — so a 6-digit landline (or a malformed number) can't
// loosely match an unrelated number that merely ends the same way. This is the
// cross-link guard the old regex-suffix match lacked.
function phoneKey(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

// The distinct strict keys for a call — any of its phone legs may identify the lead.
function phoneKeysOf({ leadPhone, to, from } = {}) {
  return [...new Set([phoneKey(leadPhone), phoneKey(to), phoneKey(from)].filter(Boolean))];
}

/**
 * Build an in-memory index of every lead phone -> lead, so matching 700 calls
 * doesn't mean 700 database queries.
 *
 * Cached: a webhook must not pay the cost of loading 1,400 leads on every call.
 * New leads appear within CACHE_TTL_MS at worst, which is fine — the reconcile
 * poll re-matches anything that arrived early.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedIndex = null;
let cachedAt = 0;
let rebuilding = null;

async function rebuildIndex() {
  const leads = await Task.find({}, { phone: 1, 'body.Who_Id': 1 }).lean();
  const index = new Map();
  for (const l of leads) {
    const phones = [l.phone, l.body && l.body.Who_Id && l.body.Who_Id.phone];
    const name = (l.body && l.body.Who_Id && l.body.Who_Id.name) || null;
    for (const p of phones) {
      const k = key10(p);
      if (k && !index.has(k)) index.set(k, { _id: l._id, name, phone: p });
    }
  }
  cachedIndex = index;
  cachedAt = Date.now();
  return index;
}

/**
 * Return the lead index.
 *
 * A webhook must never pay to load 1,400 leads, so if the cache is stale we
 * hand back the stale copy immediately and refresh in the background. Only the
 * very first caller (empty cache) ever waits — and startup warms it, so in
 * practice nobody does.
 */
async function buildLeadIndex({ fresh = false } = {}) {
  if (fresh) return rebuildIndex();

  if (cachedIndex) {
    if (Date.now() - cachedAt > CACHE_TTL_MS && !rebuilding) {
      rebuilding = rebuildIndex().finally(() => {
        rebuilding = null;
      });
    }
    return cachedIndex; // stale-while-revalidate
  }

  if (!rebuilding) {
    rebuilding = rebuildIndex().finally(() => {
      rebuilding = null;
    });
  }
  return rebuilding;
}

/** Warm the cache at boot so the first webhook is fast. */
async function warmLeadIndex() {
  const idx = await buildLeadIndex({ fresh: true });
  console.log(`Lead phone index warmed: ${idx.size} numbers`);
  return idx;
}

/**
 * Turn a raw TeleCMI CDR row into our Call shape, matching it to a lead.
 * Direction is inferred: if `to` is the lead, the agent called out (outbound).
 */
function toCallDoc(row, leadIndex, agents) {
  const from = String(row.from || '');
  const to = String(row.to || '');

  const toLead = leadIndex.get(key10(to));
  const fromLead = leadIndex.get(key10(from));

  let lead = null;
  let direction = 'unknown';
  let leadPhone = null;

  if (toLead) {
    lead = toLead;
    direction = 'outbound';
    leadPhone = to;
  } else if (fromLead) {
    lead = fromLead;
    direction = 'inbound';
    leadPhone = from;
  }

  // If neither leg matched a lead, fall back to whatever TeleCMI told us.
  if (direction === 'unknown' && row._direction) {
    const d = String(row._direction).toLowerCase();
    if (d.startsWith('in')) direction = 'inbound';
    else if (d.startsWith('out')) direction = 'outbound';
  }

  const agentExt = String(row.agent || '').split('_')[0] || null;
  const hasRecording = String(row.record) === 'true' && Boolean(row.filename);

  return {
    cmiuid: String(row.cmiuid),
    from,
    to,
    direction,
    agent: row.agent || null,
    agentExt,
    ownerEmail: agentExt ? agents[agentExt] || null : null,
    leadId: lead ? lead._id : null,
    leadPhone,
    leadName: lead ? lead.name : null,
    duration: Number(row.duration) || 0,
    billedSec: Number(row.billedsec) || 0,
    startedAt: row.time ? new Date(Number(row.time)) : null,
    filename: row.filename || null,
    hasRecording,
    // Precomputed match keys so deals can find this call by indexed equality.
    phoneKeys: phoneKeysOf({ leadPhone, to, from }),
  };
}

/**
 * Insert or update a call (idempotent on cmiuid).
 * Never resets transcription progress on an existing call.
 */
async function upsertCall(row, leadIndex, agents, { minDurationSec = 0 } = {}) {
  const doc = toCallDoc(row, leadIndex, agents);

  const existing = await Call.findOne({ cmiuid: doc.cmiuid });
  if (existing) {
    // Refresh metadata/lead match, but leave transcript + status alone.
    Object.assign(existing, doc);
    await existing.save();
    return { call: existing, created: false };
  }

  // Decide whether this call is even worth transcribing.
  const status = !doc.hasRecording || doc.duration < minDurationSec ? 'skipped' : 'pending';

  const call = await Call.create({ ...doc, transcriptionStatus: status });
  return { call, created: true };
}

module.exports = {
  agentMap,
  buildLeadIndex,
  warmLeadIndex,
  upsertCall,
  toCallDoc,
  key10,
  phoneKey,
  phoneKeysOf,
};
