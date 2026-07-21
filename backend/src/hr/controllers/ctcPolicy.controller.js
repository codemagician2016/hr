'use strict';

/**
 * ctcPolicy.controller.js — Feature 17 §4.3. The friendly CTC-policy builder's
 * backend: CRUD over reusable, CTC-AGNOSTIC salary templates (rules only), plus a
 * pure preview (compile → deriveBreakup → waterfall + India 50% verdict) and a
 * sample CTC-statement PDF. Mounted under the existing compensation router.
 *
 * Invariants (spec §4.5):
 *   - SINGLE-COUNTRY: countryCode/currencyCode are SERVER-STAMPED from the tenant
 *     (countryContext.js), never trusted from the body. A body country that differs
 *     from the tenant → 409 COUNTRY_MISMATCH. NZ never surfaces for an IN tenant.
 *   - 50% wage floor is FAIL-CLOSED at preview (on the derived amounts) and advised
 *     at save (validatePolicy). The HARD gate on a person's pay lands at onboard.
 *   - TENANT ISOLATION: every query where:{ businessId }; component FKs validated
 *     in-tenant before compile (a foreign componentId → 400).
 *   - Policies carry NO person money → visible to canViewCompensation, no per-employee
 *     scope/masking (a sample CTC is not a person's pay).
 *   - Audited: compensation.change on writes; compensation.read on preview/statement.
 */

const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const { deriveBreakup, DeriveError } = require('../compensation/deriveBreakup');
const {
  compilePolicyToStructureLines,
  validatePolicy,
  policyDefaults,
  CompilePolicyError,
} = require('../compensation/ctcPolicy');
const { renderCtcPdf } = require('../compensation/ctcPdf');
const { tenantCountry, tenantCurrency, CountryError } = require('../tenant/countryContext');

// Coerce a Decimal|number|string → integer minor units (paise) using payroll money.
const money = require('../payroll/money');
function toMinorSafe(value, scale = 2) {
  if (value == null || value === '') return 0;
  let s;
  if (typeof value === 'object' && typeof value.toFixed === 'function') s = value.toFixed(scale);
  else if (typeof value === 'number') s = value.toFixed(scale);
  else s = String(value);
  return money.toMinor(s, scale);
}

// Fire-and-forget audit (never blocks/throws into the request path).
function audit(action, { businessId, actorId, entityId, meta }) {
  Promise.resolve(
    writeAudit({ businessId, actorId, action, entityType: 'CtcPolicy', entityId: entityId || null, meta }),
  ).catch(() => {});
}

// Resolve the tenant's authoritative country/currency (fail-closed). Maps a
// CountryError to the right HTTP status so a pre-setup tenant gets a clean 409.
async function resolveTenant(req, res) {
  try {
    const businessId = req.user.businessId;
    const [country, currency] = await Promise.all([
      tenantCountry(businessId),
      tenantCurrency(businessId),
    ]);
    return { country, currency };
  } catch (e) {
    if (e instanceof CountryError) {
      res.status(e.status || 409).json({ error: e.code, message: 'Your company HR country is not set up yet.' });
      return null;
    }
    throw e;
  }
}

// Validate the line array against the tenant's components (in-tenant) + the policy
// rules. Returns { ok, errors, advisories, components } so callers reuse the lookup.
async function validateLines(businessId, lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const componentIds = [...new Set(arr.map((l) => l && l.componentId).filter(Boolean))];
  const components = componentIds.length
    ? await prisma.salaryComponent.findMany({ where: { id: { in: componentIds }, businessId, deletedAt: null } })
    : [];
  if (components.length !== componentIds.length) {
    return { ok: false, errors: ['One or more pay components are not valid for your company.'], advisories: [], components };
  }
  const v = validatePolicy({ lines: arr }, { components });
  return { ...v, components };
}

// Map a CtcPolicyLine[] from the request body to the create shape (tenant-stamped).
function lineCreates(businessId, lines) {
  return (Array.isArray(lines) ? lines : []).map((l, i) => ({
    businessId,
    componentId: l.componentId,
    calcMethod: String(l.calcMethod || '').toUpperCase(),
    pct: l.pct != null && l.pct !== '' ? String(l.pct) : null,
    flatMonthly: l.flatMonthly != null && l.flatMonthly !== '' ? String(l.flatMonthly) : null,
    baseCode: l.baseCode ? String(l.baseCode).toUpperCase() : null,
    sortOrder: l.sortOrder != null ? l.sortOrder : i,
  }));
}

// Shape a policy row (+lines joined to component labels) for the wire.
function shapePolicy(p) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    entityId: p.entityId,
    countryCode: p.countryCode,
    currencyCode: p.currencyCode,
    basis: p.basis,
    esiApplicable: p.esiApplicable,
    capPfAtCeiling: p.capPfAtCeiling,
    isActive: p.isActive,
    version: p.version,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lines: (p.lines || []).map((l) => ({
      id: l.id,
      componentId: l.componentId,
      component: l.component
        ? { id: l.component.id, code: l.component.code, name: l.component.name, kind: l.component.kind, category: l.component.category }
        : undefined,
      calcMethod: l.calcMethod,
      pct: l.pct,
      flatMonthly: l.flatMonthly,
      baseCode: l.baseCode,
      sortOrder: l.sortOrder,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /ctc-policies — list active (non-deleted) policies for the tenant.
// ─────────────────────────────────────────────────────────────────────────────
async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const { entityId, isActive } = req.query;
    const where = { businessId, deletedAt: null };
    if (entityId) where.entityId = entityId;
    if (isActive !== undefined) where.isActive = isActive === 'true';
    const items = await prisma.ctcPolicy.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
    });
    res.json({ items: items.map(shapePolicy), total: items.length });
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /ctc-policies/defaults — the India starter template, with the tenant's own
// component ids resolved by CODE (so the builder seeds against REAL pay heads).
// Codes the tenant does not own are omitted (the builder shows the rest).
// ─────────────────────────────────────────────────────────────────────────────
async function defaults(req, res, next) {
  try {
    const tenant = await resolveTenant(req, res);
    if (!tenant) return undefined;
    const draft = policyDefaults(tenant.country);
    if (!draft) {
      // Non-IN tenant — no India starter (single-country: NZ default is roadmap).
      return res.status(404).json({ error: 'NO_DEFAULT_POLICY', message: 'No starter policy for your country yet.' });
    }
    // Resolve the draft's componentCode → the tenant's SalaryComponent.id.
    const codes = draft.lines.map((l) => l.componentCode);
    const comps = await prisma.salaryComponent.findMany({
      where: { businessId: req.user.businessId, deletedAt: null, code: { in: codes } },
      select: { id: true, code: true, name: true, kind: true, category: true },
    });
    const byCode = new Map(comps.map((c) => [String(c.code).toUpperCase(), c]));
    const lines = draft.lines
      .map((l, i) => {
        const c = byCode.get(String(l.componentCode).toUpperCase());
        if (!c) return null;
        return {
          componentId: c.id,
          component: { id: c.id, code: c.code, name: c.name, kind: c.kind, category: c.category },
          calcMethod: l.calcMethod,
          pct: l.pct != null ? l.pct : null,
          flatMonthly: l.flatMonthly != null ? l.flatMonthly : null,
          baseCode: l.baseCode || null,
          sortOrder: i,
        };
      })
      .filter(Boolean);
    res.json({
      code: draft.code,
      name: draft.name,
      countryCode: tenant.country,
      currencyCode: tenant.currency,
      basis: draft.basis,
      esiApplicable: draft.esiApplicable,
      capPfAtCeiling: draft.capPfAtCeiling,
      lines,
      // Surface the codes we COULDN'T resolve so the UI can hint "create these heads".
      missingCodes: draft.lines.map((l) => l.componentCode).filter((cd) => !byCode.has(String(cd).toUpperCase())),
    });
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /ctc-policies/:id — one policy + its lines (component labels joined).
// ─────────────────────────────────────────────────────────────────────────────
async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const p = await prisma.ctcPolicy.findFirst({
      where: { id: req.params.id, businessId, deletedAt: null },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
    });
    if (!p) return res.status(404).json({ message: 'CTC policy not found' });
    res.json(shapePolicy(p));
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /ctc-policies — create. countryCode/currencyCode SERVER-STAMPED from the
// tenant; a mismatching body country → 409. validatePolicy fail-closed.
// ─────────────────────────────────────────────────────────────────────────────
async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const { code, name, entityId, basis, esiApplicable, capPfAtCeiling, lines } = req.body || {};
    if (!code || !name) return res.status(400).json({ message: 'code and name are required' });

    const tenant = await resolveTenant(req, res);
    if (!tenant) return undefined;
    // SINGLE-COUNTRY: a body country that differs from the tenant is rejected.
    const bodyCountry = req.body.countryCode ? String(req.body.countryCode).toUpperCase() : null;
    if (bodyCountry && bodyCountry !== tenant.country) {
      return res.status(409).json({ error: 'COUNTRY_MISMATCH', message: 'A CTC policy must use your company country.' });
    }
    // SINGLE-SOURCE BASIS (review MED finding #3): onboard FORCES basis from country
    // (IN → CTC). Refuse to persist a GROSS-basis policy on an IN tenant, else preview
    // would derive a basis onboard never materializes — the package the candidate sees
    // would diverge from what is committed. Basis is then always the country basis.
    if (tenant.country === 'IN' && String(basis || '').toUpperCase() === 'GROSS') {
      return res.status(422).json({ error: 'BASIS_NOT_ALLOWED', message: 'India CTC policies must use a CTC basis (GROSS is not supported).' });
    }

    const v = await validateLines(businessId, lines);
    if (!v.ok) return res.status(422).json({ error: 'POLICY_INVALID', errors: v.errors, advisories: v.advisories });

    const created = await prisma.ctcPolicy.create({
      data: {
        businessId,
        entityId: entityId || null,
        code: String(code).trim(),
        name: String(name).trim(),
        countryCode: tenant.country,
        currencyCode: tenant.currency,
        basis: basis === 'GROSS' ? 'GROSS' : 'CTC',
        esiApplicable: esiApplicable === true,
        capPfAtCeiling: capPfAtCeiling !== false,
        createdById: req.user.id || null,
        lines: { create: lineCreates(businessId, lines) },
      },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
    });
    audit('compensation.change', { businessId, actorId: req.user.id, entityId: created.id, meta: { op: 'ctc-policy.create', code: created.code } });
    res.status(201).json({ ...shapePolicy(created), advisories: v.advisories });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A CTC policy with that code already exists' });
    next(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /ctc-policies/:id — replace lines atomically + re-validate. Header fields
// (name/entity/basis/knobs/isActive) optional; countryCode/currencyCode are NEVER
// editable (single-country invariant).
// ─────────────────────────────────────────────────────────────────────────────
async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.ctcPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'CTC policy not found' });
    // Feature 42 — CTC LOCK: a locked policy refuses edits until unlocked by a
    // canApproveCompensation holder (policy writes have no maker-checker; the
    // lock is the freeze that protects an agreed structure from silent drift).
    if (existing.isLocked) {
      return res.status(423).json({ error: 'CTC_POLICY_LOCKED', message: 'This CTC policy is locked. Unlock it (approver-only) before editing.' });
    }

    if (req.body.countryCode && String(req.body.countryCode).toUpperCase() !== existing.countryCode) {
      return res.status(409).json({ error: 'COUNTRY_MISMATCH', message: 'A CTC policy country cannot be changed.' });
    }
    // Single-source basis (review MED finding #3): an IN policy may never become GROSS
    // basis (onboard forces CTC from country; a GROSS policy would mislead preview).
    if (req.body.basis !== undefined && existing.countryCode === 'IN' && String(req.body.basis || '').toUpperCase() === 'GROSS') {
      return res.status(422).json({ error: 'BASIS_NOT_ALLOWED', message: 'India CTC policies must use a CTC basis (GROSS is not supported).' });
    }

    const data = {};
    if (req.body.name !== undefined) data.name = String(req.body.name).trim();
    if (req.body.entityId !== undefined) data.entityId = req.body.entityId || null;
    if (req.body.basis !== undefined) data.basis = req.body.basis === 'GROSS' ? 'GROSS' : 'CTC';
    if (req.body.esiApplicable !== undefined) data.esiApplicable = req.body.esiApplicable === true;
    if (req.body.capPfAtCeiling !== undefined) data.capPfAtCeiling = req.body.capPfAtCeiling !== false;
    if (req.body.isActive !== undefined) data.isActive = req.body.isActive === true;

    const linesProvided = Array.isArray(req.body.lines);
    let advisories = [];
    if (linesProvided) {
      const v = await validateLines(businessId, req.body.lines);
      if (!v.ok) return res.status(422).json({ error: 'POLICY_INVALID', errors: v.errors, advisories: v.advisories });
      advisories = v.advisories;
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (linesProvided) {
        await tx.ctcPolicyLine.deleteMany({ where: { businessId, policyId: existing.id } });
        data.lines = { create: lineCreates(businessId, req.body.lines) };
      }
      data.version = { increment: 1 };
      return tx.ctcPolicy.update({
        where: { id: existing.id },
        data,
        include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
      });
    });
    audit('compensation.change', { businessId, actorId: req.user.id, entityId: updated.id, meta: { op: 'ctc-policy.update', code: updated.code } });
    res.json({ ...shapePolicy(updated), advisories });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'A CTC policy with that code already exists' });
    next(e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /ctc-policies/:id — soft-delete (deletedAt). Existing hires are unaffected
// (revisions snapshot resolved lines; a policy is a template, not a live link).
// ─────────────────────────────────────────────────────────────────────────────
async function remove(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.ctcPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'CTC policy not found' });
    // Feature 42 — a locked policy cannot be deleted either.
    if (existing.isLocked) {
      return res.status(423).json({ error: 'CTC_POLICY_LOCKED', message: 'This CTC policy is locked. Unlock it (approver-only) before deleting.' });
    }
    await prisma.ctcPolicy.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } });
    audit('compensation.change', { businessId, actorId: req.user.id, entityId: existing.id, meta: { op: 'ctc-policy.delete', code: existing.code } });
    res.status(204).end();
  } catch (e) { next(e); }
}

// ── Feature 42 — CTC LOCK / UNLOCK ────────────────────────────────────────────
// Lock: any canManageCompensation holder may lock (freeze an agreed structure).
// Unlock: gated at the ROUTE on canApproveCompensation (the comp CHECKER role) —
// the maker who locked it cannot silently unfreeze without the approver.
async function lock(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.ctcPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'CTC policy not found' });
    if (existing.isLocked) return res.json(shapePolicy(existing));
    const row = await prisma.ctcPolicy.update({
      where: { id: existing.id },
      data: { isLocked: true, lockedById: req.user.id || null, lockedAt: new Date() },
    });
    audit('compensation.change', { businessId, actorId: req.user.id, entityId: row.id, meta: { op: 'ctc-policy.lock', code: row.code } });
    res.json(shapePolicy(row));
  } catch (e) { next(e); }
}

async function unlock(req, res, next) {
  try {
    const { businessId } = req.user;
    const existing = await prisma.ctcPolicy.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
    if (!existing) return res.status(404).json({ message: 'CTC policy not found' });
    if (!existing.isLocked) return res.json(shapePolicy(existing));
    const row = await prisma.ctcPolicy.update({
      where: { id: existing.id },
      data: { isLocked: false, lockedById: null, lockedAt: null },
    });
    audit('compensation.change', { businessId, actorId: req.user.id, entityId: row.id, meta: { op: 'ctc-policy.unlock', code: row.code } });
    res.json(shapePolicy(row));
  } catch (e) { next(e); }
}

// Compile a (persisted OR ad-hoc) policy + components → deriveBreakup → the waterfall
// + line items + employer cost + 50% verdict, at a sample CTC. PURE (no persist).
// Accepts either a persisted policy { lines, components } or an in-flight draft
// (lines on the body) so the builder previews UNSAVED edits too.
//
// SINGLE-SOURCE BASIS (review MED finding #3): the committed hire (onboard.controller)
// FORCES basis from the tenant country (IN → CTC, else GROSS) and IGNORES policy.basis.
// Preview MUST use the EXACT SAME resolution so the candidate's previewed package is
// byte-identical to what onboard commits — never policy.basis or a body-supplied basis.
async function computePreview({ businessId, policy, components, ctcAnnual, grossMonthly, countryCode, currencyCode, asOf }) {
  const cc = (countryCode || 'IN').toUpperCase();
  // Force basis from country — IDENTICAL to onboard.controller.byCtc (`basis =
  // countryCode === 'IN' ? 'CTC' : 'GROSS'`). policy.basis is intentionally not read.
  const basis = cc === 'IN' ? 'CTC' : 'GROSS';
  const { lines } = compilePolicyToStructureLines(policy, { components });
  const tgt = {};
  if (basis === 'CTC' && ctcAnnual != null) tgt.ctcAnnualMinor = toMinorSafe(ctcAnnual);
  else if (grossMonthly != null) tgt.grossMonthlyMinor = toMinorSafe(grossMonthly);
  else if (ctcAnnual != null) tgt.ctcAnnualMinor = toMinorSafe(ctcAnnual);

  const breakup = deriveBreakup({
    target: tgt,
    basis,
    lines,
    ctx: {
      countryCode: cc,
      asOf,
      esiApplicable: policy.esiApplicable === true,
      capPfAtCeiling: policy.capPfAtCeiling !== false,
    },
  });

  const employerCostMonthlyMinor = breakup.employerCost.monthlyMinor;
  const waterfall = { employerCostMonthlyMinor, grossMonthlyMinor: breakup.grossMinor };
  if (tgt.ctcAnnualMinor != null) waterfall.ctcAnnualMinor = tgt.ctcAnnualMinor;
  else if (employerCostMonthlyMinor > 0) waterfall.ctcAnnualMinor = (breakup.targetGrossMinor + employerCostMonthlyMinor) * 12;
  else waterfall.grossAnnualMinor = breakup.grossMinor * 12;

  return { basis, currencyCode, target: tgt, waterfall, resolved: breakup.resolved, employerCost: breakup.employerCost, basicDaMonthlyMinor: breakup.basicDaMonthlyMinor, wagesVerdict: breakup.wagesVerdict };
}

// Load a persisted policy + its components (tenant-scoped) for preview/statement.
async function loadPolicyForCompile(businessId, id) {
  const policy = await prisma.ctcPolicy.findFirst({
    where: { id, businessId, deletedAt: null },
    include: { lines: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!policy) return null;
  const componentIds = [...new Set((policy.lines || []).map((l) => l.componentId))];
  const components = componentIds.length
    ? await prisma.salaryComponent.findMany({ where: { id: { in: componentIds }, businessId, deletedAt: null } })
    : [];
  return { policy, components };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /ctc-policies/:id/preview — body { ctcAnnual } → waterfall + 50% verdict.
// PURE, no persist. Debounced from the builder/wizard.
// POST /ctc-policies/preview      — same, but on an AD-HOC draft (body.lines), so an
//   UNSAVED policy in the builder previews live. countryCode/currency tenant-stamped.
// ─────────────────────────────────────────────────────────────────────────────
async function preview(req, res, next) {
  try {
    const { businessId } = req.user;
    const tenant = await resolveTenant(req, res);
    if (!tenant) return undefined;
    const { ctcAnnual, grossMonthly, asOf } = req.body || {};

    let policy;
    let components;
    if (req.params.id) {
      const loaded = await loadPolicyForCompile(businessId, req.params.id);
      if (!loaded) return res.status(404).json({ message: 'CTC policy not found' });
      policy = loaded.policy;
      components = loaded.components;
    } else {
      // Ad-hoc draft from the body — validate the lines in-tenant first.
      const v = await validateLines(businessId, req.body.lines);
      if (!v.ok) return res.status(422).json({ error: 'POLICY_INVALID', errors: v.errors, advisories: v.advisories });
      policy = {
        lines: req.body.lines,
        basis: req.body.basis === 'GROSS' ? 'GROSS' : 'CTC',
        esiApplicable: req.body.esiApplicable === true,
        capPfAtCeiling: req.body.capPfAtCeiling !== false,
      };
      components = v.components;
    }

    let out;
    try {
      out = await computePreview({
        businessId, policy, components, ctcAnnual, grossMonthly,
        countryCode: tenant.country, currencyCode: tenant.currency, asOf,
      });
    } catch (err) {
      if (err instanceof CompilePolicyError) return res.status(err.status || 422).json({ error: 'POLICY_UNRESOLVED', message: err.message });
      if (err instanceof DeriveError) return res.status(422).json({ error: err.code, message: err.message });
      throw err;
    }
    audit('compensation.read', { businessId, actorId: req.user.id, meta: { op: 'ctc-policy.preview', policyId: req.params.id || null } });
    res.json(out);
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /ctc-policies/:id/statement.pdf — compile → breakup → ctcPdf.js. A SAMPLE
// statement (watermark in identity), NOT a person's pay. Reuses the branded PDF.
// ─────────────────────────────────────────────────────────────────────────────
async function statementPdf(req, res, next) {
  try {
    const { businessId } = req.user;
    const tenant = await resolveTenant(req, res);
    if (!tenant) return undefined;
    const { ctcAnnual, grossMonthly, asOf } = req.body || {};

    const loaded = await loadPolicyForCompile(businessId, req.params.id);
    if (!loaded) return res.status(404).json({ message: 'CTC policy not found' });

    let out;
    try {
      out = await computePreview({
        businessId, policy: loaded.policy, components: loaded.components, ctcAnnual, grossMonthly,
        countryCode: tenant.country, currencyCode: tenant.currency, asOf,
      });
    } catch (err) {
      if (err instanceof CompilePolicyError) return res.status(err.status || 422).json({ error: 'POLICY_UNRESOLVED', message: err.message });
      if (err instanceof DeriveError) return res.status(422).json({ error: err.code, message: err.message });
      throw err;
    }

    const business = await prisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true } });

    // Shape the breakup into the renderCtcPdf `revision` (absolute) envelope. Lines
    // carry the joined component label/category so the PDF groups earnings/employer.
    const compById = new Map((loaded.components || []).map((c) => [c.id, c]));
    const ctcAnnualMajor = out.waterfall.ctcAnnualMinor != null ? out.waterfall.ctcAnnualMinor / 100 : null;
    const grossMonthlyMajor = out.waterfall.grossMonthlyMinor != null ? out.waterfall.grossMonthlyMinor / 100 : null;
    const revLines = (out.resolved || []).map((r) => {
      const c = r.componentId ? compById.get(r.componentId) : null;
      return {
        component: c ? { code: c.code, name: c.name, category: c.category } : { code: r.code, category: r.category },
        amountMonthly: r.amountMonthlyMinor / 100,
        amountAnnual: r.amountAnnualMinor / 100,
      };
    });
    // Employer-cost lines from the quote items (cost-to-company, not paid out).
    for (const it of (out.employerCost && out.employerCost.items) || []) {
      revLines.push({ component: { code: it.code, name: it.code, category: 'EMPLOYER_COST' }, amountMonthly: it.amountMinor / 100, amountAnnual: (it.amountMinor / 100) * 12 });
    }

    const revision = {
      effectiveFrom: asOf || new Date().toISOString().slice(0, 10),
      currencyCode: tenant.currency,
      revisionReason: 'SAMPLE',
      absolute: { ctcAnnual: ctcAnnualMajor, grossMonthly: grossMonthlyMajor },
      lines: revLines,
    };
    const employee = { firstName: 'Sample', lastName: 'Statement', code: loaded.policy.code };
    const pdf = await renderCtcPdf({ employee, business: business || { id: businessId }, revision, currency: tenant.currency });

    audit('compensation.read', { businessId, actorId: req.user.id, meta: { op: 'ctc-policy.statement', policyId: req.params.id } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="ctc-policy-${loaded.policy.code}-sample.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.status(200).send(pdf);
  } catch (e) { next(e); }
}

module.exports = {
  list, get, create, update, remove, lock, unlock, defaults, preview, statementPdf,
  // exported for tests / the onboard controller's reuse
  _internal: { computePreview, validateLines, loadPolicyForCompile, lineCreates, shapePolicy },
};
