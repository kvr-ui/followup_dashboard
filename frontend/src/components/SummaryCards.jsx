import { priorityClass, statusClass } from '../utils';

export default function SummaryCards({ summary, isAdmin, onSelectTab }) {
  const s = summary;

  const cards = [
    { key: 'all', label: 'Total', num: s.total, cls: '' },
    { key: 'overdue', label: 'Overdue', num: s.overdue, cls: 'overdue' },
    { key: 'today', label: 'Due Today', num: s.today, cls: 'today' },
    { key: 'week', label: 'Due This Week', num: s.week, cls: 'week', noTab: true },
  ];

  return (
    <>
      <div className="summary-grid">
        {cards.map((c) => (
          <div
            key={c.key}
            className={`card ${c.cls} ${c.noTab ? '' : 'clickable'}`}
            onClick={() => !c.noTab && onSelectTab(c.key)}
          >
            <div className="num">{c.num}</div>
            <div className="label">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="mini-grid">
        <div className="panel-sm">
          <h3>By status</h3>
          <div className="breakdown">
            {Object.entries(s.status).map(([k, v]) => (
              <span key={k} className={statusClass(k)}>
                {k}: <b>{v}</b>
              </span>
            ))}
          </div>
        </div>

        <div className="panel-sm">
          <h3>By priority</h3>
          <div className="breakdown">
            {Object.entries(s.priority).map(([k, v]) => (
              <span key={k} className={priorityClass(k)}>
                {k}: <b>{v}</b>
              </span>
            ))}
          </div>
        </div>

        {isAdmin && (
          <div className="panel-sm">
            <h3>By salesperson</h3>
            <div className="breakdown">
              {Object.entries(s.byOwner)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <span key={k} className="badge badge-normal">
                    {k}: <b>{v}</b>
                  </span>
                ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
