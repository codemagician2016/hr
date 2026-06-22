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
// India Code on Wages, 2019 — "wages" floor rule.
// The sum of basic pay + dearness allowance (the statutory "wages") must be at
// least 50% of total remuneration (gross). Employers structuring CTC to push
// allowances above 50% to suppress PF/gratuity liability is disallowed.
//
// We can only validate when the caller supplies resolved component amounts. We
// classify a line as "wages" by the underlying component's kind (BASIC /
// DEARNESS_ALLOWANCE) and sum the monthly amounts; gross is the sum of all
// EARNING-category monthly amounts. Returns { ok, wages, gross } — ok is true
// when we lack the data to judge (fail-open; nothing to validate).
// ─────────────────────────────────────────────────────────────────────────────
const WAGE_KINDS = new Set(['BASIC', 'DEARNESS_ALLOWANCE']);

function validateWages50(linesWithComponent) {
  let wages = 0;
  let gross = 0;
  let sawEarning = false;
  for (const line of linesWithComponent) {
    const comp = line.component || {};
    const amt = toNum(line.amountMonthly);
    if (comp.category === 'EARNING') {
      sawEarning = true;
      gross += amt;
      if (WAGE_KINDS.has(comp.kind)) wages += amt;
    }
  }
  // Nothing resolved to judge against → fail-open (rule not applicable here).
  if (!sawEarning || gross <= 0) return { ok: true, wages, gross };
  return { ok: wages >= gross * 0.5, wages, gross };
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

const revisions = {
  // List the compensation history for one employee (newest effective first).
  list: async (req, res, next) => {
    try {
      const { businessId } = req.user;
      const { employeeId } = req.params;
      const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
      if (!emp) return res.status(404).json({ message: 'Employee not found' });

      const items = await prisma.compensationRevision.findMany({
        where: { businessId, employeeId },
        orderBy: { effectiveFrom: 'desc' },
        include: { lines: { orderBy: { sortOrder: 'asc' }, include: { component: true } } },
      });
      res.json({ items });
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
        // India Code-on-Wages 50% rule (Basic+DA >= 50% of gross). Only enforced
        // when resolved monthly amounts are supplied on the lines.
        const wage = validateWages50(lines.map((l) => ({ amountMonthly: l.amountMonthly, component: byId.get(l.componentId) })));
        if (!wage.ok) {
          return res.status(400).json({
            error: 'WAGES_50_RULE',
            message: 'Basic + DA must be at least 50% of gross (India Code on Wages, 2019).',
            wages: wage.wages,
            gross: wage.gross,
          });
        }
        lineCreates = lines.map((l) => ({ ...pickLine(l), businessId }));
      }

      const data = { ...pickRevision(req.body), businessId, employeeId, isCurrent: true };
      if (lineCreates) data.lines = { create: lineCreates };

      // Supersede + insert atomically. The prior current revision (if any) is
      // closed the day before the new one takes effect; a new revision with the
      // same effectiveFrom collides on the unique key → 409.
      const created = await prisma.$transaction(async (tx) => {
        const prior = await tx.compensationRevision.findFirst({
          where: { businessId, employeeId, isCurrent: true },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (prior) {
          const closeAt = new Date(effFrom);
          closeAt.setUTCDate(closeAt.getUTCDate() - 1);
          // Only auto-close a prior whose window actually precedes the new one.
          if (prior.effectiveFrom < effFrom) {
            await tx.compensationRevision.update({
              where: { id: prior.id },
              data: { isCurrent: false, effectiveTo: closeAt },
            });
          } else {
            await tx.compensationRevision.update({ where: { id: prior.id }, data: { isCurrent: false } });
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
};

module.exports = { components, structures, revisions, validateWages50 };
