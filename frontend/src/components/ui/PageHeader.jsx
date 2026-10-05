// Title row of a view: what it is, an optional count or note, and its actions.
export default function PageHeader({ title, meta, actions }) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        {title && <h2 className="page-title">{title}</h2>}
        {meta && <div className="page-meta">{meta}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
