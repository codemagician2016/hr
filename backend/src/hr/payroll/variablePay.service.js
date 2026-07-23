'use strict';

/**
 * variablePay.service.js — Variable-Pay / Incentive orchestrator (Feature 46,
 * Phase 4). The DB-touching, thin layer over the PURE payroll/variablePay.js core.
 * Mirrors bonus.service.js: load rows → call the pure core → persist the
 * VariablePayCycle/VariablePayAward snapshot → pay each award by INJECTing a
 * PayRunInputItem(kind=OTE) onto the employee's entity's OPEN pay run.
 *
 * PAYOUT PATH — OTE-inject (NOT a minted OFF_CYCLE run):
 *   A variable-pay cycle can span MANY entities (its scope is a Json filter), so a
 *   single minted PayRun (bonus's per-entity model) does not fit. Instead each award
 *   rides the PayRunInputItem(kind=OTE) vehicle — the documented one-time-earning
 *   input — onto that employee's entity's current OPEN (DRAFT/INPUTS_LOCKED) run, so
 *   it flows through the EXISTING engine (TDS, PF/ESI, net-floor) with NO change to
 *   the fixed-pay path. When no open run exists the award is stamped `queued=true`;
 *   an operator injects it later (or opens a run and re-injects). Nothing is minted.
 *
 * APPROVAL — a canApprovePayroll maker-checker (NOT the F10 engine), matching bonus:
 *   the payroll domain already gates create/compute on canManageCompensation and
 *   approve on canApprovePayroll, with four-eyes SoD (approver ≠ computedBy) enforced
 *   here. A new WorkflowModule buys nothing over this in-service maker-checker.
 *
 * MONEY: integer MINOR units (paise) through variablePay.js; Decimal only at this edge.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { notifyHrEvent } = require('../integrations/notifications');
const core = require('./variablePay');
const { _internal: payrollService } = require('./service');
const resolveCurrentCompensation = payrollService.resolveCurrentCompensation;

// ── money edge helpers (integer minor ↔ Decimal string; never floats for money) ──
function minorToDecimal(minor) {
  const n = Math.round(Number(minor) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
function decimalToMinor(dec) {
  if (dec == null) return 0;
  return Math.round(Number(dec) * 100);
}
function toDateOnly(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function isoDay(d) {
  return toDateOnly(d).toISOString().slice(0, 10);
}
function dayCountInclusive(start, end) {
  const a = toDateOnly(start).getTime();
  const b = toDateOnly(end).getTime();
  if (b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

const KINDS = new Set(['INCENTIVE', 'COMMISSION', 'BONUS']);
const BASES = new Set(['GROSS', 'BASIC', 'CTC', 'FIXED_AMOUNT']);
const FREQS = new Set(['MONTHLY', 'QUARTERLY', 'ANNUAL']);
const PRORATIONS = new Set(['NONE', 'BY_ATTENDANCE', 'BY_TENURE']);

class VariablePayError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.reason = code;
  }
}

// ── basis resolution — the current comp → gross/basic/ctc for the period (paise) ──
function basicDaMinorFromComp(comp) {
  if (!comp || !Array.isArray(comp.lines)) return 0;
  let minor = 0;
  for (const line of comp.lines) {
    const kind = line.component && line.component.kind;
    if (kind === 'BASIC' || kind === 'DEARNESS_ALLOWANCE') {
      const amt = line.amountMonthly != null ? line.amountMonthly : line.calcValue;
      minor += Math.round(Number(amt || 0) * 100);
    }
  }
  return minor;
}
function resolveBasisMinor(basis, comp) {
  if (basis === 'FIXED_AMOUNT') return 0; // basis unused; targetAmount drives the payout
  if (!comp) return 0;
  if (basis === 'BASIC') return basicDaMinorFromComp(comp);
  if (basis === 'CTC') return comp.ctcAnnual != null ? decimalToMinor(comp.ctcAnnual) : 0;
  // GROSS (default): the current comp's monthly gross.
  return comp.grossMonthly != null ? decimalToMinor(comp.grossMonthly) : 0;
}

// ── eligibility scope → current employments (like the recognition budget scope) ──
async function resolveEligibleEmployments(businessId, scope, asOfDate) {
  const where = { businessId, isCurrent: true, effectiveFrom: { lte: asOfDate } };
  const s = scope && typeof scope === 'object' ? scope : {};
  const arr = (v) => (Array.isArray(v) && v.length ? v : null);
  if (arr(s.entityIds)) where.entityId = { in: s.entityIds };
  if (arr(s.departmentIds)) where.departmentId = { in: s.departmentIds };
  if (arr(s.gradeIds)) where.gradeId = { in: s.gradeIds };
  const rows = await prisma.employmentRecord.findMany({
    where,
    select: { employeeId: true, entityId: true, effectiveFrom: true, effectiveTo: true },
    orderBy: { effectiveFrom: 'desc' },
  });
  // Dedupe to one (the latest) current segment per employee.
  const byEmp = new Map();
  for (const r of rows) if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, r);
  return [...byEmp.values()];
}

// ── scheme CRUD ──────────────────────────────────────────────────────────────
function validateSchemeShape({ basis, targetPct, targetAmount, kind, payoutFrequency, prorationMethod }) {
  if (kind && !KINDS.has(kind)) throw new VariablePayError('BAD_KIND', `kind must be one of ${[...KINDS].join('/')}`, 422);
  if (basis && !BASES.has(basis)) throw new VariablePayError('BAD_BASIS', `basis must be one of ${[...BASES].join('/')}`, 422);
  if (payoutFrequency && !FREQS.has(payoutFrequency)) throw new VariablePayError('BAD_FREQUENCY', `payoutFrequency must be one of ${[...FREQS].join('/')}`, 422);
  if (prorationMethod && !PRORATIONS.has(prorationMethod)) throw new VariablePayError('BAD_PRORATION', `prorationMethod must be one of ${[...PRORATIONS].join('/')}`, 422);
  const b = basis || 'GROSS';
  if (b === 'FIXED_AMOUNT') {
    if (targetAmount == null || Number(targetAmount) <= 0) throw new VariablePayError('MISSING_TARGET_AMOUNT', 'basis=FIXED_AMOUNT requires a positive targetAmount', 422);
  } else if (targetPct == null || Number(targetPct) <= 0) {
    throw new VariablePayError('MISSING_TARGET_PCT', `basis=${b} requires a positive targetPct`, 422);
  }
}

async function createScheme({ businessId, actorId, name, code, kind, basis, targetPct, targetAmount, payoutFrequency, prorationMethod, eligibilityScope }) {
  if (!name || !String(name).trim()) throw new VariablePayError('MISSING_NAME', 'name is required', 422);
  validateSchemeShape({ basis, targetPct, targetAmount, kind, payoutFrequency, prorationMethod });
  const b = basis || 'GROSS';
  try {
    const scheme = await prisma.variablePayScheme.create({
      data: {
        businessId,
        name: String(name).trim(),
        code: code ? String(code).trim() : null,
        kind: kind || 'INCENTIVE',
        basis: b,
        targetPct: b === 'FIXED_AMOUNT' ? null : String(Number(targetPct)),
        targetAmount: b === 'FIXED_AMOUNT' ? String(Number(targetAmount)) : null,
        payoutFrequency: payoutFrequency || 'QUARTERLY',
        prorationMethod: prorationMethod || 'NONE',
        eligibilityScope: eligibilityScope || null,
        isActive: true,
      },
    });
    await writeAudit({ businessId, actorId, action: 'variablePay.scheme.create', entityType: 'VariablePayScheme', entityId: scheme.id, meta: { name: scheme.name, kind: scheme.kind, basis: scheme.basis } });
    return serializeScheme(scheme);
  } catch (e) {
    if (e && e.code === 'P2002') throw new VariablePayError('CODE_EXISTS', `A scheme with code "${code}" already exists`, 409);
    throw e;
  }
}

async function updateScheme({ businessId, actorId, schemeId, ...patch }) {
  const scheme = await loadScheme(businessId, schemeId);
  const merged = {
    basis: patch.basis !== undefined ? patch.basis : scheme.basis,
    targetPct: patch.targetPct !== undefined ? patch.targetPct : scheme.targetPct,
    targetAmount: patch.targetAmount !== undefined ? patch.targetAmount : scheme.targetAmount,
    kind: patch.kind !== undefined ? patch.kind : scheme.kind,
    payoutFrequency: patch.payoutFrequency !== undefined ? patch.payoutFrequency : scheme.payoutFrequency,
    prorationMethod: patch.prorationMethod !== undefined ? patch.prorationMethod : scheme.prorationMethod,
  };
  validateSchemeShape(merged);
  const data = {};
  if (patch.name !== undefined) data.name = String(patch.name).trim();
  if (patch.code !== undefined) data.code = patch.code ? String(patch.code).trim() : null;
  if (patch.kind !== undefined) data.kind = patch.kind;
  if (patch.basis !== undefined) data.basis = patch.basis;
  if (patch.payoutFrequency !== undefined) data.payoutFrequency = patch.payoutFrequency;
  if (patch.prorationMethod !== undefined) data.prorationMethod = patch.prorationMethod;
  if (patch.eligibilityScope !== undefined) data.eligibilityScope = patch.eligibilityScope || null;
  if (patch.isActive !== undefined) data.isActive = !!patch.isActive;
  // Normalise the target pair to the (possibly new) basis.
  if (patch.basis !== undefined || patch.targetPct !== undefined || patch.targetAmount !== undefined) {
    if (merged.basis === 'FIXED_AMOUNT') {
      data.targetAmount = String(Number(merged.targetAmount));
      data.targetPct = null;
    } else {
      data.targetPct = String(Number(merged.targetPct));
      data.targetAmount = null;
    }
  }
  try {
    const updated = await prisma.variablePayScheme.update({ where: { id: schemeId }, data });
    await writeAudit({ businessId, actorId, action: 'variablePay.scheme.update', entityType: 'VariablePayScheme', entityId: schemeId, meta: Object.keys(data) });
    return serializeScheme(updated);
  } catch (e) {
    if (e && e.code === 'P2002') throw new VariablePayError('CODE_EXISTS', 'A scheme with that code already exists', 409);
    throw e;
  }
}

async function deleteScheme({ businessId, actorId, schemeId }) {
  await loadScheme(businessId, schemeId);
  await prisma.variablePayScheme.update({ where: { id: schemeId }, data: { deletedAt: new Date(), isActive: false } });
  await writeAudit({ businessId, actorId, action: 'variablePay.scheme.delete', entityType: 'VariablePayScheme', entityId: schemeId, meta: {} });
  return { id: schemeId, deleted: true };
}

async function loadScheme(businessId, schemeId) {
  const scheme = await prisma.variablePayScheme.findFirst({ where: { id: schemeId, businessId, deletedAt: null } });
  if (!scheme) throw new VariablePayError('SCHEME_NOT_FOUND', 'Variable-pay scheme not found', 404);
  return scheme;
}
function serializeScheme(s) {
  return {
    ...s,
    targetPct: s.targetPct != null ? Number(s.targetPct) : null,
    targetAmount: s.targetAmount != null ? Number(s.targetAmount) : null,
  };
}
async function listSchemes({ businessId, isActive }) {
  const where = { businessId, deletedAt: null };
  if (isActive != null) where.isActive = String(isActive) === 'true';
  const items = await prisma.variablePayScheme.findMany({ where, orderBy: { createdAt: 'desc' } });
  return { items: items.map(serializeScheme), total: items.length };
}
async function getScheme({ businessId, schemeId }) {
  return serializeScheme(await loadScheme(businessId, schemeId));
}

// ── cycle create — resolve eligible employees + seed DRAFT awards ─────────────
async function createCycle({ businessId, actorId, schemeId, periodLabel, periodStart, periodEnd }) {
  const scheme = await loadScheme(businessId, schemeId);
  if (!periodLabel || !periodStart || !periodEnd) throw new VariablePayError('MISSING_FIELDS', 'periodLabel, periodStart and periodEnd are required', 422);
  const start = toDateOnly(periodStart);
  const end = toDateOnly(periodEnd);
  if (!start || !end) throw new VariablePayError('BAD_PERIOD', 'periodStart/periodEnd must be valid dates', 422);
  if (end < start) throw new VariablePayError('BAD_PERIOD', 'periodEnd must be on/after periodStart', 422);
  const periodDays = dayCountInclusive(start, end);

  const employments = await resolveEligibleEmployments(businessId, scheme.eligibilityScope, end);
  if (!employments.length) throw new VariablePayError('NO_ELIGIBLE_EMPLOYEES', 'No employees match the scheme eligibility scope for this period', 422);

  // Build the seed award rows (pure resolution; no writes yet).
  const asOf = isoDay(end);
  const seedRows = [];
  for (const emp of employments) {
    const comp = await resolveCurrentCompensation(businessId, emp.employeeId, asOf);
    const basisMinor = resolveBasisMinor(scheme.basis, comp);
    const activeDays = dayCountInclusive(
      emp.effectiveFrom > start ? emp.effectiveFrom : start,
      emp.effectiveTo && emp.effectiveTo < end ? emp.effectiveTo : end,
    );
    const prorationFactor = core.resolveProration({ method: scheme.prorationMethod, activeDays, periodDays });
    const { targetMinor } = core.computeAward({
      basisMinor,
      targetPct: scheme.targetPct != null ? Number(scheme.targetPct) : null,
      targetAmountMinor: scheme.targetAmount != null ? decimalToMinor(scheme.targetAmount) : 0,
      basis: scheme.basis,
      achievementPct: 100,
      prorationFactor,
    });
    seedRows.push({
      employeeId: emp.employeeId,
      basisAmount: minorToDecimal(basisMinor),
      targetAmount: minorToDecimal(targetMinor),
      prorationFactor: String(prorationFactor),
    });
  }

  let cycle;
  try {
    cycle = await prisma.$transaction(async (tx) => {
      const c = await tx.variablePayCycle.create({
        data: {
          businessId, schemeId, periodLabel: String(periodLabel),
          periodStart: start, periodEnd: end, status: 'DRAFT',
        },
      });
      await tx.variablePayAward.createMany({
        data: seedRows.map((r) => ({
          businessId, cycleId: c.id, employeeId: r.employeeId,
          basisAmount: r.basisAmount, targetAmount: r.targetAmount,
          achievementPct: '100', prorationFactor: r.prorationFactor,
          computedAmount: '0', status: 'DRAFT',
        })),
      });
      return c;
    });
  } catch (e) {
    if (e && e.code === 'P2002') throw new VariablePayError('CYCLE_EXISTS', `A cycle "${periodLabel}" already exists for this scheme`, 409);
    throw e;
  }
  await writeAudit({ businessId, actorId, action: 'variablePay.cycle.create', entityType: 'VariablePayCycle', entityId: cycle.id, meta: { schemeId, periodLabel, headcount: seedRows.length } });
  return getCycle({ businessId, cycleId: cycle.id });
}

// ── patch an award's achievement% (DRAFT/COMPUTED only; re-opens a COMPUTED cycle) ──
async function patchAward({ businessId, actorId, cycleId, awardId, achievementPct, note }) {
  const cycle = await loadCycle(businessId, cycleId);
  if (cycle.status !== 'DRAFT' && cycle.status !== 'COMPUTED') {
    throw new VariablePayError('IMMUTABLE_CYCLE', `Cannot edit awards on a ${cycle.status} cycle`, 409);
  }
  const award = await prisma.variablePayAward.findFirst({ where: { id: awardId, cycleId, businessId } });
  if (!award) throw new VariablePayError('AWARD_NOT_FOUND', 'Award not found', 404);
  const data = {};
  if (achievementPct !== undefined) {
    const pct = Number(achievementPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 1000) throw new VariablePayError('BAD_ACHIEVEMENT', 'achievementPct must be 0..1000', 422);
    data.achievementPct = String(pct);
    // Any figure edit re-opens a COMPUTED cycle: the number must be recomputed
    // before approve, preserving maker-checker integrity.
    data.computedAmount = '0';
    data.status = 'DRAFT';
  }
  if (note !== undefined) data.note = note || null;
  data.version = { increment: 1 };
  await prisma.$transaction(async (tx) => {
    await tx.variablePayAward.update({ where: { id: awardId }, data });
    if (cycle.status === 'COMPUTED' && achievementPct !== undefined) {
      await tx.variablePayCycle.update({ where: { id: cycleId }, data: { status: 'DRAFT', computedAt: null, computedBy: null, version: { increment: 1 } } });
    }
  });
  await writeAudit({ businessId, actorId, action: 'variablePay.award.patch', entityType: 'VariablePayAward', entityId: awardId, meta: { achievementPct: data.achievementPct } });
  return getCycle({ businessId, cycleId });
}

// ── compute — DRAFT/COMPUTED → COMPUTED; freeze computedAmount per award + totals ──
async function computeCycle({ businessId, actorId, cycleId }) {
  const cycle = await loadCycle(businessId, cycleId);
  if (cycle.status !== 'DRAFT' && cycle.status !== 'COMPUTED') {
    throw new VariablePayError('IMMUTABLE_CYCLE', `Compute requires a DRAFT/COMPUTED cycle (current: ${cycle.status})`, 409);
  }
  const scheme = await loadScheme(businessId, cycle.schemeId);
  const awards = await prisma.variablePayAward.findMany({ where: { businessId, cycleId } });
  if (!awards.length) throw new VariablePayError('NO_AWARDS', 'Cycle has no awards to compute', 422);

  const results = [];
  for (const a of awards) {
    const r = core.computeAward({
      basisMinor: decimalToMinor(a.basisAmount),
      targetPct: scheme.targetPct != null ? Number(scheme.targetPct) : null,
      targetAmountMinor: scheme.targetAmount != null ? decimalToMinor(scheme.targetAmount) : 0,
      basis: scheme.basis,
      achievementPct: Number(a.achievementPct),
      prorationFactor: Number(a.prorationFactor),
    });
    results.push({ id: a.id, targetMinor: r.targetMinor, computedMinor: r.computedMinor });
  }
  const totals = core.computeCycleTotals(results);

  await prisma.$transaction(async (tx) => {
    for (const r of results) {
      await tx.variablePayAward.update({
        where: { id: r.id },
        data: { targetAmount: minorToDecimal(r.targetMinor), computedAmount: minorToDecimal(r.computedMinor), status: 'COMPUTED', version: { increment: 1 } },
      });
    }
    await tx.variablePayCycle.update({
      where: { id: cycleId },
      data: {
        status: 'COMPUTED', computedAt: new Date(), computedBy: actorId,
        totalsJson: { headcount: totals.headcount, totalTargetMinor: totals.totalTargetMinor, totalComputedMinor: totals.totalComputedMinor },
        version: { increment: 1 },
      },
    });
  });
  await writeAudit({ businessId, actorId, action: 'variablePay.cycle.compute', entityType: 'VariablePayCycle', entityId: cycleId, meta: totals });
  try {
    await notifyHrEvent({ businessId, event: 'variablePay.computed', triggeredBy: actorId, variables: { LABEL: cycle.periodLabel, COUNT: String(totals.headcount), AMT: minorToDecimal(totals.totalComputedMinor) } });
  } catch (_) { /* notification failure must not fail the compute */ }
  return getCycle({ businessId, cycleId });
}

// ── approve — SoD maker-checker; OTE-inject each award onto the entity's open run ──
async function approveCycle({ businessId, actorId, cycleId }) {
  const cycle = await loadCycle(businessId, cycleId);
  if (cycle.status !== 'COMPUTED') throw new VariablePayError('BAD_STATE', `Approve requires a COMPUTED cycle (current: ${cycle.status})`, 409);
  // Four-eyes SoD: the approver must differ from the maker (computedBy). Fail-closed.
  if (!cycle.computedBy) throw new VariablePayError('SOD_MAKER_UNKNOWN', 'Cycle maker is unknown; cannot approve (fail-closed)', 403);
  if (cycle.computedBy === actorId) throw new VariablePayError('MAKER_CHECKER', 'Maker-checker: the approver must differ from the employee who computed the cycle', 403);

  const awards = await prisma.variablePayAward.findMany({ where: { businessId, cycleId } });
  const payable = awards.filter((a) => decimalToMinor(a.computedAmount) > 0);
  if (!payable.length) throw new VariablePayError('NO_PAYABLE', 'No awards with a positive computed amount to disburse', 422);

  // Resolve each payable employee's CURRENT entity, then one OPEN run per entity.
  const empIds = payable.map((a) => a.employeeId);
  const emps = await prisma.employmentRecord.findMany({
    where: { businessId, employeeId: { in: empIds }, isCurrent: true },
    select: { employeeId: true, entityId: true },
    orderBy: { effectiveFrom: 'desc' },
  });
  const entityByEmp = new Map();
  for (const e of emps) if (!entityByEmp.has(e.employeeId)) entityByEmp.set(e.employeeId, e.entityId);

  const runByEntity = new Map();
  for (const entityId of new Set([...entityByEmp.values()])) {
    const run = await prisma.payRun.findFirst({
      where: { businessId, entityId, deletedAt: null, status: { in: ['DRAFT', 'INPUTS_LOCKED'] }, type: { in: ['REGULAR', 'OFF_CYCLE'] } },
      orderBy: { periodStart: 'desc' },
      select: { id: true },
    });
    runByEntity.set(entityId, run ? run.id : null);
  }

  let injected = 0;
  let queued = 0;
  const runIds = new Set();
  const out = await prisma.$transaction(async (tx) => {
    // Atomic single-approve claim (COMPUTED → APPROVED). Serialises concurrent approves.
    const claim = await tx.variablePayCycle.updateMany({
      where: { id: cycleId, businessId, status: 'COMPUTED' },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedByUserId: actorId, version: { increment: 1 } },
    });
    if (claim.count !== 1) throw new VariablePayError('ALREADY_APPROVED', 'Cycle already approved (lost the concurrent approve race)', 409);

    for (const a of payable) {
      const amountMinor = decimalToMinor(a.computedAmount);
      const entityId = entityByEmp.get(a.employeeId);
      const runId = entityId ? runByEntity.get(entityId) : null;
      if (runId) {
        const item = await tx.payRunInputItem.create({
          data: {
            businessId, payRunId: runId, employeeId: a.employeeId,
            kind: 'OTE', componentCode: 'VARIABLE_PAY', amountMinor: BigInt(amountMinor),
            taxable: true, note: `Variable pay ${cycle.periodLabel} (scheme ${cycle.schemeId})`, createdBy: actorId,
          },
        });
        await tx.variablePayAward.update({ where: { id: a.id }, data: { status: 'APPROVED', queued: false, payRunInputItemId: item.id, version: { increment: 1 } } });
        injected += 1;
        runIds.add(runId);
      } else {
        await tx.variablePayAward.update({ where: { id: a.id }, data: { status: 'APPROVED', queued: true, version: { increment: 1 } } });
        queued += 1;
      }
    }
    // Non-payable awards ride the cycle transition too (kept as-is, no payout).
    const distinctRuns = [...runIds];
    const totals = cycle.totalsJson || {};
    await tx.variablePayCycle.update({
      where: { id: cycleId },
      data: {
        payRunId: distinctRuns.length === 1 ? distinctRuns[0] : null,
        totalsJson: { ...totals, injected, queued, payRunIds: distinctRuns },
      },
    });
    return { injected, queued, payRunIds: distinctRuns };
  });

  await writeAudit({ businessId, actorId, action: 'variablePay.cycle.approve', entityType: 'VariablePayCycle', entityId: cycleId, meta: out });
  try {
    await notifyHrEvent({ businessId, event: 'variablePay.approved', triggeredBy: actorId, variables: { LABEL: cycle.periodLabel, INJECTED: String(out.injected), QUEUED: String(out.queued) } });
  } catch (_) { /* best-effort */ }
  return getCycle({ businessId, cycleId });
}

// ── cancel — DRAFT/COMPUTED only (APPROVED awards already rode a run; not unwound) ──
async function cancelCycle({ businessId, actorId, cycleId }) {
  const cycle = await loadCycle(businessId, cycleId);
  if (cycle.status !== 'DRAFT' && cycle.status !== 'COMPUTED') {
    throw new VariablePayError('BAD_STATE', `Only a DRAFT/COMPUTED cycle can be cancelled (current: ${cycle.status})`, 409);
  }
  await prisma.$transaction(async (tx) => {
    await tx.variablePayAward.updateMany({ where: { businessId, cycleId }, data: { status: 'CANCELLED' } });
    await tx.variablePayCycle.update({ where: { id: cycleId }, data: { status: 'CANCELLED', version: { increment: 1 } } });
  });
  await writeAudit({ businessId, actorId, action: 'variablePay.cycle.cancel', entityType: 'VariablePayCycle', entityId: cycleId, meta: {} });
  return getCycle({ businessId, cycleId });
}

// ── reads ─────────────────────────────────────────────────────────────────────
async function loadCycle(businessId, cycleId) {
  const cycle = await prisma.variablePayCycle.findFirst({ where: { id: cycleId, businessId } });
  if (!cycle) throw new VariablePayError('CYCLE_NOT_FOUND', 'Variable-pay cycle not found', 404);
  return cycle;
}
function serializeAward(a) {
  return {
    ...a,
    basisAmount: Number(a.basisAmount),
    targetAmount: Number(a.targetAmount),
    achievementPct: Number(a.achievementPct),
    prorationFactor: Number(a.prorationFactor),
    computedAmount: Number(a.computedAmount),
  };
}
async function getCycle({ businessId, cycleId }) {
  const cycle = await loadCycle(businessId, cycleId);
  const [scheme, awards] = await Promise.all([
    prisma.variablePayScheme.findFirst({ where: { id: cycle.schemeId, businessId } }),
    prisma.variablePayAward.findMany({
      where: { businessId, cycleId },
      include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const ser = awards.map(serializeAward);
  return {
    cycle,
    scheme: scheme ? serializeScheme(scheme) : null,
    awards: ser,
    totals: cycle.totalsJson || core.computeCycleTotals([]),
  };
}
async function listCycles({ businessId, schemeId, status, page = 1, pageSize = 25 }) {
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
  const where = { businessId };
  if (schemeId) where.schemeId = schemeId;
  if (status) where.status = status;
  const [items, total] = await Promise.all([
    prisma.variablePayCycle.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { scheme: { select: { id: true, name: true, code: true, kind: true } } } }),
    prisma.variablePayCycle.count({ where }),
  ]);
  return { items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take };
}

async function listAwards({ businessId, cycleId }) {
  await loadCycle(businessId, cycleId);
  const awards = await prisma.variablePayAward.findMany({
    where: { businessId, cycleId },
    include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return { items: awards.map(serializeAward), total: awards.length };
}

module.exports = {
  VariablePayError,
  createScheme,
  updateScheme,
  deleteScheme,
  listSchemes,
  getScheme,
  createCycle,
  patchAward,
  computeCycle,
  approveCycle,
  cancelCycle,
  getCycle,
  listCycles,
  listAwards,
  // exposed for tests
  _internals: { minorToDecimal, decimalToMinor, resolveBasisMinor, basicDaMinorFromComp, dayCountInclusive },
};
