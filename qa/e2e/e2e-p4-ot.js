'use strict';
/* Phase 4 workforce wave C E2E on live staging: OT pre-approval (21st engine
 * module). Covers: OT rule requirePreApproval toggle, ESS submit → engine
 * request opened (PENDING + approvalRequestId), admin visibility, manager
 * approves via the /approvals inbox → consumer flips OvertimeRequest APPROVED,
 * and a separate ESS cancel → CANCELLED. Cleanup: OT rule removed, sandbox
 * requests are 2099-dated. 3 logins (HR Admin + Priya + Manager Aarav) →
 * 26s spacing, ~6min cooldown before a full rerun. fetch-retry harness. */
const A = require('./config').ADMIN;
const M = require('./config').MOBILE;
const pb = require('./config');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, opts, tries = 4) { let last; for (let i = 0; i < tries; i++) { try { return await fetch(url, opts); } catch (e) { last = e; await sleep(1500 * (i + 1)); } } throw last; }
async function call(origin, j, method, path, body) {
  const h = { 'X-Tenant-Host': 'demo.staging.drifthr.com' };
  if (j && j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetchRetry(origin + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (j && setC.length) {
    const pairs = setC.map((c) => c.split(';')[0].trim()).filter((p) => p.includes('='));
    const map = new Map((j.cookie ? j.cookie.split('; ') : []).map((p) => [p.split('=')[0], p]));
    for (const p of pairs) map.set(p.split('=')[0], p);
    j.cookie = [...map.values()].join('; ');
  }
  let data = null; try { data = await res.json(); } catch (_e) {}
  return { status: res.status, data };
}

(async () => {
  const op = jar(); const priya = jar(); const mgr = jar();
  const T = 'OT-' + (Date.now() % 100000);
  const day = (n) => `2099-03-${String(n).padStart(2, '0')}`;
  const d1 = day((Date.now() % 20) + 1); const d2 = day((Date.now() % 20) + 2);

  let r = await call(A, op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { email: cred('Priya').email, password: cred('Priya').password });
  rec('Priya login', r.status === 200);
  await sleep(26000);
  r = await call(A, mgr, 'POST', '/api/auth/login', { email: cred('Manager').email, password: cred('Manager').password });
  rec('Manager (Aarav) login', r.status === 200);

  // ── A. OT rule with requirePreApproval ────────────────────────────────────
  r = await call(A, op, 'POST', '/api/hr/attendance/overtime-rules', { dailyThresholdMin: 480, weekdayMultiplier: 1.5, weeklyOffMultiplier: 2, holidayMultiplier: 2, roundingMin: 15, requirePreApproval: true });
  const otRule = r.data?.rule || r.data;
  rec('OT rule created with requirePreApproval', (r.status === 201 || r.status === 200) && !!otRule?.id, `status ${r.status}`);

  // ── B. ESS submit → engine request opened ─────────────────────────────────
  r = await call(M, priya, 'POST', '/api/hr/me/attendance/overtime', { date: d1, requestedMinutes: 120, reason: `${T} project crunch` });
  const req1 = r.data?.request || r.data;
  rec('ESS OT request submitted', (r.status === 201 || r.status === 200) && !!req1?.id && (req1.status === 'PENDING'), `status ${r.status} ${r.data?.message || ''}`);
  rec('Request opened an approval (approvalRequestId)', !!req1?.approvalRequestId, `arid=${req1?.approvalRequestId ? 'yes' : 'no'}`);
  r = await call(M, priya, 'GET', '/api/hr/me/attendance/overtime');
  rec('ESS lists my OT request', (r.data?.items || []).some((x) => x.id === req1.id));
  r = await call(A, op, 'GET', '/api/hr/attendance/overtime-requests?status=PENDING');
  rec('Admin sees the pending OT request', (r.data?.items || []).some((x) => x.id === req1.id));

  // ── C. manager approves via the inbox → consumer flips APPROVED ───────────
  r = await call(A, mgr, 'GET', '/api/hr/approvals/inbox?module=OVERTIME');
  const inbox = r.data?.items || [];
  const mine = inbox.find((x) => x.entityId === req1.id || (x.entityType === 'OvertimeRequest' && x.entityId === req1.id));
  rec('OT request in the manager inbox', !!mine, `inbox=${inbox.length}`);
  if (mine) {
    r = await call(A, mgr, 'POST', `/api/hr/approvals/${mine.id}/decide`, { decision: 'APPROVED', comment: `${T} ok` });
    rec('Manager approves', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
    r = await call(A, op, 'GET', '/api/hr/attendance/overtime-requests?status=APPROVED');
    rec('OT request flipped APPROVED (consumer)', (r.data?.items || []).some((x) => x.id === req1.id));
  } else {
    rec('Manager approves', 'skip', 'not in this manager inbox');
    rec('OT request flipped APPROVED (consumer)', 'skip');
  }

  // ── D. cancel path (a second request) ─────────────────────────────────────
  r = await call(M, priya, 'POST', '/api/hr/me/attendance/overtime', { date: d2, requestedMinutes: 60, reason: `${T} cancel me` });
  const req2 = r.data?.request || r.data;
  rec('Second OT request submitted', (r.status === 201 || r.status === 200) && !!req2?.id, `status ${r.status}`);
  r = await call(M, priya, 'POST', `/api/hr/me/attendance/overtime/${req2.id}/cancel`, {});
  rec('ESS cancels the request', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'GET', '/api/hr/attendance/overtime-requests?status=CANCELLED');
  rec('Request flipped CANCELLED', (r.data?.items || []).some((x) => x.id === req2.id));

  // ── cleanup ───────────────────────────────────────────────────────────────
  const del = await call(A, op, 'DELETE', `/api/hr/attendance/overtime-rules/${otRule.id}`);
  rec('Cleanup (OT rule removed)', [200, 204].includes(del.status), `status ${del.status}`);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P4 OT pre-approval E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
