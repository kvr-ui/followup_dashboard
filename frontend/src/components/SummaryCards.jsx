import { priorityClass, statusClass } from '../utils';
import StatCard, { StatGrid } from './ui/StatCard';
import Section from './ui/Section';

export default function SummaryCards({ summary, isAdmin, activeTab, onSelectTab }) {
  const s = summary;

  const cards = [
    { key: 'all', label: 'Total', num: s.total },
    { key: 'overdue', label: 'Overdue', num: s.overdue, tone: 'red' },
    { key: 'today', label: 'Due Today', num: s.today, tone: 'amber' },
    { key: 'week', label: 'Due This Week', num: s.week, tone: 'accent', noTab: true },
  ];

  return (
    <>
      <StatGrid>
        {cards.map((c) => (
          <StatCard
            key={c.key}
            label={c.label}
            value={c.num}
            tone={c.tone}
            active={!c.noTab && activeTab === c.key}
            onClick={c.noTab ? undefined : () => onSelectTab(c.key)}
          />
        ))}
      </StatGrid>

      <div className="fu-breakdowns">
        <Section title="By status">
          <div className="fu-breakdown">
            {Object.entries(s.status).map(([k, v]) => (
              <span key={k} className={statusClass(k)}>
                {k}: <b>{v}</b>
              </span>
            ))}
          </div>
        </Section>

        <Section title="By priority">
          <div className="fu-breakdown">
            {Object.entries(s.priority).map(([k, v]) => (
              <span key={k} className={priorityClass(k)}>
                {k}: <b>{v}</b>
              </span>
            ))}
          </div>
        </Section>

        {isAdmin && (
          <Section title="By salesperson">
            <div className="fu-breakdown">
              {Object.entries(s.byOwner)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => (
                  <span key={k} className="badge badge-normal">
                    {k}: <b>{v}</b>
                  </span>
                ))}
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
