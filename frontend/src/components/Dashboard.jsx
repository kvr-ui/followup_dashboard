import { useCallback, useEffect, useMemo, useState } from 'react';
import TaskTable from './TaskTable';
import TaskDetail from './TaskDetail';
import AdminUsers from './AdminUsers';
import Analytics from './Analytics';
import Calls from './Calls';
import Products from './Products';
import SummaryCards from './SummaryCards';
import Filters from './Filters';
import { api } from '../api';
import { extractTasks } from '../utils';
import { computeSummary, applyFilters, DEFAULT_FILTERS } from '../taskStats';

export default function Dashboard({ user, onLogout }) {
  const isAdmin = user.role === 'admin';
  // Remember the active tab across page refreshes.
  const [view, setView] = useState(() => localStorage.getItem('fd_view') || 'tasks');
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ ...DEFAULT_FILTERS });
  const [selectedId, setSelectedId] = useState(null);

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
    if (view !== 'tasks') return undefined;
    loadTasks();
    const timer = setInterval(loadTasks, 15000);
    return () => clearInterval(timer);
  }, [view, loadTasks]);

  // Non-admins only have the tasks view; persist the tab for everyone else.
  useEffect(() => {
    if (!isAdmin && view !== 'tasks') {
      setView('tasks');
      return;
    }
    localStorage.setItem('fd_view', view);
  }, [view, isAdmin]);

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
      <header>
        <div className="brand">
          <h1>Followup Dashboard</h1>
          {isAdmin && (
            <nav className="tabs">
              <button
                className={view === 'tasks' ? 'tab active' : 'tab'}
                onClick={() => setView('tasks')}
              >
                Follow-ups
              </button>
              <button
                className={view === 'analytics' ? 'tab active' : 'tab'}
                onClick={() => setView('analytics')}
              >
                Analytics
              </button>
              <button
                className={view === 'calls' ? 'tab active' : 'tab'}
                onClick={() => setView('calls')}
              >
                Calls
              </button>
              <button
                className={view === 'products' ? 'tab active' : 'tab'}
                onClick={() => setView('products')}
              >
                Products
              </button>
              <button
                className={view === 'users' ? 'tab active' : 'tab'}
                onClick={() => setView('users')}
              >
                Users
              </button>
            </nav>
          )}
        </div>
        <div className="user-box">
          <span className="who-mini">
            {user.name} <span className="subtle">({user.role})</span>
          </span>
          <button onClick={onLogout}>Logout</button>
        </div>
      </header>

      <main>
        {view === 'tasks' ? (
          <>
            <SummaryCards
              summary={summary}
              isAdmin={isAdmin}
              onSelectTab={(tab) => setFilters((f) => ({ ...f, tab }))}
            />

            <Filters
              filters={filters}
              setFilters={setFilters}
              owners={owners}
              isAdmin={isAdmin}
            />

            <div className="toolbar">
              <p id="status">
                {error
                  ? error
                  : `Showing ${filtered.length} of ${tasks.length} follow-up(s)`}
              </p>
              <button onClick={loadTasks} disabled={loading}>
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {filtered.length > 0 ? (
              <TaskTable tasks={filtered} onSelect={setSelectedId} />
            ) : (
              <p className="subtle">No follow-ups match the current filters.</p>
            )}
          </>
        ) : view === 'analytics' ? (
          <Analytics />
        ) : view === 'calls' ? (
          <Calls />
        ) : view === 'products' ? (
          <Products />
        ) : (
          <AdminUsers />
        )}
      </main>

      {selectedId && (
        <TaskDetail
          recordId={selectedId}
          onClose={() => setSelectedId(null)}
          onUpdated={loadTasks}
        />
      )}
    </>
  );
}
