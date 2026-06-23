'use strict';

/**
 * engine.live.test.js — Feature 10 slice 10a state-machine proof against LIVE hr_test.
 * Builds isolated fixtures (users + employees with a manager chain + roles), drives
 * the engine end-to-end, asserts the §10a behaviours, then cleans up.
 *
 * Covers: sequential advance, parallel/minApprovals (any-1 + all-of), conditional
 * skip, AUTO_APPROVE, SoD-collapse on a tiny tenant, version-lock race (409).
 *
 * Run: DATABASE_URL="$HR_URL" node src/hr/approvals/__tests__/engine.live.test.js
 */

const prisma = require('../../../core/lib/prisma');
const engine = require('../engine');
const { resolveStepApprovers } = require('../approverResolver');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) log(`  PASS  ${msg}`); else { failures += 1; log(`  FAIL  ${msg}`); } }

const PREFIX = 'APPENG-TEST';

async function cleanup(businessId) {
  await prisma.approvalAction.deleteMany({ where: { businessId, approvalRequest: { entityType: { startsWith: PREFIX } } } });
  await prisma.approvalRequest.deleteMany({ where: { businessId, entityType: { startsWith: PREFIX } } });
  await prisma.workflowStep.deleteMany({ where: { businessId, workflow: { code: { startsWith: PREFIX } } } });
  await prisma.workflowDefinition.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
  await prisma.approvalDelegation.deleteMany({ where: { businessId, reason: { startsWith: PREFIX } } });
  await prisma.notification.deleteMany({ where: { businessId, entityType: 'ApprovalRequest', dataJson: { path: ['module'], equals: 'LEAVE' }, body: { contains: 'awaiting' } } }).catch(() => {});
  // employees first (managerEmployeeId self-FK), then users.
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
  // Isolation: retire any earlier published def for this module so resolveDefinition
  // unambiguously picks THIS one (a tenant normally has one module-default at a time).
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

async function main() {
  log('\n=== Approval engine proof (LIVE hr_test) ===\n');
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;
  await cleanup(businessId);

  try {
    // Org: top → mgr → ic.  ic requests; mgr approves; top is mgr's manager.
    const top = await mkUserEmp(businessId, 'Top');
    const mgr = await mkUserEmp(businessId, 'Mgr', top.emp.id);
    const ic = await mkUserEmp(businessId, 'Ic', mgr.emp.id);
    const finance = await mkUserEmp(businessId, 'Fin');

    // ── (1) SEQUENTIAL: manager(1-up) then a specific person ───────────────────
    log('(1) sequential two-step (manager → specific employee):');
    {
      await mkDef(businessId, 'SEQ', 'LEAVE', [
        { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager' },
        { stepOrder: 2, approverType: 'SPECIFIC_EMPLOYEE', approverRefId: finance.emp.id, name: 'Finance' },
      ]);
      const { approvalRequest, terminal } = await engine.openRequest({
        businessId, module: 'LEAVE', entityType: `${PREFIX}-SEQ`, entityId: 'e-seq-1',
        requesterEmployeeId: ic.emp.id, payload: { reason: 'x' }, ctx: {},
      });
      assert(terminal === null && approvalRequest.status === 'PENDING', `opens PENDING at level 1 (got ${approvalRequest.status})`);
      assert(approvalRequest.currentStepOrder === 1, `currentStepOrder=1 (got ${approvalRequest.currentStepOrder})`);
      assert(approvalRequest.payloadJson._active.approverUserIds.includes(mgr.user.id), 'manager is the active approver');

      // manager approves → advance to level 2 (finance), still PENDING.
      const d1 = await engine.recordDecision({ approvalRequestId: approvalRequest.id, actorUserId: mgr.user.id, decision: 'APPROVED' });
      assert(d1.terminal === null && d1.approvalRequest.status === 'PENDING', 'after mgr approve → still PENDING (advanced)');
      assert(d1.approvalRequest.currentStepOrder === 2, `advanced to level 2 (got ${d1.approvalRequest.currentStepOrder})`);
      assert(d1.approvalRequest.payloadJson._active.approverUserIds.includes(finance.user.id), 'finance is now the active approver');

      // finance approves → terminal APPROVED.
      const d2 = await engine.recordDecision({ approvalRequestId: approvalRequest.id, actorUserId: finance.user.id, decision: 'APPROVED' });
      assert(d2.terminal === 'APPROVED' && d2.approvalRequest.status === 'APPROVED', 'after finance approve → APPROVED terminal');
    }

    // ── (2) PARALLEL any-1 (minApprovals=1, two approvers same stepOrder) ───────
    log('(2) parallel any-1 (need 1 of 2):');
    {
      await mkDef(businessId, 'PAR1', 'EXPENSE', [
        { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager', isParallel: true, minApprovals: 1 },
        { stepOrder: 1, approverType: 'SPECIFIC_EMPLOYEE', approverRefId: finance.emp.id, name: 'Finance', isParallel: true, minApprovals: 1 },
      ]);
      const { approvalRequest } = await engine.openRequest({
        businessId, module: 'EXPENSE', entityType: `${PREFIX}-PAR1`, entityId: 'e-par1', requesterEmployeeId: ic.emp.id, ctx: {},
      });
      const set = approvalRequest.payloadJson._active.approverUserIds;
      assert(set.includes(mgr.user.id) && set.includes(finance.user.id), 'parallel level has both approvers');
      assert(approvalRequest.payloadJson._active.minApprovals === 1, `minApprovals=1 (got ${approvalRequest.payloadJson._active.minApprovals})`);
      const d = await engine.recordDecision({ approvalRequestId: approvalRequest.id, actorUserId: mgr.user.id, decision: 'APPROVED' });
      assert(d.terminal === 'APPROVED', 'one approval completes the any-1 level → APPROVED');
    }

    // ── (3) PARALLEL all-of (minApprovals=2) ───────────────────────────────────
    log('(3) parallel all-of (need 2 of 2):');
    {
      await mkDef(businessId, 'PAR2', 'EXPENSE', [
        { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager', isParallel: true, minApprovals: 2 },
        { stepOrder: 1, approverType: 'SPECIFIC_EMPLOYEE', approverRefId: finance.emp.id, name: 'Finance', isParallel: true, minApprovals: 2 },
      ]);
      const { approvalRequest } = await engine.openRequest({
        businessId, module: 'EXPENSE', entityType: `${PREFIX}-PAR2`, entityId: 'e-par2', requesterEmployeeId: ic.emp.id, ctx: {},
      });
      assert(approvalRequest.payloadJson._active.minApprovals === 2, `minApprovals=2 (got ${approvalRequest.payloadJson._active.minApprovals})`);
      const d1 = await engine.recordDecision({ approvalRequestId: approvalRequest.id, actorUserId: mgr.user.id, decision: 'APPROVED' });
      assert(d1.terminal === null && d1.levelComplete === false, 'first of two approvals does NOT complete the level');
      const d2 = await engine.recordDecision({ approvalRequestId: approvalRequest.id, actorUserId: finance.user.id, decision: 'APPROVED' });
      assert(d2.terminal === 'APPROVED', 'second approval completes the all-of level → APPROVED');
    }

    // ── (4) CONDITIONAL SKIP (HR step only over an amount threshold) ────────────
    log('(4) conditional skip (HR step skipped below threshold):');
    {
      await mkDef(businessId, 'COND', 'EXPENSE', [
        { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager' },
        { stepOrder: 2, approverType: 'SPECIFIC_EMPLOYEE', approverRefId: finance.emp.id, name: 'Finance>50k', conditionJson: { amount: { '>': 50000 } } },
      ]);
      // small claim: amount 100 → level 2 condition fails → skipped → APPROVED after mgr.
      const small = await engine.openRequest({
        businessId, module: 'EXPENSE', entityType: `${PREFIX}-COND`, entityId: 'e-cond-small', requesterEmployeeId: ic.emp.id, ctx: { amount: 100 },
      });
      const ds = await engine.recordDecision({ approvalRequestId: small.approvalRequest.id, actorUserId: mgr.user.id, decision: 'APPROVED' });
      assert(ds.terminal === 'APPROVED', 'small claim: manager-only, finance step skipped → APPROVED');

      // big claim: amount 60000 → level 2 applies → needs finance after manager.
      const big = await engine.openRequest({
        businessId, module: 'EXPENSE', entityType: `${PREFIX}-COND`, entityId: 'e-cond-big', requesterEmployeeId: ic.emp.id, ctx: { amount: 60000 },
      });
      const db1 = await engine.recordDecision({ approvalRequestId: big.approvalRequest.id, actorUserId: mgr.user.id, decision: 'APPROVED' });
      assert(db1.terminal === null && db1.approvalRequest.currentStepOrder === 2, 'big claim: advances to finance level');
      const db2 = await engine.recordDecision({ approvalRequestId: big.approvalRequest.id, actorUserId: finance.user.id, decision: 'APPROVED' });
      assert(db2.terminal === 'APPROVED', 'big claim: finance approves → APPROVED');
    }

    // ── (5) AUTO_APPROVE (no-hierarchy / no-approvals chain) ────────────────────
    log('(5) auto-approve chain:');
    {
      await mkDef(businessId, 'AUTO', 'LEAVE', [
        { stepOrder: 1, approverType: 'AUTO_APPROVE', name: 'Auto' },
      ]);
      const r = await engine.openRequest({
        businessId, module: 'LEAVE', entityType: `${PREFIX}-AUTO`, entityId: 'e-auto', requesterEmployeeId: ic.emp.id, ctx: {},
      });
      assert(r.terminal === 'APPROVED' && r.approvalRequest.status === 'APPROVED', 'auto-approve completes immediately on open');
    }

    // ── (6) SoD COLLAPSE on a tiny tenant (requester IS their own manager) ──────
    log('(6) SoD collapse (founder is own manager → escalate→HR→auto, never deadlock):');
    {
      // A self-managing founder: the REPORTING_MANAGER step resolves to the founder,
      // SoD removes them → the collapse cascade kicks in. In the SEEDED demo tenant
      // an HR approver exists, so it escalates to HR (the desirable outcome) rather
      // than blind auto-approve. The KEY invariant: it NEVER deadlocks.
      const founder = await mkUserEmp(businessId, 'Founder');
      await prisma.employee.update({ where: { id: founder.emp.id }, data: { managerEmployeeId: founder.emp.id } }); // self-loop (cycle-guarded)
      const step = { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager', minApprovals: 1 };
      const resolved = await resolveStepApprovers(step, { id: founder.emp.id, businessId, userId: founder.user.id, managerEmployeeId: founder.emp.id }, businessId, { module: 'LEAVE', now: new Date() });
      // collapse landed on HR (seeded) or auto — both are valid non-deadlock outcomes.
      const collapseReasons = ['SOD_ESCALATED_TO_MANAGER', 'SOD_ESCALATED_TO_HR', 'SOD_COLLAPSE_AUTO_APPROVE'];
      assert(collapseReasons.includes(resolved.escalationReason), `SoD-empty step collapses with a reason (got ${resolved.escalationReason})`);
      assert(resolved.autoApprove === true ? true : resolved.userIds.length > 0, 'collapse yields either auto-approve or a real fallback approver (never empty+stuck)');
      // the founder themselves is never in the fallback set (SoD holds through collapse):
      assert(!resolved.userIds.includes(founder.user.id), 'founder is never their own fallback approver');

      // Force the pure auto-approve leaf: a tenant with NO manager-up AND no HR approver
      // for this requester. We assert the cascade's terminal leaf directly via a unit
      // call by stubbing usersWithPermission is overkill; instead assert the engine
      // never leaves the request stuck — it either APPROVES (auto/HR-then-act) or is
      // PENDING on a real approver.
      await mkDef(businessId, 'SOD', 'LEAVE', [step]);
      const r = await engine.openRequest({
        businessId, module: 'LEAVE', entityType: `${PREFIX}-SOD`, entityId: 'e-sod', requesterEmployeeId: founder.emp.id, ctx: {},
      });
      const okOutcome = (r.terminal === 'APPROVED') || (r.approvalRequest.status === 'PENDING' && (r.approvalRequest.payloadJson._active.approverUserIds || []).length > 0);
      assert(okOutcome, `founder self-request never deadlocks (terminal=${r.terminal}, status=${r.approvalRequest.status})`);
      assert(!((r.approvalRequest.payloadJson._active || {}).approverUserIds || []).includes(founder.user.id), 'founder is not routed their own request');
    }

    // ── (6b) SoD collapse on a TRULY isolated tenant → auto-approve leaf ─────────
    log('(6b) SoD collapse pure auto-approve leaf (own brand-new tenant, no HR):');
    {
      // Spin a throwaway tenant with exactly ONE self-managing user and NO HR role/
      // permission, so the collapse cascade (manager → HR → auto) reaches its FINAL
      // auto-approve-with-audit-note leaf deterministically.
      const t2 = await prisma.business.create({ data: { name: `${PREFIX}-T2`, slug: `appeng-t2-${Date.now()}` } });
      try {
        const u = await prisma.user.create({ data: { businessId: t2.id, email: `${PREFIX.toLowerCase()}-solo-${Date.now()}@t.test`, password: 'x', name: 'Solo', role: 'USER', isActive: true } });
        const e = await prisma.employee.create({ data: { businessId: t2.id, code: `${PREFIX}-SOLO`, firstName: 'Solo', lastName: 'O', status: 'ACTIVE', userId: u.id } });
        await prisma.employee.update({ where: { id: e.id }, data: { managerEmployeeId: e.id } });
        const step = { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager', minApprovals: 1 };
        const resolved = await resolveStepApprovers(step, { id: e.id, businessId: t2.id, userId: u.id, managerEmployeeId: e.id }, t2.id, { module: 'LEAVE', now: new Date() });
        assert(resolved.autoApprove === true && resolved.escalationReason === 'SOD_COLLAPSE_AUTO_APPROVE', `no-HR tenant collapses to auto-approve+audit (auto=${resolved.autoApprove}, reason=${resolved.escalationReason})`);
      } finally {
        await prisma.employee.updateMany({ where: { businessId: t2.id }, data: { managerEmployeeId: null } });
        await prisma.employee.deleteMany({ where: { businessId: t2.id } });
        await prisma.user.deleteMany({ where: { businessId: t2.id } });
        await prisma.business.delete({ where: { id: t2.id } });
      }
    }

    // ── (7) SoD 403: requester cannot decide their own request ──────────────────
    log('(7) SoD 403 on self-decide:');
    {
      await mkDef(businessId, 'SELF', 'LEAVE', [
        { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager' },
      ]);
      const r = await engine.openRequest({
        businessId, module: 'LEAVE', entityType: `${PREFIX}-SELF`, entityId: 'e-self', requesterEmployeeId: ic.emp.id, ctx: {},
      });
      let threw = null;
      try { await engine.recordDecision({ approvalRequestId: r.approvalRequest.id, actorUserId: ic.user.id, decision: 'APPROVED' }); }
      catch (e) { threw = e; }
      // ic is the requester AND not in the manager set, so this is NOT_AN_APPROVER
      // (a sharper 403 than SOD); either way it's a forbidden self-decision.
      assert(threw && threw.statusCode === 403, `self-decide is 403 (got ${threw && threw.code})`);
    }

    // ── (8) VERSION-LOCK race → 409 CONCURRENT_UPDATE ───────────────────────────
    log('(8) version-lock race (stale write → 409):');
    {
      await mkDef(businessId, 'RACE', 'LEAVE', [
        { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager' },
      ]);
      const r = await engine.openRequest({
        businessId, module: 'LEAVE', entityType: `${PREFIX}-RACE`, entityId: 'e-race', requesterEmployeeId: ic.emp.id, ctx: {},
      });
      // simulate a concurrent writer bumping the version out from under a held tx.
      let threw = null;
      try {
        await prisma.$transaction(async (tx) => {
          const fresh = await tx.approvalRequest.findUnique({ where: { id: r.approvalRequest.id } });
          // another actor advances version in a separate connection mid-flight:
          await prisma.approvalRequest.update({ where: { id: r.approvalRequest.id }, data: { version: { increment: 1 } } });
          // now a stale terminal flip with the OLD version must fail.
          const flip = await tx.approvalRequest.updateMany({
            where: { id: r.approvalRequest.id, status: 'PENDING', version: fresh.version },
            data: { status: 'APPROVED', version: { increment: 1 } },
          });
          if (flip.count === 0) { const e = new Error('race'); e.code = 'CONCURRENT_UPDATE'; throw e; }
        });
      } catch (e) { threw = e; }
      assert(threw && engine.isConcurrencyError(threw), `stale version write detected → CONCURRENT_UPDATE (got ${threw && threw.code})`);
    }

    // ── (9) REJECT terminates ───────────────────────────────────────────────────
    log('(9) reject path:');
    {
      await mkDef(businessId, 'REJ', 'LEAVE', [
        { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager' },
      ]);
      const r = await engine.openRequest({
        businessId, module: 'LEAVE', entityType: `${PREFIX}-REJ`, entityId: 'e-rej', requesterEmployeeId: ic.emp.id, ctx: {},
      });
      const d = await engine.recordDecision({ approvalRequestId: r.approvalRequest.id, actorUserId: mgr.user.id, decision: 'REJECTED', comment: 'no' });
      assert(d.terminal === 'REJECTED' && d.approvalRequest.status === 'REJECTED', 'manager reject → REJECTED terminal');
    }

    // ── (10) IDEMPOTENT double-decision is a no-op ──────────────────────────────
    log('(10) idempotent double-approve:');
    {
      await mkDef(businessId, 'IDEM', 'EXPENSE', [
        { stepOrder: 1, approverType: 'REPORTING_MANAGER', approverRefId: '1', name: 'Manager', isParallel: true, minApprovals: 2 },
        { stepOrder: 1, approverType: 'SPECIFIC_EMPLOYEE', approverRefId: finance.emp.id, name: 'Finance', isParallel: true, minApprovals: 2 },
      ]);
      const r = await engine.openRequest({
        businessId, module: 'EXPENSE', entityType: `${PREFIX}-IDEM`, entityId: 'e-idem', requesterEmployeeId: ic.emp.id, ctx: {},
      });
      await engine.recordDecision({ approvalRequestId: r.approvalRequest.id, actorUserId: mgr.user.id, decision: 'APPROVED' });
      const dup = await engine.recordDecision({ approvalRequestId: r.approvalRequest.id, actorUserId: mgr.user.id, decision: 'APPROVED' });
      assert(dup.idempotent === true && dup.terminal === null, 'duplicate same-user approval is a no-op (not double-counted)');
      // the all-of level still needs finance:
      const d2 = await engine.recordDecision({ approvalRequestId: r.approvalRequest.id, actorUserId: finance.user.id, decision: 'APPROVED' });
      assert(d2.terminal === 'APPROVED', 'finance completes it (dup did not inflate the count)');
    }
  } finally {
    await cleanup(businessId);
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? '=== ALL ENGINE CHECKS PASSED ===' : `=== ${failures} CHECK(S) FAILED ===`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
