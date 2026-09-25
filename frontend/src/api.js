const TOKEN_KEY = 'fd_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Thin fetch wrapper that attaches the auth token and parses JSON.
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  const token = getToken();
  if (token) opts.headers.Authorization = `Bearer ${token}`;

  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);

  if (res.status === 401) {
    setToken(null);
    throw new Error('Session expired. Please log in again.');
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || `Request failed (${res.status})`);
    // Callers that treat a 403 or 404 differently from a failure read this.
    err.status = res.status;
    throw err;
  }
  return json;
}

// Fetches an authenticated file (CSV etc.) and hands it to the browser as a
// download — a plain <a href> can't carry the Bearer token.
export async function download(path, fallbackName = 'export.csv') {
  const token = getToken();
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    setToken(null);
    throw new Error('Session expired. Please log in again.');
  }
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
