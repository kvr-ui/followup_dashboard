// Match an ad lead (web form or Meta instant form) to the dashboard Task that
// represents the same person, and write the link on both sides.
//
// Two halves of one lead live in two systems. The ad side knows a lead's UTMs,
// campaign and qualification answers; the Task side knows every follow-up, call
// and deal that came after. The join key is a Bigin contact id when we have one,
// and the last 10 digits of the phone otherwise.
//
// TWO DIRECTIONS, ONE ANSWER
// --------------------------
// The link is needed both ways: the backfill walks leads, and a Bigin webhook
// arrives as a Task. Rather than implement two matchers that can disagree, both
// entry points funnel into `bestLeadForTask()` — the single rule for "which lead
// is this Task's lead". That makes the result independent of the order records
// are processed in, which is what the backfill needs to be re-runnable.
//
// CONSERVATIVE BY DESIGN
// ----------------------
// A wrong link is worse than no link: it puts another person's campaign, spend
// and answers on a rep's screen. So every ambiguity resolves towards NOT linking:
// a Bigin id match always beats a phone match, a phone that matches two different
// Bigin contacts (a shared family number) links to neither, and a lead already
// linked to some other Task is never stolen.

const mongoose = require('mongoose');
const Task = require('../../../models/Task');
const WebLead = require('../models/WebLead');
const MetaLead = require('../models/MetaLead');
const { phoneKey } = require('../../../utils/phone'); // the one normaliser — do not add another

// ---------------------------------------------------------------------------
// Meta lead form field extraction
// ---------------------------------------------------------------------------

// A Meta instant-form answer set arrives as an untyped list — [{ name, values }]
// — and the field NAME is chosen per form by whoever built it. Across the Focas
// forms alone the phone has shipped as `phone_number`, `mobile_number` and
// `contact_number`, so a single hard-coded key would quietly drop whole forms.
//
// Tried in this order, most specific first. `number` sits last on purpose: it is
// the one entry here that could plausibly name something that is not a phone.
const PHONE_FIELD_NAMES = [
  'phonenumber',
  'phone',
  'mobilenumber',
  'mobile',
  'mobileno',
  'phoneno',
  'contactnumber',
  'contactno',
  'whatsappnumber',
  'whatsapp',
  'telephone',
  'tel',
  'cellphone',
  'cell',
  'alternatephonenumber',
  'alternatemobilenumber',
  'yourphonenumber',
  'yourmobilenumber',
  'number',
];

// Second pass: forms whose field is a full question ("what is your mobile
// number?") or a localised label never match the list above, so fall back to a
// substring test. Kept narrow — anything matching these words in a lead form is
// a phone.
const PHONE_NAME_HINTS = ['phonenumber', 'mobilenumber', 'contactnumber', 'whatsapp', 'phone', 'mobile', 'telephone'];

/** Field names are compared with the same shape-insensitive rule as campaign names. */
function normalizeFieldName(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function entryName(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return normalizeFieldName(entry.name != null ? entry.name : entry.key != null ? entry.key : entry.field);
}

/** Meta sends `values: []`; migrated/hand-made rows sometimes carry a bare `value`. */
function entryValues(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.values)) return entry.values;
  if (entry.values != null) return [entry.values];
  if (Array.isArray(entry.value)) return entry.value;
  if (entry.value != null) return [entry.value];
  return [];
}

/** First value in the list that normalises to a usable 10-digit key. */
function firstUsableKey(values) {
  for (const value of values) {
    const key = phoneKey(value);
    if (key) return key;
  }
  return null;
}

/**
 * Pull the phone out of a Meta lead's `fieldData` and return it as the shared
 * 10-digit match key (not the raw string) — that is the only form anything joins
 * on. Returns null when the form carried no usable number.
 *
 * @param {Array<{name?: string, values?: any}>} fieldData
 * @returns {string|null}
 */
function phoneFromFieldData(fieldData) {
  if (!Array.isArray(fieldData)) return null;

  // Pass 1 — exact field names, in priority order. Priority is over the NAME not
  // the array position, so a form listing `alternate_phone` before `phone_number`
  // still yields the primary number.
  for (const wanted of PHONE_FIELD_NAMES) {
    for (const entry of fieldData) {
      if (entryName(entry) !== wanted) continue;
      // Keep looking if this entry was present but blank — a form with an empty
      // `phone` and a filled `mobile_number` must not resolve to null.
      const key = firstUsableKey(entryValues(entry));
      if (key) return key;
    }
  }

  // Pass 2 — substring fallback for question-style or unfamiliar labels.
  for (const entry of fieldData) {
    const name = entryName(entry);
    if (!name || !PHONE_NAME_HINTS.some((hint) => name.includes(hint))) continue;
    const key = firstUsableKey(entryValues(entry));
    if (key) return key;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Lead / Task field readers
// ---------------------------------------------------------------------------

/** Works for hydrated documents and for `.lean()` plain objects alike. */
function leadKind(lead) {
  const modelName = lead && lead.constructor && lead.constructor.modelName;
  if (modelName === 'MetaLead') return 'meta';
  if (modelName === 'WebLead') return 'web';
  return Array.isArray(lead && lead.fieldData) ? 'meta' : 'web';
}

function leadPhoneKey(lead, kind) {
  if (lead && lead.phoneKey) return lead.phoneKey;
  if (kind === 'meta') return phoneFromFieldData(lead && lead.fieldData);
  return phoneKey(lead && lead.phone);
}

/**
 * When the lead was captured — the tie-break when one Task has several candidate
 * leads. Meta stores `createdTime` as an ISO string; a web lead has a real Date.
 */
function leadCapturedMs(lead, kind) {
  const raw = kind === 'meta' ? lead.createdTime || lead.syncedAt : lead.createdAt;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** The Bigin contact id lives in the raw webhook body; `dedupeKey` mirrors it. */
function taskContactId(task) {
  const id = task && task.body && task.body.Who_Id && task.body.Who_Id.id;
  return id == null || id === '' ? null : String(id);
}

/**
 * Task 3 derives `phoneKey` from the `phone` column OR, for records that were
 * never enriched, from `body.Who_Id.phone`. Plenty of older Tasks predate the
 * field entirely and have neither backfilled yet, so read all three locations
 * here — a matcher that trusted the column alone would silently skip them.
 */
function taskPhoneKey(task) {
  if (!task) return null;
  if (task.phoneKey) return task.phoneKey;
  return phoneKey(task.phone) || phoneKey(task.body && task.body.Who_Id && task.body.Who_Id.phone);
}

// ---------------------------------------------------------------------------
// The Meta-lead storage gap
// ---------------------------------------------------------------------------
//
// `MetaLead._id` is Meta's own numeric string id (task 1, deliberate — it makes
// the Atlas migration a straight copy) while `Task.linkedLeadId` is typed
// ObjectId (task 3). A 16-digit Meta id does not cast to an ObjectId, and
// MetaLead has no `linkedTaskId` of its own, so as the two schemas stand today a
// Meta lead link CANNOT be persisted on either side.
//
// Both those files are outside this task's boundary, so rather than write half a
// link — a Task with `leadSource: 'meta'` and a null `linkedLeadId`, which the
// lead-detail API would render as "from Meta" with no campaign, no cost and no
// answers — such leads are excluded from matching entirely and reported once.
// The matching code below is otherwise type-agnostic: widening
// `Task.linkedLeadId` to Mixed is all that is needed to switch them on.
function isStorableLeadId(id) {
  if (id instanceof mongoose.Types.ObjectId) return true;
  if (typeof id !== 'string') return false;
  // `isValid` also accepts any 12-character string, so round-trip it.
  return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === id;
}

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[leadLinker] ${message}`);
}

// ---------------------------------------------------------------------------
// The single matching rule
// ---------------------------------------------------------------------------

/**
 * Every lead that could belong to this Task, already reduced to the winning
 * rule: a Bigin id match if one exists at all, otherwise phone matches.
 *
 * Only unlinked leads (or leads already pointing at THIS Task, so a re-run is a
 * no-op) are candidates — a lead belonging to another Task is never taken.
 */
async function candidatesForTask(task) {
  const free = { $or: [{ linkedTaskId: null }, { linkedTaskId: task._id }] };

  const contactId = taskContactId(task);
  if (contactId) {
    // Only web leads carry a Bigin contact id; the CRM's ingest created the
    // contact, so this is an identity, not an inference.
    const byId = await WebLead.find({ biginContactId: contactId, ...free }).lean();
    if (byId.length) {
      return { matchedBy: 'biginContactId', candidates: byId.map((lead) => ({ lead, kind: 'web' })) };
    }
  }

  const key = taskPhoneKey(task);
  if (!key) return null;

  // Same shared-number guard the lead direction applies, stated from this side:
  // if any OTHER contact holds this number there is nothing to choose between
  // them, so this Task gets no lead. Written as "some other task" rather than a
  // count so it holds even for Tasks whose own `phoneKey` column is not
  // backfilled yet and whose key was derived from the raw body.
  const rival = await Task.findOne({ phoneKey: key, _id: { $ne: task._id } }, { _id: 1 }).lean();
  if (rival) {
    console.warn(`[leadLinker] phone ${key} matches multiple contacts — not linking`);
    return null;
  }

  const [webLeads, metaLeads] = await Promise.all([
    // A web lead carrying a DIFFERENT Bigin contact id belongs to that contact,
    // whatever the phone says — a shared handset, not the same person.
    WebLead.find({
      phoneKey: key,
      ...free,
      ...(contactId ? { $and: [{ $or: [{ biginContactId: null }, { biginContactId: contactId }] }] } : {}),
    }).lean(),
    MetaLead.find({ phoneKey: key, ...free }).lean(),
  ]);

  const candidates = [
    ...webLeads.map((lead) => ({ lead, kind: 'web' })),
    ...metaLeads
      .filter((lead) => {
        if (isStorableLeadId(lead._id)) return true;
        warnOnce(
          'meta-id',
          'Meta leads cannot be linked: MetaLead._id is a Meta string id and ' +
            'Task.linkedLeadId is typed ObjectId. Widen Task.linkedLeadId to Mixed to enable them.'
        );
        return false;
      })
      .map((lead) => ({ lead, kind: 'meta' })),
  ];

  if (!candidates.length) return null;
  return { matchedBy: 'phoneKey', candidates };
}

/**
 * Of several equally-matching leads, take the most recently captured one and
 * leave the rest alone — they stay unlinked and visible in the Ad Leads view
 * rather than being merged into one record that claims to be all of them.
 */
function pickCandidate(candidates) {
  return [...candidates].sort((a, b) => {
    const delta = leadCapturedMs(b.lead, b.kind) - leadCapturedMs(a.lead, a.kind);
    if (delta) return delta;
    const ai = String(a.lead._id);
    const bi = String(b.lead._id);
    return ai < bi ? 1 : ai > bi ? -1 : 0; // deterministic when timestamps tie
  })[0];
}

/** Write the link on both sides. Returns true when anything actually changed. */
async function applyLink(task, winner, matchedBy) {
  const leadId = winner.lead._id;
  const leadSource = winner.kind === 'meta' ? 'meta' : 'web';

  // The Task's CURRENT link is read back rather than taken from the object the
  // caller handed us. Callers legitimately pass a document they loaded before
  // some earlier link was written — the ingest route holds one across an await,
  // and `linkLead` resolves its Task through a separate read. Trusting a stale
  // snapshot would both mis-report `changed` (breaking the backfill's "a second
  // run changes nothing" check) and, worse, make this think it is re-pointing
  // away from a lead the Task no longer holds — releasing that lead's link for
  // nothing.
  const current = await Task.findOne({ _id: task._id }, { linkedLeadId: 1, leadSource: 1 }).lean();
  if (!current) return false; // Task deleted mid-flight; nothing to link to.

  const previous = current.linkedLeadId;
  const repointed = Boolean(previous) && String(previous) !== String(leadId);
  if (repointed) {
    // The Task was pointing at a weaker match (phone) and a stronger one (Bigin
    // id) has since appeared. Release the old lead so it is not orphaned holding
    // a link this Task no longer honours.
    await WebLead.updateOne({ _id: previous, linkedTaskId: task._id }, { $set: { linkedTaskId: null } });
    console.warn(
      `[leadLinker] task ${task._id} re-pointed from lead ${previous} to ${leadId} (${matchedBy})`
    );
  }

  // Compared against what the Task already holds rather than trusting
  // modifiedCount: Task is a `timestamps: true` schema, so mongoose appends an
  // `updatedAt` to every update and Mongo then reports a modification even when
  // nothing else moved. The backfill needs "zero changes on a second run" to
  // actually mean that.
  const linkChanged =
    String(previous || '') !== String(leadId) || current.leadSource !== leadSource;

  let changed = repointed || linkChanged;

  if (winner.kind === 'web') {
    const res = await WebLead.updateOne(
      { _id: leadId, linkedTaskId: { $ne: task._id } },
      { $set: { linkedTaskId: task._id } }
    );
    changed = changed || res.modifiedCount > 0;
  }

  // Skipped entirely when the Task already says this, so a re-run of the backfill
  // over tens of thousands of contacts issues no writes at all. `timestamps: false`
  // for the same reason the comparison above exists: resolving attribution is a
  // derived write, not the contact being touched, and it must not push every Task
  // to the top of a list sorted by `updatedAt`.
  if (linkChanged) {
    await Task.updateOne(
      { _id: task._id },
      { $set: { linkedLeadId: leadId, leadSource } },
      { timestamps: false }
    );
  }

  return changed;
}

/**
 * Reverse direction: given a Task (typically one Bigin just created), find the ad
 * lead it belongs to and link them.
 *
 * @param {object} taskDoc a Task document or lean object
 * @returns {Promise<{leadId: any, leadSource: 'web'|'meta', matchedBy: 'biginContactId'|'phoneKey', changed: boolean}|null>}
 */
async function linkTask(taskDoc) {
  if (!taskDoc || !taskDoc._id) return null;

  const found = await candidatesForTask(taskDoc);
  if (!found) return null;

  const winner = pickCandidate(found.candidates);
  const changed = await applyLink(taskDoc, winner, found.matchedBy);

  return {
    leadId: winner.lead._id,
    leadSource: winner.kind === 'meta' ? 'meta' : 'web',
    matchedBy: found.matchedBy,
    changed,
  };
}

// Everything the matcher reads off a Task. Projected explicitly because `body`
// is the whole Bigin webhook payload and we only ever need two fields out of it
// — pulling the lot on every candidate lookup would be a lot of wasted bytes
// during the backfill.
const TASK_FIELDS = {
  _id: 1,
  dedupeKey: 1,
  phone: 1,
  phoneKey: 1,
  leadSource: 1,
  linkedLeadId: 1,
  'body.Who_Id': 1,
};

/** The one Task this lead could belong to, or null when there is no safe answer. */
async function findTaskForLead(lead, kind) {
  const contactId = kind === 'web' && lead.biginContactId ? String(lead.biginContactId) : null;
  const key = leadPhoneKey(lead, kind);

  if (contactId) {
    // `dedupeKey` is the canonical `contact:<id>` and is uniquely indexed; the
    // body path is the fallback for rows written before it, and is indexed too.
    const byKey = await Task.findOne({ dedupeKey: `contact:${contactId}` }, TASK_FIELDS).lean();
    if (byKey) return byKey;
    const byBody = await Task.findOne({ 'body.Who_Id.id': contactId }, TASK_FIELDS).lean();
    if (byBody) return byBody;
  }

  if (!key) return null;
  return findTaskByPhone(key, contactId);
}

async function findTaskByPhone(key, contactId) {
  // Two Bigin contacts on one number (a parent and a child sharing a handset) is
  // real and common. There is no evidence that picks between them, so link
  // neither — a blank Acquisition panel beats one showing the wrong person.
  const tasks = await Task.find({ phoneKey: key }, TASK_FIELDS).limit(2).lean();
  if (tasks.length !== 1) {
    if (tasks.length > 1) {
      console.warn(`[leadLinker] phone ${key} matches multiple contacts — not linking`);
    }
    return null;
  }

  const task = tasks[0];
  // We got here with a Bigin id in hand and no Task carrying it. Dashboard Tasks
  // are deduped BY contact, so a Task holding some OTHER contact id is a
  // different person who happens to share the number; only a Task with no
  // contact id of its own can still be this lead's.
  if (contactId) {
    const own = taskContactId(task);
    if (own && own !== contactId) return null;
  }
  return task;
}

/**
 * Forward direction: given an ad lead, find its Task and link them.
 *
 * Resolution is delegated to `linkTask` so both directions apply the identical
 * preference rules — which also means this returns a null taskId when the Task
 * was found but a BETTER lead won it. That is the correct answer for this lead:
 * it is not linked.
 *
 * @param {object} leadDoc a WebLead or MetaLead document / lean object
 * @returns {Promise<{taskId: any, matchedBy: 'biginContactId'|'phoneKey'|null}>}
 */
async function linkLead(leadDoc) {
  const unlinked = { taskId: null, matchedBy: null };
  if (!leadDoc || !leadDoc._id) return unlinked;

  const kind = leadKind(leadDoc);
  if (kind === 'meta' && !isStorableLeadId(leadDoc._id)) {
    warnOnce(
      'meta-id',
      'Meta leads cannot be linked: MetaLead._id is a Meta string id and ' +
        'Task.linkedLeadId is typed ObjectId. Widen Task.linkedLeadId to Mixed to enable them.'
    );
    return unlinked;
  }

  const task = await findTaskForLead(leadDoc, kind);
  if (!task) return unlinked;

  const result = await linkTask(task);
  if (!result || String(result.leadId) !== String(leadDoc._id)) return unlinked;

  return { taskId: task._id, matchedBy: result.matchedBy };
}

module.exports = { linkLead, linkTask, phoneFromFieldData };
