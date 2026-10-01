// Everything the dashboard knows about ONE lead, in one payload.
//
// The same person is spread across six tabs — Follow-ups (Task), Ad Leads
// (WebLead / MetaLead), Calls, Installments and Upsells (Deal), VSL Tracking (a
// second Mongo cluster). Every one of those collections already carries the same
// indexed join key, the last 10 digits of the phone, so a profile is five
// equality reads on that key plus the two enrichment blocks the lead drawer
// already builds. Nothing here re-implements a rule another module owns:
//
//   task shapes     taskController.serialize / serializeDetail
//   acquisition     ads/services/acquisitionView.buildAcquisition (cost: admins only)
//   watch time      vsl/services/vslView.buildVslBlock (never the VSL cluster directly)
//   won/lost/...    ads/services/leadState.leadState
//   task ownership  utils/owner.taskOwnerEmails
//
// FAULT TOLERANCE
// ---------------
// Each source is fetched in parallel with its own catch, the way detailFor() does
// it for the drawer: a VSL cluster timeout costs the VSL panel, a Calls query that
// throws costs the Calls list, and neither costs the lead. But a source that
// FAILED is not a source that came back EMPTY — a lead is only 404 when every
// source answered and every answer was "nothing", and a rep is only 403 when every
// ownership source answered and none named them. Anything short of that is a 503:
// we could not tell, and saying "not found" or "not yours" would be a guess.
//
// buildLeadProfile() never touches req/res. It returns { status, body } so the
// route is a one-line translation and the tests (task 4) can call it directly.

const Task = require('../../../models/Task');
const WebLead = require('../../ads/models/WebLead');
const MetaLead = require('../../ads/models/MetaLead');
const Deal = require('../../calls/models/Deal');
const Call = require('../../calls/models/Call');
const Contact = require('../models/Contact');
const zoho = require('../../../services/zoho');
const vslConnection = require('../../vsl/services/connection');
const { serialize, serializeDetail } = require('../../../controllers/taskController');
const { buildAcquisition } = require('../../ads/services/acquisitionView');
const { buildVslBlock, contactPhoneOf } = require('../../vsl/services/vslView');
const { leadState } = require('../../ads/services/leadState');
const { NAME_FIELDS, fieldValue } = require('../../ads/services/metaFields');
const { taskOwnerEmails } = require('../../../utils/owner');

const PHONE_KEY_RE = /^\d{10}$/;

// A call's transcript segments are word-level timing data — easily the largest
// thing in the collection and nothing a profile renders. The transcript text and
// the grade stay.
const CALL_PROJECTION = { 'transcript.segments': 0 };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(status, message) {
  return { status, body: { success: false, message } };
}

/** A real Date, or null — never an Invalid Date that would poison a sort. */
function toDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function timeOf(value) {
  const date = toDate(value);
  return date ? date.getTime() : 0;
}

/** Newest first; undated rows sink to the bottom instead of throwing the order. */
function byNewest(atOf) {
  return (a, b) => timeOf(atOf(b)) - timeOf(atOf(a));
}

function lower(value) {
  return value == null ? '' : String(value).trim().toLowerCase();
}

function firstPresent(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
}

/** A Task `body` is one task object OR an array of them — see utils/owner.js. */
function bodiesOf(taskDoc) {
  const body = taskDoc && taskDoc.body;
  return (Array.isArray(body) ? body : [body]).filter((b) => b && typeof b === 'object');
}

// When each record "happened", for sorting and for the timeline.
const taskAt = (t) => t.receivedAt || t.updatedAt || t.createdAt;
const dealAt = (d) => d.modifiedTime || d.updatedAt || d.createdAt;
const callAt = (c) => c.startedAt || c.createdAt;
const webAt = (w) => w.createdAt;
const metaAt = (m) => m.createdTime || m.syncedAt;

/**
 * Run one source with its own failure boundary.
 *
 * Resolves to the fallback on error and records the source's name in `failed`,
 * so the caller can tell "empty" from "unknown" when deciding 404 and 403.
 */
function guard(name, promise, fallback, failed) {
  return Promise.resolve(promise).catch((err) => {
    console.warn(`[lead-profile] ${name} failed:`, err && err.message ? err.message : err);
    if (failed) failed.add(name);
    return fallback;
  });
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Does this rep own anything on the lead?
 *
 * A Task is theirs by the same owner test the tasks list uses (every owner email
 * on the body, array or not). A Deal or a Call is theirs by its `ownerEmail`,
 * case-insensitively — Bigin and TeleCMI do not agree on casing.
 *
 * A rep with no ownerEmail owns nothing: comparing '' against a deal with no
 * owner would otherwise hand them every unowned deal on the key.
 */
function repOwnsSomething(user, { tasks, deals, calls, contacts = [] }) {
  const mine = lower(user && user.ownerEmail);
  if (!mine) return false;
  if (tasks.some((t) => taskOwnerEmails(t).includes(mine))) return true;
  if (deals.some((d) => lower(d.ownerEmail) === mine)) return true;
  if (contacts.some((c) => lower(c.ownerEmail) === mine)) return true;
  return calls.some((c) => lower(c.ownerEmail) === mine);
}

/** No owner email on any Task, Deal, Call or Bigin contact — an unassigned lead. */
function nobodyOwns({ tasks, deals, calls, contacts = [] }) {
  if (tasks.some((t) => taskOwnerEmails(t).length)) return false;
  if (deals.some((d) => lower(d.ownerEmail))) return false;
  if (contacts.some((c) => lower(c.ownerEmail))) return false;
  return !calls.some((c) => lower(c.ownerEmail));
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function taskContact(taskDoc) {
  if (!taskDoc) return { name: null, phone: null, leadSource: null };
  const who = bodiesOf(taskDoc)
    .map((b) => b.Who_Id)
    .find((w) => w && typeof w === 'object' && w.name);
  return {
    name: who ? who.name : null,
    phone: firstPresent(taskDoc.phone, contactPhoneOf(taskDoc.body)),
    leadSource: taskDoc.leadSource || null,
  };
}

function formContact(form) {
  if (!form) return { name: null, phone: null, leadSource: null };
  if (form.kind === 'web') {
    const lead = form.lead;
    return {
      name: firstPresent(lead.name, [lead.firstName, lead.lastName].filter(Boolean).join(' ')),
      phone: firstPresent(lead.phone, lead.phoneKey),
      leadSource: 'web',
    };
  }
  return {
    name: fieldValue(form.lead.fieldData, NAME_FIELDS),
    // The shared 10-digit key, as the Ad Leads tab shows it.
    phone: form.lead.phoneKey || null,
    leadSource: 'meta',
  };
}

function dealContact(deal) {
  if (!deal) return { name: null, phone: null, leadSource: null };
  return {
    name: deal.contactName || null,
    phone: firstPresent(deal.contactPhone, deal.contactPhoneKey),
    leadSource: firstPresent(deal.leadSourceKey, deal.leadSource),
  };
}

function callContact(call) {
  if (!call) return { name: null, phone: null, leadSource: null };
  return { name: call.leadName || null, phone: call.leadPhone || null, leadSource: null };
}

function biginContact(contact) {
  if (!contact) return { name: null, phone: null, leadSource: null };
  return {
    name: contact.name || null,
    phone: firstPresent(contact.phone, contact.mobile),
    leadSource: contact.leadSource || null,
  };
}

function taskOwner(taskDoc) {
  const owner = bodiesOf(taskDoc)
    .map((b) => b.Owner)
    .find((o) => o && typeof o === 'object' && (o.email || o.name));
  return owner ? { name: owner.name || null, email: owner.email || null } : null;
}

/**
 * Who this is and where they stand.
 *
 * Each of name / phone / leadSource is taken from the best source that HAS it,
 * in order: latest Task, newest form fill, newest Deal, newest Call. Field by
 * field rather than record by record, so a Task that never learned the lead's
 * source doesn't blank a source the form fill knows.
 *
 * The state is the newest deal's — a lead that lost a deal last year and has an
 * open one now is in the pipeline, not lost.
 */
function buildHeader({ phoneKey, tasks, forms, deals, calls, contacts = [] }) {
  const latestTask = tasks[0] || null;
  const newestDeal = deals[0] || null;
  const contact = contacts[0] || null;
  const candidates = [
    taskContact(latestTask),
    formContact(forms[0] || null),
    dealContact(newestDeal),
    biginContact(contact),
    callContact(calls[0] || null),
  ];
  const pick = (field) => firstPresent(...candidates.map((c) => c[field]));

  const owner =
    (latestTask && taskOwner(latestTask)) ||
    (newestDeal && (newestDeal.ownerName || newestDeal.ownerEmail)
      ? { name: newestDeal.ownerName || null, email: newestDeal.ownerEmail || null }
      : null) ||
    (contact && (contact.ownerName || contact.ownerEmail)
      ? { name: contact.ownerName || null, email: contact.ownerEmail || null }
      : null);

  return {
    name: pick('name'),
    phone: pick('phone') || phoneKey,
    leadSource: pick('leadSource'),
    state: leadState(latestTask, newestDeal),
    ownerName: owner ? owner.name : null,
    ownerEmail: owner ? owner.email : null,
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (!s) return null;
  const m = Math.floor(s / 60);
  return m ? `${m}m ${s % 60}s` : `${s}s`;
}

function taskCreatedAt(taskDoc) {
  if (toDate(taskDoc.createdAt)) return taskDoc.createdAt;
  // Documents older than the timestamps option: the earliest Bigin task we
  // recorded for the contact is the best evidence of when it started.
  const earliest = (taskDoc.taskHistory || [])
    .map((h) => toDate(h && h.createdTime))
    .filter(Boolean)
    .sort((a, b) => a - b)[0];
  return earliest || taskDoc.receivedAt;
}

/**
 * One merged, newest-first history across every source.
 *
 * `by` is whoever DID the thing, when a record says so, and null otherwise — a
 * webhook status change has no human behind it, and a Task's owner is who it is
 * assigned to, not who created it. Entries with no usable date are dropped: an
 * undated event has no place in a chronology, and a NaN would scramble the sort.
 */
function buildTimeline({ tasks, webLeads, metaLeads, deals, calls }) {
  const events = [];
  const push = (at, type, text, by) => {
    const date = toDate(at);
    if (!date) return;
    events.push({ at: date, type, text, by: by == null || by === '' ? null : String(by) });
  };

  for (const lead of webLeads) {
    const parts = ['Filled web form'];
    if (lead.source) parts.push(`"${lead.source}"`);
    if (lead.utmCampaign) parts.push(`(campaign ${lead.utmCampaign})`);
    push(webAt(lead), 'form', parts.join(' '), null);
  }

  for (const lead of metaLeads) {
    push(
      metaAt(lead),
      'form',
      lead.formId ? `Filled Meta instant form ${lead.formId}` : 'Filled Meta instant form',
      null
    );
  }

  for (const task of tasks) {
    const body = bodiesOf(task)[0] || {};
    const creator = body.Created_By && typeof body.Created_By === 'object' ? body.Created_By.name : null;
    push(
      taskCreatedAt(task),
      'task',
      body.Subject ? `Follow-up created: ${body.Subject}` : 'Follow-up created',
      creator
    );

    for (const change of task.statusHistory || []) {
      if (!change || !change.status) continue;
      const via = change.source === 'dashboard' ? 'on the dashboard' : 'in Bigin';
      push(change.changedAt, 'status', `Status set to ${change.status} ${via}`, change.by);
    }

    for (const note of task.notes || []) {
      if (!note || !note.text) continue;
      push(note.createdAt, 'note', note.text, note.author);
    }

    for (const msg of task.whatsappLog || []) {
      if (!msg) continue;
      const name = msg.template ? `"${msg.template}"` : 'template';
      const text = msg.ok
        ? `WhatsApp ${name} sent`
        : `WhatsApp ${name} failed${msg.error ? `: ${msg.error}` : ''}`;
      push(msg.sentAt, 'whatsapp', text, msg.sentBy);
    }
  }

  for (const call of calls) {
    const direction =
      call.direction === 'inbound' ? 'Inbound call' : call.direction === 'outbound' ? 'Outbound call' : 'Call';
    const duration = formatDuration(call.duration);
    const graded = call.grade && Number.isFinite(call.grade.score) ? `, graded ${call.grade.score}` : '';
    push(
      callAt(call),
      'call',
      `${direction}${duration ? ` (${duration})` : ''}${graded}`,
      call.ownerEmail || null
    );
  }

  for (const deal of deals) {
    const verdict =
      deal.outcome === 'won' ? 'Deal won' : deal.outcome === 'lost' ? 'Deal lost' : 'Deal in pipeline';
    const parts = [verdict];
    if (deal.stage) parts.push(`— ${deal.stage}`);
    if (deal.name) parts.push(`(${deal.name})`);
    if (deal.outcome === 'lost' && deal.lostReason) parts.push(`: ${deal.lostReason}`);
    push(dealAt(deal), 'deal', parts.join(' '), deal.ownerName || deal.ownerEmail || null);
  }

  return events.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

/**
 * Which ad lead the profile's acquisition block should describe.
 *
 * A Task that was linked at match time is the authority (newest first). A lead
 * nobody has made a Task for yet still filled a form, and that form IS where they
 * came from — so the newest form fill stands in, shaped as the (leadSource,
 * linkedLeadId) pair buildAcquisition reads.
 */
function acquisitionSource(tasks, forms) {
  const linked = tasks.find((t) => t.linkedLeadId != null && t.linkedLeadId !== '');
  if (linked) return linked;
  const form = forms[0];
  return form ? { leadSource: form.kind, linkedLeadId: form.lead._id } : null;
}

// ---------------------------------------------------------------------------
// The profile
// ---------------------------------------------------------------------------

/**
 * @param {string} phoneKey the last 10 digits of the lead's phone
 * @param {object} user the authenticated user (role, ownerEmail)
 * @returns {Promise<{status: number, body: object}>} never rejects for a data
 *   failure — the status is the answer (200 / 400 / 403 / 404 / 503)
 */
async function buildLeadProfile(phoneKey, user) {
  const key = phoneKey == null ? '' : String(phoneKey);
  if (!PHONE_KEY_RE.test(key)) {
    return fail(400, 'phoneKey must be exactly 10 digits');
  }

  const isAdmin = Boolean(user && user.role === 'admin');
  const failed = new Set();

  // ---- every source, in flight at once ------------------------------------
  const tasksP = guard(
    'tasks',
    Task.find({ phoneKey: key }).sort({ receivedAt: -1 }).lean(),
    [],
    failed
  );
  const webP = guard(
    'webLeads',
    WebLead.find({ phoneKey: key }).sort({ createdAt: -1 }).lean(),
    [],
    failed
  );
  // createdTime is Meta's ISO string with a +0000 offset, so the order is taken
  // on the parsed date rather than trusting a string sort.
  const metaP = guard(
    'metaLeads',
    MetaLead.find({ phoneKey: key }).lean().then((rows) => rows.sort(byNewest(metaAt))),
    [],
    failed
  );
  const dealsP = guard(
    'deals',
    Deal.find({ contactPhoneKey: key }).lean().then((rows) => rows.sort(byNewest(dealAt))),
    [],
    failed
  );
  // A call carries a key per phone leg (lead / to / from), so the lead's key is
  // matched against the array rather than a single field.
  const callsP = guard(
    'calls',
    Call.find({ phoneKeys: key }, CALL_PROJECTION).lean().then((rows) => rows.sort(byNewest(callAt))),
    [],
    failed
  );

  // The Bigin contact(s) on this number — enough on their own to make a lead.
  const contactsP = guard(
    'contacts',
    Contact.find({ phoneKeys: key }).sort({ createdTime: -1 }).lean(),
    [],
    failed
  );

  // The newest Task, in exactly the GET /api/tasks/:id shape. serializeDetail
  // builds that shape's own acquisition + vsl (each already failure-bounded
  // inside detailFor), which the profile-level blocks below reuse rather than
  // fetching the same thing twice.
  const latestTaskP = guard(
    'latestTask',
    tasksP.then((tasks) => (tasks[0] ? serializeDetail(tasks[0], user) : null)),
    null
  );

  // Watch time is keyed on the phone alone, so a lead with no Task still gets it.
  const vslP = guard(
    'vsl',
    Promise.all([latestTaskP, tasksP]).then(([detail, tasks]) =>
      detail
        ? detail.vsl
        : buildVslBlock({ phoneKey: key, leadSource: tasks[0] ? tasks[0].leadSource : null })
    ),
    null
  );

  // Cost is requested ONLY for admins; buildAcquisition then never writes the key.
  const acquisitionP = guard(
    'acquisition',
    Promise.all([latestTaskP, tasksP, webP, metaP]).then(([detail, tasks, web, meta]) => {
      if (detail && detail.acquisition) return detail.acquisition;
      const source = acquisitionSource(tasks, mergeForms(web, meta));
      return source ? buildAcquisition(source, { includeCost: isAdmin }) : null;
    }),
    null
  );

  const [tasks, webLeads, metaLeads, deals, calls, contacts] = await Promise.all([
    tasksP,
    webP,
    metaP,
    dealsP,
    callsP,
    contactsP,
  ]);

  // ---- 404: nothing anywhere — but only if everywhere actually answered -----
  const nothing =
    !tasks.length && !webLeads.length && !metaLeads.length && !deals.length && !calls.length && !contacts.length;
  if (nothing) {
    return failed.size
      ? fail(503, 'Could not load this lead right now — please try again')
      : fail(404, 'No lead found for this phone number');
  }

  // ---- 403: a rep must own a Task, Deal or Call on the key — or nobody may ---
  // A lead nobody owns yet (a fresh form fill) is open to every rep, the same
  // rule the Leads list uses to show it. Only when every ownership source
  // answered can we say "nobody owns it".
  if (!isAdmin && !repOwnsSomething(user, { tasks, deals, calls, contacts })) {
    const ownershipUnknown =
      failed.has('tasks') || failed.has('deals') || failed.has('calls') || failed.has('contacts');
    if (ownershipUnknown) {
      return fail(503, 'Could not verify access to this lead right now — please try again');
    }
    if (!nobodyOwns({ tasks, deals, calls, contacts })) return fail(403, 'Not your lead');
  }

  const [latestTask, vsl, acquisition] = await Promise.all([latestTaskP, vslP, acquisitionP]);
  const forms = mergeForms(webLeads, metaLeads);

  return {
    status: 200,
    body: {
      success: true,
      zohoSync: zoho.isConfigured(),
      data: {
        phoneKey: key,
        header: buildHeader({ phoneKey: key, tasks, forms, deals, calls, contacts }),
        latestTask,
        // Read-only rows in the UI; the newest one is `latestTask` above.
        olderTasks: tasks.slice(1).map((t) => serialize(t)),
        webLeads,
        metaLeads,
        deals,
        calls,
        vsl: vsl || null,
        // null vsl means "never watched" only when the VSL cluster is wired up;
        // otherwise nobody can know, and the page says which.
        vslConfigured: vslConnection.isConfigured(),
        acquisition: acquisition || null,
        timeline: buildTimeline({ tasks, webLeads, metaLeads, deals, calls }),
      },
    },
  };
}

/** Both form collections as one newest-first list of { kind, lead }. */
function mergeForms(webLeads, metaLeads) {
  return [
    ...webLeads.map((lead) => ({ kind: 'web', lead, at: webAt(lead) })),
    ...metaLeads.map((lead) => ({ kind: 'meta', lead, at: metaAt(lead) })),
  ].sort(byNewest((f) => f.at));
}

module.exports = {
  buildLeadProfile,
  buildHeader,
  buildTimeline,
  // Shared with the Leads list (leadList.js), so a row and its profile agree.
  mergeForms,
  bodiesOf,
  toDate,
  lower,
  taskAt,
  dealAt,
};
