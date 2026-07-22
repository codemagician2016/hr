'use strict';

/**
 * budget.js — Feature 35 §3.4/§4.2. Recognition budgets (optional spend caps).
 * Consumed is DERIVED from POSTED (+ still-pending) recognitions in the period
 * window — never stored — so a mid-period budget edit re-bases cleanly.
 *
 * Pure parts (unit-tested, no DB): budgetWindow, pickBudget, evaluateGive.
 * DB part: consumedPoints + resolveBudgetState (reads via an injected client).
 */

/** PURE — the [start, end) window containing `now` for a budget period type. */
function budgetWindow(periodType, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (periodType === 'YEARLY') {
    return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
  }
  if (periodType === 'QUARTERLY') {
    const qStart = Math.floor(m / 3) * 3;
    return { start: new Date(y, qStart, 1), end: new Date(y, qStart + 3, 1) };
  }
  // MONTHLY (default)
  return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
}

// Most-specific-wins precedence for budget scopes (spec §3.4).
const SCOPE_ORDER = ['GIVER', 'DEPARTMENT', 'ENTITY', 'TENANT'];

/**
 * PURE — pick the governing budget for a giver from the tenant's ACTIVE budgets:
 * GIVER(scopeRefId=giverId) > DEPARTMENT(giver's dept) > ENTITY(giver's entity)
 * > TENANT (scopeRefId null). Returns the budget row or null (no cap).
 */
function pickBudget(budgets, { giverEmployeeId, departmentId, entityId }) {
  const list = (budgets || []).filter((b) => b && b.isActive !== false);
  for (const scope of SCOPE_ORDER) {
    const match = list.find((b) => {
      if (b.scope !== scope) return false;
      if (scope === 'GIVER') return !!giverEmployeeId && b.scopeRefId === giverEmployeeId;
      if (scope === 'DEPARTMENT') return !!departmentId && b.scopeRefId === departmentId;
      if (scope === 'ENTITY') return !!entityId && b.scopeRefId === entityId;
      return true; // TENANT — matches everyone
    });
    if (match) return match;
  }
  return null;
}

/**
 * PURE — does THIS give need an F10 budget approval? (spec §4.2 step 3)
 *   needsApproval when pointsEnabled AND totalPoints > 0 AND
 *     (totalPoints > recognitionApprovalThreshold  [threshold null/0 = never]
 *      OR remainingBudget != null && remainingBudget < totalPoints)
 * Returns { needsApproval, reasons: [...] }.
 */
function evaluateGive({ config, totalPoints, remainingBudget }) {
  const reasons = [];
  const pts = Number(totalPoints) || 0;
  if (!config || config.pointsEnabled !== true || pts <= 0) {
    return { needsApproval: false, reasons };
  }
  const threshold = config.recognitionApprovalThreshold;
  if (Number.isInteger(threshold) && threshold > 0 && pts > threshold) {
    reasons.push('OVER_THRESHOLD');
  }
  if (remainingBudget != null && Number.isFinite(Number(remainingBudget)) && Number(remainingBudget) < pts) {
    reasons.push('OVER_BUDGET');
  }
  return { needsApproval: reasons.length > 0, reasons };
}

/**
 * Derived consumption for a budget scope in the current window: Σ pointsEach ×
 * recipientCount over the scope's recognitions that are POSTED or still
 * PENDING_APPROVAL (a pending give reserves budget so two rapid gives can't both
 * slip under the cap). Rejected gives never consume.
 */
async function consumedPoints(db, { businessId, budget, giverEmployeeId, departmentEmployeeIds, entityEmployeeIds, now = new Date() }) {
  if (!budget) return 0;
  const { start, end } = budgetWindow(budget.periodType, now);
  const where = {
    businessId,
    status: { in: ['POSTED', 'PENDING_APPROVAL'] },
    pointsEach: { gt: 0 },
    createdAt: { gte: start, lt: end },
  };
  if (budget.scope === 'GIVER') where.giverEmployeeId = budget.scopeRefId || giverEmployeeId;
  else if (budget.scope === 'DEPARTMENT') where.giverEmployeeId = { in: departmentEmployeeIds || [] };
  else if (budget.scope === 'ENTITY') where.giverEmployeeId = { in: entityEmployeeIds || [] };
  // TENANT — no giver narrowing.

  const rows = await db.recognition.findMany({
    where,
    select: { pointsEach: true, _count: { select: { recipients: true } } },
  });
  let total = 0;
  for (const r of rows) total += (r.pointsEach || 0) * ((r._count && r._count.recipients) || 0);
  return total;
}

/**
 * Resolve the giver's governing budget + remaining points for the current window.
 * Returns { budget: row|null, allocated, consumed, remaining } — remaining is null
 * when no budget governs (uncapped).
 */
async function resolveBudgetState(db, { businessId, giverEmployeeId, now = new Date() }) {
  const budgets = await db.recognitionBudget.findMany({ where: { businessId, isActive: true } });
  if (!budgets.length) return { budget: null, allocated: null, consumed: 0, remaining: null };

  // The giver's current segment (entity + department) for scope matching.
  const er = await db.employmentRecord.findFirst({
    where: { businessId, employeeId: giverEmployeeId, isCurrent: true },
    select: { entityId: true, departmentId: true },
  });
  const segment = { entityId: er ? er.entityId : null, departmentId: er ? er.departmentId || null : null };
  const budget = pickBudget(budgets, {
    giverEmployeeId,
    departmentId: segment.departmentId,
    entityId: segment.entityId,
  });
  if (!budget) return { budget: null, allocated: null, consumed: 0, remaining: null };

  // For DEPARTMENT/ENTITY scopes, consumption pools across the segment's givers.
  let departmentEmployeeIds = null;
  let entityEmployeeIds = null;
  if (budget.scope === 'DEPARTMENT' && budget.scopeRefId) {
    const recs = await db.employmentRecord.findMany({
      where: { businessId, isCurrent: true, departmentId: budget.scopeRefId },
      select: { employeeId: true },
    });
    departmentEmployeeIds = [...new Set(recs.map((r) => r.employeeId))];
  } else if (budget.scope === 'ENTITY' && budget.scopeRefId) {
    const recs = await db.employmentRecord.findMany({
      where: { businessId, isCurrent: true, entityId: budget.scopeRefId },
      select: { employeeId: true },
    });
    entityEmployeeIds = [...new Set(recs.map((r) => r.employeeId))];
  }

  const consumed = await consumedPoints(db, {
    businessId, budget, giverEmployeeId, departmentEmployeeIds, entityEmployeeIds, now,
  });
  return {
    budget,
    allocated: budget.allocatedPoints,
    consumed,
    remaining: Math.max(0, budget.allocatedPoints - consumed),
  };
}

module.exports = { budgetWindow, pickBudget, evaluateGive, consumedPoints, resolveBudgetState };
