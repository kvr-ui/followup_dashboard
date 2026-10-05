import { useEffect, useState } from 'react';
import { api } from '../api';
import Section from './ui/Section';
import DataTable from './ui/DataTable';
import EmptyState from './ui/EmptyState';
import StatCard, { StatGrid } from './ui/StatCard';
import Icon from './ui/Icon';
import '../styles/views/reports.css';

function rateTone(rate) {
  if (rate >= 70) return 'green';
  if (rate >= 40) return 'amber';
  return 'red';
}

export default function Analytics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      setData(await api('/api/analytics'));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="subtle">Loading analytics…</p>;

  const { totals, users } = data;

  return (
    <div className="report">
      <StatGrid>
        <StatCard label="Salespeople" value={totals.salespeople} />
        <StatCard label="Total follow-ups" value={totals.total} />
        <StatCard label="Completed" value={totals.completed} tone="green" />
        <StatCard label="Overdue" value={totals.overdue} tone="red" />
        <StatCard label="Overall completion" value={`${totals.completionRate}%`} />
      </StatGrid>

      <Section
        title="Performance by salesperson"
        flush={users.length > 0}
        actions={
          <button onClick={load}>
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        }
      >
        {users.length > 0 ? (
          <DataTable>
            <thead>
              <tr>
                <th>Salesperson</th>
                <th className="num">Total</th>
                <th className="num">Completed</th>
                <th className="num">In Progress</th>
                <th className="num">Overdue</th>
                <th className="num">Due Today</th>
                <th>Completion rate</th>
                <th className="num">Notes</th>
                <th className="num">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email}>
                  <td>
                    <div className="who">{u.name || u.email}</div>
                    <div className="subtle">{u.username ? `@${u.username}` : 'no account'}</div>
                  </td>
                  <td className="num">{u.total}</td>
                  <td className="num">{u.completed}</td>
                  <td className="num">{u.inProgress}</td>
                  <td className={u.overdue ? 'num cell-overdue' : 'num'}>{u.overdue}</td>
                  <td className="num">{u.dueToday}</td>
                  <td>
                    <div className="rate-wrap">
                      <div className="rate-bar">
                        <span
                          className={`fill-${rateTone(u.completionRate)}`}
                          style={{ width: `${u.completionRate}%` }}
                        />
                      </div>
                      <span className="rate-num">{u.completionRate}%</span>
                    </div>
                  </td>
                  <td className="num">{u.notes}</td>
                  <td className="num">{u.actions}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        ) : (
          <EmptyState title="No data yet" />
        )}
      </Section>
    </div>
  );
}
