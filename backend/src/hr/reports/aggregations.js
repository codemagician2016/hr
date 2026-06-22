'use strict';

/**
 * aggregations.js — PURE report aggregation functions for the HR reports layer.
 *
 * These functions take already-fetched, plain rows (no Prisma, no I/O) and
 * fold them into report shapes. Keeping them pure makes the money math
 * unit-testable without a database (see aggregations.test.js) and keeps the
 * controller a thin prisma↔fn wiring layer.
 *
 * Money handling: amounts arrive as Prisma Decimal | string | number. We never
 * do floating-point math on the raw inputs — every amount is summed in integer
 * minor units (cents/paise) via `toMinor`, then rendered back with `fromMinor`.
 * This makes "register total == sum of line totals" exact for 2-dp currencies.
 */

// ── money helpers (integer minor units) ──────────────────────────────────────

/** Coerce a Decimal | string | number | null into a Number (NaN-safe → 0). */
function toNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && typeof v.toNumber === 'function') return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round a money value to integer minor units (cents) — half-up, sign-safe. */
function toMinor(v) {
  const n = toNumber(v);
  return Math.round(n * 100);
}

/** Render integer minor units back to a 2-dp Number. */
function fromMinor(minor) {
  return Math.round(minor) / 100;
}

/** Sum a list of money values exactly in minor units, returning a 2-dp Number. */
function sumMoney(values) {
  let acc = 0;
  for (const v of values) acc += toMinor(v);
  return fromMinor(acc);
}

// ── 1. Payroll register ───────────────────────────────────────────────────────

/**
 * Build a payroll register for a pay run from its PayRunLine rows.
 *
 * @param {Object} args
 * @param {Object} args.run    minimal run header { id, code, currencyCode, ... }
 * @param {Array}  args.lines  PayRunLine rows, each optionally carrying
 *                             `employee` ({code,firstName,lastName}) and
 *                             `payslip` (for net cross-check). Money fields:
 *                             grossEarnings, totalDeductions, netPay, employerCost.
 * @returns {{ run, currencyCode, rows, totals }}
 *   rows: per-employee { employeeId, employeeCode, employeeName, gross,
 *         deductions, net, employerCost }
 *   totals: column totals { gross, deductions, net, employerCost, headcount }
 */
function buildPayrollRegister({ run, lines } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const currencyCode = (run && run.currencyCode) || (list[0] && list[0].currencyCode) || 'USD';

  const rows = list.map((l) => {
    const emp = l.employee || {};
    const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.name || null;
    return {
      lineId: l.id,
      employeeId: l.employeeId,
      employeeCode: emp.code || null,
      employeeName: name,
      currencyCode: l.currencyCode || currencyCode,
      gross: fromMinor(toMinor(l.grossEarnings)),
      deductions: fromMinor(toMinor(l.totalDeductions)),
      net: fromMinor(toMinor(l.netPay)),
      employerCost: fromMinor(toMinor(l.employerCost)),
    };
  });

  const totals = {
    gross: sumMoney(rows.map((r) => r.gross)),
    deductions: sumMoney(rows.map((r) => r.deductions)),
    net: sumMoney(rows.map((r) => r.net)),
    employerCost: sumMoney(rows.map((r) => r.employerCost)),
    headcount: rows.length,
  };

  return {
    run: run ? { id: run.id, code: run.code, status: run.status, periodStart: run.periodStart, periodEnd: run.periodEnd, payDate: run.payDate, entityId: run.entityId } : null,
    currencyCode,
    rows,
    totals,
  };
}

// ── 2. Statutory summary ──────────────────────────────────────────────────────

// Which PayRunLine columns roll up for each country's statutory return.
const IN_STATUTORY_FIELDS = [
  { key: 'pfEmployee', label: 'PF (employee)', group: 'PF' },
  { key: 'pfEmployer', label: 'PF (employer)', group: 'PF' },
  { key: 'esiEmployee', label: 'ESI (employee)', group: 'ESI' },
  { key: 'esiEmployer', label: 'ESI (employer)', group: 'ESI' },
  { key: 'pt', label: 'Professional Tax', group: 'PT' },
  { key: 'tds', label: 'TDS', group: 'TDS' },
];
const NZ_STATUTORY_FIELDS = [
  { key: 'paye', label: 'PAYE', group: 'PAYE' },
  { key: 'kiwiSaverEmployee', label: 'KiwiSaver (employee)', group: 'KIWISAVER' },
  { key: 'kiwiSaverEmployer', label: 'KiwiSaver (employer)', group: 'KIWISAVER' },
  { key: 'esct', label: 'ESCT', group: 'ESCT' },
  { key: 'accLevy', label: 'ACC levy', group: 'ACC' },
  { key: 'studentLoan', label: 'Student loan', group: 'STUDENT_LOAN' },
];

/**
 * Roll up statutory contributions for a pay run / period from PayRunLine rows.
 * Country is inferred from the entity (passed in) and selects the column set;
 * each contribution sums exactly in minor units.
 *
 * @param {Object} args
 * @param {Array}  args.lines       PayRunLine rows (with statutory columns)
 * @param {String} args.countryCode 'IN' | 'NZ' (case-insensitive)
 * @param {String} [args.currencyCode]
 * @param {String} [args.taxPeriod] e.g. "2026-06" (passthrough for the challan)
 * @returns {{ countryCode, currencyCode, taxPeriod, items, total, headcount }}
 *   items: [{ key, label, group, amount }]
 *   total: grand total of all statutory amounts (employer + employee)
 */
function buildStatutorySummary({ lines, countryCode, currencyCode, taxPeriod } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const cc = String(countryCode || '').toUpperCase();
  const fields = cc === 'NZ' ? NZ_STATUTORY_FIELDS : IN_STATUTORY_FIELDS;
  const cur = currencyCode || (list[0] && list[0].currencyCode) || (cc === 'NZ' ? 'NZD' : 'INR');

  const items = fields.map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    amount: sumMoney(list.map((l) => l[f.key])),
  }));

  // Group rollup (PF total = employee + employer, etc.) for the challan view.
  const groups = {};
  for (const it of items) {
    groups[it.group] = fromMinor(toMinor(groups[it.group] || 0) + toMinor(it.amount));
  }

  return {
    countryCode: cc === 'NZ' ? 'NZ' : 'IN',
    currencyCode: cur,
    taxPeriod: taxPeriod || null,
    items,
    groups: Object.entries(groups).map(([group, amount]) => ({ group, amount })),
    total: sumMoney(items.map((i) => i.amount)),
    headcount: list.length,
  };
}

// ── 3. Headcount & attrition ──────────────────────────────────────────────────

/** Parse a date-ish value to a Date (or null). */
function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when `d` falls within [start, end] inclusive (any null bound = open). */
function inWindow(d, start, end) {
  if (!d) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

/**
 * Headcount & attrition over a period, bucketed by a chosen dimension.
 *
 * @param {Object} args
 * @param {Array}  args.employees  rows enriched with { id, status, hireDate,
 *                                  terminationDate, departmentId, departmentName,
 *                                  entityId, entityName }
 * @param {Date|string} args.periodStart
 * @param {Date|string} args.periodEnd
 * @param {'department'|'entity'} [args.groupBy='department']
 * @returns {{ groupBy, periodStart, periodEnd, totals, buckets }}
 *   totals/bucket: { active, joined, terminated, headcount }
 *     - active:      currently isActive / not TERMINATED-RETIRED
 *     - joined:      hireDate within the window
 *     - terminated:  terminationDate within the window
 *     - headcount:   total rows in the bucket
 */
function buildHeadcount({ employees, periodStart, periodEnd, groupBy = 'department' } = {}) {
  const list = Array.isArray(employees) ? employees : [];
  const start = toDate(periodStart);
  const end = toDate(periodEnd);
  const dim = groupBy === 'entity' ? 'entity' : 'department';

  const INACTIVE = new Set(['TERMINATED', 'RETIRED']);
  const buckets = new Map();

  function bucketFor(e) {
    const id = dim === 'entity' ? (e.entityId || '—') : (e.departmentId || '—');
    const name = dim === 'entity' ? (e.entityName || 'Unassigned') : (e.departmentName || 'Unassigned');
    if (!buckets.has(id)) buckets.set(id, { key: id, label: name, active: 0, joined: 0, terminated: 0, headcount: 0 });
    return buckets.get(id);
  }

  const totals = { active: 0, joined: 0, terminated: 0, headcount: 0 };

  for (const e of list) {
    const b = bucketFor(e);
    b.headcount += 1;
    totals.headcount += 1;

    const isActive = e.isActive !== false && !INACTIVE.has(String(e.status || '').toUpperCase());
    if (isActive) { b.active += 1; totals.active += 1; }

    if (inWindow(toDate(e.hireDate), start, end)) { b.joined += 1; totals.joined += 1; }
    if (inWindow(toDate(e.terminationDate), start, end)) { b.terminated += 1; totals.terminated += 1; }
  }

  // Attrition rate: terminations in window / active headcount (guard /0).
  const attritionRate = totals.active > 0 ? Math.round((totals.terminated / totals.active) * 10000) / 100 : 0;

  return {
    groupBy: dim,
    periodStart: start ? start.toISOString().slice(0, 10) : null,
    periodEnd: end ? end.toISOString().slice(0, 10) : null,
    totals: { ...totals, attritionRate },
    buckets: Array.from(buckets.values()).sort((a, b) => b.headcount - a.headcount),
  };
}

// ── 4. Leave liability ────────────────────────────────────────────────────────

/**
 * Value outstanding leave balances. Each balance carries a `closing` quantity
 * (DAYS/HOURS/WEEKS) and an optional per-unit valuation `dayRate` (derived by
 * the caller from compensation). NZ annual leave may instead carry a
 * pre-valued `nzAccruedGrossEarnings` money figure, which we prefer when present.
 *
 * @param {Object} args
 * @param {Array}  args.balances  LeaveBalance rows enriched with { closing, unit,
 *                                dayRate, nzAccruedGrossEarnings, employeeId,
 *                                leaveTypeId, leaveTypeName, currencyCode }
 * @param {String} [args.currencyCode]
 * @returns {{ currencyCode, totalDays, totalValue, byType, rows }}
 */
function buildLeaveLiability({ balances, currencyCode } = {}) {
  const list = Array.isArray(balances) ? balances : [];
  const cur = currencyCode || (list[0] && list[0].currencyCode) || 'USD';

  const rows = list.map((b) => {
    const qty = toNumber(b.closing);
    // Prefer an explicit NZ money valuation; else qty * dayRate.
    const value = b.nzAccruedGrossEarnings != null
      ? fromMinor(toMinor(b.nzAccruedGrossEarnings))
      : fromMinor(Math.round(qty * toNumber(b.dayRate) * 100));
    return {
      employeeId: b.employeeId,
      leaveTypeId: b.leaveTypeId,
      leaveTypeName: b.leaveTypeName || null,
      unit: b.unit || 'DAYS',
      quantity: qty,
      value,
      currencyCode: b.currencyCode || cur,
    };
  });

  // By leave type rollup.
  const byTypeMap = new Map();
  for (const r of rows) {
    const k = r.leaveTypeId || r.leaveTypeName || '—';
    if (!byTypeMap.has(k)) byTypeMap.set(k, { leaveTypeId: r.leaveTypeId, leaveTypeName: r.leaveTypeName, quantity: 0, value: 0 });
    const g = byTypeMap.get(k);
    g.quantity = Math.round((g.quantity + r.quantity) * 10000) / 10000;
    g.value = fromMinor(toMinor(g.value) + toMinor(r.value));
  }

  return {
    currencyCode: cur,
    totalQuantity: Math.round(rows.reduce((a, r) => a + r.quantity, 0) * 10000) / 10000,
    totalValue: sumMoney(rows.map((r) => r.value)),
    byType: Array.from(byTypeMap.values()).sort((a, b) => b.value - a.value),
    rows,
  };
}

module.exports = {
  // helpers (exported for tests)
  toNumber,
  toMinor,
  fromMinor,
  sumMoney,
  // field maps
  IN_STATUTORY_FIELDS,
  NZ_STATUTORY_FIELDS,
  // report builders
  buildPayrollRegister,
  buildStatutorySummary,
  buildHeadcount,
  buildLeaveLiability,
};
