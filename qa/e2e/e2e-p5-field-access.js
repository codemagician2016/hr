'use strict';
/* Phase 5c E2E on live staging: field-level permissions. Proves the enforcement
 * end-to-end by restricting the ACTING operator's OWN role and observing the effect
 * on that same operator's employee reads/writes, then ALWAYS reverting (finally) so
 * the demo HR-Admin role never stays restricted.
 *
 * Covers: the field-group catalog; baseline (no map → no _fieldAccess, fields
 * present); set { bank:HIDDEN, identity:HIDDEN, personal:READ, custom:HIDDEN } on
 * the acting role → GET redacts bank/statutory/customFields + records _fieldAccess,
 * personal stays visible (READ); write-gate: personal PATCH → 403, ungoverned
 * (firstName) PATCH → 200, custom-field PATCH → 403, custom-field GET → []; revert
 * → _fieldAccess gone + personal writable again.
 * 1 login (HR Admin on app-staging). fetch-retry harness. */
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
const setMap = (op, roleId, map) => call(op, 'PUT', `/api/hr/field-access/roles/${roleId}`, { fieldAccess: map });

(async () => {
  const op = jar();
  let actingRoleId = null;
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator (HR Admin) login', r.status === 200);

  // ── A. Catalog + acting role ──────────────────────────────────────────────
  r = await call(op, 'GET', '/api/hr/field-access/roles');
  const groups = (r.data?.groups || []).map((g) => g.key);
  actingRoleId = r.data?.actingRoleId || null;
  rec('Field-group catalog present', ['personal', 'contact', 'identity', 'bank', 'custom'].every((k) => groups.includes(k)), `groups ${groups.join(',')}`);
  rec('Acting role resolved', !!actingRoleId, actingRoleId || 'null');
  if (!actingRoleId) { console.log('\n==== P5c field-access E2E: aborted (no acting role) ===='); process.exit(1); }

  try {
    // Ensure a clean baseline (a prior aborted run could have left a map).
    await setMap(op, actingRoleId, {});

    r = await call(op, 'GET', '/api/hr/employees?q=Priya&pageSize=5');
    const priya = (r.data?.items || []).find((e) => (e.firstName || '').startsWith('Priya'));
    rec('Resolve Priya employee', !!priya?.id, priya?.id || 'not found');
    if (!priya?.id) throw new Error('no subject');
    const eid = priya.id;

    // ── B. Baseline: no rules → no _fieldAccess, record loads ────────────────
    r = await call(op, 'GET', `/api/hr/employees/${eid}`);
    rec('Baseline employee GET ok', r.status === 200);
    rec('Baseline has NO _fieldAccess (fail-open identity)', r.data && r.data._fieldAccess === undefined, `_fieldAccess=${JSON.stringify(r.data?._fieldAccess)}`);
    const hadDob = r.data?.dateOfBirth !== undefined && r.data?.dateOfBirth !== null;

    // ── C. Restrict the acting role, observe read redaction ──────────────────
    r = await setMap(op, actingRoleId, { bank: 'HIDDEN', identity: 'HIDDEN', personal: 'READ', custom: 'HIDDEN' });
    rec('Set field-access on acting role', r.status === 200, `status ${r.status}`);

    r = await call(op, 'GET', `/api/hr/employees/${eid}`);
    const acc = r.data?._fieldAccess || {};
    rec('_fieldAccess reflects the rule', acc.bank === 'HIDDEN' && acc.personal === 'READ' && acc.identity === 'HIDDEN' && acc.custom === 'HIDDEN', JSON.stringify(acc));
    rec('HIDDEN bank omitted', Array.isArray(r.data?.bankAccounts) ? r.data.bankAccounts.length === 0 : (r.data?.bankAccounts == null), `bankAccounts=${JSON.stringify(r.data?.bankAccounts)}`);
    rec('HIDDEN identity nulled', r.data?.statutoryProfile == null, `statutoryProfile=${JSON.stringify(r.data?.statutoryProfile)}`);
    rec('HIDDEN custom emptied', Array.isArray(r.data?.customFields) && r.data.customFields.length === 0, `customFields len=${(r.data?.customFields || []).length}`);
    rec('READ personal stays visible', hadDob ? (r.data?.dateOfBirth != null) : true, `dob=${JSON.stringify(r.data?.dateOfBirth)}`);

    // ── D. Write-gate ────────────────────────────────────────────────────────
    r = await call(op, 'PATCH', `/api/hr/employees/${eid}`, { dateOfBirth: '1990-01-01' });
    rec('PATCH READ personal field refused (403)', r.status === 403 && r.data?.code === 'FIELD_WRITE_FORBIDDEN', `status ${r.status} ${r.data?.code || ''}`);
    r = await call(op, 'PATCH', `/api/hr/employees/${eid}`, { firstName: priya.firstName });
    rec('PATCH ungoverned field allowed (200)', r.status === 200, `status ${r.status}`);
    r = await call(op, 'PATCH', `/api/hr/employees/${eid}/custom-fields`, { values: { anything: 'x' } });
    rec('PATCH custom field refused (403)', r.status === 403 && r.data?.code === 'FIELD_WRITE_FORBIDDEN', `status ${r.status} ${r.data?.code || ''}`);
    r = await call(op, 'GET', `/api/hr/employees/${eid}/custom-fields`);
    rec('GET custom fields redacted to []', Array.isArray(r.data?.customFields) && r.data.customFields.length === 0, `len=${(r.data?.customFields || []).length}`);

    // ── E. Revert → full access restored ─────────────────────────────────────
    r = await setMap(op, actingRoleId, {});
    rec('Revert field-access to {}', r.status === 200, `status ${r.status}`);
    r = await call(op, 'GET', `/api/hr/employees/${eid}`);
    rec('_fieldAccess gone after revert', r.data && r.data._fieldAccess === undefined, `_fieldAccess=${JSON.stringify(r.data?._fieldAccess)}`);
    const curDob = r.data?.dateOfBirth;
    if (curDob) {
      // Echo the CURRENT DOB back (a no-op write) — proves the personal group is
      // writable again without altering demo data.
      r = await call(op, 'PATCH', `/api/hr/employees/${eid}`, { dateOfBirth: String(curDob).slice(0, 10) });
      rec('Personal field writable again (not 403)', r.status !== 403, `status ${r.status}`);
    } else {
      rec('Personal field writable again (not 403)', 'skip', 'no DOB to echo');
    }
  } finally {
    // ALWAYS clear the map so the demo role is never left restricted.
    if (actingRoleId) { try { await setMap(op, actingRoleId, {}); } catch (_e) {} }
  }

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P5c field-access E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
