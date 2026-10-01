// A titled card that groups one block of a view: a table, a chart, a form.
// `actions` sits on the right of the title row; `flush` drops the body padding
// so a DataTable can run edge to edge.
export default function Section({ title, meta, actions, flush, children, className = '' }) {
  return (
    <section className={`section-card ${flush ? 'flush' : ''} ${className}`.trim()}>
      {(title || actions) && (
        <div className="section-head">
          <div>
            {title && <h3 className="section-title">{title}</h3>}
            {meta && <div className="section-meta">{meta}</div>}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </div>
      )}
      <div className="section-body">{children}</div>
    </section>
  );
}
