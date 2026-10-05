import Icon from './Icon';

// The module rail. A module click opens that module's last-used tab.
export default function SideNav({ modules, active, onSelect }) {
  return (
    <nav className="side-nav" aria-label="Modules">
      {modules.map((m) => (
        <button
          key={m.id}
          className={m.id === active ? 'side-nav-item active' : 'side-nav-item'}
          aria-current={m.id === active ? 'page' : undefined}
          onClick={() => onSelect(m)}
        >
          <Icon name={m.icon} />
          <span>{m.label}</span>
        </button>
      ))}
    </nav>
  );
}
