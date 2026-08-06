#!/usr/bin/env node
/**
 * hiring-smoke.js — drive the WHOLE talent-hiring journey in a real browser.
 *
 *   node qa/hiring-smoke.js                      # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *   E2E_TENANT=https://demo.drifthr.com \
 *     node qa/hiring-smoke.js                    # prod
 *
 * WHY THIS EXISTS
 * ---------------
 * Every hiring bug reported by a customer in one week was invisible to the
 * checks we had:
 *
 *   • "Create job not available"  — the API returned 200 all day. The PAGE hid
 *     its own button, because permissionsFromSession read the /api/auth/me
 *     wrapper instead of the user inside it.
 *   • "Unable to type in new job form" — builds clean, renders clean. The
 *     handler threw on the FIRST KEYSTROKE, so the field just looked disabled.
 *   • "Link not working" — the API happily returned a URL. Only DNS proved the
 *     host had never existed.
 *
 * All three are interface-contract mismatches: two sides of a boundary
 * disagreeing about a shape. `next build` cannot see them. A page load cannot
 * see them. Endpoint probing cannot see them. Only a browser doing what a person
 * does — click the button, TYPE in the field, open the link with no session.
 *
 * So this asserts three things a smoke test usually skips:
 *   1. It TYPES, and reads the value back. A field that silently discards input
 *      is the exact failure we shipped.
 *   2. It fails on ANY console error or pageerror. The typing bug threw a
 *      TypeError on every keypress and nothing was watching.
 *   3. It opens the candidate URL in a CLEAN context — no cookies, no session,
 *      no cached permissions. That is the only way to see what a candidate sees,
 *      and it is the step most likely to be skipped by hand.
 *
 * Exit code 0 = the journey works end to end. Non-zero = a real user would hit
 * something. Run it after every deploy.
 */

'use strict';

const path = require('path');

// Playwright lives in the sibling repo; browser-smoke.js resolves it the same way.
function resolvePlaywright() {
  const candidates = ['/Users/kp/sitepresso', path.resolve(__dirname, '..')];
  for (const c of candidates) {
    try { return require(require.resolve('playwright', { paths: [c] })); } catch { /* next */ }
  }
  throw new Error('Playwright not installed. Run npm i -D playwright, then retry.');
}
const { chromium } = resolvePlaywright();

const ADMIN = process.env.E2E_ADMIN || 'https://app-staging.drifthr.com';
const TENANT = process.env.E2E_TENANT || 'https://demo-staging.drifthr.com';
const EMAIL = process.env.E2E_EMAIL || 'operator@demo.test';
const PASSWORD = process.env.E2E_PASSWORD || 'Demo@12345';
const KEEP = process.env.E2E_KEEP === '1'; // skip cleanup for debugging

let pass = 0; const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { failures.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
  return !!cond;
}

// Console errors and failed responses are FAILURES, not noise. Anything a real
// user's browser would log, this run treats as a defect.
// Noise that is NOT a defect. Keeping this list short and justified matters: a
// smoke that reports things nobody will act on gets ignored, and then it catches
// nothing at all.
const BENIGN = [
  // The admin host has no tenant to resolve by hostname — 404 is the design.
  'tenant/resolve',
  // Next.js prefetches links on hover/viewport. When one loses the race with a
  // navigation (or the context closes) it logs this and, as the message itself
  // says, falls back to a normal navigation. The user sees nothing.
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
    if (isBenign(t)) return;
    // "Failed to load resource" carries no URL, so on its own it is unactionable.
    // The response listener below reports the same failure WITH the URL; keep
    // that one and drop this, rather than printing both halves of one event.
    if (t.startsWith('Failed to load resource')) return;
    sink.push(`${tag} console: ${t.slice(0, 160)}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (isBenign(u)) return;
    sink.push(`${tag} HTTP ${r.status()} ${u.replace(ADMIN, '').replace(TENANT, '').slice(0, 110)}`);
  });
}

const stamp = String(Date.now()).slice(-6);
const JOB_CODE = `SMOKE-${stamp}`;
const JOB_TITLE = `Smoke Test Engineer ${stamp}`;
const CAND_FIRST = 'Smoke';
const CAND_LAST = `Candidate${stamp}`;
const CAND_EMAIL = `smoke.candidate.${stamp}@example.com`;

(async () => {
  console.log(`\n=== hiring smoke — admin ${ADMIN} · tenant ${TENANT} ===\n`);
  const browser = await chromium.launch();
  const problems = [];
  let jobId = null;
  let publicUrl = null;

  // ── 1. admin session ──────────────────────────────────────────────────────
  const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await adminCtx.newPage();
  watch(page, 'admin', problems);

  await page.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  ok(!page.url().includes('/login'), 'admin signs in', page.url());

  // ── 2. the button a tenant OWNER was wrongly denied ───────────────────────
  await page.goto(`${ADMIN}/recruitment`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const newJobBtn = page.locator('button:has-text("New job")').first();
  const btnVisible = await newJobBtn.isVisible().catch(() => false);
  ok(btnVisible, 'Recruitment shows "New job" (permission gate resolves)',
    btnVisible ? '' : 'hidden — permissionsFromSession regression?');

  if (btnVisible) {
    await newJobBtn.click();
    await page.waitForTimeout(1000);

    // ── 3. TYPE. The bug we shipped discarded every keystroke silently. ─────
    const codeInput = page.locator('input[type="text"]').first();
    await codeInput.click();
    await codeInput.type(JOB_CODE, { delay: 25 });
    const codeBack = await codeInput.inputValue();
    ok(codeBack === JOB_CODE, 'Job code accepts typing and reads back',
      `typed "${JOB_CODE}" got "${codeBack}"`);

    const titleInput = page.locator('input[type="text"]').nth(1);
    await titleInput.click();
    await titleInput.type(JOB_TITLE, { delay: 25 });
    const titleBack = await titleInput.inputValue();
    ok(titleBack === JOB_TITLE, 'Title accepts typing and reads back',
      `typed "${JOB_TITLE}" got "${titleBack}"`);

    const desc = page.locator('textarea').first();
    if (await desc.isVisible().catch(() => false)) {
      await desc.click();
      await desc.type('Created by the hiring smoke test.', { delay: 10 });
      ok((await desc.inputValue()).length > 0, 'Description accepts typing');
    }

    // Publish to the public careers board so the candidate half is reachable.
    const publicToggle = page.locator('input[type="checkbox"]').first();
    if (await publicToggle.isVisible().catch(() => false)) {
      await publicToggle.check().catch(() => {});
      ok(await publicToggle.isChecked().catch(() => false), 'Post-to-careers toggles on');
    }

    await page.click('button:has-text("Create job")');
    await page.waitForTimeout(3000);
    const created = !(await page.locator('button:has-text("Create job")').isVisible().catch(() => false));
    ok(created, 'Create job submits and the dialog closes');
  }

  // ── 4. the job exists server-side, with a usable public link ──────────────
  const listed = await page.evaluate(async () => {
    const r = await fetch('/api/hr/recruitment/jobs?pageSize=50', { credentials: 'include' });
    return r.ok ? r.json() : null;
  });
  const items = (listed && (listed.items || listed.jobs || listed)) || [];
  const mine = Array.isArray(items) ? items.find((j) => j.code === JOB_CODE) : null;
  ok(!!mine, 'created job is listed by the API', mine ? '' : `no job with code ${JOB_CODE}`);

  if (mine) {
    jobId = mine.id;

    // A job is created DRAFT (schema default) and only resolves on the public
    // board once it is OPEN *and* isPublic — see publicCareersLink's `live`.
    // Skipping this made the candidate step 404 and look like a product bug; it
    // was the test forgetting to publish. Assert the transition rather than
    // assuming it, so a broken publish route fails HERE with a clear label.
    const published = await page.evaluate(async (id) => {
      const r = await fetch(`/api/hr/recruitment/jobs/${id}/publish`, { method: 'POST', credentials: 'include' });
      return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
    }, jobId);
    ok(published.status < 400, 'job publishes (DRAFT → OPEN)', `HTTP ${published.status}`);
    ok(published.body && published.body.status === 'OPEN',
      'published job reports status OPEN', published.body && published.body.status);

    const share = await page.evaluate(async (id) => {
      const r = await fetch(`/api/hr/recruitment/jobs/${id}/share`, { credentials: 'include' });
      return r.ok ? r.json() : { error: r.status };
    }, jobId);
    const link = share && share.publicLink;
    publicUrl = link && link.url;
    ok(!!publicUrl, 'share endpoint returns an absolute public URL', JSON.stringify(share).slice(0, 140));
    // The apply path must point at the PUBLIC careers router and end in /apply —
    // it previously aimed at a sibling module, and its test omitted /apply.
    ok(!!link && typeof link.apiApplyPath === 'string'
       && link.apiApplyPath.startsWith('/api/public/careers/')
       && link.apiApplyPath.endsWith('/apply'),
      'apply path targets /api/public/careers/…/apply',
      link && link.apiApplyPath);
  }

  // ── 5. THE CANDIDATE VIEW — clean context, no session, no cached perms ────
  if (publicUrl) {
    const candCtx = await browser.newContext();
    const cand = await candCtx.newPage();
    const candProblems = [];
    watch(cand, 'candidate', candProblems);

    let reached = true;
    const resp = await cand.goto(publicUrl, { waitUntil: 'networkidle', timeout: 30000 })
      .catch((e) => { reached = false; problems.push(`candidate could not reach ${publicUrl}: ${e.message.slice(0, 90)}`); return null; });

    ok(reached && resp && resp.status() < 400,
      'candidate can open the shared job link with NO session',
      reached ? `HTTP ${resp && resp.status()}` : 'host unreachable (DNS?)');

    if (reached) {
      await cand.waitForTimeout(2500);
      const body = await cand.innerText('body').catch(() => '');
      ok(body.length > 40 && !/this site can.?t be reached/i.test(body),
        'job page renders content to the candidate', body.slice(0, 60).replace(/\n/g, ' '));
      // The apply form is the point of the page.
      const hasApply = await cand.locator('input[type="email"], button:has-text("Apply"), form').first()
        .isVisible().catch(() => false);
      ok(hasApply, 'apply form is present on the public job page');

      // ── the candidate actually APPLIES ──────────────────────────────────
      // The half of hiring that only a candidate exercises. Everything above
      // this line can pass while applying is broken.
      if (hasApply) {
        const textBoxes = cand.locator('form input.ipt, input.ipt');
        const nCand = await textBoxes.count().catch(() => 0);
        if (nCand >= 3) {
          await textBoxes.nth(0).fill(CAND_FIRST);
          await textBoxes.nth(1).fill(CAND_LAST);
          await textBoxes.nth(2).fill(CAND_EMAIL);
          const backFirst = await textBoxes.nth(0).inputValue();
          ok(backFirst === CAND_FIRST, 'candidate name field accepts typing', `got "${backFirst}"`);
        } else {
          ok(false, 'candidate detail fields present', `found ${nCand} inputs`);
        }

        // Consent is required server-side; an unticked box is a 400.
        const consent = cand.locator('input[type="checkbox"]').last();
        if (await consent.isVisible().catch(() => false)) {
          await consent.check().catch(() => {});
          ok(await consent.isChecked().catch(() => false), 'consent checkbox ticks');
        }

        const submit = cand.locator('button[type="submit"], button:has-text("Apply")').last();
        await submit.click().catch(() => {});
        await cand.waitForTimeout(4000);
        const after = await cand.innerText('body').catch(() => '');
        const accepted = /thank you|received|we.ll be in touch|application/i.test(after);
        ok(accepted, 'application submits and the candidate sees a confirmation',
          after.slice(0, 90).replace(/\n/g, ' '));
      }
    }
    problems.push(...candProblems);
    await candCtx.close();
  } else {
    ok(false, 'candidate journey reachable (skipped — no public URL)');
  }

  // ── 6. the ATS side: did the application actually arrive, and can it move? ─
  // A candidate seeing "thank you" proves nothing if the application never
  // reaches the recruiter. This is the seam between the public and internal
  // halves of hiring, and nothing else in the suite crosses it.
  if (jobId) {
    await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
    const apps = await page.evaluate(async (id) => {
      const r = await fetch(`/api/hr/recruitment/applications?jobId=${id}&pageSize=50`, { credentials: 'include' });
      return r.ok ? r.json() : { error: r.status };
    }, jobId);
    const list = (apps && (apps.items || apps.applications || apps)) || [];
    const mineApp = Array.isArray(list)
      ? list.find((a) => JSON.stringify(a).includes(CAND_EMAIL) || JSON.stringify(a).includes(CAND_LAST))
      : null;
    ok(!!mineApp, 'application reaches the recruiter pipeline',
      mineApp ? '' : `not found for ${CAND_EMAIL} — ${JSON.stringify(apps).slice(0, 120)}`);

    if (mineApp) {
      // Stages come from the job; moving one is the recruiter's core action.
      const stages = await page.evaluate(async (id) => {
        const r = await fetch(`/api/hr/recruitment/jobs/${id}`, { credentials: 'include' });
        const j = r.ok ? await r.json() : null;
        return (j && j.stages) || [];
      }, jobId);
      ok(stages.length > 0, 'job has a pipeline of stages', `${stages.length} stages`);

      const target = stages.find((s2) => s2.kind === 'SCREENING') || stages[1] || stages[0];
      if (target) {
        const moved = await page.evaluate(async ([appId, stageId]) => {
          const r = await fetch(`/api/hr/recruitment/applications/${appId}/move`, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stageId }),
          });
          return { status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => '') };
        }, [mineApp.id, target.id]);
        ok(moved.status < 400, `application moves to "${target.name || target.kind}"`,
          `HTTP ${moved.status} ${String(moved.body).slice(0, 90)}`);
      }
    }
  }

  // ── 7. cleanup ────────────────────────────────────────────────────────────
  if (jobId && !KEEP) {
    const del = await page.evaluate(async (id) => {
      const r = await fetch(`/api/hr/recruitment/jobs/${id}`, { method: 'DELETE', credentials: 'include' });
      return r.status;
    }, jobId);
    console.log(`  ..    cleanup: deleted smoke job (HTTP ${del})`);
  }

  await browser.close();

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log(`\n  ${pass} passed, ${failures.length} failed`);
  if (problems.length) {
    console.log(`\n  browser problems (${problems.length}) — each is something a real user's browser logged:`);
    [...new Set(problems)].slice(0, 15).forEach((p) => console.log(`    • ${p}`));
  }
  const bad = failures.length > 0 || problems.length > 0;
  console.log(bad ? '\n=== HIRING SMOKE FAILED ===\n' : '\n=== HIRING SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('\nsmoke crashed:', e.message, '\n'); process.exit(1); });
