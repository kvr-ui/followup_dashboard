// One TTL + stale-while-revalidate cache, shared by every slow read in the app.
//
// Atlas M0 takes seconds to return a full collection, and the dashboard polls
// every 15s, so the task list, the leads list, the funnel, analytics and the two
// VSL indexes are all held in memory and refreshed behind the request. Each of
// them used to carry its own copy of this logic, and only one of the copies had
// the generation guard — so a write that landed while a slow read was in flight
// could be hidden by that read's stale result for a whole TTL. Now every cache
// gets the guard.
//
//   const cache = createSwrCache({ name: 'tasks', ttlMs: 30000, load: loadTaskList });
//   await cache.get()      // fresh -> value; stale -> old value now, refresh behind;
//                          // cold  -> waits for the first load (rejects if it fails)
//   cache.peek()           // never awaits, never throws: the value we have, or null
//   cache.invalidate()     // after a write: the next read reloads and sees it
//   await cache.refresh()  // force a load now (one in flight at a time, shared)
//
// `load(prev)` receives the previous value so an incremental loader can fold
// new rows into what it already holds (the VSL watch index does this).

function createSwrCache({ name, ttlMs, load }) {
  let value = null;
  let at = 0; // when `value` was last marked fresh; 0 = stale
  let gen = 0; // bumped by invalidate(); a load that started before a bump stays stale
  let inflight = null;
  let lastError = null;
  let loadMs = 0;

  const fresh = () => value != null && Date.now() - at < ttlMs;

  function refresh() {
    if (inflight) return inflight;
    const startGen = gen;
    const t0 = Date.now();
    inflight = Promise.resolve()
      .then(() => load(value))
      .then((next) => {
        value = next;
        // Only mark fresh if no write invalidated us mid-load; otherwise leave it
        // stale so the very next read refreshes again, this time seeing the write.
        at = gen === startGen ? Date.now() : 0;
        loadMs = Date.now() - t0;
        lastError = null;
        return next;
      })
      .catch((err) => {
        lastError = err && err.message ? err.message : String(err);
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function get() {
    if (fresh()) return value;
    const pending = refresh();
    if (value != null) {
      // Stale-while-revalidate: hand back the old copy instantly. The refresh
      // reports its failure through stats(); nobody is waiting on it here.
      pending.catch(() => {});
      return value;
    }
    return pending;
  }

  function peek() {
    if (!fresh()) refresh().catch(() => {});
    return value;
  }

  function invalidate() {
    at = 0;
    gen += 1;
  }

  function stats() {
    return { name, at, stale: !fresh(), refreshing: Boolean(inflight), error: lastError, loadMs };
  }

  return { get, peek, refresh, invalidate, stats };
}

module.exports = { createSwrCache };
