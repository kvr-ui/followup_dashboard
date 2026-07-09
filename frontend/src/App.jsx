import { useEffect, useState } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import { api, getToken, setToken } from './api';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Restore the session on load if a token is present.
  useEffect(() => {
    (async () => {
      if (getToken()) {
        try {
          const { user } = await api('/api/auth/me');
          setUser(user);
        } catch {
          setToken(null);
        }
      }
      setLoading(false);
    })();
  }, []);

  function handleLogout() {
    setToken(null);
    setUser(null);
  }

  if (loading) return null;
  if (!user) return <Login onLogin={setUser} />;
  return <Dashboard user={user} onLogout={handleLogout} />;
}
