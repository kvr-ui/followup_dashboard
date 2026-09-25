import { useEffect, useState } from 'react';

// The lead page lives at #/lead/<phoneKey>. A hash route rather than a router:
// the server needs no fallback, Back returns to the list, and a refresh keeps
// the lead open. phoneKey is the last 10 digits of the lead's phone — the same
// key the server joins leads on.

const LEAD_HASH = /^#\/lead\/(\d{10})$/;
// Fired alongside pushState, which (unlike a hash assignment) raises no
// hashchange of its own.
const ROUTE_EVENT = 'fd-leadroute';

// Any phone value -> its last 10 digits, or null when it has fewer than 10.
export function toPhoneKey(phone) {
  if (phone == null) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

// A row's key: its own phoneKey when the server sent one, else derived from the phone.
export function rowPhoneKey(row, phone) {
  return toPhoneKey(row?.phoneKey) || toPhoneKey(phone);
}

function keyFromHash() {
  const m = LEAD_HASH.exec(window.location.hash);
  return m ? m[1] : null;
}

export function openLead(phoneKey) {
  const key = toPhoneKey(phoneKey);
  if (!key) return;
  window.location.hash = `#/lead/${key}`;
  // Mark the entry as reached from inside the app, so "← Back" knows history.back()
  // lands on the list. History state survives a refresh; a pasted link has none.
  window.history.replaceState({ fdFromList: true }, '', window.location.href);
}

// Leave the lead page by pushing a new, hash-less entry, so Back still returns to it.
export function closeLead() {
  if (!keyFromHash()) return;
  const { pathname, search } = window.location;
  window.history.pushState(null, '', pathname + search);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

// "← Back": step back to the list when we came from it, otherwise just clear the hash.
export function leaveLead() {
  if (window.history.state?.fdFromList) window.history.back();
  else closeLead();
}

export function useLeadRoute() {
  const [key, setKey] = useState(keyFromHash);
  useEffect(() => {
    const sync = () => setKey(keyFromHash());
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    window.addEventListener(ROUTE_EVENT, sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
      window.removeEventListener(ROUTE_EVENT, sync);
    };
  }, []);
  return key;
}
