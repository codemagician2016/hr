'use strict';

/**
 * templates.js — the canonical column set per ImportKind (India-first) + the
 * downloadable template/data-dictionary generator. PURE (no DB).
 *
 * Each field: { name, required, type, rule, example }. `required` may be:
 *   true     — always required
 *   false    — optional
 *   'IN'     — required for India entities (PAN / PT state / gender)
 *   'oneOf:<group>' — at least one of the group must be present (e.g. ctcAnnual|grossMonthly)
 *
 * The template download = the header row + one example row + a leading block of
 * `#`-prefixed data-dictionary comment lines (a CSV-safe way to ship the rules
 * inline without needing a hidden xlsx sheet). The parser ignores `#` lines is
 * NOT automatic — so we keep the dictionary OUT of the parseable region by
 * emitting it only in the human-facing template, and the upload path strips any
 * leading comment block (see imports.service.stripCommentLines).
 */

const { toCsv } = require('./parsers/csv');

// FLAG (Feature 28 — shared edit): add the BIOMETRIC import kind. It reuses the F18
// machinery end-to-end (upload→map→validate→dry-run→commit→report); a BIOMETRIC job
// requires options.deviceId (the device pins vendor/adapter/TZ/location). Its
// committer (commitBiometricPunch) lands raw device punches + a post-commit pass
// recomputes — see backend/src/hr/attendance/biometric/committer.js.
// Leave-audit (shared edit): LEAVE_BALANCE — opening leave balances for client
// migration (previously the ONLY way to seed balances was per-employee manual
// adjustment). Lands LeaveBalance lots + OPENING_BALANCE ledger rows.
const KINDS = ['EMPLOYEE', 'COMPENSATION', 'ATTENDANCE', 'PAYROLL_HISTORY', 'REIMBURSEMENT', 'BIOMETRIC', 'LEAVE_BALANCE'];

const TEMPLATES = Object.freeze({
  EMPLOYEE: {
    naturalKeyHint: 'code (or workEmail if code blank)',
    fields: [
      { name: 'code', required: false, type: 'string', rule: 'Employee code (EMP-000142). Blank = minted. Present + exists = update.', example: 'EMP-IMP-001' },
      { name: 'firstName', required: true, type: 'string', rule: 'Given name.', example: 'Asha' },
      { name: 'lastName', required: true, type: 'string', rule: 'Family name.', example: 'Rao' },
      { name: 'workEmail', required: true, type: 'email', rule: 'Tenant-unique work email.', example: 'asha.rao@acme.in' },
      { name: 'personalEmail', required: false, type: 'email', rule: 'Personal email.', example: '' },
      { name: 'phone', required: false, type: 'string', rule: 'Mobile.', example: '' },
      { name: 'gender', required: 'IN', type: 'enum', rule: 'MALE|FEMALE|OTHER — drives engine gender flags.', example: 'FEMALE' },
      { name: 'dateOfBirth', required: true, type: 'date', rule: 'YYYY-MM-DD.', example: '1993-02-11' },
      { name: 'dateOfJoining', required: true, type: 'date', rule: 'YYYY-MM-DD; in the past for migration.', example: '2025-04-01' },
      { name: 'entityCode', required: true, type: 'string', rule: 'Must resolve to an Entity in this tenant.', example: 'IN-HQ' },
      { name: 'locationCode', required: false, type: 'string', rule: 'Optional — resolves to a Location.', example: '' },
      { name: 'departmentCode', required: false, type: 'string', rule: 'Optional — resolves to a Department.', example: '' },
      { name: 'designationCode', required: false, type: 'string', rule: 'Optional — resolves to a Designation.', example: '' },
      { name: 'managerCode', required: false, type: 'string', rule: 'Manager employee code.', example: '' },
      { name: 'pan', required: 'IN', type: 'PAN', rule: 'ABCDE1234X — ^[A-Z]{5}[0-9]{4}[A-Z]$.', example: 'ABCDE1234X' },
      { name: 'uan', required: false, type: 'string', rule: '12-digit UAN; presence flips pfApplicable.', example: '' },
      { name: 'esiApplicable', required: false, type: 'Y/N', rule: 'Y/N.', example: 'N' },
      { name: 'esiNumber', required: false, type: 'string', rule: 'ESI IP number.', example: '' },
      { name: 'ptStateCode', required: false, type: 'string', rule: 'PT slab state (e.g. KA, MH).', example: 'KA' },
      { name: 'bankAccount', required: false, type: 'string', rule: 'Bank account number.', example: '' },
      { name: 'ifsc', required: false, type: 'IFSC', rule: '^[A-Z]{4}0[A-Z0-9]{6}$.', example: '' },
    ],
  },
  COMPENSATION: {
    naturalKeyHint: 'employeeCode + effectiveFrom',
    fields: [
      { name: 'employeeCode', required: true, type: 'string', rule: 'Must resolve to an Employee in the entity.', example: 'EMP-IMP-001' },
      { name: 'effectiveFrom', required: true, type: 'date', rule: 'YYYY-MM-DD; back-dated allowed.', example: '2025-04-01' },
      { name: 'ctcAnnual', required: 'oneOf:target', type: 'money', rule: 'Annual CTC in ₹ (major units) — fed to deriveBreakup.', example: '1200000' },
      { name: 'grossMonthly', required: 'oneOf:target', type: 'money', rule: 'Monthly gross in ₹ — alternative target.', example: '' },
      { name: 'structureCode', required: false, type: 'string', rule: 'SalaryStructure template to derive against; else entity default.', example: '' },
    ],
  },
  ATTENDANCE: {
    naturalKeyHint: 'DAILY: employeeCode+date · SUMMARY: employeeCode+periodMonth',
    fields: [
      { name: 'employeeCode', required: true, type: 'string', rule: 'Must resolve to an Employee.', example: 'EMP-IMP-001' },
      // DAILY columns
      { name: 'date', required: false, type: 'date', rule: 'DAILY mode: YYYY-MM-DD.', example: '2025-12-01' },
      { name: 'status', required: false, type: 'enum', rule: 'DAILY: PRESENT|ABSENT|HALF_DAY|ON_LEAVE|WEEKLY_OFF|HOLIDAY|WORK_FROM_HOME|ON_DUTY.', example: 'PRESENT' },
      { name: 'otHours', required: false, type: 'number', rule: 'Overtime equivalent hours for the day/period.', example: '0' },
      // SUMMARY columns
      { name: 'periodMonth', required: false, type: 'month', rule: 'SUMMARY mode: YYYY-MM.', example: '' },
      { name: 'payableDays', required: false, type: 'number', rule: 'SUMMARY: paid days in the month.', example: '' },
      { name: 'lopDays', required: false, type: 'number', rule: 'SUMMARY: loss-of-pay days.', example: '' },
      { name: 'paidLeaveDays', required: false, type: 'number', rule: 'SUMMARY: paid-leave days.', example: '' },
    ],
  },
  PAYROLL_HISTORY: {
    naturalKeyHint: 'employeeCode + periodMonth',
    fields: [
      { name: 'employeeCode', required: true, type: 'string', rule: 'Must resolve to an Employee with a CTC + attendance for the month.', example: 'EMP-IMP-001' },
      { name: 'periodMonth', required: true, type: 'month', rule: 'YYYY-MM; period end must be before today (back-dated).', example: '2025-12' },
      { name: 'payableDays', required: false, type: 'number', rule: 'GENERATE: optional inline attendance if no ATTENDANCE import.', example: '' },
      { name: 'lopDays', required: false, type: 'number', rule: 'GENERATE: optional inline LOP days.', example: '' },
      // RECONCILE columns (the prior provider's figures — used as a CHECK, never overwrite the engine).
      { name: 'priorGross', required: false, type: 'money', rule: 'RECONCILE: prior provider gross (₹) — compared to engine, WARN on mismatch.', example: '' },
      { name: 'priorNet', required: false, type: 'money', rule: 'RECONCILE: prior provider net (₹).', example: '' },
      { name: 'priorPf', required: false, type: 'money', rule: 'RECONCILE: prior PF (₹).', example: '' },
      { name: 'priorPt', required: false, type: 'money', rule: 'RECONCILE: prior PT (₹).', example: '' },
      { name: 'priorTds', required: false, type: 'money', rule: 'RECONCILE: prior TDS (₹).', example: '' },
    ],
  },
  LEAVE_BALANCE: {
    naturalKeyHint: 'employeeCode + leaveTypeCode + periodCode',
    fields: [
      { name: 'employeeCode', required: true, type: 'string', rule: 'Must resolve to an Employee in this tenant.', example: 'EMP-IMP-001' },
      { name: 'leaveTypeCode', required: true, type: 'string', rule: 'Must resolve to an ACTIVE LeaveType code (EL/SL/CL/…).', example: 'EL' },
      { name: 'periodCode', required: true, type: 'string', rule: 'Leave period, e.g. "2026-27" (IN FY) or an NZ anniversary code.', example: '2026-27' },
      { name: 'openingBalance', required: true, type: 'number', rule: 'Opening units (days/weeks per the type unit). ≥ 0; lands as an OPENING_BALANCE ledger row.', example: '12.5' },
      { name: 'note', required: false, type: 'string', rule: 'Optional migration note (kept on the ledger row).', example: 'Migrated from legacy HRMS' },
    ],
  },
  REIMBURSEMENT: {
    naturalKeyHint: 'employeeCode + claimNumber (or expenseDate+amount+desc-hash)',
    fields: [
      { name: 'employeeCode', required: true, type: 'string', rule: 'Must resolve to an Employee.', example: 'EMP-IMP-001' },
      { name: 'claimNumber', required: false, type: 'string', rule: 'EXP-####; blank = minted.', example: '' },
      { name: 'categoryCode', required: false, type: 'string', rule: 'Resolves to an ExpenseCategory.', example: '' },
      { name: 'expenseDate', required: true, type: 'date', rule: 'YYYY-MM-DD; back-dated allowed.', example: '2025-11-15' },
      { name: 'claimedAmount', required: true, type: 'money', rule: 'Employee-claimed figure (₹).', example: '4200' },
      { name: 'approvedAmount', required: false, type: 'money', rule: 'Back-dated approved figure (₹); blank = claimedAmount.', example: '4200' },
      { name: 'status', required: false, type: 'enum', rule: 'APPROVED (default) | REIMBURSED.', example: 'APPROVED' },
      { name: 'approvedBy', required: false, type: 'string', rule: 'Prior system’s approver (provenance); never the employee. Blank → SYSTEM:MIGRATION.', example: '' },
      { name: 'description', required: false, type: 'string', rule: 'Free text.', example: 'Client lunch' },
      { name: 'paymentRef', required: false, type: 'string', rule: 'Legacy payout reference (for REIMBURSED).', example: '' },
      { name: 'reimbursedAt', required: false, type: 'date', rule: 'Settlement date (for REIMBURSED).', example: '' },
    ],
  },
  // Feature 28 — device punch import (eSSL/ZKTeco/Matrix/... export → AttendancePunch).
  // The operator picks a DEVICE (options.deviceId) first, so vendor/TZ/location resolve;
  // the file is the device's export. Direction is OPTIONAL — most India devices don't
  // record it reliably, so the device's directionMode (default DERIVE) decides IN/OUT.
  BIOMETRIC: {
    naturalKeyHint: 'deviceCode + localTime (+ direction) — the dedupKey spine',
    fields: [
      { name: 'deviceCode', required: true, type: 'string', rule: 'Enroll-no / PIN as the device reports it. Maps to an employee via DeviceEmployeeMap (or Employee.code fallback).', example: '1042' },
      { name: 'localTime', required: true, type: 'datetime', rule: 'Device LOCAL wall-clock (YYYY-MM-DD HH:MM:SS). Resolved to UTC in the device location TZ — never the server TZ.', example: '2026-06-24 09:01:33' },
      { name: 'direction', required: false, type: 'string', rule: 'Optional device IN/OUT token (IN|OUT|0|1|C/In…). Honoured only when the device is in TRUST_DEVICE mode; otherwise ignored (DERIVE by punch order).', example: '' },
    ],
  },
});

/** Canonical field names for a kind (the default identity mapping). */
function canonicalFields(kind) {
  const t = TEMPLATES[kind];
  if (!t) throw new Error(`Unknown import kind: ${kind}`);
  return t.fields.map((f) => f.name);
}

/** Required field names (always-required only) for a kind. */
function requiredFields(kind) {
  const t = TEMPLATES[kind];
  if (!t) throw new Error(`Unknown import kind: ${kind}`);
  return t.fields.filter((f) => f.required === true).map((f) => f.name);
}

/** "oneOf" groups: { group: [fieldNames] } — at least one must be present. */
function oneOfGroups(kind) {
  const t = TEMPLATES[kind];
  const groups = {};
  for (const f of (t ? t.fields : [])) {
    if (typeof f.required === 'string' && f.required.startsWith('oneOf:')) {
      const g = f.required.slice('oneOf:'.length);
      (groups[g] = groups[g] || []).push(f.name);
    }
  }
  return groups;
}

/**
 * buildTemplateCsv(kind) — the downloadable CSV: a leading `#`-prefixed data
 * dictionary, then the header row, then a single filled example row.
 */
function buildTemplateCsv(kind) {
  const t = TEMPLATES[kind];
  if (!t) throw new Error(`Unknown import kind: ${kind}`);
  const headers = canonicalFields(kind);
  const dict = [
    `# DriftHR import template — ${kind}`,
    `# Natural key (idempotency): ${t.naturalKeyHint}`,
    '# Money columns are in ₹ (major units). Dates are YYYY-MM-DD. Booleans Y/N.',
    '# Required: ' + (requiredFields(kind).join(', ') || '(see rules)'),
    '# Data dictionary (field | required | type | rule):',
    ...t.fields.map((f) => `#   ${f.name} | ${f.required === true ? 'yes' : f.required === false ? 'no' : f.required} | ${f.type} | ${f.rule}`),
    '# Delete every # comment line before upload, OR leave them — the importer strips a leading # block.',
  ];
  const example = {};
  for (const f of t.fields) example[f.name] = f.example;
  const body = toCsv(headers, [example]);
  return `${dict.join('\r\n')}\r\n${body}\r\n`;
}

module.exports = {
  KINDS,
  TEMPLATES,
  canonicalFields,
  requiredFields,
  oneOfGroups,
  buildTemplateCsv,
};
