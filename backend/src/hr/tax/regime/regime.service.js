'use strict';

/**
 * regime.service.js — Feature 15/25. The INCOME-TAX REGIME ELECTION workflow that
 * sits on top of the already-built regime-aware withholding (payroll/service →
 * computeTds) and the regimeComparison the projection assembler already produces.
 *
 * What this module owns (the GAP pieces — everything else already exists):
 *   - electRegime()      : an employee (ESS) or HR sets the elected regime, ENFORCING
 *                          the per-FY election window + per-employee + global lock.
 *                          On success it updates StatutoryProfile.taxRegime AND appends
 *                          a StatutoryElectionHistory row (the append-only audit). Idempotent
 *                          (electing the already-elected regime is a no-op success).
 *   - getEffectiveRegime(): THE RESOLVER — the elected regime if the employee has one,
 *                          else the tenant default (TaxRegimePolicy.defaultRegime for the
 *                          FY), else the statutory NEW. This is what the withholding path
 *                          consults so an UN-ELECTED employee is withheld under the
 *                          EMPLOYER DEFAULT (not a blanket NEW).
 *   - setPolicy()        : HR upserts the per-FY TaxRegimePolicy (default + window + lock).
 *   - lockRegime()       : HR locks one employee OR every employee for the FY (bulk lock
 *                          when the window closes) by stamping StatutoryProfile.regimeLockedAt.
 *
 * Tenant-walled: EVERY query carries businessId; a cross-tenant id resolves to NOT_FOUND.
 * India-only is enforced by the callers/controllers (the regime concept is an IN one);
 * this service does not re-derive country (it operates on the StatutoryProfile it is given
 * an employeeId for, within the tenant).
 *
 * Errors carry a `.code` so the controllers can map them: NOT_FOUND (404), BAD_REQUEST
 * (422), REGIME_LOCKED / WINDOW_CLOSED / WINDOW_NOT_OPEN / GLOBAL_LOCK (409 — election
 * refused). The lock/window enforcement is the §192 control: once HR finalises the year,
 * the regime that drove the year's TDS can't be retroactively flipped.
 */

const prisma = require('../../../core/lib/prisma');

const VALID = new Set(['NEW', 'OLD']);

function badRequest(message) {
  const e = new Error(message);
  e.code = 'BAD_REQUEST';
  return e;
}
function notFound(message = 'Employee not found') {
  const e = new Error(message);
  e.code = 'NOT_FOUND';
  return e;
}
function locked(code, message) {
  const e = new Error(message);
  e.code = code; // REGIME_LOCKED | WINDOW_CLOSED | WINDOW_NOT_OPEN | GLOBAL_LOCK
  return e;
}

// "2026-27" → guard true. Same shape as StatutoryProfile.prevEmployerFY / the window FY.
const FY_RE = /^\d{4}-\d{2}$/;
function normFy(fy) {
  return typeof fy === 'string' && FY_RE.test(fy.trim()) ? fy.trim() : null;
}
function normRegime(r) {
  const s = typeof r === 'string' ? r.trim().toUpperCase() : '';
  return VALID.has(s) ? s : null;
}
// FY start date (1 April of the first year). Used as the election's effectiveFrom so the
// history row is effective-dated to the start of the year it governs.
function fyStartDate(fy) {
  const startYear = Number(fy.slice(0, 4));
  return new Date(`${startYear}-04-01T00:00:00.000Z`);
}

// ── Policy read ───────────────────────────────────────────────────────────────
// The tenant's per-FY policy (or null). Tenant-walled by businessId.
async function getPolicy({ businessId, fy, db = prisma } = {}) {
  const f = normFy(fy);
  if (!businessId || !f) return null;
  return db.taxRegimePolicy.findFirst({ where: { businessId, fy: f } });
}

/**
 * getEffectiveRegime — the RESOLVER the withholding/projection path consults.
 * Precedence: the employee's ELECTED regime (StatutoryProfile.taxRegime) →
 * the tenant DEFAULT (TaxRegimePolicy.defaultRegime for the FY) → statutory NEW.
 *
 * `sp`/`policy` may be passed in to avoid a re-fetch on the hot payroll path (the
 * payroll service already loaded the StatutoryProfile). When omitted they are looked
 * up (tenant-scoped). Returns a plain string 'NEW'|'OLD' — never throws on a missing
 * profile (an employee with no SP falls through to default/NEW).
 *
 * @returns {Promise<{ regime:'NEW'|'OLD', source:'ELECTED'|'DEFAULT'|'STATUTORY' }>}
 */
async function getEffectiveRegime({ businessId, employeeId, fy, sp, policy, db = prisma } = {}) {
  if (!businessId || !employeeId) return { regime: 'NEW', source: 'STATUTORY' };

  // 1. ELECTED — the employee's own choice on their StatutoryProfile.
  const profile = sp !== undefined
    ? sp
    : await db.statutoryProfile.findFirst({ where: { businessId, employeeId }, select: { taxRegime: true } });
  const elected = profile && profile.taxRegime ? normRegime(profile.taxRegime) : null;
  if (elected) return { regime: elected, source: 'ELECTED' };

  // 2. DEFAULT — the employer's per-FY policy default.
  const pol = policy !== undefined ? policy : await getPolicy({ businessId, fy, db });
  const def = pol && pol.defaultRegime ? normRegime(pol.defaultRegime) : null;
  if (def) return { regime: def, source: 'DEFAULT' };

  // 3. STATUTORY — the income-tax default.
  return { regime: 'NEW', source: 'STATUTORY' };
}

// Convenience: the bare effective regime string (the payroll service's seam).
async function resolveEffectiveRegimeString(args) {
  const r = await getEffectiveRegime(args);
  return r.regime;
}

/**
 * assertElectable — the WINDOW + LOCK gate. Throws when an election must be refused:
 *   - the employee's regime is individually locked (StatutoryProfile.regimeLockedAt)
 *   - the policy is globally locked (lockedGlobally)
 *   - now is BEFORE electionOpenFrom (window not open yet)
 *   - now is ON/AFTER electionLockDate (window closed)
 * No policy / no dates ⇒ fail-OPEN (election allowed) — a tenant that hasn't set a
 * window can still elect. Returns silently when electable.
 */
function assertElectable({ profile, policy, now = new Date() }) {
  if (profile && profile.regimeLockedAt) {
    throw locked('REGIME_LOCKED', 'Your tax-regime election is locked for this year. Contact HR to change it.');
  }
  if (policy) {
    if (policy.lockedGlobally) {
      throw locked('GLOBAL_LOCK', 'Tax-regime elections are locked for this financial year.');
    }
    if (policy.electionOpenFrom && now < policy.electionOpenFrom) {
      throw locked('WINDOW_NOT_OPEN', 'The tax-regime election window has not opened yet.');
    }
    if (policy.electionLockDate && now >= policy.electionLockDate) {
      throw locked('WINDOW_CLOSED', 'The tax-regime election window has closed for this financial year.');
    }
  }
}

/**
 * electRegime — set the elected regime (ESS employee or HR acting for an employee).
 * ENFORCES the window/lock via assertElectable, then (on a real change) updates
 * StatutoryProfile.taxRegime and APPENDS a StatutoryElectionHistory row (field
 * "taxRegime", oldValue→newValue, effectiveFrom = FY start, changedBy = actorId).
 *
 * Idempotent: electing the regime the employee already has is a success no-op (no
 * history row written). Tenant-walled. The StatutoryProfile is upserted by the unique
 * employeeId so an employee without one yet can still elect (countryCode required on
 * create — resolved from the employee row).
 *
 * @returns {Promise<{ employeeId, fy, regime, changed:boolean, source:'ELECTED' }>}
 */
async function electRegime({ businessId, employeeId, fy, regime, actorId, db = prisma } = {}) {
  if (!businessId || !employeeId) throw badRequest('businessId and employeeId are required');
  const f = normFy(fy);
  if (!f) throw badRequest('fy must be "YYYY-YY" (e.g. 2026-27)');
  const target = normRegime(regime);
  if (!target) throw badRequest('regime must be NEW or OLD');

  // Subject must exist in THIS tenant (cross-tenant → NOT_FOUND, never leak existence).
  const emp = await db.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, countryCode: true },
  });
  if (!emp) throw notFound();

  const profile = await db.statutoryProfile.findFirst({ where: { businessId, employeeId } });
  const policy = await getPolicy({ businessId, fy: f, db });

  // Lock/window gate — refused with a precise code (the controller maps to 409).
  assertElectable({ profile, policy, now: new Date() });

  const current = profile && profile.taxRegime ? normRegime(profile.taxRegime) : null;
  if (current === target) {
    // Idempotent: already elected this regime — success, no history row.
    return { employeeId, fy: f, regime: target, changed: false, source: 'ELECTED' };
  }

  const effectiveFrom = fyStartDate(f);
  const saved = await db.$transaction(async (tx) => {
    const sp = await tx.statutoryProfile.upsert({
      where: { employeeId },
      update: { taxRegime: target, version: { increment: 1 } },
      create: { businessId, employeeId, countryCode: emp.countryCode || 'IN', taxRegime: target },
    });
    await tx.statutoryElectionHistory.create({
      data: {
        businessId,
        statutoryProfileId: sp.id,
        field: 'taxRegime',
        oldValue: current || null,
        newValue: target,
        effectiveFrom,
        changedBy: actorId || 'system',
      },
    });
    return sp;
  });

  return { employeeId, fy: f, regime: normRegime(saved.taxRegime), changed: true, source: 'ELECTED' };
}

/**
 * setPolicy — HR upserts the per-FY TaxRegimePolicy (employer default + election
 * window + global lock). Tenant-walled by (businessId, fy). Validates the regime and
 * the date order (electionOpenFrom ≤ electionLockDate when both supplied).
 *
 * @returns the saved policy row.
 */
async function setPolicy({ businessId, fy, defaultRegime, electionOpenFrom, electionLockDate, lockedGlobally, actorId, db = prisma } = {}) {
  if (!businessId) throw badRequest('businessId is required');
  const f = normFy(fy);
  if (!f) throw badRequest('fy must be "YYYY-YY" (e.g. 2026-27)');

  const data = {};
  if (defaultRegime !== undefined) {
    const dr = normRegime(defaultRegime);
    if (!dr) throw badRequest('defaultRegime must be NEW or OLD');
    data.defaultRegime = dr;
  }
  const openFrom = electionOpenFrom !== undefined ? toDateOrNull(electionOpenFrom) : undefined;
  const lockDate = electionLockDate !== undefined ? toDateOrNull(electionLockDate) : undefined;
  if (openFrom !== undefined) data.electionOpenFrom = openFrom;
  if (lockDate !== undefined) data.electionLockDate = lockDate;
  if (lockedGlobally !== undefined) data.lockedGlobally = !!lockedGlobally;

  // Date order guard (only when both ends are present in the resulting record).
  const existing = await db.taxRegimePolicy.findFirst({ where: { businessId, fy: f } });
  const effOpen = openFrom !== undefined ? openFrom : (existing ? existing.electionOpenFrom : null);
  const effLock = lockDate !== undefined ? lockDate : (existing ? existing.electionLockDate : null);
  if (effOpen && effLock && effOpen > effLock) {
    throw badRequest('electionOpenFrom must be on or before electionLockDate');
  }

  const saved = await db.taxRegimePolicy.upsert({
    where: { businessId_fy: { businessId, fy: f } },
    update: { ...data, updatedBy: actorId || null, version: { increment: 1 } },
    create: {
      businessId,
      fy: f,
      defaultRegime: data.defaultRegime || 'NEW',
      electionOpenFrom: data.electionOpenFrom ?? null,
      electionLockDate: data.electionLockDate ?? null,
      lockedGlobally: data.lockedGlobally ?? false,
      updatedBy: actorId || null,
    },
  });
  return saved;
}

/**
 * lockRegime — stamp StatutoryProfile.regimeLockedAt to freeze the election. Locks ONE
 * employee ({ employeeId }) or EVERY India employee for the tenant ({ all:true }) — the
 * bulk lock HR runs when the FY election window closes. Idempotent (already-locked rows
 * keep their original timestamp unless `relock` is set). Tenant-walled.
 *
 * @returns {Promise<{ locked:number, at:Date }>} how many profiles were stamped.
 */
async function lockRegime({ businessId, employeeId, all = false, relock = false, db = prisma } = {}) {
  if (!businessId) throw badRequest('businessId is required');
  if (!employeeId && !all) throw badRequest('Provide employeeId or all:true');
  const at = new Date();

  if (employeeId && !all) {
    // Single employee — verify tenant membership (cross-tenant → NOT_FOUND).
    const emp = await db.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!emp) throw notFound();
    const where = { businessId, employeeId, ...(relock ? {} : { regimeLockedAt: null }) };
    const r = await db.statutoryProfile.updateMany({ where, data: { regimeLockedAt: at } });
    return { locked: r.count, at };
  }

  // Bulk: every (India) StatutoryProfile in the tenant that isn't already locked.
  const where = { businessId, countryCode: 'IN', ...(relock ? {} : { regimeLockedAt: null }) };
  const r = await db.statutoryProfile.updateMany({ where, data: { regimeLockedAt: at } });
  return { locked: r.count, at };
}

// Unlock (HR override) — clears regimeLockedAt so an employee can re-elect.
async function unlockRegime({ businessId, employeeId, db = prisma } = {}) {
  if (!businessId || !employeeId) throw badRequest('businessId and employeeId are required');
  const emp = await db.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true } });
  if (!emp) throw notFound();
  const r = await db.statutoryProfile.updateMany({ where: { businessId, employeeId }, data: { regimeLockedAt: null } });
  return { unlocked: r.count };
}

// Parse a YYYY-MM-DD | ISO string | Date into a Date, or null. Empty → null (clears).
function toDateOrNull(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string') {
    const s = v.trim();
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

module.exports = {
  getEffectiveRegime,
  resolveEffectiveRegimeString,
  electRegime,
  setPolicy,
  getPolicy,
  lockRegime,
  unlockRegime,
  // Internals for unit tests (pure where possible).
  _internals: { assertElectable, normRegime, normFy, fyStartDate, toDateOrNull },
};
