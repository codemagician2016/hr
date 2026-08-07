#!/usr/bin/env node
/**
 * screening-questions.js — the HR admin's DAY-TO-DAY loop on a job's screening form.
 *
 *   node qa/smoke/screening-questions.js                 # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/screening-questions.js               # prod
 *
 * WHY THIS EXISTS
 * ---------------
 * Applying a form template 500'd on any job whose questions had been deleted: the
 * delete is SOFT, but @@unique([businessId, jobId, sortOrder]) is a FULL unique, so
 * the tombstones still held sortOrder 0..n while the screen showed "No screening
 * questions yet". The fix cleared the tombstones — but the real requirement is that
 * an HR admin can add, edit, delete, reorder and re-template this form REPEATEDLY
 * without ever hitting a wall. Reasoning said the other paths were safe; this
 * exercises them instead.
 *
 * EVERY ASSERTION READS THE VALUE BACK. A 200 on a PATCH proves nothing if the
 * points silently failed to persist — the score depends on them.
 *
 * SAFETY: operates on a throwaway job it creates, and deletes it at the end.
 */

'use strict';

const path = require('path');
function resolvePlaywright() {
  for (const c of ['/Users/kp/sitepresso', path.resolve(__dirname, '..', '..')]) {
    try { return require(require.resolve('playwright', { paths: [c] })); } catch { /* next */ }
  }
  throw new Error('Playwright not installed. Run npm i -D playwright, then retry.');
}
const { chromium } = resolvePlaywright();
const { signIn, waitForHealthy } = require('./ui-lib');

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

(async () => {
  console.log(`\n=== screening questions — the HR admin edit loop — ${ADMIN} ===\n`);
  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1440, height: 1000 } }).then((c) => c.newPage());
  let jobId = null;

  const api = (u, m = 'GET', body) => page.evaluate(async ([url, method, b]) => {
    const r = await fetch(url, {
      method, credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: b ? JSON.stringify(b) : undefined,
    });
    let out = null; try { out = await r.json(); } catch { out = null; }
    return { status: r.status, body: out };
  }, [u, m, body]);
  const listOf = (r) => (r.body && (r.body.items || r.body.data)) || (Array.isArray(r.body) ? r.body : []);
  const questions = async () => listOf(await api(`/api/hr/recruitment/jobs/${jobId}/screening-questions`));

  try {
    await waitForHealthy(page, ADMIN);
    const login = await signIn(page, { admin: ADMIN, email: EMAIL, password: PASSWORD });
    if (login.notUp) { console.log(`\n  APP NOT UP — login ${login.status}.\n`); await browser.close(); process.exit(2); }
    if (login.throttled) { console.log('\n  THROTTLED — 429 (correct behaviour).\n'); await browser.close(); process.exit(2); }
    ok(login.ok, 'admin signs in');

    // Work on an EXISTING job so this mirrors reality; fall back to any job.
    const jobs = listOf(await api('/api/hr/recruitment/jobs?take=50'));
    if (!jobs.length) { console.log('\n  no jobs on this tenant — nothing to exercise.\n'); await browser.close(); process.exit(2); }
    jobId = jobs[0].id;
    note(`job "${jobs[0].title}"`);

    // Start from a known-clean form so counts are meaningful.
    const before = await questions();
    for (const q of before) await api(`/api/hr/recruitment/screening-questions/${q.id}`, 'DELETE');
    ok((await questions()).length === 0, 'form starts empty', `${before.length} cleared`);

    // ── 1. add a scored question ────────────────────────────────────────────
    const add = await api(`/api/hr/recruitment/jobs/${jobId}/screening-questions`, 'POST', {
      prompt: 'Highest qualification?', kind: 'SINGLE_CHOICE', required: true, isKnockout: false,
      options: [
        { label: "Bachelor's", value: 'BACHELORS', points: 4, sortOrder: 0 },
        { label: "Master's", value: 'MASTERS', points: 8, sortOrder: 1 },
      ],
    });
    ok(add.status < 300, 'HR adds a scored question', `HTTP ${add.status} ${JSON.stringify(add.body || {}).slice(0, 140)}`);

    // Read back — the POINTS are what the score depends on.
    let qs = await questions();
    const q1 = qs.find((q) => q.prompt === 'Highest qualification?');
    ok(!!q1, 'the new question is listed');
    // points is Decimal(7,2) — Prisma serialises it as a STRING on purpose (no float
    // drift). The engine's num() and the UI's Number() both coerce, so compare
    // numerically; asserting on the JSON shape would fail on a correct value.
    const pts = (q1?.options || []).map((o) => Number(o.points)).sort((a, b) => a - b);
    ok(JSON.stringify(pts) === '[4,8]', 'its option POINTS persisted', JSON.stringify(pts));

    // ── 2. edit it — the thing HR does most ─────────────────────────────────
    const edit = await api(`/api/hr/recruitment/screening-questions/${q1.id}`, 'PATCH', {
      prompt: 'Highest qualification (edited)?', kind: 'SINGLE_CHOICE', required: true, isKnockout: false,
      options: [
        { label: "Bachelor's", value: 'BACHELORS', points: 5, sortOrder: 0 },
        { label: "Master's", value: 'MASTERS', points: 10, sortOrder: 1 },
        { label: 'PhD', value: 'PHD', points: 15, sortOrder: 2 },
      ],
    });
    ok(edit.status < 300, 'HR edits the question (new prompt, new points, extra option)', `HTTP ${edit.status}`);
    qs = await questions();
    const q1b = qs.find((q) => q.id === q1.id);
    ok(q1b && q1b.prompt === 'Highest qualification (edited)?', 'the edited PROMPT persisted', q1b && q1b.prompt);
    const pts2 = (q1b?.options || []).map((o) => Number(o.points)).sort((a, b) => a - b);
    ok(JSON.stringify(pts2) === '[5,10,15]', 'the edited POINTS persisted', JSON.stringify(pts2));

    // ── 3. add a knockout, then delete a question, then add again ───────────
    const ko = await api(`/api/hr/recruitment/jobs/${jobId}/screening-questions`, 'POST', {
      prompt: 'Available full-time?', kind: 'BOOLEAN', required: true, isKnockout: true, knockoutValue: [true],
      options: [{ label: 'Yes', value: 'true', points: 3, sortOrder: 0 }, { label: 'No', value: 'false', points: 0, sortOrder: 1 }],
    });
    ok(ko.status < 300, 'HR adds a Yes/No knockout that also carries points', `HTTP ${ko.status}`);

    const del = await api(`/api/hr/recruitment/screening-questions/${q1.id}`, 'DELETE');
    ok(del.status < 300, 'HR deletes a question', `HTTP ${del.status}`);

    // THE REGRESSION: adding after a delete must not collide with the tombstone.
    const readd = await api(`/api/hr/recruitment/jobs/${jobId}/screening-questions`, 'POST', {
      prompt: 'Years of experience', kind: 'NUMBER', required: true, maxPoints: 10,
    });
    ok(readd.status < 300, 'HR adds ANOTHER question after deleting one (tombstone path)',
      `HTTP ${readd.status} ${JSON.stringify(readd.body || {}).slice(0, 140)}`);

    // ── 4. repeat the add/delete cycle — HR does this over and over ─────────
    let churnOk = true; let churnDetail = '';
    for (let i = 0; i < 4; i += 1) {
      const a = await api(`/api/hr/recruitment/jobs/${jobId}/screening-questions`, 'POST', {
        prompt: `Churn question ${i}`, kind: 'TEXT', required: false,
      });
      if (a.status >= 300) { churnOk = false; churnDetail = `add #${i} HTTP ${a.status}`; break; }
      const d = await api(`/api/hr/recruitment/screening-questions/${a.body.id}`, 'DELETE');
      if (d.status >= 300) { churnOk = false; churnDetail = `delete #${i} HTTP ${d.status}`; break; }
    }
    ok(churnOk, 'four add→delete cycles in a row all succeed', churnDetail);

    // ── 5. live questions must never share a sortOrder ─────────────────────
    qs = await questions();
    const orders = qs.map((q) => q.sortOrder);
    ok(new Set(orders).size === orders.length, 'no duplicate sortOrder among live questions', JSON.stringify(orders));

    // ── 6. templates over a dirty form ─────────────────────────────────────
    let tpls = listOf(await api('/api/hr/recruitment/screening-form-templates'));
    if (!tpls.length) {
      await api('/api/hr/recruitment/screening-form-templates/seed-defaults', 'POST', {});
      tpls = listOf(await api('/api/hr/recruitment/screening-form-templates'));
    }
    if (tpls.length) {
      const tpl = tpls[0];
      const refuse = await api(`/api/hr/recruitment/jobs/${jobId}/apply-screening-template`, 'POST', { templateId: tpl.id });
      ok(refuse.status === 409, 'applying over a populated form is REFUSED without replace', `HTTP ${refuse.status}`);

      const rep = await api(`/api/hr/recruitment/jobs/${jobId}/apply-screening-template?replace=true`, 'POST', { templateId: tpl.id });
      ok(rep.status === 200, 'applying WITH replace=true succeeds', `HTTP ${rep.status} ${JSON.stringify(rep.body || {}).slice(0, 140)}`);

      // delete everything, then re-apply — the originally reported 500
      for (const q of await questions()) await api(`/api/hr/recruitment/screening-questions/${q.id}`, 'DELETE');
      ok((await questions()).length === 0, 'screen shows NO questions after deleting them all');
      const again = await api(`/api/hr/recruitment/jobs/${jobId}/apply-screening-template`, 'POST', { templateId: tpl.id });
      ok(again.status === 200, 'RE-APPLYING onto the emptied job succeeds (the reported 500)',
        `HTTP ${again.status} ${JSON.stringify(again.body || {}).slice(0, 140)}`);
      ok((await questions()).length > 0, 'the template questions are actually on the job');

      // and HR can keep editing AFTER a template apply
      const post = await questions();
      if (post.length) {
        const e2 = await api(`/api/hr/recruitment/screening-questions/${post[0].id}`, 'PATCH', {
          prompt: 'Edited after template apply', kind: post[0].kind, required: true, isKnockout: !!post[0].isKnockout,
          options: (post[0].options || []).map((o, i) => ({ label: o.label, value: o.value, points: o.points, sortOrder: i })),
        });
        ok(e2.status < 300, 'HR can still edit a question that came FROM a template', `HTTP ${e2.status}`);
      }
    } else {
      note('no screening form templates available — template paths not exercised');
    }
  } catch (e) {
    console.log(`\nsmoke crashed: ${e.message}\n`);
    failures.push(`crash: ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
  console.log(failures.length ? '=== SCREENING QUESTIONS SMOKE FAILED ===\n' : '=== SCREENING QUESTIONS SMOKE PASSED ===\n');
  process.exit(failures.length ? 1 : 0);
})();
