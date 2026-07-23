'use strict';
/* Phase 4 workforce wave D E2E on live staging: open-shift claim (22nd engine
 * module). Covers: admin publishes an open shift, ESS claims it → engine
 * request opened, manager Aarav approves via the inbox → consumer flips claim
 * APPROVED + materializes the claimant's RosterDay + shift FILLED, admin sees
 * FILLED. Cleanup: cancel the open shift (2099-dated). 3 logins → 26s spacing,
 * ~6min cooldown before a full rerun. fetch-retry harness. */
const A = 'https://app-staging.drifthr.com';
const M = 'https://m-demo-staging.drifthr.com';
const pb = require('/Users/kp/hr/qa/playbook.json');
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
  const T = 'OS-' + (Date.now() % 100000);
  const date = `2099-04-${String((Date.now() % 25) + 1).padStart(2, '0')}`;

  let r = await call(A, op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { email: cred('Priya').email, password: cred('Priya').password });
  rec('Priya login', r.status === 200);
  await sleep(26000);
  r = await call(A, mgr, 'POST', '/api/auth/login', { email: cred('Manager').email, password: cred('Manager').password });
  rec('Manager (Aarav) login', r.status === 200);

  // ── A. a shift pattern (reuse an existing one, else create) ───────────────
  r = await call(A, op, 'GET', '/api/hr/attendance/shifts');
  let pattern = (r.data?.items || (Array.isArray(r.data) ? r.data : []))
    .find((p) => p.isActive !== false);
  if (!pattern?.id) {
    r = await call(A, op, 'POST', '/api/hr/attendance/shifts', { code: `${T}-D`, name: `${T} Day`, startTime: '09:00', endTime: '18:00' });
    pattern = r.data?.shift || r.data; // createShift returns the item directly (201)
  }
  rec('Shift pattern available', !!pattern?.id, pattern && (pattern.name || pattern.id));

  // ── B. admin publishes an open shift (headcount 1) ────────────────────────
  r = await call(A, op, 'POST', '/api/hr/attendance/open-shifts', { date, shiftPatternId: pattern.id, headcount: 1, note: `${T} extra cover` });
  const shift = r.data?.openShift || r.data;
  rec('Open shift published', (r.status === 201 || r.status === 200) && !!shift?.id && shift.status === 'OPEN', `status ${r.status} ${r.data?.message || ''}`);

  // ── C. ESS claims it → engine request opened ──────────────────────────────
  r = await call(M, priya, 'GET', '/api/hr/me/shifts/open');
  const listed = (r.data?.items || []).some((x) => x.id === shift.id);
  rec('Open shift visible to employee', listed, `count=${r.data?.items?.length}`);
  r = await call(M, priya, 'POST', `/api/hr/me/shifts/open/${shift.id}/claim`, {});
  const claim = r.data?.claim || r.data;
  rec('Employee claims the shift', (r.status === 201 || r.status === 200) && !!claim?.id && !!claim.approvalRequestId, `status ${r.status} arid=${claim?.approvalRequestId ? 'yes' : 'no'} ${r.data?.message || ''}`);
  r = await call(M, priya, 'POST', `/api/hr/me/shifts/open/${shift.id}/claim`, {});
  rec('Double-claim blocked (409)', r.status === 409, `status ${r.status}`);
  r = await call(M, priya, 'GET', '/api/hr/me/shifts/open/claims');
  rec('ESS lists my claim', (r.data?.items || []).some((x) => x.id === claim.id));

  // ── D. manager approves via inbox → consumer fills the shift ──────────────
  r = await call(A, mgr, 'GET', '/api/hr/approvals/inbox?module=OPEN_SHIFT_CLAIM');
  const mine = (r.data?.items || []).find((x) => x.entityId === claim.id);
  rec('Claim in the manager inbox', !!mine, `inbox=${r.data?.items?.length}`);
  if (mine) {
    r = await call(A, mgr, 'POST', `/api/hr/approvals/${mine.id}/decide`, { decision: 'APPROVED', comment: `${T} ok` });
    rec('Manager approves the claim', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
    r = await call(A, op, 'GET', `/api/hr/attendance/open-shifts/${shift.id}`);
    const after = r.data?.openShift || r.data;
    rec('Open shift now FILLED', after?.status === 'FILLED' && after?.filledCount >= 1, `status=${after?.status} filled=${after?.filledCount}`);
    const claims = after?.claims || [];
    rec('Claim flipped APPROVED (consumer)', claims.some((c) => c.id === claim.id && c.status === 'APPROVED'));
  } else {
    rec('Manager approves the claim', 'skip'); rec('Open shift now FILLED', 'skip'); rec('Claim flipped APPROVED (consumer)', 'skip');
  }

  // ── cleanup ───────────────────────────────────────────────────────────────
  const del = await call(A, op, 'POST', `/api/hr/attendance/open-shifts/${shift.id}/cancel`, {});
  rec('Cleanup (open shift cancelled)', [200, 204, 409].includes(del.status), `status ${del.status}`);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P4 open-shift E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
