'use strict';

/**
 * rbac.controller.js — Feature 10 §7.4 user-friendly RBAC + hierarchy surface.
 * Mounted at /api/hr/rbac/* (operator session). A FRIENDLIER surface over the
 * existing rbac.js catalog + BusinessRole + HrRolePermissionGrant +
 * Employee.managerEmployeeId — NO parallel RBAC system.
 *
 *   GET    /rbac/permissions            catalog (PERMISSIONS) for the role builder
 *   GET    /rbac/roles                  list BusinessRoles (+ grants)
 *   POST   /rbac/roles                  create a custom role (clone-and-edit a preset)
 *   PUT    /rbac/roles/:id              edit a custom role (isSystem = clone-only)
 *   DELETE /rbac/roles/:id              delete a custom role (guards: in-use, system)
 *   POST   /rbac/roles/:id/grants       add an entity-scoped/time-bound grant
 *   GET    /rbac/org-tree               the reporting tree (recursive CTE)
 *   PATCH  /rbac/employees/:id          re-parent in the tree (cycle-guarded)
 *   POST   /rbac/employees/:id/assign-role   set a person's businessRoleId
 *
 * Gates are applied in the route file (canManageRoles / canManageHierarchy /
 * canViewEmployees). Every query is tenant-scoped; a cross-tenant id ⇒ 404.
 */

const prisma = require('../../core/lib/prisma');
const { PERMISSIONS, validatePermissions } = require('../../core/lib/rbac');

const SCOPE_BANDS = new Set(['NONE', 'SELF', 'TEAM', 'DEPARTMENT', 'ALL']);
const COMP_VIS = new Set(['ABSOLUTE', 'RANGE_ONLY', 'SELF_ONLY', 'NONE']);

function bad(res, message) { return res.status(400).json({ message }); }

// ── GET /rbac/permissions — the catalog (key → plain-English description) ────────
async function listPermissions(req, res, next) {
  try {
    const items = Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description }));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// ── Roles ────────────────────────────────────────────────────────────────────────
async function listRoles(req, res, next) {
  try {
    const { businessId } = req.user;
    const roles = await prisma.businessRole.findMany({
      where: { businessId },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: {
        hrPermissionGrants: { select: { id: true, permissionKey: true, entityId: true, expiresAt: true } },
        _count: { select: { members: true } },
      },
    });
    res.json({ items: roles, total: roles.length });
  } catch (e) { next(e); }
}

async function createRole(req, res, next) {
  try {
    const { businessId } = req.user;
    const { name, permissions, defaultScope, compVisibility } = req.body || {};
    if (!name || typeof name !== 'string') return bad(res, 'name is required');
    const perms = permissions || {};
    const v = validatePermissions(perms);
    if (!v.ok) return bad(res, v.error);
    if (defaultScope && !SCOPE_BANDS.has(defaultScope)) return bad(res, `defaultScope must be one of ${[...SCOPE_BANDS].join('/')}`);
    if (compVisibility && !COMP_VIS.has(compVisibility)) return bad(res, `compVisibility must be one of ${[...COMP_VIS].join('/')}`);
    const dup = await prisma.businessRole.findFirst({ where: { businessId, name }, select: { id: true } });
    if (dup) return res.status(409).json({ message: `A role named "${name}" already exists` });
    const role = await prisma.businessRole.create({
      data: {
        businessId, name, permissions: perms, isSystem: false,
        defaultScope: defaultScope || 'SELF', compVisibility: compVisibility || 'NONE',
      },
    });
    res.status(201).json(role);
  } catch (e) { next(e); }
}

async function updateRole(req, res, next) {
  try {
    const { businessId } = req.user;
    const role = await prisma.businessRole.findFirst({ where: { id: req.params.id, businessId } });
    if (!role) return res.status(404).json({ message: 'Not found' });
    // §9.9 — system roles are immutable (clone-to-edit). Reject in-place edits.
    if (role.isSystem) return res.status(403).json({ message: 'System roles are clone-to-edit; create a custom role instead' });
    const { name, permissions, defaultScope, compVisibility } = req.body || {};
    if (permissions !== undefined) {
      const v = validatePermissions(permissions);
      if (!v.ok) return bad(res, v.error);
    }
    if (defaultScope && !SCOPE_BANDS.has(defaultScope)) return bad(res, 'bad defaultScope');
    if (compVisibility && !COMP_VIS.has(compVisibility)) return bad(res, 'bad compVisibility');

    // Lockout guard (§9.9): the caller cannot strip canManageRoles from the very role
    // they are using to make this change (would lock themselves out).
    if (permissions !== undefined && req.user.businessRoleId === role.id && permissions.canManageRoles !== true) {
      return res.status(400).json({ message: 'You cannot remove canManageRoles from the role you are currently using' });
    }
    const updated = await prisma.businessRole.update({
      where: { id: role.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(permissions !== undefined ? { permissions } : {}),
        ...(defaultScope !== undefined ? { defaultScope } : {}),
        ...(compVisibility !== undefined ? { compVisibility } : {}),
      },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

async function deleteRole(req, res, next) {
  try {
    const { businessId } = req.user;
    const role = await prisma.businessRole.findFirst({ where: { id: req.params.id, businessId }, include: { _count: { select: { members: true } } } });
    if (!role) return res.status(404).json({ message: 'Not found' });
    if (role.isSystem) return res.status(403).json({ message: 'System roles cannot be deleted' });
    if (req.user.businessRoleId === role.id) return res.status(400).json({ message: 'You cannot delete the role you are currently using' });
    if (role._count.members > 0) return res.status(409).json({ message: `Role is assigned to ${role._count.members} user(s); reassign them first` });
    await prisma.businessRole.delete({ where: { id: role.id } });
    res.json({ ok: true, id: role.id });
  } catch (e) { next(e); }
}

// POST /rbac/roles/:id/grants — entity-scoped/time-bound HrRolePermissionGrant.
async function addGrant(req, res, next) {
  try {
    const { businessId } = req.user;
    const role = await prisma.businessRole.findFirst({ where: { id: req.params.id, businessId }, select: { id: true } });
    if (!role) return res.status(404).json({ message: 'Not found' });
    const { permissionKey, entityId, expiresAt } = req.body || {};
    if (!permissionKey) return bad(res, 'permissionKey is required');
    if (!(permissionKey in PERMISSIONS)) return bad(res, `Unknown permission "${permissionKey}"`);
    let exp = null;
    if (expiresAt) { exp = new Date(expiresAt); if (Number.isNaN(exp.getTime())) return bad(res, 'expiresAt must be a valid date'); }
    if (entityId) {
      const ent = await prisma.entity.findFirst({ where: { id: entityId, businessId }, select: { id: true } });
      if (!ent) return res.status(404).json({ message: 'entity not found in this tenant' });
    }
    const grant = await prisma.hrRolePermissionGrant.upsert({
      where: { roleId_permissionKey_entityId: { roleId: role.id, permissionKey, entityId: entityId || null } },
      update: { expiresAt: exp },
      create: { businessId, roleId: role.id, permissionKey, entityId: entityId || null, expiresAt: exp },
    });
    res.status(201).json(grant);
  } catch (e) { next(e); }
}

// ── GET /rbac/org-tree — the reporting tree (recursive CTE; reuses the F1 shape) ─
async function orgTree(req, res, next) {
  try {
    const { businessId } = req.user;
    const rows = await prisma.$queryRaw`
      WITH RECURSIVE tree AS (
        SELECT e.id, e."managerEmployeeId", 0 AS depth
          FROM "Employee" e
          WHERE e."businessId" = ${businessId} AND e."deletedAt" IS NULL AND e."managerEmployeeId" IS NULL
        UNION ALL
        SELECT e.id, e."managerEmployeeId", t.depth + 1
          FROM "Employee" e
          JOIN tree t ON e."managerEmployeeId" = t.id
          WHERE e."businessId" = ${businessId} AND e."deletedAt" IS NULL AND t.depth < 64
      )
      SELECT t.id, t."managerEmployeeId", t.depth,
             e."firstName", e."lastName", e."code", e."status", u."businessRoleId"
        FROM tree t
        JOIN "Employee" e ON e.id = t.id
        LEFT JOIN "User" u ON u.id = e."userId"
        ORDER BY t.depth ASC, e."lastName" ASC`;
    // Also surface employees with NO manager that are not roots-in-tree (orphans):
    const all = await prisma.employee.findMany({
      where: { businessId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, code: true, status: true, managerEmployeeId: true, userId: true },
    });
    const inTree = new Set(rows.map((r) => r.id));
    const orphans = all.filter((e) => !inTree.has(e.id));
    const flatMode = all.length > 0 && all.every((e) => !e.managerEmployeeId);
    res.json({
      nodes: rows.map((r) => ({
        id: r.id, managerEmployeeId: r.managerEmployeeId, depth: Number(r.depth),
        name: `${r.firstName} ${r.lastName}`.trim(), code: r.code, status: r.status, businessRoleId: r.businessRoleId,
      })),
      orphans: orphans.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`.trim(), code: e.code, status: e.status })),
      flatMode, // a tenant with no reporting structure at all → builder shows the flat-mode banner
      total: all.length,
    });
  } catch (e) { next(e); }
}

// Cycle guard (mirrors employee.controller#detectReportingCycle).
async function detectReportingCycle(tx, { businessId, employeeId, proposedManagerId }) {
  let cursor = proposedManagerId;
  const seen = new Set([employeeId]);
  for (let i = 0; i < 1000 && cursor; i += 1) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const mgr = await tx.employee.findFirst({ where: { id: cursor, businessId, deletedAt: null }, select: { managerEmployeeId: true } });
    if (!mgr) return false;
    cursor = mgr.managerEmployeeId;
  }
  return false;
}

// PATCH /rbac/employees/:id { managerEmployeeId } — re-parent in the tree. Same
// cycle guard + in-tenant validation as the employee controller, but gated by
// canManageHierarchy (the org-editor key) instead of canManageEmployees.
async function reparent(req, res, next) {
  try {
    const { businessId } = req.user;
    const id = req.params.id;
    const emp = await prisma.employee.findFirst({ where: { id, businessId, deletedAt: null }, select: { id: true } });
    if (!emp) return res.status(404).json({ message: 'Employee not found' });
    if (!('managerEmployeeId' in (req.body || {}))) return bad(res, 'managerEmployeeId is required (null to detach)');
    const proposed = req.body.managerEmployeeId || null;
    if (proposed) {
      if (proposed === id) return res.status(400).json({ message: 'An employee cannot report to themselves.' });
      const mgr = await prisma.employee.findFirst({ where: { id: proposed, businessId, deletedAt: null }, select: { id: true } });
      if (!mgr) return res.status(404).json({ message: 'Proposed manager not found in this tenant' });
      const loops = await prisma.$transaction((tx) => detectReportingCycle(tx, { businessId, employeeId: id, proposedManagerId: proposed }));
      if (loops) return res.status(400).json({ message: 'reporting loop: that manager already reports (directly or indirectly) to this employee.' });
    }
    const updated = await prisma.employee.update({
      where: { id }, data: { managerEmployeeId: proposed, version: { increment: 1 } },
      select: { id: true, managerEmployeeId: true, firstName: true, lastName: true },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// POST /rbac/employees/:id/assign-role { businessRoleId } — set a person's role.
async function assignRole(req, res, next) {
  try {
    const { businessId } = req.user;
    const emp = await prisma.employee.findFirst({ where: { id: req.params.id, businessId, deletedAt: null }, select: { id: true, userId: true } });
    if (!emp) return res.status(404).json({ message: 'Employee not found' });
    if (!emp.userId) return res.status(400).json({ message: 'This employee has no portal user to assign a role to' });
    const { businessRoleId } = req.body || {};
    if (businessRoleId) {
      const role = await prisma.businessRole.findFirst({ where: { id: businessRoleId, businessId }, select: { id: true } });
      if (!role) return res.status(404).json({ message: 'Role not found in this tenant' });
    }
    const user = await prisma.user.update({
      where: { id: emp.userId },
      data: { businessRoleId: businessRoleId || null },
      select: { id: true, businessRoleId: true },
    });
    res.json({ employeeId: emp.id, userId: user.id, businessRoleId: user.businessRoleId });
  } catch (e) { next(e); }
}

module.exports = {
  listPermissions,
  listRoles, createRole, updateRole, deleteRole, addGrant,
  orgTree, reparent, assignRole,
};
