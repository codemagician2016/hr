'use client';

// Feature 10 (ESS) — shared helpers for the unified Approvals inbox, the
// delegate-while-away form, and the "who will approve this?" submit hint.
//
// Plain-language + ⓘ tooltips per the owner's standing rules. Theme-token only
// (var(--theme-*)); no hardcoded colours.

import { useState, useId, useMemo } from 'react';

// ─── InfoTip (ⓘ) ─────────────────────────────────────────────────────────────
export function InfoTip({ text, label = 'More info' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!text) return null;
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-semibold leading-none"
        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 top-6 z-30 w-56 -translate-x-1/2 rounded-lg border bg-white px-3 py-2 text-xs font-normal leading-relaxed shadow-lg"
          style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

// ─── Pagination ──────────────────────────────────────────────────────────────
export function usePagination(items, { initialPageSize = 8 } = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageItems = useMemo(() => list.slice(start, start + pageSize), [list, start, pageSize]);
  return {
    page: safePage, pageSize, pageCount, total, start, end: Math.min(start + pageSize, total),
    pageItems, setPage,
    next: () => setPage((p) => Math.min(p + 1, pageCount)),
    prev: () => setPage((p) => Math.max(p - 1, 1)),
  };
}

export function Pagination({ pager }) {
  const { page, pageCount, total, start, end, next, prev } = pager;
  if (total === 0 || pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 py-3 text-sm" style={{ color: 'var(--theme-muted)' }}>
      <span>Showing {start + 1}–{end} of {total}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={prev} disabled={page <= 1} className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-40" style={{ borderColor: 'var(--theme-border)' }}>← Prev</button>
        <span className="text-xs">Page {page} / {pageCount}</span>
        <button type="button" onClick={next} disabled={page >= pageCount} className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-40" style={{ borderColor: 'var(--theme-border)' }}>Next →</button>
      </div>
    </div>
  );
}

// ─── module vocabulary (plain language, India-first) ─────────────────────────
export const MODULE_META = {
  LEAVE: { label: 'Leave', icon: 'M7 3v4M17 3v4M3 9h18M5 5h14v16H5z' },
  EXPENSE: { label: 'Reimbursement', icon: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6' },
  TRAVEL: { label: 'Travel', icon: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z' },
  COMPENSATION: { label: 'Salary change', icon: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6' },
  LOAN: { label: 'Loan', icon: 'M3 10h18M3 6h18v12H3zM7 15h4' },
  PROFILE_CHANGE: { label: 'Profile edit', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0' },
  ATTENDANCE_REGULARIZATION: { label: 'Attendance fix', icon: 'M12 8v4l3 2M12 3a9 9 0 100 18 9 9 0 000-18z' },
  SEPARATION: { label: 'Exit', icon: 'M16 17l5-5-5-5M21 12H9M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4' },
};
export function moduleMeta(m) {
  return MODULE_META[m] || { label: m, icon: 'M6 2h9l5 5v15H6zM15 2v5h5' };
}

// One-line plain-language summary of a request from its snapshot payload.
export function payloadLine(item) {
  const p = item.payload || {};
  if (item.module === 'LEAVE') {
    const span = p.startDate && p.endDate
      ? `${fmtDate(p.startDate)} – ${fmtDate(p.endDate)}`
      : '';
    const days = p.days != null ? `${p.days} day${Number(p.days) === 1 ? '' : 's'}` : '';
    return [p.leaveType, days, span].filter(Boolean).join(' · ') || 'Leave request';
  }
  if (item.module === 'EXPENSE' || item.module === 'TRAVEL') {
    const amt = p.amount != null ? money(p.amount) : '';
    return [amt, p.category, p.claimNumber].filter(Boolean).join(' · ') || 'Reimbursement claim';
  }
  // generic: show a few primitive fields
  const bits = Object.entries(p)
    .filter(([, v]) => v != null && (typeof v === 'string' || typeof v === 'number'))
    .slice(0, 3)
    .map(([, v]) => String(v));
  return bits.join(' · ') || `${moduleMeta(item.module).label} request`;
}

function fmtDate(v) {
  try { return new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); }
  catch { return String(v); }
}
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n); }
  catch { return `₹${n}`; }
}

// ─── SLA countdown ───────────────────────────────────────────────────────────
// Returns { text, tone } where tone ∈ 'ok' | 'warn' | 'over'. Pure; no timers.
export function slaInfo(slaDueAt) {
  if (!slaDueAt) return { text: 'No time limit', tone: 'ok' };
  const due = new Date(slaDueAt).getTime();
  if (Number.isNaN(due)) return { text: '', tone: 'ok' };
  const ms = due - Date.now();
  if (ms <= 0) return { text: 'Overdue', tone: 'over' };
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 1) return { text: 'Due within the hour', tone: 'warn' };
  if (hrs < 24) return { text: `${hrs}h left`, tone: hrs <= 4 ? 'warn' : 'ok' };
  const days = Math.round(hrs / 24);
  return { text: `${days} day${days === 1 ? '' : 's'} left`, tone: days <= 1 ? 'warn' : 'ok' };
}

export function ageText(createdAt) {
  if (!createdAt) return '';
  const ms = Date.now() - new Date(createdAt).getTime();
  const hrs = Math.floor(ms / 3_600_000);
  if (hrs < 1) return 'just now';
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
