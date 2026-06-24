'use strict';

/**
 * portalInvite.test.js — Feature 4 employee portal-invitation / credential flow.
 *
 * Plain-node runner (no jest), same harness as the other lifecycle proofs, run
 * against an isolated hr_test schema. Builds a self-contained tenant + employees
 * (no dependency on the demo seed) and exercises the WHOLE loop end-to-end:
 *
 *   1  admin invites an employee → token persisted HASHED (raw never stored),
 *      HR_PORTAL_INVITE notification fired, copyable link returned
 *   2  accept-invite with the raw token → password set + emailVerified + isActive,
 *      invite marked ACCEPTED/usedAt, employee can then customer-login
 *   3  a USED token is rejected (generic error, no enumeration)
 *   4  a WRONG/garbage token is rejected (generic, same message)
 *   5  an EXPIRED token is rejected
 *   6  re-invite REVOKEs the prior token (the old raw token no longer works)
 *   7  portal status transitions NOT_INVITED → INVITED → ACTIVE
 *   8  another tenant's token can't be used (tenant isolation)
 *   9  no-clobber: a routine re-invite of an ALREADY-active login is refused
 *      (allowReset overrides)
 *  10  the admin controller (POST /:id/invite) returns the link + fires the event
 *
 * Run (needs the live schema):
 *   DATABASE_URL="$HR_URL" node src/hr/lifecycle/__tests__/portalInvite.test.js
 * where $HR_URL = repo .env DATABASE_URL + '?schema=hr_test'.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

let failures = 0;
const log = (...a) => console.log(...a);
function assert(cond, msg) {
  if (cond) { log(`  PASS  ${msg}`); } else { failures += 1; log(`  FAIL  ${msg}`); }
}

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
    end() { return this; },
    // cookie sink so setCustomerTokenCookie doesn't blow up
    cookie() { return this; },
    clearCookie() { return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    append() { return this; },
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

const PREFIX = 'PORTAL-INV-TEST';

async function main() {
  log('\n=== Feature 4 — employee portal-invitation flow ===\n');

  if (!process.env.DATABASE_URL) {
    log('[skip] DATABASE_URL not set — portal-invite proof needs the live hr_test schema.\n');
    return;
  }

  const prisma = require('../../../core/lib/prisma');
  const portalInvite = require('../portalInvite');
  const notifications = require('../../integrations/notifications');
  const employeeCtrl = require('../../controllers/employee.controller');
  const customerCtrl = require('../../../core/controllers/customer.controller');

  // Spy on the fan-out so we can prove HR_PORTAL_INVITE fired without needing a
  // configured provider. We REPLACE the module export (portalInvite calls it via
  // the module reference) and capture every call.
  const fired = [];
  const realNotify = notifications.notifyHrEvent;
  notifications.notifyHrEvent = async (args) => { fired.push(args); return { ok: true, channel: 'email', spy: true }; };

  // ── Build two isolated tenants + employees ──────────────────────────────
  async function makeTenant(tag) {
    return prisma.business.create({
      data: { name: `${PREFIX} ${tag}`, slug: `${PREFIX.toLowerCase()}-${tag}-${Date.now()}`, email: `${tag}@example.com` },
    });
  }
  async function makeEmployee(businessId, tag, { workEmail, status = 'ACTIVE', withCustomer = false, claimed = false } = {}) {
    const email = (workEmail || `${PREFIX}-${tag}@example.com`).toLowerCase();
    const emp = await prisma.employee.create({
      data: {
        businessId, code: `${PREFIX}-${tag}`, firstName: 'New', lastName: tag,
        workEmail: email, status, isActive: true, countryCode: 'IN', phone: '+919876500000',
      },
    });
    if (withCustomer) {
      await prisma.customer.create({
        data: {
          businessId, email, name: `New ${tag}`,
          password: bcrypt.hashSync('TempRandom#123', 10),
          // an UNCLAIMED ESS identity: not verified, no passwordChangedAt
          emailVerified: claimed, isActive: true,
          ...(claimed ? { passwordChangedAt: new Date() } : {}),
        },
      });
    }
    return emp;
  }

  let bizA;
  let bizB;
  try {
    bizA = await makeTenant('A');
    bizB = await makeTenant('B');

    // ── 7a: status NOT_INVITED before any invite ──
    log('7) portal-status transitions:');
    const emp1 = await makeEmployee(bizA.id, 'EMP1', { withCustomer: true, claimed: false });
    let st = await portalInvite.portalStatusForEmployee(bizA.id, { id: emp1.id, workEmail: emp1.workEmail });
    assert(st.state === 'NOT_INVITED', `before invite → NOT_INVITED (got ${st.state})`);

    // ── 1: admin invites (via SERVICE) → hashed token + notification + link ──
    log('\n1) invite → hashed token persisted + HR_PORTAL_INVITE fired + link:');
    const beforeFired = fired.length;
    const r1 = await portalInvite.createInvite({ businessId: bizA.id, employeeId: emp1.id, createdByUserId: 'op-A' });
    assert(r1.ok === true, 'createInvite ok');
    assert(typeof r1.link === 'string' && r1.link.includes('/set-password?token='), `link returned with /set-password?token= (${r1.link})`);
    // recover the RAW token from the link we returned (it is NOT in the result)
    const rawToken1 = new URL(r1.link, 'https://x.example').searchParams.get('token');
    assert(!!rawToken1 && rawToken1.length >= 40, 'raw token present in link, >=40 chars');
    const row1 = await prisma.employeeInvite.findFirst({ where: { businessId: bizA.id, employeeId: emp1.id }, orderBy: { createdAt: 'desc' } });
    assert(!!row1, 'invite row persisted');
    assert(row1.tokenHash && row1.tokenHash !== rawToken1, 'stored tokenHash != raw token (hashed at rest)');
    assert(row1.tokenHash === crypto.createHash('sha256').update(rawToken1).digest('hex'), 'stored hash == sha256(raw)');
    assert(row1.status === 'PENDING' && !row1.usedAt, 'row PENDING, not used');
    assert(fired.length === beforeFired + 1, 'exactly one HR notification fired');
    const fire1 = fired[fired.length - 1];
    assert(fire1 && (fire1.event === 'portal.invite' || fire1.templateKey === 'HR_PORTAL_INVITE'), 'fired event is portal.invite');
    assert(fire1.variables && fire1.variables.EMAIL === emp1.workEmail, 'notification carries the work-email login');

    // ── 7b: status INVITED after invite ──
    st = await portalInvite.portalStatusForEmployee(bizA.id, { id: emp1.id, workEmail: emp1.workEmail });
    assert(st.state === 'INVITED', `after invite → INVITED (got ${st.state})`);

    // ── 8: another tenant's token can't be used (tenant isolation) ──
    log('\n8) tenant isolation — bizB cannot accept a bizA token:');
    // The accept path resolves tenant FROM the token, so even a totally separate
    // tenant context can only ever resolve to bizA. Prove a bizB customer/email
    // collision does NOT let bizB claim bizA's token: make a bizB employee with
    // the SAME work email and confirm the accept binds to bizA, not bizB.
    const empB = await makeEmployee(bizB.id, 'EMP1', { workEmail: emp1.workEmail, withCustomer: true });
    const acceptForeign = await portalInvite.acceptInvite({ token: rawToken1, passwordHash: bcrypt.hashSync('Whatever#123', 12) });
    assert(acceptForeign.ok === true && acceptForeign.businessId === bizA.id, `token binds to its own tenant (bizA), not bizB (got ${acceptForeign.businessId})`);
    // bizB's customer for the same email must be UNTOUCHED (still unverified)
    const bizBCust = await prisma.customer.findUnique({ where: { businessId_email: { businessId: bizB.id, email: emp1.workEmail } } });
    assert(bizBCust && bizBCust.emailVerified === false, 'bizB same-email customer untouched (emailVerified still false)');

    // ── 2: that accept set the bizA password + verified + active + can login ──
    log('\n2) accept-invite set password + verified + login works:');
    const bizACust = await prisma.customer.findUnique({ where: { businessId_email: { businessId: bizA.id, email: emp1.workEmail } } });
    assert(bizACust.emailVerified === true && bizACust.isActive === true, 'bizA customer emailVerified + isActive after accept');
    assert(bizACust.passwordChangedAt != null, 'passwordChangedAt stamped (sessions revoked)');
    const row1After = await prisma.employeeInvite.findUnique({ where: { id: row1.id } });
    assert(row1After.status === 'ACCEPTED' && row1After.usedAt != null, 'invite marked ACCEPTED + usedAt set (single-use)');

    // login via the public customer controller (resolveBusinessId via header host)
    // — we set the password we hashed above; prove bcrypt.compare matches.
    assert(bcrypt.compareSync('Whatever#123', bizACust.password), 'new password verifies (bcrypt) → employee can log in');

    // ── 7c: status ACTIVE after claim ──
    st = await portalInvite.portalStatusForEmployee(bizA.id, { id: emp1.id, workEmail: emp1.workEmail });
    assert(st.state === 'ACTIVE', `after accept → ACTIVE (got ${st.state})`);

    // ── 3: a USED token is rejected (generic) ──
    log('\n3) used token rejected (generic, no enumeration):');
    const usedAgain = await portalInvite.acceptInvite({ token: rawToken1, passwordHash: bcrypt.hashSync('Another#123', 12) });
    assert(usedAgain.ok === false && usedAgain.reason === 'INVALID', 'used token → {ok:false, INVALID}');

    // ── 4: a WRONG/garbage token is rejected (same generic) ──
    log('\n4) wrong/garbage token rejected (same generic reason):');
    const garbage = await portalInvite.acceptInvite({ token: 'totally-made-up-token-zzz', passwordHash: bcrypt.hashSync('Another#123', 12) });
    assert(garbage.ok === false && garbage.reason === 'INVALID', 'garbage token → INVALID (no distinction from used)');

    // ── 5: an EXPIRED token is rejected ──
    log('\n5) expired token rejected:');
    const emp2 = await makeEmployee(bizA.id, 'EMP2', { withCustomer: true });
    const r2 = await portalInvite.createInvite({ businessId: bizA.id, employeeId: emp2.id });
    const raw2 = new URL(r2.link, 'https://x.example').searchParams.get('token');
    // force-expire it
    await prisma.employeeInvite.updateMany({ where: { businessId: bizA.id, employeeId: emp2.id, status: 'PENDING' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await portalInvite.acceptInvite({ token: raw2, passwordHash: bcrypt.hashSync('Another#123', 12) });
    assert(expired.ok === false && expired.reason === 'INVALID', 'expired token → INVALID');
    // and status reads EXPIRED
    const stExp = await portalInvite.portalStatusForEmployee(bizA.id, { id: emp2.id, workEmail: emp2.workEmail });
    assert(stExp.state === 'EXPIRED', `expired pending → status EXPIRED (got ${stExp.state})`);

    // ── 6: re-invite REVOKEs the prior token ──
    log('\n6) re-invite invalidates the old token:');
    const emp3 = await makeEmployee(bizA.id, 'EMP3', { withCustomer: true });
    const rA = await portalInvite.createInvite({ businessId: bizA.id, employeeId: emp3.id });
    const rawA = new URL(rA.link, 'https://x.example').searchParams.get('token');
    const rB = await portalInvite.createInvite({ businessId: bizA.id, employeeId: emp3.id }); // re-invite
    const rawB = new URL(rB.link, 'https://x.example').searchParams.get('token');
    assert(rawA !== rawB, 'fresh token minted on re-invite');
    const oldRow = await prisma.employeeInvite.findUnique({ where: { tokenHash: crypto.createHash('sha256').update(rawA).digest('hex') } });
    assert(oldRow && oldRow.status === 'REVOKED', 'prior invite REVOKED');
    const acceptOld = await portalInvite.acceptInvite({ token: rawA, passwordHash: bcrypt.hashSync('Another#123', 12) });
    assert(acceptOld.ok === false, 'old (revoked) token rejected');
    const acceptNew = await portalInvite.acceptInvite({ token: rawB, passwordHash: bcrypt.hashSync('FreshPass#123', 12) });
    assert(acceptNew.ok === true, 'fresh token accepted');

    // ── 9: no-clobber on a routine re-invite of an ALREADY-active login ──
    log('\n9) no-clobber — re-invite of an active login refused unless reset:');
    const emp4 = await makeEmployee(bizA.id, 'EMP4', { withCustomer: true, claimed: true });
    const noClobber = await portalInvite.createInvite({ businessId: bizA.id, employeeId: emp4.id });
    assert(noClobber.ok === false && noClobber.reason === 'ALREADY_ACTIVE', 'active login → routine invite refused (ALREADY_ACTIVE)');
    const reset = await portalInvite.createInvite({ businessId: bizA.id, employeeId: emp4.id, allowReset: true });
    assert(reset.ok === true, 'allowReset overrides → invite minted');

    // ── 10: the ADMIN controller path returns link + fires + audits ──
    log('\n10) POST /:id/invite controller returns link + fires:');
    const emp5 = await makeEmployee(bizA.id, 'EMP5', { withCustomer: true });
    const before5 = fired.length;
    const res5 = await callController(employeeCtrl.invite, {
      user: { businessId: bizA.id, id: 'op-A', role: 'BUSINESS_ADMIN' },
      params: { id: emp5.id }, body: {}, scope: { kind: 'ALL' },
    });
    assert(res5.statusCode === 200 && res5.body.ok === true, 'controller 200 ok');
    assert(typeof res5.body.link === 'string' && res5.body.link.includes('/set-password?token='), 'controller returns copyable link');
    assert(res5.body.loginEmail === emp5.workEmail, 'controller surfaces the work-email login');
    assert(fired.length === before5 + 1, 'controller fired the notification');

    // ── 10b: the public accept-invite CONTROLLER (auto-login cookie) ──
    log('\n10b) POST /api/customer/accept-invite controller (public claim):');
    const rawCtrlToken = new URL(res5.body.link, 'https://x.example').searchParams.get('token');
    const acceptRes = await callController(customerCtrl.acceptInvite, {
      body: { token: rawCtrlToken, password: 'StrongPass#123' },
      headers: {}, cookies: {},
    });
    assert(acceptRes.statusCode === 200 && acceptRes.body.ok === true, 'accept controller 200 + ok');
    assert(acceptRes.body.customer && acceptRes.body.customer.businessId === bizA.id, 'auto-login customer bound to bizA');
    // weak password → 400 (strength rule), token stays usable
    const weakRes = await callController(customerCtrl.acceptInvite, {
      body: { token: 'x'.repeat(43), password: 'weak' }, headers: {}, cookies: {},
    });
    assert(weakRes.statusCode === 400, 'weak password rejected (400) before token touched');

    // ── 10c: LIST read surfaces portalStatus per row ──
    log('\n10c) employee LIST read surfaces portalStatus:');
    const listRes = await callController(employeeCtrl.list, {
      user: { businessId: bizA.id, id: 'op-A', role: 'BUSINESS_ADMIN' },
      query: { pageSize: '100' }, scope: { kind: 'ALL' },
    });
    assert(listRes.statusCode === 200 && Array.isArray(listRes.body.items), 'list 200 + items[]');
    const sample = listRes.body.items.find((i) => i.id === emp1.id);
    assert(sample && sample.portalStatus === 'ACTIVE', `emp1 row shows portalStatus ACTIVE (got ${sample && sample.portalStatus})`);
    const sample5 = listRes.body.items.find((i) => i.id === emp5.id);
    assert(sample5 && sample5.portalStatus === 'ACTIVE', `emp5 row shows ACTIVE after claim (got ${sample5 && sample5.portalStatus})`);

    // ── 11: ACCOUNT-TAKEOVER GUARD (HIGH) ───────────────────────────────────
    // A stale PENDING first-claim token must NOT be able to overwrite the password
    // of a login that is ALREADY active/claimed (activated through another path).
    // Only an EXPLICIT reset-minted token (allowReset) may re-set a claimed login.
    log('\n11) acceptInvite cannot take over an already-active login:');
    // emp6 has an UNCLAIMED ESS identity. Mint a first-claim invite while unclaimed.
    const emp6 = await makeEmployee(bizA.id, 'EMP6', { withCustomer: true, claimed: false });
    const inv6 = await portalInvite.createInvite({ businessId: bizA.id, employeeId: emp6.id });
    const stale6 = new URL(inv6.link, 'https://x.example').searchParams.get('token');
    const stale6Row = await prisma.employeeInvite.findUnique({ where: { tokenHash: crypto.createHash('sha256').update(stale6).digest('hex') } });
    assert(stale6Row && stale6Row.isReset === false, 'first-claim token is NOT marked isReset');
    // The login becomes ACTIVE by some OTHER path (e.g. self-serve verify / earlier
    // claim) while the token is still sitting PENDING in someone's inbox.
    const knownHash = bcrypt.hashSync('LegitOwner#123', 12);
    await prisma.customer.update({
      where: { businessId_email: { businessId: bizA.id, email: emp6.workEmail } },
      data: { password: knownHash, emailVerified: true, isActive: true, passwordChangedAt: new Date() },
    });
    // Replaying the stale token must be REFUSED (generic), and must NOT change the pw.
    const takeover = await portalInvite.acceptInvite({ token: stale6, passwordHash: bcrypt.hashSync('Attacker#123', 12) });
    assert(takeover.ok === false && takeover.reason === 'INVALID', 'stale first-claim token on an active login → INVALID (no takeover)');
    const cust6 = await prisma.customer.findUnique({ where: { businessId_email: { businessId: bizA.id, email: emp6.workEmail } } });
    assert(cust6.password === knownHash, 'active login password UNCHANGED (attacker password not written)');
    assert(bcrypt.compareSync('LegitOwner#123', cust6.password) && !bcrypt.compareSync('Attacker#123', cust6.password), 'legit owner password still verifies; attacker password does not');
    // The stale token is NOT consumed by the refusal (tx rolled back) — it stays
    // PENDING and useless against the active login until revoked/expired.
    const stale6After = await prisma.employeeInvite.findUnique({ where: { id: stale6Row.id } });
    assert(stale6After.status === 'PENDING' && stale6After.usedAt == null, 'refused token left PENDING (tx rolled back, not silently consumed)');

    // ── 12: RESET-invite STILL WORKS over an active login ───────────────────
    log('\n12) explicit reset-invite can still re-set an active login:');
    const resetInv = await portalInvite.createInvite({ businessId: bizA.id, employeeId: emp6.id, allowReset: true });
    assert(resetInv.ok === true, 'allowReset over an active login mints a token');
    const resetRaw = new URL(resetInv.link, 'https://x.example').searchParams.get('token');
    const resetRow = await prisma.employeeInvite.findUnique({ where: { tokenHash: crypto.createHash('sha256').update(resetRaw).digest('hex') } });
    assert(resetRow && resetRow.isReset === true, 'reset token IS marked isReset');
    const resetHash = bcrypt.hashSync('OwnerResetPw#123', 12);
    const resetAccept = await portalInvite.acceptInvite({ token: resetRaw, passwordHash: resetHash });
    assert(resetAccept.ok === true && resetAccept.businessId === bizA.id, 'reset token accepted → owner can re-set their password');
    const cust6Reset = await prisma.customer.findUnique({ where: { businessId_email: { businessId: bizA.id, email: emp6.workEmail } } });
    assert(cust6Reset.password === resetHash, 'reset wrote the new password (legitimate self-service reset)');

    // ── 13: BULK-INVITE SCOPE — fail-CLOSED, never fail-open (HIGH) ──────────
    // The bulk controller must intersect the requested ids with the actor's F1
    // accessible set for EVERY band. A NONE-band operator invites NOTHING; an IDS
    // operator invites only ids inside their sub-tree; ALL invites tenant-wide.
    log('\n13) inviteBulk scope: NONE→none, IDS→intersect, ALL→all (no fail-open):');
    const bScopeA = await makeEmployee(bizA.id, 'SCOPE-IN', { withCustomer: true });
    const bScopeB = await makeEmployee(bizA.id, 'SCOPE-OUT', { withCustomer: true });
    const reqIds = [bScopeA.id, bScopeB.id];

    // 13a: NONE band → no invites sent, both reported OUT_OF_SCOPE (the bug let a
    // NONE operator invite everyone — it must now invite nobody).
    const noneRes = await callController(employeeCtrl.inviteBulk, {
      user: { businessId: bizA.id, id: 'op-none', role: 'BUSINESS_USER' },
      body: { employeeIds: reqIds }, scope: { kind: 'NONE' },
    });
    assert(noneRes.statusCode === 200 && noneRes.body.sent === 0, `NONE band sends 0 invites (got sent=${noneRes.body && noneRes.body.sent})`);
    assert(noneRes.body.results.every((r) => r.ok === false && r.reason === 'OUT_OF_SCOPE'), 'NONE band: every requested id reported OUT_OF_SCOPE');
    const noneMinted = await prisma.employeeInvite.count({ where: { businessId: bizA.id, employeeId: { in: reqIds } } });
    assert(noneMinted === 0, 'NONE band minted NO invite rows (fail-closed, not fail-open)');

    // 13b: IDS band that includes only bScopeA → only bScopeA invited, bScopeB OUT.
    const idsRes = await callController(employeeCtrl.inviteBulk, {
      user: { businessId: bizA.id, id: 'op-team', role: 'BUSINESS_USER' },
      body: { employeeIds: reqIds }, scope: { kind: 'IDS', ids: new Set([bScopeA.id]) },
    });
    assert(idsRes.statusCode === 200 && idsRes.body.sent === 1, `IDS band sends exactly 1 (got sent=${idsRes.body && idsRes.body.sent})`);
    const okRow = idsRes.body.results.find((r) => r.employeeId === bScopeA.id);
    const outRow = idsRes.body.results.find((r) => r.employeeId === bScopeB.id);
    assert(okRow && okRow.ok === true, 'IDS band: in-scope id invited');
    assert(outRow && outRow.ok === false && outRow.reason === 'OUT_OF_SCOPE', 'IDS band: out-of-scope id blocked (OUT_OF_SCOPE)');
    const bScopeBMinted = await prisma.employeeInvite.count({ where: { businessId: bizA.id, employeeId: bScopeB.id } });
    assert(bScopeBMinted === 0, 'IDS band: NO invite minted for the out-of-scope employee');

    // 13c: ALL band → both invited (the legitimate tenant-wide operator).
    const allRes = await callController(employeeCtrl.inviteBulk, {
      user: { businessId: bizA.id, id: 'op-all', role: 'BUSINESS_ADMIN' },
      body: { employeeIds: reqIds }, scope: { kind: 'ALL' },
    });
    assert(allRes.statusCode === 200 && allRes.body.sent === 2, `ALL band sends to every requested id (got sent=${allRes.body && allRes.body.sent})`);
    assert(allRes.body.results.every((r) => r.ok === true), 'ALL band: every requested id invited');

    // 13d: TENANT ISOLATION — an ALL-band operator cannot bulk-invite ANOTHER
    // tenant's employee id (it isn't in their tenant, so createInvite 404s it).
    const foreignEmp = await makeEmployee(bizB.id, 'FOREIGN', { withCustomer: true });
    const crossRes = await callController(employeeCtrl.inviteBulk, {
      user: { businessId: bizA.id, id: 'op-all', role: 'BUSINESS_ADMIN' },
      body: { employeeIds: [foreignEmp.id] }, scope: { kind: 'ALL' },
    });
    assert(crossRes.statusCode === 200 && crossRes.body.sent === 0, 'cross-tenant id is not invited (sent=0)');
    const crossRow = crossRes.body.results.find((r) => r.employeeId === foreignEmp.id);
    assert(crossRow && crossRow.ok === false, "another tenant's employee id is refused");
    const foreignMinted = await prisma.employeeInvite.count({ where: { employeeId: foreignEmp.id } });
    assert(foreignMinted === 0, 'no invite minted against the cross-tenant employee (tenant wall holds)');
  } finally {
    notifications.notifyHrEvent = realNotify;
    // ── cleanup (children first; businesses cascade the rest) ──
    try {
      if (bizA || bizB) {
        const bizIds = [bizA && bizA.id, bizB && bizB.id].filter(Boolean);
        await prisma.employeeInvite.deleteMany({ where: { businessId: { in: bizIds } } });
        await prisma.customer.deleteMany({ where: { businessId: { in: bizIds } } });
        await prisma.employee.deleteMany({ where: { businessId: { in: bizIds } } });
        await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
      }
    } catch (e) { log('  cleanup warn:', e.message); }
    await prisma.$disconnect();
  }

  log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
