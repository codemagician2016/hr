'use strict';

/**
 * fbp.controller.js — Feature 25. The OPERATOR (hr-admin) FBP endpoints: the plan
 * builder (CRUD), the India template, the plan preview (tax-with/without), and the
 * allocation roster + per-employee drill-down + force-lock. Tenant-scoped; India
 * country-stamped on create. RBAC is enforced at the route layer
 * (canViewCompensation / canManageCompensation / canManagePayroll / canViewEmployees).
 *
 * Proof verify for FBP bills REUSES the F20 proofs.controller verbatim (the FBP_*
 * claim types ride the same accept/reject + SoD + console) — no FBP-specific verify
 * code here. The roster just surfaces the per-employee FBP state.
 */

const prisma = require('../../core/lib/prisma');
const fbpService = require('../compensation/fbpService');
const { indiaFbpHeadTemplate } = require('../compensation/fbpPlan');
const { previewFbp } = require('../tax/fbp/fbpPreview');
const { computeFbpExempt } = require('../tax/fbp/fbpAggregator');
const { resolveWindow } = require('../tax/investmentProof/windowResolver');

function handleError(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('[fbp.controller]', err);
  return res.status(status).json({ message: err.message || 'Internal error', code: err.code || undefined });
}

function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// ── Plan builder ──────────────────────────────────────────────────────────────

async function listPlans(req, res) {
  try {
    const { businessId } = req.user;
    const financialYear = typeof req.query.fy === 'string' ? req.query.fy : undefined;
    const plans = await fbpService.listPlans({ businessId, financialYear });
    res.json({ items: plans });
  } catch (err) { handleError(res, err); }
}

async function getPlan(req, res) {
  try {
    const { businessId } = req.user;
    const plan = await fbpService.getPlan({ businessId, id: req.params.id });
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    res.json(plan);
  } catch (err) { handleError(res, err); }
}

// The India template seed for "Start from India template".
async function getTemplate(req, res) {
  try {
    res.json({ countryCode: 'IN', heads: indiaFbpHeadTemplate() });
  } catch (err) { handleError(res, err); }
}

async function createPlan(req, res) {
  try {
    const { businessId, id: userId } = req.user;
    const plan = await fbpService.savePlan({ businessId, createdById: userId, input: req.body || {} });
    res.status(201).json(plan);
  } catch (err) { handleError(res, err); }
}

async function updatePlan(req, res) {
  try {
    const { businessId } = req.user;
    const plan = await fbpService.savePlan({ businessId, input: req.body || {}, existingId: req.params.id });
    res.json(plan);
  } catch (err) { handleError(res, err); }
}

async function deletePlan(req, res) {
  try {
    const { businessId } = req.user;
    await fbpService.softDeletePlan({ businessId, id: req.params.id });
    res.json({ ok: true });
  } catch (err) { handleError(res, err); }
}

/**
 * POST /plans/:id/preview — pure computeFbpSplit + tax-with/without. Body:
 *   { envelopeAnnual, regime, allocation:[{headId, annual}], salaryContext? }
 * No persist. Drives the ESS live impact + the admin preview.
 */
async function previewPlan(req, res) {
  try {
    const { businessId } = req.user;
    const plan = await fbpService.getPlan({ businessId, id: req.params.id });
    if (!plan) return res.status(404).json({ message: 'Plan not found' });
    const body = req.body || {};
    const heads = plan.heads.map(fbpService.headToPure);
    const allocation = (body.allocation || []).map((a) => ({ headId: a.headId, annualAmountMinor: rupeesToMinor(a.annual) }));
    const out = previewFbp({
      envelopeMinor: rupeesToMinor(body.envelopeAnnual),
      heads,
      allocation,
      regime: body.regime || 'OLD',
      salaryContext: body.salaryContext || {},
    });
    res.json(out);
  } catch (err) { handleError(res, err); }
}

// ── Allocation roster + drill-down ──────────────────────────────────────────────

/**
 * GET /allocations?fy=&status=&page= — the roster: who has/hasn't declared, envelope
 * vs allocated vs unallocated, regime, status. Tenant-scoped + (route) F1-scoped.
 */
async function listAllocations(req, res) {
  try {
    const { businessId } = req.user;
    const fy = typeof req.query.fy === 'string' ? req.query.fy : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const where = { businessId, deletedAt: null };
    if (fy) where.financialYear = fy;
    if (status) where.status = status;
    // The scope middleware (if present) attaches req.scope; honour it.
    if (req.scope && Array.isArray(req.scope.employeeIds)) {
      where.employeeId = { in: req.scope.employeeIds };
    }
    const allocations = await prisma.fbpAllocation.findMany({
      where,
      include: {
        employee: { select: { id: true, code: true, firstName: true, lastName: true } },
        lines: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    const items = allocations.map((a) => {
      const envMinor = rupeesToMinor(a.envelopeAnnualRupees);
      const allocMinor = (a.lines || []).reduce((s, l) => s + rupeesToMinor(l.annualAmountRupees), 0);
      return {
        id: a.id,
        employeeId: a.employeeId,
        employeeName: [a.employee && a.employee.firstName, a.employee && a.employee.lastName].filter(Boolean).join(' ') || (a.employee && a.employee.code),
        financialYear: a.financialYear,
        status: a.status,
        envelopeAnnual: envMinor / 100,
        allocated: allocMinor / 100,
        unallocated: (envMinor - allocMinor) / 100,
        version: a.version,
        submittedAt: a.submittedAt,
        lockedAt: a.lockedAt,
      };
    });
    res.json({ items });
  } catch (err) { handleError(res, err); }
}

/** GET /employees/:employeeId/fbp?fy= — one employee's allocation + per-head split. */
async function getEmployeeFbp(req, res) {
  try {
    const { businessId } = req.user;
    const employeeId = req.params.employeeId;
    const fy = typeof req.query.fy === 'string' ? req.query.fy
      : require('../payroll/service')._internal.taxYearFor(new Date().toISOString().slice(0, 10), 4);
    const allocation = await fbpService.currentAllocation({ businessId, employeeId, financialYear: fy });
    if (!allocation) return res.json({ financialYear: fy, allocation: null, lines: [] });

    const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId } });
    const regime = sp && sp.taxRegime ? String(sp.taxRegime).toUpperCase() : 'NEW';
    const window = await resolveWindow({ businessId, financialYear: fy, purpose: 'FBP_ALLOCATION' });
    const proofs = await prisma.investmentProof.findMany({
      where: { businessId, employeeId, financialYear: fy, deletedAt: null, status: 'ACCEPTED', claimType: { in: ['FBP_LTA', 'FBP_FUEL', 'FBP_TELEPHONE', 'FBP_BOOKS', 'FBP_PROF_DEV', 'FBP_UNIFORM'] } },
      select: { claimType: true, verifiedAmount: true, status: true, deletedAt: true },
    });
    const heads = allocation.plan.heads.map(fbpService.headToPure);
    const pureAlloc = allocation.lines.map((l) => ({ headId: l.headId, annualAmountMinor: rupeesToMinor(l.annualAmountRupees) }));
    const exempt = computeFbpExempt({ heads, allocation: pureAlloc, proofs, window, asOf: new Date().toISOString().slice(0, 10), regime });
    res.json({
      financialYear: fy,
      regime,
      status: allocation.status,
      envelopeAnnual: rupeesToMinor(allocation.envelopeAnnualRupees) / 100,
      basis: exempt.basis,
      totalExempt: exempt.totalExemptMinor / 100,
      lines: exempt.lines.map((l) => ({
        headType: l.headType, label: l.label, taxSection: l.taxSection,
        allocated: l.allocatedMinor / 100, cap: l.capMinor == null ? null : l.capMinor / 100,
        verified: l.verifiedMinor / 100, exempt: l.exemptMinor / 100, unverified: l.unverifiedMinor / 100,
        proofRequired: l.proofRequired, basis: l.basis,
      })),
    });
  } catch (err) { handleError(res, err); }
}

/** POST /employees/:employeeId/fbp/:id/lock — force-lock (SoD: operator ≠ subject). */
async function lockEmployeeFbp(req, res) {
  try {
    const { businessId } = req.user;
    const employeeId = req.params.employeeId;
    // SoD: the operator may not lock their own allocation.
    const operatorEmp = await prisma.employee.findFirst({ where: { userId: req.user.id, businessId, deletedAt: null }, select: { id: true } });
    if (operatorEmp && operatorEmp.id === employeeId) {
      return res.status(403).json({ message: 'You cannot lock your own FBP allocation (separation of duties).', code: 'SOD_VIOLATION' });
    }
    const alloc = await prisma.fbpAllocation.findFirst({ where: { id: req.params.id, businessId, employeeId, deletedAt: null } });
    if (!alloc) return res.status(404).json({ message: 'Allocation not found' });
    const updated = await prisma.fbpAllocation.update({
      where: { id: alloc.id },
      data: { status: 'LOCKED', lockedAt: new Date(), version: { increment: 1 } },
    });
    res.json({ id: updated.id, status: updated.status, lockedAt: updated.lockedAt });
  } catch (err) { handleError(res, err); }
}

module.exports = {
  listPlans, getPlan, getTemplate, createPlan, updatePlan, deletePlan, previewPlan,
  listAllocations, getEmployeeFbp, lockEmployeeFbp,
};
