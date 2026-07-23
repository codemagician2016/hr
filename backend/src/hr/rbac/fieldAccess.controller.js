'use strict';

// Phase 5c — field-level permissions admin API. A dedicated, unambiguous surface
// (mounted at /api/hr/field-access) so it never collides with the two /api/rbac
// role routers. Lets a tenant admin set, PER ROLE, a field-group access map that
// the employee read/write paths enforce. Guarded by canManageEmployees (an existing
// operator permission — field access governs employee-field visibility).
//
// NOTE (deliberate): unlike role permission edits, field-access MAY be set on a
// system role. It only ever RESTRICTS what that role sees — it cannot escalate
// privilege — so the "system roles are clone-to-edit" invariant does not apply.

const prisma = require('../../core/lib/prisma');
const fieldAccess = require('./fieldAccess');

// GET /api/hr/field-access/roles — every role + its current field-access map, plus
// the acting role id (so a caller can see the effect on itself) and the group catalog.
async function listRolesWithAccess(req, res, next) {
  try {
    const { businessId } = req.user;
    const items = await prisma.businessRole.findMany({
      where: { businessId },
      select: { id: true, name: true, isSystem: true, defaultScope: true, fieldAccess: true },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    res.json({
      items: items.map((r) => ({ ...r, fieldAccess: r.fieldAccess && typeof r.fieldAccess === 'object' ? r.fieldAccess : {} })),
      actingRoleId: req.user.businessRoleId || (req.user.businessRole && req.user.businessRole.id) || null,
      groups: fieldAccess.publicGroups(),
    });
  } catch (e) { next(e); }
}

// GET /api/hr/field-access/groups — the governable field-group catalog (console columns).
async function listGroups(req, res, next) {
  try { res.json({ groups: fieldAccess.publicGroups() }); } catch (e) { next(e); }
}

// PUT /api/hr/field-access/roles/:id — replace a role's field-access map.
// Body: { fieldAccess: { group: 'HIDDEN'|'READ'|'WRITE', ... } } (bare map also accepted).
async function setRoleFieldAccess(req, res, next) {
  try {
    const { businessId } = req.user;
    const role = await prisma.businessRole.findFirst({ where: { id: req.params.id, businessId } });
    if (!role) return res.status(404).json({ message: 'Role not found' });

    const input = req.body && req.body.fieldAccess !== undefined ? req.body.fieldAccess : req.body;
    const v = fieldAccess.validateFieldAccessMap(input);
    if (!v.ok) return res.status(422).json({ code: 'INVALID_FIELD_ACCESS', message: v.error });

    const updated = await prisma.businessRole.update({
      where: { id: role.id },
      data: { fieldAccess: v.map },
      select: { id: true, name: true, isSystem: true, defaultScope: true, fieldAccess: true },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

module.exports = { listRolesWithAccess, listGroups, setRoleFieldAccess };
