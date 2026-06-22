'use strict';

/**
 * scope.middleware.js — Feature 1 hierarchical RBAC.
 *  - attachSelfEmployee: resolves the operator's own Employee (portal identity) and
 *    attaches the hierarchy anchor (employeeId/managerEmployeeId) to req.user, so the
 *    scope resolver has a root. Runs once after auth; idempotent per request.
 *  - withEmployeeScope(action, {idParam}): attaches req.scope = ScopeResult and, for
 *    single-row routes, returns 404 when the :id is out of the actor's scope (IDOR-safe).
 */

const prisma = require('../../core/lib/prisma');
const { resolveAccessibleEmployeeIds, scopeAllows } = require('../lib/scopeResolver');

async function attachSelfEmployee(req, res, next) {
  try {
    if (req.user && req.user.id && req.user.employeeId === undefined) {
      const emp = req.user.businessId
        ? await prisma.employee.findFirst({
            where: { userId: req.user.id, businessId: req.user.businessId, deletedAt: null },
            select: { id: true, managerEmployeeId: true },
          })
        : null;
      req.user.employeeId = emp ? emp.id : null;
      req.user.managerEmployeeId = emp ? emp.managerEmployeeId : null;
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

function withEmployeeScope(action, { idParam } = {}) {
  return async function scopeGuard(req, res, next) {
    try {
      const scope = await resolveAccessibleEmployeeIds(req.user, action);
      req.scope = scope;
      if (idParam && req.params && req.params[idParam]) {
        if (!scopeAllows(scope, req.params[idParam])) {
          return res.status(404).json({ message: 'Not found' });
        }
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { attachSelfEmployee, withEmployeeScope };
