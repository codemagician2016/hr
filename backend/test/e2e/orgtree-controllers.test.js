'use strict';

/**
 * orgtree-controllers.test.js — Feature 19 CONTROLLER-level proof. Drives the REAL
 * route handlers (org.controller.tree* operator session + meTeam.controller.org*
 * customer session) against the LIVE hr_test schema via the fakeReq/fakeRes harness
 * (mirrors profileMss.rbac.test.js). This proves the ROUTE-LAYER scope gating, not
 * just the lib:
 *
 *   OPERATOR (hr-admin)
 *     (a) treeRoots(ALL) → tenant roots; treeChildren(:id) → that node's reports.
 *     (b) a manager (TEAM band) → roots = their own node (scope-clamped);
 *         treeChildren on an OUT-OF-SCOPE :id (their own manager) → 404.
 *     (c) treeAncestors(in-scope) → path-to-top; out-of-scope :id → 404.
 *     (d) treeSearch is scope-clamped (manager cannot find the CEO).
 *
 *   CUSTOMER (ESS)
 *     (e) orgSelf → { self, ancestors } (path-to-top, ancestors expandable:false).
 *     (f) orgChildren drills INSIDE the sub-tree; an out-of-sub-tree :id → 404.
 *     (g) orgTop → tenant roots card-only (expandable:false outside own sub-tree).
 *     (h) no compensation on any node; an IC (SELF band) gets self + no drill peers.
 *
 * Idempotent: F19C-* fixtures, cleaned at start + end.
 *
 * Run with: DATABASE_URL="$HR_URL" node test/e2e/orgtree-controllers.test.js
 */

const prisma = require('../../src/core/lib/prisma');
const org = require('../../src/hr/controllers/org.controller');
const team = require('../../src/hr/profile/meTeam.controller');

let pass = 0; let fail = 0;
const log = (...a) => console.log(...a);
function ok(c, m) { if (c) { pass += 1; log(`  PASS  ${m}`); } else { fail += 1; log(`  FAIL  ${m}`); } }

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(p) { this.body = p; return this; },
    end() { this.body = undefined; return this; },
  };
}
function call(handler, req) {
  return new Promise((resolve, reject) => {
    const res = fakeRes();
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(res); } };
    const next = (err) => { if (err) { settled = true; return reject(err); } return done(); };
    const oj = res.json.bind(res); res.json = (p) => { const r = oj(p); done(); return r; };
    const oe = res.end.bind(res); res.end = () => { const r = oe(); done(); return r; };
    Promise.resolve(handler(req, res, next)).then(done).catch((e) => { if (!settled) { settled = true; reject(e); } });
  });
}

const PREFIX = 'F19C';

async function cleanup() {
  const emps = await prisma.employee.findMany({ where: { code: { startsWith: PREFIX } }, select: { id: true } });
  const ids = emps.map((e) => e.id);
  if (ids.length) {
    await prisma.employmentRecord.deleteMany({ where: { employeeId: { in: ids } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: { in: ids } }, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX.toLowerCase() } } }).catch(() => {});
  await prisma.businessRole.deleteMany({ where: { name: { startsWith: PREFIX } } }).catch(() => {});
}

async function resolveTenant() {
  const demo = await prisma.business.findFirst({ where: { slug: 'demo' }, select: { id: true } });
  if (demo) return demo.id;
  const own = await prisma.business.upsert({
    where: { slug: `${PREFIX.toLowerCase()}-tenant` }, update: {},
    create: { slug: `${PREFIX.toLowerCase()}-tenant`, name: 'F19C Test Co', region: 'IN' },
    select: { id: true },
  });
  return own.id;
}

async function main() {
  log('\n=== Feature 19 controller-level proof (LIVE hr_test) ===\n');
  const businessId = await resolveTenant();
  await cleanup();

  // Roles: ALL-band (admin), TEAM-band (manager), SELF-band (IC).
  const allRole = await prisma.businessRole.create({ data: { businessId, name: `${PREFIX}-All`, defaultScope: 'ALL', permissions: { canViewEmployees: true } } });
  const teamRole = await prisma.businessRole.create({ data: { businessId, name: `${PREFIX}-Team`, defaultScope: 'TEAM', permissions: { canViewEmployees: true } } });
  const selfRole = await prisma.businessRole.create({ data: { businessId, name: `${PREFIX}-Self`, defaultScope: 'SELF', permissions: { canViewEmployees: true } } });

  const mkUser = (slug, roleId) => prisma.user.create({ data: { businessId, email: `${PREFIX.toLowerCase()}-${slug}@example.com`, name: slug, role: 'USER', isActive: true, businessRoleId: roleId, password: 'x' } });
  const adminUser = await mkUser('admin', allRole.id);
  const vpUser = await mkUser('vp', teamRole.id);
  const icUser = await mkUser('ic', selfRole.id);

  // Tree: CEO → VP → {MGR-a, MGR-b}; MGR-a → IC.
  const mk = (code, mgrId, extra = {}) => prisma.employee.create({ data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'Z', status: 'ACTIVE', isActive: true, managerEmployeeId: mgrId || null, ...extra }, select: { id: true, code: true } });
  const ceo = await mk('CEO', null);
  const vp = await mk('VP', ceo.id, { userId: vpUser.id, workEmail: vpUser.email });
  const mgrA = await mk('MGRA', vp.id);
  const mgrB = await mk('MGRB', vp.id);
  const ic = await mk('IC', mgrA.id, { userId: icUser.id, workEmail: icUser.email });

  // Sessions.
  const adminUserSession = { id: adminUser.id, businessId, role: 'USER', employeeId: null, businessRoleId: allRole.id, businessRole: { defaultScope: 'ALL' } };
  const vpUserSession = { id: vpUser.id, businessId, role: 'USER', employeeId: vp.id, businessRoleId: teamRole.id, businessRole: { defaultScope: 'TEAM' } };
  const vpCust = { id: `cust-${vpUser.id}`, businessId, email: vpUser.email };
  const icCust = { id: `cust-${icUser.id}`, businessId, email: icUser.email };

  try {
    // ── OPERATOR ──────────────────────────────────────────────────────────────
    log('OPERATOR (hr-admin lazy endpoints)');
    {
      const r = await call(org.treeRoots, { user: adminUserSession, query: {} });
      ok(r.statusCode === 200, 'admin treeRoots → 200');
      ok((r.body.nodes || []).some((n) => n.code === `${PREFIX}-CEO`), 'admin roots include the CEO');
      const kids = await call(org.treeChildren, { user: adminUserSession, params: { id: vp.id }, query: {} });
      ok(kids.body.nodes.length === 2 && kids.body.nodes.every((n) => n.code.startsWith(`${PREFIX}-MGR`)), 'admin treeChildren(VP) → 2 managers');
      const anc = await call(org.treeAncestors, { user: adminUserSession, params: { id: ic.id }, query: {} });
      const codes = anc.body.path.map((n) => n.code);
      ok(JSON.stringify(codes) === JSON.stringify([`${PREFIX}-CEO`, `${PREFIX}-VP`, `${PREFIX}-MGRA`, `${PREFIX}-IC`]), 'admin treeAncestors(IC) → CEO→VP→MGRA→IC');
    }
    {
      // Manager (VP, TEAM band): roots = own node; cannot drill the CEO (out of scope).
      const roots = await call(org.treeRoots, { user: vpUserSession, query: {} });
      ok(roots.body.nodes.length === 1 && roots.body.nodes[0].code === `${PREFIX}-VP`, 'manager roots = own node (scope-clamped)');
      ok(roots.body.nodes[0].isSelf === true, 'manager root node flagged isSelf');
      const blocked = await call(org.treeChildren, { user: vpUserSession, params: { id: ceo.id }, query: {} });
      ok(blocked.statusCode === 404, 'manager treeChildren(CEO) → 404 (CEO ∉ sub-tree)');
      const blockedAnc = await call(org.treeAncestors, { user: vpUserSession, params: { id: ceo.id }, query: {} });
      ok(blockedAnc.statusCode === 404, 'manager treeAncestors(CEO) → 404 (out of scope)');
      const ownKids = await call(org.treeChildren, { user: vpUserSession, params: { id: vp.id }, query: {} });
      ok(ownKids.statusCode === 200 && ownKids.body.nodes.length === 2, 'manager CAN list own 2 reports');
      const s = await call(org.treeSearch, { user: vpUserSession, query: { q: 'CEO' } });
      ok((s.body.results || []).every((r) => r.node.code !== `${PREFIX}-CEO`), 'manager search cannot find the CEO (scope-clamped)');
      const s2 = await call(org.treeSearch, { user: vpUserSession, query: { q: 'IC' } });
      ok((s2.body.results || []).some((r) => r.node.code === `${PREFIX}-IC`), 'manager search finds an IC inside the sub-tree');
    }

    // ── CUSTOMER (ESS) ──────────────────────────────────────────────────────────
    log('\nCUSTOMER (ESS lazy endpoints)');
    {
      // VP (TEAM band) self landing: self + ancestor path to the top.
      const self = await call(team.orgSelf, { customer: vpCust });
      ok(self.body.self && self.body.self.code === `${PREFIX}-VP` && self.body.self.isSelf, 'ESS orgSelf → own node badged isSelf');
      const ancCodes = self.body.ancestors.map((n) => n.code);
      ok(ancCodes.includes(`${PREFIX}-CEO`), 'ESS orgSelf ancestors include the CEO (path-to-top)');
      const ceoAnc = self.body.ancestors.find((n) => n.code === `${PREFIX}-CEO`);
      ok(ceoAnc && ceoAnc.expandable === false, 'ESS ancestor (CEO) is card-only (expandable:false)');
      // Drill down inside sub-tree.
      const kids = await call(team.orgChildren, { customer: vpCust, params: { id: vp.id }, query: {} });
      ok(kids.statusCode === 200 && kids.body.nodes.length === 2, 'ESS orgChildren(self) → 2 reports (drill down)');
      ok(kids.body.nodes.every((n) => n.expandable === true), 'ESS own reports are expandable');
      // Out-of-sub-tree drill → 404 (cannot expand the CEO's private tree).
      const blocked = await call(team.orgChildren, { customer: vpCust, params: { id: ceo.id }, query: {} });
      ok(blocked.statusCode === 404, 'ESS orgChildren(CEO) → 404 (cannot drill outside own sub-tree)');
      // Top of org: roots card-only.
      const top = await call(team.orgTop, { customer: vpCust, query: {} });
      ok(top.statusCode === 200 && (top.body.nodes || []).some((n) => n.code === `${PREFIX}-CEO`), 'ESS orgTop → lists the CEO as a root');
      const ceoTop = top.body.nodes.find((n) => n.code === `${PREFIX}-CEO`);
      ok(ceoTop && ceoTop.expandable === false, 'ESS orgTop CEO is card-only (expandable:false, lateral policy)');
      // No compensation on any node.
      const compKeys = ['salary', 'ctc', 'compensation', 'wage', 'gross', 'net'];
      const leak = Object.keys(self.body.self).filter((k) => compKeys.some((c) => k.toLowerCase().includes(c)));
      ok(leak.length === 0, 'ESS node carries no compensation fields');
    }
    {
      // IC (SELF band): self only; no reports to drill; cannot expand a peer.
      const self = await call(team.orgSelf, { customer: icCust });
      ok(self.body.self && self.body.self.code === `${PREFIX}-IC`, 'ESS IC orgSelf → own node');
      const kids = await call(team.orgChildren, { customer: icCust, params: { id: ic.id }, query: {} });
      ok(kids.statusCode === 200 && kids.body.nodes.length === 0, 'ESS IC has no reports (self-only drill)');
      const peerBlocked = await call(team.orgChildren, { customer: icCust, params: { id: mgrB.id }, query: {} });
      ok(peerBlocked.statusCode === 404, 'ESS IC cannot drill a peer manager (MGR-b) → 404');
    }
  } finally {
    await cleanup();
  }

  log(`\n──────── ${pass} passed, ${fail} failed ────────\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('FATAL', e); try { await prisma.$disconnect(); } catch {} process.exit(1); });
