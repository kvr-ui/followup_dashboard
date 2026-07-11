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

function isConfigured() {
  return Boolean(APPID && SECRET);
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

/** Download a recording as a Buffer (server-side only). */
async function downloadRecording(filename) {
  if (!filename) throw new Error('No recording filename');
  await slot();
  const res = await fetch(recordingUrl(filename));
  if (!res.ok) throw new Error(`Recording download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buffer: buf, contentType: res.headers.get('content-type') || 'audio/mpeg' };
}

module.exports = {
  isConfigured,
  fetchCdrPage,
  forEachCall,
  downloadRecording,
  recordingUrl,
  PAGE_SIZE,
};
