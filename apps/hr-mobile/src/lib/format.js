// Formatting helpers shared across screens. Mirrors the web ESS contract:
// money values arrive as plain numbers / Decimal-ish strings (MAJOR units) or
// objects { amount|value, currency } / { minor, currency }. Only the explicit
// `minor` field is divided by 100 — the pure payroll engine uses minor units
// internally but the API serializes payslip lines as major-unit Decimals.

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
  return d.toLocaleDateString(
    undefined,
    opts || { day: '2-digit', month: 'short', year: 'numeric' }
  );
}

export function formatTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatPeriod(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (p.label) return p.label;
  if (p.periodLabel) return p.periodLabel;
  if (p.month && p.year) return `${p.month} ${p.year}`;
  if (p.periodStart && p.periodEnd) {
    return `${formatDate(p.periodStart)} – ${formatDate(p.periodEnd)}`;
  }
  return '';
}

export function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
