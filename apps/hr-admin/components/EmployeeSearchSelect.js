'use client';

// EmployeeSearchSelect — a reusable, premium searchable employee combobox.
//
// The friendly replacement for the "Search by name or code…" boxes scattered
// across hr-admin. On focus/click it opens a DROPDOWN LIST of employees (the
// first N most-recent by default) and filters AS YOU TYPE by name + employee
// code/ID + work email. The search runs SERVER-SIDE against the existing
// `GET /api/hr/employees?q=&page=&pageSize=` endpoint (F1-scoped + paginated),
// debounced, so it scales to 1000+ employees without loading the directory
// client-side. Infinite-scroll pulls the next page as the operator scrolls.
//
// Each row shows an avatar (initials) + name + code + designation/department.
// Keyboard-navigable (↑/↓ + Enter + Esc), has a clear button, is accessible
// (combobox/listbox ARIA, aria-activedescendant), and carries an ⓘ tooltip.
// Renders explicit loading + "no matches" states.
//
// onSelect contract is preserved at every call-site: it fires with the FULL
// employee object, and the caller derives whatever shape it needs (id, label,
// or the whole record). `value`/`selectedLabel` pre-fill a chosen employee
// loaded from the server without a refetch.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { get } from '@/lib/api';

const DEFAULT_PAGE_SIZE = 20;
const DEBOUNCE_MS = 250;

// Human display name for an employee record (mirrors lib/ui.employeeLabel but
// kept local so the component is drop-in and dependency-light).
export function employeeName(emp) {
  if (!emp) return '';
  const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ');
  return name || emp.preferredName || emp.name || emp.code || emp.id || '';
}

// Up-to-two-letter initials for the avatar.
function initialsOf(emp) {
  const n = employeeName(emp).trim();
  if (!n) return '–';
  const parts = n.split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || n[0].toUpperCase();
}

// The dept/designation sub-line ("Engineer · Platform"), omitting blanks.
function subLineOf(emp) {
  const desig = emp?.designation?.name || emp?.designation?.title || emp?.jobTitle;
  const dept = emp?.department?.name;
  return [desig, dept].filter(Boolean).join(' · ');
}

function Avatar({ emp }) {
  const url = emp?.photoUrl || emp?.avatarUrl;
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={url}
        alt=""
        className="h-8 w-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
      style={{ background: 'var(--theme-primary-soft, #eef2ff)', color: 'var(--theme-primary, #4f46e5)' }}
    >
      {initialsOf(emp)}
    </span>
  );
}

// ⓘ tip — circled "i" that reveals help text on hover/focus. Matches the
// Letters InfoTip affordance so the look is consistent across hr-admin.
function InfoTip({ text, label }) {
  if (!text) return null;
  return (
    <span
      className="ml-1 inline-flex h-4 w-4 cursor-help select-none items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-500 align-middle hover:border-gray-400 hover:text-gray-700"
      title={text}
      tabIndex={0}
      role="img"
      aria-label={`${label ? `${label}: ` : 'Help: '}${text}`}
    >
      i
    </span>
  );
}

export default function EmployeeSearchSelect({
  label,
  tip,
  value = '',                 // selected employeeId ('' when none)
  selectedLabel,              // display for a server-pre-filled value (no refetch)
  onSelect,                   // (employee | null) => void — fires with the FULL row
  placeholder = 'Search by name, code or email…',
  status,                     // optional EmployeeStatus filter (e.g. 'ACTIVE')
  excludeId,                  // optional id to hide from results (e.g. self)
  pageSize = DEFAULT_PAGE_SIZE,
  hint,
  disabled = false,
  required = false,
  allowClear = true,
  autoFocus = false,
  emptyText = 'No matching employees.',
  id: idProp,
}) {
  const reactId = useId();
  const baseId = idProp || `emp-select-${reactId}`;
  const listboxId = `${baseId}-listbox`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);      // highlighted row index
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [chosen, setChosen] = useState(
    value && selectedLabel ? { id: value, label: selectedLabel } : null
  );

  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const loadingMoreRef = useRef(false);   // guards infinite-scroll double-fetch
  const seqRef = useRef(0);               // discards stale responses

  // Keep the chosen chip in sync when the parent updates value/selectedLabel
  // (e.g. Letters "Issue this" pre-fills a request's employee).
  useEffect(() => {
    if (value && selectedLabel) setChosen({ id: value, label: selectedLabel });
    else if (!value) setChosen(null);
  }, [value, selectedLabel]);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const fetchPage = useCallback(
    async (q, pageNo, { append }) => {
      const seq = ++seqRef.current;
      if (append) loadingMoreRef.current = true;
      else setLoading(true);
      try {
        const params = { q: q.trim(), page: pageNo, pageSize };
        if (status) params.status = status;
        const res = await get('/api/hr/employees', params);
        if (seq !== seqRef.current) return; // a newer request superseded this one
        const rows = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        const filtered = excludeId ? rows.filter((e) => e.id !== excludeId) : rows;
        const tot = Number(res?.total) || 0;
        setTotal(tot);
        setItems((prev) => {
          const next = append ? [...prev, ...filtered] : filtered;
          // hasMore = the server says there are more rows than we've loaded.
          setHasMore(tot ? next.length < tot : filtered.length === pageSize);
          return next;
        });
      } catch {
        if (seq !== seqRef.current) return;
        if (!append) { setItems([]); setTotal(0); setHasMore(false); }
      } finally {
        if (seq === seqRef.current) {
          if (append) loadingMoreRef.current = false;
          else setLoading(false);
        }
      }
    },
    [pageSize, status, excludeId]
  );

  // Debounced search whenever the query changes while open. Resets to page 1.
  useEffect(() => {
    if (!open) return undefined;
    const h = setTimeout(() => {
      setPage(1);
      setActive(-1);
      fetchPage(query, 1, { append: false });
    }, DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [query, open, fetchPage]);

  function openList() {
    if (disabled) return;
    setOpen(true);
  }

  function loadMore() {
    if (loadingMoreRef.current || !hasMore || loading) return;
    const nextPage = page + 1;
    setPage(nextPage);
    fetchPage(query, nextPage, { append: true });
  }

  function onScroll(e) {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) loadMore();
  }

  function pick(emp) {
    setChosen({ id: emp.id, label: employeeName(emp) });
    onSelect?.(emp);
    setOpen(false);
    setQuery('');
    setActive(-1);
  }

  function clear() {
    setChosen(null);
    onSelect?.(null);
    setQuery('');
    setActive(-1);
    // Re-open the search so the operator can immediately pick another.
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { openList(); return; }
      setActive((i) => Math.min((i < 0 ? -1 : i) + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && items[active]) {
        e.preventDefault();
        pick(items[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); }
    } else if (e.key === 'Home' && open) {
      e.preventDefault();
      setActive(items.length ? 0 : -1);
    } else if (e.key === 'End' && open) {
      e.preventDefault();
      setActive(items.length - 1);
    }
  }

  // Keep the active row scrolled into view as the operator arrows through.
  useEffect(() => {
    if (!open || active < 0 || !listRef.current) return;
    const node = listRef.current.querySelector(`[data-idx="${active}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const showChip = !!(chosen && chosen.id);
  const labelText = typeof label === 'string' ? label : undefined;

  const footer = useMemo(() => {
    if (loading || items.length === 0) return null;
    if (total > items.length) {
      return `Showing ${items.length} of ${total} — keep typing to narrow, or scroll for more`;
    }
    return `${items.length} ${items.length === 1 ? 'employee' : 'employees'}`;
  }, [loading, items.length, total]);

  return (
    <div ref={rootRef} className="relative">
      {label && (
        <label htmlFor={baseId} className="block text-sm font-medium text-gray-700 mb-1">
          {label}
          <InfoTip text={tip} label={labelText} />
        </label>
      )}

      {showChip ? (
        // Selected-state chip: avatar + name + code, with a clear button.
        <div className="flex items-center justify-between gap-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
          <span className="flex items-center gap-2 min-w-0">
            <Avatar emp={{ firstName: chosen.label }} />
            <span className="truncate font-medium text-gray-900">{chosen.label}</span>
          </span>
          {allowClear && !disabled && (
            <button
              type="button"
              onClick={clear}
              className="shrink-0 rounded text-xs font-medium text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]"
              aria-label="Clear selected employee"
            >
              Clear
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <input
            id={baseId}
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${baseId}-opt-${active}` : undefined}
            aria-required={required || undefined}
            autoComplete="off"
            disabled={disabled}
            autoFocus={autoFocus}
            value={query}
            placeholder={placeholder}
            onFocus={openList}
            onClick={openList}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onKeyDown={onKeyDown}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 pr-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)] disabled:bg-gray-50 disabled:text-gray-400"
          />
          {/* search / clear-query affordance */}
          {query ? (
            <button
              type="button"
              onClick={() => { setQuery(''); setOpen(true); inputRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              aria-label="Clear search"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          ) : (
            <svg
              className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300"
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          )}
        </div>
      )}

      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}

      {open && !showChip && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={labelText || 'Employees'}
            onScroll={onScroll}
            className="max-h-72 overflow-y-auto py-1"
          >
            {loading ? (
              <li className="flex items-center gap-2 px-3 py-4 text-sm text-gray-400">
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.4 0 0 5.4 0 12h4z" />
                </svg>
                Searching…
              </li>
            ) : items.length === 0 ? (
              <li className="px-3 py-6 text-center text-sm text-gray-400">{emptyText}</li>
            ) : (
              items.map((emp, idx) => {
                const sub = subLineOf(emp);
                const isActive = idx === active;
                return (
                  <li
                    key={emp.id}
                    id={`${baseId}-opt-${idx}`}
                    data-idx={idx}
                    role="option"
                    aria-selected={emp.id === value}
                  >
                    <button
                      type="button"
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => pick(emp)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm"
                      style={isActive ? { background: 'var(--theme-primary-soft, #f3f4f6)' } : undefined}
                    >
                      <Avatar emp={emp} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="truncate font-medium text-gray-900">{employeeName(emp)}</span>
                          {emp.code && <span className="shrink-0 text-xs text-gray-400">{emp.code}</span>}
                        </span>
                        {(sub || emp.workEmail) && (
                          <span className="block truncate text-xs text-gray-500">
                            {sub || emp.workEmail}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
            {!loading && hasMore && (
              <li className="px-3 py-2 text-center text-xs text-gray-400">Loading more…</li>
            )}
          </ul>
          {footer && (
            <div className="border-t border-gray-100 bg-gray-50 px-3 py-1.5 text-[11px] text-gray-400">
              {footer}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
