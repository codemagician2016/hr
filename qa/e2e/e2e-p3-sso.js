'use strict';
/* Phase 3 wave 4 E2E on live staging: SSO + SCIM. Covers: admin connection
 * CRUD (OIDC secrets write-only), public /sso/:tenant/status, SAML SP
 * metadata XML, OIDC login redirect (302 with state/PKCE params — uses a
 * public discovery-capable issuer URL: accounts.google.com), SCIM bearer auth
 * (401 without), discovery docs, live SCIM Users CRUD: create → Employee +
 * Customer appear → filter userName eq → PATCH active=false → identities off
 * → active=true → DELETE (soft). Cleanup: SCIM user deactivated, token
 * revoked, connection deleted. Ops: 26s between logins; ~6min cooldown. */
const A = require('./config').ADMIN;
const T_HOST = 'demo.staging.drifthr.com';
const pb = require('./config');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
async function call(j, method, path, { body, raw, headers, redirect } = {}) {
  const h = { 'X-Tenant-Host': T_HOST, ...(headers || {}) };
  if (j && j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(A + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: redirect || 'manual' });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (j && setC.length) {
    const pairs = setC.map((c) => c.split(';')[0].trim()).filter((p) => p.includes('='));
    const map = new Map((j.cookie ? j.cookie.split('; ') : []).map((p) => [p.split('=')[0], p]));
    for (const p of pairs) map.set(p.split('=')[0], p);
    j.cookie = [...map.values()].join('; ');
  }
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), ct: res.headers.get('content-type'), loc: res.headers.get('location') };
  let data = null; try { data = await res.json(); } catch (_e) {}
  return { status: res.status, data, loc: res.headers.get('location') };
}

(async () => {
  const op = jar();
  const T = 'SSO-' + (Date.now() % 1000);
  let r = await call(op, 'POST', '/api/auth/login', { body: { email: cred('HR Admin').email, password: cred('HR Admin').password } });
  rec('Operator login', r.status === 200);

  // ── A. connection CRUD (OIDC first — uses Google's public discovery) ──────
  r = await call(op, 'PUT', '/api/hr/sso/connection', { body: {
    protocol: 'OIDC', displayName: `${T} Corp SSO`, issuerUrl: 'https://accounts.google.com',
    clientId: 'e2e-client-id', clientSecret: 'e2e-secret-value', loginTarget: 'ESS',
    jitProvision: false, isActive: true,
  } });
  const conn = r.data?.connection;
  rec('OIDC connection saved', r.status === 200 && conn?.protocol === 'OIDC', `status ${r.status} ${r.data?.message || ''}`);
  rec('Secret write-only (hasClientSecret, never echoed)', conn?.hasClientSecret === true && !JSON.stringify(conn).includes('e2e-secret-value'), `has=${conn?.hasClientSecret}`);

  r = await call(op, 'POST', '/api/hr/sso/connection/test', {});
  rec('Connection test (Google discovery reachable)', r.status === 200, `status ${r.status} ${JSON.stringify(r.data || {}).slice(0, 80)}`);

  // ── B. public status + OIDC login redirect ────────────────────────────────
  r = await call(null, 'GET', '/sso/demo/status');
  rec('Public status shows configured OIDC', r.status === 200 && r.data?.configured === true && r.data?.protocol === 'OIDC', JSON.stringify(r.data || {}));
  const lg = await call(null, 'GET', '/sso/demo/login?target=ess', { raw: true });
  const locOk = lg.status === 302 && /accounts\.google\.com/.test(lg.loc || '') && /state=/.test(lg.loc || '') && /code_challenge=/.test(lg.loc || '');
  rec('OIDC login 302 with state+PKCE', locOk, `status ${lg.status} loc=${String(lg.loc || '').slice(0, 90)}`);

  // ── C. SAML: switch protocol, metadata XML ────────────────────────────────
  r = await call(op, 'PUT', '/api/hr/sso/connection', { body: {
    protocol: 'SAML', displayName: `${T} SAML`, idpEntityId: 'https://idp.example.com/metadata',
    idpSsoUrl: 'https://idp.example.com/sso', wantAssertionsSigned: true, loginTarget: 'ESS', isActive: true,
    idpCertPem: '-----BEGIN CERTIFICATE-----\nMIICqjCCAZICCQC6OUqnpvpJFDANBgkqhkiG9w0BAQsFADAXMRUwEwYDVQQDDAxl\nMmUtdGVzdC1pZHAwHhcNMjYwNzIyMjI1MTQ3WhcNMzYwNzE5MjI1MTQ3WjAXMRUw\nEwYDVQQDDAxlMmUtdGVzdC1pZHAwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK\nAoIBAQDCyC7b5AlvNtmnJzBwvLPIkZF7pVMpJqdXgKdbcP7q8i3wpHjdagfYxTzp\n3GpLka5amAB8hc4TWmzt6nmgbsPawVPGAVm1dFVhPJPN/KUrLvb1sCre4IczIzY1\nqyCTe4va9qDRnw+/xrsJO9DCfrxfK5zA2/uuHJeKHafHO631cGETkLr+kdQzQ4DV\nOh08sTw98LUAk8gv0Sw9gkvee9QZdq0UzJtSkyb0M2m0eg//KHJTNSindzwR6Qf3\negrSrCCwd8ysfroZDacgucwkRGyTeJB14luu7ON7a+iS1kx2xcnbk2FWhfviNtFP\nDMAoXISMOMMw53IWSRXO5uTObrJFAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAL4k\nDl8N0a1v0UURu6YBb8wW/2tBrqTSlX48DUhDk+jg1cKzBu1HxJOy3qxBtn7N9UqK\nJ+HkMOpO7RO2Xf3fFFckAgH6V7B9+NLSuhbDk8o4OKwW+ctGqjqlvUvi8UKkJuL5\nZYnSASoPB8zjMJAwDQO0eCN6IJcHfSPiNLBAm3dGgWXMiZ5X8TMcPx0aiol7PnHU\nQ4JMTvZxbzUvXrkQcOPx1xZgqK5ZzE+BNzIY4fDN0enr9BrjYeufL8lOEV2uZpqH\ntgOfcrFSKw/oefhZKqqhTQRo7JSW8m/qEj9GIhQ6NkOs2B3ES62btSj3QAyZIuyZ\nCG13G2kcrIFJ7CJGyWc=\n-----END CERTIFICATE-----',
  } });
  rec('SAML connection saved (valid X.509)', r.status === 200, `status ${r.status} ${String(r.data?.message || '').slice(0, 70)}`);
  if (r.status === 200) {
    const md = await call(null, 'GET', '/sso/demo/metadata', { raw: true });
    rec('SP metadata XML served', md.status === 200 && /xml/.test(md.ct || '') && md.buf.toString().includes('EntityDescriptor'), `ct=${md.ct}`);
  } else {
    rec('SP metadata XML served', false, 'SAML save failed unexpectedly');
  }

  // ── D. SCIM: token mint + bearer auth + discovery ─────────────────────────
  r = await call(op, 'POST', '/api/hr/sso/scim-tokens', { body: { name: `${T} azure` } });
  const rawToken = r.data?.token?.raw;
  rec('SCIM token minted (raw shown once)', r.status === 201 && !!rawToken, `last4=${r.data?.token?.last4}`);
  const scim = (method, path, body) => call(null, method, path, {
    body, headers: { Authorization: `Bearer ${rawToken}`, 'Content-Type': 'application/scim+json' },
  });
  r = await call(null, 'GET', '/scim/v2/ServiceProviderConfig');
  rec('SCIM without bearer → 401', r.status === 401);
  r = await scim('GET', '/scim/v2/ServiceProviderConfig');
  rec('ServiceProviderConfig serves', r.status === 200 && JSON.stringify(r.data).includes('ServiceProviderConfig'));

  // ── E. SCIM Users lifecycle ───────────────────────────────────────────────
  const uname = `${T.toLowerCase()}.scim@e2edemo.dev`;
  r = await scim('POST', '/scim/v2/Users', {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: uname, externalId: `ext-${T}`,
    name: { givenName: 'Scim', familyName: 'Probe' },
    emails: [{ value: uname, primary: true }],
    active: true,
  });
  const scimUser = r.data || {};
  rec('SCIM user created', r.status === 201 && !!scimUser.id, `status ${r.status} ${String(scimUser.detail || '').slice(0, 60)}`);

  // appears as an Employee + ESS Customer
  r = await call(op, 'GET', `/api/hr/employees?q=Probe&pageSize=10`);
  const emp = (r.data?.items || []).find((e) => (e.workEmail || '') === uname);
  rec('Employee materialized from SCIM', !!emp, emp && emp.code);

  r = await scim('GET', `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${uname}"`)}`);
  rec('Filter userName eq finds it', r.status === 200 && (r.data?.Resources || []).length === 1 && r.data.totalResults === 1, `total=${r.data?.totalResults}`);

  r = await scim('PATCH', `/scim/v2/Users/${scimUser.id}`, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'replace', path: 'active', value: false }],
  });
  rec('PATCH active=false', r.status === 200 && r.data?.active === false, `status ${r.status}`);
  r = await call(op, 'GET', `/api/hr/employees/${emp?.id}`);
  const empAfter = r.data?.employee || r.data;
  rec('Employee deactivated (both identities off)', empAfter?.isActive === false || empAfter?.status === 'INACTIVE', `isActive=${empAfter?.isActive} status=${empAfter?.status}`);

  r = await scim('PATCH', `/scim/v2/Users/${scimUser.id}`, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'replace', path: 'active', value: true }],
  });
  rec('PATCH active=true reactivates', r.status === 200 && r.data?.active === true);
  r = await scim('DELETE', `/scim/v2/Users/${scimUser.id}`);
  rec('DELETE = soft deprovision', r.status === 204 || r.status === 200, `status ${r.status}`);

  // ── cleanup ───────────────────────────────────────────────────────────────
  let cleaned = true;
  r = await call(op, 'GET', '/api/hr/sso/scim-tokens');
  for (const t of (r.data?.tokens || [])) {
    if ((t.name || '').includes(T)) {
      const d = await call(op, 'DELETE', `/api/hr/sso/scim-tokens/${t.id}`);
      if (d.status !== 200) cleaned = false;
    }
  }
  const dc = await call(op, 'DELETE', '/api/hr/sso/connection');
  if (dc.status !== 200) { cleaned = false; console.log('   conn delete:', dc.status, dc.data?.message); }
  r = await call(null, 'GET', '/sso/demo/status');
  rec('Cleanup (tokens revoked, connection gone, status unconfigured)', cleaned && r.data?.configured === false, `configured=${r.data?.configured}`);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P3 SSO/SCIM E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
