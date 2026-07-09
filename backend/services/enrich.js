const zoho = require('../services/zoho');

// Cache contact lookups by id so re-processing many tasks (import/backfill)
// doesn't refetch the same contact repeatedly.
const contactCache = new Map();

async function lookupContact(id) {
  if (contactCache.has(id)) return contactCache.get(id);
  const c = await zoho.getContact(id);
  contactCache.set(id, c);
  return c;
}

// The webhook sends the contact as Who_Id; the Bigin API sends it as
// Related_To ($related_module = "Contacts"). Normalise both into Who_Id.
function normalizeContact(task) {
  if (!task) return false;
  if (task.Who_Id && task.Who_Id.id) return false;

  const rel = task.Related_To;
  const mod = task.$related_module;
  if (rel && rel.id && (!mod || mod === 'Contacts')) {
    task.Who_Id = { id: rel.id, name: rel.name || null };
    return true;
  }
  return false;
}

// Ensure Who_Id is set (from Related_To) and enriched with phone/email.
// Returns true if the task object was modified.
async function enrichContact(task) {
  let changed = normalizeContact(task);

  if (task && task.Who_Id && task.Who_Id.id && !task.Who_Id.phone && !task.Who_Id.email) {
    const c = await lookupContact(task.Who_Id.id);
    if (c.ok) {
      task.Who_Id = {
        ...task.Who_Id,
        name: task.Who_Id.name || c.name,
        phone: c.phone,
        email: c.email,
      };
      changed = true;
    }
  }
  return changed;
}

// Fill in the task's Subject (name) — and Description — from Bigin if the
// webhook didn't send them. No-op once Subject is present.
async function enrichTaskFields(task) {
  if (!task || !task.id) return false;
  if (task.Subject) return false;

  const r = await zoho.getTaskRecord(task.id);
  if (!r.ok) return false;

  task.Subject = r.record.Subject || null;
  if (!task.Description && r.record.Description) {
    task.Description = r.record.Description;
  }
  return true;
}

// Enrich every task inside a stored document body (single object or array).
async function enrichBody(body) {
  const tasks = Array.isArray(body) ? body : [body];
  let changed = false;
  for (const t of tasks) {
    const a = await enrichContact(t);
    const b = await enrichTaskFields(t);
    if (a || b) changed = true;
  }
  return changed;
}

module.exports = { enrichContact, enrichTaskFields, enrichBody, normalizeContact };
