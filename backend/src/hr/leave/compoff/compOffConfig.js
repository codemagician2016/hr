'use strict';

/**
 * compOffConfig.js — resolve the per-tenant comp-off knobs (Feature 30 §3.3).
 *
 * Comp-off behaviour rides on the COMP_OFF-type LeavePolicy's `compOffConfig`
 * JSON sidecar (added in the F30 migration). This module merges a tenant's stored
 * config over India-sane DEFAULTS so every runner/seam reads one coherent object.
 *
 * It also locates the tenant's COMP_OFF leave type + its policy. The leave type is
 * seeded once per tenant (`ensureCompOffType`), category=COMP_OFF, isPaid=true,
 * affectsLOP=false, with a policy whose accrualMethod=NONE — so the nightly accrual
 * runner NEVER auto-grants it (accrualRunner.js skips NONE); the balance is fed ONLY
 * by earned credits.
 *
 * Thin DB reads; the merge is pure + exported for tests.
 */

const prisma = require('../../../core/lib/prisma');

// India-sane defaults (§3.3). Karnataka tenants override expiryDays→90.
const DEFAULTS = Object.freeze({
  expiryDays: 60,
  requireApproval: true,
  autoEarn: true,
  minWorkedMinutesForCredit: 240, // < this → no credit
  fullDayMinutes: 480, // >= this → 1.0 day; else (>= min) → 0.5 when allowHalfDay
  allowHalfDay: true,
  allowEncash: false,
  earnFromWeeklyOff: true,
  earnFromHoliday: true,
  expiryReminderDays: 7, // "expiring soon" reminder lead time
});

/** mergeConfig(stored) — PURE. Defaults ← stored (only known keys, numbers coerced). */
function mergeConfig(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (s[k] === undefined || s[k] === null) continue;
    if (typeof DEFAULTS[k] === 'boolean') out[k] = s[k] === true || s[k] === 'true';
    else if (typeof DEFAULTS[k] === 'number') {
      const n = Number(s[k]);
      if (Number.isFinite(n)) out[k] = n;
    } else out[k] = s[k];
  }
  return out;
}

/**
 * creditQuantityForMinutes(workedMinutes, config) — PURE. The lot quantity an
 * earn should mint from a worked-on-off-day (§4.1):
 *   worked >= fullDayMinutes                     → 1.0
 *   worked >= minWorkedMinutesForCredit & half   → 0.5
 *   else                                         → 0 (no credit)
 */
function creditQuantityForMinutes(workedMinutes, config) {
  const c = config || DEFAULTS;
  const w = Number(workedMinutes) || 0;
  if (w >= Number(c.fullDayMinutes)) return 1.0;
  if (w >= Number(c.minWorkedMinutesForCredit)) return c.allowHalfDay ? 0.5 : 0;
  return 0;
}

/**
 * resolveCompOffType(businessId, { tx }) — the tenant's COMP_OFF leave type + its
 * (first active) policy + the merged config. Returns null when no COMP_OFF type is
 * seeded (the earn runner then skips the tenant). DB-thin.
 */
async function resolveCompOffType(businessId, { tx } = {}) {
  const db = tx || prisma;
  const leaveType = await db.leaveType.findFirst({
    where: { businessId, category: 'COMP_OFF', deletedAt: null, isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!leaveType) return null;
  const policy = await db.leavePolicy.findFirst({
    where: { businessId, leaveTypeId: leaveType.id, isActive: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return { leaveType, policy, config: mergeConfig(policy && policy.compOffConfig) };
}

/**
 * ensureCompOffType(businessId, { tx, code }) — idempotently seed the COMP_OFF
 * leave type + a NONE-accrual policy for a tenant. Used by the seed script + the
 * manual-grant path so an HR grant never fails for want of a type. Returns the
 * same shape as resolveCompOffType.
 */
async function ensureCompOffType(businessId, { tx, code = 'COMP_OFF' } = {}) {
  const db = tx || prisma;
  const existing = await resolveCompOffType(businessId, { tx: db });
  if (existing) return existing;

  const leaveType = await db.leaveType.upsert({
    where: { businessId_code: { businessId, code } },
    update: { category: 'COMP_OFF', isPaid: true, affectsLOP: false, isActive: true, deletedAt: null },
    create: {
      businessId, code, name: 'Comp-off', category: 'COMP_OFF',
      unit: 'DAYS', isPaid: true, affectsLOP: false, requiresReason: false,
      isEncashable: false, color: '#0ea5e9', isActive: true,
    },
  });
  const policyCode = `${code}_POLICY`;
  const policy = await db.leavePolicy.upsert({
    where: { businessId_code: { businessId, code: policyCode } },
    update: { leaveTypeId: leaveType.id, accrualMethod: 'NONE', isActive: true, deletedAt: null },
    create: {
      businessId, leaveTypeId: leaveType.id, code: policyCode, name: 'Comp-off policy',
      accrualMethod: 'NONE', accrualProrateOnJoin: false, isActive: true,
      compOffConfig: { ...DEFAULTS },
    },
  });
  return { leaveType, policy, config: mergeConfig(policy.compOffConfig) };
}

module.exports = {
  DEFAULTS,
  mergeConfig,
  creditQuantityForMinutes,
  resolveCompOffType,
  ensureCompOffType,
};
