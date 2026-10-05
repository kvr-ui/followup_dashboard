import { useEffect, useMemo } from 'react';
import Agent from './Agent';
import LeadProfile from './LeadProfile';
import TopBar from './ui/TopBar';
import SideNav from './ui/SideNav';
import SubTabs from './ui/SubTabs';
import GlobalSearch from './ui/GlobalSearch';
import { useRoute, go, replaceRoute } from '../route';
import { modulesFor, fromLegacyView, HOME } from '../nav';

// The last tab opened in each module, so a module click returns to it.
const TABS_KEY = 'fd_tabs';

function readLastTabs() {
  try {
    return JSON.parse(localStorage.getItem(TABS_KEY)) || {};
  } catch {
    return {};
  }
}

export default function Dashboard({ user, onLogout }) {
  const isAdmin = user.role === 'admin';
  const modules = useMemo(() => modulesFor(isAdmin), [isAdmin]);
  const { module: moduleId, tab: tabId, leadKey } = useRoute();

  const current = modules.find((m) => m.id === moduleId);
  const tab = current?.tabs.find((t) => t.id === tabId);

  // No route, or one this user can't see (a stale link, a rep on an admin URL):
  // go to the screen they were last on, else home. The server enforces access
  // too; this only keeps anyone from landing on a blank 403 screen.
  useEffect(() => {
    if (leadKey || tab) return;
    const legacy = fromLegacyView(localStorage.getItem('fd_view'));
    const target =
      legacy && modules.some((m) => m.id === legacy.module && m.tabs.some((t) => t.id === legacy.tab))
        ? legacy
        : HOME;
    replaceRoute(target.module, target.tab);
  }, [leadKey, tab, modules]);

  useEffect(() => {
    if (!tab) return;
    // Dropped only once a real route is showing, so the redirect above has used it.
    localStorage.removeItem('fd_view');
    localStorage.setItem(TABS_KEY, JSON.stringify({ ...readLastTabs(), [moduleId]: tabId }));
  }, [moduleId, tabId, tab]);

  const openModule = (m) => {
    const last = readLastTabs()[m.id];
    go(m.id, m.tabs.some((t) => t.id === last) ? last : m.tabs[0].id);
  };

  const View = tab?.component;

  return (
    <div className="app">
      <TopBar user={user} onLogout={onLogout} onHome={() => go(HOME.module, HOME.tab)}>
        <GlobalSearch />
      </TopBar>

      <div className="app-shell">
        <SideNav modules={modules} active={leadKey ? 'leads' : moduleId} onSelect={openModule} />

        <main>
          {leadKey ? (
            <LeadProfile phoneKey={leadKey} />
          ) : current && View ? (
            <>
              <div className="module-header">
                <h1 className="module-title">{current.label}</h1>
                {current.tabs.length > 1 && (
                  <SubTabs
                    tabs={current.tabs}
                    active={tabId}
                    onSelect={(id) => go(current.id, id)}
                  />
                )}
              </div>
              <div className="module-body">
                <View key={`${moduleId}/${tabId}`} isAdmin={isAdmin} user={user} />
              </div>
            </>
          ) : null}
        </main>
      </div>

      {/* The ask-the-data assistant floats over every view, for reps too: every
          tool it can call is owner-scoped server-side, and the ones that cannot
          be scoped are admin-gated by name. */}
      <Agent user={user} />
    </div>
  );
}
