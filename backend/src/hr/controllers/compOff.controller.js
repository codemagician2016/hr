'use strict';

/**
 * compOff.controller.js — Feature 30. Comp-off admin (operator) + ESS surfaces.
 *
 * AVAIL is NOT here — availing a comp-off is an ordinary leave application on the
 * COMP_OFF type via POST /leave/requests (operator) / POST /me/leave/requests (ESS),
 * routed through the UNCHANGED createRequest → engine → consumers.leave seam. This
 * controller covers EARN (grant/approve/reject/void), READ (lots/balance/ledger), and
 * the ops RUN triggers.
 *
 * RBAC (reused verbatim from F1):
 *   - operator reads: withEmployeeScope('canViewEmployees') → scopeWhere(employeeId)
 *   - grant / void / runs: requirePermission('canManageOrg')
 *   - approve / reject: requirePermission('canApproveLeave') + withEmployeeScope
 *   - ESS /me/*: subject resolved ENTIRELY from the customer session (no employeeId
 *     from the client) — SELF_ONLY by construction.
 *
 * Every query is businessId-scoped (tenant isolation); a client-supplied employeeId
 * never widens scope (team reads pass through scopeWhere; /me/* ignores the body).
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const { sumActiveRemaining } = require('../leave/compoff/compOffLots');
const { resolveCompOffType, ensureCompOffType } = require('../leave/compoff/compOffConfig');
const { finalizeCredit, voidCredit } = require('../leave/compoff/finalizeCredit');
const { runCompOffEarn } = require('../leave/compoff/compOffEarnRunner');
const { runCompOffExpiry } = require('../leave/compoff/compOffExpiryRunner');

function toDate(v) {
  const s = typeof v === 'string' ? v : new Date(v).toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00.000Z`);
}
function utcDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}
function addDays(d, n) { return new Date(utcDay(d).getTime() + n * 86400000); }
function remainingOf(c) { return Math.round((Number(c.quantity) - Number(c.consumed)) * 1e4) / 1e4; }

// Shape a credit row for the API (adds derived `remaining`).
function presentCredit(c) {
  return {
    id: c.id, employeeId: c.employeeId, sourceDate: c.sourceDate, sourceKind: c.sourceKind,
    quantity: Number(c.quantity), consumed: Number(c.consumed), remaining: remainingOf(c),
    earnedOn: c.earnedOn, expiresOn: c.expiresOn, status: c.status,
    grantedBy: c.grantedBy, reason: c.reason, attendanceId: c.attendanceId,
    approvalRequestId: c.approvalRequestId, createdAt: c.createdAt,
  };
}

// ── ESS self-resolution (mirrors meLeave.resolveActiveSelfId) ──
async function resolveActiveSelfId(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null }, select: { id: true, isActive: true },
  });
  if (!emp || emp.isActive === false) return null;
  return emp.id;
}
const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// ── ESS: GET /me/comp-off/credits — my lots ──────────────────────────────────
async function listMyCredits(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const where = { businessId, employeeId };
    if (status) where.status = status;
    const credits = await prisma.compOffCredit.findMany({
      where, orderBy: [{ expiresOn: 'asc' }, { earnedOn: 'asc' }], take: 500,
    });
    res.json({ credits: credits.map(presentCredit) });
  } catch (e) { next(e); }
}

// ── ESS: GET /me/comp-off/balance — aggregate closing + soonest expiry ────────
async function myBalance(req, res, next) {
  try {
    const employeeId = await resolveActiveSelfId(req);
    if (!employeeId) return noEmployee(res);
    const { businessId } = req.customer;
    const active = await prisma.compOffCredit.findMany({
      where: { businessId, employeeId, status: 'ACTIVE' },
      select: { quantity: true, consumed: true, expiresOn: true },
      orderBy: { expiresOn: 'asc' },
    });
    const available = sumActiveRemaining(active);
    const soonestExpiry = active.length ? active[0].expiresOn : null;
    res.json({ available, lotCount: active.length, soonestExpiry });
  } catch (e) { next(e); }
}

// ── Operator: GET /comp-off/credits — team/all lots (scoped) ──────────────────
async function listCredits(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, status, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 25));
    const skip = (Math.max(1, parseInt(page, 10) || 1) - 1) * take;
    const where = { businessId, ...scopeWhere(req.scope, 'employeeId') };
    if (employeeId) {
      // A client-supplied employeeId NARROWS but never widens scope.
      if (!scopeAllows(req.scope, employeeId)) return res.status(404).json({ message: 'Not found' });
      where.employeeId = employeeId;
    }
    if (status) where.status = String(status).toUpperCase();
    const [rows, total] = await Promise.all([
      prisma.compOffCredit.findMany({
        where, orderBy: [{ createdAt: 'desc' }], skip, take,
        include: { employee: { select: { id: true, firstName: true, lastName: true } } },
      }),
      prisma.compOffCredit.count({ where }),
    ]);
    res.json({
      credits: rows.map((c) => ({ ...presentCredit(c), employee: c.employee })),
      page: Number(page), pageSize: take, total,
    });
  } catch (e) { next(e); }
}

// ── Operator: GET /comp-off/queue — PENDING earn credits awaiting approval ────
async function listQueue(req, res, next) {
  try {
    const { businessId } = req.user;
    const where = { businessId, status: 'PENDING', ...scopeWhere(req.scope, 'employeeId') };
    const rows = await prisma.compOffCredit.findMany({
      where, orderBy: [{ createdAt: 'asc' }], take: 200,
      include: { employee: { select: { id: true, firstName: true, lastName: true } } },
    });
    res.json({ credits: rows.map((c) => ({ ...presentCredit(c), employee: c.employee })) });
  } catch (e) { next(e); }
}

// ── Operator: POST /comp-off/credits — HR manual grant (HR_GRANT) ─────────────
async function grantCredit(req, res, next) {
  try {
    const { businessId } = req.user;
    const grantedBy = req.user.id || req.user.userId || null;
    const { employeeId, quantity, reason } = req.body || {};
    if (!employeeId || quantity == null) {
      return res.status(400).json({ message: 'employeeId and quantity are required' });
    }
    const qty = Number(quantity);
    if (!(qty > 0)) return res.status(400).json({ message: 'quantity must be positive' });

    const emp = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const typeCtx = await ensureCompOffType(businessId);
    const config = typeCtx.config;
    const sourceDate = req.body.sourceDate ? toDate(req.body.sourceDate) : utcDay(new Date());
    const earnedOn = sourceDate;
    const expiresOn = req.body.expiresOn ? toDate(req.body.expiresOn) : addDays(earnedOn, Number(config.expiryDays) || 60);
    const requireApproval = config.requireApproval !== false && req.body.skipApproval !== true;

    const employment = await prisma.employmentRecord.findFirst({
      where: { businessId, employeeId, isCurrent: true }, select: { entity: { select: { taxYearStartMonth: true } } },
    });
    const taxYearStartMonth = (employment && employment.entity && employment.entity.taxYearStartMonth) || 4;

    const credit = await prisma.$transaction(async (tx) => {
      const c = await tx.compOffCredit.create({
        data: {
          businessId, employeeId, sourceDate: earnedOn, sourceKind: 'HR_GRANT',
          quantity: qty, earnedOn, expiresOn, status: 'PENDING',
          grantedBy, reason: reason || null,
        },
      });
      if (!requireApproval) {
        await finalizeCredit(tx, { credit: c, leaveTypeId: typeCtx.leaveType.id, taxYearStartMonth, decidedBy: grantedBy });
      }
      return c;
    });

    if (requireApproval) {
      try {
        const engine = require('../approvals/engine');
        const ar = await engine.openRequest({
          businessId, module: 'COMP_OFF', entityType: 'CompOffCredit', entityId: credit.id,
          requesterEmployeeId: employeeId,
          payload: { sourceKind: 'HR_GRANT', days: qty, reason: reason || null, expiresOn: expiresOn.toISOString().slice(0, 10) },
          ctx: { entityId: credit.id, days: qty },
        });
        const arId = (ar && ar.approvalRequest && ar.approvalRequest.id) || (ar && ar.id) || null;
        if (arId) await prisma.compOffCredit.update({ where: { id: credit.id }, data: { approvalRequestId: arId } });
      } catch (e) {
        if (e && e.code !== 'P2025') console.error('[comp-off grant] openRequest', credit.id, e.message);
      }
    }
    const fresh = await prisma.compOffCredit.findUnique({ where: { id: credit.id } });
    res.status(201).json(presentCredit(fresh));
  } catch (e) {
    if (e && e.code === 'P2002') return res.status(409).json({ message: 'A comp-off credit already exists for this employee + date', reason: 'DUPLICATE_CREDIT' });
    next(e);
  }
}

// ── Operator: POST /comp-off/credits/:id/approve — approve a PENDING earn ──────
async function approveCredit(req, res, next) {
  try {
    const { businessId } = req.user;
    const credit = await prisma.compOffCredit.findFirst({ where: { id: req.params.id, businessId } });
    if (!credit) return res.status(404).json({ message: 'Comp-off credit not found' });
    if (!scopeAllows(req.scope, credit.employeeId)) return res.status(404).json({ message: 'Comp-off credit not found' });
    if (credit.status !== 'PENDING') return res.status(409).json({ message: `Only a pending credit can be approved (status: ${credit.status})`, reason: 'NOT_PENDING' });
    const decidedBy = req.user.id || req.user.userId || 'SYSTEM';

    // Drive the engine when an approval request exists (fires the COMP_OFF consumer →
    // finalizeCredit). Otherwise finalize directly (a credit created with skipApproval
    // shouldn't reach here, but a missing request must not strand the credit).
    if (credit.approvalRequestId) {
      const engine = require('../approvals/engine');
      await engine.recordDecision({ approvalRequestId: credit.approvalRequestId, actorUserId: decidedBy, decision: 'APPROVED', comment: req.body.comment || null, systemActor: true });
    } else {
      const typeCtx = await resolveCompOffType(businessId);
      if (!typeCtx || !typeCtx.leaveType) return res.status(409).json({ message: 'No comp-off leave type configured', reason: 'NO_COMP_OFF_TYPE' });
      const employment = await prisma.employmentRecord.findFirst({ where: { businessId, employeeId: credit.employeeId, isCurrent: true }, select: { entity: { select: { taxYearStartMonth: true } } } });
      const taxYearStartMonth = (employment && employment.entity && employment.entity.taxYearStartMonth) || 4;
      await prisma.$transaction((tx) => finalizeCredit(tx, { credit, leaveTypeId: typeCtx.leaveType.id, taxYearStartMonth, decidedBy }));
    }
    const fresh = await prisma.compOffCredit.findUnique({ where: { id: credit.id } });
    res.json(presentCredit(fresh));
  } catch (e) { next(e); }
}

// ── Operator: POST /comp-off/credits/:id/reject — reject → VOIDED ─────────────
async function rejectCredit(req, res, next) {
  try {
    const { businessId } = req.user;
    const credit = await prisma.compOffCredit.findFirst({ where: { id: req.params.id, businessId } });
    if (!credit) return res.status(404).json({ message: 'Comp-off credit not found' });
    if (!scopeAllows(req.scope, credit.employeeId)) return res.status(404).json({ message: 'Comp-off credit not found' });
    if (credit.status !== 'PENDING') return res.status(409).json({ message: `Only a pending credit can be rejected (status: ${credit.status})`, reason: 'NOT_PENDING' });
    const decidedBy = req.user.id || req.user.userId || 'SYSTEM';

    if (credit.approvalRequestId) {
      const engine = require('../approvals/engine');
      await engine.recordDecision({ approvalRequestId: credit.approvalRequestId, actorUserId: decidedBy, decision: 'REJECTED', comment: req.body.reason || null, systemActor: true });
    } else {
      await prisma.$transaction((tx) => voidCredit(tx, { credit, decidedBy, reason: req.body.reason || 'Comp-off earn rejected' }));
    }
    const fresh = await prisma.compOffCredit.findUnique({ where: { id: credit.id } });
    res.json(presentCredit(fresh));
  } catch (e) { next(e); }
}

// ── Operator: POST /comp-off/credits/:id/void — HR void an ACTIVE credit ──────
async function voidActiveCredit(req, res, next) {
  try {
    const { businessId } = req.user;
    const credit = await prisma.compOffCredit.findFirst({ where: { id: req.params.id, businessId } });
    if (!credit) return res.status(404).json({ message: 'Comp-off credit not found' });
    const decidedBy = req.user.id || req.user.userId || null;
    const typeCtx = await resolveCompOffType(businessId);
    const leaveTypeId = typeCtx && typeCtx.leaveType ? typeCtx.leaveType.id : null;
    const result = await prisma.$transaction((tx) => voidCredit(tx, { credit, leaveTypeId, decidedBy, reason: req.body.reason || 'HR void' }));
    if (!result.ok) {
      const code = result.reason === 'CONSUMED' ? 409 : 422;
      return res.status(code).json({ message: `Cannot void this credit (${result.reason})`, reason: result.reason });
    }
    const fresh = await prisma.compOffCredit.findUnique({ where: { id: credit.id } });
    res.json(presentCredit(fresh));
  } catch (e) { next(e); }
}

// ── Operator: POST /comp-off/runs/earn — manual earn-runner trigger (ops) ──────
async function runEarn(req, res, next) {
  try {
    const { businessId } = req.user;
    const lookbackDays = req.body && req.body.lookbackDays != null ? Number(req.body.lookbackDays) : undefined;
    const dryRun = !!(req.body && req.body.dryRun);
    const summary = await runCompOffEarn({ businessId, asOf: new Date(), lookbackDays, dryRun });
    res.json(summary);
  } catch (e) { next(e); }
}

// ── Operator: POST /comp-off/runs/expiry — manual expiry-runner trigger (ops) ──
async function runExpiry(req, res, next) {
  try {
    const { businessId } = req.user;
    const dryRun = !!(req.body && req.body.dryRun);
    const summary = await runCompOffExpiry({ businessId, asOf: new Date(), dryRun });
    res.json(summary);
  } catch (e) { next(e); }
}

// ── Operator: GET /comp-off/config — the resolved tenant config (admin UI) ────
async function getConfig(req, res, next) {
  try {
    const { businessId } = req.user;
    const typeCtx = await resolveCompOffType(businessId);
    if (!typeCtx) return res.json({ configured: false });
    res.json({
      configured: true,
      leaveTypeId: typeCtx.leaveType.id, leaveTypeCode: typeCtx.leaveType.code,
      policyId: typeCtx.policy ? typeCtx.policy.id : null, config: typeCtx.config,
    });
  } catch (e) { next(e); }
}

// ── Operator: PUT /comp-off/config — update the comp-off knobs (canManageOrg) ─
async function updateConfig(req, res, next) {
  try {
    const { businessId } = req.user;
    const typeCtx = await ensureCompOffType(businessId);
    if (!typeCtx.policy) return res.status(409).json({ message: 'No comp-off policy to configure', reason: 'NO_POLICY' });
    const body = req.body || {};
    const merged = { ...typeCtx.config, ...body };
    const updated = await prisma.leavePolicy.update({
      where: { id: typeCtx.policy.id }, data: { compOffConfig: merged, version: { increment: 1 } },
    });
    res.json({ ok: true, policyId: updated.id, config: merged });
  } catch (e) { next(e); }
}

module.exports = {
  // ESS
  listMyCredits, myBalance,
  // operator
  listCredits, listQueue, grantCredit, approveCredit, rejectCredit, voidActiveCredit,
  runEarn, runExpiry, getConfig, updateConfig,
};
