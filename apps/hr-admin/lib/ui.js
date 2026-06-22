'use client';

// Small presentational helpers shared by the HR-admin domain screens.
// @hr/ui has no Table/Tabs/Badge primitive, so we keep these here and match
// the styled-table look established in app/people/page.js (rounded-2xl card,
// uppercase header row, hover rows). Pure presentation — no data fetching.

import { Empty, Spinner } from '@hr/ui';

export function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="flex items-start justify-between mb-6 gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 border-b border-gray-200 mb-5">
      {tabs.map((t) => {
        const on = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
              on ? 'text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
            style={on ? { borderBottomColor: 'var(--theme-primary)', color: 'var(--theme-primary)' } : undefined}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// Generic styled table card. `columns` = [{ key, header, render?, className? }].
// `rowKey` resolves a stable key per row. Renders Spinner / Empty states.
export function DataTable({ columns, rows, loading, emptyText = 'Nothing here yet.', rowKey, caption }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
      {loading ? (
        <div className="py-12 flex justify-center">
          <Spinner />
        </div>
      ) : !rows || rows.length === 0 ? (
        <Empty text={emptyText} />
      ) : (
        <table className="w-full text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
              {columns.map((c) => (
                <th key={c.key} scope="col" className={`px-4 py-3 font-medium ${c.className || ''}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={rowKey ? rowKey(row, i) : row.id ?? i}
                className="border-b border-gray-50 last:border-0 hover:bg-gray-50"
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-3 ${c.cellClassName || 'text-gray-700'}`}>
                    {c.render ? c.render(row) : row[c.key] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Status pill. Color is derived from a coarse semantic bucket so every domain
// (leave / expense / loan / payrun) shares one vocabulary.
const POSITIVE = new Set(['APPROVED', 'ACTIVE', 'FULFILLED', 'REIMBURSED', 'DISBURSED', 'CLOSED', 'CALCULATED', 'PAID', 'LOCKED']);
const PENDING = new Set(['PENDING', 'SUBMITTED', 'IN_PROGRESS', 'DRAFT', 'OPEN']);
const NEGATIVE = new Set(['REJECTED', 'CANCELLED', 'CANCELED', 'FAILED', 'EXPIRED']);
const INFO = new Set(['APPROVED_FOR_PAYROLL', 'COMPUTED', 'READY']);

export function StatusBadge({ status }) {
  const s = String(status || '').toUpperCase();
  let cls = 'bg-gray-100 text-gray-600 border-gray-200';
  if (POSITIVE.has(s)) cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
  else if (NEGATIVE.has(s)) cls = 'bg-red-50 text-red-700 border-red-200';
  else if (PENDING.has(s)) cls = 'bg-amber-50 text-amber-700 border-amber-200';
  else if (INFO.has(s)) cls = 'bg-blue-50 text-blue-700 border-blue-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  );
}

// Thin secondary button used for inline row actions (approve/reject/etc.).
export function ActionButton({ onClick, disabled, tone = 'neutral', children }) {
  const tones = {
    neutral: 'border-gray-300 text-gray-700 hover:bg-gray-50',
    positive: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50',
    danger: 'border-red-300 text-red-700 hover:bg-red-50',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1 text-xs font-medium border rounded-md disabled:opacity-40 disabled:cursor-not-allowed ${tones[tone] || tones.neutral}`}
    >
      {children}
    </button>
  );
}

// Resolve a person-ish display name from an embedded employee object or bare id.
export function employeeLabel(row) {
  const e = row.employee || row;
  const name = [e.firstName, e.lastName].filter(Boolean).join(' ');
  return name || e.name || e.code || row.employeeId || '—';
}

export function moneyish(value, currency) {
  if (value == null) return '—';
  const num = typeof value === 'object' && value.toNumber ? value.toNumber() : Number(value);
  if (Number.isNaN(num)) return String(value);
  const cur = currency || 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(num);
  } catch {
    return `${cur} ${num.toFixed(2)}`;
  }
}
