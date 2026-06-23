'use strict';

/**
 * managerChain.js — Feature 8 §5.2 / §5.6: the INVERSE of the TEAM sub-tree.
 *
 * `resolveAccessibleEmployeeIds(actor,'TEAM')` (scopeResolver.js) walks DOWN the
 * reporting tree — every report below the actor. OKR *alignment* needs the
 * opposite: the chain of managers ABOVE the actor (manager, manager's manager, …,
 * up to the org root), so an INDIVIDUAL contributor may align their objective only
 * to a parent owned by someone in their own management line — never to an
 * arbitrary peer's objective. Same self-relation (`Employee.managerEmployeeId`),
 * walked up instead of down.
 *
 *   resolveManagerChainEmployeeIds(actor) -> { kind:'IDS', ids:Set<id> } | { kind:'NONE' }
 *
 * The set ALWAYS includes the actor's own employeeId (an IC may align to their own
 * objective). Tenant-scoped + soft-delete-aware, mirroring the TEAM CTE.
 */

const prisma = require('../../../core/lib/prisma');

const NONE = { kind: 'NONE' };

async function resolveManagerChainEmployeeIds(actor) {
  if (!actor || !actor.businessId) return NONE;
  const selfId = actor.employeeId || null;
  if (!selfId) return NONE;

  const ids = new Set([selfId]);
  // Recursive CTE: seed with the actor's manager, then climb manager-of-manager.
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE chain AS (
      SELECT m.id, m."managerEmployeeId"
        FROM "Employee" e
        JOIN "Employee" m ON m.id = e."managerEmployeeId"
        WHERE e.id = ${selfId}
          AND m."businessId" = ${actor.businessId}
          AND m."deletedAt" IS NULL
      UNION
      SELECT p.id, p."managerEmployeeId"
        FROM "Employee" p
        JOIN chain c ON p.id = c."managerEmployeeId"
        WHERE p."businessId" = ${actor.businessId}
          AND p."deletedAt" IS NULL
    )
    SELECT id FROM chain
  `;
  for (const r of rows) ids.add(r.id);
  return { kind: 'IDS', ids };
}

module.exports = { resolveManagerChainEmployeeIds };
