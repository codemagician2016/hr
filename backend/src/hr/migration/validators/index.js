'use strict';

/**
 * validators/index.js — PURE per-kind row validators.
 *
 * Each `validate<Kind>(row, ctx)` takes a parsed canonical row + a `ctx` the
 * orchestrator PRE-LOADS (no DB inside the validator):
 *   ctx = {
 *     countryCode,                 // entity country ('IN')
 *     employeeCodes:  Set<string>, // existing employee codes in scope
 *     employeeByCode: Map<code, { id, entityId }>,
 *     entityCodes:    Set<string>,
 *     today:          'YYYY-MM-DD',
 *     mode:           { attendanceMode?, payrollMode? },  // from optionsJson
 *   }
 * and returns { status: PASS|WARN|ERROR, findings:[{code,severity,field?,message}],
 *               normalized, naturalKey }.
 *
 * Severity policy (§4.3): ERROR → excluded from commit; WARN → commits flagged;
 * PASS → clean. Bad rows are REPORTED, never silently dropped.
 */

const {
  PAN_RE, IFSC_RE, UAN_RE, EMAIL_RE,
  finding, rollupStatus, isBlank, toBool, toMinor, toNumber,
  isValidDate, isValidMonth,
} = require('./common');

const ATT_STATUSES = new Set(['PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY', 'WORK_FROM_HOME', 'ON_DUTY', 'HOLIDAY_WORKED']);

function done(findings, normalized, naturalKey) {
  return { status: rollupStatus(findings), findings, normalized, naturalKey: naturalKey || null };
}

// ── EMPLOYEE ────────────────────────────────────────────────────────────────
function validateEmployee(row, ctx) {
  const f = [];
  const isIN = (ctx.countryCode || 'IN') === 'IN';
  const code = row.code ? String(row.code).trim() : null;
  const email = row.workEmail ? String(row.workEmail).trim().toLowerCase() : null;

  if (isBlank(row.firstName)) f.push(finding('REQUIRED', 'ERROR', 'firstName is required', 'firstName'));
  if (isBlank(row.lastName)) f.push(finding('REQUIRED', 'ERROR', 'lastName is required', 'lastName'));
  if (isBlank(email)) f.push(finding('REQUIRED', 'ERROR', 'workEmail is required', 'workEmail'));
  else if (!EMAIL_RE.test(email)) f.push(finding('BAD_EMAIL', 'ERROR', `workEmail "${email}" is not a valid email`, 'workEmail'));

  if (isBlank(row.dateOfJoining)) f.push(finding('REQUIRED', 'ERROR', 'dateOfJoining is required', 'dateOfJoining'));
  else if (!isValidDate(row.dateOfJoining)) f.push(finding('BAD_DATE', 'ERROR', `dateOfJoining "${row.dateOfJoining}" must be YYYY-MM-DD`, 'dateOfJoining'));
  if (!isBlank(row.dateOfBirth) && !isValidDate(row.dateOfBirth)) f.push(finding('BAD_DATE', 'ERROR', `dateOfBirth "${row.dateOfBirth}" must be YYYY-MM-DD`, 'dateOfBirth'));

  if (isBlank(row.entityCode)) f.push(finding('REQUIRED', 'ERROR', 'entityCode is required', 'entityCode'));
  else if (ctx.entityCodes && !ctx.entityCodes.has(String(row.entityCode).trim())) {
    f.push(finding('UNKNOWN_ENTITY', 'ERROR', `entityCode "${row.entityCode}" not found in this tenant`, 'entityCode'));
  }

  if (isIN) {
    if (isBlank(row.gender)) f.push(finding('REQUIRED_IN', 'WARN', 'gender recommended for India (drives engine gender flags)', 'gender'));
    if (isBlank(row.pan)) f.push(finding('REQUIRED_IN', 'WARN', 'PAN missing — TDS will compute at the no-PAN rate', 'pan'));
    else if (!PAN_RE.test(String(row.pan).trim().toUpperCase())) f.push(finding('BAD_PAN', 'ERROR', `PAN "${row.pan}" is invalid (expected ABCDE1234X)`, 'pan'));
  }
  if (!isBlank(row.uan) && !UAN_RE.test(String(row.uan).trim())) f.push(finding('BAD_UAN', 'ERROR', `UAN "${row.uan}" must be 12 digits`, 'uan'));
  if (!isBlank(row.ifsc) && !IFSC_RE.test(String(row.ifsc).trim().toUpperCase())) f.push(finding('BAD_IFSC', 'ERROR', `IFSC "${row.ifsc}" is invalid`, 'ifsc'));

  // Update vs create: a present, known code is an update.
  const exists = code && ctx.employeeCodes && ctx.employeeCodes.has(code);
  const naturalKey = code || email;
  if (!naturalKey) f.push(finding('NO_KEY', 'ERROR', 'a code or workEmail is required as the natural key', 'code'));

  const normalized = {
    code, action: exists ? 'update' : 'create',
    firstName: row.firstName, lastName: row.lastName, workEmail: email,
    personalEmail: row.personalEmail || null, phone: row.phone || null,
    gender: row.gender ? String(row.gender).trim().toUpperCase() : null,
    dateOfBirth: row.dateOfBirth || null, dateOfJoining: row.dateOfJoining || null,
    entityCode: row.entityCode ? String(row.entityCode).trim() : null,
    locationCode: row.locationCode || null, departmentCode: row.departmentCode || null,
    designationCode: row.designationCode || null, managerCode: row.managerCode || null,
    pan: row.pan ? String(row.pan).trim().toUpperCase() : null,
    uan: row.uan ? String(row.uan).trim() : null,
    esiApplicable: toBool(row.esiApplicable), esiNumber: row.esiNumber || null,
    ptStateCode: row.ptStateCode ? String(row.ptStateCode).trim().toUpperCase() : null,
    bankAccount: row.bankAccount || null, ifsc: row.ifsc ? String(row.ifsc).trim().toUpperCase() : null,
  };
  return done(f, normalized, naturalKey);
}

// ── COMPENSATION ──────────────────────────────────────────────────────────
function validateCompensation(row, ctx) {
  const f = [];
  const empCode = row.employeeCode ? String(row.employeeCode).trim() : null;
  if (isBlank(empCode)) f.push(finding('REQUIRED', 'ERROR', 'employeeCode is required', 'employeeCode'));
  else if (ctx.employeeCodes && !ctx.employeeCodes.has(empCode)) f.push(finding('UNKNOWN_EMPLOYEE', 'ERROR', `employeeCode "${empCode}" not found in this tenant`, 'employeeCode'));

  if (isBlank(row.effectiveFrom)) f.push(finding('REQUIRED', 'ERROR', 'effectiveFrom is required', 'effectiveFrom'));
  else if (!isValidDate(row.effectiveFrom)) f.push(finding('BAD_DATE', 'ERROR', `effectiveFrom "${row.effectiveFrom}" must be YYYY-MM-DD`, 'effectiveFrom'));

  const hasCtc = !isBlank(row.ctcAnnual);
  const hasGross = !isBlank(row.grossMonthly);
  if (!hasCtc && !hasGross) f.push(finding('REQUIRED', 'ERROR', 'one of ctcAnnual or grossMonthly is required', 'ctcAnnual'));

  let ctcAnnualMinor = null; let grossMonthlyMinor = null;
  try { if (hasCtc) { ctcAnnualMinor = toMinor(row.ctcAnnual); if (ctcAnnualMinor <= 0) f.push(finding('BAD_MONEY', 'ERROR', 'ctcAnnual must be > 0', 'ctcAnnual')); } }
  catch (e) { f.push(finding('BAD_MONEY', 'ERROR', `ctcAnnual "${row.ctcAnnual}" is not a valid amount`, 'ctcAnnual')); }
  try { if (hasGross) { grossMonthlyMinor = toMinor(row.grossMonthly); if (grossMonthlyMinor <= 0) f.push(finding('BAD_MONEY', 'ERROR', 'grossMonthly must be > 0', 'grossMonthly')); } }
  catch (e) { f.push(finding('BAD_MONEY', 'ERROR', `grossMonthly "${row.grossMonthly}" is not a valid amount`, 'grossMonthly')); }

  const naturalKey = empCode && row.effectiveFrom ? `${empCode}|${row.effectiveFrom}` : null;
  const normalized = {
    employeeCode: empCode, effectiveFrom: row.effectiveFrom || null,
    basis: hasCtc ? 'CTC' : 'GROSS', ctcAnnualMinor, grossMonthlyMinor,
    structureCode: row.structureCode || null,
  };
  return done(f, normalized, naturalKey);
}

// ── ATTENDANCE ────────────────────────────────────────────────────────────
function validateAttendance(row, ctx) {
  const f = [];
  const mode = (ctx.mode && ctx.mode.attendanceMode) || (row.date ? 'DAILY' : 'SUMMARY');
  const empCode = row.employeeCode ? String(row.employeeCode).trim() : null;
  if (isBlank(empCode)) f.push(finding('REQUIRED', 'ERROR', 'employeeCode is required', 'employeeCode'));
  else if (ctx.employeeCodes && !ctx.employeeCodes.has(empCode)) f.push(finding('UNKNOWN_EMPLOYEE', 'ERROR', `employeeCode "${empCode}" not found`, 'employeeCode'));

  let naturalKey = null;
  const normalized = { employeeCode: empCode, mode };

  if (mode === 'DAILY') {
    if (isBlank(row.date)) f.push(finding('REQUIRED', 'ERROR', 'date is required in DAILY mode', 'date'));
    else if (!isValidDate(row.date)) f.push(finding('BAD_DATE', 'ERROR', `date "${row.date}" must be YYYY-MM-DD`, 'date'));
    const status = row.status ? String(row.status).trim().toUpperCase() : null;
    if (isBlank(status)) f.push(finding('REQUIRED', 'ERROR', 'status is required in DAILY mode', 'status'));
    else if (!ATT_STATUSES.has(status)) f.push(finding('BAD_STATUS', 'ERROR', `status "${status}" is not a valid attendance status`, 'status'));
    const ot = toNumber(row.otHours);
    if (Number.isNaN(ot)) f.push(finding('BAD_NUMBER', 'ERROR', `otHours "${row.otHours}" is not a number`, 'otHours'));
    normalized.date = row.date || null; normalized.status = status; normalized.otHours = ot || 0;
    naturalKey = empCode && row.date ? `${empCode}|${row.date}` : null;
  } else {
    if (isBlank(row.periodMonth)) f.push(finding('REQUIRED', 'ERROR', 'periodMonth is required in SUMMARY mode', 'periodMonth'));
    else if (!isValidMonth(row.periodMonth)) f.push(finding('BAD_MONTH', 'ERROR', `periodMonth "${row.periodMonth}" must be YYYY-MM`, 'periodMonth'));
    const payable = toNumber(row.payableDays); const lop = toNumber(row.lopDays); const paidLeave = toNumber(row.paidLeaveDays);
    if (row.payableDays != null && Number.isNaN(payable)) f.push(finding('BAD_NUMBER', 'ERROR', 'payableDays is not a number', 'payableDays'));
    if (row.lopDays != null && Number.isNaN(lop)) f.push(finding('BAD_NUMBER', 'ERROR', 'lopDays is not a number', 'lopDays'));
    normalized.periodMonth = row.periodMonth || null;
    normalized.payableDays = payable; normalized.lopDays = lop || 0; normalized.paidLeaveDays = paidLeave || 0;
    normalized.otHours = toNumber(row.otHours) || 0;
    naturalKey = empCode && row.periodMonth ? `${empCode}|${row.periodMonth}` : null;
  }
  return done(f, normalized, naturalKey);
}

// ── PAYROLL_HISTORY ─────────────────────────────────────────────────────────
function validatePayrollHistory(row, ctx) {
  const f = [];
  const empCode = row.employeeCode ? String(row.employeeCode).trim() : null;
  if (isBlank(empCode)) f.push(finding('REQUIRED', 'ERROR', 'employeeCode is required', 'employeeCode'));
  else if (ctx.employeeCodes && !ctx.employeeCodes.has(empCode)) f.push(finding('UNKNOWN_EMPLOYEE', 'ERROR', `employeeCode "${empCode}" not found`, 'employeeCode'));

  if (isBlank(row.periodMonth)) f.push(finding('REQUIRED', 'ERROR', 'periodMonth is required', 'periodMonth'));
  else if (!isValidMonth(row.periodMonth)) f.push(finding('BAD_MONTH', 'ERROR', `periodMonth "${row.periodMonth}" must be YYYY-MM`, 'periodMonth'));
  else {
    // period end must be before today (back-dated history, not a future run).
    const endY = Number(row.periodMonth.slice(0, 4)); const endM = Number(row.periodMonth.slice(5, 7));
    const end = new Date(Date.UTC(endY, endM, 0)).toISOString().slice(0, 10);
    if (ctx.today && end >= ctx.today) f.push(finding('NOT_BACKDATED', 'ERROR', `periodMonth "${row.periodMonth}" ends ${end} which is not before today (${ctx.today}); imports are for history only`, 'periodMonth'));
  }

  const mode = (ctx.mode && ctx.mode.payrollMode) || 'GENERATE';
  const prior = {};
  for (const [k, col] of [['gross', 'priorGross'], ['net', 'priorNet'], ['pf', 'priorPf'], ['pt', 'priorPt'], ['tds', 'priorTds']]) {
    if (!isBlank(row[col])) {
      try { prior[k] = toMinor(row[col]); } catch (e) { f.push(finding('BAD_MONEY', 'ERROR', `${col} "${row[col]}" is not a valid amount`, col)); }
    }
  }
  const naturalKey = empCode && row.periodMonth ? `${empCode}|${row.periodMonth}` : null;
  const normalized = {
    employeeCode: empCode, periodMonth: row.periodMonth || null, mode,
    payableDays: toNumber(row.payableDays), lopDays: toNumber(row.lopDays) || 0, prior,
  };
  return done(f, normalized, naturalKey);
}

// ── REIMBURSEMENT ─────────────────────────────────────────────────────────
function validateReimbursement(row, ctx) {
  const f = [];
  const empCode = row.employeeCode ? String(row.employeeCode).trim() : null;
  if (isBlank(empCode)) f.push(finding('REQUIRED', 'ERROR', 'employeeCode is required', 'employeeCode'));
  else if (ctx.employeeCodes && !ctx.employeeCodes.has(empCode)) f.push(finding('UNKNOWN_EMPLOYEE', 'ERROR', `employeeCode "${empCode}" not found`, 'employeeCode'));

  if (isBlank(row.expenseDate)) f.push(finding('REQUIRED', 'ERROR', 'expenseDate is required', 'expenseDate'));
  else if (!isValidDate(row.expenseDate)) f.push(finding('BAD_DATE', 'ERROR', `expenseDate "${row.expenseDate}" must be YYYY-MM-DD`, 'expenseDate'));

  let claimedMinor = null; let approvedMinor = null;
  if (isBlank(row.claimedAmount)) f.push(finding('REQUIRED', 'ERROR', 'claimedAmount is required', 'claimedAmount'));
  else { try { claimedMinor = toMinor(row.claimedAmount); if (claimedMinor <= 0) f.push(finding('BAD_MONEY', 'ERROR', 'claimedAmount must be > 0', 'claimedAmount')); } catch (e) { f.push(finding('BAD_MONEY', 'ERROR', `claimedAmount "${row.claimedAmount}" is not a valid amount`, 'claimedAmount')); } }
  if (!isBlank(row.approvedAmount)) { try { approvedMinor = toMinor(row.approvedAmount); } catch (e) { f.push(finding('BAD_MONEY', 'ERROR', `approvedAmount "${row.approvedAmount}" is not a valid amount`, 'approvedAmount')); } }
  if (approvedMinor == null) approvedMinor = claimedMinor;
  if (claimedMinor != null && approvedMinor != null && approvedMinor > claimedMinor) {
    f.push(finding('APPROVED_GT_CLAIMED', 'WARN', `approvedAmount (₹${row.approvedAmount}) exceeds claimedAmount (₹${row.claimedAmount}) — allowed but flagged`, 'approvedAmount'));
  }
  const status = row.status ? String(row.status).trim().toUpperCase() : 'APPROVED';
  if (!['APPROVED', 'REIMBURSED'].includes(status)) f.push(finding('BAD_STATUS', 'ERROR', `status "${status}" must be APPROVED or REIMBURSED`, 'status'));

  const claimNumber = row.claimNumber ? String(row.claimNumber).trim() : null;
  const descHash = require('crypto').createHash('sha256').update(`${row.description || ''}`).digest('hex').slice(0, 8);
  const naturalKey = empCode
    ? (claimNumber ? `${empCode}|${claimNumber}` : `${empCode}|${row.expenseDate}|${row.claimedAmount}|${descHash}`)
    : null;
  const normalized = {
    employeeCode: empCode, claimNumber, categoryCode: row.categoryCode || null,
    expenseDate: row.expenseDate || null, claimedMinor, approvedMinor, status,
    description: row.description || null, paymentRef: row.paymentRef || null,
    reimbursedAt: row.reimbursedAt || null,
    approvedBy: row.approvedBy ? String(row.approvedBy).trim() : null, // prior system's approver (provenance)
  };
  return done(f, normalized, naturalKey);
}

// ── BIOMETRIC (Feature 28) ────────────────────────────────────────────────────
// Device punch rows. ONLY structural validity is enforced here (deviceCode present;
// localTime parseable to a YYYY-MM-DD[ HH:MM[:SS]] wall-clock). An UNKNOWN device
// code is NOT an error: it lands as a parked UNMAPPED RawPunchEvent the operator maps
// + reprocesses (§6.4), so we do not consult ctx.employeeCodes (the device code ≠
// Employee.code in the common case — it resolves via DeviceEmployeeMap downstream).
// The clock time is MANDATORY (the [ T]HH:MM group is no longer optional): a
// date-only punch is not a usable attendance event — landing it at 00:00 mis-places
// it on the civil-day boundary / pre-dawn night-shift window. Reject it as a
// BAD_DATETIME at validation rather than silently materialising a midnight punch.
const BIO_TIME_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i;
const BIO_DDMM_RE = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}[ T]\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i;
function validateBiometric(row, _ctx) {
  const f = [];
  const deviceCode = row.deviceCode != null ? String(row.deviceCode).trim() : null;
  if (isBlank(deviceCode)) f.push(finding('REQUIRED', 'ERROR', 'deviceCode is required', 'deviceCode'));

  const localTime = row.localTime != null ? String(row.localTime).trim() : null;
  if (isBlank(localTime)) {
    f.push(finding('REQUIRED', 'ERROR', 'localTime is required', 'localTime'));
  } else if (!BIO_TIME_RE.test(localTime) && !BIO_DDMM_RE.test(localTime)) {
    f.push(finding('BAD_DATETIME', 'ERROR', `localTime "${localTime}" must be YYYY-MM-DD HH:MM[:SS] (or DD-MM-YYYY)`, 'localTime'));
  }

  const direction = row.direction != null ? String(row.direction).trim() : null;
  // dedupKey natural key (per-file de-dup): code|time|direction. The DB @@unique on
  // (businessId, dedupKey) is the authoritative cross-batch guard; this just catches
  // an exact duplicate line WITHIN the file.
  const naturalKey = (deviceCode && localTime) ? `${deviceCode}|${localTime}|${direction || ''}` : null;
  const normalized = { deviceCode, localTimeRaw: localTime, rawDirection: direction || null, rawPayload: { ...row } };
  return done(f, normalized, naturalKey);
}

// ── LEAVE_BALANCE (leave-audit) ─────────────────────────────────────────────
function validateLeaveBalance(row, ctx) {
  const f = [];
  const empCode = row.employeeCode ? String(row.employeeCode).trim() : null;
  if (isBlank(empCode)) f.push(finding('REQUIRED', 'ERROR', 'employeeCode is required', 'employeeCode'));
  else if (ctx.employeeCodes && !ctx.employeeCodes.has(empCode)) f.push(finding('UNKNOWN_EMPLOYEE', 'ERROR', `employeeCode "${empCode}" not found`, 'employeeCode'));

  const typeCode = row.leaveTypeCode ? String(row.leaveTypeCode).trim().toUpperCase() : null;
  if (isBlank(typeCode)) f.push(finding('REQUIRED', 'ERROR', 'leaveTypeCode is required', 'leaveTypeCode'));

  const periodCode = row.periodCode ? String(row.periodCode).trim() : null;
  if (isBlank(periodCode)) f.push(finding('REQUIRED', 'ERROR', 'periodCode is required', 'periodCode'));
  else if (!/^\d{4}(-\S{1,10})?$/.test(periodCode)) f.push(finding('BAD_PERIOD', 'ERROR', `periodCode "${periodCode}" must look like "2026-27" or "2026-ANNIV"`, 'periodCode'));

  const opening = toNumber(row.openingBalance);
  if (row.openingBalance == null || row.openingBalance === '' || Number.isNaN(opening)) {
    f.push(finding('REQUIRED', 'ERROR', 'openingBalance must be a number', 'openingBalance'));
  } else if (opening < 0) {
    f.push(finding('BAD_NUMBER', 'ERROR', 'openingBalance must be ≥ 0 (use a manual adjustment for negatives)', 'openingBalance'));
  }

  const normalized = {
    employeeCode: empCode, leaveTypeCode: typeCode, periodCode,
    opening: Number.isNaN(opening) ? 0 : opening,
    note: row.note ? String(row.note).slice(0, 500) : null,
  };
  const naturalKey = empCode && typeCode && periodCode ? `${empCode}|${typeCode}|${periodCode}` : null;
  return done(f, normalized, naturalKey);
}

const VALIDATORS = {
  EMPLOYEE: validateEmployee,
  COMPENSATION: validateCompensation,
  ATTENDANCE: validateAttendance,
  PAYROLL_HISTORY: validatePayrollHistory,
  REIMBURSEMENT: validateReimbursement,
  BIOMETRIC: validateBiometric,
  LEAVE_BALANCE: validateLeaveBalance,
};

function validateRow(kind, row, ctx) {
  const fn = VALIDATORS[kind];
  if (!fn) throw new Error(`No validator for kind ${kind}`);
  return fn(row, ctx || {});
}

module.exports = { validateRow, VALIDATORS, ATT_STATUSES };
