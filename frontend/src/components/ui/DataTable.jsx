// The standard list table: a bordered card that scrolls sideways when the
// columns outgrow it, with a sticky header. Children are the <thead>/<tbody>.
export default function DataTable({ children, className = '' }) {
  return (
    <div className="data-table-wrap">
      <table className={`data-table ${className}`.trim()}>{children}</table>
    </div>
  );
}
