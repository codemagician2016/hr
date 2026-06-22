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

// Resolve the logged-in employee id from the various customer-session shapes.
export function employeeIdOf(me) {
  return (
    me?.employee?.id ||
    me?.employeeId ||
    me?.customer?.employeeId ||
    me?.customer?.id ||
    me?.id ||
    null
  );
}
