'use strict';

/**
 * meTaxRegime.controller.js — Feature 15/25. ESS income-tax REGIME ELECTION, mounted at
 * /api/hr/me/tax/regime. CUSTOMER session (req.customer); SELF_ONLY — the subject employee
 * is resolved from the session (resolveSelfEmployee), NEVER from the client, so a
 * cross-employee election is structurally impossible (same discipline as meTax / mePayslips).
 *
 *   GET  /  → the employee's elected + EFFECTIVE regime, the per-FY window/lock state
 *             (so the page renders read-only after lock with the reason), AND the
 *             OLD-vs-NEW tax comparison from the projection assembler (betterRegime hint)
 *             so the employee elects informed.
 *   PUT  /  → elect NEW|OLD for the FY, ENFORCING the window/lock (regime.service).
 *
 * India-only: the regime concept is an IN one. A non-IN employee → 422 (country gate).
 * The withholding already honours the elected regime (computeTds); an un-elected employee
 * falls back to the employer default via getEffectiveRegime (the resolver).
 */

const { resolveSelfEmployee, isSeparatedEmployee } = require('../lib/resolveSelfEmployee');
const { resolveStatutoryCountry } = require('../lib/resolveStatutoryCountry');
const payrollService = require('../payroll/service');
const regimeService = require('../tax/regime/regime.service');
const assembler = require('../tax/projectionAssembler');
const prisma = require('../../core/lib/prisma');

const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// The current India FY ("2026-27") as of today (FY starts 1 April).
function currentFy(asOf) {
  return payrollService._internal.taxYearFor(asOf || new Date().toISOString().slice(0, 10), 4);
}

// Map a regime-service error code to an HTTP response. Lock/window refusals are 409.
function mapRegimeError(res, e) {
  if (!e || !e.code) return null;
  if (e.code === 'NOT_FOUND') return noEmployee(res);
  if (e.code === 'BAD_REQUEST') return res.status(422).json({ message: e.message, code: e.code });
  if (['REGIME_LOCKED', 'WINDOW_CLOSED', 'WINDOW_NOT_OPEN', 'GLOBAL_LOCK'].includes(e.code)) {
    return res.status(409).json({ message: e.message, code: e.code });
  }
  return null;
}

// Resolve the session's own active employee (or null → lockout).
async function resolveActiveSelf(req) {
  const { businessId } = req.customer;
  const emp = await resolveSelfEmployee(businessId, req.customer);
  return emp || null;
}

// Build the window/lock view the ESS page renders (read-only state + reason + dates).
function lockView({ profile, policy, now = new Date() }) {
  let locked = false;
  let reason = null;
  let code = null;
  if (profile && profile.regimeLockedAt) {
    locked = true; code = 'REGIME_LOCKED';
    reason = 'Your election is locked for this year. Contact HR to change it.';
  } else if (policy && policy.lockedGlobally) {
    locked = true; code = 'GLOBAL_LOCK';
    reason = 'Elections are locked for this financial year.';
  } else if (policy && policy.electionOpenFrom && now < policy.electionOpenFrom) {
    locked = true; code = 'WINDOW_NOT_OPEN';
    reason = 'The election window has not opened yet.';
  } else if (policy && policy.electionLockDate && now >= policy.electionLockDate) {
    locked = true; code = 'WINDOW_CLOSED';
    reason = 'The election window has closed for this financial year.';
  }
  return {
    locked,
    reason,
    code,
    lockedAt: profile && profile.regimeLockedAt ? profile.regimeLockedAt : null,
    electionOpenFrom: policy ? policy.electionOpenFrom : null,
    electionLockDate: policy ? policy.electionLockDate : null,
    lockedGlobally: policy ? !!policy.lockedGlobally : false,
  };
}

// ── GET /api/hr/me/tax/regime ────────────────────────────────────────────────
async function getRegime(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;

    const countryCode = await resolveStatutoryCountry(businessId, emp);
    if (countryCode && countryCode !== 'IN') {
      return res.status(422).json({ message: 'Tax-regime election is available for India only.', code: 'COUNTRY_UNSUPPORTED' });
    }

    const fy = currentFy();
    const profile = await prisma.statutoryProfile.findFirst({ where: { businessId, employeeId: emp.id } });
    const policy = await regimeService.getPolicy({ businessId, fy });
    const eff = await regimeService.getEffectiveRegime({ businessId, employeeId: emp.id, fy, sp: profile, policy });

    // The OLD-vs-NEW comparison (so the employee elects informed). Best-effort: a
    // missing compensation/declaration must not block the page — fall back to nulls.
    let comparison = null;
    try {
      const cmp = await assembler.buildRegimeComparison({ businessId, employeeId: emp.id });
      comparison = {
        taxYear: cmp.taxYear,
        NEW: cmp.NEW,
        OLD: cmp.OLD,
        betterRegime: cmp.betterRegime,
        elected: cmp.elected,
      };
    } catch (_e) { comparison = null; }

    return res.json({
      employeeId: emp.id,
      countryCode: countryCode || null,
      fy,
      elected: profile && profile.taxRegime ? profile.taxRegime : null,
      effectiveRegime: eff.regime,
      effectiveSource: eff.source, // ELECTED | DEFAULT | STATUTORY
      defaultRegime: policy ? policy.defaultRegime : 'NEW',
      lock: lockView({ profile, policy }),
      comparison,
    });
  } catch (e) { next(e); }
}

// ── PUT /api/hr/me/tax/regime  { regime: 'NEW'|'OLD' } ───────────────────────
async function putRegime(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    // A separated/deactivated employee keeps no write surface.
    if (isSeparatedEmployee(emp)) {
      return res.status(403).json({ message: 'Your account is read-only.' });
    }
    const { businessId } = req.customer;

    const countryCode = await resolveStatutoryCountry(businessId, emp);
    if (countryCode && countryCode !== 'IN') {
      return res.status(422).json({ message: 'Tax-regime election is available for India only.', code: 'COUNTRY_UNSUPPORTED' });
    }

    const fy = currentFy();
    const regime = req.body && req.body.regime;
    const out = await regimeService.electRegime({
      businessId, employeeId: emp.id, fy, regime, actorId: req.customer.id,
    });
    return res.json({ ok: true, ...out });
  } catch (e) {
    const handled = mapRegimeError(res, e);
    if (handled) return handled;
    return next(e);
  }
}

module.exports = { getRegime, putRegime };
