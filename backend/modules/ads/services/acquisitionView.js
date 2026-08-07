// Build the `acquisition` block the lead-detail API hangs off a Task: where this
// person came from, what they answered on the form, and — for admins only — what
// they cost.
//
// ONE LOOKUP, NO AGGREGATION
// --------------------------
// The link was resolved and stored on the Task when the lead was matched
// (`leadSource` + `linkedLeadId`), so answering "where did this lead come from"
// is a single primary-key read. The cost half is a memory lookup into the CPL
// table built by the ad sync. Nothing here aggregates, because this runs on every
// drawer open and Atlas M0 charges ~20ms a document.
//
// TWO COLLECTIONS, ONE SHAPE
// --------------------------
// A lead is either a WebLead (ObjectId `_id`, UTMs, typed qualification columns)
// or a MetaLead (Meta's own string `_id`, no UTMs, answers buried in an untyped
// `fieldData` list). `Task.leadSource` says which collection to read — the id
// alone cannot, since `linkedLeadId` may legitimately hold either type. Both are
// flattened into the same response shape so the UI has one panel, not two.
//
// COST IS ADMIN-ONLY AND IS OMITTED, NOT BLANKED
// ----------------------------------------------
// A sales rep must not be able to infer ad spend from their own session, and a
// nulled-out `cost: null` still tells them the field exists and invites a
// frontend that forgets to hide it. So when `includeCost` is false the key is
// never written at all — grep the raw response body and there is nothing to find.

const MetaCampaign = require('../models/MetaCampaign');
const MetaLead = require('../models/MetaLead');
const WebLead = require('../models/WebLead');
const cplCache = require('./cplCache');

// ---------------------------------------------------------------------------
// Campaign names
// ---------------------------------------------------------------------------
//
// Tens of rows, read on every drawer open, and a campaign's NAME is the one thing
// about it we display. Cached with the same short TTL as the campaign resolver's
// index so a campaign the sync created minutes ago starts naming itself without a
// restart, and so the detail endpoint stays at one database read.
const NAME_TTL_MS = Number(process.env.CAMPAIGN_INDEX_TTL_MS || 60000);

let names = null;
let namesAt = 0;
let loadingNames = null;

async function campaignNames() {
  if (names && Date.now() - namesAt < NAME_TTL_MS) return names;
  if (!loadingNames) {
    loadingNames = MetaCampaign.find({}, { name: 1 })
      .lean()
      .then((rows) => {
        const next = new Map();
        for (const row of rows) next.set(String(row._id), row.name == null ? null : String(row.name));
        names = next;
        namesAt = Date.now();
        return next;
      })
      .finally(() => {
        loadingNames = null;
      });
  }
  // Concurrent drawer opens share one query rather than stampeding the collection.
  return loadingNames;
}

/** Drop the cached names — for tests and for callers that just synced campaigns. */
function invalidate() {
  names = null;
  namesAt = 0;
}

// ---------------------------------------------------------------------------
// Meta instant-form answers
// ---------------------------------------------------------------------------
//
// A Meta form's answers arrive as an untyped [{ name, values }] list and the
// question NAME is whatever the person who built the form typed — "city",
// "Your city", "which city do you live in?". Same problem the lead linker solves
// for the phone field, same two-pass shape: exact normalised names first (in
// priority order), then a narrow substring fallback for question-style labels.
//
// Deliberately conservative: a wrong answer on a rep's screen during a call is
// worse than a blank one, so anything not clearly one of these five is dropped.
const QUALIFICATION_FIELDS = {
  caStatus: {
    names: ['castatus', 'castudentstatus', 'caqualification', 'calevel', 'course', 'currentstatus', 'status'],
    hints: ['castatus', 'castudent', 'calevel'],
  },
  attempt: {
    names: ['attempt', 'attemptnumber', 'whichattempt', 'yourattempt', 'examattempt', 'nextattempt', 'targetattempt'],
    hints: ['attempt'],
  },
  language: {
    names: ['language', 'preferredlanguage', 'languagepreference', 'mediumofinstruction', 'medium'],
    hints: ['language', 'medium'],
  },
  city: { names: ['city', 'yourcity', 'currentcity', 'town'], hints: ['city'] },
  state: { names: ['state', 'yourstate', 'currentstate'], hints: ['state'] },
};

/** Same shape-insensitive comparison the linker and the campaign resolver use. */
function normalizeFieldName(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function entryName(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return normalizeFieldName(entry.name != null ? entry.name : entry.key != null ? entry.key : entry.field);
}

/** Meta sends `values: []`; migrated rows sometimes carry a bare `value`. */
function entryValues(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.values)) return entry.values;
  if (entry.values != null) return [entry.values];
  if (Array.isArray(entry.value)) return entry.value;
  if (entry.value != null) return [entry.value];
  return [];
}

function firstAnswer(entry) {
  for (const value of entryValues(entry)) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

/**
 * Pull the five qualification answers out of a Meta lead's `fieldData`.
 * Missing questions come back null, never undefined — the response shape is the
 * same whichever form produced the lead.
 */
function qualificationFromFieldData(fieldData) {
  const out = { caStatus: null, attempt: null, language: null, city: null, state: null };
  if (!Array.isArray(fieldData) || !fieldData.length) return out;

  const named = fieldData.map((entry) => ({ entry, name: entryName(entry) })).filter((e) => e.name);

  for (const [field, { names: exact, hints }] of Object.entries(QUALIFICATION_FIELDS)) {
    // Pass 1 — exact names, in priority order. Priority is over the NAME, not the
    // position in the array, so a form listing a generic "status" before "ca_status"
    // still answers with the specific one.
    for (const wanted of exact) {
      // A question that is present but BLANK is not an answer — keep looking, so a
      // form with an empty "status" and a filled "ca_status" still resolves.
      const hit = named.find((e) => e.name === wanted && firstAnswer(e.entry));
      if (hit) {
        out[field] = firstAnswer(hit.entry);
        break;
      }
    }
    if (out[field]) continue;

    // Pass 2 — question-style or unfamiliar labels ("what is your city?").
    for (const { entry, name } of named) {
      if (!hints.some((hint) => name.includes(hint))) continue;
      const answer = firstAnswer(entry);
      if (answer) {
        out[field] = answer;
        break;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Loading the linked lead
// ---------------------------------------------------------------------------

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

/** A WebLead read must not be handed a Meta id — mongoose would throw a CastError. */
function isObjectIdLike(id) {
  if (!id) return false;
  if (typeof id === 'object') return true; // an actual ObjectId
  return OBJECT_ID_RE.test(String(id));
}

const WEB_FIELDS = {
  source: 1,
  createdAt: 1,
  caStatus: 1,
  attempt: 1,
  language: 1,
  city: 1,
  state: 1,
  utmSource: 1,
  utmMedium: 1,
  utmCampaign: 1,
  utmContent: 1,
  utmTerm: 1,
  landingUrl: 1,
  referrer: 1,
  resolvedCampaignId: 1,
  resolvedBy: 1,
};

const META_FIELDS = { createdTime: 1, syncedAt: 1, adId: 1, formId: 1, campaignId: 1, fieldData: 1 };

/**
 * Read the one lead this Task is linked to.
 *
 * `linkedLeadId` points into one of two collections and holds either an ObjectId
 * (WebLead) or Meta's own string id (MetaLead), so `leadSource` — not the id's
 * type — decides which model to query. The type check still happens, because a
 * WebLead read given a 16-digit Meta id throws rather than missing.
 */
async function loadLead(task) {
  const id = task && task.linkedLeadId;
  if (id == null || id === '') return null;

  const source = task.leadSource === 'meta' || task.leadSource === 'web' ? task.leadSource : null;

  // No `leadSource` means a link written before the field existed (or a partial
  // write). The id's own shape is the only evidence left, so use it — an
  // unattributed panel is worse than one inferred from a 24-hex id.
  const kind = source || (isObjectIdLike(id) ? 'web' : 'meta');

  if (kind === 'meta') {
    const lead = await MetaLead.findOne({ _id: String(id) }, META_FIELDS).lean();
    return lead ? { lead, kind: 'meta' } : null;
  }

  if (!isObjectIdLike(id)) return null;
  const lead = await WebLead.findOne({ _id: id }, WEB_FIELDS).lean();
  return lead ? { lead, kind: 'web' } : null;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * The lead's share of its campaign's spend for the month it was captured in.
 *
 * This is an APPORTIONMENT, not a figure Meta reports per person — which is why
 * the inputs travel with the result: the UI shows the division, not just its
 * answer. Null whenever the division cannot be made honestly: no campaign, no
 * capture date, no insight rows for that campaign-month, or a month with spend
 * but zero leads (undefined, not infinite).
 */
function costFor(campaignId, capturedAt) {
  if (!campaignId) return null;
  const month = cplCache.monthOf(capturedAt);
  if (!month) return null;

  const hit = cplCache.lookup(String(campaignId), month);
  if (!hit || !(hit.leads > 0) || !Number.isFinite(hit.cpl)) return null;

  return {
    // Rounded once here so every consumer shows the same number.
    estimated: Math.round(hit.cpl * 100) / 100,
    campaignSpend: hit.spend,
    leadCount: hit.leads,
    month,
    // Names the method so the UI can never present this as an exact per-lead cost.
    basis: 'campaign-month-apportionment',
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

const EMPTY_UTM = { source: null, medium: null, campaign: null, content: null, term: null };

function orNull(value) {
  if (value == null) return null;
  const text = String(value);
  return text === '' ? null : text;
}

async function campaignBlock(campaignId, resolvedBy) {
  if (!campaignId) return null;
  let name = null;
  try {
    name = (await campaignNames()).get(String(campaignId)) || null;
  } catch (err) {
    // A missing name is a cosmetic loss; the id is still the truth.
    console.warn('[acquisition] campaign name lookup failed:', err.message);
  }
  // `resolvedBy` is not decoration: a campaign matched by normalised string is a
  // weaker claim than one Meta reported by id, and the panel has to say which.
  return { id: String(campaignId), name, resolvedBy: resolvedBy || null };
}

/**
 * @param {object} task a Task document or lean object
 * @param {{includeCost?: boolean}} [options] cost is written ONLY when true
 * @returns {Promise<object|null>} null when this Task has no linked ad lead —
 *   never an object of nulls, so the UI renders nothing rather than a grid of dashes
 */
async function buildAcquisition(task, options) {
  const includeCost = Boolean(options && options.includeCost);

  const found = await loadLead(task);
  if (!found) return null;

  const { lead, kind } = found;

  const capturedAt =
    kind === 'meta' ? toDate(lead.createdTime) || toDate(lead.syncedAt) : toDate(lead.createdAt);

  const campaignId = kind === 'meta' ? lead.campaignId : lead.resolvedCampaignId;
  // A Meta lead's campaign is not inferred from anything — Meta reported it with
  // the lead, so it is an 'id' match by definition, the strongest kind there is.
  const resolvedBy = kind === 'meta' ? (campaignId ? 'id' : null) : lead.resolvedBy;

  const acquisition = {
    source: kind, // 'meta' | 'web'
    leadId: String(lead._id),
    // Whatever the capture recorded as the form: a web lead's form slug
    // ("counseling-form"), or the Meta instant form's id.
    formLabel: kind === 'meta' ? orNull(lead.formId) : orNull(lead.source),
    formId: kind === 'meta' ? orNull(lead.formId) : null,
    adId: kind === 'meta' ? orNull(lead.adId) : null,
    // Often EARLIER than the Task's own receivedAt: the person filled the form
    // before Bigin created the follow-up.
    capturedAt,
    campaign: await campaignBlock(campaignId, resolvedBy),
    utm:
      kind === 'meta'
        ? // A Meta instant form never leaves the platform, so there is no landing
          // URL to carry tags — reported as absent rather than faked.
          { ...EMPTY_UTM }
        : {
            source: orNull(lead.utmSource),
            medium: orNull(lead.utmMedium),
            campaign: orNull(lead.utmCampaign),
            content: orNull(lead.utmContent),
            term: orNull(lead.utmTerm),
          },
    landingUrl: kind === 'meta' ? null : orNull(lead.landingUrl),
    referrer: kind === 'meta' ? null : orNull(lead.referrer),
    qualification:
      kind === 'meta'
        ? qualificationFromFieldData(lead.fieldData)
        : {
            caStatus: orNull(lead.caStatus),
            attempt: orNull(lead.attempt),
            language: orNull(lead.language),
            city: orNull(lead.city),
            state: orNull(lead.state),
          },
  };

  // Written only for admins. Not blanked, not zeroed — absent.
  if (includeCost) {
    acquisition.cost = costFor(campaignId, capturedAt);
  }

  return acquisition;
}

module.exports = {
  buildAcquisition,
  costFor,
  qualificationFromFieldData,
  invalidate,
};
