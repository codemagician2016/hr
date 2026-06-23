'use client';

// Feature 10 shared widgets for the owner-facing Approvals + RBAC UIs.
//
// These are intentionally small, dependency-free, and plain-language: the
// owner's standing rule is an ⓘ info tooltip on EVERY field/section (a
// non-technical admin must understand what it is + how to use it) and
// pagination on every list. Keep them here (not @hr/ui) so this slice is
// self-contained for merge.

import { useState, useId, useMemo } from 'react';

// ─── InfoTip (ⓘ) ─────────────────────────────────────────────────────────────
// A small circled-i that reveals a plain-language explanation on hover/focus.
// Accessible: the trigger is a real button, the bubble is aria-describedby-linked
// and toggles on click for touch + keyboard. Pure CSS positioning (no portal).
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
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-500 hover:border-gray-400 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-1"
        style={{ '--tw-ring-color': 'var(--theme-primary)' }}
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 top-6 z-30 w-60 -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-normal leading-relaxed text-gray-600 shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}

// A label row with an inline ⓘ tip. Used at the top of every section/field.
export function FieldLabel({ children, tip, htmlFor, className = '' }) {
  return (
    <label htmlFor={htmlFor} className={`flex items-center text-sm font-medium text-gray-700 mb-1 ${className}`}>
      {children}
      {tip && <InfoTip text={tip} />}
    </label>
  );
}

// A section heading with an inline ⓘ tip explaining the whole section.
export function SectionTitle({ children, tip, className = '' }) {
  return (
    <h2 className={`flex items-center text-sm font-semibold text-gray-900 ${className}`}>
      {children}
      {tip && <InfoTip text={tip} />}
    </h2>
  );
}

// ─── Pagination ──────────────────────────────────────────────────────────────
// Client-side pager. Give it the full list; it returns a slice + controls.
// (The approvals/rbac list endpoints don't paginate server-side, so we page in
// the client with clear Prev/Next + a page indicator + a page-size selector.)
export function usePagination(items, { initialPageSize = 10 } = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const pageItems = useMemo(() => list.slice(start, start + pageSize), [list, start, pageSize]);
  return {
    page: safePage,
    pageSize,
    pageCount,
    total,
    start,
    end: Math.min(start + pageSize, total),
    pageItems,
    setPage,
    setPageSize: (n) => { setPageSize(n); setPage(1); },
    next: () => setPage((p) => Math.min(p + 1, pageCount)),
    prev: () => setPage((p) => Math.max(p - 1, 1)),
  };
}

export function Pagination({ pager, sizes = [10, 25, 50], noun = 'items' }) {
  const { page, pageCount, total, start, end, next, prev, pageSize, setPageSize } = pager;
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-1 py-3 text-sm text-gray-600">
      <div className="flex items-center gap-2">
        <span>
          Showing <span className="font-medium text-gray-900">{total === 0 ? 0 : start + 1}</span>–
          <span className="font-medium text-gray-900">{end}</span> of{' '}
          <span className="font-medium text-gray-900">{total}</span> {noun}
        </span>
        <label className="ml-2 inline-flex items-center gap-1 text-gray-500">
          <span className="sr-only">Rows per page</span>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs"
          >
            {sizes.map((s) => (
              <option key={s} value={s}>
                {s} / page
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={prev}
          disabled={page <= 1}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          ← Prev
        </button>
        <span className="text-xs text-gray-500">
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          onClick={next}
          disabled={page >= pageCount}
          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// ─── Shared domain vocabulary (plain language) ───────────────────────────────

// The 8 owner-facing Processes (a curated subset of WorkflowModule, India-first:
// we surface the SME-relevant modules and keep the technical enum out of sight).
export const PROCESSES = [
  { module: 'LEAVE', label: 'Leave', icon: 'leaf', hint: 'Time off requests — casual, sick, earned leave.' },
  { module: 'EXPENSE', label: 'Reimbursement', icon: 'receipt', hint: 'Money your team spends and claims back — taxi, meals, supplies.' },
  { module: 'TRAVEL', label: 'Travel', icon: 'send', hint: 'Trip requests — flights, hotels, on-site visits.' },
  { module: 'COMPENSATION', label: 'Salary change', icon: 'coin', hint: 'Pay revisions, increments and promotions.' },
  { module: 'LOAN', label: 'Loan', icon: 'loan', hint: 'Salary advances and staff loans.' },
  { module: 'PROFILE_CHANGE', label: 'Profile edit', icon: 'user', hint: 'Changes an employee makes to their own details (bank account, address).' },
  { module: 'ATTENDANCE_REGULARIZATION', label: 'Attendance fix', icon: 'clock', hint: 'Correcting a missed or wrong clock-in / clock-out.' },
  { module: 'SEPARATION', label: 'Exit', icon: 'exit', hint: 'Resignation and exit requests.' },
];

export const PROCESS_BY_MODULE = Object.fromEntries(PROCESSES.map((p) => [p.module, p]));

export function moduleLabel(module) {
  return PROCESS_BY_MODULE[module]?.label || module;
}

// "Who approves?" choices — the plain-language face of ApproverType (+ the N-up
// packing into approverRefId for REPORTING_MANAGER).
export const WHO_OPTIONS = [
  { key: 'MANAGER_1', label: 'My manager', approverType: 'REPORTING_MANAGER', refId: '1', hint: 'The person this employee reports to.' },
  { key: 'MANAGER_2', label: "My manager's manager (2 levels up)", approverType: 'REPORTING_MANAGER', refId: '2', hint: 'Skip a level — go two steps up the reporting line.' },
  { key: 'MANAGER_ALL', label: 'Everyone up the chain', approverType: 'REPORTING_MANAGER', refId: 'ALL', hint: 'Each manager in turn, all the way to the top.' },
  { key: 'DEPARTMENT_HEAD', label: 'Department head', approverType: 'DEPARTMENT_HEAD', refId: null, hint: 'The head of the requester’s department.' },
  { key: 'HR', label: 'Anyone in HR', approverType: 'HR', refId: null, hint: 'Any HR team member can approve.' },
  { key: 'PAYROLL_MANAGER', label: 'Payroll / Finance', approverType: 'PAYROLL_MANAGER', refId: null, hint: 'Anyone who can run payroll.' },
  { key: 'SPECIFIC_ROLE', label: 'A role…', approverType: 'SPECIFIC_ROLE', refId: '', hint: 'Anyone holding a particular role (e.g. “Finance”).' },
  { key: 'SPECIFIC_EMPLOYEE', label: 'A specific person…', approverType: 'SPECIFIC_EMPLOYEE', refId: '', hint: 'One named person — great for a small team with no org chart.' },
  { key: 'AUTO_APPROVE', label: 'Nobody — auto-approve', approverType: 'AUTO_APPROVE', refId: null, hint: 'Granted automatically the moment it’s filed.' },
];

// Map a stored step back to a WHO option key (for editing an existing chain).
export function whoKeyForStep(step) {
  if (step.approverType === 'REPORTING_MANAGER') {
    const n = String(step.approverRefId || '1');
    if (n === 'ALL') return 'MANAGER_ALL';
    if (n === '2') return 'MANAGER_2';
    return 'MANAGER_1';
  }
  const found = WHO_OPTIONS.find(
    (o) => o.approverType === step.approverType && !o.key.startsWith('MANAGER_')
  );
  return found ? found.key : 'MANAGER_1';
}

export const TIMEOUT_LABELS = {
  REMIND: 'Remind them again',
  ESCALATE: 'Escalate to their manager',
  AUTO_APPROVE: 'Auto-approve it',
  AUTO_REJECT: 'Auto-decline it',
};
