'use strict';

/**
 * proofWindowRunner.js — Feature 20 slice 20e. The daily scheduler runner that drives
 * the InvestmentDeclarationWindow lifecycle + reminder fan-out. Idempotent, tenant-safe
 * (every row carries businessId), best-effort on notifications.
 *
 * CRITICAL: the TDS switch itself is DATE-DRIVEN in the assembler (asOf >=
 * proofDeadline), NOT cron-driven. This runner only moves window STATUS + sends
 * NOTIFICATIONS — even if a tick is missed, the math is still correct on the next
 * payroll run. The cron never affects correctness.
 *
 * Daily 09:00 for each window (IN):
 *   • today == opensAt   → DRAFT → OPEN  + notify OLD-regime employees ("window open")
 *   • today == closesAt  → OPEN  → CLOSED
 *   • today == proofDeadline → CLOSED → LOCKED + notify employees with verified<declared
 *   • T-14 / T-3 before proofDeadline → reminder to employees with PENDING/missing proofs
 */

const prisma = require('../../../core/lib/prisma');
const { notifyHrEvent } = require('../../integrations/notifications');
const { CLAIM_TYPE_META } = require('./claimTypes');

function isoDay(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}
function toNum(v) {
  if (v == null) return 0;
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function daysBetween(aIso, bIso) {
  const a = new Date(`${aIso}T00:00:00.000Z`).getTime();
  const b = new Date(`${bIso}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86400000);
}

// OLD-regime employees of a tenant with a resolvable email (recipients for the open nudge).
async function oldRegimeEmployees(businessId) {
  const sps = await prisma.statutoryProfile.findMany({
    where: { businessId, countryCode: 'IN', taxRegime: 'OLD' },
    select: { employeeId: true },
  });
  if (!sps.length) return [];
  const ids = sps.map((s) => s.employeeId);
  return prisma.employee.findMany({
    where: { id: { in: ids }, businessId, deletedAt: null, isActive: true },
    select: { id: true, firstName: true, workEmail: true, personalEmail: true },
  });
}

function emailOf(emp) { return emp.workEmail || emp.personalEmail || null; }

/**
 * Run the daily sweep. @param {{ asOf?: Date|string, db? }} — asOf lets a test pin
 * "today". Returns a small summary for the scheduler log.
 */
async function runProofWindowSweep({ asOf = new Date(), db = prisma } = {}) {
  const today = isoDay(asOf);
  const summary = { opened: 0, closed: 0, locked: 0, remindersSent: 0, notified: 0, errors: 0 };

  const windows = await db.investmentDeclarationWindow.findMany({
    where: { countryCode: 'IN', status: { in: ['DRAFT', 'OPEN', 'CLOSED'] } },
  });

  for (const w of windows) {
    try {
      const opensAt = isoDay(w.opensAt);
      const closesAt = isoDay(w.closesAt);
      const deadline = isoDay(w.proofDeadline);
      const biz = await db.business.findUnique({ where: { id: w.businessId }, select: { name: true } });
      const bizName = (biz && biz.name) || 'your company';

      // DRAFT → OPEN on opensAt.
      if (w.status === 'DRAFT' && today >= opensAt) {
        await db.investmentDeclarationWindow.update({ where: { id: w.id }, data: { status: 'OPEN', version: { increment: 1 } } });
        summary.opened += 1;
        const emps = await oldRegimeEmployees(w.businessId);
        for (const emp of emps) {
          const email = emailOf(emp);
          if (!email) continue;
          try {
            await notifyHrEvent({
              businessId: w.businessId, event: 'proof.window-open', recipientEmail: email,
              variables: { NAME: emp.firstName || 'there', FY: w.financialYear, BIZ: bizName, DEADLINE: deadline, LINK: '' },
              triggeredBy: 'INVESTMENT_PROOF_WINDOW',
            });
            summary.notified += 1;
          } catch (_e) { /* best-effort */ }
        }
        continue; // a freshly-opened window doesn't also close/lock same tick
      }

      // OPEN → CLOSED on closesAt.
      if (w.status === 'OPEN' && today >= closesAt && today < deadline) {
        await db.investmentDeclarationWindow.update({ where: { id: w.id }, data: { status: 'CLOSED', version: { increment: 1 } } });
        summary.closed += 1;
      }

      // (OPEN|CLOSED) → LOCKED on proofDeadline + notify employees with verified<declared.
      const live = await db.investmentDeclarationWindow.findUnique({ where: { id: w.id } });
      if (live && (live.status === 'OPEN' || live.status === 'CLOSED') && today >= deadline) {
        await db.investmentDeclarationWindow.update({ where: { id: w.id }, data: { status: 'LOCKED', version: { increment: 1 } } });
        summary.locked += 1;
        await notifyUnverified(db, w, bizName, summary);
        continue;
      }

      // Reminder nudges at T-14 / T-3 before the deadline (window OPEN only).
      if (live && live.status === 'OPEN') {
        const dleft = daysBetween(today, deadline);
        if (dleft === 14 || dleft === 3) {
          await sendReminders(db, w, bizName, deadline, summary);
        }
      }
    } catch (e) {
      summary.errors += 1;
    }
  }
  return summary;
}

// Notify OLD-regime employees whose Σverified < declared at the deadline (the §201
// "unverified is excluded" warning).
async function notifyUnverified(db, w, bizName, summary) {
  const sps = await db.statutoryProfile.findMany({
    where: { businessId: w.businessId, countryCode: 'IN', taxRegime: 'OLD' },
  });
  for (const sp of sps) {
    try {
      const proofs = await db.investmentProof.findMany({
        where: { businessId: w.businessId, employeeId: sp.employeeId, financialYear: w.financialYear, deletedAt: null, status: 'ACCEPTED' },
        select: { claimType: true, verifiedAmount: true },
      });
      let unverified = 0;
      for (const ct of Object.keys(CLAIM_TYPE_META)) {
        if (!CLAIM_TYPE_META[ct].engineConsumed) continue;
        const declared = toNum(sp[CLAIM_TYPE_META[ct].spField]);
        if (declared <= 0) continue;
        const verified = Math.min(declared, proofs.filter((p) => p.claimType === ct).reduce((a, p) => a + toNum(p.verifiedAmount), 0));
        unverified += Math.max(0, declared - verified);
      }
      if (unverified <= 0) continue;
      const emp = await db.employee.findFirst({ where: { id: sp.employeeId, businessId: w.businessId, deletedAt: null }, select: { firstName: true, workEmail: true, personalEmail: true } });
      const email = emp ? emailOf(emp) : null;
      if (!email) continue;
      await notifyHrEvent({
        businessId: w.businessId, event: 'proof.deadline', recipientEmail: email,
        variables: { NAME: (emp && emp.firstName) || 'there', FY: w.financialYear, AMOUNT: `₹${unverified.toLocaleString('en-IN')}`, BIZ: bizName },
        triggeredBy: 'INVESTMENT_PROOF_DEADLINE',
      });
      summary.notified += 1;
    } catch (_e) { /* best-effort */ }
  }
}

// Reminder nudge to OLD-regime employees with PENDING or missing proofs.
async function sendReminders(db, w, bizName, deadline, summary) {
  const emps = await oldRegimeEmployees(w.businessId);
  for (const emp of emps) {
    try {
      const email = emailOf(emp);
      if (!email) continue;
      // Only nudge those who still have something PENDING or haven't uploaded yet.
      const accepted = await db.investmentProof.count({
        where: { businessId: w.businessId, employeeId: emp.id, financialYear: w.financialYear, deletedAt: null, status: 'ACCEPTED' },
      });
      const pending = await db.investmentProof.count({
        where: { businessId: w.businessId, employeeId: emp.id, financialYear: w.financialYear, deletedAt: null, status: 'PENDING' },
      });
      if (accepted > 0 && pending === 0) continue; // fully verified — no nudge
      await notifyHrEvent({
        businessId: w.businessId, event: 'proof.reminder', recipientEmail: email,
        variables: { NAME: emp.firstName || 'there', FY: w.financialYear, DEADLINE: deadline, LINK: '', BIZ: bizName },
        triggeredBy: 'INVESTMENT_PROOF_REMINDER',
      });
      summary.remindersSent += 1;
    } catch (_e) { /* best-effort */ }
  }
}

module.exports = { runProofWindowSweep, _internals: { daysBetween, isoDay } };
