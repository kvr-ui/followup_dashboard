// Zoho CRM write-back client.
// Requires OAuth credentials in the environment to actually reach Zoho:
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
//   ZOHO_ACCOUNTS_URL (e.g. https://accounts.zoho.in)   — data-centre specific
//   ZOHO_API_URL      (e.g. https://www.zohoapis.in)    — data-centre specific
//   ZOHO_MODULE       (defaults to "Tasks")
// If unconfigured, every call resolves to { ok: false, skipped: true } so the
// dashboard keeps working with local-only updates.

const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_REGION = 'com',
  ZOHO_PRODUCT = 'crm', // 'crm' or 'bigin'
  ZOHO_MODULE = 'Tasks',
} = process.env;

// Bigin and CRM expose the same-shaped record API under different base paths.
const API_BASE =
  String(ZOHO_PRODUCT).toLowerCase() === 'bigin' ? '/bigin/v1' : '/crm/v2';

// Map a Zoho data-centre region to its accounts + API hosts.
// Explicit ZOHO_ACCOUNTS_URL / ZOHO_API_URL override the region if set.
const REGION_DOMAINS = {
  com: { accounts: 'accounts.zoho.com', api: 'www.zohoapis.com' },
  in: { accounts: 'accounts.zoho.in', api: 'www.zohoapis.in' },
  eu: { accounts: 'accounts.zoho.eu', api: 'www.zohoapis.eu' },
  au: { accounts: 'accounts.zoho.com.au', api: 'www.zohoapis.com.au' },
  jp: { accounts: 'accounts.zoho.jp', api: 'www.zohoapis.jp' },
  ca: { accounts: 'accounts.zohocloud.ca', api: 'www.zohoapis.ca' },
};

const region = REGION_DOMAINS[String(ZOHO_REGION).toLowerCase()] || REGION_DOMAINS.com;
const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || `https://${region.accounts}`;
const ZOHO_API_URL = process.env.ZOHO_API_URL || `https://${region.api}`;

function isConfigured() {
  return Boolean(ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET && ZOHO_REFRESH_TOKEN);
}

// Cache the access token in memory until shortly before it expires.
// A single in-flight refresh is shared by concurrent callers so we never
// hammer Zoho's OAuth endpoint (which triggers "Access Denied" rate blocks).
let cachedToken = null;
let tokenExpiresAt = 0;
let refreshInFlight = null;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const params = new URLSearchParams({
      refresh_token: ZOHO_REFRESH_TOKEN,
      client_id: ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token',
    });

    const res = await fetch(`${ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('Zoho auth blocked (non-JSON response — likely rate-limited)');
    }
    if (!json.access_token) {
      throw new Error(json.error || 'Failed to obtain Zoho access token');
    }

    cachedToken = json.access_token;
    // Zoho tokens last ~1h; refresh a minute early.
    tokenExpiresAt = Date.now() + ((json.expires_in || 3600) - 60) * 1000;
    return cachedToken;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

// Throttle ALL Zoho calls through a single serial queue with minimum spacing,
// so bursts of webhooks never hammer Zoho (which triggers "Access Denied").
const MIN_SPACING_MS = 350;
let zohoQueue = Promise.resolve();
let lastCallAt = 0;

function reserveSlot() {
  zohoQueue = zohoQueue.then(async () => {
    const wait = MIN_SPACING_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  return zohoQueue;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function zohoFetch(path, options = {}, attempt = 0) {
  await reserveSlot();

  const token = await getAccessToken();
  const res = await fetch(`${ZOHO_API_URL}${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON = Zoho's HTML "Access Denied"/rate-limit page. Back off and retry.
    if (attempt < 3) {
      await sleep(1500 * (attempt + 1));
      return zohoFetch(path, options, attempt + 1);
    }
    throw new Error(`Zoho unavailable (${res.status}) — rate-limited. Try again shortly.`);
  }

  if (!res.ok) {
    const throttled = res.status === 429 || json.code === 'TOO_MANY_REQUESTS';
    if (throttled && attempt < 3) {
      await sleep(1500 * (attempt + 1));
      return zohoFetch(path, options, attempt + 1);
    }
    throw new Error(json.message || `Zoho API error (${res.status})`);
  }
  return json;
}

async function updateTaskStatus(zohoId, status) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    await zohoFetch(`/${ZOHO_MODULE}`, {
      method: 'PUT',
      body: JSON.stringify({ data: [{ id: zohoId, Status: status }] }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Fetch a full task record (used to backfill fields the webhook omits, e.g. Subject).
async function getTaskRecord(id) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const json = await zohoFetch(`/${ZOHO_MODULE}/${id}`);
    const rec = json?.data?.[0];
    if (!rec) return { ok: false, error: 'Task not found' };
    return { ok: true, record: rec };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Look up a contact (Bigin Who_Id) to get its phone/email.
async function getContact(id) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const json = await zohoFetch(`/Contacts/${id}`);
    const rec = json?.data?.[0];
    if (!rec) return { ok: false, error: 'Contact not found' };
    return {
      ok: true,
      name: rec.Full_Name || null,
      phone: rec.Phone || rec.Mobile || null,
      email: rec.Email || rec.Secondary_Email || null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function addNote(zohoId, title, content) {
  if (!isConfigured()) return { ok: false, skipped: true };
  try {
    const json = await zohoFetch(`/${ZOHO_MODULE}/${zohoId}/Notes`, {
      method: 'POST',
      body: JSON.stringify({
        data: [{ Note_Title: title || 'Note', Note_Content: content }],
      }),
    });
    const noteId = json?.data?.[0]?.details?.id || null;
    return { ok: true, noteId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isConfigured,
  updateTaskStatus,
  addNote,
  getContact,
  getTaskRecord,
};
