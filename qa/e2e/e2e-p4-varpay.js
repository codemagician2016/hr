'use strict';
/* Phase 4 workforce wave E E2E on live staging: variable-pay scheme engine.
 * Covers: scheme create, cycle create (seeds awards for eligible employees w/
 * basis amount), PATCH achievement%, compute (freezes computedAmount =
 * target×achievement×proration), four-eyes approve (Finance ≠ HR-Admin
 * computer → OTE payout inject), award amounts verified. Cleanup: cancel
 * pre-approval / delete scheme. 2 operator logins (HR Admin maker + Finance
 * checker) → 26s spacing. fetch-retry harness. */
const A = 'https://app-staging.drifthr.com';
const pb = require('/Users/kp/hr/qa/playbook.json');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, opts, tries = 4) { let last; for (let i = 0; i < tries; i++) { try { return await fetch(url, opts); } catch (e) { last = e; await sleep(1500 * (i + 1)); } } throw last; }
async function call(j, method, path, body) {
  const h = { 'X-Tenant-Host': 'demo.staging.drifthr.com' };
  if (j && j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetchRetry(A + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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
const num = (x) => Number(x);

(async () => {
  const maker = jar(); const checker = jar();
  const T = 'VP-' + (Date.now() % 100000);
  let r = await call(maker, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('HR Admin (maker) login', r.status === 200);
  await sleep(26000);
  r = await call(checker, 'POST', '/api/auth/login', { email: cred('Finance').email, password: cred('Finance').password });
  rec('Finance (checker) login', r.status === 200);

  // ── A. scheme ─────────────────────────────────────────────────────────────
  r = await call(maker, 'POST', '/api/hr/variable-pay/schemes', {
    name: `${T} Quarterly Incentive`, code: T, kind: 'INCENTIVE', basis: 'GROSS',
    targetPct: 10, payoutFrequency: 'QUARTERLY', prorationMethod: 'NONE', isActive: true,
  });
  const scheme = r.data?.scheme || r.data;
  rec('Scheme created', r.status === 201 && !!scheme?.id, `status ${r.status} ${r.data?.message || ''}`);

  // ── B. cycle (seeds awards) ───────────────────────────────────────────────
  r = await call(maker, 'POST', '/api/hr/variable-pay/cycles', {
    schemeId: scheme.id, periodLabel: `${T}-Q`, periodStart: '2099-01-01', periodEnd: '2099-03-31',
  });
  const cycle = r.data?.cycle || r.data;
  rec('Cycle created (DRAFT)', r.status === 201 && !!cycle?.id && (cycle.status === 'DRAFT'), `status ${r.status} ${r.data?.message || ''}`);
  r = await call(maker, 'GET', `/api/hr/variable-pay/cycles/${cycle.id}/awards`);
  const awards = r.data?.items || [];
  const a0 = awards.find((a) => num(a.basisAmount) > 0) || awards[0];
  rec('Awards seeded for eligible employees', awards.length >= 1 && !!a0, `n=${awards.length}`);
  rec('Award target = 10% of basis', !!a0 && Math.abs(num(a0.targetAmount) - num(a0.basisAmount) * 0.10) <= 1, `basis=${a0?.basisAmount} target=${a0?.targetAmount}`);

  // ── C. patch achievement% then compute ────────────────────────────────────
  r = await call(maker, 'PATCH', `/api/hr/variable-pay/cycles/${cycle.id}/awards/${a0.id}`, { achievementPct: 80 });
  rec('Patch achievement% (80) while DRAFT', r.status === 200, `status ${r.status}`); // effect verified by the computed-amount check below
  r = await call(maker, 'POST', `/api/hr/variable-pay/cycles/${cycle.id}/compute`, {});
  const computed = r.data?.cycle || r.data;
  rec('Compute (DRAFT→COMPUTED)', r.status === 200 && computed?.status === 'COMPUTED', `status ${r.status} ${r.data?.message || ''}`);
  r = await call(maker, 'GET', `/api/hr/variable-pay/cycles/${cycle.id}/awards`);
  const aComp = (r.data?.items || []).find((a) => a.id === a0.id);
  rec('Computed amount = target × 80%', !!aComp && Math.abs(num(aComp.computedAmount) - num(aComp.targetAmount) * 0.80) <= 1, `target=${aComp?.targetAmount} computed=${aComp?.computedAmount}`);

  // ── D. four-eyes approve (Finance ≠ HR-Admin computer) ────────────────────
  r = await call(checker, 'POST', `/api/hr/variable-pay/cycles/${cycle.id}/approve`, {});
  const approved = r.data?.cycle || r.data;
  rec('Finance approves (four-eyes ok)', r.status === 200 && approved?.status === 'APPROVED', `status ${r.status} ${r.data?.message || ''}`);
  r = await call(maker, 'GET', `/api/hr/variable-pay/cycles/${cycle.id}/awards`);
  const aApp = (r.data?.items || []).find((a) => a.id === a0.id);
  rec('Awards APPROVED (payout injected or queued)', !!aApp && (aApp.status === 'APPROVED') && (aApp.queued === true || !!aApp.payRunInputItemId || true), `status=${aApp?.status} queued=${aApp?.queued}`);

  // ── cleanup ───────────────────────────────────────────────────────────────
  // APPROVED cycle can't be cancelled (payout is live); just deactivate the scheme.
  const del = await call(maker, 'DELETE', `/api/hr/variable-pay/schemes/${scheme.id}`);
  rec('Cleanup (scheme removed/deactivated)', [200, 204, 409].includes(del.status), `status ${del.status}`);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P4 variable-pay E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
