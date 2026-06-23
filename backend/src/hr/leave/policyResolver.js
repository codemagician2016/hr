'use strict';

/**
 * policyResolver.js — resolve the effective LeavePolicy for an employee+type
 * (Feature 6 §4.7). Thin DB read; the ranking logic is pure and exported for
 * tests. `LeavePolicyAssignment` is unused by the request flow today — this
 * wires it in, most-specific-wins (mirrors `isHoliday` scope ranking).
 *
 *   rank = EMPLOYEE(4) > GRADE(3) > DEPARTMENT(2) > EMPLOYMENT_TYPE(1) > ENTITY(0)
 *   resolvePolicy(emp, leaveTypeId, asOf) =
 *     highest-rank assignment whose [effectiveFrom, effectiveTo] covers asOf,
 *     for a LeavePolicy of that leaveTypeId; tie-break = latest effectiveFrom.
 *
 * Feeds both accrual rates (with AccrualRule tiers) and apply-time gates.
 */

const prisma = require('../../core/lib/prisma');

const SCOPE_RANK = { EMPLOYEE: 4, GRADE: 3, DEPARTMENT: 2, EMPLOYMENT_TYPE: 1, ENTITY: 0 };

function utcDayMs(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
}

/**
 * scopeRefFor(emp, scope) — the id this employee presents for an assignment
 * scope. Returns null when the employee has no value for that axis (so it can
 * never accidentally match a NULL scopeRefId).
 */
function scopeRefFor(emp, scope) {
  const e = emp || {};
  switch (scope) {
    case 'EMPLOYEE': return e.id || null;
    case 'GRADE': return e.gradeId || e.grade || null;
    case 'DEPARTMENT': return e.departmentId || e.department || null;
    case 'EMPLOYMENT_TYPE': return e.employmentType || null;
    case 'ENTITY': return e.entityId || null;
    default: return null;
  }
}

/**
 * pickAssignment(assignments, emp, asOf) — PURE. Choose the most-specific
 * assignment covering `asOf` whose scopeRefId matches the employee on its axis
 * (ENTITY may be a catch-all with a null scopeRefId). Tie-break by latest
 * effectiveFrom. Returns the assignment or null.
 */
function pickAssignment(assignments, emp, asOf) {
  const when = utcDayMs(asOf);
  const candidates = (assignments || []).filter((a) => {
    if (!a) return false;
    const from = a.effectiveFrom ? utcDayMs(a.effectiveFrom) : -Infinity;
    const to = a.effectiveTo ? utcDayMs(a.effectiveTo) : Infinity;
    if (when < from || when > to) return false;
    const ref = scopeRefFor(emp, a.scope);
    if (a.scope === 'ENTITY') {
      // entity-wide default: matches when scopeRefId is null OR equals the emp's entity
      return a.scopeRefId == null || a.scopeRefId === ref;
    }
    return a.scopeRefId != null && a.scopeRefId === ref;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const ra = SCOPE_RANK[a.scope] ?? -1;
    const rb = SCOPE_RANK[b.scope] ?? -1;
    if (ra !== rb) return rb - ra; // higher rank first
    const fa = a.effectiveFrom ? utcDayMs(a.effectiveFrom) : 0;
    const fb = b.effectiveFrom ? utcDayMs(b.effectiveFrom) : 0;
    return fb - fa; // latest effectiveFrom first
  });
  return candidates[0];
}

/**
 * resolvePolicy(emp, leaveTypeId, asOf, { tx }) — DB-backed. Loads the active
 * assignments for this type's policies, picks the most-specific, returns
 * { policy, accrualRules, assignment } or a fallback when no assignment exists
 * (the single active LeavePolicy for that type, if any — keeps v1 usable before
 * assignments are authored).
 */
async function resolvePolicy(emp, leaveTypeId, asOf = new Date(), { tx } = {}) {
  const db = tx || prisma;
  const businessId = emp && emp.businessId;
  if (!businessId || !leaveTypeId) return null;

  const policies = await db.leavePolicy.findMany({
    where: { businessId, leaveTypeId, isActive: true, deletedAt: null },
    include: { assignments: true, accrualRules: true },
  });
  if (!policies.length) return null;

  // Flatten (assignment -> its policy) and pick the most-specific assignment.
  const flat = [];
  for (const p of policies) {
    for (const a of p.assignments || []) flat.push({ ...a, _policy: p });
  }
  const chosen = pickAssignment(flat, emp, asOf);
  if (chosen) {
    const policy = chosen._policy;
    return { policy, accrualRules: policy.accrualRules || [], assignment: chosen };
  }

  // Fallback: no assignment authored yet → the policy scoped to the emp's entity,
  // else a global (entityId null) one, else the first active policy.
  const entityScoped = policies.find((p) => p.entityId && emp.entityId && p.entityId === emp.entityId);
  const global = policies.find((p) => p.entityId == null);
  const policy = entityScoped || global || policies[0];
  return { policy, accrualRules: policy.accrualRules || [], assignment: null };
}

module.exports = { resolvePolicy, pickAssignment, scopeRefFor, SCOPE_RANK };
