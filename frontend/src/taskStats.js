// Pure helpers for summarising, filtering and sorting the flattened task list.
// Each "item" is { key, task, receivedAt } as produced by extractTasks().

export function parseDueDate(value) {
  if (!value) return null;
  // Due_Date arrives as "2026-07-10" (date only) — pin to local midnight.
  const withTime = value.length === 10 ? `${value}T00:00:00` : value;
  const d = new Date(withTime);
  return isNaN(d.getTime()) ? null : d;
}

export function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function isCompleted(task) {
  return (task.Status || '').toLowerCase() === 'completed';
}

// Bucket a task by its due date: overdue | today | upcoming | completed | no-date
export function classifyDue(task) {
  const completed = isCompleted(task);
  const due = parseDueDate(task.Due_Date);

  if (completed) return { due, completed, diffDays: null, bucket: 'completed' };
  if (!due) return { due: null, completed, diffDays: null, bucket: 'no-date' };

  const diffDays = Math.round((due - startOfToday()) / 86400000);
  let bucket;
  if (diffDays < 0) bucket = 'overdue';
  else if (diffDays === 0) bucket = 'today';
  else bucket = 'upcoming';

  return { due, completed, diffDays, bucket };
}

export function computeSummary(items) {
  const s = {
    total: items.length,
    overdue: 0,
    today: 0,
    week: 0,
    status: {},
    priority: {},
    byOwner: {},
  };

  for (const { task } of items) {
    const { bucket, diffDays } = classifyDue(task);

    if (bucket === 'overdue') s.overdue += 1;
    if (bucket === 'today') s.today += 1;
    // Due within the next 7 days (today through +6), not completed.
    if (diffDays !== null && diffDays >= 0 && diffDays <= 6) s.week += 1;

    const st = task.Status || 'Unknown';
    s.status[st] = (s.status[st] || 0) + 1;

    const pr = task.Priority || 'Unknown';
    s.priority[pr] = (s.priority[pr] || 0) + 1;

    const owner = (task.Owner && task.Owner.name) || 'Unassigned';
    s.byOwner[owner] = (s.byOwner[owner] || 0) + 1;
  }

  return s;
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

function priorityRank(task) {
  const p = (task.Priority || '').toLowerCase();
  return p in PRIORITY_RANK ? PRIORITY_RANK[p] : 99;
}

function createdTime(task) {
  const d = task.Created_Time ? new Date(task.Created_Time) : null;
  return d && !isNaN(d.getTime()) ? d.getTime() : 0;
}

// When the lead landed in our dashboard (webhook ingest time). Falls back to the
// Bigin Created_Time for older rows that predate receivedAt.
function receivedTime(item) {
  const d = item.receivedAt ? new Date(item.receivedAt) : null;
  if (d && !isNaN(d.getTime())) return d.getTime();
  return createdTime(item.task);
}

function sortComparator(sortBy) {
  if (sortBy === 'newest') {
    return (a, b) => receivedTime(b) - receivedTime(a);
  }
  if (sortBy === 'priority') {
    return (a, b) => priorityRank(a.task) - priorityRank(b.task);
  }
  if (sortBy === 'created') {
    return (a, b) => createdTime(b.task) - createdTime(a.task);
  }
  // Default: due date ascending, tasks without a due date last.
  return (a, b) => {
    const da = parseDueDate(a.task.Due_Date);
    const db = parseDueDate(b.task.Due_Date);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  };
}

export function applyFilters(items, f) {
  let out = items;

  if (f.tab && f.tab !== 'all') {
    out = out.filter(({ task }) => classifyDue(task).bucket === f.tab);
  }
  if (f.status) {
    out = out.filter(({ task }) => (task.Status || '') === f.status);
  }
  if (f.priority) {
    out = out.filter(({ task }) => (task.Priority || '') === f.priority);
  }
  if (f.category) {
    // "(none)" = leads whose task subject matched no known category.
    out = out.filter(({ category }) =>
      f.category === '(none)' ? !category : category === f.category
    );
  }
  if (f.owner) {
    const owner = f.owner.toLowerCase();
    out = out.filter(
      ({ task }) => (task.Owner?.email || '').toLowerCase() === owner
    );
  }
  if (f.search) {
    const q = f.search.toLowerCase();
    out = out.filter(({ task }) => {
      const contact = (task.Who_Id?.name || '').toLowerCase();
      const subject = (task.Subject || '').toLowerCase();
      return contact.includes(q) || subject.includes(q);
    });
  }
  if (f.dueFrom) {
    const from = parseDueDate(f.dueFrom);
    out = out.filter(({ task }) => {
      const d = parseDueDate(task.Due_Date);
      return d && from && d >= from;
    });
  }
  if (f.dueTo) {
    const to = parseDueDate(f.dueTo);
    out = out.filter(({ task }) => {
      const d = parseDueDate(task.Due_Date);
      return d && to && d <= to;
    });
  }

  return [...out].sort(sortComparator(f.sortBy));
}

export const DEFAULT_FILTERS = {
  tab: 'all',
  status: '',
  priority: '',
  category: '',
  owner: '',
  search: '',
  dueFrom: '',
  dueTo: '',
  sortBy: 'newest',
};

// Bigin's Task_Category picklist, plus "No Response (NR)" — which is NOT in the
// picklist but is the second most common category the reps actually use (636 tasks).
// Worth adding to Bigin properly.
export const TASK_CATEGORIES = [
  'Follow Up',
  'No Response (NR)',
  'Call Back',
  'Final Call Back',
  'Final Follow Up',
  'See Response',
  'ICAI Not - Foundation',
  'ICAI Not - Intermediate',
];
