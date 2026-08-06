#!/usr/bin/env node
/**
 * onboarding.js — Module 3 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/onboarding.js                  # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/onboarding.js                # prod
 *
 * WHAT THIS COVERS
 * ----------------
 * The handoff that turns a hire into an employee. There is no "create journey"
 * endpoint — an onboarding journey exists ONLY because an offer was accepted — so
 * this drives the real chain:
 *
 *   job → candidate → application → offer → send → ACCEPT
 *        → journey seeded → tasks exist → complete a task → provision an Employee
 *
 * WHY IT ASSERTS THE JOURNEY, NOT JUST THE ACCEPT
 * -----------------------------------------------
 * Earlier today the first hire of every new tenant silently got NO onboarding.
 * acceptOffer returned 200, the offer went ACCEPTED and the application went
 * HIRED — while seedOnboardingJourney quietly returned null because the tenant had
 * no lifecycle template and nothing ever seeds one at signup. It surfaced only as
 * "we hired them and nothing happened".
 *
 * So a 200 from accept proves nothing here. This asserts the journey EXISTS, that
 * it has TASKS, and that an Employee can actually be provisioned from it.
 *
 * SAFETY
 * ------
 * Creates a stamped job/candidate and terminates the provisioned employee at the
 * end (there is no employee DELETE, by design — payroll history must survive).
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
const { assertControlVisible } = require('./ui-lib');

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

const stamp = String(Date.now()).slice(-6);
const today = new Date().toISOString().slice(0, 10);
const joinDate = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);

(async () => {
  console.log(`\n=== onboarding smoke — admin ${ADMIN} ===\n`);
  const browser = await chromium.launch();
  const problems = [];
  let jobId = null; let empId = null;

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  watch(page, 'admin', problems);

  try {
    await page.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
      page.click('button[type="submit"]'),
    ]);
    ok(!page.url().includes('/login'), 'admin signs in', page.url());

    // ── 1. lifecycle templates ──────────────────────────────────────────────
    // A tenant with no default ONBOARDING template silently produces no journey.
    // seed-defaults is a manual admin action nothing calls at signup, so assert a
    // usable default exists (or can be created) BEFORE relying on it downstream.
    let tpls = await api(page, '/api/hr/lifecycle/templates');
    let list = (tpls.body && (tpls.body.items || tpls.body)) || [];
    const onboardingDefault = (arr) => (Array.isArray(arr) ? arr : []).find(
      (t) => t.direction === 'ONBOARDING' && t.isDefault && t.isActive !== false);

    if (!onboardingDefault(list)) {
      note('no default ONBOARDING template — seeding defaults');
      const seeded = await send(page, 'POST', '/api/hr/lifecycle/templates/seed-defaults', {});
      ok(seeded.status < 400, 'seed-defaults creates the starter templates', `HTTP ${seeded.status}`);
      tpls = await api(page, '/api/hr/lifecycle/templates');
      list = (tpls.body && (tpls.body.items || tpls.body)) || [];
    }
    const tpl = onboardingDefault(list);
    ok(!!tpl, 'tenant has a default ONBOARDING template',
      `${Array.isArray(list) ? list.length : 0} template(s)`);
    if (tpl) {
      // A template with no task defs is as dead an end as no template at all.
      const full = await api(page, `/api/hr/lifecycle/templates/${tpl.id}`);
      const defs = (full.body && (full.body.taskDefs || (full.body.template && full.body.template.taskDefs))) || [];
      ok(defs.length > 0, 'the default template actually has task definitions',
        `${defs.length} task def(s)`);
    }

    // ── 2. drive a hire: job → candidate → application → offer → accept ─────
    const job = await send(page, 'POST', '/api/hr/recruitment/jobs', {
      code: `ONB-${stamp}`, title: `Onboarding Smoke ${stamp}`,
      countryCode: 'IN', employmentType: 'FULL_TIME', openings: 1,
    });
    ok(job.status < 400 && job.body && job.body.id, 'job created', `HTTP ${job.status}`);
    jobId = job.body && job.body.id;

    const cand = await send(page, 'POST', '/api/hr/recruitment/candidates', {
      firstName: 'Onboard', lastName: `Smoke${stamp}`, email: `onboard.smoke.${stamp}@example.com`,
    });
    ok(cand.status < 400 && cand.body && cand.body.id, 'candidate created', `HTTP ${cand.status}`);

    let appId = null;
    if (jobId && cand.body && cand.body.id) {
      const app = await send(page, 'POST', '/api/hr/recruitment/applications', {
        jobId, candidateId: cand.body.id,
      });
      ok(app.status < 400 && app.body && app.body.id, 'application created', `HTTP ${app.status}`);
      appId = app.body && app.body.id;
    }

    let offerId = null;
    if (appId) {
      const offer = await send(page, 'POST', '/api/hr/recruitment/offers', {
        applicationId: appId, currencyCode: 'INR',
        grossMonthly: 100000, basicMonthly: 50000, joiningDate: joinDate,
      });
      ok(offer.status < 400 && offer.body && offer.body.id, 'offer raised',
        `HTTP ${offer.status} ${JSON.stringify(offer.body).slice(0, 100)}`);
      offerId = offer.body && offer.body.id;
    }

    if (offerId) {
      const sent = await send(page, 'POST', `/api/hr/recruitment/offers/${offerId}/send`, {});
      ok(sent.status < 400, 'offer can be sent (DRAFT → SENT)', `HTTP ${sent.status}`);

      const acc = await send(page, 'POST', `/api/hr/recruitment/offers/${offerId}/accept`, {});
      ok(acc.status < 400, 'offer can be accepted', `HTTP ${acc.status} ${JSON.stringify(acc.body).slice(0, 100)}`);

      // ── 3. THE assertion: accepting must actually produce onboarding ──────
      // A 200 above is not enough. The bug fixed today returned 200 while
      // seedOnboardingJourney quietly did nothing, so the new starter had no
      // tasks, no pre-join link, and nobody knew.
      await page.waitForTimeout(1500);
      const journeys = await api(page, '/api/hr/onboarding/journeys?pageSize=50');
      const jList = (journeys.body && (journeys.body.items || journeys.body)) || [];
      const mine = (Array.isArray(jList) ? jList : []).find(
        (j) => j.offerId === offerId || (j.offer && j.offer.id === offerId));
      ok(!!mine, 'accepting an offer SEEDS an onboarding journey',
        `HTTP ${journeys.status}, ${Array.isArray(jList) ? jList.length : 0} journey(s), none for offer ${offerId}`);

      if (mine) {
        const detail = await api(page, `/api/hr/onboarding/journeys/${mine.id}`);
        const jr = (detail.body && (detail.body.journey || detail.body)) || {};
        const tasks = jr.tasks || (detail.body && detail.body.tasks) || [];
        ok(tasks.length > 0, 'the seeded journey has onboarding TASKS',
          `${tasks.length} task(s)`);

        // completing a task is the day-one action; it must stick
        if (tasks.length) {
          const t0 = tasks[0];
          const done = await send(page, 'POST', `/api/hr/onboarding/tasks/${t0.id}/complete`, {});
          ok(done.status < 400, 'an onboarding task can be completed', `HTTP ${done.status}`);
          const after = await api(page, `/api/hr/onboarding/journeys/${mine.id}`);
          const ajr = (after.body && (after.body.journey || after.body)) || {};
          const atasks = ajr.tasks || (after.body && after.body.tasks) || [];
          const t0after = atasks.find((x) => x.id === t0.id);
          ok(t0after && ['DONE', 'COMPLETED'].includes(t0after.status),
            'the completed task STAYS completed after a re-read',
            `status now ${t0after && t0after.status}`);
        }

        // ── 4. provision — the journey becomes a real Employee ─────────────
        const prov = await send(page, 'POST', `/api/hr/onboarding/journeys/${mine.id}/provision`, {});
        ok(prov.status < 400, 'journey can provision an Employee',
          `HTTP ${prov.status} ${JSON.stringify(prov.body).slice(0, 120)}`);
        empId = (prov.body && (prov.body.employeeId || (prov.body.employee && prov.body.employee.id))) || null;
        if (empId) {
          const emp = await api(page, `/api/hr/employees/${empId}`);
          ok(emp.status < 400, 'the provisioned employee is readable', `HTTP ${emp.status}`);
        }
      }
    }

    // ── 5. the page a client actually opens ─────────────────────────────────
    await page.goto(`${ADMIN}/onboarding`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText || '');
    ok(text.trim().length > 80, 'onboarding page renders content', `${text.trim().length} chars`);
    // A 200 page with no usable control is indistinguishable from a healthy
    // one to every check except a browser looking for the control itself.
    await assertControlVisible(page, ok, ['button:has-text("New")', 'a:has-text("New")', 'button:has-text("Start")', 'button', 'a[href*="onboarding"]'], 'Onboarding page exposes an actionable control');

    // ── 6. cleanup ──────────────────────────────────────────────────────────
    if (!KEEP) {
      if (empId) {
        const term = await send(page, 'POST', `/api/hr/employees/${empId}/terminate`, {
          terminationDate: today, reason: 'QA smoke cleanup',
        });
        note(`cleanup: terminated provisioned employee (HTTP ${term.status})`);
      }
      if (jobId) {
        const del = await api(page, `/api/hr/recruitment/jobs/${jobId}`, { method: 'DELETE' });
        note(`cleanup: deleted smoke job (HTTP ${del.status})`);
      }
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
  console.log(bad ? '=== ONBOARDING SMOKE FAILED ===\n' : '=== ONBOARDING SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
