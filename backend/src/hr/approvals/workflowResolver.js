'use strict';

/**
 * workflowResolver.js — Feature 10 §5.1. Pick the WorkflowDefinition that routes a
 * given (businessId, module, ctx). When a tenant has configured + published nothing,
 * fall back to a BUILT_IN_DEFAULT code constant per module that reproduces TODAY's
 * behaviour exactly — so zero-config tenants keep working with no migration.
 *
 *   resolveDefinition(businessId, module, ctx) -> { definition, steps, source }
 *     ctx    = { entityId?, departmentId?, employeeLevel?, locationId?, amount?, ... }
 *     source = 'DEFINITION' | 'BUILT_IN_DEFAULT'
 *
 * Selection order (§5.1):
 *   1. Published, active defs for (businessId, module), ordered by priority asc.
 *   2. First whose entityId matches ctx.entityId (most specific), else whose
 *      scopeJson matches ctx (department/level/location), else the module DEFAULT
 *      (scopeJson = null + entityId = null).
 *   3. Else BUILT_IN_DEFAULT[module] (or the generic single-manager default).
 *
 * BUILT_IN_DEFAULT semantics (the "no behaviour change" guarantee):
 *   LEAVE   = [ REPORTING_MANAGER, escalate @48h ]      ← today's leave routing
 *   EXPENSE = [ REPORTING_MANAGER ] then [ HR if amount > threshold ]  ← today's
 *             expense behaviour generalised (bare canManageEmployees flip → a real
 *             manager step, with an amount-tiered HR step that conditional-skips
 *             below the threshold so small claims still stop at the manager).
 *   every other module = [ REPORTING_MANAGER, escalate @48h ] (manager-approves).
 *
 * The built-in steps are PLAIN OBJECTS shaped like WorkflowStep rows (no id /
 * persistence); the engine + approverResolver treat them identically to DB steps.
 */

// Default amount over which an EXPENSE adds an HR step (mirrors the historical
// "big claims need HR" intent). Overridable per-tenant by publishing a real def.
const EXPENSE_HR_THRESHOLD = 50000;

// A built-in step factory — keeps the shape identical to a persisted WorkflowStep
// (the fields the engine + approverResolver read), with sane defaults.
function step(stepOrder, approverType, extra = {}) {
  return {
    id: null,
    stepOrder,
    name: extra.name || approverType,
    approverType,
    approverRefId: extra.approverRefId || null,
    conditionJson: extra.conditionJson || null,
    isParallel: !!extra.isParallel,
    minApprovals: extra.minApprovals || 1,
    slaHours: extra.slaHours === undefined ? null : extra.slaHours,
    onTimeoutAction: extra.onTimeoutAction || 'ESCALATE',
  };
}

// Per-module built-in default chains (the inert-scaffold → live behaviour bridge).
const BUILT_IN_DEFAULT = Object.freeze({
  LEAVE: [
    step(1, 'REPORTING_MANAGER', { name: 'Manager', approverRefId: '1', slaHours: 48, onTimeoutAction: 'ESCALATE' }),
  ],
  EXPENSE: [
    step(1, 'REPORTING_MANAGER', { name: 'Manager', approverRefId: '1', slaHours: 48, onTimeoutAction: 'ESCALATE' }),
    step(2, 'HR', { name: 'HR (over threshold)', conditionJson: { amount: { '>': EXPENSE_HR_THRESHOLD } }, slaHours: 72, onTimeoutAction: 'ESCALATE' }),
  ],
  TRAVEL: [
    step(1, 'REPORTING_MANAGER', { name: 'Manager', approverRefId: '1', slaHours: 48, onTimeoutAction: 'ESCALATE' }),
    step(2, 'HR', { name: 'HR (over threshold)', conditionJson: { amount: { '>': EXPENSE_HR_THRESHOLD } }, slaHours: 72, onTimeoutAction: 'ESCALATE' }),
  ],
  // FLAG (Feature 13 — shared edit): a gated profile-field change (name/DOB/bank/
  // statutory ID) routes to a SINGLE HR step. HR — not the reporting manager — owns
  // identity/statutory/money changes (docs/features/13 §3.5). A tenant can override
  // by publishing a real PROFILE_CHANGE WorkflowDefinition.
  PROFILE_CHANGE: [
    step(1, 'HR', { name: 'HR', slaHours: 72, onTimeoutAction: 'ESCALATE' }),
  ],
  // Feature 31 — IN-SERVICE leave encashment. Manager green-lights the surrender of
  // days for cash (it debits the leave balance + queues a TAXABLE payout), escalating
  // up the chain after 48h. A tenant can override by publishing a real
  // LEAVE_ENCASHMENT WorkflowDefinition (e.g. add an HR/Finance step).
  LEAVE_ENCASHMENT: [
    step(1, 'REPORTING_MANAGER', { name: 'Manager', approverRefId: '1', slaHours: 48, onTimeoutAction: 'ESCALATE' }),
  ],
});

// Generic fallback for any module without a bespoke built-in: manager approves,
// escalates after 48h. Preserves the platform-wide "your manager says yes" default.
const GENERIC_DEFAULT = [
  step(1, 'REPORTING_MANAGER', { name: 'Manager', approverRefId: '1', slaHours: 48, onTimeoutAction: 'ESCALATE' }),
];

function builtInSteps(module) {
  return BUILT_IN_DEFAULT[module] || GENERIC_DEFAULT;
}

// Does a definition's scopeJson match the request ctx? NULL scopeJson = the
// module-wide default (matches anything). A present scopeJson matches when EVERY
// declared dimension contains the ctx value (department/level/location).
function scopeMatches(scopeJson, ctx = {}) {
  if (!scopeJson || typeof scopeJson !== 'object') return true; // default def
  const { departmentIds, employeeLevels, locationIds } = scopeJson;
  if (Array.isArray(departmentIds) && departmentIds.length > 0) {
    if (!ctx.departmentId || !departmentIds.includes(ctx.departmentId)) return false;
  }
  if (Array.isArray(employeeLevels) && employeeLevels.length > 0) {
    if (!ctx.employeeLevel || !employeeLevels.includes(ctx.employeeLevel)) return false;
  }
  if (Array.isArray(locationIds) && locationIds.length > 0) {
    if (!ctx.locationId || !locationIds.includes(ctx.locationId)) return false;
  }
  return true;
}

/**
 * resolveDefinition(businessId, module, ctx, { prismaClient }) ->
 *   { definition, steps, source }
 * `definition` is null for the built-in path. `steps` are ordered ascending by
 * stepOrder. Pass a tx client via opts.prismaClient to read within a transaction.
 */
async function resolveDefinition(businessId, module, ctx = {}, opts = {}) {
  const db = opts.prismaClient || require('../../core/lib/prisma');

  const defs = await db.workflowDefinition.findMany({
    where: { businessId, module, isActive: true, isPublished: true },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  });

  if (defs.length > 0) {
    // (a) most specific: an entityId match.
    if (ctx.entityId) {
      const byEntity = defs.find((d) => d.entityId && d.entityId === ctx.entityId);
      if (byEntity) return { definition: byEntity, steps: byEntity.steps, source: 'DEFINITION' };
    }
    // (b) a scopeJson match (priority asc already ordered).
    const byScope = defs.find((d) => d.scopeJson && scopeMatches(d.scopeJson, ctx) && !d.entityId);
    if (byScope) return { definition: byScope, steps: byScope.steps, source: 'DEFINITION' };
    // (c) the module-wide default: no entityId, no scopeJson.
    const moduleDefault = defs.find((d) => !d.entityId && !d.scopeJson);
    if (moduleDefault) return { definition: moduleDefault, steps: moduleDefault.steps, source: 'DEFINITION' };
    // (d) nothing matched the ctx but published defs exist — fall through to built-in
    //     so an over-narrow scope never deadlocks a request.
  }

  return { definition: null, steps: builtInSteps(module), source: 'BUILT_IN_DEFAULT' };
}

module.exports = {
  resolveDefinition,
  BUILT_IN_DEFAULT,
  builtInSteps,
  scopeMatches,
  EXPENSE_HR_THRESHOLD,
  _step: step,
};
