import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import CallDetail from './CallDetail';
import SubTabs from './ui/SubTabs';
import EmptyState from './ui/EmptyState';
import LeadHeader, { BackButton } from './lead/LeadHeader';
import LeadInfoPanel from './lead/LeadInfoPanel';
import LeadTimeline from './lead/LeadTimeline';
import LeadDeals from './lead/LeadDeals';
import LeadCalls from './lead/LeadCalls';
import LeadForms from './lead/LeadForms';
import LeadOlderTasks from './lead/LeadOlderTasks';
import LeadError from './lead/LeadError';
import { averageScore } from './lead/format';

// One page per lead at #/lead/<phoneKey>, built from GET /api/lead-profile/:phoneKey.
//
// Left: the lead's details and what you can DO — status, note, WhatsApp — always
// against the newest Task, then VSL watch time and acquisition.
// Right: one tab per section that has data — timeline, deals, calls, forms… —
// showing that section alone.
// Older Tasks are read-only; their notes already sit in the timeline.

export default function LeadProfile({ phoneKey }) {
  const [data, setData] = useState(null);
  const [zohoSync, setZohoSync] = useState(true);
  const [error, setError] = useState(null); // { status, message }
  const [loading, setLoading] = useState(true);
  const [openCallId, setOpenCallId] = useState(null);
  // Which section tab is open. Back to the timeline whenever another lead opens.
  const [tab, setTab] = useState('timeline');
  useEffect(() => setTab('timeline'), [phoneKey]);

  // On a laptop the page itself stays still and only the columns scroll, so
  // the page is sized to the window below wherever it starts.
  const pageRef = useRef(null);
  const hasData = Boolean(data);
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el) return undefined;
    const place = () =>
      el.style.setProperty('--lp-offset', `${el.getBoundingClientRect().top + window.scrollY}px`);
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [hasData]);
  // Only the newest request may land — a slow refetch must not overwrite a newer lead.
  const seq = useRef(0);

  const load = useCallback(
    async (fresh) => {
      const mine = ++seq.current;
      if (fresh) {
        setData(null);
        setLoading(true);
      }
      setError(null);
      try {
        const res = await api(`/api/lead-profile/${encodeURIComponent(phoneKey)}`);
        if (mine !== seq.current) return;
        setData(res.data);
        setZohoSync(res.zohoSync !== false);
      } catch (err) {
        if (mine !== seq.current) return;
        setError({ status: err.status || 0, message: err.message });
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [phoneKey]
  );

  useEffect(() => {
    setOpenCallId(null);
    window.scrollTo(0, 0);
    load(true);
  }, [load]);

  const refetch = useCallback(() => load(false), [load]);

  if (!data) {
    if (loading) {
      return (
        <div className="lead-profile">
          <div className="lp-header">
            <BackButton />
          </div>
          <p className="subtle">Loading lead…</p>
        </div>
      );
    }
    return <LeadError error={error} onRetry={() => load(true)} />;
  }

  const { header = {}, latestTask, olderTasks = [], webLeads = [], metaLeads = [] } = data;
  const deals = data.deals || [];
  const calls = data.calls || [];
  const timeline = data.timeline || [];
  const hasForms = webLeads.length > 0 || metaLeads.length > 0;

  // One tab per section that has data, in reading order. Clicking a tab shows
  // that section alone; the count sits on the tab.
  const sections = [
    timeline.length > 0 && {
      id: 'timeline',
      label: 'Timeline',
      count: timeline.length,
      render: () => <LeadTimeline events={timeline} />,
    },
    deals.length > 0 && {
      id: 'deals',
      label: 'Deals',
      count: deals.length,
      render: () => <LeadDeals deals={deals} />,
    },
    calls.length > 0 && {
      id: 'calls',
      label: 'Calls',
      count: calls.length,
      render: () => <LeadCalls calls={calls} onOpen={setOpenCallId} />,
    },
    hasForms && {
      id: 'forms',
      label: 'Form answers',
      count: webLeads.length + metaLeads.length,
      render: () => <LeadForms webLeads={webLeads} metaLeads={metaLeads} />,
    },
    olderTasks.length > 0 && {
      id: 'older',
      label: 'Older follow-ups',
      count: olderTasks.length,
      render: () => <LeadOlderTasks tasks={olderTasks} />,
    },
  ].filter(Boolean);
  // A lead with no timeline (or a tab that just emptied) falls back to the first.
  const active = sections.find((sec) => sec.id === tab) || sections[0] || null;

  return (
    <div className="lead-profile lp-fit" ref={pageRef}>
      <LeadHeader header={header} phoneKey={phoneKey} />

      {/* A refetch after an action failed: keep the page, say so. */}
      {error && (
        <div className="error">
          {error.message}{' '}
          <button className="link-btn" onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {/* Details and actions pinned on the left; the sections, one tab at a time, on the right. */}
      <div className="lp-layout">
        <LeadInfoPanel
          data={data}
          latestTask={latestTask}
          zohoSync={zohoSync}
          onChanged={refetch}
          stats={{
            followUps: (latestTask ? 1 : 0) + olderTasks.length,
            calls: calls.length,
            deals: deals.length,
            forms: webLeads.length + metaLeads.length,
            lastActivity: timeline[0]?.at || null,
            avgScore: averageScore(calls),
          }}
        />

        <div className="lp-main">
          {active ? (
            <>
              <SubTabs
                className="lp-tabs"
                active={active.id}
                onSelect={setTab}
                tabs={sections.map((sec) => ({
                  id: sec.id,
                  label: (
                    <>
                      {sec.label}
                      {sec.count != null && <span className="lp-tab-count">{sec.count}</span>}
                    </>
                  ),
                }))}
              />
              <div className="lp-panel" role="tabpanel">
                {active.render()}
              </div>
            </>
          ) : (
            <EmptyState title="Nothing recorded for this lead yet." />
          )}
        </div>
      </div>

      {openCallId && <CallDetail callId={openCallId} onClose={() => setOpenCallId(null)} />}
    </div>
  );
}
