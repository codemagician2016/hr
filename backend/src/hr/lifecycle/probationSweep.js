'use strict';

/**
 * probationSweep.js — Program P1.4: nightly probation automation (02:15, after
 * the attendance sweep family). Two passes per tenant, both idempotent:
 *
 *  1. REMINDERS — employees on PROBATION whose probationEndDate is exactly
 *     policy.remindDaysBefore days away → notifyHrEvent('probation.ending') to
 *     the manager (fallback HR/business email). Exact-day match + one cron run
 *     per day = naturally deduped, no marker table.
 *
 *  2. AUTO-CONFIRM — when the resolved policy has autoConfirm=true and
 *     probationEndDate <= today → provision.confirmProbation() (idempotent,
 *     PROBATION→ACTIVE + EmploymentRecord PROBATION_CONFIRM + journey advance),
 *     then best-effort: CONFIRMATION letter via letters.issueLetter when the
 *     policy pins letterTemplateId (issued as the tenant owner), and a
 *     'probation.confirmed' notification to the employee.
 *
 * Employees whose policy has autoConfirm=false are ONLY reminded — HR confirms
 * manually (the existing confirm endpoint). Per-employee failures are counted,
 * never thrown (one bad row must not abort the sweep).
 */

const prisma = require('../../core/lib/prisma');
const { resolveProbationPolicy } = require('./controllers/probation.controller');
const { confirmProbation } = require('./provision');
const { notifyHrEvent } = require('../integrations/notifications');

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);

function addDays(base, days) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function issueConfirmationLetter(businessId, employee, policy) {
  if (!policy.letterTemplateId) return { issued: false };
  // Cron actor: the tenant admin user (every letter needs an accountable issuer;
  // BUSINESS_ADMIN ≈ owner in the legacy role enum).
  const owner = await prisma.user.findFirst({
    where: { businessId, role: 'BUSINESS_ADMIN', isActive: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!owner) return { issued: false, reason: 'no-owner' };
  const { issueLetter } = require('../letters/letters.service');
  const r = await issueLetter(prisma, {
    businessId,
    actorUserId: owner.id,
    perms: {}, // comp.* merge fields stay masked — a confirmation letter needs none
    templateId: policy.letterTemplateId,
    employeeId: employee.id,
    mode: 'issue',
  });
  return { issued: true, issuedLetterId: r.issuedLetterId };
}

async function runProbationSweep({ asOf = new Date() } = {}) {
  const summary = { tenants: 0, reminded: 0, confirmed: 0, lettersIssued: 0, errors: 0 };
  const today = dayKey(asOf);

  // Tenants that have anyone on probation with an end date (tiny result set).
  const groups = await prisma.employee.groupBy({
    by: ['businessId'],
    where: { status: 'PROBATION', probationEndDate: { not: null }, deletedAt: null },
  });

  for (const g of groups) {
    const businessId = g.businessId;
    summary.tenants += 1;
    const employees = await prisma.employee.findMany({
      where: { businessId, status: 'PROBATION', probationEndDate: { not: null }, deletedAt: null },
      select: {
        id: true, firstName: true, lastName: true, workEmail: true, personalEmail: true,
        probationEndDate: true, currentEmploymentRecordId: true,
      },
    });
    for (const emp of employees) {
      try {
        const rec = emp.currentEmploymentRecordId
          ? await prisma.employmentRecord.findUnique({
              where: { id: emp.currentEmploymentRecordId },
              select: { entityId: true, employmentType: true, managerEmployeeId: true },
            })
          : null;
        const policy = await resolveProbationPolicy(prisma, {
          businessId, entityId: rec ? rec.entityId : null, employmentType: rec ? rec.employmentType : null,
        });
        const endKey = dayKey(emp.probationEndDate);
        const name = [emp.firstName, emp.lastName].filter(Boolean).join(' ');

        // 1. reminder — exact-day match against the policy window (default 7).
        const remindDays = policy ? policy.remindDaysBefore : 7;
        if (remindDays > 0 && dayKey(addDays(asOf, remindDays)) === endKey) {
          let managerEmail = null;
          if (rec && rec.managerEmployeeId) {
            const mgr = await prisma.employee.findFirst({
              where: { id: rec.managerEmployeeId, businessId, deletedAt: null },
              select: { workEmail: true, personalEmail: true },
            });
            managerEmail = mgr ? (mgr.workEmail || mgr.personalEmail) : null;
          }
          await notifyHrEvent({
            businessId,
            event: 'probation.ending',
            recipientEmail: managerEmail || undefined,
            variables: { employeeName: name, endDate: endKey, days: String(remindDays) },
            triggeredBy: 'HR_PROBATION_SWEEP',
          });
          summary.reminded += 1;
        }

        // 2. auto-confirm at/after the end date when the policy says so.
        if (policy && policy.autoConfirm && endKey <= today) {
          const r = await confirmProbation({ employeeId: emp.id, actorId: null }, prisma);
          if (r && r.changed) {
            summary.confirmed += 1;
            try {
              const letter = await issueConfirmationLetter(businessId, emp, policy);
              if (letter.issued) summary.lettersIssued += 1;
            } catch (e) {
              summary.errors += 1;
              console.error(`[probationSweep] letter failed for ${emp.id}: ${e.message}`);
            }
            await notifyHrEvent({
              businessId,
              event: 'probation.confirmed',
              recipientEmail: emp.workEmail || emp.personalEmail || undefined,
              variables: { employeeName: name, effectiveDate: today },
              triggeredBy: 'HR_PROBATION_SWEEP',
            }).catch(() => {});
          }
        }
      } catch (e) {
        summary.errors += 1;
        console.error(`[probationSweep] employee ${emp.id} failed: ${e.message}`);
      }
    }
  }
  return summary;
}

module.exports = { runProbationSweep };
