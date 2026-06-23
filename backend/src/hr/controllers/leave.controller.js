'use strict';
// Leave management. Three concerns, one tenant boundary (req.user.businessId):
//   (a) Config CRUD — LeaveType + LeavePolicy (soft-deleted, version-stamped).
//   (b) Request flow — a leave REQUEST is a LeaveTransaction row of
//       txnType=APPLICATION moving through the LeaveTxnStatus state machine
//       PENDING -> APPROVED | REJECTED | CANCELLED. The ledger is APPEND-ONLY:
//       we never delete a row and never rewrite its signed `quantity`; a
//       decision only flips `status`/`decidedAt`/`decidedBy` on the application
//       row and posts the balance effect.
//   (c) Balance read — LeaveBalance is the persisted running balance with a
//       soft-hold (`pendingApproval`) reconstructable from the ledger.
// Every query is scoped by businessId; an employee's rows also filter employeeId.
const prisma = require('../../core/lib/prisma');
const { scopeWhere, scopeAllows } = require('../lib/scopeResolver');
const { resolveApprover } = require('../lib/approvalRouting');
const { computeLeaveUnits, consecutiveCalendarDays } = require('../leave/calendar');
const { validateRequest } = require('../leave/validators');
const ledger = require('../leave/ledger');
const { buildHistory, groupReconciliation } = require('../leave/history');
const { loadApplyContext } = require('../leave/leaveContext');
const { runCarryForward } = require('../leave/accrualRunner');
// Feature 10 slice 10c — leave now routes its terminal decisions through the
// approval-workflow engine. createRequest opens an engine request after the
// soft-hold; approve/reject/cancel drive engine.recordDecision/engine.cancel, which
// fire the LEAVE consumer callbacks (the SAME decideTerminal/soft-hold-release logic,
// now living in consumers.leave.js). For a directly-created APPLICATION row (e.g.
// admin/test fixtures with no engine request) the controller falls back to the
// identical balance-move core directly, so behaviour is byte-identical either way.
const engine = require('../approvals/engine');
const leaveConsumer = require('../approvals/consumers.leave');

// ── Config allow-lists (never spread req.body) ──────────────────────────────
const LEAVE_TYPE_FIELDS = [
  'countryCode', 'code', 'name', 'category', 'unit', 'isPaid', 'isStatutory',
  'nzPayBasis', 'requiresReason', 'affectsLOP', 'isEncashable', 'sandwichPolicy',
  'color', 'isActive',
];
const LEAVE_POLICY_FIELDS = [
  'leaveTypeId', 'entityId', 'code', 'name', 'accrualMethod', 'entitlementPerYear',
  'statutoryFloorPerYear', // Feature 16 — as-authored India floor stamp
  'accrualFrequency', 'accrualProrateOnJoin', 'carryForwardCap', 'carryForwardExpiryMonths',
  'maxBalanceCap', 'maxConsecutive', 'minNoticeDays', 'allowNegative', 'negativeCap',
  'minTenureMonths', 'appliesToEmploymentTypes', 'genderRestriction', 'encashOnExit',
  'encashFormula', 'maxEncashCap', 'workflowDefinitionId', 'isActive',
];

// Feature 16 — the India statutory-leave floor resolver lives in the IN compliance
// module (effective-dated, per state), exactly like professional-tax. We require it
// directly (the leave config gate is India-only; an NZ tenant never hits the floor
// gate because NZ types carry no EL/SL/CL category floor).
const indiaModule = require('../payroll/compliance/india');

const DUP_MSG = 'A record with that code already exists';

// Map a config-validation error (string code or {code,message,...}) to an HTTP
// response. Floor/coherence violations are 422 (semantically invalid config).
function sendConfigError(res, err) {
  const obj = typeof err === 'string' ? { code: err } : (err || {});
  const messages = {
    INCOHERENT_LEAVE_TYPE: 'A paid leave type cannot also reduce pay (affectsLOP). Use an UNPAID type for Leave Without Pay.',
    LEAVE_BELOW_STATUTORY_FLOOR: obj.message || 'Entitlement is below the statutory floor for this state/category.',
    LWP_NO_ENTITLEMENT: obj.message || 'A Leave-Without-Pay / no-accrual policy must not have an entitlement.',
  };
  return res.status(422).json({ ...obj, reason: obj.code, message: obj.message || messages[obj.code] || 'Invalid leave configuration' });
}

function picker(fields, dates = []) {
  return (body) => {
    const out = {};
    for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
    for (const d of dates) if (out[d] != null) out[d] = new Date(out[d]);
    return out;
  };
}

// ── Feature 16 — leave-config coherence + India statutory-floor gates ────────

// Coerce LeaveType flag coherence (UNPAID ⇒ isPaid=false ∧ affectsLOP=true) and
// reject an incoherent paid-but-affectsLOP type. Mutates `body` in place to
// SERVER-FORCE the unpaid invariants. Returns an error code string or null.
function validateLeaveTypeBody(body, existing = {}) {
  const category = body.category != null ? body.category : existing.category;
  const isPaid = body.isPaid != null ? body.isPaid : existing.isPaid;
  const affectsLOP = body.affectsLOP != null ? body.affectsLOP : existing.affectsLOP;

  if (category === 'UNPAID') {
    // Server-FORCE the unpaid invariants so an admin can't accidentally make LWP paid.
    body.isPaid = false;
    body.affectsLOP = true;
    if (body.sandwichPolicy == null && existing.sandwichPolicy == null) {
      // A public holiday inside an unpaid block must NOT become unpaid → EXCLUSIVE.
      body.sandwichPolicy = 'EXCLUSIVE';
    }
    return null;
  }
  // A PAID type that also reduces pay (affectsLOP) is incoherent (it would both pay
  // the day AND dock it). Block it.
  if (isPaid === true && affectsLOP === true) {
    return 'INCOHERENT_LEAVE_TYPE';
  }
  return null;
}

// India statutory-floor gate for a LeavePolicy. Re-resolves the floor LIVE from
// india.leaveStatutoryFramework (effective-dated, per state) so a floor change
// re-validates; granting ABOVE the floor is always allowed. LWP/NONE policies must
// carry no entitlement. Returns { code, ... } or null. Reads the leave type +
// (optional) entity state to resolve the floor. India-only (NZ types have no
// EL/SL/CL category → resolveLeaveFloor returns null → no gate).
async function validateLeavePolicyBody(businessId, body, existing = {}) {
  const leaveTypeId = body.leaveTypeId || existing.leaveTypeId;
  const accrualMethod = body.accrualMethod || existing.accrualMethod;
  const entitlement = body.entitlementPerYear != null ? Number(body.entitlementPerYear) : null;

  const type = leaveTypeId
    ? await prisma.leaveType.findFirst({ where: { id: leaveTypeId, businessId, deletedAt: null } })
    : null;

  // LWP / NONE-accrual policy: never carries an entitlement or accrues a balance.
  if (accrualMethod === 'NONE' || (type && type.category === 'UNPAID')) {
    if (entitlement != null && entitlement > 0) {
      return { code: 'LWP_NO_ENTITLEMENT', message: 'A Leave-Without-Pay / no-accrual policy must not have an entitlementPerYear.' };
    }
    return null;
  }

  // Resolve the entity's state (PT state / address state) to pick the floor.
  let stateCode = null;
  const entityId = body.entityId || existing.entityId;
  if (entityId) {
    const entity = await prisma.entity.findFirst({
      where: { id: entityId, businessId }, select: { stateCode: true, countryCode: true },
    });
    if (entity && entity.countryCode !== 'IN') return null; // floor gate is India-only
    stateCode = entity ? entity.stateCode : null;
  }

  if (!type) return null;
  const floor = indiaModule.resolveLeaveFloor(stateCode, type.category, new Date().toISOString().slice(0, 10));
  if (floor == null) return null; // no statutory floor for this category (e.g. NZ/COMP_OFF)

  // Stamp the as-authored floor for audit.
  body.statutoryFloorPerYear = floor;

  if (entitlement != null && entitlement < floor) {
    return {
      code: 'LEAVE_BELOW_STATUTORY_FLOOR',
      message: `Entitlement ${entitlement} is below the statutory floor of ${floor} day(s)/yr for ${type.category} in ${stateCode || 'this state'}.`,
      floor, given: entitlement, stateCode, category: type.category,
    };
  }
  return null;
}

// ── Config CRUD factory (LeaveType, LeavePolicy) ────────────────────────────
// Mirrors org.controller's crud(): tenant-scoped, soft-deleted, P2002 -> 409.
// `validate(body, { businessId, existing })` (optional) runs BEFORE create/update;
// it may MUTATE body (server-forced coherence) and returns an error {code,message}
// (or string) to reject with 400/409, or null to proceed.
function configCrud(model, { fields, required = [], validate = null } = {}) {
  const pick = picker(fields);
  return {
    list: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const items = await prisma[model].findMany({
          where: { businessId, deletedAt: null },
          orderBy: { createdAt: 'desc' },
        });
        res.json({ items });
      } catch (e) { next(e); }
    },
    get: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const item = await prisma[model].findFirst({
          where: { id: req.params.id, businessId, deletedAt: null },
        });
        if (!item) return res.status(404).json({ message: 'Not found' });
        res.json(item);
      } catch (e) { next(e); }
    },
    create: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        for (const r of required) {
          if (req.body[r] === undefined || req.body[r] === null || req.body[r] === '') {
            return res.status(400).json({ message: `${r} is required` });
          }
        }
        if (validate) {
          const err = await validate(req.body, { businessId, existing: {} });
          if (err) return sendConfigError(res, err);
        }
        const item = await prisma[model].create({ data: { ...pick(req.body), businessId } });
        res.status(201).json(item);
      } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
    },
    update: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const existing = await prisma[model].findFirst({
          where: { id: req.params.id, businessId, deletedAt: null },
        });
        if (!existing) return res.status(404).json({ message: 'Not found' });
        if (validate) {
          const err = await validate(req.body, { businessId, existing });
          if (err) return sendConfigError(res, err);
        }
        const item = await prisma[model].update({ where: { id: req.params.id }, data: pick(req.body) });
        res.json(item);
      } catch (e) { if (e.code === 'P2002') return res.status(409).json({ message: DUP_MSG }); next(e); }
    },
    remove: async (req, res, next) => {
      try {
        const { businessId } = req.user;
        const existing = await prisma[model].findFirst({
          where: { id: req.params.id, businessId, deletedAt: null },
        });
        if (!existing) return res.status(404).json({ message: 'Not found' });
        await prisma[model].update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
        res.status(204).end();
      } catch (e) { next(e); }
    },
  };
}

const leaveTypes = configCrud('leaveType', {
  fields: LEAVE_TYPE_FIELDS,
  required: ['code', 'name', 'category'],
  // Feature 16 — coherence: UNPAID ⇒ isPaid=false ∧ affectsLOP=true (server-forced);
  // a paid type with affectsLOP=true is rejected (INCOHERENT_LEAVE_TYPE).
  validate: (body, { existing }) => validateLeaveTypeBody(body, existing),
});
const leavePolicies = configCrud('leavePolicy', {
  fields: LEAVE_POLICY_FIELDS,
  required: ['leaveTypeId', 'code', 'name', 'accrualMethod'],
  // Feature 16 — India statutory-floor gate (re-resolved live) + LWP_NO_ENTITLEMENT.
  validate: (body, { businessId, existing }) => validateLeavePolicyBody(businessId, body, existing),
});

// Feature 16 — GET /statutory-framework?stateCode= — the resolved EL/SL/CL floors
// for the admin "Statutory framework" panel. India-only (404 for non-IN tenants);
// pure read from india.leaveStatutoryFramework (effective-dated, per state).
async function getStatutoryFramework(req, res, next) {
  try {
    const { businessId } = req.user;
    // India-only: gate on the tenant's HR country (Feature 14 single-country lock).
    const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { hrCountry: true } });
    if (biz && biz.hrCountry && biz.hrCountry !== 'IN') {
      return res.status(404).json({ message: 'Statutory leave framework is India-only', reason: 'NOT_INDIA_TENANT' });
    }
    const stateCode = req.query.stateCode || null;
    const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
    const framework = indiaModule.resolveLeaveFramework(stateCode, asOf);
    res.json(framework);
  } catch (e) { next(e); }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE REQUEST FLOW  (LeaveTransaction, txnType = APPLICATION)
// State machine over LeaveTxnStatus: PENDING -> APPROVED | REJECTED | CANCELLED.
// ─────────────────────────────────────────────────────────────────────────────

// 409 reason codes that map to a conflict rather than a 400 (balance/overlap).
const CONFLICT_CODES = new Set(['INSUFFICIENT_BALANCE', 'NEGATIVE_CAP_EXCEEDED', 'OVERLAPPING_LEAVE']);

function toDate(v) {
  // accept "YYYY-MM-DD" (Zod-validated) → midnight-UTC @db.Date
  const s = typeof v === 'string' ? v : new Date(v).toISOString().slice(0, 10);
  return new Date(`${s}T00:00:00.000Z`);
}

// POST /requests — employee applies for leave. Working-day-aware (calendar.js,
// reusing the attendance derive.js resolvers so leave & attendance agree on a
// working day), policy-gated (validators.js), overlap-checked, then creates a
// PENDING APPLICATION ledger row (signed −units) and soft-holds the units on the
// balance's pendingApproval bucket. Append-only; the ledger is the source of truth.
async function createRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, leaveTypeId, startDate, endDate } = req.body;
    if (!employeeId || !leaveTypeId || !startDate || !endDate) {
      return res.status(400).json({ message: 'employeeId, leaveTypeId, startDate and endDate are required' });
    }

    const startHalf = req.body.startHalf || null;
    const endHalf = req.body.endHalf || null;
    const isAdvance = req.body.isAdvance === true;
    const asOf = new Date();

    // Assemble the context the pure engines need (employee/shift/holidays/policy/
    // balance/overlap). Mirrors attendance/service.js resolution.
    const ctx = await loadApplyContext({ businessId, employeeId, leaveTypeId, startDate, endDate, asOf });
    if (!ctx.employee) return res.status(404).json({ message: 'Employee not found' });
    if (!ctx.leaveType) return res.status(404).json({ message: 'Leave type not found' });

    // Working-day netting (replaces the naive spanDays that charged weekends/holidays).
    const netted = computeLeaveUnits(
      { startDate, endDate, startHalf, endHalf },
      { employee: ctx.employee, leaveType: ctx.leaveType, weeklyOffDays: ctx.weeklyOffDays, holidays: ctx.holidays },
    );
    const units = netted.units;
    if (units == null || units <= 0) {
      return res.status(400).json({ message: 'The request spans no working days (or endDate precedes startDate)' });
    }

    // Policy gates → structured reason codes.
    const verdict = validateRequest({
      request: { startDate, endDate, startHalf, endHalf, reason: req.body.reason },
      units,
      consecutiveDays: consecutiveCalendarDays({ startDate, endDate }),
      policy: ctx.policy,
      leaveType: ctx.leaveType,
      balance: ctx.balance,
      employee: ctx.employee,
      overlapping: ctx.overlapping,
      asOf,
      isAdvance,
    });
    if (!verdict.ok) {
      const first = verdict.errors[0];
      const status = CONFLICT_CODES.has(first.code) ? 409 : 400;
      return res.status(status).json({ message: first.message, reason: first.code, errors: verdict.errors });
    }

    // Feature 16 — LWP / UNPAID is the ONE type that applies with NO balance: it
    // has no LeaveBalance row (accrualMethod NONE → never minted), so there is
    // nothing to draw from or soft-hold. We take the NO-BALANCE branch explicitly
    // (leaveBalanceId=null, no pendingApproval hold), keeping quantity=-units for
    // audit/reporting only. A defensive assertion: an UNPAID apply must NEVER touch
    // a LeaveBalance (a bug that held a non-existent balance would otherwise corrupt
    // a paid type's row that happened to be returned by the newest-balance fallback).
    const isUnpaidLwp = ctx.leaveType.category === 'UNPAID' || ctx.leaveType.affectsLOP === true;
    const balance = isUnpaidLwp ? null : ctx.balance;
    const start = toDate(startDate);
    const end = toDate(endDate);

    const txn = await prisma.$transaction(async (tx) => {
      const created = await tx.leaveTransaction.create({
        data: {
          businessId,
          employeeId,
          leaveTypeId,
          leaveBalanceId: balance ? balance.id : null,
          txnType: 'APPLICATION',
          unit: ctx.leaveType.unit,
          quantity: -units, // signed: application consumes balance (audit only for LWP)
          startDate: start,
          endDate: end,
          startHalf,
          endHalf,
          reason: req.body.reason || null,
          status: 'PENDING',
          appliedAt: new Date(),
        },
      });
      // Soft-hold the requested units so concurrent requests see them reserved.
      // version optimistic-lock: a concurrent apply that raced our read fails and
      // retries against the reduced available (QA 11). LWP has no balance → skipped.
      if (balance) {
        await tx.leaveBalance.update({
          where: { id: balance.id, version: balance.version },
          data: { pendingApproval: { increment: units }, version: { increment: 1 } },
        });
      }

      // Feature 10 §7.5 — open the approval-engine request (after the soft-hold), in
      // the SAME tx. For a zero-config tenant this resolves the BUILT_IN_DEFAULT LEAVE
      // chain (manager → escalate@48h) — the SAME approver routing as today — and stays
      // PENDING until the manager decides. On a tiny tenant where the SoD-collapse
      // cascade auto-approves on open, the onApprove callback fires here and moves the
      // balance atomically (the "approved immediately" outcome). ctx carries the
      // routing dimensions the engine/conditions read; payload is the approver view.
      await engine.openRequest({
        businessId,
        module: 'LEAVE',
        entityType: 'LeaveTransaction',
        entityId: created.id,
        requesterEmployeeId: created.employeeId,
        payload: {
          leaveType: ctx.leaveType.code,
          leaveTypeId,
          startDate,
          endDate,
          days: units,
          reason: req.body.reason || null,
        },
        ctx: {
          entityId: created.id,
          days: units,
          departmentId: (ctx.employee && ctx.employee.departmentId) || null,
          employeeLevel: (ctx.employee && ctx.employee.gradeId) || null,
        },
      }, tx);

      return created;
    });

    res.status(201).json({ ...txn, dayBreakdown: netted.dayBreakdown, units });
  } catch (e) {
    // optimistic-lock miss (P2025) → the balance moved under us; tell the client to retry.
    if (e && e.code === 'P2025') {
      return res.status(409).json({ message: 'Balance changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// GET /requests — paginated list of APPLICATION rows, tenant-scoped; optional
// employeeId / status / leaveTypeId filters.
//
// Feature 1: the list is filtered to the actor's reporting sub-tree via
// scopeWhere(req.scope, 'employeeId'). A client-supplied ?employeeId is NEVER
// trusted to widen scope — it is only honored when that employee is already in
// the actor's scope; otherwise the request returns empty (closes the audited IDOR).
async function listRequests(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, status, leaveTypeId, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;

    // AND the hierarchical scope (Manager → their reporting sub-tree only).
    const where = { businessId, txnType: 'APPLICATION', ...scopeWhere(req.scope, 'employeeId') };
    if (employeeId) {
      // Only honor a client-supplied employeeId when it is within scope; otherwise
      // return an empty result set rather than widening access.
      if (!scopeAllows(req.scope, employeeId)) {
        return res.json({ items: [], total: 0, page: pageNum, pageSize: take });
      }
      where.employeeId = employeeId;
    }
    if (leaveTypeId) where.leaveTypeId = leaveTypeId;
    if (status) where.status = status;

    // Resolve the applicant + leave-type so the admin list renders human names
    // (and the type label) instead of raw UUIDs (audit #16).
    const [items, total] = await Promise.all([
      prisma.leaveTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, code: true } },
          leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } },
        },
      }),
      prisma.leaveTransaction.count({ where }),
    ]);
    res.json({ items, total, page: pageNum, pageSize: take });
  } catch (e) { next(e); }
}

async function getRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await prisma.leaveTransaction.findFirst({
      where: { id: req.params.id, businessId, txnType: 'APPLICATION' },
      include: {
        employee: { select: { id: true, firstName: true, lastName: true, code: true } },
        leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } },
      },
    });
    if (!txn) return res.status(404).json({ message: 'Leave request not found' });
    // Feature 1: out-of-scope applicant → 404 (IDOR-safe; don't reveal existence).
    if (!scopeAllows(req.scope, txn.employeeId)) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    res.json(txn);
  } catch (e) { next(e); }
}

// Shared guard + balance-release for terminal transitions. Returns the loaded
// PENDING application row, or sends the appropriate error response.
//
// Feature 1: `enforceScope` (set for approve/reject) re-resolves the decision
// scope server-side. The canApproveLeave scope excludes the actor (separation of
// duties) and is bounded to their reporting sub-tree, so an out-of-scope
// applicant — a peer, someone outside the team, or the approver themselves — is
// 404'd here (IDOR-safe; never trust a client-supplied employeeId to widen scope).
async function loadPendingApplication(req, res, businessId, { enforceScope = false } = {}) {
  const txn = await prisma.leaveTransaction.findFirst({
    where: { id: req.params.id, businessId, txnType: 'APPLICATION' },
  });
  if (!txn) { res.status(404).json({ message: 'Leave request not found' }); return null; }
  if (enforceScope && !scopeAllows(req.scope, txn.employeeId)) {
    res.status(404).json({ message: 'Leave request not found' });
    return null;
  }
  if (txn.status !== 'PENDING') {
    res.status(409).json({ message: `Cannot transition a request in status ${txn.status}` });
    return null;
  }
  return txn;
}

// Separation of duties (finding #3): an approver may never act on their OWN
// leave. The canApproveLeave scope already excludes self, but we fail-closed here
// too so a mis-scoped route can't slip a self-decision through. Returns true when
// the decision is blocked (and has sent the 404 — IDOR-safe, don't reveal it).
function blockSelfDecision(req, res, txn) {
  const actorEmp = req.user && req.user.employeeId;
  if (actorEmp && actorEmp === txn.employeeId) {
    res.status(404).json({ message: 'Leave request not found' });
    return true;
  }
  return false;
}

// The shared guarded terminal transition (conditional status flip + version-locked
// balance move) that approve/reject/cancel apply lives — since slice 10c — in
// consumers.leave.js#applyLeaveDecision, so the engine consumer and the controller's
// direct (no-engine-request) path share ONE body and cannot drift. The controller
// reaches it via driveTerminalDecision (engine path) / leaveConsumer.applyLeaveDecision
// (direct path).

// pendingApproval can never go below zero — floor the release so a duplicated
// decision (or a stale hold) cannot over-state `available` (finding #3).
function flooredRelease(current, qty) {
  const floored = Math.min(qty, Math.max(0, Number(current || 0)));
  return floored;
}

// Map the guarded-transition races to a 409 the client can retry.
function isDecisionRace(e) {
  return e && (e.code === 'DECISION_RACE' || e.code === 'P2025' || e.code === 'CONCURRENT_UPDATE');
}

// Find the OPEN approval-engine request gating this LeaveTransaction (if leave was
// applied via createRequest after slice 10c). Returns null for a directly-created
// APPLICATION row (admin/fixtures) — the controller then uses the legacy direct path.
async function findOpenApprovalRequest(businessId, txnId, tx) {
  const db = tx || prisma;
  return db.approvalRequest.findFirst({
    where: { businessId, module: 'LEAVE', entityType: 'LeaveTransaction', entityId: txnId, status: { in: ['PENDING', 'ESCALATED'] } },
  });
}

/**
 * driveTerminalDecision — the single seam through which approve/reject/cancel apply
 * their terminal transition. The route's RBAC + F1 sub-tree scope + SoD self-block
 * are the AUTHORITATIVE authorization boundary (proven before we get here), exactly
 * as before slice 10c; this helper only chooses HOW the balance effect is applied:
 *
 *   (a) ENGINE PATH — an open ApprovalRequest exists (leave was applied via
 *       createRequest). Drive engine.recordDecision (APPROVED/REJECTED) or
 *       engine.cancel (CANCELLED) as a TRUSTED systemActor (the controller already
 *       authorized the actor; the engine's own approver-membership gate would
 *       otherwise reject a route-authorized HR/admin actor who isn't literally in the
 *       resolved set). The engine fires the LEAVE consumer's onApprove/onReject/
 *       onCancel callback, which carries the SAME decideTerminal/soft-hold-release
 *       balance move. We then return the freshly-decided LeaveTransaction.
 *
 *   (b) DIRECT PATH — no engine request (directly-created row). Run the identical
 *       balance-move core (leaveConsumer.applyLeaveDecision == the old decideTerminal)
 *       directly, in one tx. Byte-identical outcome.
 *
 * Either way a lost race / concurrent move bubbles a DECISION_RACE / P2025 /
 * CONCURRENT_UPDATE the caller maps to 409 via isDecisionRace.
 */
async function driveTerminalDecision({ businessId, txn, decision, toStatus, decidedBy, reason, balanceMove }) {
  const open = await findOpenApprovalRequest(businessId, txn.id);
  if (open) {
    // Engine path. Stamp decidedBy + (for reject) the reason into the request so the
    // consumer callback can read them, then drive the matching engine transition.
    if (decision === 'CANCELLED') {
      await engine.cancel({ approvalRequestId: open.id, actorUserId: decidedBy || 'REQUESTER', comment: reason || null });
    } else {
      if (reason !== undefined && reason !== null) {
        await prisma.approvalRequest.update({
          where: { id: open.id },
          data: { payloadJson: { ...(open.payloadJson || {}), rejectReason: reason }, decidedBy: decidedBy || null },
        });
      } else if (decidedBy) {
        await prisma.approvalRequest.update({ where: { id: open.id }, data: { decidedBy } });
      }
      await engine.recordDecision({ approvalRequestId: open.id, actorUserId: decidedBy || 'SYSTEM', decision, comment: reason || null, systemActor: true });
    }
    // The consumer flipped the LeaveTransaction inside the engine tx; return it fresh.
    // For a multi-level chain not yet terminal, the row stays PENDING (the decision
    // advanced the chain) — the response then reflects the still-open application.
    return prisma.leaveTransaction.findUnique({ where: { id: txn.id } });
  }

  // Direct path (no engine request) — identical balance-move core, in one tx.
  return prisma.$transaction(async (tx) => leaveConsumer.applyLeaveDecision(tx, {
    txn, toStatus, fromStatuses: ['PENDING'], decidedBy, reason, balanceMove,
  }));
}

// POST /requests/:id/approve — PENDING -> APPROVED. Moves the soft-hold into
// `taken` and decrements `closing`. The ledger row is NOT rewritten beyond its
// terminal status + decision metadata (append-only invariant preserved).
async function approveRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await loadPendingApplication(req, res, businessId, { enforceScope: true });
    if (!txn) return;
    // SoD: an approver may never approve their own leave (finding #3).
    if (blockSelfDecision(req, res, txn)) return;

    // Feature 1 (approval routing): the canonical approver for this application is
    // the applicant's manager (escalating up the chain to an HR-Admin fallback).
    // The scope guard above already proved this actor is allowed to act on the
    // applicant's sub-tree and is not the applicant (SoD); resolveApprover is the
    // single source of truth for *who* the request routes to (used by the ESS
    // inbox + notifications). We surface it as decision provenance, not a second
    // gate — the sub-tree scope is the authoritative authorization boundary.
    const applicant = await prisma.employee.findFirst({
      where: { id: txn.employeeId, businessId, deletedAt: null },
      select: { id: true, managerEmployeeId: true, businessId: true },
    });
    await resolveApprover(applicant); // eslint-disable-line no-unused-vars — provenance/guard hook

    const heldQty = Math.abs(Number(txn.quantity));
    const decidedBy = req.user.id || req.user.userId || null;

    const updated = await driveTerminalDecision({
      businessId, txn, decision: 'APPROVED', toStatus: 'APPROVED', decidedBy,
      // Release the hold and post the consumption under the version lock. closing
      // is the persisted derived figure (opening+accrued-taken-encashed-lapsed+/-adjusted).
      balanceMove: (bal) => {
        const release = flooredRelease(bal.pendingApproval, heldQty);
        return {
          pendingApproval: { decrement: release },
          taken: { increment: heldQty },
          closing: { decrement: heldQty },
        };
      },
    });

    res.json(updated);
  } catch (e) {
    if (isDecisionRace(e)) {
      return res.status(409).json({ message: 'Request changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// POST /requests/:id/reject — PENDING -> REJECTED. Releases the soft-hold; no
// units are consumed.
async function rejectRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await loadPendingApplication(req, res, businessId, { enforceScope: true });
    if (!txn) return;
    // SoD: an approver may never reject their own leave (finding #3).
    if (blockSelfDecision(req, res, txn)) return;

    const heldQty = Math.abs(Number(txn.quantity));
    const decidedBy = req.user.id || req.user.userId || null;

    const updated = await driveTerminalDecision({
      businessId, txn, decision: 'REJECTED', toStatus: 'REJECTED', decidedBy,
      reason: req.body.reason || txn.reason,
      // Release the hold (floored); no units are consumed.
      balanceMove: (bal) => ({ pendingApproval: { decrement: flooredRelease(bal.pendingApproval, heldQty) } }),
    });

    res.json(updated);
  } catch (e) {
    if (isDecisionRace(e)) {
      return res.status(409).json({ message: 'Request changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// POST /requests/:id/cancel — PENDING -> CANCELLED (withdrawal before decision).
// Releases the soft-hold.
async function cancelRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await loadPendingApplication(req, res, businessId);
    if (!txn) return;

    const heldQty = Math.abs(Number(txn.quantity));
    const decidedBy = req.user.id || req.user.userId || null;

    const updated = await driveTerminalDecision({
      businessId, txn, decision: 'CANCELLED', toStatus: 'CANCELLED', decidedBy,
      // Release the soft-hold (floored, version-locked).
      balanceMove: (bal) => ({ pendingApproval: { decrement: flooredRelease(bal.pendingApproval, heldQty) } }),
    });

    res.json(updated);
  } catch (e) {
    if (isDecisionRace(e)) {
      return res.status(409).json({ message: 'Request changed concurrently; please retry', reason: 'CONCURRENT_UPDATE' });
    }
    next(e);
  }
}

// ── Balance read ────────────────────────────────────────────────────────────
// GET /employees/:employeeId/balances — current leave balances for an employee,
// scoped by businessId + employeeId. Optional leaveTypeId / periodCode filters.
async function listEmployeeBalances(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, businessId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const where = { businessId, employeeId };
    if (req.query.leaveTypeId) where.leaveTypeId = req.query.leaveTypeId;
    if (req.query.periodCode) where.periodCode = req.query.periodCode;

    const rows = await prisma.leaveBalance.findMany({
      where,
      include: { leaveType: { select: { id: true, code: true, name: true, category: true, unit: true, color: true } } },
      orderBy: [{ leaveTypeId: 'asc' }, { periodCode: 'desc' }],
    });
    // Surface `available = closing − pendingApproval` so the ESS card no longer
    // has to guess at a non-existent key (the §9.7 bug). The raw buckets stay so
    // the breakdown (opening/accrued/taken/pendingApproval/lapsed) renders too.
    const items = rows.map((b) => ({
      ...b,
      available: ledger.available(b, {}),
    }));
    res.json({ items });
  } catch (e) { next(e); }
}

// ── Employee leave history (operator, scope-guarded) ─────────────────────────
// GET /employees/:employeeId/history?leaveTypeId=&periodCode= — the full
// chronological leave history for ONE employee (every request decision AND every
// ledger movement — accrued/taken/encashed/lapsed/adjusted), shaped into a
// plain-English, signed-delta feed with a running balance.
//
// Feature 1: the route mounts withEmployeeScope('canViewEmployees'); we 404 when
// the target employee is OUTSIDE the actor's reporting sub-tree (IDOR-safe — don't
// reveal existence), mirroring getRequest/requestHistory.
async function employeeHistory(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, businessId, deletedAt: null },
      select: { id: true },
    });
    // out-of-tenant OR out-of-scope → 404 (don't reveal existence).
    if (!employee || !scopeAllows(req.scope, employeeId)) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const where = { businessId, employeeId };
    if (req.query.leaveTypeId) where.leaveTypeId = req.query.leaveTypeId;
    if (req.query.periodCode) {
      const lots = await prisma.leaveBalance.findMany({
        where: { businessId, employeeId, periodCode: req.query.periodCode },
        select: { id: true },
      });
      where.leaveBalanceId = { in: lots.map((l) => l.id) };
    }

    const rows = await prisma.leaveTransaction.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 1000,
      include: { leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } } },
    });
    const items = buildHistory(rows).reverse(); // newest-first for display
    res.json({ items });
  } catch (e) { next(e); }
}

// ── Employee leave reconciliation (operator, scope-guarded) ──────────────────
// GET /employees/:employeeId/reconciliation?periodCode=&leaveTypeId= — a
// reconciliation STATEMENT per (leaveType) for the chosen period that visibly
// BALANCES: opening + accrued − taken − encashed − lapsed + adjusted = closing.
//
// The components are recomputed from the LeaveTransaction ledger (the source of
// truth) and cross-checked against the persisted LeaveBalance.closing; any drift
// is flagged (`reconciled:false`). Feature 1 scope-guarded like employeeHistory.
async function employeeReconciliation(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId } = req.params;
    const { periodCode, leaveTypeId } = req.query;
    if (!periodCode) return res.status(400).json({ message: 'periodCode is required' });

    const employee = await prisma.employee.findFirst({
      where: { id: employeeId, businessId, deletedAt: null },
      select: { id: true },
    });
    if (!employee || !scopeAllows(req.scope, employeeId)) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    // The persisted balance lots for this period (the projection we audit against).
    const balWhere = { businessId, employeeId, periodCode };
    if (leaveTypeId) balWhere.leaveTypeId = leaveTypeId;
    const balances = await prisma.leaveBalance.findMany({
      where: balWhere,
      include: { leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } } },
    });

    // Ledger rows for exactly those lots (period-scoped via leaveBalanceId), so the
    // reconstruction matches the persisted lot field-by-field.
    const lotIds = balances.map((b) => b.id);
    const txns = lotIds.length
      ? await prisma.leaveTransaction.findMany({
          where: { businessId, employeeId, leaveBalanceId: { in: lotIds } },
          include: { leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } } },
        })
      : [];

    const leaveTypeById = new Map(
      balances.filter((b) => b.leaveType).map((b) => [b.leaveTypeId, b.leaveType]),
    );
    const groups = groupReconciliation(txns, balances, leaveTypeById);
    res.json({ periodCode, employeeId, items: groups });
  } catch (e) { next(e); }
}

// ── (NEW endpoints, §4.8) ────────────────────────────────────────────────────

// GET /me/requests — ESS self-list of own requests. employeeId from the
// attachSelfEmployee anchor; never widened by a client-supplied id (no scope).
async function listMyRequests(req, res, next) {
  try {
    const { businessId } = req.user;
    const employeeId = req.user.employeeId;
    if (!employeeId) return res.json({ items: [], total: 0, page: 1, pageSize: 25 });
    const { status, page = '1', pageSize = '25' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 25, 1), 100);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * take;

    const where = { businessId, employeeId, txnType: 'APPLICATION' };
    if (status) where.status = status;
    const [items, total] = await Promise.all([
      prisma.leaveTransaction.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take,
        include: { leaveType: { select: { id: true, code: true, name: true, color: true, unit: true } } },
      }),
      prisma.leaveTransaction.count({ where }),
    ]);
    res.json({ items, total, page: pageNum, pageSize: take });
  } catch (e) { next(e); }
}

// GET /calendar?from&to&entityId&leaveTypeId&includePending — org/team leave
// calendar, scope-filtered server-side (canViewEmployees sub-tree).
async function leaveCalendar(req, res, next) {
  try {
    const { businessId } = req.user;
    const { from, to, leaveTypeId, includePending } = req.query;
    const statuses = includePending === 'true' || includePending === true
      ? ['PENDING', 'APPROVED', 'AVAILED']
      : ['APPROVED', 'AVAILED'];

    const where = {
      businessId, txnType: 'APPLICATION', status: { in: statuses },
      ...scopeWhere(req.scope, 'employeeId'),
    };
    if (leaveTypeId) where.leaveTypeId = leaveTypeId;
    if (from) where.endDate = { gte: new Date(`${from}T00:00:00.000Z`) };
    if (to) where.startDate = { ...(where.startDate || {}), lte: new Date(`${to}T00:00:00.000Z`) };

    const items = await prisma.leaveTransaction.findMany({
      where,
      orderBy: { startDate: 'asc' },
      take: 1000,
      include: {
        leaveType: { select: { id: true, code: true, name: true, color: true } },
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// GET /requests/:id/history — per-request audit trail (the application row +
// any reversing ADJUSTMENT it spawned). Scope-guarded (404 if out of sub-tree).
async function requestHistory(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await prisma.leaveTransaction.findFirst({
      where: { id: req.params.id, businessId, txnType: 'APPLICATION' },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
    });
    if (!txn || !scopeAllows(req.scope, txn.employeeId)) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    // reversing/related rows: same employee+type+dates (the ADJUSTMENT from a withdraw)
    const related = await prisma.leaveTransaction.findMany({
      where: {
        businessId, employeeId: txn.employeeId, leaveTypeId: txn.leaveTypeId,
        txnType: { in: ['ADJUSTMENT', 'CANCELLATION'] },
        startDate: txn.startDate, endDate: txn.endDate,
      },
      orderBy: { createdAt: 'asc' },
    });
    const history = [txn, ...related]
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .map((r) => ({
        id: r.id, txnType: r.txnType, status: r.status, quantity: r.quantity,
        reason: r.reason, appliedAt: r.appliedAt, decidedAt: r.decidedAt, decidedBy: r.decidedBy,
        createdAt: r.createdAt,
      }));
    res.json({ request: txn, history });
  } catch (e) { next(e); }
}

// POST /requests/:id/withdraw — APPROVED → WITHDRAWN. Emits a reversing
// ADJUSTMENT (+units), credits the balance back (taken−, closing+), preserving
// the append-only ledger. Blocked when the covered day sits in a CLOSED pay run
// (payRunId stamped) so closed payroll is never rewritten.
async function withdrawRequest(req, res, next) {
  try {
    const { businessId } = req.user;
    const txn = await prisma.leaveTransaction.findFirst({
      where: { id: req.params.id, businessId, txnType: 'APPLICATION' },
    });
    if (!txn) return res.status(404).json({ message: 'Leave request not found' });
    // self OR in-scope approver may withdraw; out-of-scope → 404 (IDOR-safe).
    const isSelf = req.user.employeeId && req.user.employeeId === txn.employeeId;
    if (!isSelf && !scopeAllows(req.scope, txn.employeeId)) {
      return res.status(404).json({ message: 'Leave request not found' });
    }
    if (txn.status !== 'APPROVED' && txn.status !== 'AVAILED') {
      // already WITHDRAWN (a re-withdraw) reports a stable reason so the client can
      // distinguish "already done" from "never withdrawable" (both 409). The in-tx
      // conditional flip (finding #5) covers the concurrent race with the same reason.
      const reason = txn.status === 'WITHDRAWN' ? 'ALREADY_WITHDRAWN' : 'NOT_WITHDRAWABLE';
      return res.status(409).json({ message: `Only an approved request can be withdrawn (status: ${txn.status})`, reason });
    }
    if (txn.payRunId) {
      return res.status(422).json({
        message: 'This leave is in a closed pay run; it cannot be withdrawn (settle as a next-period credit)',
        reason: 'PAYRUN_CLOSED',
      });
    }
    const units = Math.abs(Number(txn.quantity));
    const decidedBy = req.user.id || req.user.userId || null;

    const updated = await prisma.$transaction(async (tx) => {
      // CONDITIONAL status flip (finding #5): only transition a row that is still
      // {APPROVED,AVAILED}. Two concurrent withdraws both pass the pre-tx status
      // check, but only ONE updateMany matches — the loser sees count===0 and we
      // throw DECISION_RACE so the credit (and CANCELLATION row) never run twice.
      const flip = await tx.leaveTransaction.updateMany({
        where: { id: txn.id, status: { in: ['APPROVED', 'AVAILED'] } },
        data: { status: 'WITHDRAWN', decidedAt: new Date(), decidedBy },
      });
      if (flip.count === 0) {
        const err = new Error('Leave request already withdrawn'); err.code = 'DECISION_RACE'; throw err;
      }
      // Append-only audit marker for the reversal. The WITHDRAWN status flip already
      // removes the application's −units from the closing identity (the ledger
      // reducer scores a non-{APPROVED,AVAILED} APPLICATION as 0), so this row is
      // a zero-quantity CANCELLATION trail — posting +units here would DOUBLE-count
      // the credit and break the §4.2 reconciliation. The balance credit below
      // mirrors exactly the status flip, and ONLY runs because the flip transitioned
      // the row (so a re-withdraw cannot double-credit).
      await tx.leaveTransaction.create({
        data: {
          businessId, employeeId: txn.employeeId, leaveTypeId: txn.leaveTypeId,
          leaveBalanceId: txn.leaveBalanceId,
          txnType: 'CANCELLATION', unit: txn.unit, quantity: 0,
          startDate: txn.startDate, endDate: txn.endDate,
          reason: `Withdrawal of approved leave ${txn.id} (+${units} ${txn.unit.toLowerCase()} credited back)`,
          status: 'APPROVED', appliedAt: new Date(), decidedAt: new Date(), decidedBy,
        },
      });
      if (txn.leaveBalanceId) {
        // version optimistic-lock — a concurrent move bubbles P2025 → 409 retry.
        const bal = await tx.leaveBalance.findUnique({ where: { id: txn.leaveBalanceId }, select: { id: true, version: true } });
        if (bal) {
          await tx.leaveBalance.update({
            where: { id: bal.id, version: bal.version },
            data: { taken: { decrement: units }, closing: { increment: units }, version: { increment: 1 } },
          });
        }
      }
      return tx.leaveTransaction.findUnique({ where: { id: txn.id } });
    });
    res.json(updated);
  } catch (e) {
    if (isDecisionRace(e)) {
      return res.status(409).json({ message: 'This leave was already withdrawn (or changed concurrently)', reason: 'ALREADY_WITHDRAWN' });
    }
    next(e);
  }
}

// POST /balances/adjust — audited manual adjustment → ADJUSTMENT ledger row +
// `adjusted`/`closing` bump. Append-only. canManageOrg gated at the route.
async function adjustBalance(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, leaveTypeId, periodCode, delta, reason } = req.body;
    if (!reason) return res.status(400).json({ message: 'reason is required' });
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return res.status(400).json({ message: 'delta must be a non-zero number' });

    const employee = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    const leaveType = await prisma.leaveType.findFirst({ where: { id: leaveTypeId, businessId, deletedAt: null } });
    if (!leaveType) return res.status(404).json({ message: 'Leave type not found' });

    const out = await prisma.$transaction(async (tx) => {
      const balance = await tx.leaveBalance.upsert({
        where: { businessId_employeeId_leaveTypeId_periodCode: { businessId, employeeId, leaveTypeId, periodCode } },
        update: {},
        create: { businessId, employeeId, leaveTypeId, periodCode, unit: leaveType.unit },
      });
      const row = await tx.leaveTransaction.create({
        data: {
          businessId, employeeId, leaveTypeId, leaveBalanceId: balance.id,
          txnType: 'ADJUSTMENT', unit: leaveType.unit, quantity: d,
          reason, status: 'APPROVED', appliedAt: new Date(), decidedAt: new Date(),
          decidedBy: req.user.id || req.user.userId || null,
        },
      });
      const before = Number(balance.closing);
      const updatedBal = await tx.leaveBalance.update({
        where: { id: balance.id },
        data: { adjusted: { increment: d }, closing: { increment: d }, version: { increment: 1 } },
      });
      return { row, before, after: Number(updatedBal.closing), balance: updatedBal };
    });
    res.status(201).json({ transaction: out.row, before: out.before, after: out.after });
  } catch (e) { next(e); }
}

// POST /runs/carry-forward {periodCode, leaveTypeId?, dryRun} — year-end roll.
// dryRun (default true) writes nothing. canManageOrg gated at the route.
async function carryForwardRun(req, res, next) {
  try {
    const { businessId } = req.user;
    const { periodCode, leaveTypeId, dryRun = true } = req.body;
    if (!periodCode) return res.status(400).json({ message: 'periodCode is required' });
    const result = await runCarryForward({
      businessId, periodCode, leaveTypeId: leaveTypeId || null,
      dryRun: dryRun !== false, actorId: req.user.id || null,
    });
    res.status(dryRun !== false ? 200 : 201).json(result);
  } catch (e) { next(e); }
}

// GET /reports/summary?from&to&entityId&groupBy — aggregate taken/pending/
// balance/LOP, scope-filtered. canViewReports/canManageOrg gated at the route.
async function reportsSummary(req, res, next) {
  try {
    const { businessId } = req.user;
    const { from, to, groupBy = 'type' } = req.query;
    const where = { businessId, txnType: 'APPLICATION', ...scopeWhere(req.scope, 'employeeId') };
    if (from) where.endDate = { gte: new Date(`${from}T00:00:00.000Z`) };
    if (to) where.startDate = { lte: new Date(`${to}T00:00:00.000Z`) };

    const rows = await prisma.leaveTransaction.findMany({
      where,
      include: { leaveType: { select: { id: true, code: true, name: true, affectsLOP: true } } },
    });
    const groups = {};
    for (const r of rows) {
      const key = groupBy === 'type' ? (r.leaveType ? r.leaveType.code : 'UNKNOWN') : r.employeeId;
      const g = groups[key] || (groups[key] = { key, taken: 0, pending: 0, lop: 0, count: 0 });
      const q = Math.abs(Number(r.quantity));
      g.count += 1;
      if (r.status === 'APPROVED' || r.status === 'AVAILED') {
        g.taken += q;
        if (r.leaveType && r.leaveType.affectsLOP) g.lop += q;
      } else if (r.status === 'PENDING') {
        g.pending += q;
      }
    }
    res.json({ groupBy, items: Object.values(groups) });
  } catch (e) { next(e); }
}

module.exports = {
  leaveTypes,
  leavePolicies,
  getStatutoryFramework, // Feature 16
  createRequest,
  listRequests,
  getRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
  withdrawRequest,
  listEmployeeBalances,
  employeeHistory,
  employeeReconciliation,
  // Feature 6 §4.8 new endpoints
  listMyRequests,
  leaveCalendar,
  requestHistory,
  adjustBalance,
  carryForwardRun,
  reportsSummary,
};
