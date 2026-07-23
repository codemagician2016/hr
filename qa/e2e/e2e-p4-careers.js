'use strict';
/* Phase 4 workforce wave B E2E on live staging: Careers CMS. Covers: admin
 * get/upsert (HTML sanitized on write — <script> stripped), draft NOT on the
 * public board, publish → page appears (content only, no draft fields),
 * unpublish → page gone. Cleanup: unpublish + reset. Public board is unauth.
 * fetch-retry harness for the flaky staging uplink. */
const A = 'https://app-staging.drifthr.com';
const pb = require('/Users/kp/hr/qa/playbook.json');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchRetry(url, opts, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fetch(url, opts); } catch (e) { last = e; await sleep(1500 * (i + 1)); } }
  throw last;
}
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

(async () => {
  const op = jar();
  const T = 'CMS-' + (Date.now() % 100000);
  let r = await call(op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);

  // ── A. get (empty default) + upsert with a hostile script ─────────────────
  r = await call(op, 'GET', '/api/hr/recruitment/careers-page');
  rec('Careers page GET (empty default)', r.status === 200 && typeof r.data === 'object', JSON.stringify(r.data || {}).slice(0, 60));

  const headline = `${T} Join our team`;
  const about = `<p>We build great HR software.</p><script>alert('xss')</script><p onclick="evil()">Come work with us</p>`;
  r = await call(op, 'PUT', '/api/hr/recruitment/careers-page', {
    headline, subheadline: 'India-first HRMS', aboutHtml: about,
    cultureHtml: '<p>Ownership & kindness.</p>',
    customSections: [{ title: 'Benefits', bodyHtml: '<ul><li>Health cover</li></ul>', order: 0 }],
    socialLinks: { linkedin: 'https://linkedin.com/company/x', website: 'https://x.com', evil: 'javascript:alert(1)' },
    perks: [{ label: 'Remote-friendly' }, { label: 'Learning budget' }],
  });
  rec('Careers page upsert', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);

  r = await call(op, 'GET', '/api/hr/recruitment/careers-page');
  const saved = r.data?.page || r.data || {};
  const savedAbout = String(saved.aboutHtml || '');
  rec('HTML sanitized on write (script/on* stripped)', !/<script/i.test(savedAbout) && !/onclick/i.test(savedAbout) && /Come work with us/.test(savedAbout), savedAbout.slice(0, 70));
  rec('Content preserved after sanitize', saved.headline === headline && (saved.customSections || []).length === 1);

  // ── B. draft NOT on the public board ──────────────────────────────────────
  r = await call(null, 'GET', '/api/public/careers/demo');
  rec('Draft page hidden on public board (page:null)', r.status === 200 && (r.data?.page === null || r.data?.page === undefined), `page=${r.data?.page === null ? 'null' : typeof r.data?.page}`);

  // ── C. publish → page appears (content only) ──────────────────────────────
  r = await call(op, 'POST', '/api/hr/recruitment/careers-page/publish', {});
  rec('Publish', r.status === 200);
  r = await call(null, 'GET', '/api/public/careers/demo');
  const pubPage = r.data?.page || null;
  const raw = JSON.stringify(r.data || {});
  rec('Published page on public board', !!pubPage && pubPage.headline === headline && !/<script/i.test(JSON.stringify(pubPage)), `headline=${pubPage?.headline}`);
  rec('No draft-only fields leaked', !/isPublished|updatedByUserId|brandId/.test(raw), 'clean');

  // ── D. unpublish → gone ───────────────────────────────────────────────────
  r = await call(op, 'POST', '/api/hr/recruitment/careers-page/unpublish', {});
  rec('Unpublish', r.status === 200);
  r = await call(null, 'GET', '/api/public/careers/demo');
  rec('Unpublished page hidden again', r.data?.page === null || r.data?.page === undefined);

  // ── cleanup ───────────────────────────────────────────────────────────────
  const c = await call(op, 'PUT', '/api/hr/recruitment/careers-page', { headline: '', subheadline: '', aboutHtml: '', cultureHtml: '', customSections: [], socialLinks: {}, perks: [] });
  rec('Cleanup (page reset + unpublished)', c.status === 200);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P4 careers-CMS E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
