// Background job for the ads module: keep the Meta mirror fresh.
//
// One job, one knob. SYNC_INTERVAL_MINUTES set and positive => a full sync on that
// cadence (1440 = daily, which is what ad reporting actually needs — Meta's own
// numbers move for a day or two after the fact). Unset or zero => nothing starts,
// and a sync can still be triggered by hand from the admin API.
//
// Unlike the call jobs there is no webhook fast path here: Meta has no push for
// insights, so this poll IS the data path.
const { syncAll } = require('./syncAll');
const meta = require('./metaClient');

const SYNC_INTERVAL_MIN = Number(process.env.SYNC_INTERVAL_MINUTES || 0);

// The retired CRM waited a full interval before its first run. With a daily
// interval that leaves a fresh deploy showing up to a day-old numbers, so run once
// shortly after boot instead — late enough that startup isn't competing with a
// long Meta pull, and after the call jobs' 20/60/90s stagger.
const FIRST_RUN_DELAY_MS = Number(process.env.AD_SYNC_FIRST_RUN_DELAY_MS || 120 * 1000);

let running = false;

/**
 * Run a full sync, swallowing failures. Every failure is already logged and
 * written to an AdSyncRun row by runTracked; re-throwing here would take an
 * unhandled rejection out of a timer callback and kill the process.
 */
async function runSync() {
  if (running) return;
  running = true;
  try {
    const result = await syncAll();
    console.log('[ads sync] complete:', result);
  } catch (err) {
    console.warn('[ads sync] failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (!SYNC_INTERVAL_MIN || SYNC_INTERVAL_MIN <= 0) {
    console.log('Ad sync disabled (set SYNC_INTERVAL_MINUTES to enable).');
    return;
  }
  if (!meta.isConfigured()) {
    console.log('Ad sync disabled (META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not set).');
    return;
  }

  console.log(`Ad sync: every ${SYNC_INTERVAL_MIN}m (first run in ${FIRST_RUN_DELAY_MS / 1000}s)`);

  setTimeout(runSync, FIRST_RUN_DELAY_MS);
  setInterval(runSync, SYNC_INTERVAL_MIN * 60 * 1000);
}

module.exports = { start, runSync };
