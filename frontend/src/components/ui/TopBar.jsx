import Icon from './Icon';

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export default function TopBar({ user, onLogout, onHome, children }) {
  return (
    <header className="top-bar">
      <button className="brand" onClick={onHome} title="Home">
        <img src="/logo.png" alt="FOCAS" />
      </button>
      <div className="top-bar-center">{children}</div>
      <div className="user-box">
        <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
        <span className="who-mini">
          <span className="who-name">{user.name}</span>
          <span className="who-role">{user.role}</span>
        </span>
        <button className="icon-btn" onClick={onLogout} title="Log out" aria-label="Log out">
          <Icon name="logout" />
        </button>
      </div>
    </header>
  );
}
