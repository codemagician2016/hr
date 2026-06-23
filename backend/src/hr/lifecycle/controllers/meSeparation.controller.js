'use strict';

/**
 * meSeparation.controller.js — exiting-employee SELF-SERVICE separation surface
 * (Feature 4 §4.6 ESS, §6 "exiting employee experience", slice 4f). Mounted at
 * /api/hr/me/separation.
 *
 * SELF-ONLY by construction (§4.5): there is NO `:id` in any path. The subject
 * employee is resolved ENTIRELY from the CUSTOMER session (workEmail /
 * personalEmail / linked User) — a body `employeeId` is structurally ignored, so a
 * caller cannot reach another person's case. Cross-tenant is blocked by the
 * businessId on every where-clause (mirror of meDocuments / payroll resolveSelf).
 *
 *   POST /resign  → create exactly ONE active SeparationCase(RESIGNATION,INITIATED)
 *                   on the session employee + spawn the OFFBOARDING journey; a
 *                   second active submit is rejected (409).
 *   GET  /        → the caller's active case (status timeline + clearance lanes +
 *                   own pending tasks).
 *   GET  /fnf     → the FnF statement snapshot once FNF_COMPUTED (figures equal the
 *                   HR SeparationCase snapshot exactly, §7 QA15).
 *   POST /assets/:id/acknowledge → ESS asset acknowledgment (acknowledgmentSignedAt).
 */

const prisma = require('../../../core/lib/prisma');
const { allocateCode } = require('../lib/codes');
const { seedJourneyTasks } = require('../journeyEngine');
const { getDefaultOffboardingTemplate } = require('../templates/seed');

function toDateOnly(x) {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Resolve the session customer's own Employee (id + the bits we need). Mirror of
// documents.controller resolveSelfEmployeeId. Returns the row or null.
async function resolveSelfEmployee(businessId, customer) {
  if (!customer || !customer.email) return null;
  const byEmail = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] },
    select: { id: true, code: true, firstName: true, lastName: true, managerEmployeeId: true, status: true, hireDate: true, userId: true },
  });
  if (byEmail) return byEmail;
  const byUser = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select: { id: true, code: true, firstName: true, lastName: true, managerEmployeeId: true, status: true, hireDate: true, userId: true },
  });
  return byUser || null;
}

async function resolveEmployeeEntity(businessId, employeeId) {
  const record = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!record) return { entity: null, record: null };
  const entity = await prisma.entity.findFirst({ where: { id: record.entityId, businessId } });
  return { entity, record };
}

// POST /me/separation/resign — self-resign. Session-derived; one active case.
async function resign(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employee = await resolveSelfEmployee(businessId, req.customer);
    if (!employee) return res.status(404).json({ message: 'No employee record is linked to your account' });

    // Exactly ONE active case per employee (second submit rejected, §6 / §7 QA23).
    const active = await prisma.separationCase.findFirst({
      where: { businessId, employeeId: employee.id, deletedAt: null, status: { notIn: ['SETTLED', 'CANCELLED'] } },
    });
    if (active) return res.status(409).json({ message: 'You already have an active separation request', separationId: active.id });

    const { entity, record } = await resolveEmployeeEntity(businessId, employee.id);
    if (!entity) return res.status(422).json({ message: 'No active employment record found for your account', reason: 'precondition' });

    const { intendedLastDay, reason } = req.body || {};
    const noticeDays = record && record.noticeDays != null ? record.noticeDays : null;

    const out = await prisma.$transaction(async (tx) => {
      const code = await allocateCode(tx, { businessId, entityId: entity.id, scope: 'SEP' });
      const sep = await tx.separationCase.create({
        data: {
          businessId,
          employeeId: employee.id,
          entityId: entity.id,
          code,
          type: 'RESIGNATION',
          reason: reason || null,
          initiatedAt: toDateOnly(new Date()),
          resignationDate: toDateOnly(new Date()),
          noticePeriodDays: noticeDays,
          lastWorkingDay: toDateOnly(intendedLastDay),
          currencyCode: entity.payCurrency,
          status: 'INITIATED',
          clearanceJson: {},
        },
      });
      // Spawn the OFFBOARDING journey (reuse the HR seeder shape).
      const cc = entity.countryCode === 'NZ' ? 'NZ' : 'IN';
      const tpl = await getDefaultOffboardingTemplate(tx, businessId, cc);
      const ownerResolution = {
        EMPLOYEE: { employeeId: employee.id },
        MANAGER: employee.managerEmployeeId ? { employeeId: employee.managerEmployeeId } : {},
      };
      const ctx = {
        businessId,
        noticeStartDate: sep.resignationDate,
        lastWorkingDay: sep.lastWorkingDay,
        relievingDate: sep.lastWorkingDay,
        ownerResolution,
      };
      const taskPayloads = tpl ? seedJourneyTasks(tpl.template, tpl.taskDefs, ctx) : [];
      const jCode = await allocateCode(tx, { businessId, entityId: entity.id, scope: 'OFFBOARD' });
      const journey = await tx.lifecycleJourney.create({
        data: {
          businessId, entityId: entity.id, code: jCode, direction: 'OFFBOARDING',
          templateId: tpl ? tpl.template.id : null, employeeId: employee.id, separationId: sep.id,
          noticeStartDate: toDateOnly(sep.resignationDate), lastWorkingDay: toDateOnly(sep.lastWorkingDay),
          relievingDate: toDateOnly(sep.lastWorkingDay), currentStage: 'SEPARATION_INITIATED', status: 'IN_PROGRESS',
          tasks: { create: taskPayloads.map((t) => ({ ...t, businessId })) },
        },
      });
      await tx.employee.update({ where: { id: employee.id }, data: { status: 'NOTICE_PERIOD', version: { increment: 1 } } });
      return { sep, journey };
    });

    // Short-notice amber warning (intended last day inside the notice period).
    let shortNotice = false;
    if (noticeDays != null && out.sep.lastWorkingDay) {
      const days = Math.floor((new Date(out.sep.lastWorkingDay).getTime() - Date.now()) / 86400000);
      shortNotice = days < noticeDays;
    }
    res.status(201).json({ separation: out.sep, shortNotice, noticeDays });
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: 'You already have an active separation request' });
    next(e);
  }
}

// GET /me/separation — the caller's active case + journey tasks + clearance lanes.
async function getMySeparation(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employee = await resolveSelfEmployee(businessId, req.customer);
    if (!employee) return res.json({ separation: null });
    const sep = await prisma.separationCase.findFirst({
      where: { businessId, employeeId: employee.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!sep) return res.json({ separation: null });
    const journey = await prisma.lifecycleJourney.findFirst({
      where: { businessId, separationId: sep.id, deletedAt: null },
      include: { tasks: { orderBy: [{ stageKey: 'asc' }, { dueDate: 'asc' }] } },
    });
    res.json({
      separation: {
        id: sep.id, code: sep.code, type: sep.type, status: sep.status,
        initiatedAt: sep.initiatedAt, resignationDate: sep.resignationDate,
        lastWorkingDay: sep.lastWorkingDay, relievingDate: sep.relievingDate,
        clearanceJson: sep.clearanceJson || {},
      },
      journey: journey ? { id: journey.id, code: journey.code, currentStage: journey.currentStage, status: journey.status, tasks: journey.tasks } : null,
    });
  } catch (e) { next(e); }
}

// GET /me/separation/fnf — the FnF statement snapshot (once FNF_COMPUTED). The
// figures equal the HR SeparationCase snapshot EXACTLY (§7 QA15). 404 before
// FNF_COMPUTED so nothing leaks pre-computation.
async function getMyFnf(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employee = await resolveSelfEmployee(businessId, req.customer);
    if (!employee) return res.status(404).json({ message: 'No FnF statement available' });
    const sep = await prisma.separationCase.findFirst({
      where: { businessId, employeeId: employee.id, deletedAt: null, status: { in: ['FNF_COMPUTED', 'FNF_APPROVED', 'SETTLED'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!sep) return res.status(404).json({ message: 'No FnF statement available yet' });
    // The snapshot lines == the persisted SeparationCase money fields, 1:1.
    res.json({
      code: sep.code,
      currencyCode: sep.currencyCode,
      status: sep.status,
      lines: {
        gratuityAmount: sep.gratuityAmount,
        leaveEncashmentDays: sep.leaveEncashmentDays,
        leaveEncashmentAmount: sep.leaveEncashmentAmount,
        nzHolidayPayoutAmount: sep.nzHolidayPayoutAmount,
        noticeRecoveryAmount: sep.noticeRecoveryAmount,
        loanForeclosureAmount: sep.loanForeclosureAmount,
        assetRecoveryAmount: sep.assetRecoveryAmount,
        netSettlement: sep.netSettlement,
      },
      recoverableBalance: sep.netSettlement != null && Number(sep.netSettlement) < 0,
    });
  } catch (e) { next(e); }
}

// POST /me/separation/assets/:id/acknowledge — ESS asset acknowledgment (slice 4e).
// The employee confirms they hold / will return a given asset; stamps
// AssetAssignment.acknowledgmentSignedAt. Only the caller's OWN open assignments.
async function acknowledgeAsset(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employee = await resolveSelfEmployee(businessId, req.customer);
    if (!employee) return res.status(404).json({ message: 'Assignment not found' });
    const assignment = await prisma.assetAssignment.findFirst({
      where: { id: req.params.id, businessId, employeeId: employee.id },
    });
    if (!assignment) return res.status(404).json({ message: 'Assignment not found' });
    const updated = await prisma.assetAssignment.update({
      where: { id: assignment.id },
      data: { acknowledgmentSignedAt: new Date() },
      include: { asset: { select: { code: true, name: true, category: true } } },
    });
    res.json({ assignment: { id: updated.id, acknowledgmentSignedAt: updated.acknowledgmentSignedAt, asset: updated.asset } });
  } catch (e) { next(e); }
}

// GET /me/separation/assets — the caller's OWN asset assignments (for the exit
// checklist's asset-return tracker).
async function listMyAssets(req, res, next) {
  try {
    const { businessId } = req.customer;
    const employee = await resolveSelfEmployee(businessId, req.customer);
    if (!employee) return res.json({ items: [] });
    const items = await prisma.assetAssignment.findMany({
      where: { businessId, employeeId: employee.id },
      include: { asset: { select: { code: true, name: true, category: true } } },
      orderBy: { assignedAt: 'desc' },
    });
    res.json({ items });
  } catch (e) { next(e); }
}

module.exports = {
  resign,
  getMySeparation,
  getMyFnf,
  acknowledgeAsset,
  listMyAssets,
};
