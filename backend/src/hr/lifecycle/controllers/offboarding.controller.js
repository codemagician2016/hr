'use strict';

/**
 * offboarding.controller.js — separation + Full-and-Final settlement
 * (Feature 4 §4.3, §6, §8 slice 4f). Mounted at /api/hr/separations.
 *
 * The separation state machine over the existing SeparationStatus enum, wired to
 * an OFFBOARDING LifecycleJourney + its checklist tasks:
 *
 *   INITIATED → NOTICE_SERVING → CLEARANCE_PENDING → FNF_PENDING → FNF_COMPUTED
 *             → FNF_APPROVED → SETTLED   (any pre-SETTLE → CANCELLED)
 *
 * RBAC (F1-scoped, §4.5):
 *   - initiate / compute-fnf / approve / settle / letters → HR keys
 *     (canRunSeparation / canApprovePayroll / canGenerateLetters), ALL band.
 *   - clearance lanes → each lane only actionable by its owner permission; a
 *     MANAGER (TEAM band) may clear ONLY the KT + asset-return lanes for their own
 *     reports. Out-of-scope subject → 404 (IDOR-safe, never 403).
 *   - approve-fnf → SoD: canApprovePayroll AND approver ≠ initiator (the
 *     APPROVAL_ACTIONS self-exclusion strips the actor from their own scope; we
 *     also assert initiator ≠ approver explicitly).
 *
 * computeFnf math lives in the PURE `fnf.js` (DB-free, unit-tested); THIS
 * controller does the DB reads (comp / leave / loans / assets), maps them into
 * the pure ctx, persists the snapshot onto the SeparationCase money fields, and
 * mints the PayRun(type=FNF). Settle revokes RBAC access (with a manager-reassign
 * guard) and end-dates the Employee via the demoted employee.settle helper.
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const { effectivePermissions } = require('../../../core/lib/rbac');
const { scopeAllows } = require('../../lib/scopeResolver');
const { advanceJourney } = require('../journeyEngine');
const { allocateCode } = require('../lib/codes');
const { getDefaultOffboardingTemplate } = require('../templates/seed');
const { seedJourneyTasks } = require('../journeyEngine');
const { computeFnf } = require('../fnf');
const { settleEmployeeTermination } = require('../../controllers/employee.controller');

// Decimal helper: integer minor units → Decimal string (2dp money columns).
function minorToDecimal(minor) {
  const n = Math.round(Number(minor) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
function decimalToMinor(value) {
  if (value == null) return 0;
  return Math.round(Number(value) * 100);
}
function toDateOnly(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Whole calendar days between two date-only values (b − a), never negative.
function daysBetween(a, b) {
  const da = toDateOnly(a);
  const db = toDateOnly(b);
  if (!da || !db) return 0;
  return Math.max(0, Math.round((db.getTime() - da.getTime()) / 86400000));
}

// M4: notice shortfall = max(0, requiredNoticeDays − daysActuallyServed), where
// served = (lastWorkingDay − noticeStart). noticeStart is the resignationDate (or
// the initiate date). Returns 0 when either date or noticePeriodDays is missing
// (we never invent a shortfall). This is the value that drives the NOTICE_RECOVERY
// deduction (employee-initiated) or the pay-in-lieu earning (employer-initiated).
function deriveNoticeShortfallDays({ noticePeriodDays, noticeStart, lastWorkingDay }) {
  const required = Number(noticePeriodDays);
  if (!Number.isFinite(required) || required <= 0) return 0;
  if (!noticeStart || !lastWorkingDay) return 0;
  const served = daysBetween(noticeStart, lastWorkingDay);
  return Math.max(0, Math.round(required) - served);
}

// ── separation types ─────────────────────────────────────────────────────────
const SEPARATION_TYPES = new Set([
  'RESIGNATION', 'TERMINATION_FOR_CAUSE', 'RETRENCHMENT', 'REDUNDANCY', 'END_OF_CONTRACT',
  'RETIREMENT', 'DEATH', 'ABSCONDING', 'PROBATION_FAILURE', 'MUTUAL_SEPARATION',
]);
// Clearance lanes and the permission each lane requires. A MANAGER (no admin keys)
// may clear ONLY 'knowledge_transfer' + 'assets' for their own reports (§6).
const CLEARANCE_LANES = {
  it: { permission: 'canManageStatutory', managerAllowed: false, label: 'IT' },
  finance: { permission: 'canApprovePayroll', managerAllowed: false, label: 'Finance' },
  admin: { permission: 'canManageOrg', managerAllowed: false, label: 'Admin' },
  knowledge_transfer: { permission: 'canRunSeparation', managerAllowed: true, label: 'Knowledge transfer' },
  assets: { permission: 'canRunSeparation', managerAllowed: true, label: 'Asset return' },
};
const BLOCKING_LANES = ['it', 'finance', 'admin', 'knowledge_transfer', 'assets'];

// Resolve the scope filter for a case query (subject = SeparationCase.employeeId).
function caseScopeWhere(scope) {
  if (!scope || scope.kind === 'ALL') return {};
  if (scope.kind === 'NONE') return { id: { in: [] } };
  return { employeeId: { in: [...scope.ids] } };
}

// Load a separation case + enforce subject-scope. Returns the case or sends 404.
async function loadScopedCase(req, res, { include } = {}) {
  const { businessId } = req.user;
  const sep = await prisma.separationCase.findFirst({
    where: { id: req.params.id, businessId, deletedAt: null },
    ...(include ? { include } : {}),
  });
  if (!sep) {
    res.status(404).json({ message: 'Separation case not found' });
    return null;
  }
  if (req.scope && req.scope.kind !== 'ALL' && !scopeAllows(req.scope, sep.employeeId)) {
    res.status(404).json({ message: 'Separation case not found' });
    return null;
  }
  return sep;
}

// Resolve the hiring entity + its country for an employee (from the current
// EmploymentRecord — Employee has no direct entityId). Returns { entity, record }.
async function resolveEmployeeEntity(businessId, employeeId, db = prisma) {
  const record = await db.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!record) return { entity: null, record: null };
  const entity = await db.entity.findFirst({ where: { id: record.entityId, businessId } });
  return { entity, record };
}

// Resolve last-drawn Basic+DA (minor) + monthly gross (minor) from the employee's
// current CompensationRevision lines. Mirrors provision.resolveBasicDaMonthly.
const BASIC_DA_KINDS = new Set(['BASIC', 'DEARNESS_ALLOWANCE']);
async function resolveLastDrawnPay(businessId, employeeId, db = prisma) {
  const comp = await db.compensationRevision.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
    include: { lines: { include: { component: { select: { kind: true } } } } },
  });
  if (!comp) return { basicDaMonthlyMinor: 0, grossMonthlyMinor: 0 };
  let basicDa = 0;
  for (const ln of comp.lines || []) {
    const kind = ln.component && ln.component.kind;
    if (BASIC_DA_KINDS.has(kind) && ln.amountMonthly != null) basicDa += Number(ln.amountMonthly);
  }
  const grossMonthlyMinor = comp.grossMonthly != null ? decimalToMinor(comp.grossMonthly) : 0;
  return { basicDaMonthlyMinor: Math.round(basicDa * 100), grossMonthlyMinor };
}

// Sum the employee's outstanding loan balances (minor).
async function resolveLoanOutstanding(businessId, employeeId, db = prisma) {
  const loans = await db.loan.findMany({
    where: { businessId, employeeId, deletedAt: null, status: { in: ['DISBURSED', 'APPROVED'] } },
    select: { outstanding: true, principal: true, amountRepaid: true },
  });
  let total = 0;
  for (const l of loans) {
    const out = l.outstanding != null
      ? Number(l.outstanding)
      : Math.max(0, Number(l.principal || 0) - Number(l.amountRepaid || 0));
    total += out;
  }
  return Math.round(total * 100);
}

// Sum recovery owed on the employee's un-returned / lost / damaged assets (minor).
// recoveryAmount is set by the assets controller's returnAsset (lost/damaged) and
// can be parked on still-open assignments by an HR waiver. Open (returnedAt null)
// assignments with no recovery amount block settle (see assetReturnState).
async function resolveAssetRecovery(businessId, employeeId, db = prisma) {
  const assignments = await db.assetAssignment.findMany({
    where: { businessId, employeeId },
    select: { returnedAt: true, recoveryAmount: true, status: true },
  });
  let total = 0;
  for (const a of assignments) {
    if (a.recoveryAmount != null) total += Number(a.recoveryAmount);
  }
  return Math.round(total * 100);
}

// Asset-return state for the settle/compute guards (slice 4e): are there assets
// still OUT (returnedAt null) that have NO recovery amount recorded (i.e. neither
// returned nor waived-to-recovery)? Those block compute-fnf / settle (§7 QA24).
async function assetReturnState(businessId, employeeId, db = prisma) {
  const open = await db.assetAssignment.findMany({
    where: { businessId, employeeId, returnedAt: null },
    select: { id: true, recoveryAmount: true, assetId: true },
  });
  const unresolved = open.filter((a) => a.recoveryAmount == null);
  return { openCount: open.length, unresolvedCount: unresolved.length, unresolved };
}

// M6: resolve the NZ holiday-payout earnings from the employee's ACTUAL payroll
// history (PayRunLine.grossEarnings on PAID/non-draft runs), never a fabricated
// proxy. Returns the gross earned since the holiday anniversary + the trailing
// 52-week gross (for AWE) + the count of weeks covered. `resolved` is false when
// no payroll history exists at all — the caller then blocks compute (422) rather
// than valuing 8% of zero or an OWP guessed off the current monthly gross.
async function resolveNzEarningsHistory(businessId, employeeId, lwd, db = prisma) {
  const lwdDate = lwd ? new Date(lwd) : new Date();
  const anchor = new Date(Date.UTC(lwdDate.getUTCFullYear() - 1, lwdDate.getUTCMonth(), lwdDate.getUTCDate()));
  const lines = await db.payRunLine.findMany({
    where: {
      businessId,
      employeeId,
      status: { not: 'EXCLUDED' },
      payRun: { is: { periodEnd: { gte: anchor, lte: lwdDate }, status: { notIn: ['DRAFT', 'CANCELLED'] } } },
    },
    select: { grossEarnings: true, payRun: { select: { periodEnd: true } } },
  });
  if (!lines.length) {
    return { resolved: false, grossSinceAnniversaryMinor: 0, grossEarnings52Minor: 0, weeksCovered: 0 };
  }
  let grossSinceAnniversaryMinor = 0;
  for (const l of lines) grossSinceAnniversaryMinor += Math.round(Number(l.grossEarnings || 0) * 100);
  // For AWE the §9 base is the trailing 52 weeks; the same window approximates it.
  return {
    resolved: true,
    grossSinceAnniversaryMinor,
    grossEarnings52Minor: grossSinceAnniversaryMinor,
    weeksCovered: 52,
  };
}

// Encashable leave balance (days) for an employee — Σ LeaveBalance.closing over
// encashable LeaveTypes (current period). The pure fnf core values it.
async function resolveEncashableLeaveDays(businessId, employeeId, db = prisma) {
  const balances = await db.leaveBalance.findMany({
    where: { businessId, employeeId, leaveType: { is: { isEncashable: true } } },
    select: { closing: true },
    orderBy: { updatedAt: 'desc' },
  });
  let days = 0;
  for (const b of balances) days += Number(b.closing || 0);
  return days;
}

// ── seed the OFFBOARDING journey for a separation case (reuses journeyEngine) ──
// Snapshots the default offboarding template's task defs into LifecycleTasks,
// resolves owners (HR/IT/FINANCE/ADMIN → function owners by permission; MANAGER →
// the employee's manager). Runs inside the caller's tx. Returns the journey row.
async function seedOffboardingJourney(tx, { businessId, sep, employee, entity, actorId }) {
  const cc = entity && entity.countryCode === 'NZ' ? 'NZ' : 'IN';
  const tpl = await getDefaultOffboardingTemplate(tx, businessId, cc);
  const ownerResolution = {
    EMPLOYEE: { employeeId: employee.id },
    MANAGER: employee.managerEmployeeId ? { employeeId: employee.managerEmployeeId } : {},
    HR: actorId ? { userId: actorId } : {},
  };
  const ctx = {
    businessId,
    noticeStartDate: sep.resignationDate || sep.initiatedAt,
    lastWorkingDay: sep.lastWorkingDay,
    relievingDate: sep.relievingDate || sep.lastWorkingDay,
    ownerResolution,
  };
  const taskPayloads = tpl ? seedJourneyTasks(tpl.template, tpl.taskDefs, ctx) : [];
  const code = await allocateCode(tx, { businessId, entityId: entity ? entity.id : null, scope: 'OFFBOARD' });
  const journey = await tx.lifecycleJourney.create({
    data: {
      businessId,
      entityId: entity ? entity.id : null,
      code,
      direction: 'OFFBOARDING',
      templateId: tpl ? tpl.template.id : null,
      employeeId: employee.id,
      separationId: sep.id,
      noticeStartDate: toDateOnly(sep.resignationDate || sep.initiatedAt),
      lastWorkingDay: toDateOnly(sep.lastWorkingDay),
      relievingDate: toDateOnly(sep.relievingDate || sep.lastWorkingDay),
      currentStage: 'SEPARATION_INITIATED',
      status: 'IN_PROGRESS',
      tasks: { create: taskPayloads.map((t) => ({ ...t, businessId })) },
    },
    include: { tasks: true },
  });
  return journey;
}

// =====================================================================
// POST /separations — initiate a separation (HR: canRunSeparation)
// =====================================================================
async function initiateSeparation(req, res, next) {
  try {
    const { businessId } = req.user;
    const { employeeId, type, reason, noticeDate, lwd, relievingDate, resignationDate } = req.body || {};
    if (!employeeId || !type) {
      return res.status(400).json({ message: 'employeeId and type are required' });
    }
    if (!SEPARATION_TYPES.has(type)) {
      return res.status(422).json({ message: `Invalid separation type: ${type}` });
    }
    // Subject must be in scope (HR=ALL; a manager initiating is unusual but scoped).
    if (req.scope && req.scope.kind !== 'ALL' && !scopeAllows(req.scope, employeeId)) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    const employee = await prisma.employee.findFirst({ where: { id: employeeId, businessId, deletedAt: null } });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    // Exactly ONE active case per employee (the @@unique backstop + this guard).
    const active = await prisma.separationCase.findFirst({
      where: { businessId, employeeId, deletedAt: null, status: { notIn: ['SETTLED', 'CANCELLED'] } },
    });
    if (active) {
      return res.status(409).json({ message: 'An active separation case already exists for this employee', separationId: active.id });
    }

    const { entity, record } = await resolveEmployeeEntity(businessId, employeeId);
    if (!entity) {
      return res.status(422).json({ message: 'Employee has no current employment record / entity', reason: 'precondition' });
    }

    const noticeDays = record && record.noticeDays != null ? record.noticeDays : null;
    // M4: persist the notice shortfall at initiate (required notice vs notice served
    // from the notice start to the LWD). 0 when dates/notice are unknown.
    const noticeStart = toDateOnly(resignationDate || noticeDate) || toDateOnly(new Date());
    const noticeShortfallDays = deriveNoticeShortfallDays({
      noticePeriodDays: noticeDays, noticeStart, lastWorkingDay: toDateOnly(lwd),
    });
    const out = await prisma.$transaction(async (tx) => {
      const code = await allocateCode(tx, { businessId, entityId: entity.id, scope: 'SEP' });
      const sep = await tx.separationCase.create({
        data: {
          businessId,
          employeeId,
          entityId: entity.id,
          code,
          type,
          reason: reason || null,
          initiatedAt: toDateOnly(new Date()),
          resignationDate: noticeStart,
          noticePeriodDays: noticeDays,
          noticeShortfallDays,
          lastWorkingDay: toDateOnly(lwd),
          relievingDate: toDateOnly(relievingDate),
          currencyCode: entity.payCurrency,
          status: 'INITIATED',
          // S7: persist the initiator (HR actor) in the SAME tx — the SoD anchor.
          initiatedByUserId: req.user.id,
          clearanceJson: {},
        },
      });
      // Spawn the OFFBOARDING journey + checklist + flip the employee to notice.
      const journey = await seedOffboardingJourney(tx, { businessId, sep, employee, entity, actorId: req.user.id });
      await tx.employee.update({ where: { id: employeeId }, data: { status: 'NOTICE_PERIOD', version: { increment: 1 } } });
      return { sep, journey };
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'separation.initiate',
      entityType: 'SeparationCase', entityId: out.sep.id,
      meta: { code: out.sep.code, employeeId, type },
    });
    res.status(201).json({ separation: out.sep, journey: { id: out.journey.id, code: out.journey.code } });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'An active separation case already exists for this employee' });
    next(e);
  }
}

// =====================================================================
// GET /separations  + GET /separations/:id (scoped reads)
// =====================================================================
async function listSeparations(req, res, next) {
  try {
    const { businessId } = req.user;
    const { status, page = '1', pageSize = '50' } = req.query;
    const take = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;
    const where = { businessId, deletedAt: null, ...caseScopeWhere(req.scope) };
    if (status) where.status = status;
    const [items, total] = await Promise.all([
      prisma.separationCase.findMany({
        where, orderBy: { createdAt: 'desc' }, skip, take,
        include: { employee: { select: { id: true, code: true, firstName: true, lastName: true, status: true } } },
      }),
      prisma.separationCase.count({ where }),
    ]);
    res.json({ items, total, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take });
  } catch (e) { next(e); }
}

async function getSeparation(req, res, next) {
  try {
    const sep = await loadScopedCase(req, res, {
      include: { employee: { select: { id: true, code: true, firstName: true, lastName: true, status: true } } },
    });
    if (!sep) return undefined;
    const journey = await prisma.lifecycleJourney.findFirst({
      where: { businessId: req.user.businessId, separationId: sep.id, deletedAt: null },
      include: { tasks: { orderBy: [{ stageKey: 'asc' }, { dueDate: 'asc' }] } },
    });
    return res.json({ separation: sep, journey });
  } catch (e) { return next(e); }
}

// =====================================================================
// PATCH /separations/:id/clearance — per-lane updates into clearanceJson
// =====================================================================
async function updateClearance(req, res, next) {
  try {
    const sep = await loadScopedCase(req, res);
    if (!sep) return undefined;
    const { lane, status: laneStatus, note } = req.body || {};
    if (!lane || !CLEARANCE_LANES[lane]) {
      return res.status(422).json({ message: `Unknown clearance lane: ${lane}`, lanes: Object.keys(CLEARANCE_LANES) });
    }
    if (['SETTLED', 'CANCELLED', 'FNF_APPROVED'].includes(sep.status)) {
      return res.status(409).json({ message: `Cannot update clearance on a ${sep.status.toLowerCase()} case` });
    }
    const laneCfg = CLEARANCE_LANES[lane];
    const isManager = req.scope && req.scope.kind !== 'ALL';
    // Per-lane owner authorization. A scoped actor (manager) may clear ONLY the
    // manager-allowed lanes (KT + assets) for their own reports; the IDOR-safe
    // subject scope was already enforced by loadScopedCase. An ALL-band HR actor
    // needs the lane's permission key.
    if (isManager) {
      if (!laneCfg.managerAllowed) {
        return res.status(403).json({ message: `The ${laneCfg.label} lane is not a manager-actionable lane`, reason: 'lane-not-owned' });
      }
    } else {
      // HR/finance/IT/admin actors (ALL band) must hold the lane's permission.
      const perms = effectivePermissions(req.user) || {};
      if (perms[laneCfg.permission] !== true) {
        return res.status(403).json({ message: `Missing permission for the ${laneCfg.label} lane`, reason: 'lane-permission' });
      }
    }
    const newStatus = String(laneStatus || 'CLEARED').toUpperCase();
    if (!['CLEARED', 'PENDING', 'BLOCKED'].includes(newStatus)) {
      return res.status(422).json({ message: `Invalid lane status: ${newStatus}` });
    }
    // Asset lane sign-off is rejected while any asset is still un-returned (§6).
    if (lane === 'assets' && newStatus === 'CLEARED') {
      const st = await assetReturnState(req.user.businessId, sep.employeeId);
      if (st.unresolvedCount > 0) {
        return res.status(422).json({
          message: `Cannot clear the asset lane: ${st.unresolvedCount} asset(s) still un-returned (return them or record a recovery)`,
          reason: 'assets-open', unresolvedCount: st.unresolvedCount,
        });
      }
    }

    const clearance = { ...(sep.clearanceJson || {}) };
    clearance[lane] = { status: newStatus, note: note || null, by: req.user.id, at: new Date().toISOString() };

    // Advance INITIATED/NOTICE_SERVING → CLEARANCE_PENDING when the first lane is
    // touched; → FNF_PENDING once all blocking lanes are CLEARED.
    const allCleared = BLOCKING_LANES.every((l) => clearance[l] && clearance[l].status === 'CLEARED');
    let nextStatus = sep.status;
    if (sep.status === 'INITIATED' || sep.status === 'NOTICE_SERVING') nextStatus = 'CLEARANCE_PENDING';
    if (allCleared && ['INITIATED', 'NOTICE_SERVING', 'CLEARANCE_PENDING'].includes(nextStatus)) {
      nextStatus = 'FNF_PENDING';
    }

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.separationCase.update({
        where: { id: sep.id },
        data: { clearanceJson: clearance, status: nextStatus, version: { increment: 1 } },
      });
      // Mirror the lane onto its bound checklist task (best-effort).
      const taskKeyByLane = { it: 'CLEARANCE_IT', finance: 'CLEARANCE_FINANCE', admin: 'CLEARANCE_ADMIN', knowledge_transfer: 'KNOWLEDGE_TRANSFER', assets: 'RETURN_ASSET' };
      const taskKey = taskKeyByLane[lane];
      if (taskKey && newStatus === 'CLEARED') {
        const journey = await tx.lifecycleJourney.findFirst({ where: { businessId: req.user.businessId, separationId: sep.id, deletedAt: null } });
        if (journey) {
          const task = await tx.lifecycleTask.findFirst({ where: { journeyId: journey.id, taskKey } });
          if (task && !['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(task.status)) {
            await tx.lifecycleTask.update({ where: { id: task.id }, data: { status: 'DONE', completedAt: new Date(), completedByUserId: req.user.id, version: { increment: 1 } } });
          }
          const tasks = await tx.lifecycleTask.findMany({ where: { journeyId: journey.id } });
          const adv = advanceJourney(journey, tasks);
          if (adv.currentStage !== journey.currentStage || adv.status !== journey.status) {
            await tx.lifecycleJourney.update({ where: { id: journey.id }, data: { currentStage: adv.currentStage, status: adv.status, version: { increment: 1 } } });
          }
        }
      }
      return row;
    });
    res.json({ separation: updated, clearance });
  } catch (e) { next(e); }
}

// =====================================================================
// POST /separations/:id/compute-fnf — compute + persist the FnF snapshot
//   (HR: canRunSeparation). BLOCKED (422) while a clearance lane is un-CLEARED
//   or any asset is un-returned (unless waived → recovery). §7 QA24.
// =====================================================================
async function computeFnfEndpoint(req, res, next) {
  try {
    const sep = await loadScopedCase(req, res);
    if (!sep) return undefined;
    if (['SETTLED', 'CANCELLED'].includes(sep.status)) {
      return res.status(409).json({ message: `Cannot compute FnF on a ${sep.status.toLowerCase()} case` });
    }
    // Guard 1: every blocking clearance lane must be CLEARED.
    const clearance = sep.clearanceJson || {};
    const openLanes = BLOCKING_LANES.filter((l) => !clearance[l] || clearance[l].status !== 'CLEARED');
    if (openLanes.length) {
      return res.status(422).json({ message: 'Cannot compute FnF: clearance lanes still open', reason: 'clearance-open', openLanes });
    }
    // Guard 2: no asset still un-returned without a recovery amount (§7 QA24).
    const assetState = await assetReturnState(req.user.businessId, sep.employeeId);
    if (assetState.unresolvedCount > 0) {
      return res.status(422).json({
        message: `Cannot compute FnF: ${assetState.unresolvedCount} asset(s) un-returned (return them or record an HR waiver → recovery)`,
        reason: 'assets-open', unresolvedCount: assetState.unresolvedCount,
      });
    }

    const businessId = req.user.businessId;
    const { entity, record } = await resolveEmployeeEntity(businessId, sep.employeeId);
    const country = entity && entity.countryCode === 'NZ' ? 'NZ' : 'IN';
    const pay = await resolveLastDrawnPay(businessId, sep.employeeId);
    const encashableLeaveDays = await resolveEncashableLeaveDays(businessId, sep.employeeId);
    const loanOutstandingMinor = await resolveLoanOutstanding(businessId, sep.employeeId);
    const assetRecoveryMinor = await resolveAssetRecovery(businessId, sep.employeeId);

    // Completed service from hireDate → LWD (for gratuity rounding).
    const employee = await prisma.employee.findFirst({ where: { id: sep.employeeId, businessId } });
    const hireMs = employee && employee.hireDate ? new Date(employee.hireDate).getTime() : null;
    const lwdMs = sep.lastWorkingDay ? new Date(sep.lastWorkingDay).getTime() : Date.now();
    let serviceYears = 0; let serviceMonths = 0;
    if (hireMs != null) {
      const totalMonths = Math.max(0, Math.floor((lwdMs - hireMs) / (86400000 * 30.4375)));
      serviceYears = Math.floor(totalMonths / 12);
      serviceMonths = totalMonths % 12;
    }

    // M4: notice shortfall. Prefer the value persisted on the case (initiate), but
    // ALWAYS re-derive from the dates here so it's never read from a column nobody
    // wrote — the larger of the two wins (a stored 0 from a pre-fix row is healed).
    const derivedShortfall = deriveNoticeShortfallDays({
      noticePeriodDays: sep.noticePeriodDays,
      noticeStart: sep.resignationDate || sep.initiatedAt,
      lastWorkingDay: sep.lastWorkingDay,
    });
    const noticeShortfallDays = Math.max(Number(sep.noticeShortfallDays) || 0, derivedShortfall);

    // M6: NZ holiday inputs from ACTUAL payroll history (never a fabricated proxy).
    // If the caller passes an explicit nz block we honour it; otherwise we resolve
    // from PayRunLine history and, when none exists, flag earningsResolved:false so
    // computeFnf returns nzRequiresInput and we block below with a 422.
    let nzCtx;
    if (country === 'NZ') {
      if (req.body && req.body.nz) {
        nzCtx = { ...req.body.nz, earningsResolved: true };
      } else {
        const hist = await resolveNzEarningsHistory(businessId, sep.employeeId, sep.lastWorkingDay);
        nzCtx = {
          earningsResolved: hist.resolved,
          grossSinceAnniversaryMinor: hist.grossSinceAnniversaryMinor,
          untakenAnnualLeaveWeeks: encashableLeaveDays / 5,
          owp: { specifiedWeeklyMinor: Math.round(hist.grossEarnings52Minor / 52) },
          awe: { grossEarnings52Minor: hist.grossEarnings52Minor },
          workingDaysPerWeek: 5,
        };
      }
    }

    const ctx = {
      country,
      currencyCode: entity ? entity.payCurrency : sep.currencyCode,
      separationType: sep.type,
      disablement: req.body && req.body.disablement === true,
      basicDaMonthlyMinor: pay.basicDaMonthlyMinor,
      grossMonthlyMinor: pay.grossMonthlyMinor,
      serviceYears,
      serviceMonths,
      encashableLeaveDays,
      noticeShortfallDays,
      unpaidSalaryMinor: req.body && req.body.unpaidSalaryMinor != null ? req.body.unpaidSalaryMinor : 0,
      statutoryDeductionsMinor: req.body && req.body.statutoryDeductionsMinor != null ? req.body.statutoryDeductionsMinor : 0,
      loanOutstandingMinor,
      assetRecoveryMinor,
      nz: nzCtx,
    };

    const fnf = computeFnf(sep, ctx);

    // M6: block (don't persist) when the NZ payout needs real earnings we couldn't
    // resolve — a clearly-flagged 422 rather than a wrong number on the case.
    if (fnf.nzRequiresInput) {
      return res.status(422).json({
        message: 'Cannot compute FnF: NZ holiday-pay earnings could not be resolved from payroll history; supply the nz earnings block',
        reason: 'nz-earnings-required',
      });
    }

    const updated = await prisma.separationCase.update({
      where: { id: sep.id },
      data: {
        gratuityAmount: country === 'IN' ? minorToDecimal(fnf.snapshot.gratuityAmountMinor) : null,
        leaveEncashmentDays: country === 'IN' ? String(fnf.snapshot.leaveEncashmentDays) : null,
        leaveEncashmentAmount: country === 'IN' ? minorToDecimal(fnf.snapshot.leaveEncashmentAmountMinor) : null,
        nzHolidayPayoutAmount: country === 'NZ' ? minorToDecimal(fnf.snapshot.nzHolidayPayoutAmountMinor) : null,
        noticeRecoveryAmount: minorToDecimal(fnf.snapshot.noticeRecoveryAmountMinor),
        loanForeclosureAmount: minorToDecimal(fnf.snapshot.loanForeclosureAmountMinor),
        assetRecoveryAmount: minorToDecimal(fnf.snapshot.assetRecoveryAmountMinor),
        netSettlement: minorToDecimal(fnf.snapshot.netSettlementMinor),
        // M1+M2: persist the FULL computeFnf result — payRunInput (every earning/
        // deduction line + grossMinor/totalDeductionsMinor/netMinor) + breakdown.
        // approveFnf mints the PayRun(type=FNF) DIRECTLY from this so the run always
        // reconciles (totalGross − totalDeductions === totalNet) and no component is
        // dropped (unpaid salary, notice pay-in-lieu, statutory all carried through).
        fnfSnapshotJson: {
          country: fnf.country,
          currencyCode: fnf.currencyCode,
          lines: fnf.lines,
          snapshot: fnf.snapshot,
          breakdown: fnf.breakdown,
          payRunInput: fnf.payRunInput,
          recoverableBalance: fnf.recoverableBalance,
          noticeShortfallDays,
          computedAt: new Date().toISOString(),
        },
        noticeShortfallDays,
        status: 'FNF_COMPUTED',
        version: { increment: 1 },
      },
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'separation.compute-fnf',
      entityType: 'SeparationCase', entityId: sep.id,
      meta: { code: sep.code, netSettlement: fnf.snapshot.netSettlementMinor, recoverable: fnf.recoverableBalance },
    });

    res.json({
      separation: updated,
      fnf: { lines: fnf.lines, snapshot: fnf.snapshot, payRunInput: fnf.payRunInput, recoverableBalance: fnf.recoverableBalance },
    });
  } catch (e) { next(e); }
}

// =====================================================================
// POST /separations/:id/approve-fnf — SoD-gated approval (canApprovePayroll +
//   approver ≠ initiator). On approve: mint PayRun(type=FNF), link, status SETTLED-ready.
// =====================================================================
async function approveFnf(req, res, next) {
  try {
    const sep = await loadScopedCase(req, res);
    if (!sep) return undefined;
    if (sep.status !== 'FNF_COMPUTED') {
      return res.status(409).json({ message: `FnF must be computed before approval (status: ${sep.status})`, reason: 'precondition' });
    }
    // ── SoD (S7): the approver must NOT be the initiator (separation of duties).
    //    The initiator is persisted on the case (initiatedByUserId) in the SAME tx
    //    as initiate / ESS-resign — NOT read from an audit row that the ESS path
    //    never wrote. We FAIL CLOSED: a null/unknown initiator is a 403 (an
    //    un-attributable case cannot be self-approved), and so is initiator ==
    //    approver. (canApprovePayroll + APPROVAL_ACTIONS self-strip still apply.)
    const initiatorUserId = sep.initiatedByUserId || null;
    if (!initiatorUserId) {
      return res.status(403).json({ message: 'Separation of duties: the initiator of this case is unknown; it cannot be approved (fail-closed)', reason: 'sod-initiator-unknown' });
    }
    if (initiatorUserId === req.user.id) {
      return res.status(403).json({ message: 'Separation of duties: the initiator of a separation cannot approve its FnF', reason: 'sod-initiator-equals-approver' });
    }

    // M1+M2: mint the PayRun from the persisted full snapshot's payRunInput, so the
    // run reconciles exactly and carries every component. A pre-snapshot row (none
    // exist post-migration, but be safe) is rejected — never re-derive from the 6
    // Decimal columns (that dropped pay-in-lieu / unpaid salary / statutory).
    const snap = sep.fnfSnapshotJson || null;
    const payRunInput = snap && snap.payRunInput ? snap.payRunInput : null;
    if (!payRunInput || !Array.isArray(payRunInput.earnings) || !Array.isArray(payRunInput.deductions)) {
      return res.status(409).json({ message: 'FnF snapshot is missing or incomplete; re-run compute-fnf before approval', reason: 'snapshot-missing' });
    }

    const businessId = req.user.businessId;
    const out = await prisma.$transaction(async (tx) => {
      // Mint the FnF PayRun (type=FNF). Resolve the entity's active pay calendar
      // (required FK). Code via NumberSequence (FNF-…) so it never collides with a
      // regular run code. periodStart/End = the final period to LWD.
      const cal = await tx.payCalendar.findFirst({ where: { businessId, entityId: sep.entityId, isActive: true } })
        || await tx.payCalendar.findFirst({ where: { businessId, entityId: sep.entityId } });
      if (!cal) {
        const err = new Error('No pay calendar configured for the entity; cannot create the FnF PayRun');
        err.status = 422; err.reason = 'no-pay-calendar';
        throw err;
      }
      const lwd = sep.lastWorkingDay ? new Date(sep.lastWorkingDay) : new Date();
      const periodStart = new Date(Date.UTC(lwd.getUTCFullYear(), lwd.getUTCMonth(), 1));
      const code = await allocateCode(tx, { businessId, entityId: sep.entityId, scope: 'FNF', prefix: 'FNF-', padding: 6 });
      // Totals come STRAIGHT from the snapshot's payRunInput (Σ earning/deduction
      // lines). gross − deductions === net by construction (the pure core summed
      // the very same lines), so the persisted run always reconciles.
      const grossMinor = Math.round(Number(payRunInput.grossMinor) || 0);
      const totalDeductionsMinor = Math.round(Number(payRunInput.totalDeductionsMinor) || 0);
      const netMinor = Math.round(Number(payRunInput.netMinor) || 0);
      const payRun = await tx.payRun.create({
        data: {
          businessId,
          entityId: sep.entityId,
          payCalendarId: cal.id,
          code,
          periodStart: toDateOnly(periodStart),
          periodEnd: toDateOnly(lwd),
          payDate: toDateOnly(lwd),
          sequenceInYear: 0,
          taxYear: `${periodStart.getUTCFullYear()}-${String((periodStart.getUTCFullYear() + 1) % 100).padStart(2, '0')}`,
          type: 'FNF',
          status: 'DRAFT',
          currencyCode: sep.currencyCode,
          headcount: 1,
          totalGross: minorToDecimal(grossMinor),
          totalDeductions: minorToDecimal(totalDeductionsMinor),
          totalNet: minorToDecimal(netMinor),
          approvedAt: new Date(),
          approvedBy: req.user.id,
          notes: `Full-and-final settlement for ${sep.code} — ${payRunInput.earnings.length} earning / ${payRunInput.deductions.length} deduction line(s)`,
        },
      });
      const updated = await tx.separationCase.update({
        where: { id: sep.id },
        data: { status: 'FNF_APPROVED', fnfPayRunId: payRun.id, version: { increment: 1 } },
      });
      return { payRun, sep: updated, grossMinor, totalDeductionsMinor, netMinor };
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'separation.approve-fnf',
      entityType: 'SeparationCase', entityId: sep.id,
      meta: {
        code: sep.code, payRunId: out.payRun.id, initiatorUserId,
        grossMinor: out.grossMinor, totalDeductionsMinor: out.totalDeductionsMinor, netMinor: out.netMinor,
      },
    });
    res.json({ separation: out.sep, payRun: { id: out.payRun.id, code: out.payRun.code, type: out.payRun.type } });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ message: e.message, reason: e.reason });
    next(e);
  }
}

// =====================================================================
// POST /separations/:id/settle — revoke access + end-date the employee.
//   Gated on FNF_APPROVED + zero un-returned assets. Reassigns the leaver's
//   reports first (manager-reassign guard) so the scope CTE never orphans them.
// =====================================================================
async function settleSeparation(req, res, next) {
  try {
    const sep = await loadScopedCase(req, res);
    if (!sep) return undefined;
    if (sep.status === 'SETTLED') {
      return res.status(409).json({ message: 'Separation already settled' });
    }
    if (sep.status !== 'FNF_APPROVED') {
      return res.status(422).json({ message: `FnF must be approved before settlement (status: ${sep.status})`, reason: 'precondition' });
    }
    const businessId = req.user.businessId;
    // Settle guard: no asset still un-returned without a recovery amount (§7 QA24).
    const assetState = await assetReturnState(businessId, sep.employeeId);
    if (assetState.unresolvedCount > 0) {
      return res.status(422).json({
        message: `Cannot settle: ${assetState.unresolvedCount} asset(s) un-returned (return them or record a recovery)`,
        reason: 'assets-open', unresolvedCount: assetState.unresolvedCount,
      });
    }

    // Manager-reassign guard: if the leaver manages a team, the reports' manager
    // MUST be reassigned first (else the scopeResolver recursive CTE orphans the
    // sub-tree). Reassign to the leaver's own manager (the grandparent).
    const reports = await prisma.employee.findMany({
      where: { businessId, managerEmployeeId: sep.employeeId, deletedAt: null },
      select: { id: true },
    });
    const employee = await prisma.employee.findFirst({
      where: { id: sep.employeeId, businessId },
      // workEmail/personalEmail needed to deactivate the leaver's ESS Customer (S8).
      include: { user: { select: { id: true, email: true } } },
    });
    const reassignTo = (req.body && req.body.reassignManagerId) || (employee ? employee.managerEmployeeId : null) || null;
    if (reports.length && !reassignTo) {
      return res.status(422).json({
        message: `Cannot settle: the employee manages ${reports.length} report(s); provide reassignManagerId (or ensure they have a manager to inherit them)`,
        reason: 'reports-orphaned', reportCount: reports.length,
      });
    }

    const status = sep.type === 'RETIREMENT' ? 'RETIRED' : 'TERMINATED';
    const out = await prisma.$transaction(async (tx) => {
      // 1. Reassign the leaver's reports.
      if (reports.length) {
        await tx.employee.updateMany({ where: { businessId, managerEmployeeId: sep.employeeId, deletedAt: null }, data: { managerEmployeeId: reassignTo } });
      }
      // 2. End-date + flip the directory status (demoted employee.settle helper).
      const settleRes = await settleEmployeeTermination(tx, {
        businessId, employeeId: sep.employeeId, actorId: req.user.id,
        terminationDate: sep.lastWorkingDay || new Date(), status,
      });
      // 3. Revoke RBAC access INSIDE the settle tx (S10/S11 — no separate unguarded
      //    step): detach BusinessRole + deactivate the operator User AND deactivate
      //    the leaver's ESS Customer session(s) (S8). authenticateCustomer rejects an
      //    isActive=false customer, and resolveSelfEmployee (auth) rejects a
      //    TERMINATED/RETIRED employee, so the leaver's session stops resolving for
      //    state-changing calls the instant settle commits.
      if (employee && employee.userId) {
        await tx.user.update({ where: { id: employee.userId }, data: { isActive: false, businessRoleId: null } });
      }
      // Deactivate every Customer (portal/ESS account) tied to the leaver's emails or
      // linked User — match the resolveSelfEmployee linkage so no live session remains.
      const leaverEmails = [
        employee && employee.workEmail,
        employee && employee.personalEmail,
        employee && employee.user && employee.user.email,
      ].filter(Boolean);
      if (leaverEmails.length) {
        await tx.customer.updateMany({
          where: { businessId, isActive: true, email: { in: leaverEmails } },
          data: { isActive: false },
        });
      }
      // 4. Complete the REVOKE_ACCESS task + advance the journey to COMPLETED.
      const journey = await tx.lifecycleJourney.findFirst({ where: { businessId, separationId: sep.id, deletedAt: null } });
      if (journey) {
        const revoke = await tx.lifecycleTask.findFirst({ where: { journeyId: journey.id, taskKey: 'REVOKE_ACCESS' } });
        if (revoke && !['DONE', 'SKIPPED', 'NOT_APPLICABLE'].includes(revoke.status)) {
          await tx.lifecycleTask.update({ where: { id: revoke.id }, data: { status: 'DONE', completedAt: new Date(), completedByUserId: req.user.id, version: { increment: 1 } } });
        }
        const tasks = await tx.lifecycleTask.findMany({ where: { journeyId: journey.id } });
        const adv = advanceJourney(journey, tasks);
        await tx.lifecycleJourney.update({ where: { id: journey.id }, data: { currentStage: adv.currentStage, status: adv.status, version: { increment: 1 } } });
      }
      // 5. Mark the FnF PayRun paid (settlement disbursed).
      if (sep.fnfPayRunId) {
        await tx.payRun.update({ where: { id: sep.fnfPayRunId }, data: { status: 'PAID', paidAt: new Date() } }).catch(() => {});
      }
      const updated = await tx.separationCase.update({ where: { id: sep.id }, data: { status: 'SETTLED', version: { increment: 1 } } });
      return { sep: updated, settled: settleRes.changed, reassignedReports: reports.length };
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'separation.settle',
      entityType: 'SeparationCase', entityId: sep.id,
      meta: { code: sep.code, status, reassignedReports: out.reassignedReports },
    });
    res.json({ separation: out.sep, reassignedReports: out.reassignedReports });
  } catch (e) { next(e); }
}

// =====================================================================
// POST /separations/:id/letters — generate relieving / experience letters
//   (canGenerateLetters; gated on SETTLED). Writes a branded EmployeeDocument
//   with a verifiable fileHash (simple HTML doc when no e-sign module present).
// =====================================================================
const LETTER_KINDS = { relieving: { category: 'OFFER_LETTER', title: 'Relieving Letter' }, experience: { category: 'EXPERIENCE', title: 'Experience Certificate' } };
async function generateLetters(req, res, next) {
  try {
    const sep = await loadScopedCase(req, res);
    if (!sep) return undefined;
    const kind = String((req.body && req.body.type) || 'relieving').toLowerCase();
    if (!LETTER_KINDS[kind]) {
      return res.status(422).json({ message: `Unknown letter type: ${kind}`, types: Object.keys(LETTER_KINDS) });
    }
    // S9: relieving/experience letters REQUIRE status SETTLED. The override path is
    // strictly bounded: it can only relax SETTLED → FNF_APPROVED (the dues are
    // already approved) and NEVER earlier — a plain override can no longer mint a
    // relieving letter pre-FnF-approval. It also requires an ELEVATED permission
    // (canManageOrg, an admin-grade key the base canGenerateLetters role need not
    // hold) AND is audited. A non-SETTLED, non-FNF_APPROVED case is always refused.
    const overrideRequested = req.body && req.body.override === true;
    let overrideUsed = false;
    if (sep.status !== 'SETTLED') {
      if (!overrideRequested) {
        return res.status(422).json({ message: 'Letters are available only after the separation is SETTLED (an elevated override can force from FNF_APPROVED only, audited)', reason: 'not-settled' });
      }
      // Override never bypasses the FnF: pre-FNF-approval states are hard-refused.
      if (sep.status !== 'FNF_APPROVED') {
        return res.status(422).json({ message: `A letter cannot be forced before the FnF is approved (status: ${sep.status})`, reason: 'override-pre-fnf-approval' });
      }
      // Override requires an elevated permission beyond the base canGenerateLetters.
      const perms = effectivePermissions(req.user) || {};
      if (perms.canManageOrg !== true) {
        return res.status(403).json({ message: 'Forcing a letter before SETTLED requires an elevated permission (canManageOrg)', reason: 'override-needs-elevated-permission', missingPermission: 'canManageOrg' });
      }
      overrideUsed = true;
    }
    const businessId = req.user.businessId;
    const employee = await prisma.employee.findFirst({ where: { id: sep.employeeId, businessId } });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    const business = await prisma.business.findFirst({ where: { id: businessId }, select: { name: true } });

    // Branded HTML letter with correct tenure dates. (No e-sign module mounted in
    // 4f → write a simple branded HTML doc with a verifiable SHA-256 fileHash.)
    const meta = LETTER_KINDS[kind];
    const fullName = `${employee.firstName || ''} ${employee.lastName || ''}`.trim();
    const hire = employee.hireDate ? new Date(employee.hireDate).toISOString().slice(0, 10) : '—';
    const lwd = sep.lastWorkingDay ? new Date(sep.lastWorkingDay).toISOString().slice(0, 10) : '—';
    const html = [
      `<html><head><title>${meta.title}</title></head><body>`,
      `<h1>${business ? business.name : 'Company'}</h1>`,
      `<h2>${meta.title}</h2>`,
      `<p>This is to certify that ${fullName} (Employee Code ${employee.code}) was employed with `,
      `${business ? business.name : 'us'} from ${hire} to ${lwd}.</p>`,
      kind === 'relieving'
        ? `<p>The employee has been relieved of their duties effective ${sep.relievingDate ? new Date(sep.relievingDate).toISOString().slice(0, 10) : lwd} and all dues have been settled.</p>`
        : `<p>We confirm their service and wish them well in their future endeavours.</p>`,
      `<p>Separation reference: ${sep.code}</p>`,
      `</body></html>`,
    ].join('');
    const fileHash = crypto.createHash('sha256').update(html).digest('hex');
    // data: URL key (no object storage write in 4f; the hash is verifiable).
    const fileUrl = `data:text/html;base64,${Buffer.from(html).toString('base64')}`;

    const doc = await prisma.employeeDocument.create({
      data: {
        businessId,
        employeeId: sep.employeeId,
        category: meta.category,
        name: `${meta.title} — ${sep.code}`,
        fileUrl,
        fileHash,
        mimeType: 'text/html',
        sizeBytes: Buffer.byteLength(html),
        visibility: 'EMPLOYEE_VISIBLE',
        signatureStatus: 'NOT_REQUIRED',
      },
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'separation.letter',
      entityType: 'EmployeeDocument', entityId: doc.id,
      meta: { code: sep.code, kind, fileHash, override: overrideUsed, forcedFromStatus: overrideUsed ? sep.status : null },
    });
    res.status(201).json({ document: { id: doc.id, name: doc.name, category: doc.category, fileHash: doc.fileHash, visibility: doc.visibility } });
  } catch (e) { next(e); }
}

// =====================================================================
// POST /separations/:id/cancel — withdraw a pre-SETTLE case (HR cancel).
// =====================================================================
async function cancelSeparation(req, res, next) {
  try {
    const sep = await loadScopedCase(req, res);
    if (!sep) return undefined;
    if (sep.status === 'SETTLED') {
      return res.status(409).json({ message: 'Cannot cancel a settled separation' });
    }
    if (sep.status === 'CANCELLED') {
      return res.status(409).json({ message: 'Separation already cancelled' });
    }
    const businessId = req.user.businessId;
    const out = await prisma.$transaction(async (tx) => {
      const updated = await tx.separationCase.update({ where: { id: sep.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      // Employee returns to ACTIVE (they were flipped to NOTICE_PERIOD on initiate).
      await tx.employee.updateMany({ where: { id: sep.employeeId, businessId, status: 'NOTICE_PERIOD' }, data: { status: 'ACTIVE' } });
      const journey = await tx.lifecycleJourney.findFirst({ where: { businessId, separationId: sep.id, deletedAt: null } });
      if (journey) await tx.lifecycleJourney.update({ where: { id: journey.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      return updated;
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'separation.cancel', entityType: 'SeparationCase', entityId: sep.id, meta: { code: sep.code, reason: req.body && req.body.reason } });
    res.json({ separation: out });
  } catch (e) { next(e); }
}

module.exports = {
  initiateSeparation,
  listSeparations,
  getSeparation,
  updateClearance,
  computeFnf: computeFnfEndpoint,
  approveFnf,
  settleSeparation,
  generateLetters,
  cancelSeparation,
  // exported for tests
  _internals: {
    seedOffboardingJourney, resolveLastDrawnPay, resolveEncashableLeaveDays,
    resolveLoanOutstanding, resolveAssetRecovery, assetReturnState,
    resolveNzEarningsHistory, deriveNoticeShortfallDays, daysBetween,
    CLEARANCE_LANES, BLOCKING_LANES, minorToDecimal,
  },
};
