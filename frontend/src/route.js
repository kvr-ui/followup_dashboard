import { useEffect, useState } from 'react';

// Every screen has a hash URL, so Back/forward, refresh and shared links all work
// without a router library or a server-side SPA fallback:
//   #/<module>/<tab>     a list view, e.g. #/activities/follow-ups
//   #/lead/<phoneKey>    the lead page
// phoneKey is the last 10 digits of the lead's phone — the same key the server
// joins leads on.

const LEAD_HASH = /^#\/lead\/(\d{10})$/;
const VIEW_HASH = /^#\/([a-z-]+)\/([a-z-]+)$/;

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

function parseHash() {
  const { hash } = window.location;
  const lead = LEAD_HASH.exec(hash);
  if (lead) return { module: null, tab: null, leadKey: lead[1] };
  const view = VIEW_HASH.exec(hash);
  if (view) return { module: view[1], tab: view[2], leadKey: null };
  return { module: null, tab: null, leadKey: null };
}

export function go(module, tab) {
  const next = `#/${module}/${tab}`;
  if (window.location.hash !== next) window.location.hash = next;
}

// Swap the current entry instead of adding one — for redirects (no route, a
// route this user may not see), so Back doesn't bounce into the redirect again.
export function replaceRoute(module, tab) {
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', `${pathname}${search}#/${module}/${tab}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function openLead(phoneKey) {
  const key = toPhoneKey(phoneKey);
  if (!key) return;
  window.location.hash = `#/lead/${key}`;
  // Mark the entry as reached from inside the app, so "← Back" knows history.back()
  // lands on the list. History state survives a refresh; a pasted link has none.
  window.history.replaceState({ fdFromList: true }, '', window.location.href);
}

// "← Back": step back to the list when we came from it. A pasted lead link has
// no list behind it, so it goes to the home view instead.
export function leaveLead() {
  if (window.history.state?.fdFromList) window.history.back();
  else go('activities', 'follow-ups');
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const sync = () => setRoute(parseHash());
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);
  return route;
}
