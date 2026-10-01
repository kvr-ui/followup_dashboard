import { useCallback, useEffect, useMemo, useState } from 'react';
import TaskTable from './TaskTable';
import SummaryCards from './SummaryCards';
import Filters from './Filters';
import PageHeader from './ui/PageHeader';
import EmptyState from './ui/EmptyState';
import Icon from './ui/Icon';
import { api } from '../api';
import { extractTasks } from '../utils';
import { computeSummary, applyFilters, DEFAULT_FILTERS } from '../taskStats';

// Filters outlive the view: opening a lead unmounts this list, and Back should
// land on the same filtered list, not a reset one.
let savedFilters = { ...DEFAULT_FILTERS };

export default function FollowUps({ isAdmin }) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filters, setFiltersState] = useState(savedFilters);

  const setFilters = useCallback((next) => {
    setFiltersState((prev) => {
      savedFilters = typeof next === 'function' ? next(prev) : next;
      return savedFilters;
    });
  }, []);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const json = await api('/api/tasks');
      setTasks((json.data || []).flatMap(extractTasks));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTasks();
    const timer = setInterval(loadTasks, 15000);
    return () => clearInterval(timer);
  }, [loadTasks]);

  const summary = useMemo(() => computeSummary(tasks), [tasks]);
  const filtered = useMemo(() => applyFilters(tasks, filters), [tasks, filters]);

  // Owner dropdown options (admin only), derived from the loaded tasks.
  const owners = useMemo(() => {
    const m = new Map();
    tasks.forEach(({ task }) => {
      const email = task.Owner?.email;
      if (email) m.set(email.toLowerCase(), task.Owner.name || email);
    });
    return [...m.entries()].map(([email, name]) => ({ email, name }));
  }, [tasks]);

  return (
    <>
      <SummaryCards
        summary={summary}
        isAdmin={isAdmin}
        onSelectTab={(tab) => setFilters((f) => ({ ...f, tab }))}
      />

      <Filters filters={filters} setFilters={setFilters} owners={owners} isAdmin={isAdmin} />

      <PageHeader
        meta={
          <span id="status" className={error ? 'error' : undefined}>
            {error || `Showing ${filtered.length} of ${tasks.length} follow-up(s)`}
          </span>
        }
        actions={
          <button onClick={loadTasks} disabled={loading}>
            <Icon name="refresh" size={14} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      />

      {filtered.length > 0 ? (
        <TaskTable tasks={filtered} />
      ) : (
        <EmptyState title="No follow-ups match the current filters" />
      )}
    </>
  );
}
