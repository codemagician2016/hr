'use strict';

/**
 * helpdesk.test.js — HR Helpdesk (Cycle 1) proof. Plain-node runner (no jest),
 * mirroring the onboarding/offboarding harness.
 *
 *   PART A (DB-FREE) — the pure service core (helpdesk.service.js):
 *     status-lifecycle transition table + guards; SLA due/breach math.
 *
 *   PART B (LIVE hr_test) — the operator console + ESS self-service over real rows:
 *     T1  employee raises a ticket (HD-#### minted, SLA due set, scoped to self)
 *     T2  HR sees it in the queue, assigns (OPEN→IN_PROGRESS), replies (firstResponseAt)
 *     T3  HR resolves (→RESOLVED); requester rates 1–5 → ticket CLOSES; comment stored
 *     T4  status lifecycle enforced (an illegal jump 409s; canTransition is the gate)
 *     T5  TENANT/SELF isolation — employee B cannot read employee A's ticket (404)
 *     T6  internal HR note is NEVER returned on the ESS surface
 *     T7  reopen a closed ticket (employee) → REOPENED
 *     T8  notifications fire (notifyHrEvent spy captures helpdesk.* events)
 *
 * Run (PART B needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/helpdesk/__tests__/helpdesk.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) { if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); } }
function eq(a, b, msg) { assert(a === b, `${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`); }

// ═══════════════════════════════════════════════════════════════════════════
// PART A — pure service (no DB)
// ═══════════════════════════════════════════════════════════════════════════
function partA() {
  log('\n=== PART A — helpdesk.service.js (pure, DB-free) ===\n');
  const svc = require('../helpdesk.service');

  log('A1) status lifecycle transitions:');
  assert(svc.canTransition('OPEN', 'IN_PROGRESS'), 'OPEN → IN_PROGRESS allowed');
  assert(svc.canTransition('IN_PROGRESS', 'RESOLVED'), 'IN_PROGRESS → RESOLVED allowed');
  assert(svc.canTransition('RESOLVED', 'CLOSED'), 'RESOLVED → CLOSED allowed');
  assert(svc.canTransition('RESOLVED', 'REOPENED'), 'RESOLVED → REOPENED allowed');
  assert(svc.canTransition('CLOSED', 'REOPENED'), 'CLOSED → REOPENED allowed');
  assert(!svc.canTransition('OPEN', 'CLOSED'), 'OPEN → CLOSED BLOCKED (must resolve first)');
  assert(!svc.canTransition('CLOSED', 'IN_PROGRESS'), 'CLOSED → IN_PROGRESS BLOCKED');
  assert(!svc.canTransition('CANCELLED', 'OPEN'), 'CANCELLED is terminal');
  assert(!svc.canTransition('OPEN', 'OPEN'), 'no-op transition rejected');
  assert(!svc.canTransition('OPEN', 'BOGUS'), 'unknown target rejected');

  log('A2) SLA due + breach math:');
  const base = new Date('2026-06-01T00:00:00Z');
  const dueCat = svc.computeSlaDueAt({ priority: 'LOW', categorySlaHours: 5, from: base });
  eq(dueCat.getTime(), base.getTime() + 5 * 3600 * 1000, 'category slaHours wins (5h)');
  const duePri = svc.computeSlaDueAt({ priority: 'URGENT', categorySlaHours: null, from: base });
  eq(duePri.getTime(), base.getTime() + 4 * 3600 * 1000, 'URGENT default = 4h when no category SLA');
  assert(svc.isBreached({ status: 'OPEN', slaDueAt: new Date('2026-06-01T00:00:00Z') }, new Date('2026-06-02')), 'past-due OPEN is breached');
  assert(!svc.isBreached({ status: 'RESOLVED', slaDueAt: new Date('2026-06-01') }, new Date('2026-06-02')), 'RESOLVED stops the SLA clock');
  assert(!svc.isBreached({ status: 'OPEN', slaDueAt: null }), 'no slaDueAt → never breached');
}

// ═══════════════════════════════════════════════════════════════════════════
// PART B — LIVE hr_test
// ═══════════════════════════════════════════════════════════════════════════
function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
  };
}
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const origJson = res.json.bind(res); res.json = (p) => { const r = origJson(p); done(); return r; };
    const origEnd = res.end.bind(res); res.end = () => { const r = origEnd(); done(); return r; };
    Promise.resolve(handler(req, res, next)).catch(reject);
  });
}

const PREFIX = 'HD-TEST';

async function partB() {
  log('\n=== PART B — LIVE hr_test (operator console + ESS self-service) ===\n');

  const prisma = require('../../../core/lib/prisma');
  const ops = require('../tickets.controller');
  const me = require('../meHelpdesk.controller');

  // Spy on notifyHrEvent so we can assert fan-out WITHOUT a real provider.
  const notifications = require('../../integrations/notifications');
  const sentEvents = [];
  const origNotify = notifications.notifyHrEvent;
  notifications.notifyHrEvent = async (args) => { sentEvents.push(args); return { ok: true, spied: true }; };

  const demo = await prisma.business.findFirst({ where: { slug: 'demo' } });
  if (!demo) throw new Error("Seed tenant 'demo' not found in hr_test");
  const businessId = demo.id;

  async function cleanup() {
    const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
    const empIds = emps.map((e) => e.id);
    if (empIds.length) {
      const tix = await prisma.helpdeskTicket.findMany({ where: { businessId, employeeId: { in: empIds } }, select: { id: true } });
      const tIds = tix.map((t) => t.id);
      if (tIds.length) await prisma.helpdeskMessage.deleteMany({ where: { ticketId: { in: tIds } } });
      await prisma.helpdeskTicket.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    }
    await prisma.helpdeskCategory.deleteMany({ where: { businessId, name: { startsWith: PREFIX } } });
    await prisma.numberSequence.deleteMany({ where: { businessId, scope: 'HD' } }); // reset HD counter for a clean run
    await prisma.employee.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { businessId, email: { startsWith: PREFIX.toLowerCase() } } });
  }

  await cleanup();
  try {
    // ── fixtures: two employees (A raises tickets; B is the isolation probe) + an HR agent ──
    const empA = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-A`, firstName: 'Asha', lastName: 'Raiser', status: 'ACTIVE', isActive: true, workEmail: `${PREFIX.toLowerCase()}-a@example.com` } });
    const empB = await prisma.employee.create({ data: { businessId, code: `${PREFIX}-B`, firstName: 'Bala', lastName: 'Other', status: 'ACTIVE', isActive: true, workEmail: `${PREFIX.toLowerCase()}-b@example.com` } });
    // The HR agent is a User linked to an Employee (so assignee notices resolve a contact).
    const hrUser = await prisma.user.create({ data: { email: `${PREFIX.toLowerCase()}-hr@example.com`, password: 'x', name: 'Hannah HR', businessId } });
    await prisma.employee.create({ data: { businessId, code: `${PREFIX}-HR`, firstName: 'Hannah', lastName: 'HR', status: 'ACTIVE', isActive: true, workEmail: `${PREFIX.toLowerCase()}-hragent@example.com`, userId: hrUser.id } });
    const hrUserId = hrUser.id;
    // The operator session — canManageHelpdesk granted directly on the businessRole.
    const opUser = { id: hrUserId, businessId, role: 'BUSINESS_ADMIN', businessRole: { defaultScope: 'ALL', permissions: { canManageHelpdesk: true } } };
    // ESS customer sessions — resolveSelfEmployee matches by email.
    const custA = { id: 'cust-A', businessId, email: empA.workEmail, name: 'Asha Raiser' };
    const custB = { id: 'cust-B', businessId, email: empB.workEmail, name: 'Bala Other' };

    // ── HR creates a category with a 6h SLA ──
    const catRes = await callController(ops.createCategory, { user: opUser, body: { name: `${PREFIX}-Payroll`, slaHours: 6 } });
    eq(catRes.statusCode, 201, 'HR creates a helpdesk category');
    const categoryId = catRes.body.id;

    // ── T1: employee A raises a ticket ──
    log('T1) employee raises a ticket (self-scoped, HD code, SLA):');
    const raise = await callController(me.createTicket, { customer: custA, body: { subject: 'Payslip mismatch', description: 'My HRA looks wrong this month.', priority: 'HIGH', categoryId } });
    eq(raise.statusCode, 201, 'raise returns 201');
    const ticketId = raise.body.id;
    assert(/^HD-\d{6}$/.test(raise.body.code), `HD code minted (${raise.body.code})`);
    eq(raise.body.status, 'OPEN', 'new ticket is OPEN');
    eq(raise.body.employeeId, empA.id, 'ticket owned by raiser');
    assert(raise.body.slaDueAt != null, 'SLA due-at computed');
    // category 6h SLA wins over HIGH(8h) default. slaDueAt is computed from the request
    // clock while createdAt is the DB now() a few ms later, so allow a small tolerance.
    {
      const deltaH = (new Date(raise.body.slaDueAt).getTime() - new Date(raise.body.createdAt).getTime()) / 3600000;
      assert(Math.abs(deltaH - 6) < 0.01, `SLA due ≈ createdAt + 6h (category), got ${deltaH.toFixed(4)}h`);
    }

    // ── T2: HR queue + assign + reply ──
    log('T2) HR queue, assign, reply:');
    const queue = await callController(ops.listTickets, { user: opUser, query: { status: 'OPEN' } });
    eq(queue.statusCode, 200, 'HR queue returns 200');
    assert(queue.body.items.some((t) => t.id === ticketId), 'raised ticket appears in HR queue');
    assert('total' in queue.body && 'pageSize' in queue.body, 'queue is paginated (total + pageSize)');

    const assign = await callController(ops.assignTicket, { user: opUser, params: { id: ticketId }, body: { assigneeId: hrUserId } });
    eq(assign.statusCode, 200, 'assign returns 200');
    eq(assign.body.status, 'IN_PROGRESS', 'OPEN → IN_PROGRESS on first assignment');
    eq(assign.body.assigneeId, hrUserId, 'assignee set');

    const reply = await callController(ops.replyTicket, { user: opUser, params: { id: ticketId }, body: { body: 'Looking into your HRA now.' } });
    eq(reply.statusCode, 201, 'HR reply returns 201');
    const afterReply = await prisma.helpdeskTicket.findUnique({ where: { id: ticketId } });
    assert(afterReply.firstResponseAt != null, 'firstResponseAt stamped on first public HR reply');

    // internal note (must NOT be visible to ESS later)
    const note = await callController(ops.replyTicket, { user: opUser, params: { id: ticketId }, body: { body: 'INTERNAL: check with payroll team', isInternal: true } });
    eq(note.statusCode, 201, 'HR internal note created');

    // ── T3: resolve + employee rates → closes ──
    log('T3) HR resolves; requester rates → CLOSED:');
    const resolve = await callController(ops.changeStatus, { user: opUser, params: { id: ticketId }, body: { status: 'RESOLVED' } });
    eq(resolve.statusCode, 200, 'resolve returns 200');
    eq(resolve.body.status, 'RESOLVED', 'status is RESOLVED');
    assert(resolve.body.resolvedAt != null, 'resolvedAt stamped');

    const rate = await callController(me.rateMyTicket, { customer: custA, params: { id: ticketId }, body: { rating: 5, comment: 'Quick fix, thanks!' } });
    eq(rate.statusCode, 200, 'rate returns 200');
    eq(rate.body.status, 'CLOSED', 'rating a RESOLVED ticket CLOSES it');
    eq(rate.body.satisfactionRating, 5, 'satisfaction rating stored');
    eq(rate.body.satisfactionComment, 'Quick fix, thanks!', 'satisfaction comment stored');

    // ── T4: lifecycle enforcement ──
    log('T4) status lifecycle enforced:');
    const t2 = await callController(me.createTicket, { customer: custA, body: { subject: 'Second issue' } });
    const t2Id = t2.body.id;
    const illegal = await callController(ops.changeStatus, { user: opUser, params: { id: t2Id }, body: { status: 'CLOSED' } });
    eq(illegal.statusCode, 409, 'OPEN → CLOSED rejected (409)');

    // ── T5: tenant/self isolation ──
    log('T5) self isolation (B cannot read A\'s ticket):');
    const cross = await callController(me.getMyTicket, { customer: custB, params: { id: ticketId } });
    eq(cross.statusCode, 404, "employee B gets 404 on employee A's ticket");
    const bList = await callController(me.listMyTickets, { customer: custB, query: {} });
    assert(!bList.body.items.some((t) => t.id === ticketId), "A's ticket absent from B's list");

    // ── T6: internal note hidden on ESS ──
    log('T6) internal HR note hidden from ESS:');
    const aDetail = await callController(me.getMyTicket, { customer: custA, params: { id: ticketId } });
    eq(aDetail.statusCode, 200, 'A reads own ticket detail');
    assert(!aDetail.body.messages.some((m) => /INTERNAL:/.test(m.body)), 'internal note NOT in ESS thread');
    assert(aDetail.body.messages.some((m) => /Looking into your HRA/.test(m.body)), 'public HR reply IS in ESS thread');

    // ── T7: reopen a closed ticket ──
    log('T7) employee reopens a closed ticket:');
    const reopen = await callController(me.reopenMyTicket, { customer: custA, params: { id: ticketId }, body: { reason: 'Still wrong' } });
    eq(reopen.statusCode, 200, 'reopen returns 200');
    eq(reopen.body.status, 'REOPENED', 'CLOSED → REOPENED');

    // ── T8: notifications fired ──
    log('T8) notifications fan out:');
    const events = sentEvents.map((e) => e.event);
    assert(events.includes('helpdesk.assigned'), 'helpdesk.assigned fired on assign');
    assert(events.includes('helpdesk.replied'), 'helpdesk.replied fired on reply');
    assert(events.includes('helpdesk.resolved'), 'helpdesk.resolved fired on resolve');
    // event payloads carry the template variables (CODE/SUBJECT)
    const resolvedEvt = sentEvents.find((e) => e.event === 'helpdesk.resolved');
    assert(resolvedEvt && resolvedEvt.variables && resolvedEvt.variables.CODE === raise.body.code, 'resolved notice carries the ticket code');

    // ── audit written ──
    const audits = await prisma.auditLog.count({ where: { businessId, entityType: 'HelpdeskTicket', entityId: ticketId } });
    assert(audits >= 3, `audit rows written for ticket lifecycle (${audits})`);
  } finally {
    notifications.notifyHrEvent = origNotify;
    await cleanup();
    await prisma.$disconnect();
  }
}

(async () => {
  partA();
  if (process.env.DATABASE_URL && /schema=hr_test/.test(process.env.DATABASE_URL)) {
    await partB();
  } else {
    log('\n(skipping PART B — set DATABASE_URL=...?schema=hr_test to run the live suite)\n');
  }
  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
