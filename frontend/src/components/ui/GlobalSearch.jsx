import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { api } from '../../api';
import { openLead, rowPhoneKey } from '../../route';

const STAGE_LABEL = { mql: 'MQL', sql: 'SQL', closed: 'Closed' };

// Find any lead by name or phone from anywhere, and jump to its page. Backed by
// /api/leads-list?q=, which already scopes a rep to their own and unassigned
// leads — so search never shows a rep a lead their list wouldn't.
export default function GlobalSearch() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const boxRef = useRef(null);

  // "/" focuses search, unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    const onClick = (e) => {
      if (!boxRef.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRows([]);
      setLoading(false);
      return undefined;
    }
    let stale = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const json = await api(`/api/leads-list?q=${encodeURIComponent(term)}&limit=8`);
        if (!stale) {
          setRows(json.rows || []);
          setActive(0);
        }
      } catch {
        if (!stale) setRows([]);
      } finally {
        if (!stale) setLoading(false);
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q]);

  const pick = (row) => {
    const key = rowPhoneKey(row, row.phone);
    if (!key) return;
    openLead(key);
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && rows[active]) {
      pick(rows[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const term = q.trim();
  const showMenu = open && term.length >= 2;

  return (
    <div className="global-search" ref={boxRef}>
      <Icon name="search" size={16} />
      <input
        ref={inputRef}
        type="search"
        value={q}
        placeholder="Search leads by name or phone"
        aria-label="Search leads"
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <kbd className="search-kbd">/</kbd>
      {showMenu && (
        <ul className="search-menu" role="listbox">
          {loading && rows.length === 0 ? (
            <li className="search-empty">Searching…</li>
          ) : rows.length === 0 ? (
            <li className="search-empty">No leads match “{term}”</li>
          ) : (
            rows.map((r, i) => (
              <li
                key={r.phoneKey || r.phone || i}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'search-item active' : 'search-item'}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
              >
                <span className="search-name">{r.name || 'Unnamed lead'}</span>
                <span className="search-sub">
                  {r.phone || r.phoneKey}
                  {r.ownerName ? ` · ${r.ownerName}` : ''}
                </span>
                {STAGE_LABEL[r.stage] && (
                  <span className={`badge stage-${r.stage}`}>{STAGE_LABEL[r.stage]}</span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
