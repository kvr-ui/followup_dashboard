// Conversions API sweep — sends CRM funnel stages (Lead, MQL, SQL, Purchase) of
// every Bigin contact to the Meta pixel, so ads optimise toward real outcomes.
//
// HOW
// ---
// Every CAPI_INTERVAL_MINUTES (default 15): find contacts with anything new in
// Meta's 7-day window (created, a deal opened/moved, a connected call), work out
// their events (capiEvents), drop what the ledger (CapiEvent) already has, send
// the rest. A poll rather than webhook hooks because stages arrive by webhooks,
// polls and the nightly resync alike — the sweep sees all of them. Failures are
// retried on later sweeps, up to MAX_ATTEMPTS.
//
// MODES
// -----
//   CAPI_ENABLED=true + META_PIXEL_ID + a token     required to start
//       token = META_CAPI_TOKEN, else the ads sync's META_ACCESS_TOKEN
//   META_TEST_EVENT_CODE set                        'test' mode, ledgered separately
// CAREFUL: Meta only diverts test events while that code's Test Events session is
// OPEN in Events Manager. A stale code means the events count as real ones. So
// leave beta disabled except during a deliberate test (event ids match prod's,
// so Meta dedupes any overlap within 48h).
// Beta and prod share the database, hence the mode in the ledger key.

const Contact = require('../../leads/models/Contact');
const Deal = require('../../calls/models/Deal');
const Call = require('../../calls/models/Call');
const CapiEvent = require('../models/CapiEvent');
const { MetaClient } = require('../meta/client/MetaClient');
const { DEAL_FIELDS } = require('./dealJoin');
const { MAX_AGE_MS, isTestContact, contactEvents, tooOld, userData, toMetaEvent } = require('./capiEvents');
const { isRealPhoneKey } = require('../../../utils/phone');

const INTERVAL_MIN = Number(process.env.CAPI_INTERVAL_MINUTES || 15);
const FIRST_RUN_DELAY_MS = 150 * 1000; // after the ads sync's 120s
const MAX_ATTEMPTS = 5;
const BATCH = 500; // Meta allows 1000 per request

const CONNECTED = { $or: [{ duration: { $gt: 0 } }, { biginDurationSec: { $gt: 0 } }] };

let client = null;
let running = false;

const token = () => process.env.META_CAPI_TOKEN || process.env.META_ACCESS_TOKEN;

function isConfigured() {
  return Boolean(process.env.CAPI_ENABLED === 'true' && process.env.META_PIXEL_ID && token());
}

const mode = () => (process.env.META_TEST_EVENT_CODE ? 'test' : 'live');

function getClient() {
  if (!client) {
    client = new MetaClient({
      accessToken: token(),
      apiVersion: process.env.META_API_VERSION || undefined,
    });
  }
  return client;
}

/** Contacts with anything new inside Meta's window. */
async function loadCandidates(since) {
  const [fresh, deals, calls] = await Promise.all([
    Contact.find({ createdTime: { $gte: since } }, { zohoId: 1 }).lean(),
    Deal.find(
      { $or: [{ modifiedTime: { $gte: since } }, { createdTime: { $gte: since } }, { createdAt: { $gte: since } }] },
      { contactId: 1, contactPhoneKey: 1 }
    ).lean(),
    Call.find({ startedAt: { $gte: since }, ...CONNECTED }, { phoneKeys: 1, biginContactId: 1 }).lean(),
  ]);

  const ids = new Set(fresh.map((c) => c.zohoId));
  const keys = new Set();
  for (const d of deals) {
    if (d.contactId) ids.add(String(d.contactId));
    if (isRealPhoneKey(d.contactPhoneKey)) keys.add(d.contactPhoneKey);
  }
  for (const c of calls) {
    if (c.biginContactId) ids.add(String(c.biginContactId));
    for (const k of c.phoneKeys || []) if (isRealPhoneKey(k)) keys.add(k);
  }
  if (!ids.size && !keys.size) return [];

  return Contact.find({ $or: [{ zohoId: { $in: [...ids] } }, { phoneKeys: { $in: [...keys] } }] }).lean();
}

/** Each contact's deals and first connected call (all time — not just the window). */
async function loadHistory(contacts) {
  const ids = contacts.map((c) => c.zohoId);
  const keys = [...new Set(contacts.flatMap((c) => c.phoneKeys || []).filter(isRealPhoneKey))];

  const [deals, calls] = await Promise.all([
    Deal.find(
      { $or: [{ contactId: { $in: ids } }, { contactPhoneKey: { $in: keys } }] },
      { ...DEAL_FIELDS, createdTime: 1, createdAt: 1 }
    ).lean(),
    Call.find(
      { ...CONNECTED, $and: [{ $or: [{ phoneKeys: { $in: keys } }, { biginContactId: { $in: ids } }] }] },
      { phoneKeys: 1, biginContactId: 1, startedAt: 1 }
    ).lean(),
  ]);

  return (contact) => {
    const mine = new Set((contact.phoneKeys || []).filter(isRealPhoneKey));
    const owns = (id, phoneKeys) => String(id || '') === contact.zohoId || phoneKeys.some((k) => mine.has(k));
    const myDeals = deals.filter((d) => owns(d.contactId, [d.contactPhoneKey]));
    const firstCall = calls
      .filter((c) => owns(c.biginContactId, c.phoneKeys || []))
      .map((c) => (c.startedAt ? new Date(c.startedAt).getTime() : 0))
      .filter(Boolean);
    return { deals: myDeals, firstConnectedAt: firstCall.length ? Math.min(...firstCall) : 0 };
  };
}

async function postBatch(events) {
  const body = { data: events };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
  return getClient().post(`/${process.env.META_PIXEL_ID}/events`, body);
}

/** Send, falling back to one-by-one when Meta rejects a batch (one bad event fails all). */
async function send(items) {
  const results = new Map(); // ledger id -> { ok, error, fbtraceId }
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    try {
      const r = await postBatch(chunk.map((it) => it.payload));
      for (const it of chunk) results.set(it.id, { ok: true, fbtraceId: r.fbtrace_id || null });
    } catch (batchErr) {
      if (chunk.length === 1) {
        results.set(chunk[0].id, { ok: false, error: batchErr.message });
        continue;
      }
      for (const it of chunk) {
        try {
          const r = await postBatch([it.payload]);
          results.set(it.id, { ok: true, fbtraceId: r.fbtrace_id || null });
        } catch (err) {
          results.set(it.id, { ok: false, error: err.message });
        }
      }
    }
  }
  return results;
}

/** One sweep. Returns counts; never throws on a single event's failure. */
async function syncCapi({ now = Date.now() } = {}) {
  const m = mode();
  const since = new Date(now - MAX_AGE_MS);
  const contacts = (await loadCandidates(since)).filter((c) => !isTestContact(c));
  if (!contacts.length) return { mode: m, candidates: 0, sent: 0, failed: 0, skipped: 0 };

  const historyOf = await loadHistory(contacts);

  // Everything each contact has reached, keyed by its ledger id.
  const planned = [];
  for (const contact of contacts) {
    const { deals, firstConnectedAt } = historyOf(contact);
    const user = userData(contact, deals);
    if (!user) continue; // nothing Meta could match on
    const phoneKey = (contact.phoneKeys || []).find(isRealPhoneKey) || null;
    for (const e of contactEvents(contact, deals, firstConnectedAt)) {
      planned.push({
        id: `${m}:${contact.zohoId}:${e.event}`,
        row: { mode: m, contactId: contact.zohoId, phoneKey, ...e },
        payload: toMetaEvent({ contactId: contact.zohoId, ...e }, user),
      });
    }
  }

  // Drop what the ledger already settled: sent, too old, or out of retries — and
  // anything a duplicate contact on the same phone already sent.
  const ledger = await CapiEvent.find({ _id: { $in: planned.map((p) => p.id) } }).lean();
  const done = new Map(ledger.map((r) => [r._id, r]));
  const sentPhones = await CapiEvent.find(
    { mode: m, status: 'sent', phoneKey: { $in: [...new Set(planned.map((p) => p.row.phoneKey).filter(Boolean))] } },
    { phoneKey: 1, event: 1, contactId: 1 }
  ).lean();
  const phoneDone = new Set(sentPhones.map((r) => `${r.phoneKey}:${r.event}`));

  const toSend = [];
  const tooOldRows = [];
  const claimed = new Set(); // phone:event picked in this sweep
  for (const p of planned) {
    const prev = done.get(p.id);
    if (prev && (prev.status !== 'failed' || prev.attempts >= MAX_ATTEMPTS)) continue;
    const phoneEvent = p.row.phoneKey && `${p.row.phoneKey}:${p.row.event}`;
    if (phoneEvent && (phoneDone.has(phoneEvent) || claimed.has(phoneEvent))) continue;
    if (tooOld(p.row.eventTime, now)) {
      if (!prev) tooOldRows.push(p);
      continue;
    }
    if (phoneEvent) claimed.add(phoneEvent);
    toSend.push(p);
  }

  if (tooOldRows.length) {
    await CapiEvent.bulkWrite(
      tooOldRows.map((p) => ({
        updateOne: {
          filter: { _id: p.id },
          update: { $setOnInsert: { ...p.row, status: 'skipped_too_old' } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }

  const results = toSend.length ? await send(toSend) : new Map();
  const at = new Date();
  if (toSend.length) {
    await CapiEvent.bulkWrite(
      toSend.map((p) => {
        const r = results.get(p.id) || { ok: false, error: 'not sent' };
        return {
          updateOne: {
            filter: { _id: p.id },
            update: {
              $set: {
                ...p.row,
                status: r.ok ? 'sent' : 'failed',
                lastError: r.ok ? null : String(r.error || '').slice(0, 500),
                sentAt: r.ok ? at : null,
                fbtraceId: r.fbtraceId || null,
              },
              $inc: { attempts: 1 },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false }
    );
  }

  const sent = [...results.values()].filter((r) => r.ok).length;
  return {
    mode: m,
    candidates: contacts.length,
    sent,
    failed: toSend.length - sent,
    skipped: tooOldRows.length,
  };
}

async function runSweep() {
  if (running) return null;
  running = true;
  try {
    const result = await syncCapi();
    if (result.sent || result.failed) console.log('[capi] sweep:', result);
    return result;
  } catch (err) {
    console.warn('[capi] sweep failed:', err.message);
    return null;
  } finally {
    running = false;
  }
}

function start() {
  if (!isConfigured()) {
    console.log('CAPI disabled (set CAPI_ENABLED=true and META_PIXEL_ID).');
    return;
  }
  console.log(`CAPI: every ${INTERVAL_MIN}m, ${mode()} mode (first run in ${FIRST_RUN_DELAY_MS / 1000}s)`);
  setTimeout(runSweep, FIRST_RUN_DELAY_MS);
  setInterval(runSweep, INTERVAL_MIN * 60 * 1000);
}

/** Ledger counts + recent failures, for the admin status endpoint. */
async function capiStatus() {
  const [counts, failures] = await Promise.all([
    CapiEvent.aggregate([
      { $group: { _id: { mode: '$mode', event: '$event', status: '$status' }, n: { $sum: 1 } } },
    ]),
    CapiEvent.find({ status: 'failed' }).sort({ updatedAt: -1 }).limit(20).lean(),
  ]);
  return {
    enabled: isConfigured(),
    mode: mode(),
    counts: counts.map((c) => ({ ...c._id, count: c.n })),
    recentFailures: failures.map((f) => ({
      id: f._id,
      event: f.event,
      attempts: f.attempts,
      error: f.lastError,
      at: f.updatedAt,
    })),
  };
}

module.exports = { start, runSweep, syncCapi, capiStatus, isConfigured };
