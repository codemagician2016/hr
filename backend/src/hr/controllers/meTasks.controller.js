'use strict';

/**
 * meTasks.controller.js — Employee Self-Service (ESS) "pending tasks" feed,
 * mounted at /api/hr/me/tasks. CUSTOMER session (req.customer); SELF_ONLY — every
 * row is the caller's own (resolved from the session), never selectable by a
 * client-supplied id.
 *
 * WHY THIS EXISTS — the ESS dashboard "Pending tasks" card and the conditional
 * Onboarding nav item (audit #56/#60) called /api/hr/me/tasks, which did not
 * exist (404). This builds the real feed by unioning the employee's outstanding
 * self-service actions:
 *   • an in-progress ONBOARDING journey (→ /onboarding)
 *   • e-sign envelopes awaiting THIS employee's signature (→ /onboarding or the
 *     emailed sign link)
 *   • assigned assets not yet acknowledged (→ /profile)
 *
 * Each task carries { id, kind, title, sub?, href, dueDate? } so the dashboard can
 * render a count and the (optional) list with sensible deep links. Terminated/
 * inactive employees resolve to an empty feed (ESS lockout).
 */

const prisma = require('../../core/lib/prisma');
const payrollService = require('../payroll/service');

// Feature 10 (slice 10e): include approvals awaiting THIS person so the ESS
// dashboard "Pending tasks" count + list cover what they need to approve, not
// just their own onboarding/e-sign/asset chores. We resolve the caller's portal
// User from the ESS session (email → User), then surface PENDING ApprovalRequests
// whose active-level approver set contains that user id. Deep-links to /approvals.
const MODULE_TASK_LABEL = {
  LEAVE: 'leave request', EXPENSE: 'reimbursement claim', TRAVEL: 'travel request',
  LOAN: 'loan request', COMPENSATION: 'salary change', PROFILE_CHANGE: 'profile change',
  ATTENDANCE_REGULARIZATION: 'attendance fix', SEPARATION: 'exit request',
};

// Journey statuses that still need the new hire's attention.
const OPEN_JOURNEY_STATUS = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'ON_HOLD'];
// Signer statuses that mean "not yet signed".
const OPEN_SIGNER_STATUS = ['PENDING', 'SENT', 'VIEWED'];
// Envelope statuses that are still actively collecting signatures.
const OPEN_ENVELOPE_STATUS = ['SENT', 'DELIVERED', 'PARTIALLY_SIGNED'];

async function resolveActiveSelf(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, isActive: true },
  });
  if (!emp || emp.isActive === false) return null;
  return emp;
}

// ── GET /me/tasks — the union of the employee's outstanding self-service tasks ─
async function listMyTasks(req, res, next) {
  try {
    const { businessId } = req.customer;
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [], total: 0 });
    const employeeId = emp.id;

    const items = [];

    // 1) In-progress onboarding journey (employee-anchored). A provisioned new
    // hire's journey is anchored to their Employee; that is the case the ESS feed
    // cares about (a pre-provision candidate has no portal session here).
    const journey = await prisma.lifecycleJourney.findFirst({
      where: {
        businessId,
        direction: 'ONBOARDING',
        deletedAt: null,
        status: { in: OPEN_JOURNEY_STATUS },
        employeeId,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, code: true, currentStage: true, status: true, joinDate: true },
    });
    if (journey) {
      items.push({
        id: `onboarding:${journey.id}`,
        kind: 'ONBOARDING',
        title: 'Complete your onboarding',
        sub: 'A few steps to get you ready for day one',
        href: '/onboarding',
        dueDate: journey.joinDate || null,
      });
    }

    // 2) E-sign envelopes awaiting this employee's signature.
    const signers = await prisma.signatureSigner.findMany({
      where: {
        businessId,
        employeeId,
        status: { in: OPEN_SIGNER_STATUS },
        envelope: { is: { status: { in: OPEN_ENVELOPE_STATUS } } },
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        envelope: { select: { id: true, subject: true, expiresAt: true } },
      },
    });
    for (const s of signers) {
      items.push({
        id: `esign:${s.id}`,
        kind: 'ESIGN',
        title: 'Sign a document',
        sub: (s.envelope && s.envelope.subject) || 'A document is awaiting your signature',
        href: '/onboarding',
        dueDate: s.envelope ? s.envelope.expiresAt : null,
      });
    }

    // 3) Assigned assets not yet acknowledged.
    const assets = await prisma.assetAssignment.findMany({
      where: {
        businessId,
        employeeId,
        status: 'ASSIGNED',
        acknowledgmentSignedAt: null,
      },
      orderBy: { assignedAt: 'desc' },
      select: { id: true, assignedAt: true, asset: { select: { name: true, code: true } } },
    });
    for (const a of assets) {
      const label = a.asset ? (a.asset.name || a.asset.code || 'Company asset') : 'Company asset';
      items.push({
        id: `asset:${a.id}`,
        kind: 'ASSET_ACK',
        title: 'Acknowledge an asset',
        sub: `Confirm receipt of ${label}`,
        href: '/profile',
        dueDate: null,
      });
    }

    // 4) Approvals awaiting THIS person (Feature 10 slice 10e). Resolve the
    // caller's portal User from the ESS session (email → User), then list PENDING
    // ApprovalRequests whose active-level approver set includes that user id. JSON
    // array membership is filtered in-code (same approach as the operator inbox).
    const portalUser = req.customer.email
      ? await prisma.user.findFirst({
          where: { businessId, email: req.customer.email, isActive: true },
          select: { id: true },
        })
      : null;
    if (portalUser) {
      const pending = await prisma.approvalRequest.findMany({
        where: { businessId, status: 'PENDING' },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, module: true, payloadJson: true, slaDueAt: true },
      });
      for (const r of pending) {
        const active = r.payloadJson && r.payloadJson._active;
        if (!active || !Array.isArray(active.approverUserIds) || !active.approverUserIds.includes(portalUser.id)) continue;
        items.push({
          id: `approval:${r.id}`,
          kind: 'APPROVAL',
          title: 'Approve a request',
          sub: `A ${MODULE_TASK_LABEL[r.module] || 'request'} is waiting for your decision`,
          href: '/approvals',
          dueDate: r.slaDueAt || null,
        });
      }
    }

    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

module.exports = { listMyTasks };
