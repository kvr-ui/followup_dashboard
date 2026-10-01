// An underlined tab strip: module tabs under the page title, sections on the lead
// page, and two-way switches inside a view. `tabs` is [{ id, label }].
export default function SubTabs({ tabs, active, onSelect, className = '' }) {
  return (
    <div className={`sub-tabs ${className}`.trim()} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === active}
          className={t.id === active ? 'sub-tab active' : 'sub-tab'}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
