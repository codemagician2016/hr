'use strict';
/* Phase 5b E2E on live staging: tenant-defined CUSTOM FIELDS on the Employee
 * entity. Covers the full loop: admin defines typed fields (TEXT/NUMBER/DATE/
 * SELECT/BOOLEAN) with ESS visibility+policy, admin writes per-employee values
 * (typed round-trip), value + definition validation (bad SELECT option, non-
 * numeric NUMBER, bad fieldType, empty SELECT options → 422), and the ESS side:
 * an employee sees only non-HIDDEN defs, can self-edit a SELF_EDIT field, and is
 * refused (403) on a READ_ONLY field. Cleanup: every sandbox definition archived
 * (soft-delete), verified gone from the active list.
 * 2 logins (HR Admin on app-staging + Priya ESS on m-demo-staging) → 26s
 * spacing, ~6min cooldown before a full rerun. fetch-retry harness. */
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
const defsOf = (r) => (r.data?.definitions || r.data?.items || (Array.isArray(r.data) ? r.data : []));
const fieldsOf = (r) => (r.data?.customFields || r.data?.fields || r.data?.items || (Array.isArray(r.data) ? r.data : []));
const idOf = (r) => (r.data?.definition?.id || r.data?.id);
const valFor = (arr, key) => { const f = (arr || []).find((x) => (x.definition?.key) === key); return f ? f.value : undefined; };
const created = [];

(async () => {
  const op = jar(); const priya = jar();
  const T = String(Date.now() % 100000);
  const K = (n) => `${n}_${T}`;                 // already-slug keys

  let r = await call(A, op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator (HR Admin) login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { email: cred('Priya').email, password: cred('Priya').password });
  rec('Priya ESS login', r.status === 200);

  // ── A. Define typed fields (all 5 types × the 3 ESS policies) ──────────────
  const mk = async (body) => { const rr = await call(A, op, 'POST', '/api/hr/custom-fields/definitions', body); const id = idOf(rr); if (id) created.push(id); return rr; };
  const kTshirt = K('tshirt'), kTier = K('tier'), kSeat = K('seat'), kDate = K('badge_date'), kRemote = K('is_remote');

  r = await mk({ entityType: 'EMPLOYEE', fieldType: 'TEXT', key: kTshirt, label: `Tshirt ${T}`, essVisible: true, essPolicy: 'SELF_EDIT', section: 'Sandbox', orderIndex: 1 });
  rec('Define TEXT (ESS self-edit)', (r.status === 201 || r.status === 200) && !!idOf(r), `status ${r.status} ${r.data?.message || r.data?.code || ''}`);
  r = await mk({ entityType: 'EMPLOYEE', fieldType: 'SELECT', key: kTier, label: `Tier ${T}`, options: [{ value: 'A', label: 'Tier A' }, { value: 'B', label: 'Tier B' }], essVisible: true, essPolicy: 'READ_ONLY', section: 'Sandbox', orderIndex: 2 });
  rec('Define SELECT (ESS read-only)', (r.status === 201 || r.status === 200) && !!idOf(r), `status ${r.status}`);
  r = await mk({ entityType: 'EMPLOYEE', fieldType: 'NUMBER', key: kSeat, label: `Seat ${T}`, essVisible: false, essPolicy: 'HIDDEN', section: 'Sandbox', orderIndex: 3 });
  rec('Define NUMBER (ESS hidden)', (r.status === 201 || r.status === 200) && !!idOf(r), `status ${r.status}`);
  r = await mk({ entityType: 'EMPLOYEE', fieldType: 'DATE', key: kDate, label: `Badge date ${T}`, section: 'Sandbox', orderIndex: 4 });
  rec('Define DATE', (r.status === 201 || r.status === 200) && !!idOf(r), `status ${r.status}`);
  r = await mk({ entityType: 'EMPLOYEE', fieldType: 'BOOLEAN', key: kRemote, label: `Remote ${T}`, section: 'Sandbox', orderIndex: 5 });
  rec('Define BOOLEAN', (r.status === 201 || r.status === 200) && !!idOf(r), `status ${r.status}`);

  // ── B. Definition-level validation ────────────────────────────────────────
  r = await call(A, op, 'POST', '/api/hr/custom-fields/definitions', { entityType: 'EMPLOYEE', fieldType: 'SELECT', key: K('bad_sel'), label: 'Bad select', options: [] });
  rec('Empty SELECT options rejected (422)', r.status === 422, `status ${r.status} ${r.data?.code || ''}`);
  r = await call(A, op, 'POST', '/api/hr/custom-fields/definitions', { entityType: 'EMPLOYEE', fieldType: 'BOGUS', key: K('bad_type'), label: 'Bad type' });
  rec('Bad fieldType rejected (422)', r.status === 422, `status ${r.status} ${r.data?.code || ''}`);

  // ── C. Definitions listed ─────────────────────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/custom-fields/definitions?entityType=EMPLOYEE');
  const keys = defsOf(r).map((d) => d.key);
  rec('New definitions appear in list', [kTshirt, kTier, kSeat, kDate, kRemote].every((k) => keys.includes(k)), `have ${defsOf(r).length}`);

  // ── D. Resolve Priya, write typed values ──────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/employees?q=Priya&pageSize=5');
  const priyaEmp = (r.data?.items || []).find((e) => (e.firstName || '').startsWith('Priya'));
  rec('Resolve Priya employee', !!priyaEmp?.id, priyaEmp?.id || 'not found');
  if (!priyaEmp?.id) { const fail = results.filter((x) => x !== true && x !== 'skip').length; console.log(`\n==== P5b custom-fields E2E: ${results.length - fail} pass, ${fail} fail (aborted) ====`); process.exit(1); }

  r = await call(A, op, 'PATCH', `/api/hr/employees/${priyaEmp.id}/custom-fields`, { values: { [kTshirt]: 'L', [kTier]: 'B', [kSeat]: 42, [kDate]: '2099-05-01', [kRemote]: true } });
  rec('Admin writes typed values', r.status === 200 || r.status === 201, `status ${r.status} ${r.data?.code || r.data?.message || ''}`);

  r = await call(A, op, 'GET', `/api/hr/employees/${priyaEmp.id}/custom-fields`);
  const vals = fieldsOf(r);
  rec('TEXT value round-trips', valFor(vals, kTshirt) === 'L', `got ${JSON.stringify(valFor(vals, kTshirt))}`);
  rec('SELECT value round-trips', valFor(vals, kTier) === 'B', `got ${JSON.stringify(valFor(vals, kTier))}`);
  rec('NUMBER value round-trips (typed)', valFor(vals, kSeat) === 42, `got ${JSON.stringify(valFor(vals, kSeat))}`);
  rec('BOOLEAN value round-trips (typed)', valFor(vals, kRemote) === true, `got ${JSON.stringify(valFor(vals, kRemote))}`);
  rec('DATE value round-trips', String(valFor(vals, kDate) || '').startsWith('2099-05-01'), `got ${JSON.stringify(valFor(vals, kDate))}`);

  // ── E. Value-level validation ─────────────────────────────────────────────
  r = await call(A, op, 'PATCH', `/api/hr/employees/${priyaEmp.id}/custom-fields`, { values: { [kTier]: 'ZZ' } });
  rec('Bad SELECT option rejected (422)', r.status === 422, `status ${r.status} ${r.data?.code || ''}`);
  r = await call(A, op, 'PATCH', `/api/hr/employees/${priyaEmp.id}/custom-fields`, { values: { [kSeat]: 'not-a-number' } });
  rec('Non-numeric NUMBER rejected (422)', r.status === 422, `status ${r.status} ${r.data?.code || ''}`);

  // ── F. ESS surface — visibility, self-edit, read-only refusal ─────────────
  r = await call(M, priya, 'GET', '/api/hr/me/custom-fields');
  const my = fieldsOf(r);
  const myKeys = my.map((f) => f.definition?.key);
  rec('ESS sees SELF_EDIT + READ_ONLY defs', myKeys.includes(kTshirt) && myKeys.includes(kTier), `keys ${myKeys.filter((k) => String(k).endsWith(T)).join(',')}`);
  rec('ESS does NOT see HIDDEN def', !myKeys.includes(kSeat), `hidden leaked? ${myKeys.includes(kSeat)}`);
  rec('ESS reads admin-set value', valFor(my, kTshirt) === 'L', `got ${JSON.stringify(valFor(my, kTshirt))}`);

  r = await call(M, priya, 'PATCH', '/api/hr/me/custom-fields', { values: { [kTshirt]: 'XL' } });
  rec('ESS self-edits SELF_EDIT field', r.status === 200 || r.status === 201, `status ${r.status} ${r.data?.code || ''}`);
  r = await call(M, priya, 'GET', '/api/hr/me/custom-fields');
  rec('ESS self-edit persisted', valFor(fieldsOf(r), kTshirt) === 'XL', `got ${JSON.stringify(valFor(fieldsOf(r), kTshirt))}`);

  r = await call(M, priya, 'PATCH', '/api/hr/me/custom-fields', { values: { [kTier]: 'A' } });
  rec('ESS refused on READ_ONLY field (403)', r.status === 403, `status ${r.status} ${r.data?.code || ''}`);

  // ── G. Cleanup — archive every sandbox definition ─────────────────────────
  let archived = 0;
  for (const id of created) { const rr = await call(A, op, 'DELETE', `/api/hr/custom-fields/definitions/${id}`); if (rr.status === 200 || rr.status === 204) archived++; }
  rec('Sandbox definitions archived', archived === created.length, `${archived}/${created.length}`);
  r = await call(A, op, 'GET', '/api/hr/custom-fields/definitions?entityType=EMPLOYEE');
  const stillThere = defsOf(r).map((d) => d.key).filter((k) => [kTshirt, kTier, kSeat, kDate, kRemote].includes(k));
  rec('Archived defs gone from active list', stillThere.length === 0, `lingering ${stillThere.length}`);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P5b custom-fields E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
