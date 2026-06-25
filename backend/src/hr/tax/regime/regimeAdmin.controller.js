'use strict';

/**
 * regimeAdmin.controller.js — Feature 15/25. The HR income-tax REGIME console, mounted
 * at /api/hr/tax/regime-policy + /api/hr/tax/regime. Operator session (req.user); every
 * query is tenant-scoped on businessId (cross-tenant → 404). RBAC mirrors the
 * declaration-window: read = canViewPayrollReports, write (set policy / lock) =
 * canManageStatutory (the policy/lock moves TDS money — a statutory-config concern).
 *
 *   GET  /tax/regime-policy?fy=  → the per-FY employer default + election window + lock.
 *   PUT  /tax/regime-policy       → upsert the policy (default + window + global lock).
 *   GET  /tax/regime?fy=&q=&page= → the PER-EMPLOYEE regime view (elected/effective +
 *                                   lock status), PAGINATED + searchable + F1-scoped.
 *   POST /tax/regime/lock         → lock ONE employee ({employeeId}) or ALL ({all:true})
 *                                   for the FY (the bulk lock when the window closes).
 *   POST /tax/regime/unlock       → clear an employee's lock (HR override).
 *
 * The per-employee list is F1-SCOPED via req.scope (scopeWhere) so a manager only sees
 * their team — identical IDOR discipline to the proofs queue.
 */

const prisma = require('../../../core/lib/prisma');
const { scopeWhere } = require('../../lib/scopeResolver');
const regimeService = require('./regime.service');
const assembler = require('../projectionAssembler');
const payrollService = require('../../payroll/service');

const FY_RE = /^\d{4}-\d{2}$/;

function fyOf(req) {
  const q = typeof req.query.fy === 'string' ? req.query.fy.trim() : '';
  if (FY_RE.test(q)) return q;
  return payrollService._internal.taxYearFor(new Date().toISOString().slice(0, 10), 4);
}

function mapErr(res, e) {
  if (!e || !e.code) return null;
  if (e.code === 'NOT_FOUND') return res.status(404).json({ message: 'Employee not found' });
  if (e.code === 'BAD_REQUEST') return res.status(422).json({ message: e.message, code: e.code });
  return null;
}

function publicPolicy(p, fy) {
  if (!p) {
    return { fy, defaultRegime: 'NEW', electionOpenFrom: null, electionLockDate: null, lockedGlobally: false, exists: false };
  }
  return {
    fy: p.fy,
    defaultRegime: p.defaultRegime,
    electionOpenFrom: p.electionOpenFrom,
    electionLockDate: p.electionLockDate,
    lockedGlobally: !!p.lockedGlobally,
    updatedBy: p.updatedBy || null,
    updatedAt: p.updatedAt,
    version: p.version,
    exists: true,
  };
}

// ── GET /api/hr/tax/regime-policy?fy=2026-27 ─────────────────────────────────
async function getPolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const fy = fyOf(req);
    const policy = await regimeService.getPolicy({ businessId, fy });
    res.json({ policy: publicPolicy(policy, fy) });
  } catch (e) { next(e); }
}

// ── PUT /api/hr/tax/regime-policy ────────────────────────────────────────────
// Body: { fy, defaultRegime, electionOpenFrom, electionLockDate, lockedGlobally }.
async function putPolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const fy = FY_RE.test(String(body.fy || '').trim()) ? String(body.fy).trim() : fyOf(req);
    const saved = await regimeService.setPolicy({
      businessId,
      fy,
      defaultRegime: body.defaultRegime,
      electionOpenFrom: body.electionOpenFrom,
      electionLockDate: body.electionLockDate,
      lockedGlobally: body.lockedGlobally,
      actorId: req.user.id,
    });
    res.json({ policy: publicPolicy(saved, fy) });
  } catch (e) {
    const handled = mapErr(res, e);
    if (handled) return handled;
    return next(e);
  }
}

// ── GET /api/hr/tax/regime?fy=&q=&page=&pageSize= ────────────────────────────
// The per-employee regime view: elected/effective regime + lock status. PAGINATED +
// searchable (name/code) + F1-scoped. India employees only (the regime concept).
async function listEmployeeRegimes(req, res, next) {
  try {
    const { businessId } = req.user;
    const fy = fyOf(req);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);

    const policy = await regimeService.getPolicy({ businessId, fy });
    const defaultRegime = policy ? policy.defaultRegime : 'NEW';

    const where = {
      businessId,
      deletedAt: null,
      isActive: true,
      countryCode: 'IN',
      ...scopeWhere(req.scope, 'id'),
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: 'insensitive' } },
              { lastName: { contains: q, mode: 'insensitive' } },
              { code: { contains: q, mode: 'insensitive' } },
              { workEmail: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({
        where,
        orderBy: [{ firstName: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true, code: true, firstName: true, middleName: true, lastName: true,
          statutoryProfile: { select: { taxRegime: true, regimeLockedAt: true } },
        },
      }),
    ]);

    const items = rows.map((emp) => {
      const sp = emp.statutoryProfile || null;
      const elected = sp && sp.taxRegime ? sp.taxRegime : null;
      const effectiveRegime = elected || defaultRegime || 'NEW';
      return {
        employeeId: emp.id,
        code: emp.code,
        name: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(' ') || emp.code,
        elected,                              // null = un-elected (on the default)
        effectiveRegime,                      // elected else employer default
        effectiveSource: elected ? 'ELECTED' : (policy ? 'DEFAULT' : 'STATUTORY'),
        locked: !!(sp && sp.regimeLockedAt),
        lockedAt: sp && sp.regimeLockedAt ? sp.regimeLockedAt : null,
      };
    });

    res.json({ items, total, page, pageSize, fy, defaultRegime, policy: publicPolicy(policy, fy) });
  } catch (e) { next(e); }
}

// ── POST /api/hr/tax/regime/lock  { employeeId } | { all:true } ──────────────
async function lock(req, res, next) {
  try {
    const { businessId } = req.user;
    const body = req.body || {};
    const all = body.all === true || body.all === 'true';
    const employeeId = typeof body.employeeId === 'string' ? body.employeeId : null;
    if (!all && !employeeId) {
      return res.status(422).json({ message: 'Provide employeeId or all:true' });
    }
    const out = await regimeService.lockRegime({ businessId, employeeId, all });
    res.json({ ok: true, ...out });
  } catch (e) {
    const handled = mapErr(res, e);
    if (handled) return handled;
    return next(e);
  }
}

// ── POST /api/hr/tax/regime/unlock  { employeeId } ───────────────────────────
async function unlock(req, res, next) {
  try {
    const { businessId } = req.user;
    const employeeId = req.body && typeof req.body.employeeId === 'string' ? req.body.employeeId : null;
    if (!employeeId) return res.status(422).json({ message: 'employeeId is required' });
    const out = await regimeService.unlockRegime({ businessId, employeeId });
    res.json({ ok: true, ...out });
  } catch (e) {
    const handled = mapErr(res, e);
    if (handled) return handled;
    return next(e);
  }
}

// ── POST /api/hr/tax/regime/elect  { employeeId, regime } ─ HR elects for an employee.
async function electForEmployee(req, res, next) {
  try {
    const { businessId } = req.user;
    const fy = fyOf(req);
    const body = req.body || {};
    const out = await regimeService.electRegime({
      businessId, employeeId: body.employeeId, fy, regime: body.regime, actorId: req.user.id,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    const handled = mapErr(res, e);
    if (handled) return handled;
    if (e && ['REGIME_LOCKED', 'WINDOW_CLOSED', 'WINDOW_NOT_OPEN', 'GLOBAL_LOCK'].includes(e.code)) {
      return res.status(409).json({ message: e.message, code: e.code });
    }
    return next(e);
  }
}

module.exports = {
  getPolicy, putPolicy, listEmployeeRegimes, lock, unlock, electForEmployee,
  _internals: { publicPolicy, fyOf },
};
