// GET /api/leads-list/funnel — MQL vs SQL by lead source and month.
//
// DEFINITIONS (agreed with the sales team, matching the Bigin MQL/SQL report)
// ---------------------------------------------------------------------------
//   MQL     a Bigin contact, counted in the IST month it was created.
//   SQL     an MQL with at least one call longer than SQL_MIN_CALL_SEC, logged
//           in Bigin against that contact, in the SAME IST month the contact
//           was created. A call in a later month does not count back; deals do
//           not count at all.
//   Late SQL  an MQL that is not SQL, but had a qualifying call in a LATER
//           month. Shown beside SQL so late follow-ups are visible without
//           changing the report's SQL %.
//   Won     an MQL whose contact has a deal closed with a sale, at any time.
//           Revenue is the sum of those won deals' amounts.
//   Lost    an MQL whose contact has a lost deal and no won deal. Its lost
//           reasons feed the top-reasons list on each row.
//   Junk    a Lost MQL with a JUNK_REASONS lost reason — a wrong number, not
//           a real enquiry, a course we don't offer, or a language we can't
//           serve. Shows lead quality per source; every other lost reason is
//           a real lead that did not convert.
//
// Deals count against the month the CONTACT was created, not the deal's
// closing month — so a source's quality reads straight across a row, and
// recent months keep growing as their deals close.
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
// own plus contacts nobody owns. The owner x month table is admin-only.

const Contact = require('../models/Contact');
const Call = require('../../calls/models/Call');
const Deal = require('../../calls/models/Deal');
const { SQL_MIN_CALL_SEC } = require('../../ads/services/leadState');

const MONTH_CHOICES = [3, 4, 6, 12];
const DEFAULT_MONTHS = 3;
const MAX_MONTHS = Math.max(...MONTH_CHOICES);
const IST_OFFSET_MS = 330 * 60000;
const NOT_SET = 'Not set';
const UNASSIGNED = 'Unassigned';
const NO_REASON = 'No reason';
const TOP_REASONS = 3;

// Bigin lost reasons that mark a lead as junk, lower-cased. Bigin's own
// spellings, typos included.
const JUNK_REASONS = new Set(
  ['WrongNumber / Not Enq', 'Wrong Course/Level', 'Language Issue'].map((r) => r.toLowerCase())
);

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
 * Every in-scope, in-window contact with what it became. selectFunnel counts
 * these; selectWonLeads lists the won ones behind one cell.
 *
 * @param {object} src  { contacts, calls, deals } — see loadFunnelSources
 * @param {object} query  req.query: months, owner, unassigned
 * @param {object} user  role + ownerEmail
 * @param {Date} now
 */
function classifyContacts({ contacts, calls, deals }, query, user, now) {
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

  // Won/lost deals by contact id and by phone key. A deal can match a contact
  // both ways, so matches are collected in a Set and counted once.
  const dealsById = new Map();
  const dealsByKey = new Map();
  const push = (map, key, d) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  };
  for (const d of deals) {
    if (d.contactId) push(dealsById, String(d.contactId), d);
    if (d.contactPhoneKey) push(dealsByKey, d.contactPhoneKey, d);
  }

  const owners = new Map();
  const facts = [];
  for (const c of contacts) {
    const owner = lower(c.ownerEmail);
    // Scope first — a rep's owner facet and counts never include a colleague.
    if (!isAdmin && owner && owner !== mine) continue;
    if (owner) owners.set(owner, c.ownerName || c.ownerEmail);
    if (ownerFilter && owner !== ownerFilter) continue;
    if (unassignedOnly && owner) continue;

    const month = istMonth(c.createdTime);
    if (!inWindow.has(month)) continue;

    const called = callMonths.get(String(c.zohoId));
    const sql = Boolean(called && called.has(month));
    const lateSql = !sql && Boolean(called && [...called].some((m) => m > month));

    const matched = new Set(dealsById.get(String(c.zohoId)) || []);
    for (const k of c.phoneKeys || []) for (const d of dealsByKey.get(k) || []) matched.add(d);
    const wonDeals = [...matched].filter((d) => d.outcome === 'won');
    const won = wonDeals.length > 0;
    const lost = !won && [...matched].some((d) => d.outcome === 'lost');
    const reasons = lost
      ? new Set([...matched].filter((d) => d.outcome === 'lost').map((d) => d.lostReason || NO_REASON))
      : new Set();
    facts.push({
      contact: c,
      month,
      owner,
      source: funnelSourceName(c.leadSource),
      sql,
      lateSql,
      won,
      wonDeals,
      revenue: wonDeals.reduce((sum, d) => sum + (Number(d.amount) || 0), 0),
      lost,
      junk: [...reasons].some((r) => JUNK_REASONS.has(lower(r))),
      reasons,
    });
  }
  return { isAdmin, months, owners, facts };
}

/** The funnel counts — see the definitions at the top. */
function selectFunnel(src, query, user, now = new Date()) {
  const { isAdmin, months, owners, facts } = classifyContacts(src, query, user, now);

  const empty = () => ({ mql: 0, sql: 0, lateSql: 0, won: 0, lost: 0, junk: 0, revenue: 0 });
  const newRow = () => ({
    byMonth: Object.fromEntries(months.map((m) => [m, empty()])),
    total: empty(),
    reasons: new Map(),
  });
  const bySource = new Map(); // name -> row
  const byOwner = new Map(); // owner email ('' = unassigned) -> row
  const byMonth = Object.fromEntries(months.map((m) => [m, empty()]));
  const total = empty();
  const totalReasons = new Map();

  for (const f of facts) {
    if (!bySource.has(f.source)) bySource.set(f.source, newRow());
    const rows = [bySource.get(f.source)];
    if (isAdmin) {
      if (!byOwner.has(f.owner)) byOwner.set(f.owner, newRow());
      rows.push(byOwner.get(f.owner));
    }

    const buckets = [byMonth[f.month], total];
    for (const r of rows) buckets.push(r.byMonth[f.month], r.total);
    for (const bucket of buckets) {
      bucket.mql += 1;
      if (f.sql) bucket.sql += 1;
      if (f.lateSql) bucket.lateSql += 1;
      if (f.won) bucket.won += 1;
      if (f.lost) bucket.lost += 1;
      if (f.junk) bucket.junk += 1;
      bucket.revenue += f.revenue;
    }
    for (const reason of f.reasons) {
      for (const map of [totalReasons, ...rows.map((r) => r.reasons)]) {
        map.set(reason, (map.get(reason) || 0) + 1);
      }
    }
  }

  const topReasons = (map) =>
    [...map.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, TOP_REASONS);
  const shape = ({ reasons, ...r }) => ({ ...r, topLostReasons: topReasons(reasons) });

  // Biggest source first; "Not set" always last, as in the report.
  const sources = [...bySource.entries()]
    .map(([source, r]) => ({ source, ...shape(r) }))
    .sort((a, b) => {
      if ((a.source === NOT_SET) !== (b.source === NOT_SET)) return a.source === NOT_SET ? 1 : -1;
      return b.total.mql - a.total.mql || a.source.localeCompare(b.source);
    });

  // Same layout per owner; "Unassigned" last.
  const ownerRows = [...byOwner.entries()]
    .map(([email, r]) => ({ email, owner: email ? owners.get(email) || email : UNASSIGNED, ...shape(r) }))
    .sort((a, b) => {
      if (!a.email !== !b.email) return a.email ? -1 : 1;
      return b.total.mql - a.total.mql || a.owner.localeCompare(b.owner);
    });

  return {
    asOf: now.toISOString(),
    months,
    monthChoices: MONTH_CHOICES,
    sources,
    owners: isAdmin ? ownerRows : [],
    byMonth,
    total,
    topLostReasons: topReasons(totalReasons),
    facets: {
      owners: isAdmin
        ? [...owners.entries()]
            .map(([email, name]) => ({ email, name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    },
  };
}

/**
 * The won leads behind one funnel cell. On top of the funnel's own filters,
 * `month` ('YYYY-MM', empty = whole window), `source` (a row name) and
 * `rowOwner` (an owner row's email, '__unassigned' for that row; admin only)
 * narrow it to the cell that was clicked.
 */
function selectWonLeads(src, query, user, now = new Date()) {
  const { isAdmin, facts } = classifyContacts(src, query, user, now);
  const month = query.month ? String(query.month) : '';
  const source = query.source ? String(query.source) : '';
  const rowOwner = isAdmin && query.rowOwner != null && query.rowOwner !== '' ? lower(query.rowOwner) : null;

  const leads = facts
    .filter((f) => f.won)
    .filter((f) => !month || f.month === month)
    .filter((f) => !source || f.source === source)
    .filter((f) => rowOwner == null || f.owner === (rowOwner === '__unassigned' ? '' : rowOwner))
    .map((f) => ({
      contactId: String(f.contact.zohoId),
      phoneKey: (f.contact.phoneKeys || [])[0] || null,
      name: f.contact.name || null,
      phone: f.contact.mobile || f.contact.phone || null,
      source: f.source,
      ownerName: f.contact.ownerName || null,
      createdTime: f.contact.createdTime,
      revenue: f.revenue,
      deals: f.wonDeals.map((d) => ({
        name: d.name || null,
        amount: Number(d.amount) || 0,
        closingDate: d.closingDate || null,
        ownerName: d.ownerName || null,
      })),
    }))
    .sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));

  return { leads, revenue: leads.reduce((sum, l) => sum + l.revenue, 0) };
}

// ---------------------------------------------------------------------------
// Reads + cache
// ---------------------------------------------------------------------------

async function loadFunnelSources(now = new Date()) {
  const since = monthStart(monthWindow(now, MAX_MONTHS)[0]);
  const [contacts, calls, deals] = await Promise.all([
    Contact.find(
      { createdTime: { $gte: since } },
      { zohoId: 1, name: 1, phone: 1, mobile: 1, phoneKeys: 1, leadSource: 1, ownerEmail: 1, ownerName: 1, createdTime: 1 }
    ).lean(),
    Call.find(
      { biginContactId: { $ne: null }, biginDurationSec: { $gt: SQL_MIN_CALL_SEC }, startedAt: { $gte: since } },
      { biginContactId: 1, biginDurationSec: 1, startedAt: 1 }
    ).lean(),
    Deal.find(
      { outcome: { $in: ['won', 'lost'] } },
      { name: 1, contactId: 1, contactPhoneKey: 1, outcome: 1, amount: 1, lostReason: 1, closingDate: 1, ownerName: 1 }
    ).lean(),
  ]);
  return { contacts, calls, deals };
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

async function buildWonLeads(query, user) {
  let src;
  try {
    src = await getCachedSources();
  } catch (err) {
    console.error('[lead-funnel] load failed:', err && err.message ? err.message : err);
    return { status: 503, body: { success: false, message: 'Could not load the won leads right now — please try again' } };
  }
  return { status: 200, body: { success: true, ...selectWonLeads(src, query || {}, user) } };
}

module.exports = {
  buildFunnel,
  buildWonLeads,
  invalidateFunnelCache,
  selectFunnel,
  selectWonLeads,
  funnelSourceName,
  istMonth,
};
