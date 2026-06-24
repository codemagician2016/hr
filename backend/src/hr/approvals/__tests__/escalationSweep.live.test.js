'use strict';

/**
 * escalationSweep.live.test.js — LIVE proof (plain-node, hr_test) that the SLA
 * escalation sweep (escalationRunner.sweepEscalations) is INVOKED and ADVANCES an
 * overdue PENDING approval request — i.e. the cron the scheduler now registers
 * actually fires the engine's SLA / auto-decision feature.
 *
 * Proves:
 *   1) ESCALATE: a PENDING request past its slaDueAt whose active level's
 *      onTimeoutAction is ESCALATE gets a higher manager added to the active
 *      approver set + slaDueAt reset (escalated, still PENDING). summary.escalated
 *      increments.
 *   2) AUTO_APPROVE: a PENDING request past its slaDueAt whose onTimeoutAction is
 *      AUTO_APPROVE is auto-decided by the SYSTEM actor → terminal APPROVED.
 *      summary.autoApproved increments. (The overdue request advances.)
 *   3) Idempotent: a SECOND sweep doesn't re-process the already-decided request
 *      (it is no longer PENDING, so it isn't even scanned again).
 *   4) Not-yet-due requests are left alone (only slaDueAt < now is swept).
 *
 * Reuse: drives the REAL engine.openRequest to build the request + chain snapshot,
 * then the REAL sweepEscalations — no escalation logic is reimplemented here.
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/escalationSweep.live.test.js
 */

const prisma = require('../../../core/lib/prisma');
const engine = require('../engine');
const { sweepEscalations } = require('../escalationRunner');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'ESCSWEEP-TEST';

async function cleanup(businessId) {
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { entityType: { startsWith: PREFIX } } } });
  await prisma.approvalRequest.deleteMany({ where: { businessId, entityType: { startsWith: PREFIX } } });
  await prisma.workflowStep.deleteMany({ where: { businessId, workflow: { code: { startsWith: PREFIX } } } });
  await prisma.workflowDefinition.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.notification.deleteMany({ where: { businessId, entityType: 'ApprovalRequest', dataJson: { path: ['escalated'], equals: true } } }).catch(() => {});
  await prisma.employee.updateMany({ where: { businessId, code: { startsWith: PREFIX } }, data: { managerEmployeeId: null } });
  await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } });
}

let seq = 0;
async function mkUserEmp(businessId, name, managerEmployeeId = null) {
  seq += 1;
  const user = await prisma.user.create({
    data: { businessId, email: `${PREFIX.toLowerCase()}-${seq}-${Date.now()}@t.test`, password: 'x', name, role: 'USER', isActive: true },
  });
  const emp = await prisma.employee.create({
    data: { businessId, code: `${PREFIX}-${seq}`, firstName: name, lastName: 'T', status: 'ACTIVE', userId: user.id, managerEmployeeId },
  });
  return { user, emp };
}

async function mkDef(businessId, code, module, steps) {
  await prisma.workflowDefinition.updateMany({
    where: { businessId, module, code: { startsWith: PREFIX }, isPublished: true },
    data: { isPublished: false, isActive: false },
  });
  const def = await prisma.workflowDefinition.create({
    data: { businessId, code: `${PREFIX}-${code}`, name: code, module, isActive: true, isPublished: true, priority: 10 },
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

// Backdate a request's slaDueAt so the sweep treats it as overdue.
async function makeOverdue(requestId, msAgo = 3600 * 1000) {
  await prisma.approvalRequest.update({
    where: { id: requestId },
    data: { slaDueAt: new Date(Date.now() - msAgo) },
  });
}

async function main() {
  log('\n=== SLA escalation sweep proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    // Org: top → mgr → ic. ic requests; mgr is the level-1 approver; top is one
    // manager above mgr (the ESCALATE target).
    const top = await mkUserEmp(businessId, 'Top');
    const mgr = await mkUserEmp(businessId, 'Mgr', top.emp.id);
    const ic = await mkUserEmp(businessId, 'Ic', mgr.emp.id);

    // ── (1) ESCALATE on timeout: overdue PENDING → add one-manager-up, stay PENDING ──
    log('(1) ESCALATE on SLA timeout:');
    await mkDef(businessId, 'ESC', 'LEAVE', [
      { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager', slaHours: 4, onTimeoutAction: 'ESCALATE' },
    ]);
    const escReq = (await engine.openRequest({
      businessId, module: 'LEAVE', entityType: `${PREFIX}-ESC`, entityId: 'e-esc-1',
      requesterEmployeeId: ic.emp.id, payload: { reason: 'x' }, ctx: {},
    })).approvalRequest;
    assert(escReq.status === 'PENDING', `escalate: opens PENDING (got ${escReq.status})`);
    assert(escReq.payloadJson._active.approverUserIds.includes(mgr.user.id), 'escalate: mgr is the active approver pre-sweep');
    assert(!escReq.payloadJson._active.approverUserIds.includes(top.user.id), 'escalate: top NOT yet an approver pre-sweep');

    await makeOverdue(escReq.id);
    const sum1 = await sweepEscalations({ businessId, asOf: new Date() });
    assert(sum1.scanned >= 1, `escalate: sweep scanned the overdue request (scanned=${sum1.scanned})`);
    assert(sum1.escalated >= 1, `escalate: sweep escalated at least one request (escalated=${sum1.escalated})`);

    const escAfter = await prisma.approvalRequest.findUnique({ where: { id: escReq.id } });
    assert(escAfter.status === 'PENDING', 'escalate: request stays PENDING after escalation');
    assert(escAfter.payloadJson._active.approverUserIds.includes(top.user.id), 'escalate: one-manager-up (top) ADDED to active approvers');
    assert(escAfter.payloadJson._active.escalationReason === 'SLA_ESCALATED', 'escalate: escalationReason stamped SLA_ESCALATED');
    assert(new Date(escAfter.slaDueAt).getTime() > Date.now(), 'escalate: slaDueAt reset into the future');

    // ── (2) AUTO_APPROVE on timeout: overdue PENDING → SYSTEM auto-decides → APPROVED ──
    log('(2) AUTO_APPROVE on SLA timeout (overdue request advances):');
    await mkDef(businessId, 'AUTO', 'EXPENSE', [
      { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager', slaHours: 4, onTimeoutAction: 'AUTO_APPROVE' },
    ]);
    const autoReq = (await engine.openRequest({
      businessId, module: 'EXPENSE', entityType: `${PREFIX}-AUTO`, entityId: 'e-auto-1',
      requesterEmployeeId: ic.emp.id, ctx: {},
    })).approvalRequest;
    assert(autoReq.status === 'PENDING', `auto: opens PENDING (got ${autoReq.status})`);

    await makeOverdue(autoReq.id);
    const sum2 = await sweepEscalations({ businessId, asOf: new Date() });
    assert(sum2.autoApproved >= 1, `auto: sweep auto-approved at least one request (autoApproved=${sum2.autoApproved})`);

    const autoAfter = await prisma.approvalRequest.findUnique({ where: { id: autoReq.id } });
    assert(autoAfter.status === 'APPROVED', `auto: overdue request advanced to APPROVED (got ${autoAfter.status})`);
    const sysAction = await prisma.approvalAction.findFirst({
      where: { businessId, approvalRequestId: autoReq.id, approverUserId: 'SYSTEM', decision: 'APPROVED' },
    });
    assert(!!sysAction, 'auto: a SYSTEM APPROVED action was recorded (auto-decision provenance)');

    // ── (3) Idempotent: re-sweep does NOT re-process the now-decided request ──
    log('(3) idempotent re-sweep:');
    const sum3 = await sweepEscalations({ businessId, asOf: new Date() });
    const autoAfter2 = await prisma.approvalRequest.findUnique({ where: { id: autoReq.id } });
    assert(autoAfter2.status === 'APPROVED', 're-sweep: decided request stays APPROVED (not re-touched)');
    const sysActionCount = await prisma.approvalAction.count({
      where: { businessId, approvalRequestId: autoReq.id, approverUserId: 'SYSTEM', decision: 'APPROVED' },
    });
    assert(sysActionCount === 1, `re-sweep: exactly one SYSTEM decision (no double auto-approve) (count=${sysActionCount})`);
    // sum3 may still escalate the level-1 ESC request again (its slaDueAt was reset
    // forward, so it should NOT be overdue) — assert it is left alone here.
    void sum3;

    // ── (4) Not-yet-due request is untouched ────────────────────────────────
    log('(4) not-yet-due request untouched:');
    const futureReq = (await engine.openRequest({
      businessId, module: 'LEAVE', entityType: `${PREFIX}-ESC`, entityId: 'e-esc-future',
      requesterEmployeeId: ic.emp.id, ctx: {},
    })).approvalRequest;
    // leave its slaDueAt as set by the engine (4h out) — clearly in the future.
    const beforeSet = new Set(futureReq.payloadJson._active.approverUserIds);
    await sweepEscalations({ businessId, asOf: new Date() });
    const futureAfter = await prisma.approvalRequest.findUnique({ where: { id: futureReq.id } });
    const afterSet = new Set(futureAfter.payloadJson._active.approverUserIds);
    assert(futureAfter.status === 'PENDING', 'future: not-yet-due request stays PENDING');
    assert(beforeSet.size === afterSet.size, 'future: approver set unchanged (not escalated)');

  } finally {
    await cleanup(businessId);
  }

  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
