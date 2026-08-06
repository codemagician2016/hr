// Shared admin-shell UI primitives + formatters.
//
// Originally lived inline in [slug]/admin/page.js. Extracted 2026-04-29
// as part of the admin-page split — every extracted tab imports from here
// instead of redefining its own Spinner/Modal/formatMoneyMinor/etc.
//
// Vertical isolation rule: this file is ALLOWED to be imported by any
// admin tab in any vertical because it's pure presentation primitives,
// not vertical-specific business logic.
'use client';

// ─── UI primitives ────────────────────────────────────────────────────

export function Spinner({ small }) {
  const size = small ? 'h-4 w-4' : 'h-8 w-8';
  return (
    <svg className={`animate-spin ${size}`} style={{ color: 'var(--theme-primary, #4f46e5)' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

export function Centered({ children }) {
  return <div className="min-h-screen flex items-center justify-center">{children}</div>;
}

export function ErrorBanner({ message }) {
  return <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-2">{message}</p>;
}

export function Empty({ text }) {
  return <div className="py-10 text-center text-sm text-gray-500">{text}</div>;
}

export function Modal({ title, onClose, children, size = 'sm' }) {
  // size: 'sm' (default — forms, confirmations) | 'lg' (rich modals with
  // tables / plan pickers / multi-section bodies).
  const widthClass = size === 'lg' ? 'max-w-2xl' : 'max-w-md';
  return (
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/30 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className={`bg-white rounded-2xl w-full ${widthClass} max-h-[calc(100vh-2rem)] flex flex-col my-4`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-gray-100 flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none" aria-label="Close">×</button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">
          {children}
        </div>
      </div>
    </div>
  );
}

export function ModalActions({ children }) {
  return <div className="flex gap-2 justify-end">{children}</div>;
}

export function PrimaryButton({ onClick, type = 'button', loading, disabled, children }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={loading || disabled}
      className="px-4 py-2 text-white text-sm font-semibold rounded-lg inline-flex items-center gap-2 transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
      style={{ backgroundColor: 'var(--theme-primary)' }}
    >
      {loading && <Spinner small />}
      {children}
    </button>
  );
}

// CONTRACT — read this before wiring one up:
//   onChange receives the STRING VALUE, not the DOM event.
//     right:  onChange={(v) => setName(v)}
//     wrong:  onChange={(e) => setName(e.target.value)}   ← e is the string;
//                                                          e.target is undefined
//   The wrong form does not fail at build or on render — it throws on the FIRST
//   KEYSTROKE, so the field simply refuses to accept typing and looks disabled.
//   It cost a real "unable to type in new job form" report, across 18 call sites.
//   TextArea, DateInput and TimeInput below share this contract.
export function TextInput({ label, value, onChange, type = 'text', required, hint, min, max, step, maxLength, pattern, placeholder }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        min={min}
        max={max}
        step={step}
        maxLength={maxLength}
        pattern={pattern}
        placeholder={placeholder}
        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm"
      />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

// Bare date / time input with the admin's standard styling — designed
// for inline use in tables and tight rows where the labelled `DateField`
// / `TimeField` wrappers below would be too heavy. Same className
// surface across the admin so a future styling change lands in one
// place.
const DATE_TIME_INPUT_CLASS = 'px-2 py-1.5 border border-gray-300 rounded-md focus:outline-none text-sm';

export function DateInput({ value, onChange, min, max, required, className = '', ...rest }) {
  return (
    <input
      type="date"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      min={min}
      max={max}
      required={required}
      className={`${DATE_TIME_INPUT_CLASS} ${className}`}
      {...rest}
    />
  );
}

export function TimeInput({ value, onChange, min, max, required, className = '', ...rest }) {
  return (
    <input
      type="time"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      min={min}
      max={max}
      required={required}
      className={`${DATE_TIME_INPUT_CLASS} ${className}`}
      {...rest}
    />
  );
}

// Labelled variants — same shape as TextInput so they drop into form
// columns naturally. minToday=true sets the min attr to today's date so
// admins can't pick a past date by accident.
function todayIso() { return new Date().toISOString().slice(0, 10); }

export function DateField({ label, value, onChange, required, hint, min, max, minToday }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}{required ? ' *' : ''}</label>
      <DateInput
        value={value}
        onChange={onChange}
        required={required}
        min={min ?? (minToday ? todayIso() : undefined)}
        max={max}
        className="w-full"
      />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

export function TimeField({ label, value, onChange, required, hint, min, max }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}{required ? ' *' : ''}</label>
      <TimeInput
        value={value}
        onChange={onChange}
        required={required}
        min={min}
        max={max}
        className="w-full"
      />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

export function TextArea({ label, value, onChange, maxLength, rows = 3, hint }) {
  const len = typeof value === 'string' ? value.length : 0;
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <textarea
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        maxLength={maxLength}
        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm"
      />
      {(hint || maxLength) && (
        <div className="flex justify-between mt-1">
          {hint && <p className="text-xs text-gray-500">{hint}</p>}
          {maxLength && <p className="text-xs text-gray-400 ml-auto">{len} / {maxLength}</p>}
        </div>
      )}
    </div>
  );
}

// ─── Formatters ──────────────────────────────────────────────────────

export function formatAdminDate(value) {
  if (!value) return '—';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return '—';
  }
}

export function formatAdminDateTime(value) {
  if (!value) return '—';
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function formatMoneyMinor(minor, currencyCode = 'USD') {
  if (minor == null || currencyCode == null) return '—';
  const upper = String(currencyCode).toUpperCase();
  const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
  const threeDecimal = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
  const divisor = zeroDecimal.has(upper) ? 1 : threeDecimal.has(upper) ? 1000 : 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: upper,
    }).format(Number(minor) / divisor);
  } catch {
    return `${upper} ${(Number(minor) / divisor).toFixed(divisor === 1 ? 0 : divisor === 1000 ? 3 : 2)}`;
  }
}

export function billingStatusClass(status) {
  switch (String(status || '').toUpperCase()) {
    case 'ACTIVE': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    case 'TRIAL': return 'bg-blue-100 text-blue-700 border-blue-200';
    case 'TRIALING': return 'bg-blue-100 text-blue-700 border-blue-200';
    case 'CANCEL_SCHEDULED': return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'PAST_DUE': return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'PAUSED': return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'EXPIRED': return 'bg-gray-100 text-gray-600 border-gray-200';
    case 'CANCELED': return 'bg-red-100 text-red-700 border-red-200';
    case 'CANCELLED': return 'bg-red-100 text-red-700 border-red-200';
    default: return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

export function billingTransactionStatusClass(status) {
  switch (String(status || '').toUpperCase()) {
    case 'COMPLETED': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    case 'PAID': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
    case 'BILLED': return 'bg-blue-100 text-blue-700 border-blue-200';
    case 'PAST_DUE': return 'bg-amber-100 text-amber-700 border-amber-200';
    case 'DRAFT': return 'bg-indigo-100 text-indigo-700 border-indigo-200';
    case 'READY': return 'bg-indigo-100 text-indigo-700 border-indigo-200';
    case 'CANCELLED': return 'bg-gray-100 text-gray-600 border-gray-200';
    case 'CANCELED': return 'bg-gray-100 text-gray-600 border-gray-200';
    default: return 'bg-gray-100 text-gray-600 border-gray-200';
  }
}

export function capitalizeSlug(value) {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  return raw
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
