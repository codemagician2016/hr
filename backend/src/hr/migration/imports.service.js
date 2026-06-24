'use strict';

/**
 * imports.service.js — Feature 18 import pipeline ORCHESTRATOR.
 *
 * upload → parse → map → validate → dry-run → commit → (autogen) → report.
 *
 * Design rules (mirroring the payroll/expenses orchestrators):
 *   - Tenant scope (businessId) threaded on EVERY query.
 *   - Idempotent in THREE layers: (1) job exactly-once on (businessId, kind,
 *     fileHash); (2) row upsert on (importJobId, naturalKey); (3) engine-level
 *     (createRun on code, freezeAttendance on (payRunId, employeeId), createClaim
 *     on (businessId, claimNumber)).
 *   - NEVER writes payroll math models (PayRunLine/Payslip) directly — commit
 *     stages facts (Employee/CTC/Attendance/Claim) and autogen.service drives the
 *     engines (computeRun / deriveBreakup / freezeAttendance / claim machine).
 *   - Dry-run runs the REAL commitRow path inside a $transaction that is rolled
 *     back via a sentinel error, so the preview matches reality to the paise.
 *   - Row isolation on COMMIT: one bad row → ImportRow.FAILED, batch continues.
 *     Dry-run rolls back the WHOLE simulation.
 *   - Money: file ₹ (major) → money.toMinor; all engine math in minor units.
 */

const crypto = require('crypto');
const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { tenantCountry, assertCountry } = require('../tenant/countryContext');
const money = require('../payroll/money');
const { allocateCode } = require('../lifecycle/lib/codes');
const { materializeRevisionLines } = require('../compensation/deriveBreakup');
const { mintClaimNumber, evaluateOneLine, buildPolicySnapshot, loadActivePolicy } = require('../expenses/expenses.service');

const csv = require('./parsers/csv');
const templates = require('./templates');
const { validateRow } = require('./validators');

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_ROWS = 20000;
const ALLOWED_MIME = new Set(['text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel']);

// Sentinel used to roll back a dry-run transaction after running the real path.
const DRY_RUN_ROLLBACK = Symbol('DRY_RUN_ROLLBACK');

// Distinct, non-human migration actor recorded as the checker on imported
// historical claims. Using a dedicated system actor (NEVER the importing operator
// and NEVER the claimant employee) preserves the maker≠checker SoD invariant: a
// bulk import can record a back-dated decision without letting the operator
// holding canManageImports act as both submitter and approver.
const MIGRATION_ACTOR = 'SYSTEM:MIGRATION';

class ImportError extends Error {
  constructor(code, message, statusCode = 400) { super(message || code); this.name = 'ImportError'; this.code = code; this.statusCode = statusCode; }
}
const notFound = (m) => new ImportError('NOT_FOUND', m, 404);
const badRequest = (c, m) => new ImportError(c, m, 400);

function today() { return new Date().toISOString().slice(0, 10); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/**
 * Strip a leading block of `#` comment lines (the template's data dictionary) so
 * a customer who uploads the template unedited still parses cleanly.
 */
function stripCommentLines(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trimStart().startsWith('#'))) i += 1;
  return lines.slice(i).join('\n');
}

// ===========================================================================
//  1. UPLOAD — create the ImportJob (exactly-once on fileHash) + parse rows
// ===========================================================================

/**
 * createJob — accept a base64 file body, hash it, parse it, persist the job +
 * staged rows. Exactly-once: a re-upload of identical bytes for the same kind
 * returns the EXISTING job (mirrors createRun's (businessId, code) guard).
 *
 * @param {Object} a { businessId, actorId, kind, entityId?, fileName, contentBase64,
 *                      mimeType?, options? }
 */
async function createJob({ businessId, actorId, kind, entityId = null, fileName, contentBase64, mimeType = 'text/csv', options = {} }) {
  if (!businessId) throw badRequest('NO_TENANT', 'businessId required');
  if (!templates.KINDS.includes(kind)) throw badRequest('BAD_KIND', `unknown import kind "${kind}"`);
  if (!contentBase64) throw badRequest('NO_FILE', 'file content required');

  // Feature 14 tripwire — fail-closed at pipeline entry: a quarantined
  // (hrCountryAmbiguous) or pre-setup tenant cannot start an import. Throws 409.
  await tenantCountry(businessId);

  // Validate a provided entityId belongs to THIS tenant + matches the tenant
  // country — never persist a foreign id that downstream readers would silently
  // null/fall-back from (masking operator error + weakening provenance).
  if (entityId) {
    const ent = await prisma.entity.findFirst({ where: { id: entityId, businessId, deletedAt: null }, select: { id: true, countryCode: true } });
    if (!ent) throw badRequest('UNKNOWN_ENTITY', `entityId "${entityId}" not found in this tenant`);
    if (ent.countryCode) await assertCountry(businessId, ent.countryCode);
  }

  // Decode + cap (size from base64 length without allocating, then the buffer).
  const b64 = String(contentBase64).replace(/^data:[^;,]+;base64,/, '');
  const approxBytes = Math.floor(b64.replace(/=+$/, '').length * 3 / 4);
  if (approxBytes > MAX_BYTES) throw badRequest('FILE_TOO_LARGE', `file exceeds the ${MAX_BYTES / (1024 * 1024)}MB cap`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_BYTES) throw badRequest('FILE_TOO_LARGE', `file exceeds the ${MAX_BYTES / (1024 * 1024)}MB cap`);
  if (mimeType && !ALLOWED_MIME.has(mimeType) && !/\.csv$/i.test(fileName || '')) {
    // XLSX is not supported in this build (no parser dependency installed) — guide
    // the operator to CSV rather than silently mis-parse binary bytes.
    if (/spreadsheet|excel|xlsx/i.test(mimeType) || /\.xlsx?$/i.test(fileName || '')) {
      throw badRequest('XLSX_UNSUPPORTED', 'XLSX import requires the optional `xlsx` dependency (not installed). Save the sheet as CSV and re-upload.');
    }
  }

  const fileHash = sha256(buf);

  // Exactly-once guard.
  const existing = await prisma.importJob.findFirst({ where: { businessId, kind, fileHash, deletedAt: null } });
  if (existing) return getJob({ businessId, jobId: existing.id });

  // Parse now so the upload response shows detected headers + row count.
  const text = stripCommentLines(buf.toString('utf8'));
  const parsed = csv.parseCsv(text);
  if (parsed.rows.length > MAX_ROWS) throw badRequest('TOO_MANY_ROWS', `file has ${parsed.rows.length} rows; the cap is ${MAX_ROWS}. Split the file.`);

  const fileKey = `imports/${businessId}/${kind}/${fileHash}.csv`;

  const job = await prisma.importJob.create({
    data: {
      businessId, entityId, kind, status: 'PARSED',
      fileName: fileName || `${kind.toLowerCase()}.csv`,
      fileKey, fileHash, mimeType, rowCount: parsed.rows.length,
      mappingJson: defaultMapping(kind, parsed.headers),
      optionsJson: options || {},
      uploadedBy: actorId || 'system',
    },
  });

  await persistRows(job.id, businessId, kind, parsed, job.mappingJson);

  await writeAudit({ businessId, actorId, action: 'import.upload', entityType: 'ImportJob', entityId: job.id, meta: { kind, fileHash, rows: parsed.rows.length } });
  return getJob({ businessId, jobId: job.id });
}

/** Identity mapping for headers that match a canonical field (case-insensitive). */
function defaultMapping(kind, headers) {
  const canon = new Map(templates.canonicalFields(kind).map((c) => [c.toLowerCase(), c]));
  const map = {};
  for (const h of headers || []) {
    const hit = canon.get(String(h).trim().toLowerCase());
    if (hit) map[h] = hit;
  }
  return map;
}

/** Apply mapping (sourceHeader→canonicalField) to a raw row. */
function applyMapping(rawRow, mapping) {
  const out = {};
  for (const [src, canonical] of Object.entries(mapping || {})) {
    if (canonical) out[canonical] = rawRow[src] != null ? rawRow[src] : null;
  }
  return out;
}

/** Persist (replace) the staged ImportRows for a job. Idempotent re-parse. */
async function persistRows(jobId, businessId, kind, parsed, mapping) {
  await prisma.importRow.deleteMany({ where: { importJobId: jobId } });
  const seen = new Set();
  const data = [];
  for (let i = 0; i < parsed.rows.length; i += 1) {
    const raw = parsed.rows[i];
    const mapped = applyMapping(raw, mapping);
    // A provisional natural key so the @@unique([importJobId, naturalKey]) holds.
    // Validation re-derives the authoritative key; we de-dup blanks with the row #.
    let nk = `__row_${i + 1}`;
    data.push({ businessId, importJobId: jobId, rowNumber: i + 1, rawJson: raw, parsedJson: mapped, naturalKey: nk, status: 'PARSED' });
    seen.add(nk);
  }
  if (data.length) await prisma.importRow.createMany({ data });
}

// ===========================================================================
//  2. MAPPING — save a new mapping + re-parse from the stored rawJson
// ===========================================================================
async function updateMapping({ businessId, actorId, jobId, mapping }) {
  const job = await mustJob(businessId, jobId);
  assertMutable(job);
  const rows = await prisma.importRow.findMany({ where: { importJobId: jobId }, orderBy: { rowNumber: 'asc' } });
  await prisma.$transaction(async (tx) => {
    await tx.importJob.update({ where: { id: jobId }, data: { mappingJson: mapping, status: 'PARSED', validatedAt: null, previewJson: null } });
    for (const r of rows) {
      await tx.importRow.update({ where: { id: r.id }, data: { parsedJson: applyMapping(r.rawJson, mapping), status: 'PARSED', findingsJson: null } });
    }
  });
  return getJob({ businessId, jobId });
}

// ===========================================================================
//  3. VALIDATE — pure per-kind validators + job-level mapping/required check
// ===========================================================================

/** Pre-load the lookup ctx the PURE validators need (the only DB the validate step does). */
async function loadValidationCtx(job) {
  const { businessId } = job;
  // Feature 14 — the AUTHORITATIVE tenant country (fail-closed). No `|| 'IN'`
  // fallback: a quarantined / pre-setup tenant throws here (409) rather than
  // silently validating against India rules.
  const countryCode = await tenantCountry(businessId);
  const entities = await prisma.entity.findMany({ where: { businessId, deletedAt: null }, select: { id: true, code: true, countryCode: true } });
  // Validators only ever scope to entities that match the tenant country — a
  // multi-country tenant (e.g. a leftover NZ-AKL on an IN tenant) must not let an
  // off-country entity's code validate as known. Restrict the entity-code set to
  // the tenant country so an import targeting the wrong market is rejected.
  const entityCodes = new Set(entities.filter((e) => e.countryCode === countryCode).map((e) => e.code));
  const employees = await prisma.employee.findMany({ where: { businessId, deletedAt: null }, select: { id: true, code: true } });
  const employeeCodes = new Set(employees.map((e) => e.code));
  const employeeByCode = new Map(employees.map((e) => [e.code, { id: e.id }]));
  // A pinned entity must match the tenant country (the createJob guard already
  // asserts this; re-assert defensively in case the job predates the guard).
  if (job.entityId) {
    const e = entities.find((x) => x.id === job.entityId);
    if (e && e.countryCode) await assertCountry(businessId, e.countryCode);
  }
  return { countryCode, entityCodes, employeeCodes, employeeByCode, today: today(), mode: job.optionsJson || {} };
}

async function validate({ businessId, actorId, jobId }) {
  const job = await mustJob(businessId, jobId);
  assertMutable(job);
  const ctx = await loadValidationCtx(job);
  const rows = await prisma.importRow.findMany({ where: { importJobId: jobId }, orderBy: { rowNumber: 'asc' } });

  // Job-level: required canonical fields must be mapped (else dry-run is blocked).
  const mappedTargets = new Set(Object.values(job.mappingJson || {}));
  const jobFindings = [];
  for (const req of templates.requiredFields(job.kind)) {
    if (!mappedTargets.has(req)) jobFindings.push({ code: 'UNMAPPED_REQUIRED', severity: 'ERROR', field: req, message: `required field "${req}" is not mapped to any source column` });
  }

  let pass = 0; let warn = 0; let error = 0;
  const keysSeen = new Map();
  await prisma.$transaction(async (tx) => {
    for (const r of rows) {
      const res = validateRow(job.kind, r.parsedJson, ctx);
      const findings = res.findings.slice();
      // Duplicate natural key WITHIN the file → second occurrence is an ERROR.
      // CRITICAL: a colliding row must NOT be written with the SAME naturalKey or
      // tx.importRow.update violates @@unique([importJobId, naturalKey]) → P2002 →
      // the whole $transaction rolls back and the request 500s (the duplicate is
      // never surfaced as a row finding). Keep the colliding row's key as the
      // row-unique sentinel __row_N so the unique holds AND we still report it.
      let nk;
      if (res.naturalKey && !keysSeen.has(res.naturalKey)) {
        nk = res.naturalKey;
        keysSeen.set(res.naturalKey, r.rowNumber);
      } else if (res.naturalKey) {
        // Duplicate within the file — report it, keep a unique sentinel key.
        findings.push({ code: 'DUPLICATE_IN_FILE', severity: 'ERROR', message: `duplicate natural key "${res.naturalKey}" (first seen at row ${keysSeen.get(res.naturalKey)})` });
        nk = `__row_${r.rowNumber}`;
      } else {
        nk = `__row_${r.rowNumber}`;
      }
      const status = findings.some((f) => f.severity === 'ERROR') ? 'ERROR' : findings.some((f) => f.severity === 'WARN') ? 'WARN' : 'PASS';
      if (status === 'ERROR') error += 1; else if (status === 'WARN') warn += 1; else pass += 1;
      await tx.importRow.update({ where: { id: r.id }, data: { status, naturalKey: nk, findingsJson: findings, parsedJson: { ...r.parsedJson, __normalized: res.normalized } } });
    }
    await tx.importJob.update({ where: { id: jobId }, data: { status: jobFindings.length ? 'PARSED' : 'VALIDATED', passCount: pass, warnCount: warn, errorCount: error, validatedAt: new Date(), previewJson: { jobFindings } } });
  });

  return { ...(await getJob({ businessId, jobId })), jobFindings };
}

// ===========================================================================
//  4. DRY-RUN — run the REAL commit+autogen path in a rolled-back transaction
// ===========================================================================
async function dryRun({ businessId, actorId, jobId }) {
  const job = await mustJob(businessId, jobId);
  await validate({ businessId, actorId, jobId }); // always re-validate first
  const fresh = await mustJob(businessId, jobId);
  if (fresh.previewJson && fresh.previewJson.jobFindings && fresh.previewJson.jobFindings.length) {
    throw badRequest('UNMAPPED_REQUIRED', 'required fields are unmapped — fix the mapping before dry-run');
  }

  const preview = { kind: job.kind, perRow: [], totals: {} };

  if (job.kind === 'PAYROLL_HISTORY') {
    // PAYROLL_HISTORY dry-run shows ENGINE-TRUE net pay. computeRun opens its own
    // interactive transaction, so it cannot run inside an outer rolled-back tx.
    // Instead we GENERATE for real (engine-true) then unwind by deleting the
    // not-yet-approved MIGRATED runs by importJobId (provenance, §11 unwind) — so
    // the preview matches reality to the paise yet persists nothing net.
    const autogen = require('./autogen.service');
    try {
      const out = await autogen.runPayrollAutogen({ businessId, actorId, jobId, _dryRun: true });
      preview.perRow = (out.periods || []).flatMap((p) => (p.employees || []).map((e) => ({ periodMonth: p.periodMonth, employeeCode: e.code, action: 'created', targetType: 'Payslip', netPay: e.netPay, mismatches: e.mismatches })));
      preview.totals = { periods: (out.periods || []).length, payslips: preview.perRow.length, totalNet: (out.periods || []).reduce((s, p) => s + (p.totalNet || 0), 0) };
      preview.findings = (out.periods || []).flatMap((p) => p.findings || []).concat(out.findings || []);
    } finally {
      await unwindMigratedRuns(businessId, jobId); // delete the simulated runs (DRAFT/COMPUTED only)
    }
  } else {
    try {
      await prisma.$transaction(async (tx) => {
        const out = await commitRows(tx, fresh, actorId, { dryRun: true });
        preview.perRow = out.perRow;
        preview.totals = out.totals;
        throw DRY_RUN_ROLLBACK; // roll back EVERYTHING the simulation wrote
      }, { timeout: 120000, maxWait: 15000 });
    } catch (e) {
      if (e !== DRY_RUN_ROLLBACK) throw e;
    }
  }

  await prisma.importJob.update({ where: { id: jobId }, data: { status: fresh.errorCount > 0 && fresh.passCount + fresh.warnCount === 0 ? 'VALIDATED' : 'DRY_RUN_OK', previewJson: { ...(fresh.previewJson || {}), preview } } });
  await writeAudit({ businessId, actorId, action: 'import.dryrun', entityType: 'ImportJob', entityId: jobId, meta: { kind: job.kind, totals: preview.totals } });
  return { ...(await getJob({ businessId, jobId })), preview };
}

/**
 * unwindMigratedRuns — targeted delete of the NOT-YET-APPROVED MIGRATED runs a
 * dry-run (or a not-yet-finalised import) produced, keyed on importJobId (§11
 * unwind). APPROVED/PAID/FILED runs are NEVER hard-deleted — they follow the
 * normal correction path; here a dry-run only ever produces DRAFT/COMPUTED runs.
 */
async function unwindMigratedRuns(businessId, jobId) {
  const runs = await prisma.payRun.findMany({ where: { businessId, importJobId: jobId, status: { in: ['DRAFT', 'INPUTS_LOCKED', 'COMPUTED', 'REVIEW'] } }, select: { id: true } });
  const ids = runs.map((r) => r.id);
  if (!ids.length) return;
  await prisma.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { payRunId: { in: ids } } });
    await tx.payRunLineComponent.deleteMany({ where: { payRunLine: { payRunId: { in: ids } } } });
    await tx.payRunLine.deleteMany({ where: { payRunId: { in: ids } } });
    await tx.attendancePayInput.deleteMany({ where: { payRunId: { in: ids } } });
    await tx.payRun.deleteMany({ where: { id: { in: ids } } });
  }, { timeout: 60000 });
}

// ===========================================================================
//  5. COMMIT — write the staged rows via the reused engines (row-isolated)
// ===========================================================================
async function commit({ businessId, actorId, jobId, autoGenerate = true }) {
  const job = await mustJob(businessId, jobId);
  if (job.status === 'COMMITTED') return getJob({ businessId, jobId });
  await validate({ businessId, actorId, jobId });
  const fresh = await mustJob(businessId, jobId);
  if (fresh.previewJson && fresh.previewJson.jobFindings && fresh.previewJson.jobFindings.length) {
    throw badRequest('UNMAPPED_REQUIRED', 'required fields are unmapped — fix the mapping before commit');
  }

  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMMITTING', committedBy: actorId || 'system' } });

  let committed = 0; let skipped = 0; let failed = 0;
  const rows = await prisma.importRow.findMany({ where: { importJobId: jobId, status: { in: ['PASS', 'WARN'] } }, orderBy: { rowNumber: 'asc' } });
  for (const row of rows) {
    try {
      // Each row commits in its OWN transaction — a throw isolates to this row.
      const result = await prisma.$transaction((tx) => commitOneRow(tx, fresh, row, actorId, { dryRun: false }), { timeout: 60000 });
      if (result.action === 'skipped') skipped += 1; else committed += 1;
      await prisma.importRow.update({ where: { id: row.id }, data: { status: result.action === 'skipped' ? 'SKIPPED' : 'COMMITTED', resultJson: result, targetType: result.targetType || null, targetId: result.targetId || null } });
    } catch (e) {
      failed += 1;
      const findings = (row.findingsJson || []).concat([{ code: 'COMMIT_FAILED', severity: 'ERROR', message: e.message }]);
      await prisma.importRow.update({ where: { id: row.id }, data: { status: 'FAILED', findingsJson: findings } });
    }
  }

  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMMITTED', committedCount: committed, skippedCount: skipped, committedAt: new Date() } });
  await writeAudit({ businessId, actorId, action: 'import.commit', entityType: 'ImportJob', entityId: jobId, meta: { kind: job.kind, committed, skipped, failed, fileHash: job.fileHash } });

  // Autogen pass (payroll history → payslips). Reimbursement autogen IS the commit.
  let autogen = null;
  if (autoGenerate && job.kind === 'PAYROLL_HISTORY') {
    const driver = require('./autogen.service');
    // Sweep any leftover dry-run PREVIEW migrated run for this job before the real
    // autogen (an orphan from a crashed dry-run must never be adopted/approved).
    await driver.sweepPreviewRuns(businessId, jobId);
    autogen = await driver.runPayrollAutogen({ businessId, actorId, jobId });
  }
  return { ...(await getJob({ businessId, jobId })), commitSummary: { committed, skipped, failed }, autogen };
}

// ── commitRows: dry-run wrapper that runs every PASS/WARN row inside ONE tx ──
async function commitRows(tx, job, actorId, opts) {
  const rows = await tx.importRow.findMany({ where: { importJobId: job.id, status: { in: ['PASS', 'WARN'] } }, orderBy: { rowNumber: 'asc' } });
  const perRow = []; let created = 0; let updated = 0; let skipped = 0;
  for (const row of rows) {
    const result = await commitOneRow(tx, job, row, actorId, opts);
    if (result.action === 'created') created += 1; else if (result.action === 'updated') updated += 1; else skipped += 1;
    perRow.push({ rowNumber: row.rowNumber, naturalKey: row.naturalKey, ...result });
  }
  return { perRow, totals: { created, updated, skipped, rows: rows.length } };
}

/** Dispatch a single staged row to its per-kind committer. Returns a result obj. */
async function commitOneRow(tx, job, row, actorId, opts) {
  const n = (row.parsedJson && row.parsedJson.__normalized) || {};
  switch (job.kind) {
    case 'EMPLOYEE': return commitEmployee(tx, job, n, opts);
    case 'COMPENSATION': return commitCompensation(tx, job, n, opts);
    case 'ATTENDANCE': return commitAttendance(tx, job, n, opts);
    case 'PAYROLL_HISTORY': return commitPayrollHistory(tx, job, n, opts);
    case 'REIMBURSEMENT': return commitReimbursement(tx, job, n, actorId, opts);
    default: throw new Error(`no committer for kind ${job.kind}`);
  }
}

// ── resolve the entity for a job (pinned, else the row's entityCode, else first) ──
async function resolveEntity(tx, businessId, job, entityCode) {
  if (entityCode) {
    const e = await tx.entity.findFirst({ where: { businessId, code: entityCode, deletedAt: null } });
    if (e) return e;
  }
  if (job.entityId) { const e = await tx.entity.findFirst({ where: { businessId, id: job.entityId } }); if (e) return e; }
  return tx.entity.findFirst({ where: { businessId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
}

// ── EMPLOYEE committer ──────────────────────────────────────────────────────
async function commitEmployee(tx, job, n, _opts) {
  const { businessId } = job;
  const entity = await resolveEntity(tx, businessId, job, n.entityCode);
  if (!entity) throw new Error(`entity "${n.entityCode}" not resolvable`);

  // Idempotent: by code, else by workEmail. Existing → update.
  let existing = null;
  if (n.code) existing = await tx.employee.findFirst({ where: { businessId, code: n.code } });
  if (!existing && n.workEmail) existing = await tx.employee.findFirst({ where: { businessId, workEmail: n.workEmail } });

  const location = n.locationCode ? await tx.location.findFirst({ where: { businessId, code: n.locationCode } }) : null;
  const department = n.departmentCode ? await tx.department.findFirst({ where: { businessId, code: n.departmentCode } }) : null;
  const designation = n.designationCode ? await tx.designation.findFirst({ where: { businessId, code: n.designationCode } }) : null;
  const manager = n.managerCode ? await tx.employee.findFirst({ where: { businessId, code: n.managerCode } }) : null;

  if (existing) {
    await tx.employee.update({ where: { id: existing.id }, data: { firstName: n.firstName, lastName: n.lastName, workEmail: n.workEmail || existing.workEmail, personalEmail: n.personalEmail || existing.personalEmail, phone: n.phone || existing.phone, gender: n.gender || existing.gender, dateOfBirth: n.dateOfBirth ? new Date(`${n.dateOfBirth}T00:00:00Z`) : existing.dateOfBirth } });
    await upsertStatutory(tx, businessId, existing.id, entity.countryCode, n);
    return { action: 'updated', targetType: 'Employee', targetId: existing.id, code: existing.code };
  }

  const code = n.code || await allocateCode(tx, { businessId, scope: 'EMPLOYEE' });
  const emp = await tx.employee.create({
    data: {
      businessId, code,
      firstName: n.firstName, lastName: n.lastName,
      workEmail: n.workEmail, personalEmail: n.personalEmail || n.workEmail, phone: n.phone || null,
      gender: n.gender || undefined,
      dateOfBirth: n.dateOfBirth ? new Date(`${n.dateOfBirth}T00:00:00Z`) : null,
      countryCode: entity.countryCode,
      stateCode: n.ptStateCode || entity.stateCode || null,
      isActive: true,
      hireDate: n.dateOfJoining ? new Date(`${n.dateOfJoining}T00:00:00Z`) : null,
      managerEmployeeId: manager ? manager.id : null,
    },
  });
  const empRec = await tx.employmentRecord.create({
    data: {
      businessId, employeeId: emp.id, entityId: entity.id,
      locationId: location ? location.id : null, departmentId: department ? department.id : null,
      designationId: designation ? designation.id : null, gradeId: null,
      managerEmployeeId: manager ? manager.id : null,
      employmentType: 'FULL_TIME', workerCategory: 'STAFF',
      fteRatio: '1.0000', effectiveFrom: n.dateOfJoining ? new Date(`${n.dateOfJoining}T00:00:00Z`) : new Date(),
      changeReason: 'HIRE', isCurrent: true,
    },
  });
  await tx.employee.update({ where: { id: emp.id }, data: { currentEmploymentRecordId: empRec.id } });
  await upsertStatutory(tx, businessId, emp.id, entity.countryCode, n);
  return { action: 'created', targetType: 'Employee', targetId: emp.id, code };
}

async function upsertStatutory(tx, businessId, employeeId, countryCode, n) {
  const data = countryCode === 'IN'
    ? { countryCode: 'IN', pan: n.pan || null, uan: n.uan || null, esiApplicable: n.esiApplicable === true, esicIp: n.esiNumber || null, ptStateCode: n.ptStateCode || null }
    : { countryCode };
  await tx.statutoryProfile.upsert({ where: { employeeId }, update: data, create: { businessId, employeeId, ...data } });
}

// ── COMPENSATION committer (deriveBreakup → CompensationRevision + lines) ────
async function commitCompensation(tx, job, n, _opts) {
  const { businessId } = job;
  const emp = await tx.employee.findFirst({ where: { businessId, code: n.employeeCode } });
  if (!emp) throw new Error(`employee "${n.employeeCode}" not found`);
  const empRec = await tx.employmentRecord.findFirst({ where: { businessId, employeeId: emp.id, isCurrent: true } });
  const entity = await tx.entity.findFirst({ where: { businessId, id: empRec ? empRec.entityId : job.entityId } }) || await resolveEntity(tx, businessId, job, null);
  if (!entity) throw new Error('entity not resolvable for compensation');

  const effectiveFrom = new Date(`${n.effectiveFrom}T00:00:00Z`);
  // Idempotent on (employeeId, effectiveFrom) — the model's @@unique.
  const existing = await tx.compensationRevision.findFirst({ where: { employeeId: emp.id, effectiveFrom } });
  if (existing) return { action: 'skipped', targetType: 'CompensationRevision', targetId: existing.id, reason: 'revision already exists for this effectiveFrom' };

  // Resolve a structure (named, else entity/tenant default) → its component lines.
  const structure = await resolveStructure(tx, businessId, entity.id, n.structureCode);
  if (!structure || !structure.lines || !structure.lines.length) throw new Error('no salary structure available to derive the CTC breakup');

  const target = n.basis === 'CTC' ? { ctcAnnualMinor: n.ctcAnnualMinor } : { grossMonthlyMinor: n.grossMonthlyMinor };
  const { lines: lineCreates, breakup } = materializeRevisionLines(
    { lines: structure.lines, basis: n.basis },
    { target, basis: n.basis, countryCode: entity.countryCode, asOf: n.effectiveFrom, capPfAtCeiling: true, esiApplicable: false },
  );
  // India 50% Basic+DA wage-floor reuse: a breach is surfaced as a finding (the
  // engine's wagesVerdict), not silently allowed. ERROR if it breaches.
  if (breakup.wagesVerdict && breakup.wagesVerdict.applies && breakup.wagesVerdict.ok === false && breakup.wagesVerdict.ruleApplied) {
    throw new Error(`India 50% Basic+DA wage floor breached (wages ₹${money.fromMinor(breakup.wagesVerdict.wagesMinor || 0)} < floor ₹${money.fromMinor(breakup.wagesVerdict.floorMinor || 0)})`);
  }

  // Close any open current revision (effectiveTo = day before this one).
  await tx.compensationRevision.updateMany({ where: { businessId, employeeId: emp.id, isCurrent: true }, data: { isCurrent: false, effectiveTo: new Date(effectiveFrom.getTime() - 86400000) } });

  const rev = await tx.compensationRevision.create({
    data: {
      businessId, employeeId: emp.id, entityId: entity.id,
      structureId: structure.id || null, currencyCode: entity.payCurrency || 'INR',
      basis: n.basis,
      ctcAnnual: n.ctcAnnualMinor != null ? money.fromMinor(n.ctcAnnualMinor) : null,
      grossMonthly: n.grossMonthlyMinor != null ? money.fromMinor(n.grossMonthlyMinor) : (breakup.grossMinor != null ? money.fromMinor(breakup.grossMinor) : null),
      effectiveFrom, isCurrent: true, revisionReason: 'HIRE', status: 'EFFECTIVE',
      lines: { create: lineCreates.map((l) => ({ businessId, componentId: l.componentId, calcMethod: l.calcMethod, calcValue: l.calcValue, amountMonthly: l.amountMonthly, amountAnnual: l.amountAnnual, sortOrder: l.sortOrder })) },
    },
  });
  return { action: 'created', targetType: 'CompensationRevision', targetId: rev.id, grossMonthly: money.fromMinor(breakup.grossMinor) };
}

/** Resolve a salary structure + its lines (named code, else entity/tenant default). */
async function resolveStructure(tx, businessId, entityId, structureCode) {
  const include = { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } };
  if (structureCode) {
    const s = await tx.salaryStructure.findFirst({ where: { businessId, code: structureCode }, include });
    if (s) return s;
  }
  // Prefer an entity-scoped active default; else any active structure for the tenant.
  let s = await tx.salaryStructure.findFirst({ where: { businessId, entityId, isActive: true }, include, orderBy: { createdAt: 'asc' } });
  if (!s) s = await tx.salaryStructure.findFirst({ where: { businessId, isActive: true }, include, orderBy: { createdAt: 'asc' } });
  if (!s) s = await tx.salaryStructure.findFirst({ where: { businessId }, include, orderBy: { createdAt: 'asc' } });
  return s;
}

// ── ATTENDANCE committer ────────────────────────────────────────────────────
async function commitAttendance(tx, job, n, _opts) {
  const { businessId } = job;
  const emp = await tx.employee.findFirst({ where: { businessId, code: n.employeeCode } });
  if (!emp) throw new Error(`employee "${n.employeeCode}" not found`);

  if (n.mode === 'DAILY') {
    const date = new Date(`${n.date}T00:00:00Z`);
    const existing = await tx.attendance.findFirst({ where: { businessId, employeeId: emp.id, date } });
    if (existing && existing.isLocked) return { action: 'skipped', targetType: 'Attendance', targetId: existing.id, reason: 'day is locked (frozen); not clobbered' };
    const lopFraction = n.status === 'ABSENT' ? 1 : n.status === 'HALF_DAY' ? 0.5 : 0;
    const data = { status: n.status, lopFraction, importJobId: job.id, exceptionsJson: n.otHours ? { otEquivalentHours: n.otHours } : undefined };
    if (existing) { await tx.attendance.update({ where: { id: existing.id }, data }); return { action: 'updated', targetType: 'Attendance', targetId: existing.id }; }
    const created = await tx.attendance.create({ data: { businessId, employeeId: emp.id, date, ...data } });
    return { action: 'created', targetType: 'Attendance', targetId: created.id };
  }
  // SUMMARY mode: the rollup figures are STAGED on the ImportRow.resultJson — the
  // payroll autogen reads them and writes AttendancePayInput AFTER the MIGRATED
  // run exists (AttendancePayInput requires a payRunId). Nothing to write now.
  return { action: 'created', targetType: 'AttendanceSummary', targetId: `${n.employeeCode}|${n.periodMonth}`, staged: { payableDays: n.payableDays, lopDays: n.lopDays, paidLeaveDays: n.paidLeaveDays, otHours: n.otHours } };
}

// ── PAYROLL_HISTORY committer — the commit only STAGES; autogen generates. ────
async function commitPayrollHistory(tx, job, n, _opts) {
  const { businessId } = job;
  const emp = await tx.employee.findFirst({ where: { businessId, code: n.employeeCode } });
  if (!emp) throw new Error(`employee "${n.employeeCode}" not found`);
  // The row is a request to generate a MIGRATED run for (employee, periodMonth).
  // We resolve nothing destructive here; the autogen pass (post-commit) does the
  // createRun→computeRun. Staging the request keeps the commit idempotent + lets
  // the dry-run preview compute the engine-true net pay.
  return { action: 'created', targetType: 'PayrollHistoryRequest', targetId: `${n.employeeCode}|${n.periodMonth}`, staged: n };
}

/**
 * ensureExpSequenceAheadOfLegacy — seed/advance the tenant's EXP NumberSequence so
 * mintClaimNumber never collides with a legacy EXP-#### claim minted before the
 * atomic allocator existed. Idempotent: a no-op once the sequence is already ahead.
 */
async function ensureExpSequenceAheadOfLegacy(tx, businessId) {
  const existing = await tx.numberSequence.findFirst({ where: { businessId, entityId: null, scope: 'EXP', periodKey: null } });
  // Find the max numeric suffix of existing EXP-#### claims for this tenant.
  const claims = await tx.expenseClaim.findMany({ where: { businessId, claimNumber: { startsWith: 'EXP-' } }, select: { claimNumber: true } });
  let maxN = 0;
  for (const c of claims) { const m = /EXP-(\d+)/.exec(c.claimNumber || ''); if (m) maxN = Math.max(maxN, Number(m[1])); }
  const want = maxN + 1;
  if (!existing) {
    await tx.numberSequence.create({ data: { businessId, entityId: null, scope: 'EXP', prefix: 'EXP-', padding: 4, nextValue: want, periodKey: null } });
  } else if (existing.nextValue < want) {
    await tx.numberSequence.update({ where: { id: existing.id }, data: { nextValue: want } });
  }
}

// ── REIMBURSEMENT committer — createClaim + back-dated status-drive ──────────
async function commitReimbursement(tx, job, n, actorId, _opts) {
  const { businessId } = job;
  const emp = await tx.employee.findFirst({ where: { businessId, code: n.employeeCode } });
  if (!emp) throw new Error(`employee "${n.employeeCode}" not found`);

  // Idempotent on (businessId, claimNumber) when given; else on the synthetic key.
  if (n.claimNumber) {
    const dup = await tx.expenseClaim.findFirst({ where: { businessId, claimNumber: n.claimNumber } });
    if (dup) return { action: 'skipped', targetType: 'ExpenseClaim', targetId: dup.id, reason: 'claimNumber already exists' };
  } else {
    const expenseDate = new Date(`${n.expenseDate}T00:00:00Z`);
    const dup = await tx.expenseClaim.findFirst({ where: { businessId, employeeId: emp.id, expenseDate, amount: money.fromMinor(n.claimedMinor), description: n.description || null, importJobId: { not: null } } });
    if (dup) return { action: 'skipped', targetType: 'ExpenseClaim', targetId: dup.id, reason: 'matching imported claim already exists' };
  }

  const category = n.categoryCode ? await tx.expenseCategory.findFirst({ where: { businessId, code: n.categoryCode } }) : null;
  // Mint a claim number through the SAME atomic allocator the live expense flow
  // uses. Legacy tenants may carry EXP-#### claims minted before the allocator
  // existed (no NumberSequence row), so the first mint can collide — fast-forward
  // the EXP sequence past the existing max BEFORE minting (idempotent, one-time).
  if (!n.claimNumber) await ensureExpSequenceAheadOfLegacy(tx, businessId);
  const claimNumber = n.claimNumber || await mintClaimNumber(tx, businessId);
  const expenseDate = new Date(`${n.expenseDate}T00:00:00Z`);

  // Resolve the employee's entity country (NOT a hardcoded 'IN') so the policy
  // engine evaluates against the right market's TravelPolicy. Fail-closed to the
  // tenant country if the employment entity is unresolvable.
  const empRec = await tx.employmentRecord.findFirst({ where: { businessId, employeeId: emp.id, isCurrent: true }, select: { entityId: true } });
  const entity = await tx.entity.findFirst({ where: { businessId, id: empRec ? empRec.entityId : job.entityId }, select: { countryCode: true } });
  const claimCountry = (entity && entity.countryCode) || await tenantCountry(businessId);

  // Run the PURE policy engine for a verdict (recorded, NOT blocking for migrated
  // history per §6.5 — a cap breach is a WARN, the claim still imports).
  let policyVerdict = 'NO_POLICY'; let policyReason = null; let policySnapshot = null;
  try {
    const policy = await loadActivePolicy(businessId, { entityId: null, countryCode: claimCountry });
    if (policy) {
      const line = { amount: money.fromMinor(n.claimedMinor), categoryId: category ? category.id : null, description: n.description };
      const v = await evaluateOneLine(businessId, emp.id, line, { policy });
      policyVerdict = v.verdict || 'OK'; policyReason = v.reason || null;
      policySnapshot = buildPolicySnapshot(policy, [{ ...line, ...v }]);
    }
  } catch (e) { /* policy is advisory for migrated history; never block */ }

  // MAKER-CHECKER SoD — an imported historical claim records a back-dated decision
  // from the PRIOR system. The checker must NEVER be the importing operator
  // (canManageImports holder) and NEVER the claimant employee. Use the prior
  // system's approver from the file when it isn't the employee, else a dedicated
  // SYSTEM:MIGRATION actor. This preserves maker≠checker (the import door cannot be
  // used to self-approve) while keeping the owner's intent (claims land as their
  // historical APPROVED/REIMBURSED state). Provenance is recorded for audit.
  // The forbidden set is the CLAIMANT (code/userId/id) AND the importing operator
  // (actorId, the canManageImports holder). An approvedBy equal to EITHER falls back
  // to the dedicated MIGRATION_ACTOR — the import door can never be used to
  // self-approve (operator-as-checker) nor to record the claimant approving their own
  // claim. Only a genuine prior-system approver (neither) is honoured as the checker.
  const forbidden = new Set([emp.code, emp.userId, emp.id, actorId].filter(Boolean));
  const priorApprover = (n.approvedBy && !forbidden.has(n.approvedBy)) ? n.approvedBy : null;
  const checker = priorApprover || MIGRATION_ACTOR;
  const provenance = {
    migrated: true, importJobId: job.id, importedBy: actorId || 'system',
    priorApprover: n.approvedBy || null, checker,
    note: 'Bulk-imported historical claim; checker is a non-human migration actor (SoD preserved).',
  };
  const snapshotWithProvenance = { ...(policySnapshot || {}), __migration: provenance };

  const reimbursed = n.status === 'REIMBURSED';
  const claim = await tx.expenseClaim.create({
    data: {
      businessId, employeeId: emp.id, categoryId: category ? category.id : null,
      claimNumber, amount: money.fromMinor(n.claimedMinor), currencyCode: 'INR',
      description: n.description || null, expenseDate,
      status: reimbursed ? 'REIMBURSED' : 'APPROVED',
      submittedAt: expenseDate,
      // Checker is the migration/prior-system actor — NEVER the importing operator
      // and NEVER the claimant (maker≠checker SoD invariant).
      decidedAt: expenseDate, decidedBy: checker,
      reimbursedAt: reimbursed && n.reimbursedAt ? new Date(`${n.reimbursedAt}T00:00:00Z`) : (reimbursed ? expenseDate : null),
      reimbursedBy: reimbursed ? checker : null,
      paymentRef: reimbursed ? (n.paymentRef || null) : null,
      policyVerdict, policySnapshotJson: snapshotWithProvenance,
      importJobId: job.id,
      // approved amount lands on the line (claimed) + the claim total (= approved).
      lines: { create: [{ businessId, description: n.description || 'Imported claim', amount: money.fromMinor(n.approvedMinor != null ? n.approvedMinor : n.claimedMinor), expenseDate, categoryId: category ? category.id : null, policyStatus: policyVerdict, policyReason }] },
    },
  });
  return { action: 'created', targetType: 'ExpenseClaim', targetId: claim.id, claimNumber, claimed: money.fromMinor(n.claimedMinor), approved: money.fromMinor(n.approvedMinor != null ? n.approvedMinor : n.claimedMinor), status: claim.status };
}

// ===========================================================================
//  Reads + helpers
// ===========================================================================
async function getJob({ businessId, jobId }) {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, businessId, deletedAt: null }, include: { entity: { select: { id: true, code: true, countryCode: true } } } });
  if (!job) throw notFound('Import job not found');
  return job;
}
async function mustJob(businessId, jobId) { return getJob({ businessId, jobId }); }
function assertMutable(job) { if (['COMMITTED', 'COMMITTING', 'CANCELLED'].includes(job.status)) throw badRequest('IMMUTABLE_JOB', `job is ${job.status} — cannot modify`); }

async function listJobs({ businessId, kind, status, page = 1, pageSize = 25 }) {
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { businessId, deletedAt: null };
  if (kind) where.kind = kind; if (status) where.status = status;
  const [items, total] = await Promise.all([
    prisma.importJob.findMany({ where, orderBy: { uploadedAt: 'desc' }, skip, take, include: { entity: { select: { code: true } } } }),
    prisma.importJob.count({ where }),
  ]);
  return { items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take };
}

async function listRows({ businessId, jobId, status, page = 1, pageSize = 100 }) {
  await mustJob(businessId, jobId);
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 100, 1), 500);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { importJobId: jobId };
  if (status) where.status = status;
  const [items, total] = await Promise.all([
    prisma.importRow.findMany({ where, orderBy: { rowNumber: 'asc' }, skip, take }),
    prisma.importRow.count({ where }),
  ]);
  return { items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take };
}

/** Annotated report: source rows + __status + __reason + __targetId columns. */
async function buildReportCsv({ businessId, jobId }) {
  const job = await mustJob(businessId, jobId);
  const rows = await prisma.importRow.findMany({ where: { importJobId: jobId }, orderBy: { rowNumber: 'asc' } });
  const canon = templates.canonicalFields(job.kind);
  const headers = canon.concat(['__status', '__reason', '__targetType', '__targetId']);
  const out = rows.map((r) => {
    const p = r.parsedJson || {};
    const { __normalized, ...sourceCells } = p; // drop the internal normalized block
    const reason = (r.findingsJson || []).map((f) => `${f.severity}:${f.code}:${f.message}`).join(' | ');
    return { ...sourceCells, __status: r.status, __reason: reason, __targetType: r.targetType || '', __targetId: r.targetId || '' };
  });
  return { fileName: `import-report-${job.kind}-${jobId.slice(0, 8)}.csv`, csv: csv.toCsv(headers, out) };
}

async function cancel({ businessId, actorId, jobId }) {
  const job = await mustJob(businessId, jobId);
  if (job.status === 'COMMITTED') throw badRequest('ALREADY_COMMITTED', 'a committed job cannot be cancelled');
  await prisma.importJob.update({ where: { id: jobId }, data: { status: 'CANCELLED' } });
  await writeAudit({ businessId, actorId, action: 'import.cancel', entityType: 'ImportJob', entityId: jobId, meta: { kind: job.kind } });
  return getJob({ businessId, jobId });
}

module.exports = {
  createJob, updateMapping, validate, dryRun, commit,
  getJob, listJobs, listRows, buildReportCsv, cancel,
  // exported for autogen + tests
  resolveEntity, ImportError, stripCommentLines, defaultMapping, applyMapping,
  MAX_BYTES, MAX_ROWS, DRY_RUN_ROLLBACK,
};
