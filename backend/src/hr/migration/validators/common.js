'use strict';

/**
 * common.js — PURE validation helpers shared by the per-kind validators.
 * No DB, no I/O. India statutory formats mirror the F4 self-onboarding rules.
 */

const money = require('../../payroll/money');

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UAN_RE = /^[0-9]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// ESIC insurance ("IP") number is 17 digits.
const ESIC_RE = /^[0-9]{17}$/;
// Deliberately permissive shape — must accept "+91 98765 43210" and "(022) 2345-6789".
// KEEP IN LOCKSTEP with PHONE_DIGITS in hr/controllers/employee.controller.js: if the
// importer is laxer than the controller, an imported employee carries a phone the edit
// form then refuses to save, and HR hits the error on a field they never touched.
const PHONE_RE = /^\+?[\d\s\-().]{7,20}$/;

/** True when a phone cell has an acceptable shape AND 7-15 actual digits. */
function isValidPhone(v) {
  const raw = String(v).trim();
  const digits = raw.replace(/\D/g, '');
  return PHONE_RE.test(raw) && digits.length >= 7 && digits.length <= 15;
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const finding = (code, severity, message, field) => ({ code, severity, ...(field ? { field } : {}), message });

/** Worst severity wins: ERROR > WARN > PASS. */
function rollupStatus(findings) {
  if (findings.some((f) => f.severity === 'ERROR')) return 'ERROR';
  if (findings.some((f) => f.severity === 'WARN')) return 'WARN';
  return 'PASS';
}

function isBlank(v) { return v == null || String(v).trim() === ''; }

/** Parse a Y/N (or true/false/1/0) cell to boolean | null. */
function toBool(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim().toLowerCase();
  if (['y', 'yes', 'true', '1'].includes(s)) return true;
  if (['n', 'no', 'false', '0'].includes(s)) return false;
  return null;
}

/** Coerce a major-unit ₹ string to integer minor units (paise). Throws on junk. */
function toMinor(major) {
  return money.toMinor(String(major).replace(/,/g, '').trim(), 2);
}

/** A number (days/hours) — returns NaN on junk. */
function toNumber(v) {
  if (isBlank(v)) return null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}

function isValidDate(s) {
  if (!DATE_RE.test(String(s))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidMonth(s) {
  if (!MONTH_RE.test(String(s))) return false;
  const m = Number(String(s).slice(5, 7));
  return m >= 1 && m <= 12;
}

/** [periodStart, periodEnd] (UTC ISO date strings) for a YYYY-MM month. */
function monthRange(periodMonth) {
  const y = Number(periodMonth.slice(0, 4));
  const m = Number(periodMonth.slice(5, 7));
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0)); // last day of month
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

module.exports = {
  PAN_RE, IFSC_RE, UAN_RE, EMAIL_RE, DATE_RE, MONTH_RE, ESIC_RE, PHONE_RE,
  finding, rollupStatus, isBlank, toBool, toMinor, toNumber, isValidPhone,
  isValidDate, isValidMonth, monthRange,
};
