'use strict';

/**
 * notify.fanout.live.test.js — Cycle 0 notification fan-out proof against LIVE hr_test.
 *
 * Proves the approval/SLA surface fans out HR events to REAL channels (email here; the
 * SMS/WhatsApp cascade is the same router path) WITH a deep-link, on top of the existing
 * budget/opt-out engine, idempotently, and best-effort (a provider throw never breaks
 * the approval tx).
 *
 * The email provider is stubbed by pre-seeding the require cache for core/utils/email so
 * `sendViaSes` resolves to our fake — no live SES creds needed. We assert on the
 * MessageDelivery rows the EXISTING router writes (channel/status/bodySnapshot/triggeredBy),
 * which is the same audit trail prod uses.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/notify.fanout.live.test.js
 */

// ── Stub the email transport BEFORE anything loads the router/providers ──────────
// sendViaSes lazily `require('../../utils/email')` at call time, so seeding the require
// cache here makes every email send route through our controllable fake.
const emailPath = require.resolve('../../../core/utils/email');
let emailMode = 'OK'; // 'OK' | 'THROW' | 'FAIL'
const sentEmails = [];
require.cache[emailPath] = {
  id: emailPath,
  filename: emailPath,
  loaded: true,
  exports: {
    renderEmail: (b) => b,
    sendEmail: async (to, subject, html) => {
      if (emailMode === 'THROW') throw new Error('SIMULATED_PROVIDER_OUTAGE');
      if (emailMode === 'FAIL') return { ok: false };
      sentEmails.push({ to, subject, html });
      return { ok: true, messageId: `fake-${sentEmails.length}` };
    },
  },
};

const prisma = require('../../../core/lib/prisma');
const engine = require('../engine');
require('../consumers.leave'); // self-registers the LEAVE consumer (fan-out wired in)

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'NOTIFY-FANOUT-TEST';
let seq = 0;

async function cleanup(businessId) {
  await prisma.messageDelivery.deleteMany({ where: { businessId, triggeredBy: { startsWith: 'HR_' }, recipientEmail: { contains: PREFIX.toLowerCase() } } }).catch(() => {});
  await prisma.leaveTransaction.deleteMany({ where: { businessId, reason: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { entityType: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.approvalRequest.deleteMany({ where: { businessId, entityType: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { businessId, entityType: 'ApprovalRequest', entityId: { startsWith: 'nf-' } } }).catch(() => {});
  await prisma.workflowStep.deleteMany({ where: { businessId, workflow: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.workflowDefinition.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } }).catch(() => {});
}

async function mkUserEmp(businessId, name, managerEmployeeId = null, { email, notifyPrefs } = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { businessId, email: `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`, password: 'x', name, role: 'USER', isActive: true },
  });
  const emp = await prisma.employee.create({
    data: {
      businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status: 'ACTIVE',
      userId: user.id, managerEmployeeId,
      workEmail: email === undefined ? `${PREFIX.toLowerCase()}-emp${seq}@t.test` : email,
      countryCode: 'IN',
      ...(notifyPrefs !== undefined ? { notifyPrefs } : {}),
    },
  });
  return { user, emp };
}

async function mkDef(businessId, code, module, steps) {
  await prisma.workflowDefinition.updateMany({
    where: { businessId, module, code: { startsWith: PREFIX }, isPublished: true },
    data: { isPublished: false, isActive: false },
  });
  const def = await prisma.workflowDefinition.create({
    data: { businessId, code: `${PREFIX}-${code}`, name: code, module, isActive: true, isPublished: true, priority: 50 },
  });
  for (const s of steps) {
    await prisma.workflowStep.create({
      data: {
        businessId, workflowDefinitionId: def.id, stepOrder: s.stepOrder, name: s.name || s.approverType,
        approverType: s.approverType, approverRefId: s.approverRefId || null, conditionJson: s.conditionJson || undefined,
        isParallel: !!s.isParallel, minApprovals: s.minApprovals || 1, slaHours: s.slaHours || null,
        onTimeoutAction: s.onTimeoutAction || 'ESCALATE',
      },
    });
  }
  return def;
}

// A minimal PENDING LeaveTransaction APPLICATION row so the LEAVE consumer's onApprove/
// onReject proceeds past its loadTxn no-op guard and fires the requester fan-out (it
// reuses a seeded leave type; no balance row needed — the balance move is skipped when
// leaveBalanceId is null).
async function mkLeaveTxn(businessId, leaveTypeId, employeeId) {
  return prisma.leaveTransaction.create({
    data: {
      businessId, employeeId, leaveTypeId, txnType: 'APPLICATION', quantity: -1, unit: 'DAYS',
      status: 'PENDING', reason: `${PREFIX}-leave`, appliedAt: new Date(),
      startDate: new Date('2026-07-01'), endDate: new Date('2026-07-01'),
    },
  });
}

// Ensure the tenant's email gate context: the router emails as the always-on fallback
// regardless of managedSmsEnabled, so no NotificationConfig change is needed for email.
async function deliveriesFor(businessId, tokenPrefix) {
  return prisma.messageDelivery.findMany({
    where: { businessId, triggeredBy: { startsWith: tokenPrefix } },
    orderBy: { createdAt: 'asc' },
  });
}

// Small helper: the fan-out is fire-and-forget (not awaited by the engine), so give the
// microtask/promise queue a moment to flush its router writes before asserting.
function flush(ms = 400) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  log('\n=== Notification fan-out proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    // org: mgr → ic. ic requests leave; mgr approves.
    const mgr = await mkUserEmp(businessId, 'Mgr');
    const ic = await mkUserEmp(businessId, 'Ic', mgr.emp.id);

    await mkDef(businessId, 'LV', 'LEAVE', [
      { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager' },
    ]);

    // a seeded leave type so the LEAVE consumer can carry the decided-fan-out.
    const leaveType = await prisma.leaveType.findFirst({ where: { businessId }, select: { id: true } });
    if (!leaveType) throw new Error('No seeded LeaveType in hr_test demo tenant');

    // ── (A) APPROVAL_PENDING → approver gets an email on their preferred channel ──
    log('(A) approval request → approver gets APPROVAL_PENDING email with deep-link:');
    emailMode = 'OK';
    const txn1 = await mkLeaveTxn(businessId, leaveType.id, ic.emp.id);
    const r1 = await engine.openRequest({
      businessId, module: 'LEAVE', entityType: `${PREFIX}-LV`, entityId: txn1.id,
      requesterEmployeeId: ic.emp.id, payload: {}, ctx: {},
    });
    assert(r1.approvalRequest.status === 'PENDING', 'request opens PENDING');
    await flush();
    const pendDel = await deliveriesFor(businessId, `HR_PEND:${r1.approvalRequest.id}`);
    assert(pendDel.length === 1, `one APPROVAL_PENDING delivery logged (got ${pendDel.length})`);
    assert(pendDel[0] && pendDel[0].channel === 'EMAIL' && pendDel[0].status === 'SENT', `delivery is EMAIL/SENT (got ${pendDel[0] && pendDel[0].channel}/${pendDel[0] && pendDel[0].status})`);
    assert(pendDel[0] && /\/approvals\?request=/.test(pendDel[0].bodySnapshot), 'body carries the approvals deep-link');
    assert(pendDel[0] && /awaiting your approval/.test(pendDel[0].bodySnapshot), 'body rendered from APPROVAL_PENDING template');
    // IN_APP still written by the engine (source of truth).
    const inApp = await prisma.notification.findMany({ where: { businessId, entityId: r1.approvalRequest.id, channel: 'IN_APP', recipientUserId: mgr.user.id } });
    assert(inApp.length >= 1, 'IN_APP notification still written for the approver');

    // ── (B) DECISION → requester gets APPROVAL_DECIDED email ──────────────────────
    log('(B) decision → requester gets APPROVAL_DECIDED email with deep-link:');
    const d1 = await engine.recordDecision({ approvalRequestId: r1.approvalRequest.id, actorUserId: mgr.user.id, decision: 'APPROVED' });
    assert(d1.terminal === 'APPROVED', 'request terminal APPROVED');
    await flush();
    const decDel = await deliveriesFor(businessId, `HR_DEC:${r1.approvalRequest.id}`);
    assert(decDel.length === 1, `one APPROVAL_DECIDED delivery logged (got ${decDel.length})`);
    assert(decDel[0] && /\/leave\//.test(decDel[0].bodySnapshot), 'decided body carries the LEAVE module deep-link');
    assert(decDel[0] && /has been approved/.test(decDel[0].bodySnapshot), 'decided body rendered from APPROVAL_DECIDED template (approved)');

    // ── (C) opt-out respected — approver opted out → NO real-channel delivery ──────
    log('(C) per-employee opt-out respected (IN_APP still written, no email):');
    const mgrOut = await mkUserEmp(businessId, 'MgrOptOut', null, { notifyPrefs: { optOut: true } });
    const icC = await mkUserEmp(businessId, 'IcC', mgrOut.emp.id);
    const r2 = await engine.openRequest({
      businessId, module: 'LEAVE', entityType: `${PREFIX}-LV`, entityId: 'nf-2',
      requesterEmployeeId: icC.emp.id, payload: {}, ctx: {},
    });
    await flush();
    const pendDel2 = await deliveriesFor(businessId, `HR_PEND:${r2.approvalRequest.id}`);
    assert(pendDel2.length === 0, `opted-out approver gets NO real-channel delivery (got ${pendDel2.length})`);
    const inAppC = await prisma.notification.findMany({ where: { businessId, entityId: r2.approvalRequest.id, channel: 'IN_APP', recipientUserId: mgrOut.user.id } });
    assert(inAppC.length >= 1, 'opted-out approver STILL gets the IN_APP row (inbox stays complete)');

    // ── (D) channel-prefs narrow — approver disabled email + phone → no contact ────
    log('(D) channel-prefs narrowing (email off, no phone) → fan-out skipped, no crash:');
    const mgrNarrow = await mkUserEmp(businessId, 'MgrNarrow', null, { email: null, notifyPrefs: { channels: { email: false, whatsapp: false, sms: false } } });
    const icD = await mkUserEmp(businessId, 'IcD', mgrNarrow.emp.id);
    const r3 = await engine.openRequest({
      businessId, module: 'LEAVE', entityType: `${PREFIX}-LV`, entityId: 'nf-3',
      requesterEmployeeId: icD.emp.id, payload: {}, ctx: {},
    });
    await flush();
    const pendDel3 = await deliveriesFor(businessId, `HR_PEND:${r3.approvalRequest.id}`);
    assert(pendDel3.length === 0, `narrowed approver with no usable contact gets NO delivery (got ${pendDel3.length})`);
    assert(r3.approvalRequest.status === 'PENDING', 'approval flow unaffected by the narrowing');

    // ── (E) idempotency — re-firing the same fan-out does NOT double-send ──────────
    log('(E) idempotent — re-dispatching the same pending notice does not double-send:');
    const notify = require('../notify');
    await notify.fanOutApprovalPending({ businessId, request: r1.approvalRequest, approverUserIds: [mgr.user.id] });
    await flush(200);
    const pendDelAfter = await deliveriesFor(businessId, `HR_PEND:${r1.approvalRequest.id}`);
    assert(pendDelAfter.length === 1, `still exactly one APPROVAL_PENDING delivery after a retry (got ${pendDelAfter.length})`);

    // ── (F) a provider error does NOT break the approval transaction ──────────────
    log('(F) provider throw is swallowed — the approval tx still commits:');
    emailMode = 'THROW';
    const mgrF = await mkUserEmp(businessId, 'MgrF');
    const icF = await mkUserEmp(businessId, 'IcF', mgrF.emp.id);
    let threw = false;
    let rF;
    try {
      rF = await engine.openRequest({
        businessId, module: 'LEAVE', entityType: `${PREFIX}-LV`, entityId: 'nf-f',
        requesterEmployeeId: icF.emp.id, payload: {}, ctx: {},
      });
    } catch (_e) { threw = true; }
    await flush();
    assert(!threw && rF && rF.approvalRequest.status === 'PENDING', 'openRequest still succeeds despite the provider outage');
    const dF = await engine.recordDecision({ approvalRequestId: rF.approvalRequest.id, actorUserId: mgrF.user.id, decision: 'APPROVED' });
    assert(dF.terminal === 'APPROVED', 'decision still commits APPROVED despite the provider outage');
    // The decision flip must have persisted (proves the tx was not rolled back by the notify failure).
    const persisted = await prisma.approvalRequest.findUnique({ where: { id: rF.approvalRequest.id } });
    assert(persisted && persisted.status === 'APPROVED', 'approval state persisted (tx committed, notify failure isolated)');
    emailMode = 'OK';

    log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ===\n`);
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
