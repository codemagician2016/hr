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
const {
  PERMISSIONS, PERMISSION_KEYS, validatePermissions,
  effectivePermissions, effectiveScope,
} = require('../../core/lib/rbac');
const { ROLES } = require('../../core/lib/roles');

const SCOPE_BANDS = new Set(['NONE', 'SELF', 'TEAM', 'DEPARTMENT', 'ALL']);
const COMP_VIS = new Set(['ABSOLUTE', 'RANGE_ONLY', 'SELF_ONLY', 'NONE']);

// Scope bands, widest → narrowest. Index = breadth rank (0 = widest = ALL).
const SCOPE_ORDER = ['ALL', 'DEPARTMENT', 'TEAM', 'SELF', 'NONE'];
function scopeRank(band) {
  const i = SCOPE_ORDER.indexOf(band || 'SELF');
  return i === -1 ? SCOPE_ORDER.indexOf('SELF') : i; // unknown ⇒ treat as SELF (narrow)
}
// True when `candidate` is no broader than `cap` (i.e. its rank is ≥ cap's rank).
function scopeWithin(candidate, cap) {
  return scopeRank(candidate) >= scopeRank(cap);
}

// §7.4 privilege-escalation guard. Keys that hand out money-movement / tenant-control
// authority are Owner-only to GRANT — a canManageRoles holder who is not the Owner
// (all-keys) may never mint/assign them, even if they somehow hold the key themselves.
const OWNER_ONLY_GRANT_KEYS = Object.freeze([
  'canApprovePayroll', 'canEditBilling', 'canEditDomain', 'canManageRoles',
]);

function bad(res, message) { return res.status(400).json({ message }); }
function forbid(res, message) { return res.status(403).json({ message }); }

// An "Owner-equivalent" caller holds EVERY permission key (the seeded Owner preset,
// SUPER_ADMIN, or any role ticking all keys). Only such a caller may grant the
// OWNER_ONLY_GRANT_KEYS and assign a role at least as privileged as themselves.
function isOwnerEquivalent(user) {
  if (!user) return false;
  if (user.role === ROLES.SUPER_ADMIN) return true;
  const perms = effectivePermissions(user) || {};
  return PERMISSION_KEYS.every((k) => perms[k] === true);
}

// Validate a requested permissions object against the caller's ceiling. Returns
// { ok, status, error } — caps granted keys to a SUBSET of the caller's own
// effective perms, and forces OWNER_ONLY keys to Owner-only callers.
function checkPermSubset(requestedPerms, user) {
  const owner = isOwnerEquivalent(user);
  const ceiling = effectivePermissions(user) || {};
  for (const [key, val] of Object.entries(requestedPerms || {})) {
    if (val !== true) continue; // only GRANTS (true) need a privilege check
    if (OWNER_ONLY_GRANT_KEYS.includes(key) && !owner) {
      return { ok: false, status: 403, error: `Only an Owner may grant "${key}"` };
    }
    if (!owner && ceiling[key] !== true) {
      return { ok: false, status: 403, error: `You cannot grant "${key}" — it is not among your own permissions` };
    }
  }
  return { ok: true };
}

// A role's effective permission set (custom roles carry their own JSON; the seeded
// system Owner row is all-true even when its JSON was trimmed).
function rolePerms(role) {
  if (role && role.isSystem && role.name === 'Owner') {
    return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true]));
  }
  if (role && role.permissions && typeof role.permissions === 'object') {
    return role.permissions;
  }
  return {};
}

// True when `role` grants at least one permission (or a broader scope, or an
// Owner-only key) that the caller does NOT themselves hold — i.e. assigning it
// would elevate the target above the caller. Owner-equivalent callers may grant
// anything, so this is only consulted for non-Owner callers.
function roleExceedsCaller(role, user) {
  const ceiling = effectivePermissions(user) || {};
  const owner = isOwnerEquivalent(user);
  const perms = rolePerms(role);
  for (const [key, val] of Object.entries(perms)) {
    if (val !== true) continue;
    if (OWNER_ONLY_GRANT_KEYS.includes(key) && !owner) return true;
    if (ceiling[key] !== true) return true;
  }
  // a role whose default data-scope is broader than the caller's own band also elevates.
  if (role && role.defaultScope && !scopeWithin(role.defaultScope, effectiveScope(user))) return true;
  return false;
}

// ── last-Owner / last-canManageRoles tenant invariant ──────────────────────────
// Count the active operator users in the tenant whose EFFECTIVE permissions include
// canManageRoles (the tenant-control key), EXCLUDING `excludeUserIds`. Refusing to
// drop this to zero prevents a permanent lockout. The exclude list lets a caller
// model "after I change these user(s)" before committing the write.
async function countManageRolesHoldersExcluding(businessId, excludeUserIds = []) {
  const exclude = new Set((excludeUserIds || []).filter(Boolean));
  const users = await prisma.user.findMany({
    where: { businessId, isActive: true },
    select: { id: true, role: true, businessRole: { select: { permissions: true, name: true, isSystem: true } } },
  });
  return users.filter((u) => {
    if (exclude.has(u.id)) return false;
    const perms = effectivePermissions(u);
    return !!(perms && perms.canManageRoles === true);
  }).length;
}

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
    // §7.4 privilege-escalation guard: a non-Owner canManageRoles holder may not mint
    // a role granting permissions they don't themselves hold, an Owner-only key, or a
    // data-scope broader than their own band.
    const sub = checkPermSubset(perms, req.user);
    if (!sub.ok) return forbid(res, sub.error);
    if (defaultScope && !isOwnerEquivalent(req.user) && !scopeWithin(defaultScope, effectiveScope(req.user))) {
      return forbid(res, `defaultScope "${defaultScope}" is broader than your own scope`);
    }
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
      // §7.4 privilege-escalation guard: cannot edit a role UP to permissions the
      // caller doesn't hold / an Owner-only key. Only newly-granted keys are checked.
      const sub = checkPermSubset(permissions, req.user);
      if (!sub.ok) return forbid(res, sub.error);
    }
    if (defaultScope && !SCOPE_BANDS.has(defaultScope)) return bad(res, 'bad defaultScope');
    if (compVisibility && !COMP_VIS.has(compVisibility)) return bad(res, 'bad compVisibility');
    if (defaultScope !== undefined && defaultScope && !isOwnerEquivalent(req.user)
        && !scopeWithin(defaultScope, effectiveScope(req.user))) {
      return forbid(res, `defaultScope "${defaultScope}" is broader than your own scope`);
    }

    // Lockout guard (§9.9): the caller cannot strip canManageRoles from the very role
    // they are using to make this change (would lock themselves out).
    if (permissions !== undefined && req.user.businessRoleId === role.id && permissions.canManageRoles !== true) {
      return res.status(400).json({ message: 'You cannot remove canManageRoles from the role you are currently using' });
    }

    // Last-Owner tenant invariant (§9.9): if this edit REMOVES canManageRoles from a
    // role that currently grants it, refuse when its members are the tenant's last
    // canManageRoles holders (would lock the whole tenant out).
    if (permissions !== undefined
        && rolePerms(role).canManageRoles === true
        && permissions.canManageRoles !== true) {
      const memberIds = (await prisma.user.findMany({
        where: { businessId, businessRoleId: role.id, isActive: true }, select: { id: true },
      })).map((u) => u.id);
      const remaining = await countManageRolesHoldersExcluding(businessId, memberIds);
      if (remaining === 0) {
        return res.status(400).json({ message: 'This change would remove the last canManageRoles holder from the tenant' });
      }
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
    // §7.4 privilege-escalation guard: an entity-scoped/time-bound grant is still a
    // grant — cap it to a key the caller holds (and Owner-only keys to the Owner).
    const sub = checkPermSubset({ [permissionKey]: true }, req.user);
    if (!sub.ok) return forbid(res, sub.error);
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

// DELETE /rbac/roles/:id/grants/:grantId — revoke an entity-scoped/time-bound grant
// early (before it auto-expires). Tenant-walled: a grant from another tenant ⇒ 404.
async function deleteGrant(req, res, next) {
  try {
    const { businessId } = req.user;
    const role = await prisma.businessRole.findFirst({ where: { id: req.params.id, businessId }, select: { id: true } });
    if (!role) return res.status(404).json({ message: 'Not found' });
    const grant = await prisma.hrRolePermissionGrant.findFirst({
      where: { id: req.params.grantId, roleId: role.id, businessId }, select: { id: true },
    });
    if (!grant) return res.status(404).json({ message: 'Grant not found' });
    await prisma.hrRolePermissionGrant.delete({ where: { id: grant.id } });
    res.json({ ok: true, id: grant.id });
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

    // The target user's CURRENT role (to detect a last-Owner strip on re-assignment).
    const targetUser = await prisma.user.findFirst({
      where: { id: emp.userId, businessId },
      select: { id: true, role: true, businessRole: { select: { permissions: true, name: true, isSystem: true } } },
    });
    if (!targetUser) return res.status(404).json({ message: 'Portal user not found in this tenant' });

    const { businessRoleId } = req.body || {};
    let newRole = null;
    if (businessRoleId) {
      newRole = await prisma.businessRole.findFirst({
        where: { id: businessRoleId, businessId },
        select: { id: true, name: true, isSystem: true, permissions: true, defaultScope: true },
      });
      if (!newRole) return res.status(404).json({ message: 'Role not found in this tenant' });
      // §7.4 privilege-escalation guard: a non-Owner may not assign a role more
      // privileged than themselves (perms they lack, an Owner-only key, or a broader scope).
      if (roleExceedsCaller(newRole, req.user)) {
        return forbid(res, 'You cannot assign a role more privileged than your own');
      }
    }

    // Last-Owner tenant invariant (§9.9): if the target currently holds canManageRoles
    // and the new state does NOT, refuse when they are the tenant's last holder. The
    // post-change effective perms reflect the role-or-legacy fallback (assigning null
    // drops the custom role and the user reverts to their User.role baseline).
    const targetHadManage = !!effectivePermissions(targetUser).canManageRoles;
    const afterPerms = effectivePermissions({ role: targetUser.role, businessRole: newRole || null });
    const newHasManage = !!afterPerms.canManageRoles;
    if (targetHadManage && !newHasManage) {
      const remaining = await countManageRolesHoldersExcluding(businessId, [targetUser.id]);
      if (remaining === 0) {
        return res.status(400).json({ message: 'This change would remove the last canManageRoles holder from the tenant' });
      }
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
  listRoles, createRole, updateRole, deleteRole, addGrant, deleteGrant,
  orgTree, reparent, assignRole,
};
