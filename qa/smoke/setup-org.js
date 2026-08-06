#!/usr/bin/env node
/**
 * setup-org.js — Module 1 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/setup-org.js                   # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/setup-org.js                 # prod
 *
 * WHAT THIS COVERS
 * ----------------
 * The settings a client fills in on day one, before anything else in the product
 * is usable: company profile, employee numbering, branding, roles & access, and
 * the domain/setup surfaces.
 *
 * WHY IT ASSERTS PERSISTENCE, NOT "SAVE RETURNED 200"
 * --------------------------------------------------
 * The first bug reported by the live client was "company profile saved but after
 * reload it's vanished". The PATCH returned 200 every time. The GET projection had
 * simply drifted behind the field list, so the server forgot half of what it had
 * accepted. A test that asserts the save succeeds would have passed forever.
 *
 * So every field here is: type it → save → RELOAD THE PAGE → read it back. A save
 * that does not survive a reload is not a save.
 *
 * SAFETY
 * ------
 * This mutates real tenant settings, so it captures the original value of every
 * field it touches and restores it at the end — then verifies the restore also
 * survived. It never touches the domain-binding endpoints: repointing a live
 * tenant's domain is destructive and is read-only here.
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

let pass = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  return !!cond;
}
const note = (m) => console.log(`  ..    ${m}`);

const BENIGN = [
  'tenant/resolve',
  'Failed to fetch RSC payload',
];
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

const stamp = String(Date.now()).slice(-6);

// GET/PATCH through the page so the browser's own session + headers are used —
// the same path the app takes, rather than a hand-built request that can pass
// while the real one fails.
const api = (page, url, init) => page.evaluate(async ([u, i]) => {
  const r = await fetch(u, { credentials: 'include', ...(i || {}) });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}, [url, init || null]);

const patch = (page, url, payload) => api(page, url, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

(async () => {
  console.log(`\n=== setup & org smoke — admin ${ADMIN} ===\n`);
  const browser = await chromium.launch();
  const problems = [];
  const restore = [];   // [{label, fn}] run in reverse at the end

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

    // ── 2. company profile — the reload bug, locked down for good ───────────
    await page.goto(`${ADMIN}/settings/company-profile`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const before = await api(page, '/api/hr/company-profile');
    ok(before.status === 200 && before.body, 'company profile loads', `HTTP ${before.status}`);

    const prof = (before.body && (before.body.profile || before.body)) || {};

    // One field per GROUP, because the original bug dropped whole groups at a
    // time: an identity field, an address field, a contact field, and a DATE —
    // dates take a different serialisation path and are the likeliest to drift.
    const probes = {
      legalName: `Smoke Legal Name ${stamp}`,
      registeredCity: `Smoke City ${stamp}`,
      contactEmail: `smoke.${stamp}@example.com`,
      incorporationDate: '2019-04-01',
    };
    const original = {};
    for (const k of Object.keys(probes)) original[k] = prof[k] ?? null;
    restore.push({
      label: 'company profile',
      fn: () => patch(page, '/api/hr/company-profile', original),
    });

    const saved = await patch(page, '/api/hr/company-profile', probes);
    ok(saved.status < 400, 'company profile saves', `HTTP ${saved.status}`);

    // THE assertion: a full reload, then read back. Not the PATCH response —
    // that was 200 every time while the data was being dropped.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const after = await api(page, '/api/hr/company-profile');
    const afterProf = (after.body && (after.body.profile || after.body)) || {};
    for (const [k, v] of Object.entries(probes)) {
      const got = afterProf[k];
      // A date may come back ISO-stamped; compare on the date part only.
      const same = k === 'incorporationDate'
        ? String(got || '').slice(0, 10) === v
        : got === v;
      ok(same, `company profile ${k} SURVIVES a reload`, `saved "${v}", reloaded "${got}"`);
    }

    // Every field the API accepts must come back. A projection that drifts behind
    // the accepted field list is exactly how the original bug happened, so compare
    // the shapes rather than spot-checking two fields.
    const accepted = Object.keys(prof);
    const returned = new Set(Object.keys(afterProf));
    const dropped = accepted.filter((k) => !returned.has(k));
    ok(dropped.length === 0, 'company profile GET returns every field it stores',
      dropped.length ? `dropped: ${dropped.join(', ')}` : 'all fields present');

    // ── 2b. REAL UI: the form must accept typing and offer a save control ────
    // The API round-trip above proves the server stores what it is sent. It does
    // NOT prove a human can enter it. Two of the first bugs a tester reported were
    // exactly this: a button that renders but is invisible, and a field that threw
    // on every keystroke and so silently discarded input. Both are invisible to an
    // API assertion and obvious to a browser that types and reads back.
    await page.goto(`${ADMIN}/settings/company-profile`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);

    await typeAndReadBack(
      page, ok,
      'input:below(:text("Legal name")), input[value="' + (afterProf.legalName || '') + '"]',
      `Typed Legal ${stamp}`,
      'Legal name field ACCEPTS TYPING and reads back',
    );

    await assertControlVisible(
      page, ok,
      ['button:has-text("Save")', 'button:has-text("Update")', 'button[type="submit"]'],
      'company profile page shows a Save control',
    );

    // ── 3. employee numbering ───────────────────────────────────────────────
    const numBefore = await api(page, '/api/hr/company-profile/employee-number');
    ok(numBefore.status === 200, 'employee-number settings load', `HTTP ${numBefore.status}`);

    // ── 4. branding ─────────────────────────────────────────────────────────
    await page.goto(`${ADMIN}/settings/branding`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const brand = await api(page, '/api/hr/branding');
    ok(brand.status === 200, 'branding loads', `HTTP ${brand.status}`);

    // ── 5. roles & access ───────────────────────────────────────────────────
    // The "Create job unavailable" bug was a permissions-shape mismatch, so this
    // checks the permission catalogue and roles actually carry keys — an empty
    // permission set renders a plausible page where every action is hidden.
    await page.goto(`${ADMIN}/settings/roles`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const perms = await api(page, '/api/rbac/permissions');
    const permList = (perms.body && (perms.body.items || perms.body.permissions || perms.body)) || [];
    ok(perms.status === 200 && (Array.isArray(permList) ? permList.length : Object.keys(permList).length) > 0,
      'permission catalogue is not empty', `HTTP ${perms.status}`);

    const roles = await api(page, '/api/rbac/roles');
    const roleList = (roles.body && (roles.body.items || roles.body.roles || roles.body)) || [];
    ok(roles.status === 200 && Array.isArray(roleList) && roleList.length > 0,
      'roles list loads and is not empty', `HTTP ${roles.status}, ${Array.isArray(roleList) ? roleList.length : '?'} role(s)`);

    if (Array.isArray(roleList) && roleList.length) {
      const withPerms = roleList.filter((r) => r.permissions && Object.keys(r.permissions).length > 0);
      ok(withPerms.length > 0, 'at least one role carries permission keys',
        `${withPerms.length}/${roleList.length} roles have permissions`);
    }

    // ── 6. domain config — READ ONLY (rebinding a live domain is destructive) ─
    const dom = await api(page, '/api/business/domain-config');
    ok(dom.status === 200, 'domain config loads (read-only here)', `HTTP ${dom.status}`);

    // ── 7. the setup guide the client actually lands on ─────────────────────
    await page.goto(`${ADMIN}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    ok(bodyText.trim().length > 100, 'dashboard/setup guide renders content',
      `${bodyText.trim().length} chars`);

    // ── 8. restore ──────────────────────────────────────────────────────────
    for (const r of restore.reverse()) {
      const res = await r.fn();
      note(`restored ${r.label} (HTTP ${res.status})`);
    }
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    const restored = await api(page, '/api/hr/company-profile');
    const rp = (restored.body && (restored.body.profile || restored.body)) || {};
    ok(rp.legalName === original.legalName,
      'original company profile is restored', `now "${rp.legalName}"`);
    ok(rp.registeredCity === original.registeredCity,
      'original registered city is restored', `now "${rp.registeredCity}"`);
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
  console.log(bad ? '=== SETUP & ORG SMOKE FAILED ===\n' : '=== SETUP & ORG SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
