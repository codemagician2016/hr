'use strict';
// Compensation domain: pay components (SalaryComponent), reusable salary
// structures/templates (SalaryStructure + SalaryComponentLine), and the
// append-only, effective-dated assigned pay (CompensationRevision).
//
// Tenant-scoped by req.user.businessId on every query. SalaryComponent and
// SalaryStructure carry deletedAt (soft-delete). CompensationRevision is
// append-only: a new revision supersedes the prior current one (we close its
// effectiveTo + flip isCurrent) rather than editing in place.
//
// Money fields (calcValue, amountMonthly, ctcAnnual, ...) are Prisma Decimal —
// we pass numbers/strings straight through and NEVER parseInt them.
const prisma = require('../../core/lib/prisma');
const { writeAudit } = require('../../core/lib/audit');
const money = require('../payroll/money');
const india = require('../payroll/compliance/india');
const { deriveBreakup, materializeRevisionLines, DeriveError } = require('../compensation/deriveBreakup');
const { maskCompensation } = require('../compensation/maskCompensation');
const { effectiveCompVisibility } = require('../../core/lib/rbac');

// Coerce a Decimal|number|string → integer minor units (paise/cents). Reuses
// payroll money string-math so no float drift creeps in.
function toMinorSafe(value, scale = 2) {
  if (value == null || value === '') return 0;
  let s;
  if (typeof value === 'object' && typeof value.toFixed === 'function') s = value.toFixed(scale);
  else if (typeof value === 'number') s = value.toFixed(scale);
  else s = String(value);
  return money.toMinor(s, scale);
}

// Fire-and-forget compensation.read audit (DPDP / NZ Privacy Act access trail).
// Never blocks the response and never throws into the request path.
function auditRead({ businessId, actorId, employeeId, visibility, fields }) {
  Promise.resolve(
    writeAudit({
      businessId,
      actorId,
      action: 'compensation.read',
      entityType: 'CompensationRevision',
      entityId: employeeId || null,
      meta: { employeeId, visibility, fields },
    }),
  ).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

const dup = (res) => res.status(409).json({ message: 'A record with that code already exists' });

function picker(fields, dates = []) {
  return (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    for (const d of dates) if (out[d] != null) out[d] = new Date(out[d]);
    return out;
  };
}

// Decimal-safe numeric coercion. Accepts number | numeric-string | Prisma
// Decimal; returns a JS number for arithmetic only (validation/comparison).
// We never persist the result — the original value is stored verbatim.
function toNum(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// India Code on Wages, 2019 — "wages" floor rule (CONSOLIDATED, fail-closed).
//
// Replaces the legacy fail-open float guard with the engine-backed
// computeStatutoryWages (the SAME guard offerWageCheck / provisioning use):
// integer paise, effective-dated (50% add-back effective 2025-11-21), fail-CLOSED
// (an INR package whose Basic+DA cannot be resolved or is below 50% of gross →
// ok:false). Country-gated: skipped for NZ (no "Basic 50%" concept).
//
// classify a line as "wages" by the component's kind (BASIC/DEARNESS_ALLOWANCE)
// and sum monthly amounts; gross = Σ EARNING-category monthly amounts.
// ─────────────────────────────────────────────────────────────────────────────
const WAGE_KINDS = new Set(['BASIC', 'DEARNESS_ALLOWANCE']);

function validateWages50(linesWithComponent, { countryCode = 'IN', asOf } = {}) {
  const isIndia = String(countryCode || '').toUpperCase() === 'IN';
  if (!isIndia) return { ok: true, applies: false, ruleApplied: false };

  let wagesMinor = 0;
  let grossMinor = 0;
  let sawEarning = false;
  for (const line of linesWithComponent) {
    const comp = line.component || {};
    if (comp.category !== 'EARNING') continue;
    sawEarning = true;
    const amtMinor = toMinorSafe(line.amountMonthly != null ? line.amountMonthly : line.calcValue);
    grossMinor += amtMinor;
    if (WAGE_KINDS.has(comp.kind)) wagesMinor += amtMinor;
  }
  // FAIL-CLOSED: an INR package with no resolvable gross cannot be judged safe.
  if (!sawEarning || grossMinor <= 0) {
    return { ok: false, applies: true, code: 'WAGES_50_RULE', wages: 0, gross: 0, reason: 'no resolvable gross' };
  }
  const verdict = india._internals.computeStatutoryWages({
    periodGrossMinor: grossMinor,
    basicDaMinor: wagesMinor,
    asOf: asOf || new Date().toISOString().slice(0, 10),
  });
  return {
    ok: !verdict.breach,
    applies: true,
    code: verdict.breach ? 'WAGES_50_RULE' : undefined,
    ruleApplied: verdict.ruleApplied,
    wages: wagesMinor / 100,
    gross: grossMinor / 100,
    floorMinor: verdict.floorMinor != null ? verdict.floorMinor : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PayComponent (SalaryComponent) — CRUD
// ─────────────────────────────────────────────────────────────────────────────

const COMPONENT_FIELDS = [
  'entityId', 'code', 'name', 'kind', 'category',
  'calcMethod', 'calcValue', 'calcBaseCode', 'calcBaseScope',
  'isWageForPF', 'isWageForESI', 'isWageForPT', 'isWageForGratuity',
  'isTaxable', 'taxSection', 'isKiwiSaverable', 'isPayeable',
  'isRecurring', 'prorationMethod', 'glCode', 'sortOrder', 'isActive',
];
const pickComponent = picker(COMPONENT_FIELDS);

const components = {
  list: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { entityId, category, kind, q, page = '1', pageSize = '25' } = req.query;
      const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
      const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

      const where = { businessId, deletedAt: null };
      if (entityId) where.entityId = entityId;
      if (category) where.category = category;
      if (kind) where.kind = kind;
      if (q) {
        where.OR = [
          { code: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ];
      }

      const [items, total] = await Promise.all([
        prisma.salaryComponent.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], skip, take }),
        prisma.salaryComponent.count({ where }),
      ]);
      res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
    } catch (e) { next(e); }
  },
  get: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const item = await prisma.salaryComponent.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
      if (!item) return res.status(404).json({ message: 'Pay component not found' });
      res.json(item);
    } catch (e) { next(e); }
  },
  create: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { code, name, kind, category, calcMethod } = req.body;
      if (!code || !name || !kind || !category || !calcMethod) {
        return res.status(400).json({ message: 'code, name, kind, category and calcMethod are required' });
      }
      const data = { ...pickComponent(req.body), businessId };
      const item = await prisma.salaryComponent.create({ data });
      res.status(201).json(item);
    } catch (e) { if (e.code === 'P2002') return dup(res); next(e); }
  },
  update: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const existing = await prisma.salaryComponent.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
      if (!existing) return res.status(404).json({ message: 'Pay component not found' });
      const item = await prisma.salaryComponent.update({ where: { id: req.params.id }, data: pickComponent(req.body) });
      res.json(item);
    } catch (e) { if (e.code === 'P2002') return dup(res); next(e); }
  },
  remove: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const existing = await prisma.salaryComponent.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
      if (!existing) return res.status(404).json({ message: 'Pay component not found' });
      await prisma.salaryComponent.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
      res.status(204).end();
    } catch (e) { next(e); }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SalaryStructure — CRUD (with optional nested component lines on create)
// ─────────────────────────────────────────────────────────────────────────────

const STRUCTURE_FIELDS = ['entityId', 'code', 'name', 'countryCode', 'currencyCode', 'basis', 'isActive'];
const pickStructure = picker(STRUCTURE_FIELDS);

const LINE_FIELDS = ['componentId', 'calcMethod', 'calcValue', 'amountMonthly', 'amountAnnual', 'sortOrder'];
const pickLine = picker(LINE_FIELDS);

const structures = {
  list: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { entityId, isActive, page = '1', pageSize = '25' } = req.query;
      const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
      const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

      const where = { businessId, deletedAt: null };
      if (entityId) where.entityId = entityId;
      if (isActive !== undefined) where.isActive = isActive === 'true';

      const [items, total] = await Promise.all([
        prisma.salaryStructure.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
        prisma.salaryStructure.count({ where }),
      ]);
      res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
    } catch (e) { next(e); }
  },
  get: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const item = await prisma.salaryStructure.findFirst({
        where: { id: req.params.id, businessId, deletedAt: null },
        include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
      });
      if (!item) return res.status(404).json({ message: 'Salary structure not found' });
      res.json(item);
    } catch (e) { next(e); }
  },
  create: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { entityId, code, name, countryCode, currencyCode, basis } = req.body;
      if (!entityId || !code || !name || !countryCode || !currencyCode || !basis) {
        return res.status(400).json({ message: 'entityId, code, name, countryCode, currencyCode and basis are required' });
      }
      const data = { ...pickStructure(req.body), businessId };
      // Optional nested lines — stamp businessId on each (tenant scope) and
      // allow-list the line fields so callers can seed a template in one call.
      if (Array.isArray(req.body.lines) && req.body.lines.length) {
        for (const l of req.body.lines) {
          if (!l || !l.componentId || !l.calcMethod) {
            return res.status(400).json({ message: 'each line requires componentId and calcMethod' });
          }
        }
        data.lines = { create: req.body.lines.map((l) => ({ ...pickLine(l), businessId })) };
      }
      const item = await prisma.salaryStructure.create({
        data,
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      });
      res.status(201).json(item);
    } catch (e) { if (e.code === 'P2002') return dup(res); next(e); }
  },
  update: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const existing = await prisma.salaryStructure.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
      if (!existing) return res.status(404).json({ message: 'Salary structure not found' });
      const item = await prisma.salaryStructure.update({ where: { id: req.params.id }, data: pickStructure(req.body) });
      res.json(item);
    } catch (e) { if (e.code === 'P2002') return dup(res); next(e); }
  },
  remove: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const existing = await prisma.salaryStructure.findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
      if (!existing) return res.status(404).json({ message: 'Salary structure not found' });
      await prisma.salaryStructure.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
      res.status(204).end();
    } catch (e) { next(e); }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CompensationRevision — effective-dated, append-only, per employee
// ─────────────────────────────────────────────────────────────────────────────

const REVISION_FIELDS = [
  'entityId', 'structureId', 'currencyCode', 'basis',
  'ctcAnnual', 'grossMonthly', 'effectiveFrom', 'effectiveTo',
  'revisionReason', 'approvalRequestId', 'notes',
];
const REVISION_DATES = ['effectiveFrom', 'effectiveTo'];
const pickRevision = picker(REVISION_FIELDS, REVISION_DATES);

// Resolve the target employee's Grade (for the band/compa-ratio view) via the
// current EmploymentRecord. Tenant-scoped; null when no grade is assigned.
async function resolveEmployeeGrade(businessId, employeeId) {
  const rec = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true, gradeId: { not: null } },
    select: { gradeId: true },
  });
  if (!rec || !rec.gradeId) return null;
  return prisma.grade.findFirst({
    where: { id: rec.gradeId, businessId },
    select: { id: true, bandId: true, minSalary: true, midSalary: true, maxSalary: true },
  });
}

// Shape a CompensationRevision row into the unmasked payload maskCompensation
// consumes (employeeId + absolute money + lines + delta).
function revisionPayload(rev, employeeId, priorCtc) {
  let deltaPct = null;
  if (priorCtc != null && priorCtc > 0 && rev.ctcAnnual != null) {
    const cur = toNum(rev.ctcAnnual);
    deltaPct = Math.round(((cur - priorCtc) / priorCtc) * 10000) / 100;
  }
  return {
    id: rev.id,
    employeeId,
    effectiveFrom: rev.effectiveFrom,
    effectiveTo: rev.effectiveTo,
    isCurrent: rev.isCurrent,
    status: rev.status,
    revisionReason: rev.revisionReason,
    ctcAnnual: rev.ctcAnnual,
    grossMonthly: rev.grossMonthly,
    netMonthly: rev.netMonthly != null ? rev.netMonthly : null,
    lines: rev.lines || [],
    delta: deltaPct != null ? { pct: deltaPct } : undefined,
    letterEnvelopeId: rev.letterEnvelopeId || null,
  };
}

const revisions = {
  // List the compensation history for one employee (newest effective first).
  // EVERY row is masked per the viewer's compVisibility × scope band; the read
  // is audited (compensation.read). No 403 leak — out-of-scope is a 404 upstream
  // (withEmployeeScope); a granted viewer without ABSOLUTE gets RANGE_ONLY rows.
  list: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { employeeId } = req.params;
      const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
      if (!emp) return res.status(404).json({ message: 'Employee not found' });

      const rows = await prisma.compensationRevision.findMany({
        where: { businessId, employeeId },
        orderBy: { effectiveFrom: 'desc' },
        include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
      });

      const grade = await resolveEmployeeGrade(businessId, employeeId);
      const viewer = { ...req.user, employeeId: req.user.employeeId };
      // Build delta against the chronologically-prior revision.
      const chron = rows.slice().sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom));
      const priorByEff = new Map();
      let prev = null;
      for (const r of chron) { priorByEff.set(r.id, prev ? toNum(prev.ctcAnnual) : null); prev = r; }

      const items = rows.map((r) => maskCompensation(
        revisionPayload(r, employeeId, priorByEff.get(r.id)),
        viewer,
        { grade, target: { employeeId } },
      ));
      const visibility = items.length ? items[0].visibility : effectiveCompVisibility(viewer);
      auditRead({ businessId, actorId: req.user.id, employeeId, visibility, fields: 'revisions' });
      res.json({ items, visibility });
    } catch (e) { next(e); }
  },

  // Create a new effective-dated revision. Supersedes the prior current revision
  // (closes its effectiveTo to the day before, flips isCurrent=false). Optionally
  // seeds component lines, and — when amounts are present — enforces the India
  // Code on Wages 50% floor (Basic+DA >= 50% of gross).
  create: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { employeeId } = req.params;
      const { entityId, currencyCode, basis, effectiveFrom, revisionReason } = req.body;
      if (!entityId || !currencyCode || !basis || !effectiveFrom || !revisionReason) {
        return res.status(400).json({ message: 'entityId, currencyCode, basis, effectiveFrom and revisionReason are required' });
      }

      const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
      if (!emp) return res.status(404).json({ message: 'Employee not found' });

      const effFrom = new Date(effectiveFrom);
      if (Number.isNaN(effFrom.getTime())) {
        return res.status(400).json({ message: 'effectiveFrom is not a valid date' });
      }

      // Build + validate the nested lines before opening the transaction so a
      // rule violation never leaves a partial supersession behind.
      let lineCreates = null;
      if (Array.isArray(req.body.lines) && req.body.lines.length) {
        const lines = req.body.lines;
        for (const l of lines) {
          if (!l || !l.componentId || !l.calcMethod) {
            return res.status(400).json({ message: 'each line requires componentId and calcMethod' });
          }
        }
        // Resolve the referenced components (tenant-scoped) so we can classify
        // wages vs gross for the 50% rule and reject foreign/unknown components.
        const componentIds = [...new Set(lines.map((l) => l.componentId))];
        const comps = await prisma.salaryComponent.findMany({
          where: { id: { in: componentIds }, businessId, deletedAt: null },
        });
        const byId = new Map(comps.map((c) => [c.id, c]));
        if (byId.size !== componentIds.length) {
          return res.status(400).json({ message: 'one or more componentId values are invalid for this tenant' });
        }
        // India Code-on-Wages 50% rule (Basic+DA >= 50% of gross). CONSOLIDATED
        // engine-backed guard: fail-closed, integer paise, effective-dated,
        // country-gated (skipped for NZ). Runs on the DERIVED line amounts.
        const cc = (req.body.countryCode || emp.countryCode || (basis === 'CTC' ? 'IN' : '')).toUpperCase();
        const wage = validateWages50(
          lines.map((l) => ({ amountMonthly: l.amountMonthly, calcValue: l.calcValue, component: byId.get(l.componentId) })),
          { countryCode: cc, asOf: effectiveFrom },
        );
        if (wage.applies && !wage.ok) {
          return res.status(400).json({
            error: 'WAGES_50_RULE',
            message: 'Basic + DA must be at least 50% of gross (India Code on Wages, 2019).',
            wages: wage.wages,
            gross: wage.gross,
          });
        }
        lineCreates = lines.map((l) => ({ ...pickLine(l), businessId }));
      }

      // Feature 5 — maker-checker status machine. A maker without
      // canApproveCompensation writes PROPOSED (SoD: proposedById=self); the
      // existing direct-write path (programmatic / a full canManage operator that
      // also approves) may write EFFECTIVE directly. Default keeps back-compat.
      const wantsPropose = req.body.status === 'PROPOSED' || req.body.propose === true;
      const status = wantsPropose ? 'PROPOSED' : (req.body.status || 'EFFECTIVE');
      const makeCurrent = status === 'EFFECTIVE';

      const data = {
        ...pickRevision(req.body),
        businessId,
        employeeId,
        isCurrent: makeCurrent,
        status,
        proposedById: status === 'PROPOSED' ? req.user.id : (req.body.proposedById || null),
      };
      if (lineCreates) data.lines = { create: lineCreates };

      // Supersede + insert atomically. ONLY an EFFECTIVE revision supersedes the
      // prior current one (a PROPOSED draft must NOT close out live pay). A new
      // revision with the same effectiveFrom collides on the unique key → 409.
      const created = await prisma.$transaction(async (tx) => {
        if (makeCurrent) {
          const prior = await tx.compensationRevision.findFirst({
            where: { businessId, employeeId, isCurrent: true },
            orderBy: { effectiveFrom: 'desc' },
          });
          if (prior) {
            const closeAt = new Date(effFrom);
            closeAt.setUTCDate(closeAt.getUTCDate() - 1);
            if (prior.effectiveFrom < effFrom) {
              await tx.compensationRevision.update({
                where: { id: prior.id },
                data: { isCurrent: false, effectiveTo: closeAt },
              });
            } else {
              await tx.compensationRevision.update({ where: { id: prior.id }, data: { isCurrent: false } });
            }
          }
        }
        return tx.compensationRevision.create({
          data,
          include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
        });
      });

      // Sensitive action — audit the compensation change (best-effort).
      await writeAudit({
        businessId,
        actorId: req.user.id,
        action: 'compensation.change',
        entityType: 'CompensationRevision',
        entityId: created.id,
        meta: {
          employeeId,
          entityId,
          effectiveFrom,
          revisionReason,
          status,
          ctcAnnual: req.body.ctcAnnual ?? null,
          grossMonthly: req.body.grossMonthly ?? null,
        },
      });

      res.status(201).json(created);
    } catch (e) {
      if (e.code === 'P2002') {
        return res.status(409).json({ message: 'A revision with that effectiveFrom already exists for this employee' });
      }
      next(e);
    }
  },

  // ── Maker-checker: approve a PROPOSED revision → EFFECTIVE (SoD fail-closed). ──
  // The checker (canApproveCompensation) commits; self-approval is rejected
  // 409 SOD_SELF_APPROVAL, mirroring the F4 lifecycle pattern. On commit the
  // prior current revision is superseded and isCurrent flips to the approved one.
  approve: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { id } = req.params;
      const rev = await prisma.compensationRevision.findFirst({ where: { id, businessId } });
      if (!rev) return res.status(404).json({ message: 'Revision not found' });
      if (rev.status !== 'PROPOSED') {
        return res.status(409).json({ error: 'BAD_STATE', message: `Revision is ${rev.status}, not PROPOSED` });
      }
      // FAIL-CLOSED SoD: the approver must differ from the proposer. A null
      // proposer is unsafe (cannot prove separation) → reject.
      if (!rev.proposedById || rev.proposedById === req.user.id) {
        return res.status(409).json({
          error: 'SOD_SELF_APPROVAL',
          message: 'The approver must be different from the proposer (separation of duties).',
        });
      }
      const effFrom = new Date(rev.effectiveFrom);
      const committed = await prisma.$transaction(async (tx) => {
        const prior = await tx.compensationRevision.findFirst({
          where: { businessId, employeeId: rev.employeeId, isCurrent: true, id: { not: rev.id } },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (prior) {
          const closeAt = new Date(effFrom);
          closeAt.setUTCDate(closeAt.getUTCDate() - 1);
          await tx.compensationRevision.update({
            where: { id: prior.id },
            data: { isCurrent: false, effectiveTo: prior.effectiveFrom < effFrom ? closeAt : prior.effectiveTo },
          });
        }
        return tx.compensationRevision.update({
          where: { id: rev.id },
          data: { status: 'EFFECTIVE', isCurrent: true, approvedById: req.user.id, approvedAt: new Date() },
          include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
        });
      });
      await writeAudit({
        businessId, actorId: req.user.id, action: 'compensation.change',
        entityType: 'CompensationRevision', entityId: rev.id,
        meta: { employeeId: rev.employeeId, transition: 'PROPOSED→EFFECTIVE', approvedBy: req.user.id, proposedBy: rev.proposedById },
      });
      res.json(committed);
    } catch (e) { next(e); }
  },

  // Reject a PROPOSED revision → REJECTED (no supersession; live pay untouched).
  reject: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { id } = req.params;
      const rev = await prisma.compensationRevision.findFirst({ where: { id, businessId } });
      if (!rev) return res.status(404).json({ message: 'Revision not found' });
      if (rev.status !== 'PROPOSED') {
        return res.status(409).json({ error: 'BAD_STATE', message: `Revision is ${rev.status}, not PROPOSED` });
      }
      if (!rev.proposedById || rev.proposedById === req.user.id) {
        return res.status(409).json({ error: 'SOD_SELF_APPROVAL', message: 'The reviewer must differ from the proposer.' });
      }
      const updated = await prisma.compensationRevision.update({
        where: { id: rev.id },
        data: { status: 'REJECTED', isCurrent: false, approvedById: req.user.id, approvedAt: new Date() },
      });
      await writeAudit({
        businessId, actorId: req.user.id, action: 'compensation.change',
        entityType: 'CompensationRevision', entityId: rev.id,
        meta: { employeeId: rev.employeeId, transition: 'PROPOSED→REJECTED', reason: req.body.reason || null },
      });
      res.json(updated);
    } catch (e) { next(e); }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /structures/preview — PURE quote (no persistence). Wraps deriveBreakup +
// a single engine.computePayslip-equivalent reconciliation so the live builder
// renders the full waterfall (CTC → −employerCost → gross → −deductions → net),
// the BALANCING readout, and the India 50% verdict before commit. Backs the
// debounced builder preview. Requires canViewCompensation (read-only operators
// get a read-only builder, no 403).
// ─────────────────────────────────────────────────────────────────────────────
async function preview(req, res, next) {
  try {
    const { businessId } = req.user;
    const { basis, lines, target = {}, countryCode, asOf } = req.body || {};
    if (!basis || !Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ message: 'basis and a non-empty lines[] are required' });
    }
    // Resolve referenced components (tenant-scoped) so the preview reflects the
    // real component flags/kinds (and rejects foreign ids).
    const componentIds = [...new Set(lines.map((l) => l.componentId).filter(Boolean))];
    const comps = componentIds.length
      ? await prisma.salaryComponent.findMany({ where: { id: { in: componentIds }, businessId, deletedAt: null } })
      : [];
    const byId = new Map(comps.map((c) => [c.id, c]));
    if (byId.size !== componentIds.length) {
      return res.status(400).json({ message: 'one or more componentId values are invalid for this tenant' });
    }
    // Build the deriveBreakup line shape (component joined).
    const deriveLines = lines.map((l, i) => ({
      component: byId.get(l.componentId) || { code: l.code, kind: l.kind, category: l.category || 'EARNING', calcMethod: l.calcMethod, calcBaseCode: l.calcBaseCode, calcBaseScope: l.calcBaseScope, derivationPass: l.derivationPass },
      calcMethod: l.calcMethod,
      calcValue: l.calcValue,
      amountMonthly: l.amountMonthly,
      sortOrder: l.sortOrder != null ? l.sortOrder : i,
    }));
    const tgt = {};
    if (basis === 'CTC' && target.ctcAnnual != null) tgt.ctcAnnualMinor = toMinorSafe(target.ctcAnnual);
    else if (target.grossMonthly != null) tgt.grossMonthlyMinor = toMinorSafe(target.grossMonthly);
    else if (target.ctcAnnualMinor != null) tgt.ctcAnnualMinor = target.ctcAnnualMinor;
    else if (target.grossMonthlyMinor != null) tgt.grossMonthlyMinor = target.grossMonthlyMinor;

    let breakup;
    try {
      breakup = deriveBreakup({
        target: tgt, basis, lines: deriveLines,
        ctx: { countryCode: (countryCode || 'IN').toUpperCase(), asOf, esiApplicable: req.body.esiApplicable === true },
      });
    } catch (err) {
      if (err instanceof DeriveError) {
        return res.status(422).json({ error: err.code, message: err.message, ...err });
      }
      throw err;
    }
    res.json({
      basis,
      target: tgt,
      waterfall: {
        ctcAnnualMinor: tgt.ctcAnnualMinor != null ? tgt.ctcAnnualMinor : (breakup.targetGrossMinor + breakup.employerCost.monthlyMinor) * 12,
        employerCostMonthlyMinor: breakup.employerCost.monthlyMinor,
        grossMonthlyMinor: breakup.grossMinor,
      },
      resolved: breakup.resolved,
      employerCost: breakup.employerCost,
      basicDaMonthlyMinor: breakup.basicDaMonthlyMinor,
      wagesVerdict: breakup.wagesVerdict,
    });
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /me/compensation — self only (behind attachSelfEmployee). Bypasses
// canViewCompensation (you can always see your OWN pay) and resolves to
// SELF_ONLY. No `:id` path exists → cross-employee leakage is structurally
// impossible. Terminated-employee ESS lockout still applies (no active employee).
// ─────────────────────────────────────────────────────────────────────────────
async function meCompensation(req, res, next) {
  try {
    const { businessId } = req.user;
    const employeeId = req.user.employeeId;
    if (!employeeId) return res.status(404).json({ message: 'No employee record for this account' });
    const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
    if (!emp || emp.isActive === false) {
      return res.status(404).json({ message: 'No active employee record' });
    }
    const rows = await prisma.compensationRevision.findMany({
      where: { businessId, employeeId, status: { in: ['EFFECTIVE'] } },
      orderBy: { effectiveFrom: 'desc' },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
    });
    const current = rows.find((r) => r.isCurrent) || rows[0] || null;
    const viewer = { ...req.user, employeeId };
    const grade = await resolveEmployeeGrade(businessId, employeeId);

    let chronPrev = null;
    const chron = rows.slice().sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom));
    const priorByEff = new Map();
    for (const r of chron) { priorByEff.set(r.id, chronPrev ? toNum(chronPrev.ctcAnnual) : null); chronPrev = r; }

    const out = {
      current: current
        ? maskCompensation(revisionPayload(current, employeeId, priorByEff.get(current.id)), viewer, { grade, level: 'SELF_ONLY' })
        : null,
      history: rows.map((r) => maskCompensation(revisionPayload(r, employeeId, priorByEff.get(r.id)), viewer, { grade, level: 'SELF_ONLY' })),
    };
    auditRead({ businessId, actorId: req.user.id, employeeId, visibility: 'SELF_ONLY', fields: 'me/compensation' });
    res.json(out);
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ESS (customer session) — GET /api/hr/me/compensation. Resolves the employee
// from req.customer (email/user link, reused payroll resolver), returns the
// SELF_ONLY breakup + history + letters. No `:id` path → cross-employee leakage
// is structurally impossible. Terminated/inactive → 404 (ESS lockout).
// ─────────────────────────────────────────────────────────────────────────────
async function getMyCompensationEss(req, res, next) {
  try {
    const { businessId } = req.customer;
    const payrollService = require('../payroll/service');
    const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
    if (!employeeId) return res.status(404).json({ message: 'No employee record for this account' });
    const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
    if (!emp || emp.isActive === false) return res.status(404).json({ message: 'No active employee record' });

    const rows = await prisma.compensationRevision.findMany({
      where: { businessId, employeeId, status: { in: ['EFFECTIVE'] } },
      orderBy: { effectiveFrom: 'desc' },
      include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
    });
    const current = rows.find((r) => r.isCurrent) || rows[0] || null;
    // Self-view: a synthetic viewer whose employeeId === target → SELF_ONLY.
    const viewer = { employeeId, role: 'USER', businessRole: null };
    const grade = await resolveEmployeeGrade(businessId, employeeId);
    let prev = null;
    const chron = rows.slice().sort((a, b) => new Date(a.effectiveFrom) - new Date(b.effectiveFrom));
    const priorByEff = new Map();
    for (const r of chron) { priorByEff.set(r.id, prev ? toNum(prev.ctcAnnual) : null); prev = r; }

    const out = {
      current: current
        ? maskCompensation(revisionPayload(current, employeeId, priorByEff.get(current.id)), viewer, { grade, level: 'SELF_ONLY' })
        : null,
      history: rows.map((r) => maskCompensation(revisionPayload(r, employeeId, priorByEff.get(r.id)), viewer, { grade, level: 'SELF_ONLY' })),
    };
    auditRead({ businessId, actorId: req.customer.id, employeeId, visibility: 'SELF_ONLY', fields: 'ess/me/compensation' });
    res.json(out);
  } catch (e) { next(e); }
}

module.exports = { components, structures, revisions, preview, meCompensation, getMyCompensationEss, validateWages50 };
