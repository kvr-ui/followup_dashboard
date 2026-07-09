import { useEffect, useState } from 'react';
import { api } from '../api';

function rateColor(rate) {
  if (rate >= 70) return '#4d7a63';
  if (rate >= 40) return '#9a7a45';
  return '#a5615a';
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
    <>
      <div className="summary-grid">
        <div className="card">
          <div className="num">{totals.salespeople}</div>
          <div className="label">Salespeople</div>
        </div>
        <div className="card">
          <div className="num">{totals.total}</div>
          <div className="label">Total follow-ups</div>
        </div>
        <div className="card">
          <div className="num" style={{ color: '#12b76a' }}>
            {totals.completed}
          </div>
          <div className="label">Completed</div>
        </div>
        <div className="card overdue">
          <div className="num">{totals.overdue}</div>
          <div className="label">Overdue</div>
        </div>
        <div className="card">
          <div className="num">{totals.completionRate}%</div>
          <div className="label">Overall completion</div>
        </div>
      </div>

      <div className="panel">
        <div className="row-between" style={{ marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0 }}>Performance by salesperson</h2>
          <button onClick={load}>Refresh</button>
        </div>

        <table className="tasks">
          <thead>
            <tr>
              <th>Salesperson</th>
              <th>Total</th>
              <th>Completed</th>
              <th>In Progress</th>
              <th>Overdue</th>
              <th>Due Today</th>
              <th>Completion rate</th>
              <th>Notes</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.email}>
                <td>
                  <div className="who">{u.name || u.email}</div>
                  <div className="subtle">
                    {u.username ? `@${u.username}` : 'no account'}
                  </div>
                </td>
                <td>{u.total}</td>
                <td>{u.completed}</td>
                <td>{u.inProgress}</td>
                <td className={u.overdue ? 'cell-overdue' : ''}>{u.overdue}</td>
                <td>{u.dueToday}</td>
                <td>
                  <div className="rate-wrap">
                    <div className="rate-bar">
                      <span
                        style={{
                          width: `${u.completionRate}%`,
                          background: rateColor(u.completionRate),
                        }}
                      />
                    </div>
                    <span className="rate-num">{u.completionRate}%</span>
                  </div>
                </td>
                <td>{u.notes}</td>
                <td>{u.actions}</td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={9} className="subtle">
                  No data yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
