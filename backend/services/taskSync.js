// Reconcile poll for Bigin TASKS — the safety net the v1 task webhook never had.
//
// `POST /webhook` was the only way a task ever reached us. When it fails (a dead
// tunnel, a Zoho Flow outage, us being down), that task is gone: nothing else
// ever looks for it. Calls and deals at least had a poll. Tasks did not.
//
// This closes that hole. Same shape as the call/deal reconcilers.
const zoho = require('./zoho');
const Task = require('../models/Task');
const { upsertTask } = require('./taskStore');
const { sinceFor, commit, fmtWindow } = require('./lookback');

const TASK_POLL_MIN = Number(process.env.TASK_POLL_MINUTES || 15);

let running = false;

/** Pull tasks modified since a given time, newest first, stopping once we pass it. */
async function fetchTasksModifiedSince(since) {
  const tasks = [];
  let page = 1;

  for (;;) {
    const r = await zoho.apiGet(
      `/Tasks?per_page=200&page=${page}&sort_by=Modified_Time&sort_order=desc`
    );
    if (!r.ok) throw new Error(r.error || 'Failed to fetch tasks');
    const rows = (r.json && r.json.data) || [];
    if (!rows.length) break;

    let reachedOlder = false;
    for (const t of rows) {
      const mt = new Date(t.Modified_Time || t.Created_Time).getTime();
      if (mt < since) {
        reachedOlder = true;
        break;
      }
      tasks.push(t);
    }
    if (reachedOlder || !r.json.info || !r.json.info.more_records) break;
    page += 1;
  }
  return tasks;
}

/**
 * First run only: we have no cursor, so open the window at the newest task we
 * already hold — which is where the webhooks stopped delivering.
 *
 * Use Bigin's OWN Modified_Time, not `receivedAt`/`updatedAt`. Ours get bumped
 * every time we merge or a user edits a lead, so they drift to "now" and would
 * seed the window shut, skipping exactly the tasks we're trying to recover.
 * Bigin's timestamp is the only one we never write.
 */
async function seedFromNewestTask() {
  const pick = async (field) => {
    const doc = await Task.findOne({ [field]: { $exists: true, $ne: null } }, { [field]: 1 })
      .sort({ [field]: -1 })
      .lean();
    const raw = doc && doc.body && (doc.body.Modified_Time || doc.body.Created_Time);
    const ms = raw ? new Date(raw).getTime() : NaN;
    return isNaN(ms) ? null : ms;
  };

  // Not every payload carries Modified_Time (1,244 of 1,434 do); Created_Time
  // is near-universal, so fall back to it.
  return (await pick('body.Modified_Time')) ?? (await pick('body.Created_Time'));
}

async function reconcileTasks() {
  if (running || !zoho.isConfigured()) return;
  running = true;

  // Stamped before the fetch: anything modified mid-poll must survive to the next.
  const startedAt = new Date();

  try {
    const since = await sinceFor('tasks', seedFromNewestTask);
    console.log(`[reconcile tasks] window ${fmtWindow(since)}`);

    const rows = await fetchTasksModifiedSince(since);

    let ingested = 0;
    for (const row of rows) {
      // enrich: the payload carries a contact id but not always a phone, and the
      // phone is what matches a lead to its calls. Throttled + cached in zoho.js.
      const doc = await upsertTask(row, { enrich: true });
      if (doc) ingested += 1;
    }

    // Only now is the window truly closed.
    await commit('tasks', startedAt);

    if (rows.length) console.log(`[reconcile] ${ingested} task(s) synced from Bigin`);
  } catch (err) {
    // No commit — the cursor stays put, so the next poll retries this same window.
    console.warn('[reconcile tasks] failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (process.env.TASK_JOBS_ENABLED === 'false') {
    console.log('Task reconcile disabled (TASK_JOBS_ENABLED=false)');
    return;
  }
  console.log(`Task jobs: tasks/${TASK_POLL_MIN}m`);

  setTimeout(reconcileTasks, 40 * 1000); // staggered against the call/deal polls
  setInterval(reconcileTasks, TASK_POLL_MIN * 60 * 1000);
}

module.exports = { start, reconcileTasks, fetchTasksModifiedSince };
