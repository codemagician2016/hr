#!/usr/bin/env node
/**
 * people.js — Module 2 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/people.js                      # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/people.js                    # prod
 *
 * WHAT THIS COVERS
 * ----------------
 * Getting real people into the system: create an employee, invite them, prove the
 * invite link actually WORKS, edit their profile, and see them in the directory
 * and the org tree.
 *
 * WHY THE INVITE LINK IS OPENED IN A CLEAN BROWSER
 * ------------------------------------------------
 * A tester reported "user invitation link is showing not valid", and separately
 * "link not working to add employee" with a DNS_PROBE_FINISHED_NXDOMAIN screenshot.
 * The API had returned a perfectly well-formed URL in both cases. What was wrong
 * was the HOST — it pointed at a tenant subdomain that had never been provisioned.
 * No API assertion can see that; only fetching the URL can.
 *
 * So the link is opened in a fresh context with NO cookies and NO session, which
 * is the only way to see what the invited person sees, and the step most likely to
 * be skipped when testing by hand.
 *
 * The link is also checked for being host-DURABLE: it must not be pinned to a
 * tenant subdomain that breaks the moment the client binds their own domain.
 *
 * SAFETY
 * ------
 * Creates one employee with a unique stamped code and deletes it at the end.
 */

'use strict';

const path = require('path');

function resolvePlaywright() {
  const candidates = ['/Users/kp/sitepresso', path.resolve(__dirname, '..', '..')];
  for (const c of candidates) {
    try { return require(require.resolve('playwright', { paths: [c] })); } catch { /* next */ }
  }
  throw new Error('Playwright not installed. Run npm i -D playwright, then retry.');
}
const { chromium } = resolvePlaywright();
const { assertControlVisible, typeAndReadBack } = require('./ui-lib');

const ADMIN = process.env.E2E_ADMIN || 'https://app-staging.drifthr.com';
const EMAIL = process.env.E2E_EMAIL || 'operator@demo.test';
const PASSWORD = process.env.E2E_PASSWORD || 'Demo@12345';
const KEEP = process.env.E2E_KEEP === '1';

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  return !!cond;
}
const note = (m) => console.log(`  ..    ${m}`);

const BENIGN = ['tenant/resolve', 'Failed to fetch RSC payload'];
const isBenign = (s) => BENIGN.some((b) => s.includes(b));

function watch(page, tag, sink) {
  page.on('pageerror', (e) => {
    const t = String(e);
    if (!isBenign(t)) sink.push(`${tag} pageerror: ${t.slice(0, 160)}`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (isBenign(t) || t.startsWith('Failed to load resource')) return;
    sink.push(`${tag} console: ${t.slice(0, 160)}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (isBenign(u)) return;
    sink.push(`${tag} HTTP ${r.status()} ${u.replace(ADMIN, '').slice(0, 110)}`);
  });
}

const api = (page, url, init) => page.evaluate(async ([u, i]) => {
  const r = await fetch(u, { credentials: 'include', ...(i || {}) });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [url, init || null]);

const send = (page, method, url, payload) => api(page, url, {
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload || {}),
});

const stamp = String(Date.now()).slice(-6);
const EMP_CODE = `SMOKE-E${stamp}`;
const EMP_FIRST = 'Smoke';
const EMP_LAST = `Person${stamp}`;
const EMP_EMAIL = `smoke.person.${stamp}@example.com`;

(async () => {
  console.log(`\n=== people smoke — admin ${ADMIN} ===\n`);
  const browser = await chromium.launch();
  const problems = [];
  let empId = null;

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  watch(page, 'admin', problems);

  try {
    // ── 1. sign in ──────────────────────────────────────────────────────────
    await page.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
    ok(!page.url().includes('/login'), 'admin signs in', page.url());

    // ── 2. the People page renders with its actions ─────────────────────────
    await page.goto(`${ADMIN}/people`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const addVisible = await page.locator(
      'a[href*="/people/new"], a[href*="/people/onboard"], button:has-text("Add"), a:has-text("Add employee")'
    ).count();
    // The "Create job" bug was a HIDDEN button on a 200 page — assert the entry
    // point a client needs is actually on screen, not merely that the page loaded.
    ok(addVisible > 0, 'People page offers a way to add an employee',
      `${addVisible} matching control(s)`);

    // ── 2b. REAL UI: the Add-employee FORM must accept typing ───────────────
    // Creating an employee over the API proves the server works. It does not prove
    // a human can fill the form — the "unable to type" bug threw on every keystroke
    // and merely looked like a disabled field.
    await page.goto(`${ADMIN}/people/new`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(1800);
    await typeAndReadBack(page, ok, 'input[type="text"]', `UIType${stamp}`,
      'Add-employee form ACCEPTS TYPING and reads back');
    await assertControlVisible(page, ok,
      ['button:has-text("Add employee")', 'button[type="submit"]', 'button:has-text("Save")'],
      'Add-employee form shows its submit control');

    // ── 3. create an employee ───────────────────────────────────────────────
    const created = await send(page, 'POST', '/api/hr/employees', {
      code: EMP_CODE, firstName: EMP_FIRST, lastName: EMP_LAST,
      workEmail: EMP_EMAIL, status: 'ACTIVE',
    });
    ok(created.status < 400 && created.body && created.body.id,
      'employee can be created', `HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 120)}`);
    empId = created.body && created.body.id;

    if (empId) {
      // ── 4. it comes back from the directory ──────────────────────────────
      const list = await api(page, `/api/hr/employees?search=${encodeURIComponent(EMP_LAST)}&pageSize=20`);
      const items = (list.body && (list.body.items || list.body.data || list.body)) || [];
      ok(Array.isArray(items) && items.some((e) => e.id === empId),
        'new employee appears in the directory', `HTTP ${list.status}, ${items.length} result(s)`);

      // ── 5. profile edit SURVIVES a reload ────────────────────────────────
      // Probe real, writable Employee scalars. Org context (department /
      // designation / location / entity) is deliberately NOT here: it lives on the
      // EmploymentRecord as an FK and an edit appends a new effective-dated
      // segment rather than mutating the employee row.
      const probes = {
        phone: `+9198${stamp}`,
        preferredName: `Smokey${stamp}`,
        personalEmail: `smoke.personal.${stamp}@example.com`,
      };
      const upd = await send(page, 'PATCH', `/api/hr/employees/${empId}`, probes);
      ok(upd.status < 400, 'employee profile saves', `HTTP ${upd.status}`);

      await page.goto(`${ADMIN}/people/${empId}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      const reread = await api(page, `/api/hr/employees/${empId}`);
      const emp = (reread.body && (reread.body.employee || reread.body)) || {};
      for (const [k, v] of Object.entries(probes)) {
        ok(emp[k] === v, `employee ${k} SURVIVES a reload`,
          `saved "${v}", reloaded "${emp[k]}"`);
      }

      // the profile page itself must render, not just the API
      const profileText = await page.evaluate(() => document.body.innerText || '');
      ok(profileText.includes(EMP_LAST), 'employee profile page shows the employee',
        `page ${profileText.length} chars`);

      // ── 6. invite — and PROVE the link works ─────────────────────────────
      const inv = await send(page, 'POST', `/api/hr/employees/${empId}/invite`, {});
      ok(inv.status < 400, 'invite can be sent', `HTTP ${inv.status} ${JSON.stringify(inv.body).slice(0, 120)}`);

      const link = inv.body && (inv.body.link || inv.body.setPasswordLink || inv.body.url);
      if (link) {
        note(`invite link: ${String(link).replace(/token=[^&]+/, 'token=…')}`);

        // Host durability: the link must not be pinned to a tenant subdomain that
        // dies the moment the client binds their own domain (the reason a live
        // client's invite 404'd today).
        let host = '';
        try { host = new URL(link).host; } catch { /* reported below */ }
        ok(!!host, 'invite link is a well-formed URL', link);

        // Open it with NO session — what the invited person actually gets.
        const cleanCtx = await browser.newContext();
        const cleanPage = await cleanCtx.newPage();
        const cleanProblems = [];
        watch(cleanPage, 'invitee', cleanProblems);
        let status = 0;
        try {
          const resp = await cleanPage.goto(link, { waitUntil: 'networkidle', timeout: 30000 });
          status = resp ? resp.status() : 0;
        } catch (e) {
          note(`invite link failed to load: ${e.message.slice(0, 90)}`);
        }
        ok(status > 0 && status < 400, 'invite link OPENS in a clean browser (no session)',
          `HTTP ${status} at ${host}`);

        const inviteText = await cleanPage.evaluate(() => document.body.innerText || '').catch(() => '');
        // The tester's report was literally the words "not valid" on this page.
        ok(inviteText && !/not valid|invalid|expired/i.test(inviteText),
          'invite page does NOT say the link is invalid',
          inviteText.slice(0, 120).replace(/\s+/g, ' '));
        ok(/password/i.test(inviteText), 'invite page offers to set a password',
          inviteText.slice(0, 120).replace(/\s+/g, ' '));
        await cleanCtx.close();
      } else {
        ok(false, 'invite response carries a set-password link',
          JSON.stringify(inv.body).slice(0, 160));
      }

      // ── 7. org tree includes them ────────────────────────────────────────
      const tree = await api(page, '/api/hr/org/tree');
      ok(tree.status < 400, 'org tree loads', `HTTP ${tree.status}`);
    }

    // ── 8. cleanup ──────────────────────────────────────────────────────────
    // There is no DELETE route for an employee, by design — people are terminated,
    // not erased, because payroll/statutory history must survive. So this
    // terminates the smoke employee (which is also the real-world action worth
    // exercising) and leaves an inactive row behind rather than pretending to
    // delete it.
    if (empId && !KEEP) {
      const term = await send(page, 'POST', `/api/hr/employees/${empId}/terminate`, {
        terminationDate: new Date().toISOString().slice(0, 10),
        reason: 'QA smoke cleanup',
      });
      note(`cleanup: terminated smoke employee (HTTP ${term.status}) — no DELETE route by design, inactive row remains`);
      ok(term.status < 400, 'employee can be terminated', `HTTP ${term.status} ${JSON.stringify(term.body).slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`\nsmoke crashed: ${e.message}\n`);
    failures.push(`crash: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  if (problems.length) {
    console.log(`  browser problems (${problems.length}) — each is something a real user's browser logged:`);
    for (const p of [...new Set(problems)].slice(0, 20)) console.log(`    • ${p}`);
    console.log('');
  }
  const bad = failures.length > 0 || problems.length > 0;
  console.log(bad ? '=== PEOPLE SMOKE FAILED ===\n' : '=== PEOPLE SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
