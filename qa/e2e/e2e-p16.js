'use strict';
/* Program P1.6 E2E on live staging: tenant notification template overrides
 * (list/upsert/validate/preview/reset) + ESS unified notification prefs.
 * Self-contained; resets everything it touches. */
const A = require('./config').ADMIN;
const M = require('./config').MOBILE;
const pb = require('./config');
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

  // ── A. template overrides ─────────────────────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/notifications/templates');
  const items = r.data?.items || [];
  const bday = items.find((t) => t.key === 'HR_BIRTHDAY');
  rec('Registry listed (HR vertical only)', r.status === 200 && items.length >= 15 && !!bday && !items.some((t) => t.key === 'OTP_VERIFICATION'), `count=${items.length}`);
  rec('Probation templates present (P1.4)', items.some((t) => t.key === 'HR_PROBATION_ENDING') && items.some((t) => t.key === 'HR_PROBATION_CONFIRMED'));

  const CUSTOM = 'Many happy returns {NAME}! With love from all of us at {BIZ}.';
  r = await call(A, op, 'PUT', '/api/hr/notifications/templates/HR_BIRTHDAY', { body: CUSTOM });
  rec('Override birthday body', r.status === 200 && r.data?.overridden === true);
  r = await call(A, op, 'GET', '/api/hr/notifications/templates');
  const bday2 = (r.data?.items || []).find((t) => t.key === 'HR_BIRTHDAY');
  rec('List reflects override', bday2?.overridden === true && bday2?.overrideBody === CUSTOM && bday2?.defaultBody !== CUSTOM);

  r = await call(A, op, 'PUT', '/api/hr/notifications/templates/HR_BIRTHDAY', { body: 'Hi {NAME} your OTP is {CODE}' });
  rec('Unknown token rejected with allowed list', r.status === 400 && /\{CODE\}/.test(r.data?.message || ''), r.data?.message);
  r = await call(A, op, 'PUT', '/api/hr/notifications/templates/NOT_A_KEY', { body: 'x' });
  rec('Unknown template key 404', r.status === 404);

  r = await call(A, op, 'POST', '/api/hr/notifications/templates/HR_BIRTHDAY/preview', { variables: { NAME: 'Priya', BIZ: 'DriftHR' } });
  rec('Preview renders the OVERRIDE body', r.status === 200 && r.data?.rendered === 'Many happy returns Priya! With love from all of us at DriftHR.', r.data?.rendered);

  r = await call(A, op, 'DELETE', '/api/hr/notifications/templates/HR_BIRTHDAY');
  rec('Reset override', r.status === 204);
  r = await call(A, op, 'GET', '/api/hr/notifications/templates');
  const bday3 = (r.data?.items || []).find((t) => t.key === 'HR_BIRTHDAY');
  rec('Back to stock body', bday3?.overridden === false && bday3?.overrideBody === null);

  // ── B. ESS unified notification prefs ─────────────────────────────────────
  r = await call(M, priya, 'GET', '/api/hr/me/engagement/notification-prefs');
  const before = r.data || {};
  rec('Prefs read', r.status === 200 && typeof before.announcementsOptOut === 'boolean' && typeof before.celebrationsOptOut === 'boolean', JSON.stringify(before));
  r = await call(M, priya, 'PATCH', '/api/hr/me/engagement/notification-prefs', { announcementsOptOut: !before.announcementsOptOut, celebrationsOptOut: !before.celebrationsOptOut });
  rec('Prefs flip', r.status === 200 && r.data?.announcementsOptOut === !before.announcementsOptOut && r.data?.celebrationsOptOut === !before.celebrationsOptOut);
  // Legacy celebrations endpoint must agree (same storage).
  r = await call(M, priya, 'GET', '/api/hr/me/engagement/celebrations/preferences');
  rec('Legacy celebrations endpoint agrees', r.status === 200 && r.data?.celebrationsOptOut === !before.celebrationsOptOut);
  r = await call(M, priya, 'PATCH', '/api/hr/me/engagement/notification-prefs', { announcementsOptOut: 'yes' });
  rec('Non-boolean rejected', r.status === 400);
  r = await call(M, priya, 'PATCH', '/api/hr/me/engagement/notification-prefs', { announcementsOptOut: before.announcementsOptOut === true, celebrationsOptOut: before.celebrationsOptOut === true });
  rec('Prefs restored (cleanup)', r.status === 200 && r.data?.announcementsOptOut === (before.announcementsOptOut === true));

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P1.6 E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
