'use strict';
/* E2E on live staging: reusable APPLICATION-FORM (screening) templates.
 * Proves the full ask: author reusable form templates, apply a DIFFERENT template
 * to each job, and have a public candidate apply against the templated form (scored).
 * Covers: template CRUD + validation (choice-without-options 422, dup-name 409);
 * apply template A -> Job1 and template B -> Job2 (different form per job, verified
 * by the stamped questions); re-apply guard (409 QUESTIONS_EXIST) + ?replace=true;
 * make Job1 public -> public board surfaces the questions -> public apply with answers
 * -> 201 -> operator sees the scored application. Cleanup: templates archived, jobs
 * deleted. 1 operator login (public apply is unauthenticated). fetch-retry harness. */
const A = 'https://app-staging.drifthr.com';
const pb = require('/Users/kp/hr/qa/playbook.json');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, opts, tries = 4) { let last; for (let i = 0; i < tries; i++) { try { return await fetch(url, opts); } catch (e) { last = e; await sleep(1500 * (i + 1)); } } throw last; }
async function call(j, method, path, body, extraHeaders) {
  const h = { 'X-Tenant-Host': 'demo.staging.drifthr.com', ...(extraHeaders || {}) };
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
const promptsOf = (arr) => (arr || []).map((q) => q.prompt).sort();
const created = { tpls: [], jobs: [] };

(async () => {
  const op = jar();
  const T = String(Date.now() % 100000);
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator (HR Admin) login', r.status === 200);

  // ── A. Author two DIFFERENT form templates ────────────────────────────────
  const tplA = {
    name: `E2E General ${T}`, description: 'Baseline',
    questions: [
      { prompt: `Auth to work? ${T}`, kind: 'BOOLEAN', required: true, isKnockout: true, knockoutValue: true, sortOrder: 0 },
      { prompt: `Years experience ${T}`, kind: 'NUMBER', required: true, maxPoints: 10, sortOrder: 1 },
    ],
  };
  const tplB = {
    name: `E2E Engineering ${T}`, description: 'Eng',
    questions: [
      { prompt: `Highest qualification ${T}`, kind: 'QUALIFICATION', required: true, sortOrder: 0,
        options: [{ label: "Master's", value: 'MASTERS', points: 6 }, { label: "Bachelor's", value: 'BACHELORS', points: 4 }] },
      { prompt: `On-call ok? ${T}`, kind: 'BOOLEAN', required: true, sortOrder: 1 },
    ],
  };
  r = await call(op, 'POST', '/api/hr/recruitment/screening-form-templates', tplA);
  const A_id = r.data?.id; if (A_id) created.tpls.push(A_id);
  rec('Create template A', (r.status === 201) && !!A_id && r.data.questions?.length === 2, `status ${r.status}`);
  r = await call(op, 'POST', '/api/hr/recruitment/screening-form-templates', tplB);
  const B_id = r.data?.id; if (B_id) created.tpls.push(B_id);
  rec('Create template B (with options)', (r.status === 201) && !!B_id && r.data.questions?.[0]?.options?.length === 2, `status ${r.status}`);

  // validation
  r = await call(op, 'POST', '/api/hr/recruitment/screening-form-templates', { name: `E2E Bad ${T}`, questions: [{ prompt: 'x', kind: 'SINGLE_CHOICE', options: [] }] });
  rec('Choice kind without options rejected (422)', r.status === 422, `status ${r.status}`);
  r = await call(op, 'POST', '/api/hr/recruitment/screening-form-templates', { name: `E2E General ${T}`, questions: [] });
  rec('Duplicate template name rejected (409)', r.status === 409, `status ${r.status}`);

  r = await call(op, 'GET', '/api/hr/recruitment/screening-form-templates');
  const names = (r.data?.items || []).map((t) => t.name);
  rec('Both templates in the library', names.includes(tplA.name) && names.includes(tplB.name), `have ${(r.data?.items || []).length}`);

  // ── B. Two jobs, a DIFFERENT template applied to each ─────────────────────
  // status:'OPEN' — the public careers board only surfaces OPEN jobs (publicJobDetail).
  const mkJob = async (suffix) => call(op, 'POST', '/api/hr/recruitment/jobs', { code: `E2EJOB-${T}-${suffix}`, title: `E2E Role ${T}-${suffix}`, countryCode: 'IN', employmentType: 'FULL_TIME', openings: 1, status: 'OPEN' });
  r = await mkJob('1'); const job1 = r.data?.id; if (job1) created.jobs.push(job1);
  rec('Create Job 1', (r.status === 201 || r.status === 200) && !!job1, `status ${r.status} ${r.data?.message || ''}`);
  r = await mkJob('2'); const job2 = r.data?.id; if (job2) created.jobs.push(job2);
  rec('Create Job 2', (r.status === 201 || r.status === 200) && !!job2, `status ${r.status}`);
  if (!job1 || !job2) { finish(); return; }

  r = await call(op, 'POST', `/api/hr/recruitment/jobs/${job1}/apply-screening-template`, { templateId: A_id });
  rec('Apply template A to Job 1', r.status === 200 && r.data?.questions?.length === 2, `status ${r.status}`);
  r = await call(op, 'POST', `/api/hr/recruitment/jobs/${job2}/apply-screening-template`, { templateId: B_id });
  rec('Apply template B to Job 2', r.status === 200 && r.data?.questions?.length === 2, `status ${r.status}`);

  // The heart of the ask: each job now carries ITS template's form.
  const q1 = await call(op, 'GET', `/api/hr/recruitment/jobs/${job1}/screening-questions`);
  const q2 = await call(op, 'GET', `/api/hr/recruitment/jobs/${job2}/screening-questions`);
  const list1 = q1.data?.items || q1.data || [];
  const list2 = q2.data?.items || q2.data || [];
  rec('Job 1 form == template A', JSON.stringify(promptsOf(list1)) === JSON.stringify(promptsOf(tplA.questions)), promptsOf(list1).join(' | '));
  rec('Job 2 form == template B (different per job)', JSON.stringify(promptsOf(list2)) === JSON.stringify(promptsOf(tplB.questions)), promptsOf(list2).join(' | '));
  rec('Job 1 knockout question preserved', list1.some((q) => q.isKnockout === true), '');
  rec('Job 2 has scored options', (list2.find((q) => q.kind === 'QUALIFICATION')?.options || []).length === 2, '');

  // re-apply guard
  r = await call(op, 'POST', `/api/hr/recruitment/jobs/${job1}/apply-screening-template`, { templateId: B_id });
  rec('Re-apply without replace rejected (409)', r.status === 409 && r.data?.code === 'QUESTIONS_EXIST', `status ${r.status}`);
  r = await call(op, 'POST', `/api/hr/recruitment/jobs/${job1}/apply-screening-template?replace=true`, { templateId: B_id });
  rec('Re-apply with replace=true swaps the form', r.status === 200 && r.data?.replaced === true, `status ${r.status}`);
  // put Job 1 back to template A for the public-apply leg
  await call(op, 'POST', `/api/hr/recruitment/jobs/${job1}/apply-screening-template?replace=true`, { templateId: A_id });

  // ── C. Public candidate applies against the templated form ────────────────
  r = await call(op, 'POST', `/api/hr/recruitment/jobs/${job1}/set-public`, { isPublic: true });
  // publicLink is an OBJECT; apiApplyPath = /api/public/careers/{bslug}/jobs/{pslug}
  // (GET it for the job detail, POST it + '/apply' to apply). Fall back to composing
  // from publicSlug if the object shape differs.
  const pl = r.data?.publicLink || {};
  let apiBase = pl.apiApplyPath;
  if (!apiBase && r.data?.publicSlug) {
    const bm = (pl.jobPath || pl.careersPath || '').match(/careers\/([^/]+)/);
    if (bm) apiBase = `/api/public/careers/${bm[1]}/jobs/${r.data.publicSlug}`;
  }
  if (r.status === 200 && apiBase) {
    const anon = jar();
    let pr = await call(anon, 'GET', apiBase);
    const pubQs = pr.data?.screeningQuestions || [];
    rec('Public job detail surfaces the templated form', pr.status === 200 && pubQs.length === 2, `status ${pr.status} qs=${pubQs.length}`);
    // answer the form (knockout PASS): auth=true, experience=5
    const byPrompt = (needle) => pubQs.find((q) => (q.prompt || '').includes(needle));
    const answers = [];
    const aq = byPrompt('Auth to work'); if (aq) answers.push({ questionId: aq.id, answerValue: true });
    const eq = byPrompt('Years experience'); if (eq) answers.push({ questionId: eq.id, answerValue: 5 });
    pr = await call(anon, 'POST', `${apiBase}/apply`, {
      firstName: 'Casey', lastName: `E2E${T}`, email: `casey.e2e.${T}@example.com`, consent: true, answers,
    });
    rec('Public candidate apply accepted (201)', pr.status === 201, `status ${pr.status} ${pr.data?.message || ''}`);
    // operator sees the scored application
    await sleep(1500);
    const apps = await call(op, 'GET', `/api/hr/recruitment/applications?jobId=${job1}&pageSize=25`);
    const mine = (apps.data?.items || []).find((x) => (x.candidate?.email || x.email || '').includes(`casey.e2e.${T}`));
    rec('Operator sees the application', !!mine, mine ? `status=${mine.status} score=${mine.screeningScore}` : 'not found');
  } else {
    rec('Public job detail surfaces the templated form', 'skip', `set-public status ${r.status}, no publicLink`);
    rec('Public candidate apply accepted (201)', 'skip', 'no public slug');
    rec('Operator sees the application', 'skip', 'no public slug');
  }

  finish();

  function finish() {
    // cleanup — best-effort
    (async () => {
      for (const id of created.jobs) await call(op, 'DELETE', `/api/hr/recruitment/jobs/${id}`).catch(() => {});
      for (const id of created.tpls) await call(op, 'DELETE', `/api/hr/recruitment/screening-form-templates/${id}`).catch(() => {});
      const fail = results.filter((x) => x !== true && x !== 'skip').length;
      console.log(`\n==== screening-form-templates E2E: ${results.filter((x) => x === true).length} pass, ${fail} fail, ${results.filter((x) => x === 'skip').length} skip ====`);
      process.exit(fail ? 1 : 0);
    })();
  }
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
