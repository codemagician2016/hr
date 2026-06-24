'use strict';

/**
 * fbpService.js — Feature 25. The DB-touching service layer for FBP plans +
 * allocations. Pure math lives in fbpAggregator / materializeFbpLines / fbpPlan;
 * the tax subtraction lives in tax/fbp/fbpProjection. This module is the
 * persistence + resolution glue the controllers call. Tenant-scoped (every query
 * carries businessId). India-only (the controllers country-gate).
 */

const prisma = require('../../core/lib/prisma');
const money = require('../payroll/money');
const payrollService = require('../payroll/service');
const { validatePlan } = require('./fbpPlan');
const { computeFbpSplit } = require('../tax/fbp/fbpAggregator');

// Decimal|string|number → integer paise.
function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
function toRupees(minor) { return Math.round(minor) / 100; }

// Map an FbpPlanHead row → the pure aggregator `head` shape (caps → paise).
function headToPure(h) {
  return {
    id: h.id,
    headType: h.headType,
    label: h.label,
    taxSection: h.taxSection || null,
    claimType: h.claimType || null,
    componentId: h.componentId,
    annualCapMinor: h.annualCapRupees != null ? rupeesToMinor(h.annualCapRupees) : null,
    monthlyCapMinor: h.monthlyCapRupees != null ? rupeesToMinor(h.monthlyCapRupees) : null,
    minAllocMinor: h.minAllocRupees != null ? rupeesToMinor(h.minAllocRupees) : null,
    proofRequired: h.proofRequired !== false,
    exemptOldRegimeOnly: h.exemptOldRegimeOnly !== false,
    payCadence: h.payCadence || 'MONTHLY',
  };
}

// ── Plans ────────────────────────────────────────────────────────────────────

async function listPlans({ businessId, financialYear, db = prisma }) {
  const where = { businessId, deletedAt: null };
  if (financialYear) where.financialYear = financialYear;
  return db.fbpPlan.findMany({
    where,
    include: { heads: { orderBy: { sortOrder: 'asc' }, include: { component: { select: { id: true, code: true, name: true } } } }, envelopeComponent: { select: { id: true, code: true, name: true } } },
    orderBy: [{ financialYear: 'desc' }, { createdAt: 'desc' }],
  });
}

async function getPlan({ businessId, id, db = prisma }) {
  return db.fbpPlan.findFirst({
    where: { id, businessId, deletedAt: null },
    include: { heads: { orderBy: { sortOrder: 'asc' }, include: { component: { select: { id: true, code: true, name: true } } } }, envelopeComponent: { select: { id: true, code: true, name: true } } },
  });
}

/**
 * Create or replace a plan's heads atomically. countryCode is server-stamped to the
 * tenant country (single-country invariant). Validates structurally + verifies every
 * referenced component belongs to the tenant.
 */
async function savePlan({ businessId, createdById, input, existingId = null, db = prisma }) {
  const v = validatePlan(input);
  if (!v.ok) { const e = new Error(v.message); e.code = v.code; e.status = 422; throw e; }

  // Verify the envelope + all head components belong to the tenant.
  const componentIds = [input.envelopeComponentId, ...input.heads.map((h) => h.componentId)];
  const comps = await db.salaryComponent.findMany({
    where: { id: { in: componentIds }, businessId, deletedAt: null },
    select: { id: true },
  });
  const known = new Set(comps.map((c) => c.id));
  for (const cid of componentIds) {
    if (!known.has(cid)) { const e = new Error('A referenced pay component was not found in this tenant.'); e.code = 'FBP_UNKNOWN_COMPONENT'; e.status = 422; throw e; }
  }

  const headCreates = input.heads.map((h, i) => ({
    businessId,
    componentId: h.componentId,
    headType: h.headType,
    label: h.label || h.headType,
    taxSection: h.taxSection || null,
    annualCapRupees: h.annualCapRupees != null ? String(h.annualCapRupees) : null,
    monthlyCapRupees: h.monthlyCapRupees != null ? String(h.monthlyCapRupees) : null,
    minAllocRupees: h.minAllocRupees != null ? String(h.minAllocRupees) : null,
    exemptOldRegimeOnly: h.exemptOldRegimeOnly !== false,
    proofRequired: h.proofRequired !== false,
    payCadence: h.payCadence || 'MONTHLY',
    claimType: h.claimType || null,
    sortOrder: h.sortOrder != null ? h.sortOrder : i,
  }));

  return db.$transaction(async (tx) => {
    if (existingId) {
      const plan = await tx.fbpPlan.findFirst({ where: { id: existingId, businessId, deletedAt: null } });
      if (!plan) { const e = new Error('Plan not found'); e.code = 'NOT_FOUND'; e.status = 404; throw e; }
      // Replace heads atomically.
      await tx.fbpPlanHead.deleteMany({ where: { planId: existingId, businessId } });
      await tx.fbpPlan.update({
        where: { id: existingId },
        data: {
          name: input.name || plan.name,
          envelopeComponentId: input.envelopeComponentId,
          financialYear: input.financialYear || plan.financialYear,
          isActive: input.isActive !== false,
          version: { increment: 1 },
          heads: { create: headCreates },
        },
      });
      return getPlan({ businessId, id: existingId, db: tx });
    }
    const created = await tx.fbpPlan.create({
      data: {
        businessId,
        entityId: input.entityId || null,
        code: input.code,
        name: input.name || input.code,
        countryCode: 'IN', // server-stamped = tenant country
        financialYear: input.financialYear,
        envelopeComponentId: input.envelopeComponentId,
        isActive: input.isActive !== false,
        createdById: createdById || null,
        heads: { create: headCreates },
      },
    });
    return getPlan({ businessId, id: created.id, db: tx });
  });
}

async function softDeletePlan({ businessId, id, db = prisma }) {
  const active = await db.fbpAllocation.count({
    where: { businessId, planId: id, deletedAt: null, status: { in: ['SUBMITTED', 'LOCKED'] } },
  });
  if (active > 0) { const e = new Error('Plan has active allocations and cannot be deleted.'); e.code = 'FBP_PLAN_IN_USE'; e.status = 409; throw e; }
  return db.fbpPlan.updateMany({ where: { id, businessId, deletedAt: null }, data: { deletedAt: new Date() } });
}

// ── Envelope resolution ───────────────────────────────────────────────────────

/**
 * Resolve the FBP envelope ANNUAL amount (paise) for an employee from their current
 * compensation revision's envelope-component line. Returns 0 if no comp or no
 * envelope line (the employee then can't allocate). Reuses resolveCurrentCompensation
 * (the authoritative current package), no new derivation.
 */
async function resolveEnvelopeAnnualMinor({ businessId, employeeId, plan, asOf, db = prisma }) {
  const asOfIso = asOf || new Date().toISOString().slice(0, 10);
  const comp = await payrollService._internal.resolveCurrentCompensation(businessId, employeeId, asOfIso, db);
  if (!comp || !comp.lines) return 0;
  const line = comp.lines.find((l) => (l.componentId === plan.envelopeComponentId) || (l.component && l.component.id === plan.envelopeComponentId));
  if (!line) return 0;
  const annualMinor = line.amountAnnual != null ? rupeesToMinor(line.amountAnnual) : rupeesToMinor(line.amountMonthly) * 12;
  return Math.max(0, annualMinor);
}

/** The active plan for an employee's entity + FY (one active plan per entity per FY). */
async function resolveActivePlan({ businessId, employeeId, financialYear, db = prisma }) {
  // Entity is carried on the current EmploymentRecord (not the Employee row).
  const record = await db.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
    select: { entityId: true },
  });
  const entityId = record ? record.entityId : null;
  // Prefer an entity-specific plan; fall back to an all-entities (entityId NULL) plan.
  const plans = await db.fbpPlan.findMany({
    where: { businessId, financialYear, isActive: true, deletedAt: null, OR: [{ entityId }, { entityId: null }] },
    include: { heads: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  });
  if (plans.length === 0) return null;
  return plans.find((p) => p.entityId === entityId) || plans[0];
}

// ── Allocation ────────────────────────────────────────────────────────────────

/** The current (latest, non-superseded) allocation for an employee+FY (any status). */
async function currentAllocation({ businessId, employeeId, financialYear, db = prisma }) {
  return db.fbpAllocation.findFirst({
    where: { businessId, employeeId, financialYear, deletedAt: null },
    orderBy: { version: 'desc' },
    include: { lines: true, plan: { include: { heads: { orderBy: { sortOrder: 'asc' } } } } },
  });
}

/**
 * Save/submit an allocation. Validates: plan exists, Σ ≤ envelope, each line ≤ head
 * cap, head belongs to the plan. Writes a NEW version (supersedes prior DRAFT/SUBMITTED).
 *
 * @param {object} args.lines  [{ headId, annual }] (annual rupees)
 * @param {string} args.status DRAFT | SUBMITTED
 */
async function saveAllocation({ businessId, employeeId, financialYear, lines, status = 'SUBMITTED', windowId = null, createdById = null, asOf, db = prisma }) {
  const plan = await resolveActivePlan({ businessId, employeeId, financialYear, db });
  if (!plan) { const e = new Error('No active FBP plan for this year.'); e.code = 'FBP_NO_PLAN'; e.status = 409; throw e; }

  const envelopeAnnualMinor = await resolveEnvelopeAnnualMinor({ businessId, employeeId, plan, asOf, db });
  if (envelopeAnnualMinor <= 0) { const e = new Error('No FBP envelope is funded in your current compensation.'); e.code = 'FBP_NO_ENVELOPE'; e.status = 409; throw e; }

  const headById = new Map(plan.heads.map((h) => [h.id, headToPure(h)]));
  const pureAllocation = [];
  for (const l of lines || []) {
    if (!l || !l.headId) continue;
    const head = headById.get(l.headId);
    if (!head) { const e = new Error(`Head ${l.headId} is not in the active plan.`); e.code = 'FBP_BAD_HEAD'; e.status = 422; throw e; }
    pureAllocation.push({ headId: l.headId, annualAmountMinor: rupeesToMinor(l.annual) });
  }

  // Validate via the pure split: over-allocation + per-head cap.
  const split = computeFbpSplit({ envelopeMinor: envelopeAnnualMinor, heads: plan.heads.map(headToPure), allocation: pureAllocation });
  if (split.overAllocated) {
    const e = new Error(`Allocation (₹${toRupees(split.allocatedTotalMinor)}) exceeds your FBP allowance (₹${toRupees(envelopeAnnualMinor)}).`);
    e.code = 'FBP_OVER_ALLOCATED'; e.status = 422; throw e;
  }
  for (const sl of split.lines) {
    if (sl.overCapMinor > 0 && sl.capMinor != null && sl.allocatedMinor > sl.capMinor) {
      // Over-cap is ALLOWED (it pays but isn't exempt) — not an error, just surfaced.
      // We do NOT block; the excess is taxable (edge case 3).
    }
  }

  return db.$transaction(async (tx) => {
    // Supersede any prior non-superseded versions, find the next version number.
    const prior = await tx.fbpAllocation.findFirst({
      where: { businessId, employeeId, financialYear, deletedAt: null },
      orderBy: { version: 'desc' },
    });
    if (prior && prior.status !== 'SUPERSEDED') {
      await tx.fbpAllocation.update({ where: { id: prior.id }, data: { status: 'SUPERSEDED' } });
    }
    const nextVersion = prior ? prior.version + 1 : 0;
    const created = await tx.fbpAllocation.create({
      data: {
        businessId, employeeId, planId: plan.id, windowId,
        financialYear,
        envelopeAnnualRupees: String(toRupees(envelopeAnnualMinor)),
        status,
        submittedAt: status === 'SUBMITTED' ? new Date() : null,
        createdById,
        version: nextVersion,
        lines: { create: pureAllocation.map((a) => ({ businessId, headId: a.headId, annualAmountRupees: String(toRupees(a.annualAmountMinor)) })) },
      },
      include: { lines: true, plan: { include: { heads: { orderBy: { sortOrder: 'asc' } } } } },
    });
    return created;
  });
}

// ── Run overlay (Seam A wired into the monthly run) ──────────────────────────

const { materializeFbpLines } = require('./materializeFbpLines');

/**
 * applyFbpOverlay — Seam A in the monthly run. Given a resolved `compensation`
 * (CompensationRevision + lines + components) and the employee's CURRENT FBP
 * allocation for the run's FY, REPLACE the envelope component line with the exploded
 * head lines + residual (Σ identical to the envelope, to the paise). The returned
 * compensation has the SAME line shape ({ component, calcMethod, amountMonthly,
 * amountAnnual, sortOrder }) so the run's mapComponentLine + engine.computePayslip are
 * UNCHANGED. If there is no allocation (or no envelope line), the compensation is
 * returned untouched (no behaviour change for non-FBP employees — golden parity).
 *
 * @param {object} args
 * @param {string} args.businessId
 * @param {object} args.compensation  resolveCurrentCompensation result (with lines+components)
 * @param {string} args.employeeId
 * @param {string} args.financialYear  the run's FY ("YYYY-YY")
 * @returns the (possibly overlaid) compensation object
 */
async function applyFbpOverlay({ businessId, compensation, employeeId, financialYear, db = prisma }) {
  if (!compensation || !Array.isArray(compensation.lines) || !financialYear) return compensation;

  const allocation = await db.fbpAllocation.findFirst({
    where: { businessId, employeeId, financialYear, deletedAt: null, status: { in: ['SUBMITTED', 'LOCKED'] } },
    orderBy: { version: 'desc' },
    include: { lines: true, plan: { include: { heads: { orderBy: { sortOrder: 'asc' }, include: { component: true } } } } },
  });
  if (!allocation || !allocation.plan) return compensation;

  const plan = allocation.plan;
  // Find the envelope line in the resolved compensation.
  const envLine = compensation.lines.find(
    (l) => (l.componentId === plan.envelopeComponentId) || (l.component && l.component.id === plan.envelopeComponentId),
  );
  if (!envLine) return compensation; // envelope not in this package → nothing to explode

  const envComp = envLine.component || {};
  const envMonthlyMinor = envLine.amountMonthly != null
    ? rupeesToMinor(envLine.amountMonthly)
    : Math.round(rupeesToMinor(envLine.amountAnnual) / 12);

  // Build the pure-explosion inputs from the plan heads + the employee's allocation.
  const headComponentById = new Map(plan.heads.map((h) => [h.id, h.component]));
  const headMetaById = new Map(plan.heads.map((h) => [h.id, h]));
  const explodeHeads = plan.heads.map((h) => ({
    id: h.id,
    componentId: h.componentId,
    headType: h.headType,
    isTaxable: (h.component && h.component.isTaxable) !== false,
    taxSection: h.taxSection || (h.component && h.component.taxSection) || null,
    category: (h.component && h.component.category) || 'EARNING',
    payCadence: h.payCadence || 'MONTHLY',
    sortOrder: h.sortOrder != null ? h.sortOrder : 0,
  }));
  const pureAllocation = (allocation.lines || []).map((l) => ({ headId: l.headId, annualAmountMinor: rupeesToMinor(l.annualAmountRupees) }));

  const mat = materializeFbpLines({
    envelopeMonthlyMinor: envMonthlyMinor,
    heads: explodeHeads,
    allocation: pureAllocation,
    envelopeComponent: { id: envComp.id || plan.envelopeComponentId, category: envComp.category || 'EARNING', isTaxable: envComp.isTaxable !== false },
  });

  // Replace the envelope line with the exploded lines, preserving the comp line shape.
  // Each exploded line carries the head's (or envelope's) SalaryComponent so the run's
  // mapComponentLine reads category/isTaxable/kind exactly as for a normal line.
  const newLines = [];
  for (const l of compensation.lines) {
    if (l === envLine) continue; // drop the envelope; replaced by heads + residual
    newLines.push(l);
  }
  let extraOrder = (compensation.lines.length || 0) + 100;
  for (const ml of mat.lines) {
    const headMeta = ml.headId ? headMetaById.get(ml.headId) : null;
    const component = ml.headId
      ? headComponentById.get(ml.headId)
      : envComp; // residual pays back as the envelope component (special pay)
    if (!component) continue;
    newLines.push({
      // FLAT line: the run treats amountMonthly as the fixed amount.
      componentId: component.id,
      component,
      calcMethod: 'FLAT',
      calcValue: null,
      amountMonthly: money.fromMinor(ml.monthlyMinor),
      amountAnnual: money.fromMinor(ml.annualMinor),
      sortOrder: headMeta && headMeta.sortOrder != null ? headMeta.sortOrder : extraOrder,
      _fbp: true,
      _fbpHeadId: ml.headId || null,
      _fbpResidual: !!ml.isResidual,
    });
    extraOrder += 1;
  }

  return { ...compensation, lines: newLines, _fbpOverlaid: true };
}

module.exports = {
  rupeesToMinor, toRupees, headToPure,
  listPlans, getPlan, savePlan, softDeletePlan,
  resolveEnvelopeAnnualMinor, resolveActivePlan,
  currentAllocation, saveAllocation,
  applyFbpOverlay,
};
