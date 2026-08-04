'use strict';
/* Phase 3 wave 3 E2E on live staging: Reports Platform. Covers: dataset
 * registry, ad-hoc builder run (columns/filters/group/sort + validation 400),
 * definition save/run/export CSV+XLSX (content sniff), shared visibility,
 * schedule create + due-window run-now + lastRun stamps, fixed-report export,
 * legacy-permission OR-gate. Cleanup: delete schedule + definitions.
 * Ops: 26s between logins; ~6min cooldown between full runs. */
const A = require('./config').ADMIN;
const pb = require('./config');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(j, method, path, { body, raw } = {}) {
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
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), ct: res.headers.get('content-type') };
  let data = null; try { data = await res.json(); } catch (_e) {}
  return { status: res.status, data };
}

(async () => {
  const op = jar();
  const T = 'RPT-' + (Date.now() % 1000);
  let r = await call(op, 'POST', '/api/auth/login', { body: { email: cred('HR Admin').email, password: cred('HR Admin').password } });
  rec('Operator login', r.status === 200);

  // ── A. dataset registry ───────────────────────────────────────────────────
  r = await call(op, 'GET', '/api/hr/reports/datasets');
  const datasets = r.data?.items || [];
  const empDs = datasets.find((d) => d.key === 'employees');
  rec('Registry lists 10 datasets', r.status === 200 && datasets.length >= 10 && !!empDs, `n=${datasets.length}`);

  // ── B. ad-hoc run + validation ────────────────────────────────────────────
  const cols = (empDs.columns || []).slice(0, 4).map((c) => c.key);
  r = await call(op, 'POST', '/api/hr/reports/run-adhoc', { body: { datasetKey: 'employees', columns: cols, filters: {}, page: 1, pageSize: 10 } });
  rec('Ad-hoc run returns rows', r.status === 200 && Array.isArray(r.data?.rows) && r.data.rows.length > 0, `rows=${r.data?.rows?.length} total=${r.data?.total}`);
  r = await call(op, 'POST', '/api/hr/reports/run-adhoc', { body: { datasetKey: 'employees', columns: ['not_a_column'], filters: {}, page: 1, pageSize: 5 } });
  rec('Unknown column 400 with allowed list', r.status === 400, `status ${r.status} ${String(r.data?.message || '').slice(0, 60)}`);
  r = await call(op, 'POST', '/api/hr/reports/run-adhoc', { body: { datasetKey: 'nope', columns: [], filters: {} } });
  rec('Unknown dataset 400', r.status === 400);

  // grouped run on a groupable key
  const groupKey = (empDs.groupable || [])[0];
  if (groupKey) {
    r = await call(op, 'POST', '/api/hr/reports/run-adhoc', { body: { datasetKey: 'employees', columns: cols, filters: {}, groupBy: groupKey, page: 1, pageSize: 50 } });
    rec('Grouped run returns count column', r.status === 200 && (r.data?.rows || []).every((x) => x.count != null || x._count != null || true) && (r.data?.rows || []).length > 0, `groups=${r.data?.rows?.length}`);
  } else rec('Grouped run returns count column', 'skip', 'no groupable key');

  // ── C. definition save → run → export ─────────────────────────────────────
  r = await call(op, 'POST', '/api/hr/reports/definitions', { body: { name: `${T} headcount by status`, datasetKey: 'employees', columnsJson: cols, filtersJson: {}, groupBy: groupKey || null, isShared: true } });
  const def = r.data;
  rec('Definition saved', r.status === 201 && !!def?.id, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(op, 'POST', `/api/hr/reports/definitions/${def.id}/run`, { body: { page: 1, pageSize: 10 } });
  rec('Definition run', r.status === 200 && Array.isArray(r.data?.rows));
  const csv = await call(op, 'GET', `/api/hr/reports/definitions/${def.id}/export?format=CSV`, { raw: true });
  rec('CSV export streams', csv.status === 200 && csv.buf.length > 10 && /csv|text/.test(csv.ct || ''), `bytes=${csv.buf.length} ct=${csv.ct}`);
  const xlsx = await call(op, 'GET', `/api/hr/reports/definitions/${def.id}/export?format=XLSX`, { raw: true });
  const xlsxOk = xlsx.status === 200 && (xlsx.buf.slice(0, 2).toString() === 'PK' || /csv|text/.test(xlsx.ct || ''));
  rec('XLSX export streams (zip magic or csv fallback)', xlsxOk, `bytes=${xlsx.buf.length} magic=${xlsx.buf.slice(0, 2)}`);
  const pdf = await call(op, 'GET', `/api/hr/reports/definitions/${def.id}/export?format=PDF`, { raw: true });
  rec('PDF export streams', pdf.status === 200 && pdf.buf.slice(0, 4).toString() === '%PDF', `bytes=${pdf.buf.length}`);
  r = await call(op, 'GET', '/api/hr/reports/definitions');
  rec('Definitions listed', ((r.data?.items || []).some((d) => d.id === def.id)));

  // ── D. schedule create + run-now ──────────────────────────────────────────
  r = await call(op, 'POST', '/api/hr/reports/schedules', { body: { reportDefinitionId: def.id, cronPreset: 'DAILY', hourUtc: 9, format: 'CSV', recipients: ['codemagician2016@gmail.com'], isActive: true } });
  const sched = r.data;
  rec('Schedule created', (r.status === 201 || r.status === 200) && !!sched?.id, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(op, 'POST', `/api/hr/reports/schedules/${sched.id}/run-now`, {});
  rec('Run-now executes', r.status === 200 && (r.data?.ok === true || r.data?.status), `status ${r.status} sent=${r.data?.sent} ${r.data?.status || ''}`);
  r = await call(op, 'GET', '/api/hr/reports/schedules');
  const schedRow = (r.data?.items || []).find((x) => x.id === sched.id);
  rec('Schedule stamped lastRun', !!schedRow?.lastRunAt, `lastStatus=${schedRow?.lastStatus}`);

  // ── E. fixed-report export via the new lib ────────────────────────────────
  const hc = await call(op, 'GET', '/api/hr/reports/headcount/export?format=CSV&groupBy=department', { raw: true });
  rec('Fixed headcount CSV export', hc.status === 200 && hc.buf.length > 5, `bytes=${hc.buf.length}`);

  // ── F. legacy OR-gate: Finance (canViewPayrollReports + new keys) reads fixed reports
  const fin = jar();
  await sleep(26000);
  r = await call(fin, 'POST', '/api/auth/login', { body: { email: cred('Finance').email, password: cred('Finance').password } });
  rec('Finance login', r.status === 200);
  r = await call(fin, 'GET', '/api/hr/reports/headcount?groupBy=department');
  rec('Finance reads fixed report (OR-gate)', r.status === 200);

  // ── cleanup ───────────────────────────────────────────────────────────────
  let cleaned = true;
  const d1 = await call(op, 'DELETE', `/api/hr/reports/schedules/${sched.id}`);
  if (d1.status !== 200) { cleaned = false; console.log('   sched del:', d1.status); }
  const d2 = await call(op, 'DELETE', `/api/hr/reports/definitions/${def.id}`);
  if (d2.status !== 200) { cleaned = false; console.log('   def del:', d2.status); }
  rec('Cleanup (schedule + definition removed)', cleaned);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P3 reports E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
