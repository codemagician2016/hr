'use strict';
/* Program Phase 2 Wave A E2E on live staging: six modules newly riding the
 * approval engine (LOAN, TIMESHEET, ATTENDANCE_REGULARIZATION, COMPENSATION,
 * ASSET auto, workflow-designer scoped defs). Verifies: submit opens a real
 * ApprovalRequest, legacy decide routes drive the engine, consumers carry the
 * domain effects (EMI schedule, punch materialize, supersession-reject),
 * AUTO-default assets stay 201-instant. Unique tags; cleanup of all removable
 * rows. */
const A = 'https://app-staging.drifthr.com';
const M = 'https://m-demo-staging.drifthr.com';
const pb = require('/Users/kp/hr/qa/playbook.json');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(origin, j, method, path, body) {
  const h = { 'X-Tenant-Host': 'demo.staging.drifthr.com' };
  if (j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(origin + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const op = jar(); const priya = jar();
  const T = 'P2A-' + (Date.now() % 1000);
  let r = await call(A, op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { email: cred('Priya').email, password: cred('Priya').password });
  rec('Priya login', r.status === 200);

  // Resolve Priya's employee id via the operator directory.
  r = await call(A, op, 'GET', '/api/hr/employees?q=Priya&pageSize=5');
  const priyaEmp = (r.data?.items || []).find((e) => (e.firstName || '').startsWith('Priya'));
  rec('Priya employee resolved', !!priyaEmp?.id, priyaEmp?.id);

  // Request rows are verified two ways: by id via GET /approvals/:id when the
  // domain row exposes approvalRequestId, and (for the rest) by a read-only DB
  // check AFTER this script (ids dumped to p2a-entities.json).
  const getReq = async (id) => {
    if (!id) return null;
    const rr = await call(A, op, 'GET', `/api/hr/approvals/${id}`);
    return rr.status === 200 ? (rr.data?.request || rr.data) : null;
  };
  const entityDump = {};

  // ── A. LOAN through the engine ────────────────────────────────────────────
  r = await call(A, op, 'POST', '/api/hr/loans', {
    employeeId: priyaEmp.id, loanType: 'LOAN', principal: 12000, tenureMonths: 6,
    interestRate: 0, startDate: '2099-01-01', reason: `${T} loan approve-path`,
  });
  const loan1 = r.data;
  rec('Loan created DRAFT', r.status === 201 && loan1?.status === 'DRAFT', `status ${r.status}`);
  r = await call(A, op, 'POST', `/api/hr/loans/${loan1.id}/submit`);
  rec('Loan submitted PENDING', r.status === 200 && r.data?.status === 'PENDING');
  entityDump.loan1 = loan1.id;
  r = await call(A, op, 'POST', `/api/hr/loans/${loan1.id}/approve`);
  rec('Legacy approve drives engine → APPROVED', r.status === 200 && r.data?.status === 'APPROVED');
  r = await call(A, op, 'GET', `/api/hr/loans/${loan1.id}/installments`);
  const insts = r.data?.items || r.data || [];
  rec('Consumer built EMI schedule (6 rows)', Array.isArray(insts) && insts.length === 6, `rows=${insts.length}`);


  // Reject path.
  r = await call(A, op, 'POST', '/api/hr/loans', {
    employeeId: priyaEmp.id, loanType: 'ADVANCE', principal: 3000, tenureMonths: 3,
    startDate: '2099-02-01', reason: `${T} loan reject-path`,
  });
  const loan2 = r.data;
  entityDump.loan2 = loan2.id;
  await call(A, op, 'POST', `/api/hr/loans/${loan2.id}/submit`);
  r = await call(A, op, 'POST', `/api/hr/loans/${loan2.id}/reject`, { reason: `${T} not eligible` });
  rec('Legacy reject drives engine → REJECTED + reason', r.status === 200 && r.data?.status === 'REJECTED' && (r.data?.rejectReason || '').includes(T), r.data?.rejectReason);

  // ── C. ATTENDANCE_REGULARIZATION through the engine ───────────────────────
  const regDay = (Date.now() % 25) + 1; // unique-ish per run, keeps reruns clean
  const regDate = `2099-04-${String(regDay).padStart(2, '0')}`;
  r = await call(M, priya, 'POST', '/api/hr/me/attendance/regularizations', {
    date: regDate, kind: 'MISSED_PUNCH',
    requestedInAt: `${regDate}T03:30:00.000Z`, requestedOutAt: `${regDate}T12:30:00.000Z`,
    reason: `${T} forgot to punch`,
  });
  const reg = r.data;
  rec('ESS regularization created', r.status === 201 && reg?.status === 'PENDING', `status ${r.status} ${r.data?.message || ''}`);
  entityDump.regularization = reg.id;
  let ar = await getReq(reg.approvalRequestId);
  rec('approvalRequestId = REAL request id (module matches)', !!ar && ar.module === 'ATTENDANCE_REGULARIZATION' && ['PENDING', 'ESCALATED'].includes(ar.status), `stored=${reg?.approvalRequestId} status=${ar && ar.status}`);
  r = await call(A, op, 'POST', `/api/hr/attendance/regularizations/${reg.id}/approve`);
  rec('Regularization approve via engine', r.status === 200 && r.data?.status === 'APPROVED');
  ar = await getReq(reg.approvalRequestId);
  rec('REG request terminal APPROVED', ar?.status === 'APPROVED', ar && ar.status);
  // Consumer materialized punches + recomputed the day: the day row should exist.
  r = await call(A, op, 'GET', `/api/hr/attendance/punches?employeeId=${priyaEmp.id}&from=${regDate}T00:00:00.000Z&to=${regDate}T23:59:59.000Z`);
  const punches = r.data?.items || r.data || [];
  rec('Punches materialized by consumer', Array.isArray(punches) && punches.length >= 2, `punches=${punches.length}`);


  // ── B'. TIMESHEET through the engine (uses the attendance row the approved
  // regularization just materialized — self-contained, unique period per run) ──
  r = await call(A, op, 'POST', '/api/hr/attendance/timesheets/generate', {
    employeeId: priyaEmp.id, periodStart: regDate, periodEnd: regDate,
  });
  rec('Timesheet generated', r.status === 200 || r.status === 201, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'GET', `/api/hr/attendance/timesheets?employeeId=${priyaEmp.id}&pageSize=100`);
  const sheets = r.data?.items || [];
  const sheet = sheets.find((sh) => String(sh.periodStart).startsWith(regDate));
  rec('Generated sheet found', !!sheet, sheet ? `status=${sheet.status}` : `none for ${regDate}`);
  if (sheet && sheet.status === 'DRAFT') {
    r = await call(A, op, 'POST', `/api/hr/attendance/timesheets/${sheet.id}/submit`);
    rec('Timesheet submitted', r.status === 200 && r.data?.status === 'SUBMITTED');
    entityDump.timesheet = sheet.id;
    r = await call(A, op, 'POST', `/api/hr/attendance/timesheets/${sheet.id}/approve`);
    rec('Timesheet approve via engine → APPROVED', r.status === 200 && r.data?.status === 'APPROVED' && !!r.data?.decidedAt);
  } else {
    rec('Timesheet submitted', 'skip', 'sheet unavailable');
    rec('Timesheet approve via engine → APPROVED', 'skip');
  }

  // ── D. COMPENSATION propose → engine reject ───────────────────────────────
  // (Approve needs a second operator for SoD; the reject leg proves the wiring.)
  r = await call(A, op, 'GET', '/api/hr/org/entities');
  const ent = (r.data?.items || r.data || [])[0];
  r = await call(A, op, 'POST', `/api/hr/compensation/employees/${priyaEmp.id}/revisions`, {
    entityId: ent.id, currencyCode: 'INR', basis: 'CTC', revisionReason: 'ANNUAL_REVISION',
    effectiveFrom: `2099-05-${String(regDay).padStart(2, '0')}`, ctcAnnual: 900000, propose: true,
    lines: [],
  });
  const rev = r.data;
  const revOk = r.status === 201 || r.status === 200;
  rec('Revision proposed', revOk && (rev?.status === 'PROPOSED' || rev?.revision?.status === 'PROPOSED'), `status ${r.status} ${r.data?.message || ''}`);
  const revId = rev?.id || rev?.revision?.id;
  if (revId) {
    entityDump.compensation = revId;
    r = await call(A, op, 'POST', `/api/hr/compensation/revisions/${revId}/reject`, { reason: `${T} self` });
    // The maker persona is stopped either by SoD (409) or by lacking the
    // checker permission entirely (403) — both prove the guard.
    rec('Maker cannot decide own proposal (403/409)', r.status === 409 || r.status === 403, `status ${r.status}`);
    // The checker persona decides — SoD-clean, and it must ride the engine.
    const fin = jar();
    await sleep(26000);
    r = await call(A, fin, 'POST', '/api/auth/login', { email: cred('Finance').email, password: cred('Finance').password });
    rec('Finance checker login', r.status === 200);
    r = await call(A, fin, 'POST', `/api/hr/compensation/revisions/${revId}/reject`, { reason: `${T} cleanup` });
    rec('Checker reject via engine → REJECTED', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
    // Sweep any 2099-dated PROPOSED strays from earlier runs (keeps demo clean).
    const q = await call(A, fin, 'GET', '/api/hr/compensation/revisions/proposed');
    const strayRows = Array.isArray(q.data?.items) ? q.data.items : (Array.isArray(q.data) ? q.data : []);
    for (const row of strayRows) {
      if (String(row.effectiveFrom || '').startsWith('2099-')) {
        await call(A, fin, 'POST', `/api/hr/compensation/revisions/${row.id}/reject`, { reason: 'E2E stray sweep' });
      }
    }
  } else { rec('Maker cannot decide own proposal (403/409)', 'skip', 'no revision id'); rec('Finance checker login', 'skip'); rec('Checker reject via engine → REJECTED', 'skip'); }

  // ── E. ASSET auto-approve keeps 201-instant assign ────────────────────────
  r = await call(A, op, 'POST', '/api/hr/assets', { code: `${T}-LT`, name: `${T} test laptop`, category: 'LAPTOP' });
  const asset = r.data;
  rec('Asset created', r.status === 201 && !!asset?.id, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'POST', '/api/hr/assets/assignments', { assetId: asset.id, employeeId: priyaEmp.id });
  const assignment = r.data;
  rec('Assign instant 201 (AUTO default)', r.status === 201 && assignment?.status === 'ASSIGNED', `status ${r.status}`);
  entityDump.asset = asset.id;
  r = await call(A, op, 'POST', `/api/hr/assets/assignments/${assignment.id}/return`, { conditionIn: 'GOOD' });
  rec('Asset returned', r.status === 200);

  // ── F. Scoped workflow designer APIs ──────────────────────────────────────
  r = await call(A, op, 'POST', '/api/hr/approvals/workflows', {
    name: `${T} scoped timesheet chain`, module: 'TIMESHEET', priority: 10,
    scopeJson: { departmentIds: ['non-existent-dept-e2e'] },
  });
  const wf = r.data;
  rec('Scoped draft def created', r.status === 201 && wf?.isPublished === false && wf?.priority === 10, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'PUT', `/api/hr/approvals/workflows/${wf.id}/steps`, {
    steps: [{ stepOrder: 1, name: 'HR', approverType: 'HR', slaHours: 24, onTimeoutAction: 'ESCALATE' }],
  });
  rec('Steps saved', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'POST', `/api/hr/approvals/workflows/${wf.id}/publish`);
  rec('Published', r.status === 200 && (r.data?.isPublished === true || r.data?.workflow?.isPublished === true));
  r = await call(A, op, 'GET', '/api/hr/approvals/workflows');
  const defs = (r.data?.items || r.data || []).filter((d) => d.module === 'TIMESHEET');
  rec('Listed with scope+priority', defs.some((d) => d.id === wf.id && d.scopeJson && d.priority === 10));
  r = await call(A, op, 'DELETE', `/api/hr/approvals/workflows/${wf.id}`);
  rec('Scoped def deleted', r.status === 200 || r.status === 204);

  // ── cleanup ───────────────────────────────────────────────────────────────
  let cleaned = true;
  // approved loan → cancel (drops installments); rejected loan stays (no delete path for non-DRAFT).
  r = await call(A, op, 'POST', `/api/hr/loans/${loan1.id}/cancel`);
  if (r.status !== 200) cleaned = false;
  const d1 = await call(A, op, 'DELETE', `/api/hr/assets/${asset.id}`);
  if (d1.status !== 200 && d1.status !== 204) cleaned = false;
  rec('Cleanup (loan cancelled, asset removed)', cleaned);

  require('fs').writeFileSync('/private/tmp/claude-501/-Users-kp-hr/0d9b27b0-3daf-4a9a-9a7e-88915be117af/scratchpad/p2a-entities.json', JSON.stringify(entityDump, null, 2));
  console.log('entity ids dumped for the DB-side request verification');
  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== Phase 2A E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
