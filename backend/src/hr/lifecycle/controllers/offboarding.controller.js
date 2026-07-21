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
const { fyPeriodCode } = require('../../leave/periodCode');

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
//
// Also returns basicMonthlyMinor (BASIC kind ONLY) so the encashment BASIC_30 basis can
// price Basic/30 — NOT (Basic+DA)/30 (finding #2). BASIC_DA_26 keeps Basic+DA.
const BASIC_DA_KINDS = new Set(['BASIC', 'DEARNESS_ALLOWANCE']);
async function resolveLastDrawnPay(businessId, employeeId, db = prisma) {
  const comp = await db.compensationRevision.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
    include: { lines: { include: { component: { select: { kind: true } } } } },
  });
  if (!comp) return { basicDaMonthlyMinor: 0, basicMonthlyMinor: 0, grossMonthlyMinor: 0 };
  let basicDa = 0;
  let basic = 0;
  for (const ln of comp.lines || []) {
    const kind = ln.component && ln.component.kind;
    if (ln.amountMonthly == null) continue;
    if (BASIC_DA_KINDS.has(kind)) basicDa += Number(ln.amountMonthly);
    if (kind === 'BASIC') basic += Number(ln.amountMonthly);
  }
  const grossMonthlyMinor = comp.grossMonthly != null ? decimalToMinor(comp.grossMonthly) : 0;
  return {
    basicDaMonthlyMinor: Math.round(basicDa * 100),
    basicMonthlyMinor: Math.round(basic * 100),
    grossMonthlyMinor,
  };
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

// The leave PERIOD a separation's FnF prices/encashes against — the financial
// year containing the last working day, using the entity's tax-year start (the
// SAME scheme provision/accrualRunner mint LeaveBalance rows under). Both the FnF
// valuation and the settle write-back use this so they price and pay the same
// period's row (finding #4).
function resolveFnfLeavePeriod(sep, entity) {
  const lwd = (sep && sep.lastWorkingDay) ? new Date(sep.lastWorkingDay) : new Date();
  const startMonth = (entity && entity.taxYearStartMonth) || 4;
  return fyPeriodCode(lwd, startMonth);
}

// Encashable leave balance (days) for an employee — Σ LeaveBalance.closing over
// encashable LeaveTypes FOR THE CURRENT PERIOD only (finding #4). Summing across
// ALL periods would encash stale/duplicated prior-period rows and (when a source
// period was not zeroed by carry-forward) double-count carried units → over-pay.
// `periodCode` scopes the query; when omitted (defensive) we fall back to the
// single most-recent row per type so the valuation never silently doubles.
async function resolveEncashableLeaveDays(businessId, employeeId, db = prisma, { periodCode = null } = {}) {
  if (periodCode) {
    const balances = await db.leaveBalance.findMany({
      where: { businessId, employeeId, periodCode, leaveType: { is: { isEncashable: true } } },
      select: { closing: true },
    });
    let days = 0;
    for (const b of balances) days += Number(b.closing || 0);
    return days;
  }
  // Fallback: one row per encashable leaveType (the newest) — never sum periods.
  const balances = await db.leaveBalance.findMany({
    where: { businessId, employeeId, leaveType: { is: { isEncashable: true } } },
    select: { closing: true, leaveTypeId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
  });
  const seen = new Set();
  let days = 0;
  for (const b of balances) {
    if (seen.has(b.leaveTypeId)) continue;
    seen.add(b.leaveTypeId);
    days += Number(b.closing || 0);
  }
  return days;
}

// FnF encashment write-back (§4.11 — closes the audited gap). For each encashable
// LeaveBalance with a positive closing IN THE FnF PERIOD, post an append-only
// ENCASHMENT LeaveTransaction (quantity = −closing, stamped with the FnF payRunId)
// and move the units into the `encashed` bucket (NEVER `taken`) so closing → 0 and
// the §4.2 ledger identity still holds after the payout. MUST run inside the settle
// $transaction. `periodCode` scopes the write-back to the SAME period the FnF
// valuation (resolveEncashableLeaveDays) priced, so we never encash/pay a stale or
// duplicated prior-period row (finding #4). Returns { encashedDays, lines:[…] }.
async function writeBackLeaveEncashment(tx, { businessId, employeeId, payRunId, periodCode = null }) {
  const balances = await tx.leaveBalance.findMany({
    where: {
      businessId, employeeId, leaveType: { is: { isEncashable: true } },
      ...(periodCode ? { periodCode } : {}),
    },
    include: { leaveType: { select: { unit: true } } },
  });
  const lines = [];
  let encashedDays = 0;
  for (const bal of balances) {
    const units = Number(bal.closing || 0);
    if (units <= 0) continue;
    await tx.leaveTransaction.create({
      data: {
        businessId, employeeId, leaveTypeId: bal.leaveTypeId, leaveBalanceId: bal.id,
        txnType: 'ENCASHMENT', unit: bal.unit || (bal.leaveType ? bal.leaveType.unit : 'DAYS'),
        quantity: -units, status: 'APPROVED', appliedAt: new Date(), decidedAt: new Date(),
        payRunId: payRunId || null, reason: 'Leave encashment on full & final settlement',
      },
    });
    await tx.leaveBalance.update({
      where: { id: bal.id },
      data: { encashed: { increment: units }, closing: { decrement: units }, version: { increment: 1 } },
    });
    lines.push({ leaveBalanceId: bal.id, leaveTypeId: bal.leaveTypeId, units });
    encashedDays += units;
  }
  return { encashedDays: Math.round(encashedDays * 1e4) / 1e4, lines };
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
    // The leaving employee's OPEN asset assignments (still OUT — returnedAt null).
    // Surfaced so the asset-return lane is actionable: the admin can mark each one
    // returned or record a recovery via POST /assets/assignments/:id/return,
    // which is what assetReturnState (the compute/settle guard) keys off.
    const openAssets = await prisma.assetAssignment.findMany({
      where: { businessId: req.user.businessId, employeeId: sep.employeeId, returnedAt: null },
      select: {
        id: true, status: true, assignedAt: true, recoveryAmount: true,
        asset: { select: { id: true, code: true, name: true, category: true } },
      },
      orderBy: { assignedAt: 'asc' },
    });
    return res.json({ separation: sep, journey, openAssets });
  } catch (e) { return next(e); }
}

// =====================================================================
// PATCH /separations/:id/clearance — per-lane updates into clearanceJson
// =====================================================================
async function updateClearance(req, res, next) {
  try {
    // Wave 2B — a canApprovePayroll holder (finance lane's persona) may lack
    // canViewEmployees, leaving scope NONE; widen to ALL for THIS endpoint (the
    // per-lane permission checks below still gate what they can clear).
    {
      const { effectivePermissions } = require('../../../core/lib/rbac');
      const perms = effectivePermissions(req.user) || {};
      if (req.scope && req.scope.kind !== 'ALL' && perms.canApprovePayroll) {
        req.scope = { kind: 'ALL' };
      }
    }
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
    // Period-scope the encashable valuation to the FY containing the LWD (finding #4).
    const fnfLeavePeriod = resolveFnfLeavePeriod(sep, entity);
    const encashableLeaveDays = await resolveEncashableLeaveDays(businessId, sep.employeeId, prisma, { periodCode: fnfLeavePeriod });
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
      // P1.7 — the entity's notice per-day divisor (NULL = 30-day convention).
      noticeDaysInMonth: entity && entity.noticeDivisorDays ? entity.noticeDivisorDays : undefined,
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

    // Wave 2B — (re)open the SEPARATION approval for this FnF. A recompute
    // cancels any prior open request (its totals are stale) and opens a fresh
    // one, so the approver always decides on the CURRENT snapshot.
    try {
      const engine = require('../../approvals/engine');
      require('../../approvals/consumers.separation');
      const prior = await prisma.approvalRequest.findFirst({
        where: { businessId, module: 'SEPARATION', entityId: sep.id, status: { in: ['PENDING', 'ESCALATED'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (prior) {
        await engine.cancel({ approvalRequestId: prior.id, actorUserId: req.user.id || 'SYSTEM', comment: 'Superseded by FnF recompute' });
      }
      const opened = await engine.openRequest({
        businessId,
        module: 'SEPARATION',
        entityType: 'SeparationCase',
        entityId: sep.id,
        requesterEmployeeId: sep.employeeId,
        payload: {
          code: sep.code,
          separationType: sep.type,
          netSettlementMinor: fnf.snapshot.netSettlementMinor,
          amount: Math.round((fnf.snapshot.netSettlementMinor || 0) / 100),
        },
        ctx: { entityId: sep.id, amount: Math.round((fnf.snapshot.netSettlementMinor || 0) / 100) },
      });
      await prisma.separationCase.update({
        where: { id: sep.id },
        data: { approvalRequestId: opened.approvalRequest.id },
      });
    } catch (e) {
      console.error('[separation] failed to open FnF approval request:', e.message);
    }

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
/**
 * mintFnfApproval(tx, { businessId, sep, actorUserId }) — Wave 2B shared core:
 * mint the FnF PayRun from the persisted snapshot + flip FNF_APPROVED. Used by
 * BOTH the direct approve-fnf route and the SEPARATION engine consumer, so the
 * mint is byte-identical on either path. IDEMPOTENT: a case already approved /
 * already carrying fnfPayRunId returns without minting (the double-PayRun risk
 * from the Phase-2 audit).
 */
async function mintFnfApproval(tx, { businessId, sep, actorUserId }) {
  if (sep.status !== 'FNF_COMPUTED' || sep.fnfPayRunId) {
    const current = await tx.separationCase.findFirst({ where: { id: sep.id, businessId } });
    return { payRun: null, sep: current, grossMinor: 0, totalDeductionsMinor: 0, netMinor: 0, skipped: true };
  }
  // The snapshot's payRunInput is the ONLY mint source (M1+M2 — never re-derive
  // from the Decimal columns). Was computed by the caller pre-extraction; the
  // helper derives it itself so both entry paths are self-contained.
  const snap = sep.fnfSnapshotJson || null;
  const payRunInput = snap && snap.payRunInput ? snap.payRunInput : null;
  if (!payRunInput || !Array.isArray(payRunInput.earnings) || !Array.isArray(payRunInput.deductions)) {
    const err = new Error('FnF snapshot is missing or incomplete; re-run compute-fnf before approval');
    err.status = 409; err.reason = 'snapshot-missing';
    throw err;
  }
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
          approvedBy: actorUserId,
          notes: `Full-and-final settlement for ${sep.code} — ${payRunInput.earnings.length} earning / ${payRunInput.deductions.length} deduction line(s)`,
        },
      });
      // Write the per-line detail (PayRunLine + components) so the FnF payslip
      // reconciles line-by-line, not just at the run header — mirrors the regular
      // payroll line/component shape; the breakdown also lives in fnfSnapshotJson.
      const fnfEmp = await tx.employee.findUnique({ where: { id: sep.employeeId }, select: { currentCompensationId: true } });
      if (fnfEmp && fnfEmp.currentCompensationId) {
        const fnfLine = await tx.payRunLine.create({
          data: {
            businessId, payRunId: payRun.id, employeeId: sep.employeeId,
            compensationId: fnfEmp.currentCompensationId, payableDays: 0,
            grossEarnings: minorToDecimal(grossMinor),
            totalDeductions: minorToDecimal(totalDeductionsMinor),
            netPay: minorToDecimal(netMinor),
            currencyCode: sep.currencyCode, status: 'COMPUTED',
          },
        });
        let sort = 0;
        const comps = [];
        for (const e of payRunInput.earnings || []) comps.push({ businessId, payRunLineId: fnfLine.id, componentId: e.code, componentCode: e.code, componentName: e.label || e.code, category: 'EARNING', amount: minorToDecimal(e.amountMinor), sortOrder: sort++ });
        for (const d of payRunInput.deductions || []) comps.push({ businessId, payRunLineId: fnfLine.id, componentId: d.code, componentCode: d.code, componentName: d.label || d.code, category: 'DEDUCTION', amount: minorToDecimal(d.amountMinor), isStatutory: !!d.statutory, sortOrder: sort++ });
        if (comps.length) await tx.payRunLineComponent.createMany({ data: comps });
      }
      const updated = await tx.separationCase.update({
        where: { id: sep.id },
        data: { status: 'FNF_APPROVED', fnfPayRunId: payRun.id, version: { increment: 1 } },
      });
      return { payRun, sep: updated, grossMinor, totalDeductionsMinor, netMinor };
}

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
    // Program Phase 2 Wave B — an open SEPARATION engine request owns the
    // decision (the consumer performs the identical mint). SoD above already
    // enforced by this route; inbox decisions add engine SoD + membership.
    {
      const engine = require('../../approvals/engine');
      require('../../approvals/consumers.separation');
      const open = await prisma.approvalRequest.findFirst({
        where: { businessId, module: 'SEPARATION', entityId: sep.id, status: { in: ['PENDING', 'ESCALATED'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (open) {
        await engine.recordDecision({
          approvalRequestId: open.id,
          actorUserId: req.user.id || 'SYSTEM',
          decision: 'APPROVED',
          systemActor: true,
        });
        const freshSep = await prisma.separationCase.findFirst({ where: { id: sep.id, businessId } });
        await writeAudit({
          businessId, actorId: req.user.id, action: 'separation.approve-fnf',
          entityType: 'SeparationCase', entityId: sep.id,
          meta: { code: sep.code, payRunId: freshSep.fnfPayRunId, initiatorUserId, via: 'engine' },
        });
        return res.json({ separation: freshSep, fnfPayRunId: freshSep.fnfPayRunId });
      }
    }
    const out = await prisma.$transaction(async (tx) => mintFnfApproval(tx, { businessId, sep, actorUserId: req.user.id }));

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

    // Resolve the FnF leave period (FY containing LWD) so the encashment write-back
    // scopes to the SAME period the FnF valuation priced (finding #4) — never sums
    // across stale/duplicated prior-period rows.
    const { entity: settleEntity } = await resolveEmployeeEntity(businessId, sep.employeeId);
    const fnfLeavePeriod = resolveFnfLeavePeriod(sep, settleEntity);

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
      // 6. Leave-encashment write-back (§4.11): the FnF run already minted the
      //    FNF_LEAVE_ENCASH / FNF_NZ_HOLIDAY_PAYOUT earnings, but the leave ledger
      //    was left stale (no ENCASHMENT txn, no `.encashed` move). Post it now so
      //    the balance closes to 0 via `encashed` (never `taken`) and the ledger
      //    reconciles against the payout. Idempotent: a re-settle finds closing=0.
      const encash = await writeBackLeaveEncashment(tx, { businessId, employeeId: sep.employeeId, payRunId: sep.fnfPayRunId, periodCode: fnfLeavePeriod });
      const updated = await tx.separationCase.update({ where: { id: sep.id }, data: { status: 'SETTLED', version: { increment: 1 } } });
      return { sep: updated, settled: settleRes.changed, reassignedReports: reports.length, encashedDays: encash.encashedDays, encashLines: encash.lines };
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'separation.settle',
      entityType: 'SeparationCase', entityId: sep.id,
      meta: { code: sep.code, status, reassignedReports: out.reassignedReports, leaveEncashedDays: out.encashedDays },
    });
    res.json({ separation: out.sep, reassignedReports: out.reassignedReports, leaveEncashedDays: out.encashedDays });
  } catch (e) { next(e); }
}

// =====================================================================
// POST /separations/:id/letters — generate relieving / experience letters
//   (canGenerateLetters; gated on SETTLED). Feature 09 slice 9F: this no longer
//   hand-concatenates a `data:text/html` EmployeeDocument — it delegates to the
//   shared Letters engine (`letters.service.issueLetter`) which mints a real
//   letterhead PDF + a per-tenant reference number, writes the EmployeeDocument
//   (EMPLOYEE_VISIBLE), and chains the audit. The SETTLED gate, the bounded
//   elevated override, and `writeAudit` here are PRESERVED.
//
//   `letters.service.js` is owned/built by slice 9E and is absent in this worktree;
//   the require is therefore LAZY + GUARDED so node --check and the require-graph
//   resolve today and the live engine is picked up automatically post-merge. Until
//   the service is present the endpoint returns 501 (not a silent stub).
// =====================================================================
// kind → LetterCategory (the issuance taxonomy, schema enum). The LetterCategory
// enum has no dedicated RELIEVING value, so a relieving letter maps to EXPERIENCE
// (service/experience certificate family); the distinct wording is carried by the
// template the engine resolves + the `kind`/`subject` overrides we pass through.
const SEPARATION_LETTER_KINDS = {
  relieving:  { category: 'EXPERIENCE', title: 'Relieving Letter' },
  experience: { category: 'EXPERIENCE', title: 'Experience Certificate' },
};

// Lazy + guarded load of the 9E-owned engine. Returns the module or null if it is
// not yet present (this worktree). MERGE NOTE: no code change needed at merge — once
// letters/letters.service.js exists exporting issueLetter, this resolves it.
function loadLettersService() {
  try {
    // eslint-disable-next-line global-require
    return require('../../letters/letters.service');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}

// Resolve a published LetterTemplate for the given category, preferring the
// employee's entity country (IN/NZ) then a country-agnostic one. Tenant-scoped.
// (The engine itself resolves the letterhead by template/category/default.)
async function resolveSeparationTemplate(businessId, category, countryCode) {
  const base = { businessId, category, isActive: true, deletedAt: null };
  if (countryCode) {
    const byCountry = await prisma.letterTemplate.findFirst({
      where: { ...base, countryCode },
      orderBy: [{ isSystem: 'desc' }, { updatedAt: 'desc' }],
    });
    if (byCountry) return byCountry;
  }
  return prisma.letterTemplate.findFirst({
    where: base,
    orderBy: [{ isSystem: 'desc' }, { updatedAt: 'desc' }],
  });
}

async function generateLetters(req, res, next) {
  try {
    const sep = await loadScopedCase(req, res);
    if (!sep) return undefined;
    const kind = String((req.body && req.body.type) || 'relieving').toLowerCase();
    const meta = SEPARATION_LETTER_KINDS[kind];
    if (!meta) {
      return res.status(422).json({ message: `Unknown letter type: ${kind}`, types: Object.keys(SEPARATION_LETTER_KINDS) });
    }
    // S9 (PRESERVED): relieving/experience letters REQUIRE status SETTLED. The override
    // path is strictly bounded: it can only relax SETTLED → FNF_APPROVED (the dues are
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

    // Shared Letters engine (9E). Guarded so this worktree (no service yet) still
    // node --check's + require-resolves; live engine is used automatically post-merge.
    const letters = loadLettersService();
    if (!letters || typeof letters.issueLetter !== 'function') {
      return res.status(501).json({
        message: 'Letters engine not available in this build (slice 9E reconciles at merge)',
        reason: 'letters-service-unavailable',
      });
    }

    // Resolve the entity (for the per-entity ref-no sequence + country wording) and
    // a published template for this category. Out-of-scope subject was already
    // enforced by loadScopedCase.
    const { entity } = await resolveEmployeeEntity(businessId, sep.employeeId);
    const countryCode = entity && entity.countryCode === 'NZ' ? 'NZ' : 'IN';
    let template = await resolveSeparationTemplate(businessId, meta.category, countryCode);
    if (!template) {
      // Self-heal: a tenant that never opened the Letters module still needs a
      // relieving/experience letter at offboarding. Seed the system IN/NZ
      // templates once, then re-resolve. (Idempotent; no-op if already seeded.)
      try {
        const { seedLetterTemplates } = require('../../letters/templates/seed');
        await seedLetterTemplates(prisma, businessId);
        template = await resolveSeparationTemplate(businessId, meta.category, countryCode);
      } catch (_e) { /* fall through to the 422 below */ }
    }
    if (!template) {
      return res.status(422).json({
        message: `No published ${meta.title} template is configured for ${countryCode}`,
        reason: 'no-template', category: meta.category, countryCode,
      });
    }

    const perms = effectivePermissions(req.user) || {};
    // Call the documented issueLetter interface (Feature 09 §4.3):
    //   { businessId, entityId, actorUserId, perms, templateId, employeeId, overrides, mode }
    // `overrides` carry the offboarding-specific facts (kind/subject/dates/ref) so the
    // engine's merge can render relieving-vs-experience wording + the separation ref.
    // issueLetter(client, args) — pass the prisma client first (it opens its own
    // $transaction for the ref-no + insert); the options object is the 2nd arg.
    const result = await letters.issueLetter(prisma, {
      businessId,
      entityId: entity ? entity.id : (sep.entityId || null),
      actorUserId: req.user.id,
      perms,
      templateId: template.id,
      employeeId: sep.employeeId,
      mode: 'issue',
      overrides: {
        kind,
        subject: meta.title,
        title: meta.title,
        separationCode: sep.code,
        separationId: sep.id,
        lastWorkingDay: sep.lastWorkingDay || null,
        relievingDate: sep.relievingDate || sep.lastWorkingDay || null,
      },
    });

    await writeAudit({
      businessId, actorId: req.user.id, action: 'separation.letter',
      entityType: 'IssuedLetter', entityId: (result && (result.issuedLetterId || result.id)) || null,
      meta: {
        code: sep.code, kind, category: meta.category,
        referenceNo: result && result.referenceNo,
        employeeDocumentId: result && result.employeeDocumentId,
        fileHash: result && result.fileHash,
        override: overrideUsed, forcedFromStatus: overrideUsed ? sep.status : null,
      },
    });
    // Response carries the new engine result AND a backward-compatible `document`
    // summary (the prior contract + the separation UI read document.fileHash/visibility).
    res.status(201).json({
      letter: result,
      document: result ? {
        id: result.employeeDocumentId || null,
        fileHash: result.fileHash || null,
        visibility: 'EMPLOYEE_VISIBLE',
        referenceNo: result.referenceNo || null,
        fileUrl: result.fileUrl || null,
      } : null,
    });
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
  // Wave 2B — shared FnF mint core (used by approvals/consumers.separation.js).
  _mintFnfApproval: mintFnfApproval,
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
    writeBackLeaveEncashment, resolveFnfLeavePeriod,
    resolveLoanOutstanding, resolveAssetRecovery, assetReturnState,
    resolveNzEarningsHistory, deriveNoticeShortfallDays, daysBetween,
    CLEARANCE_LANES, BLOCKING_LANES, minorToDecimal,
  },
};
