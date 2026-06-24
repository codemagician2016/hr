'use strict';

/*
 * india.registers.seed.js — the DEFAULT India statutory REGISTER definition set
 * (Feature 32 §2.1, as DATA) + the mapping from a tenant's active
 * StatutoryRegistration rows to the RegisterDefinition forms it should own.
 *
 * PURE. No DB. `buildRegisterDefinitionsForRegistrations(registrations, opts)`
 * takes the plain StatutoryRegistration rows (or {kind, stateCode, ...}) and
 * returns the register DEFINITION objects to upsert — the seed route does the DB
 * writes (upsert on the @@unique key, idempotent + effective-dated). Mirrors
 * compliance/india.calendar.seed.js one-for-one.
 *
 * Applicability is registration-driven (the spec's source of truth):
 *   ALWAYS (any IN entity)        → MUSTER_ROLL (Form 25), WAGE_REGISTER (Form X),
 *                                    OVERTIME_REGISTER (Form 18),
 *                                    LEAVE_REGISTER (Form 15), FINES_REGISTER (PoW
 *                                    Form I), EMPLOYEE_REGISTER (Ease-of-Compliance
 *                                    Form A), and the Ease-of-Compliance combined
 *                                    set (Form B/D).
 *   SHOPS_ESTABLISHMENT (per state) → the state's S&E combined muster-cum-wage
 *                                    register (MH Form II, KA Form T, TN Form…).
 *   EPF registration              → PF_ANNUAL (Form 3A/6A human register).
 *   ESI registration              → ESI_REGISTER (half-yearly contribution).
 *
 * Each column binds a label to a (source, path[, transform]) on a frozen source
 * row — the projector resolves it. Adding a state = adding seed rows, not code.
 */

const DEFAULT_EFFECTIVE_FROM = '2017-04-01'; // Ease-of-Compliance Rules notified 2017.
const RETENTION_YEARS = 3; // typical statutory retention for these registers.

// ── reusable column fragments ────────────────────────────────────────────────

const COL_SL = { key: 'sl', label: 'Sl. No.', source: 'literal', path: '__sl' };
const COL_EMP_CODE = { key: 'code', label: 'Emp. Code', source: 'employee', path: 'code', transform: 'text' };
const COL_NAME = { key: 'name', label: 'Name of Employee', source: 'derived', path: 'fullName', transform: 'text' };
const COL_FATHER = { key: 'father', label: "Father's / Husband's Name", source: 'employee', path: 'fatherName', transform: 'text' };
const COL_DESIGNATION = { key: 'designation', label: 'Designation', source: 'employee', path: 'designation', transform: 'text' };
const COL_DOJ = { key: 'doj', label: 'Date of Joining', source: 'employee', path: 'hireDate', transform: 'date' };
const COL_UAN = { key: 'uan', label: 'UAN', source: 'statutory', path: 'uan', transform: 'uan', statutory: true };
const COL_ESIC = { key: 'esic', label: 'ESIC IP No.', source: 'statutory', path: 'esicIp', transform: 'identity', statutory: true };
const COL_PAN = { key: 'pan', label: 'PAN', source: 'statutory', path: 'pan', transform: 'pan', statutory: true };

// Attendance summary columns (all frozen on AttendancePayInput; days2 transform).
const COL_DAYS_PRESENT = { key: 'present', label: 'Days Present', source: 'derived', path: 'daysPresent', transform: 'days2' };
const COL_PAYABLE = { key: 'payable', label: 'Paid Days', source: 'summary', path: 'payableDays', transform: 'days2' };
const COL_LOP = { key: 'lop', label: 'LOP Days', source: 'summary', path: 'lopDays', transform: 'days2' };
const COL_LWP = { key: 'lwp', label: 'LWP Days', source: 'summary', path: 'lwpDays', transform: 'days2' };
const COL_ABSENT = { key: 'absent', label: 'Absent', source: 'summary', path: 'absentDays', transform: 'days2' };
const COL_WO = { key: 'wo', label: 'Weekly Offs', source: 'summary', path: 'weeklyOffDays', transform: 'days2' };
const COL_HOL = { key: 'hol', label: 'Holidays', source: 'summary', path: 'holidayDays', transform: 'days2' };
const COL_PAID_LEAVE = { key: 'paidLeave', label: 'Paid Leave', source: 'summary', path: 'paidLeaveDays', transform: 'days2' };
const COL_OT_HOURS = { key: 'otHours', label: 'OT Hours', source: 'summary', path: 'overtimeHours', transform: 'hours2' };

// Wage-register columns (all frozen on PayRunLine; rupee transform).
const COL_GROSS = { key: 'gross', label: 'Gross Earnings', source: 'line', path: 'grossEarnings', transform: 'rupee' };
const COL_PF_EE = { key: 'pfEe', label: 'PF (EE)', source: 'line', path: 'pfEmployee', transform: 'rupee', statutory: true };
const COL_ESI_EE = { key: 'esiEe', label: 'ESI (EE)', source: 'line', path: 'esiEmployee', transform: 'rupee', statutory: true };
const COL_PT = { key: 'pt', label: 'Prof. Tax', source: 'line', path: 'pt', transform: 'rupee', statutory: true };
const COL_LWF_EE = { key: 'lwfEe', label: 'LWF (EE)', source: 'line', path: 'lwfEmployee', transform: 'rupee', statutory: true };
const COL_TDS = { key: 'tds', label: 'TDS', source: 'line', path: 'tds', transform: 'rupee', statutory: true };
const COL_TOTAL_DED = { key: 'totalDed', label: 'Total Deductions', source: 'line', path: 'totalDeductions', transform: 'rupee' };
const COL_NET = { key: 'net', label: 'Net Payable', source: 'line', path: 'netPay', transform: 'rupee' };
const COL_PF_BASE = { key: 'pfBase', label: 'PF Wage Base', source: 'line', path: 'pfWagesBase', transform: 'rupee', statutory: true };

// ── the form definitions (templates; effective-dated, per-state when scoped) ──

function musterRoll(stateCode, formCode, formLabel, actLabel) {
  return {
    kind: 'MUSTER_ROLL',
    formCode,
    formLabel,
    actLabel,
    stateCode: stateCode || null,
    cadence: 'PERIOD',
    source: 'ATTENDANCE',
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME, COL_FATHER, COL_DESIGNATION, COL_DOJ, COL_UAN, COL_ESIC,
      // the per-day muster grid (one column per day-of-month, expanded by the projector)
      { key: 'grid', label: 'Daily Attendance', daily: true },
      // summary block
      COL_DAYS_PRESENT, COL_PAYABLE, COL_PAID_LEAVE, COL_LOP, COL_LWP, COL_ABSENT, COL_WO, COL_HOL, COL_OT_HOURS,
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'landscape', legend: 'P=Present ½=Half L=Paid-Leave LWP=Loss-of-Pay A=Absent WO=Weekly-Off H=Holiday MP=Missing-Punch' },
  };
}

function wageRegister(stateCode, formCode, formLabel, actLabel) {
  return {
    kind: 'WAGE_REGISTER',
    formCode,
    formLabel,
    actLabel,
    stateCode: stateCode || null,
    cadence: 'PERIOD',
    source: 'PAYRUN',
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME, COL_DESIGNATION, COL_UAN, COL_ESIC, COL_PAN,
      COL_PAYABLE, COL_LOP,
      COL_GROSS, COL_PF_EE, COL_ESI_EE, COL_PT, COL_LWF_EE, COL_TDS, COL_TOTAL_DED, COL_NET,
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'landscape', dynamicEarnings: true },
  };
}

function musterWageCombined(stateCode, formCode, formLabel, actLabel) {
  return {
    kind: 'MUSTER_WAGE_COMBINED',
    formCode,
    formLabel,
    actLabel,
    stateCode: stateCode || null,
    cadence: 'PERIOD',
    source: 'PAYRUN', // payrun bundle carries the attendance summary too (joined)
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME, COL_FATHER, COL_DESIGNATION, COL_UAN, COL_ESIC,
      COL_PAYABLE, COL_LOP, COL_ABSENT, COL_OT_HOURS,
      COL_GROSS, COL_PF_EE, COL_ESI_EE, COL_PT, COL_LWF_EE, COL_TDS, COL_TOTAL_DED, COL_NET,
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'landscape', combined: true },
  };
}

function overtimeRegister(stateCode, formCode, formLabel, actLabel) {
  return {
    kind: 'OVERTIME_REGISTER',
    formCode,
    formLabel,
    actLabel,
    stateCode: stateCode || null,
    cadence: 'PERIOD',
    source: 'PAYRUN',
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME, COL_DESIGNATION,
      { key: 'normalDays', label: 'Days Worked', source: 'line', path: 'payableDays', transform: 'days2' },
      COL_OT_HOURS,
      { key: 'otWage', label: 'OT Wages', source: 'component', path: 'OT', transform: 'rupee' },
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'landscape', note: 'OT rate = twice ordinary (Factories Act §59). OT wages read from the OT earning component.' },
  };
}

function leaveRegister(stateCode, formCode, formLabel, actLabel) {
  return {
    kind: 'LEAVE_REGISTER',
    formCode,
    formLabel,
    actLabel,
    stateCode: stateCode || null,
    cadence: 'ANNUAL',
    source: 'LEAVE',
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME, COL_DESIGNATION,
      { key: 'leaveType', label: 'Leave Type', source: 'balance', path: 'leaveTypeName', transform: 'text' },
      { key: 'opening', label: 'Opening', source: 'balance', path: 'opening', transform: 'days2' },
      { key: 'accrued', label: 'Credited', source: 'balance', path: 'accrued', transform: 'days2' },
      { key: 'taken', label: 'Availed', source: 'balance', path: 'taken', transform: 'days2' },
      { key: 'encashed', label: 'Encashed', source: 'balance', path: 'encashed', transform: 'days2' },
      { key: 'lapsed', label: 'Lapsed', source: 'balance', path: 'lapsed', transform: 'days2' },
      { key: 'closing', label: 'Closing', source: 'balance', path: 'closing', transform: 'days2' },
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'landscape', rowPerLeaveType: true },
  };
}

function finesRegister(stateCode, formCode, formLabel, actLabel) {
  return {
    kind: 'FINES_REGISTER',
    formCode,
    formLabel,
    actLabel,
    stateCode: stateCode || null,
    cadence: 'PERIOD',
    source: 'PAYRUN',
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME, COL_DESIGNATION,
      { key: 'fineComponent', label: 'Nature of Fine / Deduction', source: 'component', path: 'FINE', transform: 'rupee' },
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'portrait', note: 'Driven by deduction components flagged as fines/damage.' },
  };
}

function employeeRegister(stateCode, formCode, formLabel, actLabel) {
  return {
    kind: 'EMPLOYEE_REGISTER',
    formCode,
    formLabel,
    actLabel,
    stateCode: stateCode || null,
    cadence: 'SNAPSHOT',
    source: 'EMPLOYEE',
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME,
      { key: 'dob', label: 'Date of Birth', source: 'employee', path: 'dateOfBirth', transform: 'date' },
      { key: 'gender', label: 'Gender', source: 'employee', path: 'gender', transform: 'text' },
      COL_FATHER, COL_DESIGNATION, COL_DOJ, COL_UAN, COL_ESIC, COL_PAN,
      { key: 'addr', label: 'Address', source: 'employee', path: 'addressLine1', transform: 'text' },
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'landscape' },
  };
}

function pfAnnual(formCode, formLabel) {
  return {
    kind: 'PF_ANNUAL',
    formCode,
    formLabel,
    actLabel: 'EPF & MP Act 1952',
    stateCode: null,
    cadence: 'ANNUAL',
    source: 'PAYRUN_ANNUAL',
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME, COL_UAN,
      { key: 'pfWages', label: 'EPF Wages (FY)', source: 'line', path: 'pfWagesBase', transform: 'rupee', statutory: true },
      { key: 'pfEe', label: 'EE Contribution (FY)', source: 'line', path: 'pfEmployee', transform: 'rupee', statutory: true },
      { key: 'pfEr', label: 'ER Contribution (FY)', source: 'line', path: 'pfEmployer', transform: 'rupee', statutory: true },
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'landscape', annualRoll: true },
  };
}

function esiRegister(formCode, formLabel) {
  return {
    kind: 'ESI_REGISTER',
    formCode,
    formLabel,
    actLabel: 'ESI Act 1948',
    stateCode: null,
    cadence: 'HALF_YEARLY',
    source: 'PAYRUN',
    columns: [
      COL_SL, COL_EMP_CODE, COL_NAME, COL_ESIC,
      { key: 'esiWage', label: 'ESI Wages', source: 'line', path: 'grossEarnings', transform: 'rupee' },
      COL_ESI_EE,
      { key: 'esiEr', label: 'ESI (ER)', source: 'line', path: 'esiEmployer', transform: 'rupee', statutory: true },
    ],
    meta: { retentionYears: RETENTION_YEARS, orientation: 'landscape', halfYearly: true },
  };
}

// ── per-state S&E muster-cum-wage combined forms ─────────────────────────────

const SE_COMBINED_BY_STATE = Object.freeze({
  MH: { formCode: 'FORM_II', formLabel: 'Muster Roll-cum-Wage Register (MH Form II)', actLabel: 'Maharashtra S&E Act 2017' },
  KA: { formCode: 'FORM_T', formLabel: 'Combined Register (KA Form T)', actLabel: 'Karnataka S&E Act 1961' },
  TN: { formCode: 'FORM_R', formLabel: 'Register of Wages (TN Form R)', actLabel: 'Tamil Nadu S&E Act 1947' },
});

// ── the always-on central default set (Factories Act + Ease-of-Compliance) ────

function centralDefaults() {
  return [
    musterRoll(null, 'FORM_25', 'Muster Roll (Factories Form 25)', 'Factories Act 1948'),
    wageRegister(null, 'FORM_X', 'Register of Wages (Min. Wages Form X)', 'Minimum Wages Act 1948'),
    overtimeRegister(null, 'FORM_18', 'Register of Overtime (Factories Form 18)', 'Factories Act 1948'),
    leaveRegister(null, 'FORM_15', 'Register of Leave with Wages (Factories Form 15)', 'Factories Act 1948'),
    finesRegister(null, 'FORM_I', 'Register of Fines (Payment of Wages Form I)', 'Payment of Wages Act 1936'),
    employeeRegister(null, 'FORM_A', 'Register of Employees (Ease-of-Compliance Form A)', 'Ease-of-Compliance Rules 2017'),
    // Ease-of-Compliance combined set (Form B = wage, Form D = muster).
    wageRegister(null, 'FORM_B', 'Register of Wages (Ease-of-Compliance Form B)', 'Ease-of-Compliance Rules 2017'),
    musterRoll(null, 'FORM_D', 'Muster Roll (Ease-of-Compliance Form D)', 'Ease-of-Compliance Rules 2017'),
  ];
}

/**
 * buildRegisterDefinitionsForRegistrations(registrations, opts) → definition objs.
 * PURE. Each returned object is { kind, formCode, formLabel, actLabel, stateCode,
 * cadence, source, columns, effectiveFrom, effectiveTo, isActive, meta } — ready
 * for the seed route to stamp businessId/entityId and upsert on the @@unique key.
 *
 * @param {Array} registrations  active StatutoryRegistration rows ({kind, stateCode})
 * @param {object} [opts] { effectiveFrom }
 */
function buildRegisterDefinitionsForRegistrations(registrations, opts = {}) {
  const effectiveFrom = opts.effectiveFrom || DEFAULT_EFFECTIVE_FROM;
  const regs = Array.isArray(registrations) ? registrations : [];
  const defs = [...centralDefaults()];

  const seStates = new Set();
  let hasEpf = false;
  let hasEsi = false;
  for (const r of regs) {
    if (!r || !r.kind) continue;
    if (r.kind === 'SHOPS_ESTABLISHMENT' && r.stateCode) seStates.add(String(r.stateCode).toUpperCase());
    if (r.kind === 'EPF') hasEpf = true;
    if (r.kind === 'ESI') hasEsi = true;
  }

  // Per-state S&E combined muster-cum-wage register.
  for (const st of seStates) {
    const m = SE_COMBINED_BY_STATE[st];
    if (m) defs.push(musterWageCombined(st, m.formCode, m.formLabel, m.actLabel));
  }

  // EPF ⇒ PF annual (3A/6A) human register.
  if (hasEpf) defs.push(pfAnnual('FORM_3A', 'PF Annual Contribution Card (Form 3A/6A)'));
  // ESI ⇒ half-yearly contribution register.
  if (hasEsi) defs.push(esiRegister('ESI_HY', 'ESI Half-Yearly Contribution Register'));

  // Stamp effective-dating + isActive on every definition (idempotent on the key).
  return defs.map((d) => ({
    ...d,
    effectiveFrom,
    effectiveTo: null,
    isActive: true,
  }));
}

// The full catalog of central + per-state forms, for the catalog endpoint to list
// "available registers" even before any seed (the projector has a built-in default
// layout per kind via these objects).
function defaultCatalog() {
  // Include the per-state combined forms + the PF/ESI annual forms so the catalog
  // can show them (applicability filtering happens in the controller).
  const all = [...centralDefaults()];
  for (const st of Object.keys(SE_COMBINED_BY_STATE)) {
    const m = SE_COMBINED_BY_STATE[st];
    all.push(musterWageCombined(st, m.formCode, m.formLabel, m.actLabel));
  }
  all.push(pfAnnual('FORM_3A', 'PF Annual Contribution Card (Form 3A/6A)'));
  all.push(esiRegister('ESI_HY', 'ESI Half-Yearly Contribution Register'));
  return all.map((d) => ({ ...d, effectiveFrom: DEFAULT_EFFECTIVE_FROM, effectiveTo: null, isActive: true }));
}

module.exports = {
  buildRegisterDefinitionsForRegistrations,
  defaultCatalog,
  centralDefaults,
  SE_COMBINED_BY_STATE,
  DEFAULT_EFFECTIVE_FROM,
  // individual builders exposed for tests
  musterRoll,
  wageRegister,
  musterWageCombined,
  overtimeRegister,
  leaveRegister,
  finesRegister,
  employeeRegister,
  pfAnnual,
  esiRegister,
};
