import { DEFAULT_FILTERS, TASK_CATEGORIES } from '../taskStats';
import FilterBar from './ui/FilterBar';
import SubTabs from './ui/SubTabs';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'completed', label: 'Completed' },
];

export default function Filters({ filters, setFilters, owners, isAdmin }) {
  const set = (field, value) => setFilters((f) => ({ ...f, [field]: value }));

  return (
    <>
      <SubTabs tabs={TABS} active={filters.tab} onSelect={(id) => set('tab', id)} />

      <FilterBar>
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

        <label>
          Source
          <select value={filters.source} onChange={(e) => set('source', e.target.value)}>
            <option value="">All</option>
            <option value="meta">Meta</option>
            <option value="web">Web</option>
            {/* Leads with no ad origin at all — worth isolating on its own. */}
            <option value="untracked">Untracked</option>
          </select>
        </label>

        <label>
          Task Category
          <select value={filters.category} onChange={(e) => set('category', e.target.value)}>
            <option value="">All</option>
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="(none)">— no category —</option>
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
            <option value="newest">Newest first</option>
            <option value="dueDate">Due date</option>
            <option value="priority">Priority</option>
            <option value="created">Created</option>
          </select>
        </label>

        <button className="link-danger" onClick={() => setFilters({ ...DEFAULT_FILTERS })}>
          Clear
        </button>
      </FilterBar>
    </>
  );
}
