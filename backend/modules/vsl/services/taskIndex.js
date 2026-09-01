// phoneKey -> the dashboard's own follow-ups, cached.
//
// The VSL tab has to answer two questions per row that only THIS cluster knows:
// "is there a follow-up for this person" and "is it the logged-in rep's". Both
// join on the last 10 digits of the phone, so we hold a small index of exactly
// the fields the tab renders rather than querying Task per row.
//
// WHY AN IN-MEMORY INDEX AND NOT A MONGO QUERY PER REQUEST
// -------------------------------------------------------
// The rep filter is `Owner.email === req.user.ownerEmail`, CASE-INSENSITIVELY,
// on a field that (a) lives inside the Mixed `body`, (b) has no index, and (c)
// may sit inside an ARRAY. Mongo can traverse the array by dot notation but it
// cannot lowercase without a collation, and it is an unindexed scan either way.
// Filtering the cached index in JS with the shared ownerEmailOf() is both
// cheaper and — the part that actually matters — SEMANTICALLY IDENTICAL to
// canAccess(), so the tab and the drawer can never disagree about whose lead it
// is.
//
// Same cache shape as controllers/taskController.js and journeyCache:
// TTL + stale-while-revalidate + one in-flight rebuild shared by all callers.

const Task = require('../../../models/Task');
const { taskOwnerEmails } = require('../../../utils/owner');

const TTL_MS = Number(process.env.VSL_TASK_INDEX_TTL_MS || 60000);

// Only what the VSL tab renders or filters on. The list view's own slim
// projection is the precedent: Atlas M0 charges ~20ms a document, so every field
// we do not draw is latency we do not spend.
const FIELDS = {
  _id: 1,
  dedupeKey: 1,
  zohoId: 1,
  phoneKey: 1,
  leadSource: 1,
  receivedAt: 1,
  'body.Who_Id': 1,
  'body.Owner': 1,
  'body.Status': 1,
};

let cache = null; // Map<phoneKey, row[]>
let cachedAt = 0;
let refreshing = null;

function rowOf(doc) {
  const body = Array.isArray(doc.body) ? doc.body[0] : doc.body;
  return {
    // The id TaskDetail opens on — the same one serializeList hands the table.
    taskId: doc.dedupeKey || doc.zohoId || String(doc._id),
    contactName: (body && body.Who_Id && body.Who_Id.name) || null,
    ownerName: (body && body.Owner && body.Owner.name) || null,
    ownerEmails: taskOwnerEmails(doc),
    status: (body && body.Status) || null,
    leadSource: doc.leadSource || null,
    receivedAt: doc.receivedAt || null,
  };
}

async function load() {
  const docs = await Task.find({ phoneKey: { $ne: null } }, FIELDS).lean();
  const map = new Map();
  for (const doc of docs) {
    if (!doc.phoneKey) continue;
    const list = map.get(doc.phoneKey);
    // An array, not a single row: two Bigin contacts can genuinely share a phone
    // tail. A rep matches if ANY of them is theirs.
    if (list) list.push(rowOf(doc));
    else map.set(doc.phoneKey, [rowOf(doc)]);
  }
  return map;
}

async function getTaskIndex() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;

  if (!refreshing) {
    refreshing = load()
      .then((map) => {
        cache = map;
        cachedAt = Date.now();
        return map;
      })
      .finally(() => {
        refreshing = null;
      });
  }

  // Hand back the stale copy instantly if we have one, rather than making every
  // concurrent tab open wait on the same query.
  return cache || refreshing;
}

/** The newest follow-up for a phone key, or null. */
function newestOf(rows) {
  if (!rows || rows.length === 0) return null;
  return rows.reduce((best, row) =>
    !best || new Date(row.receivedAt || 0) > new Date(best.receivedAt || 0) ? row : best
  );
}

module.exports = { getTaskIndex, newestOf };
