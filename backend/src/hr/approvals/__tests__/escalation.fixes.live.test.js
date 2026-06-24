'use strict';

/**
 * escalation.fixes.live.test.js — LIVE proof (plain-node, hr_test) for the
 * approval-escalation review fixes in escalationRunner.js + notify.js:
 *
 *   (1) SLA sweep reads onTimeoutAction from the CURRENTLY-ACTIVE / APPLIED step, NOT
 *       blindly from steps[0]. A level whose FIRST snapshot step is a (non-matching)
 *       AUTO_REJECT branch but whose APPLIED step is REMIND must only REMIND — it must
 *       NOT auto-reject (as the SYSTEM actor, bypassing SoD) a request that should nag.
 *
 *   (2) Escalation applies the terminated/inactive lockout: a separated direct-manager
 *       (status TERMINATED, even with a still-active User) is SKIPPED, and the request
 *       escalates to the NEXT ACTIVE manager up the chain — never to the terminated one.
 *
 *   (3) The reminder dedupe token advances per SLA window: each genuinely-new reminder
 *       window sends its real-channel reminder exactly ONCE (the old token keyed only on
 *       currentStepOrder, which never changes on REMIND, so only one reminder ever left).
 *
 * Reuse: drives the REAL engine.openRequest (chain snapshot + ctx) then the REAL
 * sweepEscalations / notify fan-out — no escalation logic is reimplemented here.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/escalation.fixes.live.test.js
 */

// ── Stub the email transport BEFORE the router/providers load (same trick as
// notify.fanout.live.test.js) so reminder fan-out resolves to a controllable fake. ──
const emailPath = require.resolve('../../../core/utils/email');
const sentEmails = [];
require.cache[emailPath] = {
  id: emailPath, filename: emailPath, loaded: true,
  exports: {
    renderEmail: (b) => b,
    sendEmail: async (to, subject, html) => { sentEmails.push({ to, subject, html }); return { ok: true, messageId: `fake-${sentEmails.length}` }; },
  },
};

const prisma = require('../../../core/lib/prisma');
const engine = require('../engine');
const { sweepEscalations } = require('../escalationRunner');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'ESCFIX-TEST';
let seq = 0;

async function cleanup(businessId) {
  await prisma.messageDelivery.deleteMany({ where: { businessId, triggeredBy: { startsWith: 'HR_' }, recipientEmail: { contains: PREFIX.toLowerCase() } } }).catch(() => {});
  await prisma.$executeRawUnsafe('DELETE FROM "HrNotifyDedupe" WHERE "businessId" = $1 AND "token" LIKE $2', businessId, 'HR_%').catch(() => {});
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { entityType: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.approvalRequest.deleteMany({ where: { businessId, entityType: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.notification.deleteMany({ where: { businessId, entityType: 'ApprovalRequest', entityId: { startsWith: 'ef-' } } }).catch(() => {});
  await prisma.workflowStep.deleteMany({ where: { businessId, workflow: { code: { startsWith: PREFIX } } } }).catch(() => {});
  await prisma.workflowDefinition.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } }).catch(() => {});
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } }).catch(() => {});
}

async function mkUserEmp(businessId, name, managerEmployeeId = null, { status = 'ACTIVE', isActive = true } = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { businessId, email: `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`, password: 'x', name, role: 'USER', isActive: true },
  });
  const emp = await prisma.employee.create({
    data: {
      businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status, isActive,
      userId: user.id, managerEmployeeId,
      workEmail: `${PREFIX.toLowerCase()}-emp${seq}@t.test`, countryCode: 'IN',
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
    data: { businessId, code: `${PREFIX}-${code}`, name: code, module, isActive: true, isPublished: true, priority: 60 },
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

async function makeOverdue(requestId, msAgo = 3600 * 1000) {
  await prisma.approvalRequest.update({ where: { id: requestId }, data: { slaDueAt: new Date(Date.now() - msAgo) } });
}
function flush(ms = 400) { return new Promise((r) => setTimeout(r, ms)); }
async function remDeliveries(businessId, requestId) {
  return prisma.messageDelivery.findMany({ where: { businessId, triggeredBy: { startsWith: `HR_REM:${requestId}` } }, orderBy: { createdAt: 'asc' } });
}

async function main() {
  log('\n=== Escalation/notify review-fix proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    // ── (1) Active-step REMIND must NOT auto-reject when steps[0] is a non-applicable
    //        AUTO_REJECT branch ────────────────────────────────────────────────────
    log('(1) overdue request only-REMINDs (does NOT auto-reject) when the APPLIED step says REMIND:');
    const mgr1 = await mkUserEmp(businessId, 'Mgr1');
    const ic1 = await mkUserEmp(businessId, 'Ic1', mgr1.emp.id);
    // One level (stepOrder 1) with TWO parallel-ordered steps:
    //   step A: applies only when amount > 100000 → AUTO_REJECT  (this is steps[0])
    //   step B: applies only when amount <= 100000 → REMIND      (the APPLIED step here)
    // A request with amount=500 lands on step B (REMIND). Reading steps[0] blindly would
    // AUTO_REJECT it; reading the APPLIED step REMINDs it.
    await mkDef(businessId, 'REMIND', 'EXPENSE', [
      { stepOrder: 1, isParallel: true, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'BigReject', slaHours: 4, onTimeoutAction: 'AUTO_REJECT', conditionJson: { amount: { '>': 100000 } } },
      { stepOrder: 1, isParallel: true, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'SmallRemind', slaHours: 4, onTimeoutAction: 'REMIND', conditionJson: { amount: { '<=': 100000 } } },
    ]);
    const remReq = (await engine.openRequest({
      businessId, module: 'EXPENSE', entityType: `${PREFIX}-REMIND`, entityId: 'ef-rem-1',
      requesterEmployeeId: ic1.emp.id, payload: {}, ctx: { amount: 500 },
    })).approvalRequest;
    assert(remReq.status === 'PENDING', `remind: opens PENDING (got ${remReq.status})`);

    await makeOverdue(remReq.id);
    const s1 = await sweepEscalations({ businessId, asOf: new Date() });
    assert(s1.remind >= 1, `remind: sweep counted a REMIND (remind=${s1.remind})`);
    assert(s1.autoRejected === 0, `remind: sweep did NOT auto-reject (autoRejected=${s1.autoRejected})`);
    const remAfter = await prisma.approvalRequest.findUnique({ where: { id: remReq.id } });
    assert(remAfter.status === 'PENDING', `remind: request still PENDING (NOT auto-rejected) (got ${remAfter.status})`);
    const rejAction = await prisma.approvalAction.findFirst({ where: { businessId, approvalRequestId: remReq.id, approverUserId: 'SYSTEM', decision: 'REJECTED' } });
    assert(!rejAction, 'remind: no SYSTEM REJECTED action recorded (SoD bypass averted)');
    assert(new Date(remAfter.slaDueAt).getTime() > Date.now(), 'remind: slaDueAt pushed forward one window');

    // ── (2) Escalation skips a TERMINATED direct-manager → next ACTIVE manager up ──
    log('(2) escalation skips a terminated manager and routes to the next active manager up:');
    const grandboss2 = await mkUserEmp(businessId, 'GrandBoss2');                                  // active, top
    const termMgr2 = await mkUserEmp(businessId, 'TermMgr2', grandboss2.emp.id, { status: 'TERMINATED' }); // separated 2-up
    const dirMgr2 = await mkUserEmp(businessId, 'DirMgr2', termMgr2.emp.id);                         // active direct mgr
    const ic2 = await mkUserEmp(businessId, 'Ic2', dirMgr2.emp.id);
    await mkDef(businessId, 'ESC', 'LEAVE', [
      { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager', slaHours: 4, onTimeoutAction: 'ESCALATE' },
    ]);
    const escReq = (await engine.openRequest({
      businessId, module: 'LEAVE', entityType: `${PREFIX}-ESC`, entityId: 'ef-esc-1',
      requesterEmployeeId: ic2.emp.id, payload: {}, ctx: {},
    })).approvalRequest;
    assert(escReq.payloadJson._active.approverUserIds.includes(dirMgr2.user.id), 'escalate: direct mgr is the active approver pre-sweep');

    await makeOverdue(escReq.id);
    const s2 = await sweepEscalations({ businessId, asOf: new Date() });
    assert(s2.escalated >= 1, `escalate: sweep escalated (escalated=${s2.escalated})`);
    const escAfter = await prisma.approvalRequest.findUnique({ where: { id: escReq.id } });
    const set2 = new Set(escAfter.payloadJson._active.approverUserIds);
    assert(!set2.has(termMgr2.user.id), 'escalate: TERMINATED 2-up manager NOT added as an approver');
    assert(set2.has(grandboss2.user.id), 'escalate: next ACTIVE manager up (grand-boss) added instead');

    // ── (3) Each reminder WINDOW sends its real-channel reminder exactly once ──────
    log('(3) multiple SLA reminder windows each send a reminder exactly once:');
    const mgr3 = await mkUserEmp(businessId, 'Mgr3');
    const ic3 = await mkUserEmp(businessId, 'Ic3', mgr3.emp.id);
    await mkDef(businessId, 'REMIND2', 'EXPENSE', [
      { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'RemindAlways', slaHours: 4, onTimeoutAction: 'REMIND' },
    ]);
    const r3 = (await engine.openRequest({
      businessId, module: 'EXPENSE', entityType: `${PREFIX}-REMIND2`, entityId: 'ef-rem2-1',
      requesterEmployeeId: ic3.emp.id, payload: {}, ctx: {},
    })).approvalRequest;

    // window 1: overdue → remind → exactly 1 real-channel reminder delivery
    await makeOverdue(r3.id);
    await sweepEscalations({ businessId, asOf: new Date() });
    await flush();
    let dels = await remDeliveries(businessId, r3.id);
    assert(dels.length === 1, `window-1: exactly one reminder delivery (got ${dels.length})`);

    // a SAME-window second sweep (request not yet overdue again) must NOT re-remind
    await sweepEscalations({ businessId, asOf: new Date() });
    await flush();
    dels = await remDeliveries(businessId, r3.id);
    assert(dels.length === 1, `same-window re-sweep: still exactly one reminder (no spam) (got ${dels.length})`);

    // window 2: backdate again so it's overdue → remind → a SECOND distinct reminder
    await makeOverdue(r3.id);
    await sweepEscalations({ businessId, asOf: new Date() });
    await flush();
    dels = await remDeliveries(businessId, r3.id);
    assert(dels.length === 2, `window-2: a new window sends a second reminder (got ${dels.length})`);
    const tokens = new Set(dels.map((d) => d.triggeredBy));
    assert(tokens.size === 2, `window-2: the two reminders carry DISTINCT dedupe tokens (got ${tokens.size})`);

    log(`\n=== ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'} ===\n`);
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); await prisma.$disconnect(); process.exit(1); });
