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
  // The scorecard step probes /me/scorecards deliberately. On a tenant whose
  // operator has no linked Employee the server answers 403 "No linked employee",
  // which is the correct answer and the documented skip signal — not a fault.
  'recruitment/me/scorecards',
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
  let resumeAttached = false;

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

        // ATTACH A RÉSUMÉ. Applying without one is the easy path, and taking it is
        // exactly why nobody noticed that résumé uploads were dead in production
        // until a real applicant was told "Resume uploads are temporarily
        // unavailable" on a live client's careers page. A tiny valid PDF is enough:
        // the failure was a missing bucket, not a parsing problem.
        const fileInput = cand.locator('input[type="file"]').first();
        if (await fileInput.count().catch(() => 0)) {
          const MINIMAL_PDF = Buffer.from(
            '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
            + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
            + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n'
            + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'utf8');
          await fileInput.setInputFiles({
            name: `smoke-resume-${stamp}.pdf`,
            mimeType: 'application/pdf',
            buffer: MINIMAL_PDF,
          }).catch(() => {});
          resumeAttached = true;
          // The page shows this banner when the server refuses the upload. It is a
          // 503 the candidate cannot work around, so treat it as a hard failure.
          await cand.waitForTimeout(800);
          const preSubmit = await cand.innerText('body').catch(() => '');
          ok(!/uploads are temporarily unavailable|upload failed/i.test(preSubmit),
            'résumé attach is not refused by the server',
            preSubmit.slice(0, 140).replace(/\s+/g, ' '));
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
        // Match ONLY genuine success wording. The bare word "application" used to
        // be in here, which made "Too many applications, please try again" and
        // "Your application could not be submitted" both read as SUCCESS — the
        // assertion would have hidden the very failures it exists to catch.
        // Known error wording fails outright rather than falling through.
        const rejected = /too many|could not|failed|unavailable|error|try again/i.test(after);
        const accepted = !rejected
          && /thank you|received|we.ll be in touch|application (has been |was )?(received|submitted)/i.test(after);
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

      // ── the rest of the funnel: interview → offer ──────────────────────
      // Moving a stage is not hiring. These are the steps that turn a pipeline
      // into an actual hire, and nothing else in the suite touches them.
      const iv = await page.evaluate(async (appId) => {
        const r = await fetch('/api/hr/recruitment/interviews', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ applicationId: appId, round: 1, mode: 'VIDEO' }),
        });
        return { status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => '') };
      }, mineApp.id);
      ok(iv.status < 400, 'interview can be scheduled for the application',
        `HTTP ${iv.status} ${String(iv.body).slice(0, 90)}`);

      // A scheduled interview that cannot be SCORED is a dead end: the panellist
      // is shown no skills, saveMyScorecard's allowlist rejects every rating, and
      // the card can never be submitted — so interviewScore never computes and the
      // candidate is stuck in the merit list forever. Assert the interview came
      // back with a scorecard template that actually has rateable skills.
      if (iv.body && iv.body.id) {
        ok(!!iv.body.scorecardTemplateId,
          'scheduled interview carries a scorecard template (it is scoreable)',
          `interview ${iv.body.id} has scorecardTemplateId=${JSON.stringify(iv.body.scorecardTemplateId)}`);

        if (iv.body.scorecardTemplateId) {
          const tpl = await page.evaluate(async (tplId) => {
            const r = await fetch(`/api/hr/recruitment/scorecard-templates/${tplId}`, { credentials: 'include' });
            return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
          }, iv.body.scorecardTemplateId);
          const skills = (tpl.body && (tpl.body.skills || (tpl.body.template && tpl.body.template.skills))) || [];
          ok(skills.length > 0, 'that scorecard template has skills to rate',
            `HTTP ${tpl.status}, ${skills.length} skill(s)`);
        }
      }

      // ── scoring: the step that turns an interview into a decision ──────
      // Everything above proves an interview can be BOOKED. None of it proves it
      // can be SCORED, which is what actually ranks a candidate. Submitting a card
      // requires the panellist's OWN session (SoD: myScorecard 404s unless the
      // caller is on the panel), so schedule a second interview with the operator
      // as the panel and score that one.
      const selfEmp = await page.evaluate(async (email) => {
        const r = await fetch(`/api/hr/employees?search=${encodeURIComponent(email)}&pageSize=5`, { credentials: 'include' });
        if (!r.ok) return null;
        const j = await r.json().catch(() => null);
        const list = Array.isArray(j) ? j : (j && (j.items || j.data)) || [];
        return list.length ? list[0].id : null;
      }, EMAIL);

      if (!selfEmp) {
        // Not a failure: this operator simply has no linked Employee, so it can
        // never be a panellist. Say so rather than reporting a broken scorecard.
        console.log('  ..    skip: scorecard submission (operator has no linked Employee to sit on a panel)');
      } else {
        const iv2 = await page.evaluate(async ([appId, empId]) => {
          const r = await fetch('/api/hr/recruitment/interviews', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ applicationId: appId, round: 2, mode: 'VIDEO', interviewerIds: [empId] }),
          });
          return { status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => '') };
        }, [mineApp.id, selfEmp]);
        ok(iv2.status < 400, 'interview can be scheduled with the operator on the panel',
          `HTTP ${iv2.status} ${String(iv2.body).slice(0, 90)}`);

        if (iv2.body && iv2.body.id) {
          const card = await page.evaluate(async (ivId) => {
            const r = await fetch(`/api/hr/recruitment/me/scorecards/${ivId}`, { credentials: 'include' });
            return { status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => '') };
          }, iv2.body.id);
          const skills = (card.body && card.body.skills) || [];
          if (card.status === 403) {
            // 403 here is specifically "No linked employee for this user".
            // attachSelfEmployee resolves the panellist by userId, and this
            // operator account has no Employee row — so it can never sit on a
            // panel. That is a property of the seed account, not a defect, so it
            // must not be reported as a failure.
            //
            // The flow itself is NOT unverified: recruitment-ats.test.js drives
            // open → rate → submit at controller level and asserts interviewScore
            // AND meritScore are computed, plus SoD (a non-panellist gets 404) and
            // the post-submit 409 lock.
            console.log('  ..    skip: scorecard submission — operator has no linked Employee (covered by recruitment-ats.test.js)');
          } else {
            ok(card.status < 400 && skills.length > 0,
              'panellist can open their scorecard and it has skills to rate',
              `HTTP ${card.status}, ${skills.length} skill(s)`);
          }

          if (skills.length) {
            const cardId = card.body.card.id;
            const saved = await page.evaluate(async ([cid, ratings]) => {
              const r = await fetch(`/api/hr/recruitment/me/scorecards/${cid}`, {
                method: 'PATCH', credentials: 'include',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ratings, recommendation: 'HIRE' }),
              });
              return { status: r.status, body: r.ok ? null : await r.text().catch(() => '') };
            }, [cardId, skills.map((s) => ({ skillId: s.id, score: 8 }))]);
            ok(saved.status < 400, 'ratings save against the skill allowlist',
              `HTTP ${saved.status} ${String(saved.body).slice(0, 90)}`);

            const sub = await page.evaluate(async (cid) => {
              const r = await fetch(`/api/hr/recruitment/me/scorecards/${cid}/submit`, {
                method: 'POST', credentials: 'include',
              });
              return { status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => '') };
            }, cardId);
            ok(sub.status < 400, 'scorecard submits',
              `HTTP ${sub.status} ${String(sub.body).slice(0, 90)}`);

            // The whole point of scoring: the application must come back RANKED.
            // A submitted card that leaves interviewScore null means the candidate
            // still sits in the merit list's "pending" bucket forever.
            const merit = await page.evaluate(async ([jobId, appId]) => {
              const r = await fetch(`/api/hr/recruitment/jobs/${jobId}/merit-list`, { credentials: 'include' });
              if (!r.ok) return { status: r.status, found: null };
              const j = await r.json().catch(() => null);
              const rows = [...((j && j.ranked) || []), ...((j && j.pending) || [])];
              const row = rows.find((x) => x.id === appId);
              return { status: r.status, found: row ? { interviewScore: row.interviewScore, meritScore: row.meritScore } : null };
            }, [jobId, mineApp.id]);
            ok(merit.found && merit.found.interviewScore != null,
              'submitted scorecard produces an interviewScore (candidate is ranked)',
              `HTTP ${merit.status} ${JSON.stringify(merit.found)}`);
          }
        }
      }

      const offer = await page.evaluate(async (appId) => {
        const r = await fetch('/api/hr/recruitment/offers', {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          // India's Code on Wages requires basic >= 50% of gross, and the API
          // enforces it (WAGES_50_RULE) — so an offer without these figures is
          // CORRECTLY refused. Send a compliant pair so this exercises the happy
          // path rather than re-proving the guard.
          body: JSON.stringify({
            applicationId: appId, currencyCode: 'INR',
            grossMonthly: 100000, basicMonthly: 50000,
          }),
        });
        return { status: r.status, body: r.ok ? await r.json().catch(() => null) : await r.text().catch(() => '') };
      }, mineApp.id);
      // An offer may legitimately require the app to sit on an OFFER stage or
      // carry compensation — a 4xx with a REASON is healthy; a 5xx is not.
      ok(offer.status < 400, 'offer can be raised for the application',
        `HTTP ${offer.status} ${String(offer.body).slice(0, 130)}`);
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
