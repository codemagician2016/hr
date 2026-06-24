'use strict';

/**
 * meFbp.controller.js — Feature 25. ESS Flexi-Benefits (FBP) for the employee,
 * mounted at /api/hr/me/fbp. CUSTOMER session (requireCustomer); SELF_ONLY — the
 * subject is resolved from the session (resolveSelfEmployee), NEVER from the client,
 * so cross-employee access is structurally impossible (identical discipline to
 * meProofs / meTaxProjection). India-only (country-gated → 422 for non-IN).
 *
 *   GET  /            → the active plan, the resolved envelope, the current allocation
 *                       (or DRAFT), per-head caps + live exempt/taxable, window status
 *                       + deadline, regime gate.
 *   POST /            → save/submit allocation { lines:[{headId, annual}] }. Gated:
 *                       window OPEN (or none → provisional), Σ ≤ envelope, line ≤ cap.
 *   POST /preview     → pure live impact for the slider (computeFbpSplit + tax-with/out).
 *
 * Bills upload through the F20 ESS path (/api/hr/me/proofs) with the FBP_* claim
 * types — no FBP-specific upload here.
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');
const { resolveStatutoryCountry } = require('../lib/resolveStatutoryCountry');
const fbpService = require('../compensation/fbpService');
const { resolveWindow } = require('../tax/investmentProof/windowResolver');
const { computeFbpExempt } = require('../tax/fbp/fbpAggregator');
const { previewFbp } = require('../tax/fbp/fbpPreview');
const { HEAD_TYPE_TO_CLAIM_TYPE } = require('../tax/investmentProof/claimTypes');

function noEmployee(res) {
  return res.status(404).json({ message: 'No active employee profile for this account.' });
}
function handleError(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('[meFbp.controller]', err);
  return res.status(status).json({ message: err.message || 'Internal error', code: err.code || undefined });
}
function rupeesToMinor(v) {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

async function resolveActiveSelf(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, code: true, firstName: true, middleName: true, lastName: true, countryCode: true, isActive: true },
  });
  if (!emp || emp.isActive === false) return null;
  return emp;
}

function currentFy(asOfIso) {
  return payrollService._internal.taxYearFor(asOfIso || new Date().toISOString().slice(0, 10), 4);
}

// Assert India; throw COUNTRY_UNSUPPORTED (422) otherwise (mirrors meTaxProjection).
async function assertIndia(businessId, emp) {
  const country = await resolveStatutoryCountry(businessId, emp, prisma);
  if (country !== 'IN') { const e = new Error('Flexi Benefits are available for India only.'); e.code = 'COUNTRY_UNSUPPORTED'; e.status = 422; throw e; }
}

async function loadRegime(businessId, employeeId) {
  const sp = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId } });
  return sp && sp.taxRegime ? String(sp.taxRegime).toUpperCase() : 'NEW';
}

/** GET /api/hr/me/fbp?fy= */
async function getMyFbp(req, res) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    await assertIndia(businessId, emp);
    const asOf = typeof req.query.asOf === 'string' ? req.query.asOf : new Date().toISOString().slice(0, 10);
    const fy = typeof req.query.fy === 'string' && /^\d{4}-\d{2}$/.test(req.query.fy) ? req.query.fy : currentFy(asOf);

    const plan = await fbpService.resolveActivePlan({ businessId, employeeId: emp.id, financialYear: fy });
    if (!plan) {
      return res.json({ financialYear: fy, plan: null, message: 'No FBP plan is configured for this year.' });
    }
    const envelopeAnnualMinor = await fbpService.resolveEnvelopeAnnualMinor({ businessId, employeeId: emp.id, plan, asOf });
    const regime = await loadRegime(businessId, emp.id);
    const window = await resolveWindow({ businessId, financialYear: fy, purpose: 'FBP_ALLOCATION' });
    const allocation = await fbpService.currentAllocation({ businessId, employeeId: emp.id, financialYear: fy });

    // Proofs for the per-head exempt/verified view.
    const proofs = await prisma.investmentProof.findMany({
      where: { businessId, employeeId: emp.id, financialYear: fy, deletedAt: null, status: 'ACCEPTED', claimType: { in: ['FBP_LTA', 'FBP_FUEL', 'FBP_TELEPHONE', 'FBP_BOOKS', 'FBP_PROF_DEV', 'FBP_UNIFORM'] } },
      select: { claimType: true, verifiedAmount: true, status: true, deletedAt: true },
    });
    const heads = plan.heads.map(fbpService.headToPure);
    const pureAlloc = allocation ? allocation.lines.map((l) => ({ headId: l.headId, annualAmountMinor: rupeesToMinor(l.annualAmountRupees) })) : [];
    const exempt = computeFbpExempt({ heads, allocation: pureAlloc, proofs, window, asOf, regime });
    const exemptByHead = new Map(exempt.lines.map((l) => [l.headId, l]));

    res.json({
      financialYear: fy,
      regime,
      isOldRegime: regime === 'OLD',
      envelopeAnnual: envelopeAnnualMinor / 100,
      window: window ? { status: window.status, opensAt: window.opensAt, closesAt: window.closesAt, proofDeadline: window.proofDeadline } : null,
      basis: exempt.basis,
      totalExempt: exempt.totalExemptMinor / 100,
      allocationStatus: allocation ? allocation.status : 'NONE',
      plan: { id: plan.id, name: plan.name, financialYear: plan.financialYear },
      heads: plan.heads.map((h) => {
        const hp = fbpService.headToPure(h);
        const e = exemptByHead.get(h.id);
        const allocatedMinor = e ? e.allocatedMinor : 0;
        return {
          headId: h.id,
          headType: h.headType,
          label: h.label,
          taxSection: h.taxSection,
          payCadence: h.payCadence,
          proofRequired: h.proofRequired !== false,
          claimType: h.claimType || HEAD_TYPE_TO_CLAIM_TYPE[h.headType] || null,
          annualCap: hp.annualCapMinor == null ? null : hp.annualCapMinor / 100,
          monthlyCap: hp.monthlyCapMinor == null ? null : hp.monthlyCapMinor / 100,
          allocated: allocatedMinor / 100,
          exempt: e ? e.exemptMinor / 100 : 0,
          verified: e ? e.verifiedMinor / 100 : 0,
        };
      }),
    });
  } catch (err) { handleError(res, err); }
}

/** POST /api/hr/me/fbp  body { lines:[{headId, annual}], status? } */
async function saveMyFbp(req, res) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    await assertIndia(businessId, emp);
    const body = req.body || {};
    const asOf = new Date().toISOString().slice(0, 10);
    const fy = typeof body.financialYear === 'string' && /^\d{4}-\d{2}$/.test(body.financialYear) ? body.financialYear : currentFy(asOf);

    // Window gate: if a window exists it must be OPEN to submit. No window →
    // provisional (allowed; fail-open, edge case 12).
    const window = await resolveWindow({ businessId, financialYear: fy, purpose: 'FBP_ALLOCATION' });
    const status = body.status === 'DRAFT' ? 'DRAFT' : 'SUBMITTED';
    if (window && status === 'SUBMITTED' && window.status !== 'OPEN') {
      return res.status(409).json({ message: `The FBP allocation window is ${window.status}; submissions are only accepted while it is OPEN.`, code: 'FBP_WINDOW_NOT_OPEN' });
    }

    const allocation = await fbpService.saveAllocation({
      businessId, employeeId: emp.id, financialYear: fy,
      lines: body.lines || [], status,
      windowId: window ? window.id : null,
      createdById: null, asOf,
    });
    res.status(201).json({ id: allocation.id, status: allocation.status, version: allocation.version, financialYear: fy });
  } catch (err) { handleError(res, err); }
}

/** POST /api/hr/me/fbp/preview  body { lines:[{headId, annual}] } */
async function previewMyFbp(req, res) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    await assertIndia(businessId, emp);
    const body = req.body || {};
    const asOf = new Date().toISOString().slice(0, 10);
    const fy = typeof body.financialYear === 'string' && /^\d{4}-\d{2}$/.test(body.financialYear) ? body.financialYear : currentFy(asOf);

    const plan = await fbpService.resolveActivePlan({ businessId, employeeId: emp.id, financialYear: fy });
    if (!plan) return res.status(409).json({ message: 'No FBP plan for this year.', code: 'FBP_NO_PLAN' });
    const envelopeAnnualMinor = await fbpService.resolveEnvelopeAnnualMinor({ businessId, employeeId: emp.id, plan, asOf });
    const regime = await loadRegime(businessId, emp.id);

    // Salary context for the live tax-with/without delta: pull the rest of the
    // employee's annual earnings from the current comp so the preview matches the
    // real projection (the envelope is inside otherAllowances pre-explosion).
    const comp = await payrollService._internal.resolveCurrentCompensation(businessId, emp.id, asOf, prisma);
    const salaryContext = buildSalaryContext(comp);

    const heads = plan.heads.map(fbpService.headToPure);
    const allocation = (body.lines || []).map((l) => ({ headId: l.headId, annualAmountMinor: rupeesToMinor(l.annual) }));
    const out = previewFbp({ envelopeMinor: envelopeAnnualMinor, heads, allocation, regime, salaryContext });
    res.json({ ...out, envelopeAnnual: envelopeAnnualMinor / 100, regime, isOldRegime: regime === 'OLD' });
  } catch (err) { handleError(res, err); }
}

// Bucket the current comp into the engine salary context (BASIC/DA, HRA, other).
function buildSalaryContext(compensation) {
  let basicDaMinor = 0, hraReceivedMinor = 0, otherAllowancesMinor = 0, residualChoicePayMinor = 0;
  const lines = (compensation && compensation.lines) || [];
  for (const line of lines) {
    const comp = line.component || {};
    if (comp.category && comp.category !== 'EARNING') continue;
    const annualMinor = line.amountAnnual != null ? rupeesToMinor(line.amountAnnual) : rupeesToMinor(line.amountMonthly) * 12;
    if (annualMinor <= 0) continue;
    const kind = comp.kind;
    const isBalancing = (line.calcMethod || comp.calcMethod) === 'BALANCING';
    if (kind === 'BASIC' || kind === 'DEARNESS_ALLOWANCE') basicDaMinor += annualMinor;
    else if (kind === 'HRA') hraReceivedMinor += annualMinor;
    else if (isBalancing) residualChoicePayMinor += annualMinor;
    else otherAllowancesMinor += annualMinor;
  }
  return { basicDaMinor, hraReceivedMinor, otherAllowancesMinor, residualChoicePayMinor };
}

module.exports = { getMyFbp, saveMyFbp, previewMyFbp, _internal: { buildSalaryContext } };
