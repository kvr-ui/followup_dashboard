import { useEffect, useRef, useState } from 'react';
import { api, setToken } from '../api';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
let gsiPromise = null;

// Loads the Google Identity Services script at most once per page, reusing an
// existing tag if one is already on the page.
function loadGsi() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise((resolve, reject) => {
    let script = document.querySelector(`script[src="${GSI_SRC}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', () =>
      window.google?.accounts?.id ? resolve(window.google) : reject(new Error('GSI unavailable'))
    );
    script.addEventListener('error', () => reject(new Error('GSI failed to load')));
  }).catch((err) => {
    gsiPromise = null;
    throw err;
  });
  return gsiPromise;
}

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(null);
  const googleRef = useRef(null);

  useEffect(() => {
    let active = true;
    api('/api/auth/config')
      .then((cfg) => {
        if (active && cfg?.googleClientId) setGoogleClientId(cfg.googleClientId);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!googleClientId) return undefined;
    let active = true;
    loadGsi()
      .then((google) => {
        if (!active || !googleRef.current) return;
        google.accounts.id.initialize({ client_id: googleClientId, callback: handleGoogle });
        google.accounts.id.renderButton(googleRef.current, {
          theme: 'outline',
          size: 'large',
          width: 300,
        });
      })
      .catch(() => {
        if (active) setGoogleClientId(null);
      });
    return () => {
      active = false;
    };
    // handleGoogle only uses stable setters and the onLogin prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleClientId]);

  async function handleGoogle({ credential }) {
    setError('');
    setBusy(true);
    try {
      const { token, user } = await api('/api/auth/google', {
        method: 'POST',
        body: { credential },
      });
      setToken(token);
      onLogin(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token, user } = await api('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      setToken(token);
      onLogin(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <img className="login-logo" src="/logo.png" alt="FOCAS" />
        <div className="login-head">
          <h1>Sign in</h1>
          <p className="subtle">FOCAS Sales CRM</p>
        </div>

        {error && <div className="error">{error}</div>}

        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {googleClientId && (
          <>
            <div className="login-divider">or</div>
            <div className="login-google" ref={googleRef} />
          </>
        )}
      </form>
    </div>
  );
}
