'use strict';
/* Phase 5a E2E on live staging: multi-country (NZ) unlock — IN-REGRESSION.
 * The gate flip + NZ compute + disbursement dispatch are UNIT/golden-proven
 * (countryContext gate, nz.golden 63, disbursement 25 incl. IN byte-pins + NZ).
 * This live suite proves the change did NOT break the existing IN tenant:
 * country-context still IN/INR with capabilities, and the IN payroll +
 * disbursement surfaces still respond. (An NZ-tenant walkthrough — register →
 * setup NZ → NZ payrun → NZ pay-file — is staging-QA; see docs/features/67.)
 * fetch-retry harness. */
const A = require('./config').ADMIN;
const pb = require('./config');
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

(async () => {
  const op = jar();
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);

  // ── IN tenant unaffected by the NZ unlock ─────────────────────────────────
  r = await call(op, 'GET', '/api/hr/country-context');
  const cc = r.data || {};
  rec('Demo tenant still IN', r.status === 200 && cc.country === 'IN', `country=${cc.country}`);
  rec('Currency still INR', cc.currency === 'INR', `currency=${cc.currency}`);
  rec('IN capability matrix intact', !!cc.capabilities && (cc.capabilities.currency === 'INR' || cc.capabilities.letterLocale), JSON.stringify(cc.capabilities || {}).slice(0, 80));

  // country is locked-once — re-setup must be rejected (unchanged behaviour).
  r = await call(op, 'POST', '/api/hr/setup/country', { country: 'NZ' });
  rec('Country locked (re-setup rejected)', r.status === 409 || r.status === 422, `status ${r.status} ${r.data?.code || r.data?.message || ''}`);

  // ── IN payroll + disbursement surfaces still respond (dispatch change safe) ─
  r = await call(op, 'GET', '/api/hr/payroll/runs?pageSize=5');
  rec('IN payroll runs list OK', r.status === 200);
  const run = (r.data?.items || [])[0];
  if (run?.id) {
    r = await call(op, 'GET', `/api/hr/payroll/runs/${run.id}/disbursement/batches`).catch(() => ({ status: 0 }));
    rec('IN disbursement surface responds', r.status === 200 || r.status === 404, `status ${r.status}`);
  } else {
    rec('IN disbursement surface responds', 'skip', 'no runs to probe');
  }

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P5a NZ-unlock (IN-regression) E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
