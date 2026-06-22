'use client';

// Searchable single-select for picking an employee's manager (Feature 1).
//
// Backs the `managerEmployeeId` field on the create/edit employee flows. Types
// query the same-tenant directory (GET /api/hr/employees?q=, already scope- and
// tenant-filtered server-side) and let the operator pick one report or clear it
// (a null manager = top of the chain, e.g. the CEO). Dependency-free; debounced.

import { useEffect, useRef, useState } from 'react';
import { get } from '@/lib/api';

function nameOf(emp) {
  if (!emp) return '';
  return [emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code || emp.id;
}

export default function ManagerPicker({ label = 'Manager', value, selectedLabel, onChange, excludeId, hint }) {
  // `value` = selected employeeId (or '' ); `selectedLabel` = display for a
  // pre-selected value loaded from the server (so we don't have to refetch).
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState(selectedLabel ? { id: value, label: selectedLabel } : null);
  const boxRef = useRef(null);

  useEffect(() => {
    if (selectedLabel) setChosen({ id: value, label: selectedLabel });
  }, [selectedLabel, value]);

  // Close on outside click.
  useEffect(() => {
    function onDoc(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      get('/api/hr/employees', { q, pageSize: 10 })
        .then((res) => {
          if (!alive) return;
          const items = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
          setResults(items.filter((e) => e.id !== excludeId));
        })
        .catch(() => {
          if (alive) setResults([]);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, open, excludeId]);

  function pick(emp) {
    setChosen({ id: emp.id, label: nameOf(emp) });
    onChange(emp.id);
    setOpen(false);
    setQuery('');
  }

  function clear() {
    setChosen(null);
    onChange('');
    setQuery('');
  }

  return (
    <div ref={boxRef} className="relative">
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>

      {chosen && chosen.id ? (
        <div className="flex items-center justify-between gap-2 w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm bg-white">
          <span className="truncate text-gray-900">{chosen.label}</span>
          <button type="button" onClick={clear} className="text-gray-400 hover:text-gray-700 text-sm shrink-0">
            Clear
          </button>
        </div>
      ) : (
        <input
          type="text"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          placeholder="Search employees…"
          className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)] text-sm bg-white"
        />
      )}

      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}

      {open && !(chosen && chosen.id) && (
        <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg">
          {loading ? (
            <div className="px-4 py-3 text-sm text-gray-400">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-400">No matching employees.</div>
          ) : (
            results.map((emp) => (
              <button
                key={emp.id}
                type="button"
                onClick={() => pick(emp)}
                className="block w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50"
              >
                <span className="font-medium text-gray-900">{nameOf(emp)}</span>
                {emp.code && <span className="text-gray-400"> · {emp.code}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
