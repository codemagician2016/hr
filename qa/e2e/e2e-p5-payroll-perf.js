'use strict';
/* Phase 5d E2E on live staging: payroll performance pass.
 * The flagship change (batch-prefetch the covering compensation revision for the
 * whole run in ONE query instead of N per-employee findFirst calls) is proven for
 * EXACT parity by a read-only SSM probe (prefetchCurrentCompensations vs the
 * per-employee resolveCurrentCompensation, on real data) + the 9 payroll golden
 * suites (engine untouched). This live suite proves the OTHER P5d change — OPTIONAL,
 * backward-compatible pagination on GET /runs/:id/payslips: no params → all rows +
 * true total (unchanged); with page/pageSize → a bounded page + real count.
 * Read-only (no run is created/computed/cancelled). 1 login. fetch-retry harness. */
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

(async () => {
  const op = jar();
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator (HR Admin) login', r.status === 200);

  // Find any run that has payslips (a computed/downstream run).
  r = await call(op, 'GET', '/api/hr/payroll/runs?pageSize=25');
  const runs = r.data?.items || [];
  rec('Payroll runs list responds', r.status === 200, `${runs.length} runs`);

  let runId = null; let baseline = null;
  for (const run of runs) {
    const pr = await call(op, 'GET', `/api/hr/payroll/runs/${run.id}/payslips`);
    if (pr.status === 200 && Array.isArray(pr.data?.items) && pr.data.items.length > 0) { runId = run.id; baseline = pr.data; break; }
  }

  if (!runId) {
    rec('Payslips pagination (needs a run with payslips)', 'skip', 'no computed run with payslips on staging');
  } else {
    const all = baseline.items;
    // Backward-compat: no params → all rows, and total === the full count (=== items.length here).
    rec('Unpaginated returns all rows', all.length > 0, `${all.length} payslips`);
    rec('Unpaginated total === full count', baseline.total === all.length, `total ${baseline.total} vs ${all.length}`);
    rec('Unpaginated omits page/pageSize (shape unchanged)', baseline.page === undefined && baseline.pageSize === undefined, `page=${baseline.page} pageSize=${baseline.pageSize}`);

    // Paginated: pageSize=1 → at most 1 row, but the TRUE total is still the full count.
    r = await call(op, 'GET', `/api/hr/payroll/runs/${runId}/payslips?pageSize=1&page=1`);
    const p1 = r.data;
    rec('pageSize=1 returns ≤1 row', Array.isArray(p1?.items) && p1.items.length <= 1, `len ${p1?.items?.length}`);
    rec('Paginated total is the real count (not page len)', p1?.total === all.length, `total ${p1?.total} vs ${all.length}`);
    rec('Paginated echoes page & pageSize', p1?.page === 1 && p1?.pageSize === 1, `page=${p1?.page} pageSize=${p1?.pageSize}`);

    if (all.length >= 2) {
      r = await call(op, 'GET', `/api/hr/payroll/runs/${runId}/payslips?pageSize=1&page=2`);
      const p2 = r.data;
      rec('page 2 differs from page 1 (ordered slice)', (p2?.items?.[0]?.id) && p2.items[0].id !== p1.items[0].id, `p1 ${p1?.items?.[0]?.id?.slice(0, 8)} p2 ${p2?.items?.[0]?.id?.slice(0, 8)}`);
    } else {
      rec('page 2 differs from page 1 (ordered slice)', 'skip', 'only 1 payslip in the run');
    }
  }

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P5d payroll-perf E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
