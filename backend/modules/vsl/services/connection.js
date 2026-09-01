// The second Mongo connection: the VSL landing page's own Atlas cluster.
//
// WHY A SECOND CONNECTION AND NOT AN API CALL
// -------------------------------------------
// The VSL page (a separate Next.js project) writes `vsl_leads` / `vsl_events`
// into a DIFFERENT Atlas cluster from this dashboard. That project is not ours to
// change, so we read its collections directly rather than asking it to grow an
// endpoint for us. We are a guest in that database: this module NEVER writes,
// never creates a collection, and never touches an index.
//
// DEGRADATION IS THE WHOLE CONTRACT
// ---------------------------------
// `isConfigured()` is asked first by every entry point in this module, exactly as
// services/wati.js and services/zoho.js do. With VSL_MONGO_URI unset there is no
// connection, no query and no error: the tab explains itself, the drawer section
// is absent, the follow-ups column renders a dash. Watch time is worth less than
// the dashboard it hangs off.
//
// LAZY, AND DELIBERATELY OUTSIDE THE BOOT CHAIN
// ---------------------------------------------
// server.js chains connectDB().then(...).catch(() => process.exit(1)), so
// anything added to that chain that can reject IS a failed boot. This connection
// is therefore created on first use and never awaited at startup. Mongoose
// buffers operations on a still-connecting connection, so the first query after a
// cold start simply waits.

const mongoose = require('mongoose');

const URI = process.env.VSL_MONGO_URI || '';
const DB_NAME = process.env.VSL_MONGO_DB || 'focas';

/** The one question every entry point in this module asks first. */
function isConfigured() {
  return Boolean(URI);
}

let conn = null;

/**
 * The shared connection, or null when unconfigured.
 * Synchronous by design — callers must be able to bail out without awaiting.
 */
function getConnection() {
  if (!isConfigured()) return null;
  if (conn) return conn;

  // maxPoolSize is small on purpose: this is a secondary, read-only,
  // cache-fronted connection and it must not compete with the primary pool that
  // every dashboard request depends on.
  //
  // serverSelectionTimeoutMS is deliberately FAR below the driver's 30s default.
  // This cluster is optional; a query against it that cannot find a server should
  // fail in seconds, not hold a request open while the driver keeps hoping. With
  // the default, an unreachable VSL cluster made every lead drawer take 10s to
  // render — the panel degraded correctly, but only after the rep had waited.
  conn = mongoose.createConnection(URI, {
    dbName: DB_NAME,
    maxPoolSize: 5,
    serverSelectionTimeoutMS: Number(process.env.VSL_SERVER_TIMEOUT_MS || 3000),
    // Mongoose queues a query issued before the connection is up and, by
    // default, holds it for 10s — which is what actually kept the lead drawer
    // waiting, not server selection. Buffering still has to exist (the very
    // first query legitimately races the lazy connect), but it gets the same
    // few-second budget as everything else here.
    bufferTimeoutMS: Number(process.env.VSL_BUFFER_TIMEOUT_MS || 3000),
  });

  conn.on('connected', () => {
    // Name the database, like config/db.js does, so a misconfigured URI is
    // visible in the log rather than silently reading the wrong cluster.
    console.log(`[vsl] MongoDB connected: ${conn.name} @ ${conn.host}`);
  });
  // Warn, never throw: an unreachable VSL cluster must cost the feature, not the
  // process. Without this handler a connection error would be an unhandled
  // 'error' event on the EventEmitter and would take the server down.
  conn.on('error', (err) => console.warn('[vsl] MongoDB connection error:', err.message));

  return conn;
}

module.exports = { isConfigured, getConnection, DB_NAME };
