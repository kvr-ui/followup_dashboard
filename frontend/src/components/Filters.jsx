import { DEFAULT_FILTERS } from '../taskStats';

const TABS = [
  { k: 'all', label: 'All' },
  { k: 'overdue', label: 'Overdue' },
  { k: 'today', label: 'Today' },
  { k: 'upcoming', label: 'Upcoming' },
  { k: 'completed', label: 'Completed' },
];

export default function Filters({ filters, setFilters, owners, isAdmin }) {
  const set = (field, value) => setFilters((f) => ({ ...f, [field]: value }));

  return (
    <>
      <div className="quick-tabs">
        {TABS.map((t) => (
          <button
            key={t.k}
            className={`quick-tab ${filters.tab === t.k ? 'active' : ''}`}
            onClick={() => set('tab', t.k)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="filters">
        <label>
          Search contact
          <input
            value={filters.search}
            placeholder="name…"
            onChange={(e) => set('search', e.target.value)}
          />
        </label>

        <label>
          Status
          <select value={filters.status} onChange={(e) => set('status', e.target.value)}>
            <option value="">All</option>
            <option>In Progress</option>
            <option>Completed</option>
            <option>Not Started</option>
          </select>
        </label>

        <label>
          Priority
          <select value={filters.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="">All</option>
            <option>High</option>
            <option>Normal</option>
            <option>Low</option>
          </select>
        </label>

        {isAdmin && (
          <label>
            Owner
            <select value={filters.owner} onChange={(e) => set('owner', e.target.value)}>
              <option value="">All</option>
              {owners.map((o) => (
                <option key={o.email} value={o.email}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label>
          Due from
          <input
            type="date"
            value={filters.dueFrom}
            onChange={(e) => set('dueFrom', e.target.value)}
          />
        </label>

        <label>
          Due to
          <input
            type="date"
            value={filters.dueTo}
            onChange={(e) => set('dueTo', e.target.value)}
          />
        </label>

        <label>
          Sort by
          <select value={filters.sortBy} onChange={(e) => set('sortBy', e.target.value)}>
            <option value="dueDate">Due date</option>
            <option value="priority">Priority</option>
            <option value="created">Created</option>
          </select>
        </label>

        <button className="link-danger" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
          Clear
        </button>
      </div>
    </>
  );
}
