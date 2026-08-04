'use strict';
/* Program Phase-1 Wave-A E2E on live staging: pay-calendar CRUD, payslip
 * settings (DOB password → encrypted PDF bytes), per-line payslip hold →
 * invisible to the employee → release, OT + late rule CRUD. Self-contained. */
const A = require('./config').ADMIN;
const M = require('./config').MOBILE;
const TENANT = 'demo.staging.drifthr.com';
const pb = require('./config');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(origin, j, method, path, { body, raw } = {}) {
  const h = { 'X-Tenant-Host': TENANT };
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
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  let data = null; try { data = await res.json(); } catch (_e) {}
  return { status: res.status, data };
}

(async () => {
  const op = jar(); const priya = jar();
  let r = await call(A, op, 'POST', '/api/auth/login', { body: { email: cred('HR Admin').email, password: cred('HR Admin').password } });
  rec('Operator login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { body: { email: cred('Priya').email, password: cred('Priya').password } });
  rec('Priya login', r.status === 200);

  // ── A. pay-calendar CRUD ──────────────────────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/org/entities');
  const ent = (r.data?.items || r.data || [])[0];
  const TAG = 'E2EWA' + (Date.now() % 100);
  r = await call(A, op, 'POST', '/api/hr/payroll/calendars', { body: { entityId: ent.id, code: TAG, name: 'E2E monthly', frequency: 'MONTHLY', payDayRule: 'FIXED_DOM', payDayValue: 28, cutoffDayRule: 'FIXED_DOM', cutoffDayValue: 21 } });
  const calId = r.data?.id;
  rec('Create pay calendar (FIXED_DOM 28 / cutoff 21)', r.status === 201 && !!calId, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'POST', '/api/hr/payroll/calendars', { body: { entityId: ent.id, code: TAG + 'W', name: 'weekly', frequency: 'WEEKLY', payDayRule: 'LAST_WORKING_DAY', cutoffDayRule: 'LAST_WORKING_DAY' } });
  rec('IN entity rejects WEEKLY (422)', r.status === 422, `status ${r.status}`);
  r = await call(A, op, 'PATCH', `/api/hr/payroll/calendars/${calId}`, { body: { payDayRule: 'N_DAYS_AFTER_PERIOD_END', payDayValue: 2 } });
  rec('Update pay-day rule', r.status === 200 && r.data?.payDayRule === 'N_DAYS_AFTER_PERIOD_END');
  r = await call(A, op, 'PATCH', `/api/hr/payroll/calendars/${calId}`, { body: { payDayRule: 'FIXED_DOM', payDayValue: 45 } });
  rec('Bad FIXED_DOM value rejected', r.status === 400);
  r = await call(A, op, 'GET', '/api/hr/payroll/calendars');
  rec('Calendars listed', (r.data?.items || []).some((c) => c.id === calId));
  r = await call(A, op, 'DELETE', `/api/hr/payroll/calendars/${calId}`);
  rec('Delete unused calendar (hard)', r.status === 200 && r.data?.deleted === true);

  // ── B. payslip settings + encrypted PDF + hold/release ────────────────────
  r = await call(A, op, 'GET', '/api/hr/payroll/payslip-settings');
  rec('Payslip settings read', r.status === 200, `mode=${r.data?.payslipPdfPassword}`);
  r = await call(A, op, 'PATCH', '/api/hr/payroll/payslip-settings', { body: { payslipPdfPassword: 'DOB' } });
  rec('Enable DOB password', r.status === 200 && r.data?.payslipPdfPassword === 'DOB');

  // Priya's payslips (from earlier E2E-verified data)
  r = await call(M, priya, 'GET', '/api/hr/me/payslips?pageSize=3');
  const slip = (r.data?.items || [])[0];
  if (!slip) { rec('Payslip exists for Priya', 'skip', 'none — PDF/hold checks skipped'); } else {
    const pdf = await call(M, priya, 'GET', `/api/hr/me/payslips/${slip.id}/pdf`, { raw: true });
    const body = pdf.buf.toString('latin1');
    rec('ESS payslip PDF renders with DOB mode on', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF');
    rec('PDF is ENCRYPTED (has /Encrypt)', body.includes('/Encrypt'), `bytes=${pdf.buf.length}`);

    // hold: need the payRunLineId + runId — operator reads the payslip detail.
    const det = await call(A, op, 'GET', `/api/hr/payroll/payslips/${slip.id}`).then((x) => x.data || {});
    const lineId = det.payRunLineId; const runId = det.payRunId;
    if (!lineId || !runId) { rec('Hold/release', 'skip', 'payslip detail lacks line/run ids'); } else {
      r = await call(A, op, 'POST', `/api/hr/payroll/runs/${runId}/lines/${lineId}/hold`, { body: { note: 'E2E hold' } });
      rec('Hold payslip line', r.status === 200 && r.data?.held === true, `status ${r.status}`);
      r = await call(M, priya, 'GET', '/api/hr/me/payslips?pageSize=10');
      rec('Held payslip INVISIBLE to employee', !(r.data?.items || []).some((s) => s.id === slip.id), `count=${r.data?.items?.length}`);
      const pdf2 = await call(M, priya, 'GET', `/api/hr/me/payslips/${slip.id}/pdf`, { raw: true });
      rec('Held payslip PDF → 404', pdf2.status === 404, `status ${pdf2.status}`);
      r = await call(A, op, 'POST', `/api/hr/payroll/runs/${runId}/lines/${lineId}/release`);
      rec('Release payslip line', r.status === 200 && r.data?.held === false);
      r = await call(M, priya, 'GET', '/api/hr/me/payslips?pageSize=10');
      rec('Released payslip visible again', (r.data?.items || []).some((s) => s.id === slip.id));
    }
  }
  r = await call(A, op, 'PATCH', '/api/hr/payroll/payslip-settings', { body: { payslipPdfPassword: 'NONE' } });
  rec('Password mode reset (cleanup)', r.status === 200);

  // ── C. OT + late rules CRUD ───────────────────────────────────────────────
  r = await call(A, op, 'POST', '/api/hr/attendance/overtime-rules', { body: { dailyThresholdMin: 540, weekdayMultiplier: 1.25, weeklyOffMultiplier: 2, holidayMultiplier: 2, roundingMin: 30 } });
  const otId = r.data?.id;
  rec('Create OT rule (tenant-wide, 540min @1.25x)', r.status === 201 && !!otId);
  r = await call(A, op, 'PATCH', `/api/hr/attendance/overtime-rules/${otId}`, { body: { weekdayMultiplier: 1.5 } });
  rec('Update OT multiplier', r.status === 200 && Number(r.data?.weekdayMultiplier) === 1.5);
  r = await call(A, op, 'POST', '/api/hr/attendance/overtime-rules', { body: { dailyThresholdMin: 2000 } });
  rec('Bad threshold rejected', r.status === 400);
  r = await call(A, op, 'POST', '/api/hr/attendance/late-rules', { body: { allowedLatesPerMonth: 3, perLates: 1, penaltyDayFraction: 0.5 } });
  const lateId = r.data?.id;
  rec('Create late rule (3 free, then 0.5/day)', r.status === 201 && !!lateId);
  r = await call(A, op, 'POST', '/api/hr/attendance/late-rules', { body: { penaltyDayFraction: 0.3 } });
  rec('Bad penalty fraction rejected', r.status === 400);
  r = await call(A, op, 'GET', '/api/hr/attendance/late-rules');
  rec('Late rules listed', (r.data?.items || []).some((x) => x.id === lateId));
  for (const [path, id] of [['overtime-rules', otId], ['late-rules', lateId]]) {
    await call(A, op, 'DELETE', `/api/hr/attendance/${path}/${id}`);
  }
  r = await call(A, op, 'GET', '/api/hr/attendance/overtime-rules');
  rec('Cleanup (rules deleted)', !(r.data?.items || []).some((x) => x.id === otId));

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== Wave A E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
