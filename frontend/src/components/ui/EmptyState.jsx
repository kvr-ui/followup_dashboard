export default function EmptyState({ title = 'Nothing here yet', children }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
