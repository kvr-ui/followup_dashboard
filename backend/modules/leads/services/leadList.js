// Every lead the dashboard knows about, one row per person.
//
// A "lead" is anyone with a follow-up Task, a web or Meta form fill, or a Deal —
// grouped on the shared join key, the last 10 digits of the phone. Calls alone do
// not make a lead (random inbound numbers would flood the list); they are read
// only to decide who OWNS a lead.
//
// Name, phone, owner and state come from leadProfile.buildHeader, the very
// function the lead page header uses, so a row and the profile it opens can never
// disagree about who someone is or where they stand.
//
// SCOPE
// -----
// Admins see every row. A rep sees the rows they own a Task, Deal or Call on,
// plus every row NOBODY owns yet (`unassigned`) — a fresh form fill is fair game
// for whoever picks it up. buildLeadProfile applies the same rule on click.
//
// The whole set is grouped in memory (a few thousand leads) and cached — see
// getCachedLeads. If the collections outgrow that, step 1 becomes a $unionWith
// aggregation.

const WebLead = require('../../ads/models/WebLead');
const MetaLead = require('../../ads/models/MetaLead');
const MetaCampaign = require('../../ads/models/MetaCampaign');
const Deal = require('../../calls/models/Deal');
const Call = require('../../calls/models/Call');
const { taskOwnerEmails } = require('../../../utils/owner');
const { getCachedTasks } = require('../../../controllers/taskController');
const {
  buildHeader,
  mergeForms,
  bodiesOf,
  toDate,
  lower,
  taskAt,
  dealAt,
} = require('./leadProfile');

const HAS_KEY = { $nin: [null, ''] };
const STATES = ['won', 'lost', 'pipeline', 'followup', 'none'];
const SORTS = ['lastActivity', 'created', 'nextFollowUp', 'name'];
const MAX_LIMIT = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SOURCE_LABELS = { web: 'Web form', meta: 'Meta form' };

function fail(status, message) {
  return { status, body: { success: false, message } };
}

function earliest(dates) {
  const ok = dates.map(toDate).filter(Boolean);
  return ok.length ? new Date(Math.min(...ok.map((d) => d.getTime()))) : null;
}

function latest(dates) {
  const ok = dates.map(toDate).filter(Boolean);
  return ok.length ? new Date(Math.max(...ok.map((d) => d.getTime()))) : null;
}

const newestFirst = (atOf) => (a, b) =>
  (toDate(atOf(b)) || 0) - (toDate(atOf(a)) || 0);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadSources() {
  const [tasks, webLeads, metaLeads, deals, calls, campaigns] = await Promise.all([
    // The follow-ups list's own warm cache (slim rows: body, receivedAt,
    // leadSource, phoneKey). A fresh Task read costs ~25s on Atlas M0.
    getCachedTasks().then((rows) => rows.filter((t) => t.phoneKey)),
    WebLead.find(
      { phoneKey: HAS_KEY },
      {
        phoneKey: 1,
        name: 1,
        firstName: 1,
        lastName: 1,
        phone: 1,
        source: 1,
        utmCampaign: 1,
        resolvedCampaignId: 1,
        createdAt: 1,
      }
    ).lean(),
    MetaLead.find(
      { phoneKey: HAS_KEY },
      { phoneKey: 1, fieldData: 1, campaignId: 1, formId: 1, createdTime: 1, syncedAt: 1 }
    ).lean(),
    Deal.find(
      { contactPhoneKey: HAS_KEY },
      {
        contactPhoneKey: 1,
        contactName: 1,
        contactPhone: 1,
        ownerName: 1,
        ownerEmail: 1,
        outcome: 1,
        stage: 1,
        leadSource: 1,
        leadSourceKey: 1,
        modifiedTime: 1,
        createdAt: 1,
        updatedAt: 1,
      }
    ).lean(),
    // Ownership only: an unowned call changes nothing.
    Call.find({ ownerEmail: HAS_KEY }, { phoneKeys: 1, ownerEmail: 1 }).lean(),
    MetaCampaign.find({}, { name: 1 }).lean(),
  ]);
  return { tasks, webLeads, metaLeads, deals, calls, campaigns };
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

/** The earliest open task's due date (YYYY-MM-DD as Bigin sends it), or null. */
function nextFollowUp(tasks) {
  const due = [];
  for (const task of tasks) {
    for (const b of bodiesOf(task)) {
      if (lower(b.Status) === 'completed' || !b.Due_Date) continue;
      due.push(String(b.Due_Date));
    }
  }
  return due.sort()[0] || null;
}

function campaignOf(form, campaignNames) {
  if (!form) return null;
  if (form.kind === 'web') {
    const { resolvedCampaignId, utmCampaign } = form.lead;
    return (resolvedCampaignId && campaignNames.get(resolvedCampaignId)) || utmCampaign || null;
  }
  const id = form.lead.campaignId;
  return id ? campaignNames.get(id) || id : null;
}

function buildRow(phoneKey, group, campaignNames) {
  const tasks = group.tasks.sort(newestFirst(taskAt));
  const deals = group.deals.sort(newestFirst(dealAt));
  const forms = mergeForms(group.webLeads, group.metaLeads);
  const header = buildHeader({ phoneKey, tasks, forms, deals, calls: [] });

  const owners = new Set(group.callOwners);
  tasks.forEach((t) => taskOwnerEmails(t).forEach((e) => owners.add(lower(e))));
  deals.forEach((d) => lower(d.ownerEmail) && owners.add(lower(d.ownerEmail)));

  // A cached Task row carries Bigin's own Created_Time / Modified_Time on each
  // task body, and receivedAt (the last webhook) on the document.
  const taskBodies = tasks.flatMap(bodiesOf);
  const createdAt = earliest([
    ...taskBodies.map((b) => b.Created_Time),
    ...tasks.map((t) => t.receivedAt),
    ...forms.map((f) => f.at),
    ...deals.map((d) => d.createdAt),
  ]);
  const lastActivity = latest([
    ...tasks.map((t) => t.receivedAt),
    ...taskBodies.map((b) => b.Modified_Time),
    ...forms.map((f) => f.at),
    ...deals.map(dealAt),
  ]);

  return {
    phoneKey,
    name: header.name,
    phone: header.phone,
    state: header.state,
    ownerName: header.ownerName,
    ownerEmail: header.ownerEmail,
    source: SOURCE_LABELS[header.leadSource] || header.leadSource || null,
    campaign: campaignOf(forms[0], campaignNames),
    nextFollowUp: nextFollowUp(tasks),
    createdAt,
    lastActivity,
    unassigned: owners.size === 0,
    counts: {
      tasks: tasks.length,
      forms: forms.length,
      deals: deals.length,
    },
    // Internal: scoping only, stripped before the response.
    _owners: owners,
  };
}

/** Every lead, grouped by phoneKey. Exported for the tests. */
function groupLeads({ tasks, webLeads, metaLeads, deals, calls, campaigns }) {
  const groups = new Map();
  const group = (key) => {
    if (!groups.has(key)) {
      groups.set(key, { tasks: [], webLeads: [], metaLeads: [], deals: [], callOwners: new Set() });
    }
    return groups.get(key);
  };

  tasks.forEach((t) => group(t.phoneKey).tasks.push(t));
  webLeads.forEach((w) => group(w.phoneKey).webLeads.push(w));
  metaLeads.forEach((m) => group(m.phoneKey).metaLeads.push(m));
  deals.forEach((d) => group(d.contactPhoneKey).deals.push(d));

  // After the lead-making sources: a call never creates a row, only claims one.
  for (const call of calls) {
    const owner = lower(call.ownerEmail);
    if (!owner) continue;
    for (const key of call.phoneKeys || []) {
      if (groups.has(key)) groups.get(key).callOwners.add(owner);
    }
  }

  const campaignNames = new Map(campaigns.map((c) => [String(c._id), c.name]));
  return [...groups.entries()].map(([key, g]) => buildRow(key, g, campaignNames));
}

// ---------------------------------------------------------------------------
// Scope, filter, sort, page
// ---------------------------------------------------------------------------

function inScope(row, user) {
  if (user && user.role === 'admin') return true;
  const mine = lower(user && user.ownerEmail);
  return row.unassigned || (Boolean(mine) && row._owners.has(mine));
}

/** A YYYY-MM-DD bound as an IST day edge — the team works in IST. */
function dayEdge(value, endOfDay) {
  if (!DATE_RE.test(value || '')) return null;
  const d = new Date(`${value}T00:00:00+05:30`);
  if (!Number.isFinite(d.getTime())) return null;
  return endOfDay ? new Date(d.getTime() + 86400000) : d;
}

function compare(sort) {
  const time = (d) => (d ? new Date(d).getTime() : null);
  // Nulls always sink, whichever way the column runs.
  const nullsLast = (a, b, cmp) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : cmp(a, b));
  switch (sort) {
    case 'created':
      return (a, b) => nullsLast(time(a.createdAt), time(b.createdAt), (x, y) => y - x);
    case 'nextFollowUp':
      return (a, b) => nullsLast(a.nextFollowUp, b.nextFollowUp, (x, y) => x.localeCompare(y));
    case 'name':
      return (a, b) => nullsLast(a.name, b.name, (x, y) => x.localeCompare(y));
    default:
      return (a, b) => nullsLast(time(a.lastActivity), time(b.lastActivity), (x, y) => y - x);
  }
}

/**
 * Pure: scoped + filtered + sorted + paged rows, plus the facets the filter bar
 * needs. Exported so the tests can drive it without a database.
 */
function selectRows(allRows, query, user) {
  const isAdmin = Boolean(user && user.role === 'admin');
  const q = String(query.q || '').trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  const status = STATES.includes(query.status) ? query.status : '';
  const source = String(query.source || '');
  const owner = isAdmin ? lower(query.owner) : '';
  const unassigned = query.unassigned === '1' || query.unassigned === 'true';
  const from = dayEdge(query.from, false);
  const to = dayEdge(query.to, true);
  const sort = SORTS.includes(query.sort) ? query.sort : 'lastActivity';
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), MAX_LIMIT);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);

  const scoped = allRows.filter((r) => inScope(r, user));

  // Facets come from the scoped set, before the filters, so a dropdown never
  // offers only the value that is already selected.
  const owners = new Map();
  const sources = new Set();
  const byState = Object.fromEntries(STATES.map((s) => [s, 0]));
  let unassignedCount = 0;
  for (const r of scoped) {
    if (r.ownerEmail) owners.set(lower(r.ownerEmail), r.ownerName || r.ownerEmail);
    if (r.source) sources.add(r.source);
    byState[r.state] = (byState[r.state] || 0) + 1;
    if (r.unassigned) unassignedCount += 1;
  }

  const filtered = scoped.filter((r) => {
    if (status && r.state !== status) return false;
    if (source && r.source !== source) return false;
    if (owner && !r._owners.has(owner)) return false;
    if (unassigned && !r.unassigned) return false;
    if (from || to) {
      const at = r.createdAt ? new Date(r.createdAt).getTime() : null;
      if (at == null) return false;
      if (from && at < from.getTime()) return false;
      if (to && at >= to.getTime()) return false;
    }
    if (q) {
      const nameHit = lower(r.name).includes(q);
      const phoneHit = qDigits.length >= 3 && String(r.phone || r.phoneKey).replace(/\D/g, '').includes(qDigits);
      if (!nameHit && !phoneHit) return false;
    }
    return true;
  });

  filtered.sort(compare(sort));
  const rows = filtered
    .slice((page - 1) * limit, page * limit)
    // eslint-disable-next-line no-unused-vars
    .map(({ _owners, ...row }) => row);

  return {
    rows,
    total: filtered.length,
    page,
    limit,
    facets: {
      total: scoped.length,
      byState,
      unassigned: unassignedCount,
      sources: [...sources].sort(),
      owners: isAdmin
        ? [...owners.entries()]
            .map(([email, name]) => ({ email, name }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    },
  };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------
// Deals and Calls still take seconds on Atlas M0, so the grouped rows are kept
// in memory and refreshed in the background (stale-while-revalidate), the same
// way the follow-ups list is. A rep's status change shows up within one TTL.

const LIST_CACHE_TTL_MS = Number(process.env.LEAD_LIST_CACHE_TTL_MS || 60000);
let listCache = null;
let listCacheAt = 0;
let listRefreshing = null;

function getCachedLeads() {
  if (listCache && Date.now() - listCacheAt < LIST_CACHE_TTL_MS) return listCache;
  if (!listRefreshing) {
    listRefreshing = loadSources()
      .then((sources) => {
        listCache = groupLeads(sources);
        listCacheAt = Date.now();
        return listCache;
      })
      .finally(() => {
        listRefreshing = null;
      });
  }
  return listCache || listRefreshing;
}

/** Warm at boot, after the task cache, so the first Leads tab isn't the slow one. */
async function warmLeadListCache() {
  const rows = await getCachedLeads();
  console.log(`Lead list cache warmed: ${rows.length} leads`);
}

/**
 * @param {object} query req.query
 * @param {object} user the authenticated user (role, ownerEmail)
 * @returns {Promise<{status: number, body: object}>}
 */
async function buildLeadList(query, user) {
  let rows;
  try {
    rows = await getCachedLeads();
  } catch (err) {
    console.error('[lead-list] load failed:', err && err.message ? err.message : err);
    return fail(503, 'Could not load leads right now — please try again');
  }
  return {
    status: 200,
    body: { success: true, ...selectRows(rows, query || {}, user) },
  };
}

module.exports = { buildLeadList, warmLeadListCache, groupLeads, selectRows };
