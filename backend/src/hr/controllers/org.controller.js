'use strict';
// HR org-structure CRUD: Entity (legal/payroll unit), Location (work-site),
// Department (tree), Designation, Grade, Band. Every query is tenant-scoped by
// req.user.businessId and uses soft-delete (deletedAt). A small CRUD factory
// keeps the six resources consistent; bespoke logic lives in employee.controller.
const prisma = require('../../core/lib/prisma');

/**
 * Build a tenant-scoped CRUD handler set for a Prisma model.
 * @param {string} model       Prisma delegate name (e.g. 'entity')
 * @param {object} cfg
 * @param {string[]} cfg.fields    assignable fields (allow-list — never trust the body wholesale)
 * @param {string[]} cfg.required  fields validated as present on create
 * @param {string[]} cfg.dates     fields coerced to Date
 * @param {function} [cfg.defaultsFn] (body) => defaults applied before the body
 */
function crud(model, { fields = [], required = [], dates = [], defaultsFn = null } = {}) {
  const pick = (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    for (const d of dates) if (out[d] != null) out[d] = new Date(out[d]);
    return out;
  };
  const dup = (res) => res.status(409).json({ message: 'A record with that code already exists' });

  return {
    list: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const items = await prisma[model].findMany({
          where: { businessId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        });
        res.json({ items });
      } catch (e) { next(e); }
    },
    get: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const item = await prisma[model].findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
        if (!item) return res.status(404).json({ message: 'Not found' });
        res.json(item);
      } catch (e) { next(e); }
    },
    create: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        for (const r of required) {
          if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
            return res.status(400).json({ message: `${r} is required` });
          }
        }
        const data = { ...(defaultsFn ? defaultsFn(req.body) : {}), ...pick(req.body), businessId };
        const item = await prisma[model].create({ data });
        res.status(201).json(item);
      } catch (e) { if (e.code === 'P2002') return dup(res); next(e); }
    },
    update: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const existing = await prisma[model].findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
        if (!existing) return res.status(404).json({ message: 'Not found' });
        const item = await prisma[model].update({ where: { id: req.params.id }, data: pick(req.body) });
        res.json(item);
      } catch (e) { if (e.code === 'P2002') return dup(res); next(e); }
    },
    remove: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const existing = await prisma[model].findFirst({ where: { id: req.params.id, businessId, deletedAt: null } });
        if (!existing) return res.status(404).json({ message: 'Not found' });
        await prisma[model].update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
        res.status(204).end();
      } catch (e) { next(e); }
    },
  };
}

// GET /api/hr/org/tree (optional ?root=me) — the manager→reports hierarchy as
// nested nodes, built from Employee.managerEmployeeId. Tenant-scoped, current
// employees only. Designation/department come from the current EmploymentRecord
// segment (effective-dated). ?root=me roots the tree at the caller's own
// Employee (attachSelfEmployee has set req.user.employeeId). Without root=me the
// tree is the full forest: every employee with no (in-scope) manager is a root.
async function tree(req, res, next) {
  try {
    const { businessId } = req.user;
    const rootMe = req.query.root === 'me';
    const selfId = req.user.employeeId || null;

    if (rootMe && !selfId) {
      // Caller is not linked to an Employee — nothing to root at.
      return res.json({ items: [], root: null });
    }

    const employees = await prisma.employee.findMany({
      where: { businessId, deletedAt: null },
      select: {
        id: true,
        code: true,
        firstName: true,
        lastName: true,
        managerEmployeeId: true,
        employmentRecords: {
          where: { isCurrent: true },
          take: 1,
          orderBy: { effectiveFrom: 'desc' },
          select: {
            designation: { select: { title: true } },
            department: { select: { name: true } },
          },
        },
      },
      orderBy: [{ firstName: 'asc' }, { code: 'asc' }],
    });

    // Build bare nodes keyed by id.
    const nodeById = new Map();
    for (const e of employees) {
      const rec = e.employmentRecords && e.employmentRecords[0];
      const name = [e.firstName, e.lastName].filter(Boolean).join(' ') || e.code;
      nodeById.set(e.id, {
        id: e.id,
        code: e.code,
        name,
        designation: rec && rec.designation ? rec.designation.title : null,
        departmentName: rec && rec.department ? rec.department.name : null,
        managerEmployeeId: e.managerEmployeeId,
        reportsCount: 0,
        children: [],
      });
    }

    // Link children to parents. A node whose manager is missing from the set
    // (terminated/out-of-tenant) is treated as a root.
    const roots = [];
    for (const node of nodeById.values()) {
      const parent = node.managerEmployeeId ? nodeById.get(node.managerEmployeeId) : null;
      if (parent) {
        parent.children.push(node);
        parent.reportsCount += 1;
      } else {
        roots.push(node);
      }
    }

    if (rootMe) {
      const me = nodeById.get(selfId) || null;
      return res.json({ items: me ? [me] : [], root: selfId });
    }
    res.json({ items: roots, root: null });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  tree,
  entities: crud('entity', {
    fields: ['code', 'legalName', 'tradeName', 'countryCode', 'payCurrency', 'timezone', 'taxYearStartMonth',
      'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode',
      'pan', 'tan', 'gstin', 'cin', 'nzbn', 'irdEntityNumber', 'status', 'activeFrom', 'activeTo'],
    required: ['code', 'legalName', 'countryCode', 'payCurrency', 'timezone'],
    dates: ['activeFrom', 'activeTo'],
    defaultsFn: () => ({ activeFrom: new Date() }),
  }),
  locations: crud('location', {
    fields: ['entityId', 'code', 'name', 'addressLine1', 'city', 'stateCode', 'postalCode', 'countryCode', 'timezone',
      'geoLat', 'geoLng', 'geofenceM', 'ptRegistrationId', 'accClassUnit', 'isPrimary', 'isActive'],
    required: ['entityId', 'code', 'name', 'countryCode', 'timezone'],
  }),
  departments: crud('department', {
    fields: ['code', 'name', 'parentId', 'headEmployeeId', 'costCenter', 'isActive'],
    required: ['code', 'name'],
  }),
  designations: crud('designation', {
    fields: ['code', 'title', 'gradeId', 'isActive'],
    required: ['code', 'title'],
  }),
  grades: crud('grade', {
    fields: ['code', 'name', 'rank', 'bandId', 'minSalary', 'maxSalary', 'currencyCode', 'isActive'],
    required: ['code', 'name', 'rank'],
  }),
  bands: crud('band', {
    fields: ['code', 'name', 'isActive'],
    required: ['code', 'name'],
  }),
};
