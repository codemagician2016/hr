'use strict';
// HR org-structure CRUD: Entity (legal/payroll unit), Location (work-site),
// Department (tree), Designation, Grade, Band. Every query is tenant-scoped by
// req.user.businessId and uses soft-delete (deletedAt). A small CRUD factory
// keeps the six resources consistent; bespoke logic lives in employee.controller.
const prisma = require('../../core/lib/prisma');
const orgTree = require('../lib/orgTree');
const { resolveAccessibleEmployeeIds, scopeAllows } = require('../lib/scopeResolver');

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
        photoUrl: true, // FLAG (Feature 13): org card is Photo | Name | Position
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
        photoUrl: e.photoUrl || null,
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
    // Feature 19 — soft-cap the whole-tree reader so an OLD client degrades gracefully
    // instead of OOMing at 1000+. The redesigned client uses the lazy /tree/roots API;
    // for a small tenant the legacy nested forest is still returned as-is.
    if (employees.length > 500) {
      return res.json({ items: roots, root: null, truncated: true, total: employees.length, hint: 'use /api/hr/org/tree/roots (lazy)' });
    }
    res.json({ items: roots, root: null });
  } catch (e) {
    next(e);
  }
}

// ── Feature 19 — lazy per-node org-tree (operator session) ───────────────────
// Scope is the F1 band resolved ONCE here (resolveAccessibleEmployeeIds over
// canViewEmployees) and handed to the shared orgTree lib. A manager band is an
// IDS scope clamped to their own sub-tree; an Owner/HR-Admin is ALL. Every :id is
// re-validated with scopeAllows → 404 out-of-scope (IDOR-safe, identical to F1
// withEmployeeScope). The hierarchy anchor (req.user.employeeId) seeds ?root=me.

async function resolveOperatorScope(req) {
  const scope = await resolveAccessibleEmployeeIds(req.user, 'canViewEmployees');
  return { scope, selfId: req.user.employeeId || null };
}

// GET /org/tree/roots?cursor&limit&root=<id>
// Tenant roots (scope-clamped). An admin may re-root the viewport at any in-scope
// node via ?root=<id> (validated by scopeAllows). A manager (IDS) gets their own
// node as the single root regardless.
async function treeRoots(req, res, next) {
  try {
    const { businessId } = req.user;
    const { scope, selfId } = await resolveOperatorScope(req);
    const rootId = req.query.root && req.query.root !== 'me' ? String(req.query.root) : null;
    if (rootId && !scopeAllows(scope, rootId)) return res.status(404).json({ message: 'Not found' });
    const out = await orgTree.getRoots({
      businessId, scope, cursor: req.query.cursor, limit: req.query.limit, rootId, isSelfId: selfId,
    });
    res.json(out);
  } catch (e) { next(e); }
}

// GET /org/tree/nodes/:id/children?cursor&limit
async function treeChildren(req, res, next) {
  try {
    const { businessId } = req.user;
    const { scope, selfId } = await resolveOperatorScope(req);
    if (!scopeAllows(scope, req.params.id)) return res.status(404).json({ message: 'Not found' });
    const out = await orgTree.getChildren({
      businessId, scope, parentId: req.params.id, cursor: req.query.cursor, limit: req.query.limit, isSelfId: selfId,
    });
    res.json(out);
  } catch (e) { next(e); }
}

// GET /org/tree/nodes/:id/ancestors
async function treeAncestors(req, res, next) {
  try {
    const { businessId } = req.user;
    const { scope, selfId } = await resolveOperatorScope(req);
    if (!scopeAllows(scope, req.params.id)) return res.status(404).json({ message: 'Not found' });
    const out = await orgTree.getAncestors({ businessId, scope, nodeId: req.params.id, isSelfId: selfId });
    res.json(out);
  } catch (e) { next(e); }
}

// GET /org/tree/search?q&limit
async function treeSearch(req, res, next) {
  try {
    const { businessId } = req.user;
    const { scope, selfId } = await resolveOperatorScope(req);
    const out = await orgTree.searchNodes({ businessId, scope, q: req.query.q, limit: req.query.limit, isSelfId: selfId });
    res.json(out);
  } catch (e) { next(e); }
}

module.exports = {
  tree,
  // Feature 19 — lazy per-node org-tree (operator session)
  treeRoots,
  treeChildren,
  treeAncestors,
  treeSearch,
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
