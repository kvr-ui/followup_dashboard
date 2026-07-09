export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

export function priorityClass(priority) {
  const p = (priority || '').toLowerCase();
  if (p === 'high') return 'badge badge-high';
  if (p === 'low') return 'badge badge-low';
  return 'badge badge-normal';
}

export function statusClass(status) {
  const s = (status || '').toLowerCase().replace(/\s+/g, '-');
  return `badge status-${s || 'unknown'}`;
}

// A single stored record may hold one task or an array of tasks.
export function extractTasks(record) {
  const body = record.body;
  const tasks = Array.isArray(body) ? body : [body];
  return tasks
    .filter((t) => t && typeof t === 'object')
    .map((task, i) => ({
      key: `${record.id}-${i}`,
      recordId: record.id,
      task,
      receivedAt: record.receivedAt,
    }));
}

// Contact phone/email may live under several possible Zoho field names.
// Returns whatever is present, or null.
export function getContact(task) {
  if (!task) return { phone: null, email: null };
  const who = task.Who_Id || {};
  const phone =
    task.Phone ||
    task.Mobile ||
    task.Contact_Number ||
    task.Phone_Number ||
    who.phone ||
    who.Phone ||
    null;
  const email =
    task.Email || task.Contact_Email || task.Secondary_Email || who.email || null;
  return { phone, email };
}
