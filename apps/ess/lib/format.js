'use client';

// Shared formatters for the ESS app. Money values arrive from the backend in a
// few shapes: a plain number, a Decimal-ish string, or an object
// { amount, currency } / { minor, currency }. The pure payroll engine works in
// integer minor units but the API serializes payslip lines as major-unit
// Decimals, so we treat bare numbers/strings as MAJOR units and only divide by
// 100 when a `minor` field is explicitly present.

export function money(value, fallbackCurrency = 'INR') {
  if (value == null || value === '') return '—';

  let amount;
  let currency = fallbackCurrency;

  if (typeof value === 'object') {
    currency = value.currency || value.currencyCode || fallbackCurrency;
    if (value.minor != null) amount = Number(value.minor) / 100;
    else if (value.amount != null) amount = Number(value.amount);
    else if (value.value != null) amount = Number(value.value);
    else return '—';
  } else {
    amount = Number(value);
  }

  if (!Number.isFinite(amount)) return '—';

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function formatDate(value, opts) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString(undefined, opts || { day: '2-digit', month: 'short', year: 'numeric' });
}

// Compact relative time ("just now", "5m ago", "3h ago", "2d ago", "4w ago") for
// social timestamps (comments, notifications). Falls back to an absolute date once
// the gap is large, and degrades to '' for an unparseable/absent value. Future
// timestamps (clock skew) read as "just now" rather than a negative age.
export function relativeTime(value) {
  if (!value) return '';
  const d = new Date(value);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return formatDate(value, { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Period label for a payslip/pay run period from a variety of payload shapes.
export function formatPeriod(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (p.label) return p.label;
  if (p.periodLabel) return p.periodLabel;
  if (p.month && p.year) return `${p.month} ${p.year}`;
  if (p.periodStart && p.periodEnd) {
    return `${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}`;
  }
  if (p.periodStart) return formatDate(p.periodStart);
  return p.id || '';
}

// Resolve the logged-in employee id from the customer-session shapes.
//
// IMPORTANT (audit #55): the customer/session id is NOT the employee id. The
// authoritative employeeId is resolved SERVER-SIDE from the session by the
// /api/hr/me/* surfaces (and exposed by /api/hr/me/profile.profile.employeeId).
// We therefore only read an id that is genuinely an employee anchor here, and
// NEVER fall back to me.customer.id / me.id — passing the customer id as an
// employeeId queried the WRONG subject for every self-service read. When none is
// present, callers rely on the self-deriving /me/* endpoints (preferred).
export function employeeIdOf(me) {
  return (
    me?.employee?.id ||
    me?.employeeId ||
    me?.customer?.employeeId ||
    me?.profile?.employeeId ||
    null
  );
}
