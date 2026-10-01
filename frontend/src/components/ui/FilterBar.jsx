// The row of filter controls above a list. Children are the usual
// <label>Name<select/></label> pairs and buttons.
export default function FilterBar({ children, className = '' }) {
  return <div className={`filter-bar ${className}`.trim()}>{children}</div>;
}
