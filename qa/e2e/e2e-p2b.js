'use strict';
/* Program Phase 2 Wave B E2E on live staging: SEPARATION FnF through the
 * engine (open-on-compute, supersede-on-recompute, SoD, engine-branch approve
 * → idempotent PayRun mint), plus OFFER/PAYRUN definition-level coverage.
 * FULL cleanup: FNF run cancelled, separation cancelled (employee → ACTIVE). */
const A = 'https://app-staging.drifthr.com';
const pb = require('/Users/kp/hr/qa/playbook.json');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(j, method, path, body) {
  const h = { 'X-Tenant-Host': 'demo.staging.drifthr.com' };
  if (j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(A + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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

(async () => {
  const op = jar(); const fin = jar();
  const T = 'P2B-' + (Date.now() % 1000);
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator (initiator) login', r.status === 200);
  await sleep(26000);
  r = await call(fin, 'POST', '/api/auth/login', { email: cred('Finance').email, password: cred('Finance').password });
  rec('Finance (checker) login', r.status === 200);

  // One separation per (employee, day) — rotate candidates so daily reruns work.
  let subject = null;
  for (const nm of ['Meera', 'Priya', 'Aarav', 'Anita']) {
    const q = await call(op, 'GET', `/api/hr/employees?q=${nm}&pageSize=5`);
    const emp = (q.data?.items || []).find((e) => (e.firstName || '').startsWith(nm) && e.status === 'ACTIVE');
    if (emp) { subject = emp; }
    if (!emp) continue;
    break;
  }
  rec('Subject employee resolved', !!subject?.id, subject && `${subject.firstName} ${subject.id}`);
  const meera = subject;

  const getReq = async (j, id) => {
    if (!id) return null;
    const rr = await call(j, 'GET', `/api/hr/approvals/${id}`);
    return rr.status === 200 ? (rr.data?.request || rr.data) : null;
  };

  // ── A. SEPARATION FnF through the engine ──────────────────────────────────
  let sepId = null; let fnfRunId = null;
  let initiated = null; let subjectUsed = meera;
  // Directory-wide rotation: one separation per (employee, UTC day) — earlier
  // same-day runs consume subjects, so scan until a 201.
  const dir = await call(op, 'GET', '/api/hr/employees?pageSize=50');
  const candidates = (dir.data?.items || []).filter((e) => e.status === 'ACTIVE');
  for (const emp of candidates) {
    const attempt = await call(op, 'POST', '/api/hr/separations', {
      employeeId: emp.id, type: 'RESIGNATION', reason: `${T} engine E2E`,
      lwd: '2099-06-30', resignationDate: '2099-05-01', noticeDate: '2099-05-01',
    });
    if (attempt.status === 201 || attempt.status === 200) { initiated = attempt; subjectUsed = emp; break; }
    console.log(`   initiate ${emp.firstName}: ${attempt.status} ${attempt.data?.message || ''}`);
    if (attempt.status !== 409) { initiated = attempt; subjectUsed = emp; break; } // real error — surface it
  }
  r = initiated || { status: 0, data: {} };
  const sep = r.data?.separation || r.data;
  sepId = sep?.id;
  meera.id = subjectUsed.id; // downstream (cleanup status check) follows the used subject
  rec('Separation initiated', (r.status === 201 || r.status === 200) && !!sepId, `status ${r.status} ${r.data?.message || ''} subject=${subjectUsed.firstName}`);

  // Clear all five clearance lanes (compute-fnf gates on them). HR Admin holds
  // it/admin/kt/assets; Finance (canApprovePayroll) owns the finance lane.
  let lanesOk = true;
  for (const lane of ['it', 'admin', 'knowledge_transfer', 'assets']) {
    const c = await call(op, 'PATCH', `/api/hr/separations/${sepId}/clearance`, { lane, status: 'CLEARED', note: `${T}` });
    if (c.status !== 200) { lanesOk = false; console.log(`   lane ${lane}:`, c.status, c.data?.message); }
  }
  {
    // Wave 2B product fix: the clearance route now admits canApprovePayroll —
    // the Finance checker clears their OWN lane directly.
    const c = await call(fin, 'PATCH', `/api/hr/separations/${sepId}/clearance`, { lane: 'finance', status: 'CLEARED', note: `${T}` });
    if (c.status !== 200) { lanesOk = false; console.log('   lane finance:', c.status, c.data?.message); }
  }
  rec('Clearance lanes cleared (incl. finance by its own persona)', lanesOk);

  r = await call(op, 'POST', `/api/hr/separations/${sepId}/compute-fnf`, {});
  const sep1 = r.data?.separation || {};
  rec('FnF computed', r.status === 200 && sep1.status === 'FNF_COMPUTED', `status ${r.status} ${r.data?.message || ''}`);
  const req1 = sep1.approvalRequestId ? await getReq(op, sep1.approvalRequestId) : null;
  // approvalRequestId is written AFTER compute's response row is loaded — re-read.
  r = await call(op, 'GET', `/api/hr/separations/${sepId}`);
  const sepRead = r.data?.separation || r.data;
  const reqId1 = sepRead?.approvalRequestId || sep1.approvalRequestId;
  const reqA = req1 || (await getReq(op, reqId1));
  rec('SEPARATION request opened on compute', !!reqA && reqA.module === 'SEPARATION' && ['PENDING', 'ESCALATED'].includes(reqA.status), `status=${reqA && reqA.status}`);

  // Recompute supersedes: prior request cancelled, new one opened.
  r = await call(op, 'POST', `/api/hr/separations/${sepId}/compute-fnf`, {});
  rec('FnF recomputed', r.status === 200);
  r = await call(op, 'GET', `/api/hr/separations/${sepId}`);
  const sepRead2 = r.data?.separation || r.data;
  const reqId2 = sepRead2?.approvalRequestId;
  const oldReq = await getReq(op, reqId1);
  const newReq = await getReq(op, reqId2);
  rec('Recompute superseded the request', reqId2 !== reqId1 && oldReq?.status === 'CANCELLED' && ['PENDING', 'ESCALATED'].includes(newReq?.status), `old=${oldReq && oldReq.status} new=${newReq && newReq.status}`);

  // SoD: the INITIATOR (HR Admin) cannot approve.
  r = await call(op, 'POST', `/api/hr/separations/${sepId}/approve-fnf`, {});
  rec('Initiator approve blocked (SoD 403)', r.status === 403, `status ${r.status}`);

  // Finance approves via the legacy route → engine branch → consumer mints.
  r = await call(fin, 'POST', `/api/hr/separations/${sepId}/approve-fnf`, {});
  const sepApproved = r.data?.separation || r.data;
  fnfRunId = sepApproved?.fnfPayRunId || r.data?.fnfPayRunId || null;
  rec('Checker approve → engine → FNF_APPROVED + PayRun minted', r.status === 200 && sepApproved?.status === 'FNF_APPROVED' && !!fnfRunId, `status ${r.status} run=${fnfRunId} ${r.data?.message || ''}`);
  const termReq = await getReq(op, reqId2);
  rec('SEPARATION request terminal APPROVED', termReq?.status === 'APPROVED', termReq && termReq.status);

  // Idempotency: a second approve on the already-approved case must 409.
  r = await call(fin, 'POST', `/api/hr/separations/${sepId}/approve-fnf`, {});
  rec('Second approve blocked (no double mint)', r.status === 409, `status ${r.status}`);

  // ── B. OFFER + PAYRUN definition-level coverage ───────────────────────────
  r = await call(op, 'POST', '/api/hr/approvals/workflows', { name: `${T} offer gate`, module: 'OFFER', priority: 50 });
  const wfOffer = r.data;
  rec('OFFER def created (designer handles new module)', r.status === 201, `status ${r.status}`);
  r = await call(op, 'PUT', `/api/hr/approvals/workflows/${wfOffer.id}/steps`, {
    steps: [{ stepOrder: 1, name: 'HR', approverType: 'HR', slaHours: 24, onTimeoutAction: 'ESCALATE' }],
  });
  rec('OFFER steps saved', r.status === 200);
  r = await call(op, 'DELETE', `/api/hr/approvals/workflows/${wfOffer.id}`);
  rec('OFFER def removed (default AUTO restored)', r.status === 200 || r.status === 204);
  r = await call(op, 'GET', '/api/hr/payroll/runs?pageSize=5');
  rec('Payroll runs list healthy (no regression)', r.status === 200);

  // ── cleanup ───────────────────────────────────────────────────────────────
  let cleaned = true;
  if (fnfRunId) {
    const c1 = await call(fin, 'POST', `/api/hr/payroll/runs/${fnfRunId}/cancel`, { reason: `${T} E2E cleanup` });
    if (c1.status !== 200) { cleaned = false; console.log('   fnf run cancel:', c1.status, c1.data?.message); }
  }
  if (sepId) {
    const c2 = await call(op, 'POST', `/api/hr/separations/${sepId}/cancel`, { reason: `${T} E2E cleanup` });
    if (c2.status !== 200) { cleaned = false; console.log('   separation cancel:', c2.status, c2.data?.message); }
  }
  r = await call(op, 'GET', `/api/hr/employees/${meera.id}`);
  const meeraAfter = r.data?.employee || r.data;
  rec('Cleanup (FNF run + separation cancelled, Meera ACTIVE)', cleaned && meeraAfter?.status === 'ACTIVE', `emp=${meeraAfter?.status}`);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== Phase 2B E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
