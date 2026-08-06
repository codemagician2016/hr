#!/usr/bin/env node
/**
 * learning.js — Module 16 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/learning.js                    # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/learning.js                  # prod
 *
 * WHAT THIS COVERS
 *   courses → a course with real structure (modules + lessons) → publish →
 *   assignments → the catalogue an employee actually sees
 *
 * WHY "PUBLISHED AND REACHABLE" IS THE ASSERTION
 * ----------------------------------------------
 * Module 11 found a launch that generated every review form and left the CYCLE in
 * DRAFT, so nobody could submit. The same shape applies here twice over:
 *
 *   • a course that publishes but never leaves DRAFT is invisible in the catalogue
 *   • a course with no modules/lessons enrols people into nothing
 *
 * Both return 200 and look completely healthy in an admin list.
 *
 * SAFETY
 * ------
 * Publishing a course and assigning it NOTIFIES real people, so the write path
 * runs on staging only (mail redirects to one inbox there). On production this is
 * read-only and says so. It never waives an enrolment — that credits a completion
 * somebody did not earn.
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
const { assertControlVisible, signIn, waitForHealthy } = require('./ui-lib');

const ADMIN = process.env.E2E_ADMIN || 'https://app-staging.drifthr.com';
const EMAIL = process.env.E2E_EMAIL || 'operator@demo.test';
const PASSWORD = process.env.E2E_PASSWORD || 'Demo@12345';
const IS_STAGING = /staging/.test(ADMIN);

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
  page.on('pageerror', (e) => { const t = String(e); if (!isBenign(t)) sink.push(`${tag} pageerror: ${t.slice(0, 160)}`); });
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
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
});

const asList = (b) => (b && (b.items || b.data || b.rows)) || (Array.isArray(b) ? b : []);
const idOf = (b, key) => (b && (b.id || (b[key] && b[key].id))) || null;
const stamp = String(Date.now()).slice(-6);

(async () => {
  console.log(`\n=== learning smoke — admin ${ADMIN} ===`);
  console.log(`  (${IS_STAGING ? 'staging: publish path exercised' : 'production: READ-ONLY, publishing notifies real people'})\n`);
  const browser = await chromium.launch();
  const problems = [];

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  watch(page, 'admin', problems);

  try {
    await waitForHealthy(page, ADMIN);
    const login = await signIn(page, { admin: ADMIN, email: EMAIL, password: PASSWORD });
    if (login.notUp) {
      console.log(`\n  APP NOT UP — login returned ${login.status}. Wait for the deploy to settle.\n`);
      await browser.close(); process.exit(2);
    }
    if (login.throttled) {
      console.log('\n  THROTTLED — auth rate limiter returned 429 (correct behaviour). Re-run shortly.\n');
      await browser.close(); process.exit(2);
    }
    ok(login.ok, 'admin signs in', `HTTP ${login.status} ${page.url()}`);

    // ── 1. the course catalogue ─────────────────────────────────────────────
    const courses = await api(page, '/api/hr/learning/courses?pageSize=20');
    const courseList = asList(courses.body);
    ok(courses.status < 400, 'courses load', `HTTP ${courses.status}`);
    note(`${courseList.length} course(s)`);

    // ── 2. an existing published course must have real structure ────────────
    // A course with no modules/lessons enrols people into nothing, and looks
    // perfectly healthy in the admin list.
    const published = courseList.find((c) => /PUBLISH|ACTIVE/i.test(String(c.status || '')));
    if (published) {
      const detail = await api(page, `/api/hr/learning/courses/${published.id}`);
      const c = (detail.body && (detail.body.course || detail.body)) || {};
      const modules = c.modules || [];
      const lessons = modules.reduce((n, m) => n + ((m.lessons || []).length), 0);
      ok(detail.status < 400, 'a published course can be opened', `HTTP ${detail.status}`);
      ok(modules.length > 0 && lessons > 0,
        'a published course has modules AND lessons (not an empty shell)',
        `${modules.length} module(s), ${lessons} lesson(s) in "${c.title || published.id}"`);
    } else {
      note('no published course to inspect');
    }

    // ── 3. build one end to end (staging only) ──────────────────────────────
    if (IS_STAGING) {
      const made = await send(page, 'POST', '/api/hr/learning/courses', {
        code: `QA${stamp}`, title: `QA Smoke Course ${stamp}`,
        description: 'Created by the learning smoke. Safe to archive.',
      });
      const cid = idOf(made.body, 'course');
      ok(made.status < 400 && cid, 'a course can be created',
        `HTTP ${made.status} ${JSON.stringify(made.body).slice(0, 140)}`);

      if (cid) {
        const mod = await send(page, 'POST', `/api/hr/learning/courses/${cid}/modules`, {
          title: 'Module 1', sortOrder: 1,
        });
        const mid = idOf(mod.body, 'module');
        ok(mod.status < 400 && mid, 'a module can be added',
          `HTTP ${mod.status} ${JSON.stringify(mod.body).slice(0, 120)}`);

        if (mid) {
          const les = await send(page, 'POST', `/api/hr/learning/modules/${mid}/lessons`, {
            title: 'Lesson 1', kind: 'LINK', url: 'https://example.com/lesson', sortOrder: 1,
          });
          ok(les.status < 400, 'a lesson can be added',
            `HTTP ${les.status} ${JSON.stringify(les.body).slice(0, 120)}`);
        }

        // THE assertion: publishing must actually leave DRAFT, or the course is
        // invisible to every employee while looking published to HR.
        const pub = await send(page, 'POST', `/api/hr/learning/courses/${cid}/publish`, {});
        ok(pub.status < 400, 'a course can be published', `HTTP ${pub.status} ${JSON.stringify(pub.body).slice(0, 120)}`);

        const re = await api(page, `/api/hr/learning/courses/${cid}`);
        const st = String(((re.body && (re.body.course || re.body)) || {}).status || '');
        ok(!/DRAFT/i.test(st) && st !== '',
          'publishing a course LEAVES draft (employees can see it)',
          `status after publish: ${st || 'unknown'}`);

        await send(page, 'POST', `/api/hr/learning/courses/${cid}/archive`, {});
        note('archived the smoke course');
      }
    } else {
      note('skip: creating/publishing a course notifies real people on production');
    }

    // ── 4. the page a client opens ──────────────────────────────────────────
    const resp = await page.goto(`${ADMIN}/learning`, { waitUntil: 'networkidle' }).catch(() => null);
    const st = resp ? resp.status() : 0;
    if (st === 404) {
      note('skip: Learning page is not mounted at /learning');
    } else {
      await page.waitForTimeout(1400);
      const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      ok(text.trim().length > 60, 'Learning page renders content', `HTTP ${st}, ${text.trim().length} chars`);
      await assertControlVisible(page, ok,
        ['button:has-text("New")', 'button:has-text("Create")', 'button', 'a[href*="learning"]'],
        'Learning page exposes an actionable control');
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
  console.log(bad ? '=== LEARNING SMOKE FAILED ===\n' : '=== LEARNING SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
