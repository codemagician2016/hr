'use strict';

/**
 * autogen.service.js — Feature 18 AUTO-GENERATION driver (the heart of F18).
 *
 * The owner's rule: "when attendance entered + CTC set, payslips auto-prepare".
 * This module implements it as an explicit pass that runs AFTER commit (or on
 * demand) and REUSES the live engines — it never synthesises a payslip:
 *
 *   createRun({ type:'MIGRATED', importJobId })            // payroll/service.js
 *     → (SUMMARY attendance) write AttendancePayInput      // attendance/freeze shape
 *     → computeRun({ freezeAttendance })                    // freeze→engine→Payslip
 *
 * MIGRATED runs use a distinct code suffix (PR-YYYY-MM-IN-MIG) so a migration
 * never shadows a real run for the same month. computeRun is idempotent on the
 * inputHash, createRun on (businessId, code) — re-running the autogen is a no-op.
 *
 * RECONCILE mode: after computeRun, the engine net/PF/PT/TDS is compared to the
 * imported figures and IMPORT_MISMATCH_* WARNs are written — we NEVER overwrite
 * the engine number with the imported one (the import figure is a check).
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const money = require('../payroll/money');
const payrollService = require('../payroll/service');

function monthRange(periodMonth) {
  const y = Number(periodMonth.slice(0, 4));
  const m = Number(periodMonth.slice(5, 7));
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { start, end, startIso: start.toISOString().slice(0, 10), endIso: end.toISOString().slice(0, 10) };
}

/** Distinct MIGRATED run code so it never collides with a live PR-YYYY-MM-IN. */
function migratedRunCode(entity, periodMonth) {
  return `PR-${periodMonth}-${entity.countryCode}-MIG`;
}

/**
 * Find or create the MIGRATED PayRun for (entity, periodMonth). We can't reuse
 * payrollService.createRun verbatim because it derives the LIVE code (no -MIG
 * suffix) and ignores type/importJobId — so we create the DRAFT directly with the
 * exactly-once (businessId, code) guard, then hand it to the SAME computeRun the
 * live path uses (the engine is what we must not bypass; createRun is a thin
 * insert).
 */
async function ensureMigratedRun(tx, { businessId, entity, cal, periodMonth, importJobId, actorId }) {
  const { start, end } = monthRange(periodMonth);
  const code = migratedRunCode(entity, periodMonth);
  const existing = await tx.payRun.findFirst({ where: { businessId, code } });
  if (existing) return existing;
  const taxYear = taxYearFor(end, entity.taxYearStartMonth || 4);
  return tx.payRun.create({
    data: {
      businessId, entityId: entity.id, payCalendarId: cal.id, code,
      periodStart: start, periodEnd: end, payDate: end,
      sequenceInYear: end.getUTCMonth() + 1, taxYear, type: 'MIGRATED',
      currencyCode: entity.payCurrency, status: 'DRAFT', importJobId,
      notes: `Migrated run (import ${importJobId})${actorId ? ` by ${actorId}` : ''}`,
    },
  });
}

function taxYearFor(periodEnd, startMonth = 4) {
  const d = periodEnd instanceof Date ? periodEnd : new Date(`${periodEnd}T00:00:00Z`);
  const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1;
  const startY = m >= startMonth ? y : y - 1;
  return `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
}

/**
 * Pre-write a SUMMARY AttendancePayInput for an employee so computeRun's freeze
 * is authoritative on the staged figures (we set sourceJson so it's auditable).
 * Daily attendance rows are handled by freeze's normal rollup — nothing to do.
 */
async function stageSummaryAttendance(tx, { businessId, payRunId, employeeId, periodMonth, summary, importJobId }) {
  const { start, end } = monthRange(periodMonth);
  const calendarDays = Math.round((end - start) / 86400000) + 1;
  const payableDays = summary.payableDays != null ? summary.payableDays : calendarDays - (summary.lopDays || 0);
  await tx.attendancePayInput.upsert({
    where: { payRunId_employeeId: { payRunId, employeeId } },
    update: {
      periodStart: start, periodEnd: end, calendarDays, payableDays,
      lopDays: summary.lopDays || 0, paidLeaveDays: summary.paidLeaveDays || 0,
      overtimeHours: summary.otHours || 0, standardDays: calendarDays,
      importJobId, frozenAt: new Date(), sourceJson: { basis: 'import-summary', importJobId },
    },
    create: {
      businessId, payRunId, employeeId, periodStart: start, periodEnd: end,
      calendarDays, payableDays, lopDays: summary.lopDays || 0, paidLeaveDays: summary.paidLeaveDays || 0,
      overtimeHours: summary.otHours || 0, standardDays: calendarDays,
      importJobId, sourceJson: { basis: 'import-summary', importJobId },
    },
  });
}

/**
 * runPayrollAutogen — walk the committed PAYROLL_HISTORY rows, group by period,
 * generate a MIGRATED run per (entity, period) via computeRun.
 *
 * @returns { periods:[{ periodMonth, payRunId, code, headcount, totalNet,
 *            employees:[{ code, netPay, mismatches? }] }], findings:[] }
 */
async function runPayrollAutogen({ businessId, actorId, jobId, _dryRun = false }) {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, businessId } });
  if (!job || job.kind !== 'PAYROLL_HISTORY') return { periods: [], findings: [{ code: 'WRONG_KIND', message: 'autogen only runs for PAYROLL_HISTORY jobs' }] };

  // The generation set: COMMITTED rows for a real run; for a DRY-RUN the rows are
  // still PASS/WARN (commit hasn't flipped them), so we read those instead and the
  // caller unwinds the simulated runs afterwards.
  const statusFilter = _dryRun ? { in: ['PASS', 'WARN'] } : 'COMMITTED';
  const rows = await prisma.importRow.findMany({ where: { importJobId: jobId, status: statusFilter }, orderBy: { rowNumber: 'asc' } });
  // Staged SUMMARY attendance from a prior ATTENDANCE import (committed rows).
  const summaryByKey = await loadStagedSummaries(businessId);

  // Group requests by periodMonth.
  const byPeriod = new Map();
  for (const r of rows) {
    const n = (r.parsedJson && r.parsedJson.__normalized) || {};
    const key = n.periodMonth;
    if (!key) continue;
    if (!byPeriod.has(key)) byPeriod.set(key, []);
    byPeriod.get(key).push({ row: r, n });
  }

  const result = { periods: [], findings: [] };
  for (const [periodMonth, requests] of byPeriod) {
    try {
      const periodResult = await generatePayrollForPeriod({ businessId, actorId, job, periodMonth, requests, summaryByKey });
      result.periods.push(periodResult);
    } catch (e) {
      result.findings.push({ code: 'PERIOD_FAILED', periodMonth, message: e.message });
    }
  }
  await writeAudit({ businessId, actorId, action: 'import.autogen', entityType: 'ImportJob', entityId: jobId, meta: { periods: result.periods.map((p) => ({ periodMonth: p.periodMonth, payRunId: p.payRunId, headcount: p.headcount })) } });
  return result;
}

/** Load committed ATTENDANCE-SUMMARY rollups indexed by `${code}|${periodMonth}`. */
async function loadStagedSummaries(businessId) {
  const attJobs = await prisma.importJob.findMany({ where: { businessId, kind: 'ATTENDANCE', status: 'COMMITTED', deletedAt: null }, select: { id: true } });
  const map = new Map();
  if (!attJobs.length) return map;
  const rows = await prisma.importRow.findMany({ where: { importJobId: { in: attJobs.map((j) => j.id) }, status: { in: ['COMMITTED', 'SKIPPED'] } } });
  for (const r of rows) {
    const res = r.resultJson || {};
    if (res.targetType === 'AttendanceSummary' && res.staged) {
      map.set(String(res.targetId), res.staged);
    }
  }
  return map;
}

/**
 * generatePayrollForPeriod — the per-period orchestration. Reuses computeRun so
 * the payslip is engine-true (PF cap / PT slab / TDS as-of the period end).
 *
 * When `dryRunTx` is passed the whole thing runs inside the caller's rolled-back
 * transaction (the dry-run preview path); otherwise it opens its own tx.
 */
async function generatePayrollForPeriod({ businessId, actorId, job, periodMonth, requests, summaryByKey, dryRunTx = null }) {
  const { end } = monthRange(periodMonth);
  // Resolve the entity (pinned on the job, else the first request employee's entity).
  const firstEmp = await prisma.employee.findFirst({ where: { businessId, code: requests[0].n.employeeCode } });
  if (!firstEmp) throw new Error(`employee "${requests[0].n.employeeCode}" not found`);
  const empRec = await prisma.employmentRecord.findFirst({ where: { businessId, employeeId: firstEmp.id, isCurrent: true } });
  const entityId = job.entityId || (empRec && empRec.entityId);
  const entity = await prisma.entity.findFirst({ where: { businessId, id: entityId } });
  if (!entity) throw new Error('entity not resolvable for the period');
  const cal = await prisma.payCalendar.findFirst({ where: { businessId, entityId: entity.id } });
  if (!cal) throw new Error(`no pay calendar for entity ${entity.code}`);

  const findings = [];
  // Pre-condition check per requested employee (NO_CTC / NO_ATTENDANCE are findings,
  // not silent skips). The run still computes for the eligible set.
  for (const { n } of requests) {
    const emp = await prisma.employee.findFirst({ where: { businessId, code: n.employeeCode } });
    if (!emp) { findings.push({ code: 'NO_EMPLOYEE', employeeCode: n.employeeCode, periodMonth }); continue; }
    const comp = await prisma.compensationRevision.findFirst({ where: { businessId, employeeId: emp.id, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: end } }] } });
    if (!comp) findings.push({ code: 'NO_CTC', employeeCode: n.employeeCode, periodMonth, severity: 'ERROR', message: `no CTC effective on ${end.toISOString().slice(0, 10)} for ${n.employeeCode}` });
  }

  const runTx = async (tx) => {
    const run = await ensureMigratedRun(tx, { businessId, entity, cal, periodMonth, importJobId: job.id, actorId });
    if (['COMPUTED', 'APPROVED', 'PAID', 'FILED'].includes(run.status)) {
      // Idempotent: already generated. Return the existing detail.
      return { run, recomputed: false };
    }
    // Stage SUMMARY attendance (if present) BEFORE freeze so the staged figures are
    // authoritative; freeze upserts the same (payRunId, employeeId) row.
    for (const { n } of requests) {
      const emp = await tx.employee.findFirst({ where: { businessId, code: n.employeeCode } });
      if (!emp) continue;
      const summary = summaryByKey.get(`${n.employeeCode}|${periodMonth}`)
        || (n.payableDays != null ? { payableDays: n.payableDays, lopDays: n.lopDays || 0, otHours: 0 } : null);
      if (summary) await stageSummaryAttendance(tx, { businessId, payRunId: run.id, employeeId: emp.id, periodMonth, summary, importJobId: job.id });
    }
    return { run, recomputed: true };
  };

  let run;
  if (dryRunTx) { ({ run } = await runTx(dryRunTx)); }
  else { ({ run } = await prisma.$transaction(runTx, { timeout: 60000 })); }

  // computeRun does freeze + engine + persist atomically — the SAME live path.
  // For a DAILY-attendance migration, freeze rolls up the imported Attendance rows;
  // for SUMMARY, the pre-staged AttendancePayInput is what freeze upserts over (it
  // re-rolls from Attendance rows — which are empty for SUMMARY — so we keep the
  // staged figures by NOT freezing when summaries were staged).
  const hasStaged = await (dryRunTx || prisma).attendancePayInput.count({ where: { payRunId: run.id, importJobId: job.id } });
  const detail = await payrollService.computeRun({ businessId, actorId, payRunId: run.id, freezeAttendance: hasStaged === 0 });

  // RECONCILE: compare engine output to the prior provider's figures (WARN only).
  const employees = [];
  for (const { n } of requests) {
    const emp = await (dryRunTx || prisma).employee.findFirst({ where: { businessId, code: n.employeeCode } });
    if (!emp) continue;
    const line = (detail.lines || []).find((l) => l.employeeId === emp.id);
    const netPay = line ? Number(line.netPay) : null;
    const mismatches = [];
    if (n.mode === 'RECONCILE' && n.prior && line) {
      const tol = (job.optionsJson && job.optionsJson.tolerance) != null ? Number(job.optionsJson.tolerance) : 1;
      const cmp = [['net', n.prior.net, line.netPay], ['gross', n.prior.gross, line.grossEarnings], ['pf', n.prior.pf, line.pfEmployee], ['pt', n.prior.pt, line.pt], ['tds', n.prior.tds, line.tds]];
      for (const [field, priorMinor, engineDec] of cmp) {
        if (priorMinor == null || engineDec == null) continue;
        const engineMinor = money.toMinor(String(engineDec), 2);
        if (Math.abs(engineMinor - priorMinor) > tol) {
          mismatches.push({ code: `IMPORT_MISMATCH_${field.toUpperCase()}`, severity: 'WARN', field, message: `${field}: engine ₹${money.fromMinor(engineMinor)} vs imported ₹${money.fromMinor(priorMinor)} (Δ ₹${money.fromMinor(Math.abs(engineMinor - priorMinor))})` });
        }
      }
    }
    employees.push({ code: n.employeeCode, netPay, ...(mismatches.length ? { mismatches } : {}) });
    // Persist mismatch findings to the import row (so the report shows them).
    if (mismatches.length && !dryRunTx) {
      const existing = (await prisma.importRow.findUnique({ where: { id: requests.find((q) => q.n.employeeCode === n.employeeCode).row.id } }));
      const merged = (existing.findingsJson || []).concat(mismatches);
      await prisma.importRow.update({ where: { id: existing.id }, data: { findingsJson: merged } });
    }
  }

  return {
    periodMonth, payRunId: run.id, code: run.code,
    headcount: detail.headcount != null ? detail.headcount : (detail.lines || []).length,
    totalNet: detail.totals ? Number(detail.totals.totalNet) : null,
    employees, findings,
  };
}

module.exports = { runPayrollAutogen, generatePayrollForPeriod, ensureMigratedRun, migratedRunCode, monthRange };
