// One KPI tile. `tone` colours the figure: red | amber | green | accent | muted.
export default function StatCard({ label, value, hint, title, tone, active, onClick }) {
  const cls = ['stat-card', tone && `tone-${tone}`, onClick && 'clickable', active && 'active']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      title={title}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
    >
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function StatGrid({ children }) {
  return <div className="stat-grid">{children}</div>;
}
