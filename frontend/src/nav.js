import FollowUps from './components/FollowUps';
import Calls from './components/Calls';
import Leads from './components/Leads';
import AdLeads from './components/AdLeads';
import AdPerformance from './components/AdPerformance';
import Funnel from './components/Funnel';
import Installments from './components/Installments';
import Upsells from './components/Upsells';
import Marketing from './components/Marketing';
import Sources from './components/Sources';
import VSLTracking from './components/VSLTracking';
import Analytics from './components/Analytics';
import Scorecard from './components/Scorecard';
import RepLifecycle from './components/RepLifecycle';
import ApiUsage from './components/ApiUsage';
import AdminUsers from './components/AdminUsers';
import Products from './components/Products';
import ApiDocs from './components/ApiDocs';

// The whole navigation in one place: modules in the sidebar, tabs inside each.
//
// adminOnly mirrors the server, it does not replace it — every admin-only tab sits
// behind an admin gate at its API router (ad spend, cost per lead and raw lead PII
// under /api/ads; AI billing; user management), so a rep reaching one would get a
// 403 and an empty screen. Every tab open to reps is hard-scoped to them
// server-side: their own follow-ups, calls, score and payments; leads and the
// funnel limited to their own plus unassigned; VSL rows matching follow-ups they
// own. The API reference documents endpoints and serves no data.
//
// `legacy` is the tab's id from before modules existed (stored in fd_view), used
// once to land a returning user on the same screen.
export const MODULES = [
  {
    id: 'activities',
    label: 'Activities',
    icon: 'activities',
    tabs: [
      { id: 'follow-ups', label: 'Follow-ups', component: FollowUps, legacy: 'tasks' },
      { id: 'calls', label: 'Calls', component: Calls, legacy: 'calls' },
    ],
  },
  {
    id: 'leads',
    label: 'Leads',
    icon: 'leads',
    tabs: [
      { id: 'all', label: 'All Leads', component: Leads, legacy: 'leads' },
      { id: 'ad-leads', label: 'Ad Leads', component: AdLeads, adminOnly: true, legacy: 'adleads' },
    ],
  },
  {
    id: 'deals',
    label: 'Deals',
    icon: 'deals',
    tabs: [
      { id: 'funnel', label: 'Funnel', component: Funnel, legacy: 'funnel' },
      { id: 'installments', label: 'Installments', component: Installments, legacy: 'installments' },
      { id: 'upsells', label: 'Upsells', component: Upsells, legacy: 'upsells' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    icon: 'marketing',
    tabs: [
      { id: 'campaigns', label: 'Campaigns', component: Marketing, adminOnly: true, legacy: 'marketing' },
      { id: 'sources', label: 'Sources', component: Sources, adminOnly: true, legacy: 'sources' },
      { id: 'ad-performance', label: 'Ad Performance', component: AdPerformance, adminOnly: true },
      { id: 'vsl', label: 'VSL Tracking', component: VSLTracking, legacy: 'vsl' },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: 'reports',
    tabs: [
      { id: 'analytics', label: 'Analytics', component: Analytics, adminOnly: true, legacy: 'analytics' },
      { id: 'scorecard', label: 'Scorecard', repLabel: 'My score', component: Scorecard, legacy: 'scorecard' },
      { id: 'lifecycle', label: 'Rep Lifecycle', component: RepLifecycle, adminOnly: true },
      { id: 'ai-usage', label: 'AI Usage', component: ApiUsage, adminOnly: true, legacy: 'usage' },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    icon: 'setup',
    tabs: [
      { id: 'users', label: 'Users', component: AdminUsers, adminOnly: true, legacy: 'users' },
      { id: 'products', label: 'Products', component: Products, adminOnly: true, legacy: 'products' },
      { id: 'api-docs', label: 'API Docs', component: ApiDocs, legacy: 'apidocs' },
    ],
  },
];

export const HOME = { module: 'activities', tab: 'follow-ups' };

// The modules this user may see, each holding only their visible tabs, with the
// role-specific label applied. A module with no visible tab is dropped.
export function modulesFor(isAdmin) {
  return MODULES.map((m) => ({
    ...m,
    tabs: m.tabs
      .filter((t) => isAdmin || !t.adminOnly)
      .map((t) => ({ ...t, label: !isAdmin && t.repLabel ? t.repLabel : t.label })),
  })).filter((m) => m.tabs.length > 0);
}

// Old fd_view value -> its new { module, tab }, or null.
export function fromLegacyView(view) {
  for (const m of MODULES) {
    const t = m.tabs.find((tab) => tab.legacy === view);
    if (t) return { module: m.id, tab: t.id };
  }
  return null;
}
