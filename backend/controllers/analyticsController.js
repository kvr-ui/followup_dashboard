const Task = require('../models/Task');
const User = require('../models/User');

function isCompleted(t) {
  return (t.Status || '').toLowerCase() === 'completed';
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function dueBucket(t) {
  if (isCompleted(t)) return 'completed';
  if (!t.Due_Date) return 'nodate';
  const raw = t.Due_Date.length === 10 ? `${t.Due_Date}T00:00:00` : t.Due_Date;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return 'nodate';
  const diff = Math.round((d - startOfToday()) / 86400000);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  return 'upcoming';
}

// Atlas M0 throttles to ~20ms/doc, so scanning every lead takes ~25s.
// Analytics changes slowly — cache the computed result.
const ANALYTICS_TTL_MS = Number(process.env.ANALYTICS_CACHE_TTL_MS || 60000);
let cached = null;
let cachedAt = 0;
let building = null;

/**
 * Per-salesperson performance, aggregated from all tasks.
 * Admin-only (enforced by the route).
 */
async function getAnalytics(req, res) {
  try {
    if (cached && Date.now() - cachedAt < ANALYTICS_TTL_MS) {
      return res.json(cached);
    }
    if (building) {
      // Another request is already computing it — serve stale rather than queue.
      if (cached) return res.json(cached);
      return res.json(await building);
    }

    building = buildAnalytics()
      .then((payload) => {
        cached = payload;
        cachedAt = Date.now();
        return payload;
      })
      .finally(() => {
        building = null;
      });

    return res.json(await building);
  } catch (err) {
    console.error('Analytics failed:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to build analytics' });
  }
}

async function buildAnalytics() {
  {
    // Only pull the fields we actually aggregate on.
    const [docs, users] = await Promise.all([
      Task.find(
        {},
        { 'body.Status': 1, 'body.Priority': 1, 'body.Due_Date': 1, 'body.Owner': 1, notes: 1, statusHistory: 1 }
      ).lean(),
      User.find().lean(),
    ]);

    const byEmail = new Map();
    const ensure = (email, name) => {
      const key = (email || '').toLowerCase();
      if (!byEmail.has(key)) {
        byEmail.set(key, {
          email: key,
          name: name || null,
          total: 0,
          completed: 0,
          inProgress: 0,
          notStarted: 0,
          overdue: 0,
          dueToday: 0,
          notes: 0,
          actions: 0,
        });
      }
      const e = byEmail.get(key);
      if (!e.name && name) e.name = name;
      return e;
    };

    // username -> that user's owner email (to attribute notes/actions).
    const emailOfUsername = new Map();
    users.forEach((u) => {
      if (u.username) emailOfUsername.set(u.username, (u.ownerEmail || '').toLowerCase());
    });

    for (const doc of docs) {
      const bodies = Array.isArray(doc.body) ? doc.body : [doc.body];
      for (const t of bodies) {
        if (!t || typeof t !== 'object') continue;
        const owner = t.Owner || {};
        const e = ensure(owner.email, owner.name);
        e.total += 1;

        const st = (t.Status || '').toLowerCase();
        if (st === 'completed') e.completed += 1;
        else if (st === 'in progress') e.inProgress += 1;
        else if (st === 'not started') e.notStarted += 1;

        const bucket = dueBucket(t);
        if (bucket === 'overdue') e.overdue += 1;
        if (bucket === 'today') e.dueToday += 1;
      }

      (doc.notes || []).forEach((n) => {
        const email = emailOfUsername.get(n.author);
        if (email) ensure(email).notes += 1;
      });

      (doc.statusHistory || []).forEach((h) => {
        if (h.source === 'dashboard' && h.by) {
          const email = emailOfUsername.get(h.by);
          if (email) ensure(email).actions += 1;
        }
      });
    }

    // Include registered sales users even if they have zero tasks.
    users
      .filter((u) => u.role === 'sales' && u.ownerEmail)
      .forEach((u) => ensure(u.ownerEmail, u.name));

    const userByEmail = new Map();
    users.forEach((u) => {
      if (u.ownerEmail) userByEmail.set(u.ownerEmail.toLowerCase(), u);
    });

    const rows = [...byEmail.values()]
      .filter((e) => e.email) // drop tasks with no owner email
      .map((e) => {
        const u = userByEmail.get(e.email);
        return {
          ...e,
          username: u ? u.username : null,
          registered: Boolean(u),
          completionRate: e.total ? Math.round((e.completed / e.total) * 100) : 0,
        };
      })
      .sort((a, b) => b.total - a.total);

    const totals = rows.reduce(
      (acc, r) => {
        acc.total += r.total;
        acc.completed += r.completed;
        acc.overdue += r.overdue;
        acc.inProgress += r.inProgress;
        return acc;
      },
      { total: 0, completed: 0, overdue: 0, inProgress: 0 }
    );
    totals.salespeople = rows.length;
    totals.completionRate = totals.total
      ? Math.round((totals.completed / totals.total) * 100)
      : 0;

    return { success: true, totals, users: rows };
  }
}

module.exports = { getAnalytics };
