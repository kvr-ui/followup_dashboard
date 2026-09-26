// GET /api/leads-list/funnel — MQL vs SQL by lead source and month.
//
// DEFINITIONS (agreed with the sales team, matching the Bigin MQL/SQL report)
// ---------------------------------------------------------------------------
//   MQL     a Bigin contact, counted in the IST month it was created.
//   SQL     an MQL with at least one call longer than SQL_MIN_CALL_SEC, logged
//           in Bigin against that contact, in the SAME IST month the contact
//           was created. A call in a later month does not count back; deals do
//           not count at all.
//   Closed  an MQL whose contact has a deal closed with a sale, at any time —
//           shown per month as an extra, not part of the report's SQL %.
//
// Contacts come from our Contact mirror (webhook + backfill). Calls are the
// Bigin calls in our Call collection (the scheduler's Bigin poll, plus
// modules/calls/scripts/backfillBiginCalls.js for history), joined on the
// Bigin contact id with Bigin's own duration. That is what the Bigin report
// counts; matching TeleCMI calls by phone instead overcounts (Aug 2026: 231 vs
// 193) and a TeleCMI twin measures a different leg of the call.
//
// Lead source is Contacts.Lead_Source1, with spellings merged only where they
// differ by case or a short form (funnelSourceName). This is deliberately NOT
// ads/services/leadSourceName.canonicalSource, which folds Instagram and
// Facebook into "Meta Ads" — the funnel reports them apart.
//
// Scope matches the Leads tab: admins see everything, a rep sees contacts they
// own plus contacts nobody owns.

const Contact = require('../models/Contact');
const Call = require('../../calls/models/Call');
const Deal = require('../../calls/models/Deal');
const { SQL_MIN_CALL_SEC } = require('../../ads/services/leadState');

const MONTH_CHOICES = [3, 4, 6, 12];
const DEFAULT_MONTHS = 3;
const MAX_MONTHS = Math.max(...MONTH_CHOICES);
const IST_OFFSET_MS = 330 * 60000;
const NOT_SET = 'Not set';

const lower = (v) => String(v || '').trim().toLowerCase();

// Short forms and spellings of one channel. Keys are lower-case.
const SOURCE_ALIASES = {
  ig: 'Instagram',
  instagram: 'Instagram',
  fb: 'Facebook',
  facebook: 'Facebook',
  whatsapp: 'WhatsApp',
  'whatsapp dms': 'WhatsApp DMs',
  'whatsapp dm': 'WhatsApp DMs',
  'ca guru': 'CA Guru',
  'mentor session': 'Mentor Session',
  'old kit student': 'Old Kit Student',
};

/** Contacts.Lead_Source1 -> the row it is reported under. */
function funnelSourceName(raw) {
  const text = String(raw == null ? '' : raw).replace(/_/g, ' ').trim().replace(/\s+/g, ' ');
  if (!text) return NOT_SET;
  return SOURCE_ALIASES[text.toLowerCase()] || text;
}

/** 'YYYY-MM' in IST, or null. */
function istMonth(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 7);
}

/** The last `count` IST months, oldest first, ending with the current one. */
function monthWindow(now, count) {
  const current = new Date(now.getTime() + IST_OFFSET_MS);
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** UTC instant of 00:00 IST on the first day of a 'YYYY-MM'. */
function monthStart(month) {
  return new Date(new Date(`${month}-01T00:00:00Z`).getTime() - IST_OFFSET_MS);
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/**
 * @param {object} src  { contacts, calls, wonDeals } — see loadFunnelSources
 * @param {object} query  req.query: months, owner, unassigned
 * @param {object} user  role + ownerEmail
 * @param {Date} now
 */
function selectFunnel({ contacts, calls, wonDeals }, query, user, now = new Date()) {
  const isAdmin = Boolean(user && user.role === 'admin');
  const count = MONTH_CHOICES.includes(Number(query.months)) ? Number(query.months) : DEFAULT_MONTHS;
  const months = monthWindow(now, count);
  const inWindow = new Set(months);
  const ownerFilter = isAdmin ? lower(query.owner) : '';
  const unassignedOnly = query.unassigned === '1' || query.unassigned === 'true';
  const mine = lower(user && user.ownerEmail);

  // Bigin contact id -> IST months it had a qualifying call in.
  const callMonths = new Map();
  for (const call of calls) {
    if (!(Number(call.biginDurationSec) > SQL_MIN_CALL_SEC)) continue;
    const m = istMonth(call.startedAt);
    const id = call.biginContactId && String(call.biginContactId);
    if (!m || !id) continue;
    if (!callMonths.has(id)) callMonths.set(id, new Set());
    callMonths.get(id).add(m);
  }

  const wonIds = new Set();
  const wonKeys = new Set();
  for (const d of wonDeals) {
    if (d.contactId) wonIds.add(String(d.contactId));
    if (d.contactPhoneKey) wonKeys.add(d.contactPhoneKey);
  }

  const owners = new Map();
  const empty = () => ({ mql: 0, sql: 0, closed: 0 });
  const bySource = new Map(); // name -> { byMonth: {m: counts}, total: counts }
  const byMonth = Object.fromEntries(months.map((m) => [m, empty()]));
  const total = empty();

  for (const c of contacts) {
    const owner = lower(c.ownerEmail);
    // Scope first — a rep's owner facet and counts never include a colleague.
    if (!isAdmin && owner && owner !== mine) continue;
    if (owner) owners.set(owner, c.ownerName || c.ownerEmail);
    if (ownerFilter && owner !== ownerFilter) continue;
    if (unassignedOnly && owner) continue;

    const month = istMonth(c.createdTime);
    if (!inWindow.has(month)) continue;

    const keys = c.phoneKeys || [];
    const sql = Boolean(callMonths.get(String(c.zohoId)) && callMonths.get(String(c.zohoId)).has(month));
    const closed = wonIds.has(String(c.zohoId)) || keys.some((k) => wonKeys.has(k));

    const name = funnelSourceName(c.leadSource);
    if (!bySource.has(name)) {
      bySource.set(name, { byMonth: Object.fromEntries(months.map((m) => [m, empty()])), total: empty() });
    }
    const row = bySource.get(name);
    for (const bucket of [row.byMonth[month], row.total, byMonth[month], total]) {
      bucket.mql += 1;
      if (sql) bucket.sql += 1;
      if (closed) bucket.closed += 1;
    }
  }

  // Biggest source first; "Not set" always last, as in the report.
  const sources = [...bySource.entries()]
    .map(([source, r]) => ({ source, ...r }))
    .sort((a, b) => {
      if ((a.source === NOT_SET) !== (b.source === NOT_SET)) return a.source === NOT_SET ? 1 : -1;
      return b.total.mql - a.total.mql || a.source.localeCompare(b.source);
    });

  return {
    asOf: now.toISOString(),
    months,
    monthChoices: MONTH_CHOICES,
    sources,
    byMonth,
    total,
    facets: {
      owners: isAdmin
        ? [...owners.entries()]
            .map(([email, name]) => ({ email, name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Reads + cache
// ---------------------------------------------------------------------------

async function loadFunnelSources(now = new Date()) {
  const since = monthStart(monthWindow(now, MAX_MONTHS)[0]);
  const [contacts, calls, wonDeals] = await Promise.all([
    Contact.find(
      { createdTime: { $gte: since } },
      { zohoId: 1, phoneKeys: 1, leadSource: 1, ownerEmail: 1, ownerName: 1, createdTime: 1 }
    ).lean(),
    Call.find(
      { biginContactId: { $ne: null }, biginDurationSec: { $gt: SQL_MIN_CALL_SEC }, startedAt: { $gte: since } },
      { biginContactId: 1, biginDurationSec: 1, startedAt: 1 }
    ).lean(),
    Deal.find({ outcome: 'won' }, { contactId: 1, contactPhoneKey: 1 }).lean(),
  ]);
  return { contacts, calls, wonDeals };
}

const CACHE_TTL_MS = Number(process.env.FUNNEL_CACHE_TTL_MS || 60000);
let cache = null;
let cacheAt = 0;
let refreshing = null;

function getCachedSources() {
  if (cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;
  if (!refreshing) {
    refreshing = loadFunnelSources()
      .then((src) => {
        cache = src;
        cacheAt = Date.now();
        return src;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return cache || refreshing;
}

/** Drop the cache so the next read reloads — the contact webhook calls this. */
function invalidateFunnelCache() {
  cacheAt = 0;
}

async function buildFunnel(query, user) {
  let src;
  try {
    src = await getCachedSources();
  } catch (err) {
    console.error('[lead-funnel] load failed:', err && err.message ? err.message : err);
    return { status: 503, body: { success: false, message: 'Could not load the funnel right now — please try again' } };
  }
  return { status: 200, body: { success: true, ...selectFunnel(src, query || {}, user) } };
}

module.exports = { buildFunnel, invalidateFunnelCache, selectFunnel, funnelSourceName, istMonth };
