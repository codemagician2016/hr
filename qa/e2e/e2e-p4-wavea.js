'use strict';
/* Phase 4 workforce wave A E2E on live staging: loan interest methods
 * (REDUCING_BALANCE amortization vs FLAT — schedule shape proven via the
 * installments) + recruitment pipeline templates (seed, create, apply to a
 * job → JobStage materialized, re-apply 409, exclusive default). Cleanup:
 * loans cancelled, template deleted, job removed. Single operator login. */
const A = require('./config').ADMIN;
const pb = require('./config');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, opts, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, opts); }
    catch (e) { last = e; await sleep(1500 * (i + 1)); } // flaky staging uplink → retry
  }
  throw last;
}
async function call(j, method, path, body) {
  const h = { 'X-Tenant-Host': 'demo.staging.drifthr.com' };
  if (j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetchRetry(A + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setC.length) {
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
  const op = jar();
  const T = 'P4A-' + (Date.now() % 100000);
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);

  r = await call(op, 'GET', '/api/hr/employees?q=Priya&pageSize=5');
  const emp = (r.data?.items || []).find((e) => (e.firstName || '').startsWith('Priya'));
  rec('Employee resolved', !!emp?.id, emp && emp.code);

  // ── A. LOAN interest methods ──────────────────────────────────────────────
  const mkLoan = async (method) => {
    let rr = await call(op, 'POST', '/api/hr/loans', {
      employeeId: emp.id, loanType: 'LOAN', principal: 120000, interestRate: 12,
      interestMethod: method, tenureMonths: 12, startDate: '2099-01-01', reason: `${T} ${method}`,
    });
    const loan = rr.data?.loan || rr.data;
    if (!loan?.id) return { create: rr.status, loan: null, installments: [] };
    await call(op, 'POST', `/api/hr/loans/${loan.id}/submit`, {});
    const ap = await call(op, 'POST', `/api/hr/loans/${loan.id}/approve`, {});
    rr = await call(op, 'GET', `/api/hr/loans/${loan.id}/installments`);
    return { create: 201, approve: ap.status, loan, installments: rr.data?.items || [] };
  };

  const red = await mkLoan('REDUCING_BALANCE');
  rec('REDUCING loan created + approved', !!red.loan && red.approve === 200, `create=${red.create} approve=${red.approve}`);
  const rInt = red.installments.map((i) => num(i.interestComponent));
  const rPrin = red.installments.map((i) => num(i.principalComponent));
  const decreasing = rInt.length >= 2 && rInt.every((v, i) => i === 0 || v <= rInt[i - 1] + 0.001) && rInt[0] > rInt[rInt.length - 1];
  const sumPrin = Math.round(rPrin.reduce((a, b) => a + b, 0));
  rec('REDUCING interest decreases per installment', red.installments.length === 12 && decreasing, `n=${red.installments.length} first=${rInt[0]} last=${rInt[rInt.length - 1]}`);
  rec('REDUCING principal sums to loan principal', sumPrin === 120000, `Σprincipal=${sumPrin}`);

  const flat = await mkLoan('FLAT');
  const fInt = flat.installments.map((i) => num(i.interestComponent));
  const flatEqualish = fInt.length === 12 && Math.abs(fInt[0] - fInt[fInt.length - 2]) < 0.02; // flat interest ~equal across rows (last may absorb rounding)
  rec('FLAT loan interest ~equal per installment', !!flat.loan && flatEqualish, `first=${fInt[0]} penult=${fInt[fInt.length - 2]}`);

  r = await call(op, 'POST', '/api/hr/loans', {
    employeeId: emp.id, loanType: 'LOAN', principal: 1000, interestRate: 0,
    interestMethod: 'NOPE', tenureMonths: 3, startDate: '2099-01-01',
  });
  rec('Bad interestMethod 422', r.status === 422, `status ${r.status}`);

  // ── B. PIPELINE TEMPLATES ─────────────────────────────────────────────────
  r = await call(op, 'POST', '/api/hr/recruitment/pipeline-templates/seed-defaults', {});
  rec('Seed default templates', r.status === 200 || r.status === 201, `status ${r.status} ${JSON.stringify(r.data || {}).slice(0, 50)}`);
  r = await call(op, 'GET', '/api/hr/recruitment/pipeline-templates');
  const tpls = r.data?.items || [];
  const standard = tpls.find((t) => /standard/i.test(t.name));
  rec('Standard template present with stages', !!standard && (standard.stages || []).length >= 3, `n=${tpls.length} stages=${standard?.stages?.length}`);

  r = await call(op, 'POST', '/api/hr/recruitment/pipeline-templates', {
    name: `${T} Custom`, description: 'e2e', stages: [
      { name: 'Sourced', kind: 'SOURCED', sortOrder: 0 },
      { name: 'Phone screen', kind: 'SCREENING', sortOrder: 1 },
      { name: 'Onsite', kind: 'INTERVIEW', sortOrder: 2 },
      { name: 'Offer', kind: 'OFFER', sortOrder: 3 },
      { name: 'Hired', kind: 'HIRED', sortOrder: 4 },
    ],
  });
  const custom = r.data;
  rec('Custom template created', r.status === 201 && !!custom?.id && (custom.stages || []).length === 5, `status ${r.status}`);

  // createJob may AUTO-SEED the active default template's stages (additive hook).
  // Whether a default is active depends on prior state, so branch on what the
  // fresh job actually has to keep this deterministic.
  const stagesOf = async (jid) => {
    const rr = await call(op, 'GET', `/api/hr/recruitment/jobs/${jid}/stages`);
    return rr.data?.items || rr.data?.stages || (Array.isArray(rr.data) ? rr.data : []);
  };
  r = await call(op, 'POST', '/api/hr/recruitment/jobs', { code: T, title: `${T} Role`, countryCode: 'IN', employmentType: 'FULL_TIME' });
  const job = r.data?.job || r.data;
  rec('Job created', (r.status === 201 || r.status === 200) && !!job?.id);
  const seeded = await stagesOf(job.id);

  if (seeded.length === 0) {
    // No active default → job is empty → plain apply materializes.
    r = await call(op, 'POST', `/api/hr/recruitment/pipeline-templates/${custom.id}/apply`, { jobId: job.id });
    rec('Apply to empty job → materialized', r.status === 200 && ((r.data?.stages || []).length === 5 || r.data?.count === 5 || r.data?.applied === true), `status ${r.status}`);
    // Now it has stages → applying again without replace is 409.
    r = await call(op, 'POST', `/api/hr/recruitment/pipeline-templates/${custom.id}/apply`, { jobId: job.id });
    rec('Re-apply without replace 409 STAGES_EXIST', r.status === 409 && (r.data?.code === 'STAGES_EXIST' || /stages/i.test(r.data?.message || '')), `status ${r.status}`);
  } else {
    // A default seeded stages → apply without replace is 409; replace=true works.
    rec('Apply to empty job → materialized', 'skip', `job auto-seeded ${seeded.length} default stages`);
    r = await call(op, 'POST', `/api/hr/recruitment/pipeline-templates/${custom.id}/apply`, { jobId: job.id });
    rec('Re-apply without replace 409 STAGES_EXIST', r.status === 409 && (r.data?.code === 'STAGES_EXIST' || /stages/i.test(r.data?.message || '')), `status ${r.status}`);
    r = await call(op, 'POST', `/api/hr/recruitment/pipeline-templates/${custom.id}/apply?replace=true`, { jobId: job.id });
    rec('Apply with replace=true → replaced', r.status === 200 && r.data?.applied === true, `status ${r.status} count=${r.data?.count}`);
  }
  const stages = await stagesOf(job.id);
  rec('Job now has the 5 custom stages', stages.length === 5, `stages=${stages.length}`);

  // exclusive default
  r = await call(op, 'PATCH', `/api/hr/recruitment/pipeline-templates/${custom.id}`, { isDefault: true });
  rec('Set custom as default', r.status === 200 && r.data?.isDefault === true);
  r = await call(op, 'GET', '/api/hr/recruitment/pipeline-templates');
  const defaults = (r.data?.items || []).filter((t) => t.isDefault);
  rec('Default is exclusive (exactly one)', defaults.length === 1 && defaults[0].id === custom.id, `defaults=${defaults.length}`);

  // ── cleanup ───────────────────────────────────────────────────────────────
  let cleaned = true;
  for (const l of [red.loan, flat.loan]) {
    if (l?.id) { const c = await call(op, 'POST', `/api/hr/loans/${l.id}/cancel`, { reason: `${T} cleanup` }); if (![200, 409].includes(c.status)) cleaned = false; }
  }
  const dj = await call(op, 'DELETE', `/api/hr/recruitment/jobs/${job.id}`);
  if (![200, 204].includes(dj.status)) { cleaned = false; console.log('   job del:', dj.status); }
  const dt = await call(op, 'DELETE', `/api/hr/recruitment/pipeline-templates/${custom.id}`);
  if (![200, 204].includes(dt.status)) { cleaned = false; console.log('   tpl del:', dt.status); }
  rec('Cleanup (loans cancelled, job + template removed)', cleaned);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P4 wave A E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
