// Copies each lead's WATI chat into wati_chats, so the Rep Lifecycle tab can read
// 800 chats without 800 live API calls.
//
// WHO GETS SYNCED, AND HOW OFTEN
// ------------------------------
// A chat matters most in the first hours of a lead's life (the bot, the first
// enquiry, the rep's first message), so new leads refresh often and older ones
// rarely:
//   created in the last 2 days    every run (WATI_SYNC_MIN, default 30)
//   created 2–14 days ago         every 6 hours
//   older                         only by the backfill script
// Every run is capped (WATI_SYNC_MAX_PER_RUN) and sequential with a small
// delay. A 429 ends the run early; the next run picks up where it stopped,
// because the stalest chats always go first.

const Contact = require('../../leads/models/Contact');
const WatiChat = require('../models/WatiChat');
const wati = require('../../../services/wati');
const { normaliseItems } = require('./watiNormalise');
const { PLACEHOLDER_PHONES, OFFICE_DID } = require('../../../utils/phone');

const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const HISTORY_DAYS = 180;
const DELAY_MS = Number(process.env.WATI_SYNC_DELAY_MS || 250);
const MAX_PER_RUN = Number(process.env.WATI_SYNC_MAX_PER_RUN || 300);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isRateLimit = (err) => err && (err.status === 429 || /too many|rate/i.test(err.message));

/** Fetch one phone's chat (newest pages first) and store it. */
async function syncPhone(phoneKey) {
  const cutoff = Date.now() - HISTORY_DAYS * DAY;
  const raw = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, hasMore } = await wati.getMessages(phoneKey, page, PAGE_SIZE);
    raw.push(...items);
    const oldest = items[items.length - 1];
    const oldestAt = oldest && new Date(oldest.created || 0).getTime();
    if (!hasMore || !items.length || (oldestAt && oldestAt < cutoff)) break;
    await sleep(DELAY_MS);
  }
  const items = normaliseItems(raw).filter((i) => i.at.getTime() >= cutoff);
  await WatiChat.updateOne(
    { phoneKey },
    {
      $set: {
        items,
        lastMessageAt: items.length ? items[items.length - 1].at : null,
        fetchedAt: new Date(),
        error: null,
      },
    },
    { upsert: true }
  );
  return items.length;
}

const usableKeys = (c) =>
  (c.phoneKeys || []).filter((k) => k && !PLACEHOLDER_PHONES.has(k) && k !== OFFICE_DID);

/**
 * Sync a list of phone keys in order, stopping at the cap or a rate limit.
 * Returns { synced, failed, rateLimited }.
 */
async function syncKeys(keys, { max = MAX_PER_RUN, log = false } = {}) {
  let synced = 0;
  let failed = 0;
  let rateLimited = false;
  for (const key of keys.slice(0, max)) {
    try {
      const n = await syncPhone(key);
      synced += 1;
      if (log && synced % 50 === 0) console.log(`[wati sync] ${synced}/${Math.min(keys.length, max)} (last: ${n} items)`);
    } catch (err) {
      if (isRateLimit(err)) {
        rateLimited = true;
        console.warn('[wati sync] rate limited, stopping this run');
        break;
      }
      failed += 1;
      await WatiChat.updateOne(
        { phoneKey: key },
        { $set: { fetchedAt: new Date(), error: String(err.message).slice(0, 200) } },
        { upsert: true }
      ).catch(() => {});
    }
    await sleep(DELAY_MS);
  }
  return { synced, failed, rateLimited };
}

/** The keys due a refresh, stalest first. */
async function dueKeys(now = Date.now()) {
  const contacts = await Contact.find(
    { createdTime: { $gte: new Date(now - 14 * DAY) } },
    { phoneKeys: 1, createdTime: 1 }
  ).lean();
  const keys = [...new Set(contacts.flatMap(usableKeys))];
  const createdByKey = new Map();
  for (const c of contacts) for (const k of usableKeys(c)) createdByKey.set(k, new Date(c.createdTime).getTime());

  const chats = await WatiChat.find({ phoneKey: { $in: keys } }, { phoneKey: 1, fetchedAt: 1 }).lean();
  const fetched = new Map(chats.map((c) => [c.phoneKey, c.fetchedAt ? new Date(c.fetchedAt).getTime() : 0]));
  const everyMin = Number(process.env.WATI_SYNC_MIN || 30);

  return keys
    .filter((k) => {
      const last = fetched.get(k) || 0;
      const age = now - (createdByKey.get(k) || 0);
      const maxStale = age < 2 * DAY ? everyMin * 60 * 1000 : 6 * HOUR;
      return now - last >= maxStale;
    })
    .sort((a, b) => (fetched.get(a) || 0) - (fetched.get(b) || 0));
}

let running = false;

/** The scheduler job. */
async function syncRecent() {
  if (!wati.isConfigured() || running) return null;
  running = true;
  try {
    const keys = await dueKeys();
    if (!keys.length) return { synced: 0, failed: 0, rateLimited: false };
    const result = await syncKeys(keys);
    console.log(`[wati sync] ${result.synced} chats synced, ${result.failed} failed, ${keys.length} were due`);
    return result;
  } catch (err) {
    console.warn('[wati sync] failed:', err.message);
    return null;
  } finally {
    running = false;
  }
}

/** Every contact created in the last `days` whose chat we don't have (or all, with force). */
async function backfill({ days = 120, force = false, max = Infinity } = {}) {
  const contacts = await Contact.find(
    { createdTime: { $gte: new Date(Date.now() - days * DAY) } },
    { phoneKeys: 1 }
  ).lean();
  let keys = [...new Set(contacts.flatMap(usableKeys))];
  if (!force) {
    const have = new Set(
      (await WatiChat.find({ phoneKey: { $in: keys }, error: null }, { phoneKey: 1 }).lean()).map((c) => c.phoneKey)
    );
    keys = keys.filter((k) => !have.has(k));
  }
  console.log(`[wati backfill] ${keys.length} chats to fetch`);
  return syncKeys(keys, { max, log: true });
}

module.exports = { syncPhone, syncRecent, backfill, dueKeys };
