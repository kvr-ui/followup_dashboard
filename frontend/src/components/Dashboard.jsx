import { useCallback, useEffect, useMemo, useState } from 'react';
import TaskTable from './TaskTable';
import TaskDetail from './TaskDetail';
import AdminUsers from './AdminUsers';
import Analytics from './Analytics';
import Calls from './Calls';
import Products from './Products';
import Installments from './Installments';
import Upsells from './Upsells';
import Scorecard from './Scorecard';
import Marketing from './Marketing';
import Sources from './Sources';
import AdLeads from './AdLeads';
import VSLTracking from './VSLTracking';
import ApiUsage from './ApiUsage';
import ApiDocs from './ApiDocs';
import Agent from './Agent';
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

  // Sales users get their own follow-ups and their own pending payments — the rest
  // of the dashboard is admin-only. The server enforces this too; this just keeps
  // a stale localStorage tab from stranding a rep on a view they can't load.
  const allowed = useMemo(
    () =>
      isAdmin
        ? [
            'tasks',
            // The ask-the-data assistant. Open to reps as well (see the sales
            // list below): every tool it can call is owner-scoped server-side,
            // and the ones that cannot be scoped are admin-gated by name.
            'agent',
            'analytics',
            'calls',
            'scorecard',
            'products',
            'installments',
            'upsells',
            // Visible to EVERY role, unlike the ads tabs below it. /api/vsl sits
            // behind `authenticate` with no admin gate, and the controller pins a
            // rep to VSL leads matching follow-ups they own — the same shape as
            // installments and upsells.
            'vsl',
            // Ad spend, cost per lead and raw lead PII are management data.
            // /api/ads is admin-only at the router, so a rep who reaches these
            // views gets a 403 and an empty screen — hence they are also absent
            // from the sales list below, and a rep with either one stored is
            // redirected to follow-ups by the effect underneath.
            'marketing',
            // Which lead source closed the deal, and the campaign behind it.
            // Same reasoning as the two either side: /api/ads/sources is behind
            // the admin gate, so a rep here would get a 403 and a blank panel.
            'sources',
            'adleads',
            // AI provider spend and account balance — billing data, admin only.
            'usage',
            'users',
            'apidocs',
          ]
        : // A sales rep gets their own follow-ups, their own graded calls, their personal
          // scorecard, and their payments. Every one is hard-scoped to them on the server,
          // not just hidden here.
          //
          // The API reference is open to reps too: it documents the endpoints, it does not
          // serve their data, and every admin-only entry is labelled as such (and would
          // answer 403 anyway). Hiding the docs would not have hidden anything.
          ['tasks', 'agent', 'calls', 'scorecard', 'installments', 'upsells', 'vsl', 'apidocs'],
    [isAdmin]
  );

  useEffect(() => {
    if (!allowed.includes(view)) {
      setView('tasks');
      return;
    }
    localStorage.setItem('fd_view', view);
  }, [view, allowed]);

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
        {/* Title and account on one line, the tabs on their own full-width line
            below. They used to share a row, so every tab added squeezed the
            others until labels broke across two lines and the account name was
            pushed off the edge — at thirteen tabs an admin had reached that. */}
        <div className="header-row">
          <h1>Followup Dashboard</h1>
          <div className="user-box">
            <span className="who-mini">
              {user.name} <span className="subtle">({user.role})</span>
            </span>
            <button onClick={onLogout}>Logout</button>
          </div>
        </div>
        <nav className="tabs">
            <button
              className={view === 'tasks' ? 'tab active' : 'tab'}
              onClick={() => setView('tasks')}
            >
              Follow-ups
            </button>
            <button
              className={view === 'agent' ? 'tab active' : 'tab'}
              onClick={() => setView('agent')}
            >
              Ask
            </button>
            {isAdmin && (
              <button
                className={view === 'analytics' ? 'tab active' : 'tab'}
                onClick={() => setView('analytics')}
              >
                Analytics
              </button>
            )}
            <button
              className={view === 'calls' ? 'tab active' : 'tab'}
              onClick={() => setView('calls')}
            >
              Calls
            </button>
            <button
              className={view === 'scorecard' ? 'tab active' : 'tab'}
              onClick={() => setView('scorecard')}
            >
              {isAdmin ? 'Scorecard' : 'My score'}
            </button>
            {isAdmin && (
              <button
                className={view === 'products' ? 'tab active' : 'tab'}
                onClick={() => setView('products')}
              >
                Products
              </button>
            )}
            <button
              className={view === 'installments' ? 'tab active' : 'tab'}
              onClick={() => setView('installments')}
            >
              Installments
            </button>
            <button
              className={view === 'upsells' ? 'tab active' : 'tab'}
              onClick={() => setView('upsells')}
            >
              Upsells
            </button>
            <button
              className={view === 'vsl' ? 'tab active' : 'tab'}
              onClick={() => setView('vsl')}
            >
              VSL Tracking
            </button>
            {isAdmin && (
              <button
                className={view === 'marketing' ? 'tab active' : 'tab'}
                onClick={() => setView('marketing')}
              >
                Marketing
              </button>
            )}
            {isAdmin && (
              <button
                className={view === 'sources' ? 'tab active' : 'tab'}
                onClick={() => setView('sources')}
              >
                Sources
              </button>
            )}
            {isAdmin && (
              <button
                className={view === 'adleads' ? 'tab active' : 'tab'}
                onClick={() => setView('adleads')}
              >
                Ad Leads
              </button>
            )}
            {isAdmin && (
              <button
                className={view === 'usage' ? 'tab active' : 'tab'}
                onClick={() => setView('usage')}
              >
                AI Usage
              </button>
            )}
            {isAdmin && (
              <button
                className={view === 'users' ? 'tab active' : 'tab'}
                onClick={() => setView('users')}
              >
                Users
              </button>
            )}
            <button
              className={view === 'apidocs' ? 'tab active' : 'tab'}
              onClick={() => setView('apidocs')}
            >
              API Docs
            </button>
        </nav>
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
        ) : view === 'agent' ? (
          <Agent user={user} />
        ) : view === 'installments' ? (
          <Installments isAdmin={isAdmin} />
        ) : view === 'upsells' ? (
          <Upsells isAdmin={isAdmin} />
        ) : view === 'vsl' ? (
          // Opening a lead's follow-up reuses the drawer this file already owns,
          // exactly as the Ad Leads tab does.
          <VSLTracking isAdmin={isAdmin} onOpenTask={setSelectedId} />
        ) : view === 'analytics' ? (
          <Analytics />
        ) : view === 'calls' ? (
          <Calls />
        ) : view === 'scorecard' ? (
          <Scorecard user={user} />
        ) : view === 'products' ? (
          <Products />
        ) : view === 'marketing' ? (
          <Marketing />
        ) : view === 'sources' ? (
          <Sources />
        ) : view === 'adleads' ? (
          // Opening a lead's follow-up reuses the drawer this file already
          // owns rather than mounting a second copy of it inside the tab.
          <AdLeads onOpenTask={setSelectedId} />
        ) : view === 'usage' ? (
          <ApiUsage />
        ) : view === 'apidocs' ? (
          <ApiDocs user={user} />
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
