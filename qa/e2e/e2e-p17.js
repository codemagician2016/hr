'use strict';
/* Program P1.7 E2E on live staging: /meta vocabularies (operator + ESS),
 * restricted-holiday elections end-to-end (admin creates an RH → employee
 * elects → cap + duplicate guards → withdraw), RH allowance setting, entity
 * defaultPayoutBank/noticeDivisorDays PATCH, employee-number token preview,
 * compVisibility role roundtrip. Cleans up everything it creates. */
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
  let r = await call(A, op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { email: cred('Priya').email, password: cred('Priya').password });
  rec('Priya login', r.status === 200);

  // ── 1. /meta ──────────────────────────────────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/meta');
  rec('Operator /meta', r.status === 200 && r.data?.employmentTypes?.length === 8 && r.data?.payoutBanks?.includes('NEFT_RTGS'));
  r = await call(M, priya, 'GET', '/api/hr/me/meta');
  rec('ESS /me/meta', r.status === 200 && r.data?.genders?.includes('NON_BINARY') && r.data?.educationLevels?.includes('CERTIFICATION'));

  // ── 2. RH allowance setting ───────────────────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/attendance/rh-settings');
  const origAllowance = r.data?.allowance;
  rec('RH settings read', r.status === 200 && Number.isInteger(origAllowance), `allowance=${origAllowance}`);
  r = await call(A, op, 'PATCH', '/api/hr/attendance/rh-settings', { allowance: 1 });
  rec('RH allowance set to 1', r.status === 200 && r.data?.allowance === 1);
  r = await call(A, op, 'PATCH', '/api/hr/attendance/rh-settings', { allowance: 99 });
  rec('Allowance > 30 rejected', r.status === 400);

  // ── 3. RH elections end-to-end ────────────────────────────────────────────
  // Create two future restricted holidays (unique names for cleanup).
  const T = 'E2E-RH-' + (Date.now() % 1000);
  const year = new Date().getUTCFullYear();
  const mk = async (name, month, day) => call(A, op, 'POST', '/api/hr/attendance/holidays', {
    date: `${year + 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    name, type: 'RESTRICTED_OPTIONAL', isRestricted: true, isPaid: true, countryCode: 'IN',
  });
  let h1 = await mk(`${T} A`, 1, 14);
  let h2 = await mk(`${T} B`, 2, 14);
  const h1id = h1.data?.id, h2id = h2.data?.id;
  rec('Admin creates 2 restricted holidays (next year)', h1.status === 201 && h2.status === 201, `${h1.status}/${h2.status}`);

  r = await call(M, priya, 'GET', `/api/hr/me/attendance/restricted-holidays?year=${year + 1}`);
  const listed = r.data?.items || [];
  rec('ESS lists restricted holidays + allowance', r.status === 200 && r.data?.allowance === 1 && listed.some((h) => h.id === h1id) && listed.some((h) => h.id === h2id), `count=${listed.length}`);

  r = await call(M, priya, 'POST', '/api/hr/me/attendance/restricted-holidays', { holidayId: h1id });
  rec('Elect first RH', r.status === 201 && r.data?.used === 1);
  r = await call(M, priya, 'POST', '/api/hr/me/attendance/restricted-holidays', { holidayId: h1id });
  rec('Duplicate election 409', r.status === 409);
  r = await call(M, priya, 'POST', '/api/hr/me/attendance/restricted-holidays', { holidayId: h2id });
  rec('Quota (1) enforced 422', r.status === 422, r.data?.message);
  r = await call(M, priya, 'GET', `/api/hr/me/attendance/restricted-holidays?year=${year + 1}`);
  rec('Election reflected in list', (r.data?.items || []).find((h) => h.id === h1id)?.elected === true && r.data?.used === 1);
  r = await call(M, priya, 'DELETE', `/api/hr/me/attendance/restricted-holidays/${h1id}`);
  rec('Withdraw election', r.status === 204);

  // ── 4. Entity bank/notice defaults ────────────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/org/entities');
  const ent = (r.data?.items || r.data || [])[0];
  const entPatch = (body) => call(A, op, 'PATCH', `/api/hr/org/entities/${ent.id}`, body);
  r = await entPatch({ defaultPayoutBank: 'ICICI', noticeDivisorDays: 26 });
  rec('Entity bank+notice defaults saved', r.status === 200 && r.data?.defaultPayoutBank === 'ICICI' && r.data?.noticeDivisorDays === 26, `status ${r.status} ${r.data?.message || ''}`);
  r = await entPatch({ defaultPayoutBank: null, noticeDivisorDays: null });
  rec('Defaults cleared (cleanup)', r.status === 200 && !r.data?.defaultPayoutBank && !r.data?.noticeDivisorDays);

  // ── 5. Employee-number token preview ──────────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/company-profile/employee-number');
  const orig = r.data || {};
  rec('Emp-number scheme read', r.status === 200 && typeof orig.preview === 'string', `preview=${orig.preview}`);
  r = await call(A, op, 'PATCH', '/api/hr/company-profile/employee-number', { prefix: 'EMP-{ENTITY}-{YY}-' });
  const yy = String(year).slice(-2);
  rec('Token prefix preview expands', r.status === 200 && (r.data?.preview || '').startsWith(`EMP-ENT-${yy}-`), `preview=${r.data?.preview}`);
  r = await call(A, op, 'PATCH', '/api/hr/company-profile/employee-number', { prefix: orig.prefix });
  rec('Prefix restored (cleanup)', r.status === 200 && r.data?.prefix === orig.prefix);

  // ── 6. compVisibility role roundtrip ──────────────────────────────────────
  r = await call(A, op, 'POST', '/api/hr/rbac/roles', { name: `${T} viewer`, permissions: { canViewEmployees: true }, defaultScope: 'SELF', compVisibility: 'RANGE_ONLY' });
  const roleId = r.data?.id;
  rec('Role created with compVisibility', r.status === 201 && r.data?.compVisibility === 'RANGE_ONLY', `status ${r.status} ${r.data?.message || ''}`);
  if (roleId) {
    r = await call(A, op, 'PUT', `/api/hr/rbac/roles/${roleId}`, { compVisibility: 'NONE' });
    rec('compVisibility patched', r.status === 200 && r.data?.compVisibility === 'NONE');
    r = await call(A, op, 'DELETE', `/api/hr/rbac/roles/${roleId}`);
    rec('Role removed (cleanup)', r.status === 200 || r.status === 204, `status ${r.status}`);
  } else { rec('compVisibility patched', 'skip'); rec('Role removed (cleanup)', 'skip'); }

  // ── cleanup: RH settings + holidays ───────────────────────────────────────
  let cleaned = true;
  r = await call(A, op, 'PATCH', '/api/hr/attendance/rh-settings', { allowance: origAllowance });
  if (r.status !== 200) cleaned = false;
  for (const id of [h1id, h2id]) {
    if (!id) continue;
    const d = await call(A, op, 'DELETE', `/api/hr/attendance/holidays/${id}`);
    if (d.status !== 200 && d.status !== 204) cleaned = false;
  }
  rec('Cleanup (allowance restored + holidays removed)', cleaned);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P1.7 E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
