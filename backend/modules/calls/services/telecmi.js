// TeleCMI client — fetch call detail records (CDR) and download recordings.
//
// Verified API shape:
//   POST https://rest.telecmi.com/v2/answered
//     body: { appid, secret, start_date, end_date, page, limit }   (dates = epoch ms)
//     -> { count: <total>, cdr: [ { cmiuid, duration, agent, billedsec,
//                                   filename, record, name, from, to, time } ] }
//   Page size is FIXED at 10 (the `limit` param is ignored).
//
//   GET https://rest.telecmi.com/v2/play?appid=&secret=&file=<filename>  -> audio/mpeg

const APPID = Number(process.env.TELECMI_APP_ID);
const SECRET = process.env.TELECMI_SECRET;
const BASE = process.env.TELECMI_BASE_URL || 'https://rest.telecmi.com/v2';

const PAGE_SIZE = 10; // enforced by TeleCMI

// Outbound calls are invisible to /v2/answered — that feed carries inbound DID traffic
// only, and its direction filters are silently ignored. They live behind a PER-USER API
// (/v2/user/out_cdr) authenticated with a login token rather than appid/secret, so we log
// in as each agent. The CDR rows come back in the same shape, `filename` included, which
// is why the recordings still download through /v2/play with the app credentials below.
const USER_PASSWORD = process.env.TELECMI_USER_PASSWORD || process.env.PASSWORD;

// Tokens last 30 days; refresh well before that and re-login on demand if one is rejected.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const tokenCache = new Map(); // ext -> { token, expiresAt }

function isConfigured() {
  return Boolean(APPID && SECRET);
}

/** Are per-agent outbound pulls configured? */
function canReadOutgoing() {
  return Boolean(APPID && USER_PASSWORD);
}

/** The agent extensions we hold credentials for (from TELECMI_AGENTS). */
function agentExtensions() {
  return String(process.env.TELECMI_AGENTS || '')
    .split(',')
    .map((p) => p.split('=')[0].trim())
    .filter(Boolean);
}

/**
 * Log in as one agent and cache the token.
 * `force` bypasses the cache — used when a token is rejected mid-poll.
 */
async function userToken(ext, { force = false } = {}) {
  const hit = tokenCache.get(ext);
  if (!force && hit && Date.now() < hit.expiresAt) return hit.token;

  await slot();
  const res = await fetch(`${BASE}/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: `${ext}_${APPID}`, password: USER_PASSWORD }),
  });

  const json = await res.json().catch(() => null);
  if (!json || !json.token) {
    throw new Error(`TeleCMI login failed for ${ext}: ${(json && json.msg) || res.status}`);
  }

  tokenCache.set(ext, { token: json.token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return json.token;
}

/**
 * Iterate one agent's OUTGOING calls.
 * @param type 1 = answered (has a recording), 0 = missed (no recording, but it is still
 *             a dial the rep made and belongs on their activity count).
 */
async function forEachOutgoingCall({ ext, from, to, type = 1, onRecord }) {
  let page = 1;
  let seen = 0;
  let total = null;
  let retriedAuth = false;

  for (;;) {
    let token = await userToken(ext);
    await slot();

    let res = await fetch(`${BASE}/user/out_cdr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, token, from, to, page, limit: PAGE_SIZE }),
    });
    let json = await res.json().catch(() => null);

    // A 30-day-old token dies mid-poll; re-login once rather than losing the window.
    if ((!json || json.code === 401 || json.code === 404) && !retriedAuth) {
      retriedAuth = true;
      token = await userToken(ext, { force: true });
      res = await fetch(`${BASE}/user/out_cdr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, token, from, to, page, limit: PAGE_SIZE }),
      });
      json = await res.json().catch(() => null);
    }

    if (!json) throw new Error(`TeleCMI out_cdr returned a non-JSON response (${res.status})`);
    if (json.error) throw new Error(json.msg ? JSON.stringify(json.msg) : 'TeleCMI out_cdr error');

    const rows = json.cdr || [];
    if (total === null) total = json.count || 0;
    if (!rows.length) break;

    for (const row of rows) {
      await onRecord({
        ...row,
        // out_cdr omits two fields that /v2/answered provides and toCallDoc relies on:
        //   `agent`  — the caller IS the agent we logged in as, so name it here.
        //   `record` — absent entirely; a filename is what actually means "recorded",
        //              and without this every outbound call would look unrecorded.
        agent: `${ext}_${APPID}`,
        record: row.filename ? 'true' : 'false',
        _direction: 'outbound',
      });
    }

    seen += rows.length;
    if (rows.length < PAGE_SIZE || seen >= total) break;
    page += 1;
  }

  return { total, seen };
}

// Throttle outbound calls so a backfill never hammers TeleCMI.
const MIN_SPACING_MS = 200;
let queue = Promise.resolve();
let lastAt = 0;
function slot() {
  queue = queue.then(async () => {
    const wait = MIN_SPACING_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  });
  return queue;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one page of CDR records.
 * @param {'answered'|'missed'} type
 * @returns {{count:number, rows:Array}}
 */
async function fetchCdrPage({ page = 1, from, to, type = 'answered' }, attempt = 0) {
  if (!isConfigured()) throw new Error('TeleCMI is not configured');
  await slot();

  const res = await fetch(`${BASE}/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appid: APPID,
      secret: SECRET,
      start_date: from,
      end_date: to,
      page,
      limit: PAGE_SIZE,
    }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    if (attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return fetchCdrPage({ page, from, to, type }, attempt + 1);
    }
    throw new Error(`TeleCMI returned a non-JSON response (${res.status})`);
  }

  if (!res.ok || json.error) {
    throw new Error(json.msg ? JSON.stringify(json.msg) : `TeleCMI error ${res.status}`);
  }
  return { count: json.count || 0, rows: json.cdr || [] };
}

/**
 * Iterate every CDR record in a date range (handles pagination).
 * Calls onRecord(row) for each.
 */
async function forEachCall({ from, to, type = 'answered', onRecord, onPage }) {
  let page = 1;
  let seen = 0;
  let total = null;

  for (;;) {
    const { count, rows } = await fetchCdrPage({ page, from, to, type });
    if (total === null) total = count;
    if (!rows.length) break;

    for (const row of rows) await onRecord(row);
    seen += rows.length;
    if (onPage) onPage({ page, seen, total });

    if (rows.length < PAGE_SIZE || seen >= total) break;
    page += 1;
  }
  return { total, seen };
}

// The playback URL contains our secret — NEVER send this to a browser.
// Use downloadRecording() and stream it through our own authenticated route.
function recordingUrl(filename) {
  return `${BASE}/play?appid=${APPID}&secret=${SECRET}&file=${encodeURIComponent(filename)}`;
}

/**
 * Download a recording as a Buffer (server-side only).
 *
 * /v2/play does NOT use the status code to say "no audio here". When the recording is
 * missing or not published yet it answers 200 with a JSON body:
 *
 *   {"code":502,"msg":"Internal Server Error"}      (42 bytes, content-type: application/json)
 *
 * Checking only res.ok therefore handed 42 bytes of JSON to the transcriber, which
 * reasonably replied "File is corrupted" — and since that reads as a bad recording, the
 * call burned its whole retry budget in minutes and was marked `failed` forever. Audio
 * that TeleCMI simply had not finished publishing was thrown away permanently.
 *
 * So detect it here and flag it `isNotReady`: the same call usually downloads fine later.
 */
async function downloadRecording(filename) {
  if (!filename) throw new Error('No recording filename');
  await slot();
  const res = await fetch(recordingUrl(filename));
  if (!res.ok) throw new Error(`Recording download failed (${res.status})`);

  const contentType = res.headers.get('content-type') || 'audio/mpeg';
  const buf = Buffer.from(await res.arrayBuffer());

  if (/json|text/i.test(contentType) || (buf.length < 1024 && buf[0] === 0x7b /* '{' */)) {
    let detail = buf.toString('utf8').slice(0, 120);
    try {
      const j = JSON.parse(detail);
      detail = `${j.code || '?'} ${j.msg || ''}`.trim();
    } catch {
      /* keep the raw snippet */
    }
    const err = new Error(`Recording not available from TeleCMI yet (${detail})`);
    err.isNotReady = true;
    throw err;
  }

  return { buffer: buf, contentType };
}

module.exports = {
  isConfigured,
  canReadOutgoing,
  agentExtensions,
  userToken,
  fetchCdrPage,
  forEachCall,
  forEachOutgoingCall,
  downloadRecording,
  recordingUrl,
  PAGE_SIZE,
};
