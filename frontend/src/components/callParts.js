import { useEffect, useState } from 'react';
import { getToken } from '../api';

// Pieces of the call drawer that the lead page reuses: the mm:ss clock and the
// authenticated recording fetch.

/** Seconds → "mm:ss". */
export function ts(sec) {
  const s = Math.round(sec || 0);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The recording route needs an auth header, so <audio src> can't fetch it
 * directly — pull it as a blob and hand the player an object URL.
 *
 * Fetches only while `enabled` (a loaded call that actually has a recording),
 * otherwise every call without audio fires a guaranteed 404.
 *
 * @returns {{ url: string|null, loading: boolean, error: string }}
 */
export function useRecordingUrl(callId, enabled) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled || !callId) {
      setUrl(null);
      setLoading(false);
      setError('');
      return undefined;
    }
    let revoked = null;
    let cancelled = false;
    setLoading(true);
    setError('');
    fetch(`/api/calls/${callId}/recording`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then(async (r) => {
        if (r.ok) return r.blob();
        const json = await r.json().catch(() => ({}));
        throw new Error(json.message || 'Recording unavailable');
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        // If we switched calls while the blob was downloading, drop it — don't hand a
        // stale recording to the player.
        if (cancelled) return URL.revokeObjectURL(objectUrl);
        revoked = objectUrl;
        setUrl(objectUrl);
      })
      .catch((e) => {
        if (cancelled) return;
        setUrl(null);
        setError(e.message || 'Recording unavailable');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [callId, enabled]);

  return { url, loading, error };
}
