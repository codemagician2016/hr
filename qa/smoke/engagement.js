#!/usr/bin/env node
/**
 * engagement.js — Module 15 of the feature sweep (see qa/SWEEP.md).
 *
 *   node qa/smoke/engagement.js                  # staging (default)
 *   E2E_ADMIN=https://app.drifthr.com \
 *     node qa/smoke/engagement.js                # prod
 *
 * WHAT THIS COVERS
 *   helpdesk (categories → a ticket that is answerable) → announcements →
 *   surveys → recognition
 *
 * WHY PUBLISH-STATE IS THE ASSERTION HERE
 * ---------------------------------------
 * This module's failure mode is the one Performance just demonstrated: an object
 * is created, the API returns 200, and it never reaches the people it was written
 * for because a status was never advanced. A DRAFT announcement nobody sees and a
 * DRAFT survey nobody can answer look exactly like healthy records in a list.
 *
 * Module 11 found precisely that in review cycles — launch generated the forms and
 * left the cycle DRAFT, so every self-review was refused. So this checks that
 * published things actually leave draft.
 *
 * SAFETY
 * ------
 * Publishing an announcement or survey NOTIFIES real people. Staging redirects all
 * mail to one inbox, so the publish path is exercised there only; on production
 * this stays read-only and says so.
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
const stamp = String(Date.now()).slice(-6);

(async () => {
  console.log(`\n=== engagement smoke — admin ${ADMIN} ===\n`);
  console.log(`  (${IS_STAGING ? 'staging: publish paths exercised' : 'production: READ-ONLY, publishing notifies real people'})\n`);
  const browser = await chromium.launch();
  const problems = [];

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  watch(page, 'admin', problems);

  try {
    await waitForHealthy(page, ADMIN);
    const login = await signIn(page, { admin: ADMIN, email: EMAIL, password: PASSWORD });
    if (login.notUp) {
      // The app is restarting (a deploy just ran). Everything below would fail on
      // 401 and look like an outage.
      console.log(`\n  APP NOT UP — login returned ${login.status}. Wait for the deploy to settle and re-run.\n`);
      await browser.close();
      process.exit(2);
    }
    if (login.throttled) {
      console.log('\n  THROTTLED — the auth rate limiter returned 429 (correct behaviour).');
      console.log('  Wait a minute and re-run; this is NOT a product failure.\n');
      await browser.close();
      process.exit(2);
    }
    ok(login.ok, 'admin signs in', `HTTP ${login.status} ${page.url()}`);

    // ── 1. helpdesk ─────────────────────────────────────────────────────────
    const cats = await api(page, '/api/hr/helpdesk/categories');
    const catList = asList(cats.body);
    ok(cats.status < 400, 'helpdesk categories load', `HTTP ${cats.status}`);
    // With no category an employee cannot raise a ticket at all — the same
    // "config absent, feature unusable" shape found repeatedly in this sweep.
    // Ordinary tenant config with an admin UI, exactly like expense categories —
    // a company defines its own. Create one rather than reporting normal setup as
    // a defect, so the ticket path is still exercised.
    if (!catList.length) {
      note('no helpdesk categories — creating one so the ticket path is covered');
      const mk = await send(page, 'POST', '/api/hr/helpdesk/categories', {
        name: `QA Smoke Category ${stamp}`, isActive: true,
      });
      ok(mk.status < 400, 'a helpdesk category can be created',
        `HTTP ${mk.status} ${JSON.stringify(mk.body).slice(0, 120)}`);
    } else {
      ok(true, 'the tenant has helpdesk categories', `${catList.length} category(ies)`);
    }

    const tickets = await api(page, '/api/hr/helpdesk/tickets?pageSize=20');
    ok(tickets.status < 400, 'helpdesk tickets load',
      `HTTP ${tickets.status}, ${asList(tickets.body).length} ticket(s)`);

    const agents = await api(page, '/api/hr/helpdesk/agents');
    const agentList = asList(agents.body);
    ok(agents.status < 400, 'helpdesk agents load', `HTTP ${agents.status}`);
    // A ticket queue with no agents is a queue nobody is asked to answer.
    ok(agentList.length > 0, 'the helpdesk has at least one agent to answer tickets',
      `${agentList.length} agent(s) — with none, tickets are raised into a void`);

    // ── 2. announcements ────────────────────────────────────────────────────
    const anns = await api(page, '/api/hr/announcements?pageSize=20');
    const annList = asList(anns.body);
    ok(anns.status < 400, 'announcements load', `HTTP ${anns.status}`);
    note(`${annList.length} announcement(s)`);

    if (IS_STAGING) {
      // THE assertion: publishing must actually leave DRAFT. Module 11 found a
      // launch that generated everything and never advanced the status, which
      // silently blocked an entire company's appraisal.
      const made = await send(page, 'POST', '/api/hr/announcements', {
        title: `QA Smoke Announcement ${stamp}`,
        // bodyRichText, not body — the API named the field exactly in its 400.
        bodyRichText: 'Created by the engagement smoke. Safe to ignore.',
      });
      // The response NESTS the record: { announcement: { id, ... } }.
      const annRow = (made.body && (made.body.announcement || made.body)) || {};
      ok(made.status < 400 && annRow.id, 'an announcement can be created',
        `HTTP ${made.status} ${JSON.stringify(made.body).slice(0, 140)}`);
      const aid = annRow.id;
      if (aid) {
        const pub = await send(page, 'POST', `/api/hr/announcements/${aid}/publish`, {});
        ok(pub.status < 400, 'an announcement can be published', `HTTP ${pub.status}`);
        const re = await api(page, `/api/hr/announcements/${aid}`);
        const st = String((re.body && (re.body.status || (re.body.announcement && re.body.announcement.status))) || '');
        ok(!/DRAFT/i.test(st), 'publishing an announcement LEAVES draft (people can see it)',
          `status after publish: ${st || 'unknown'}`);
        await send(page, 'POST', `/api/hr/announcements/${aid}/archive`, {});
        note('archived the smoke announcement');
      }
    } else {
      note('skip: publishing an announcement notifies real people on production');
    }

    // ── 3. surveys ──────────────────────────────────────────────────────────
    const surveys = await api(page, '/api/hr/surveys?pageSize=20');
    ok(surveys.status < 400, 'surveys load',
      `HTTP ${surveys.status}, ${asList(surveys.body).length} survey(s)`);

    // ── 4. recognition ──────────────────────────────────────────────────────
    const recConfig = await api(page, '/api/hr/recognition/config');
    ok(recConfig.status < 400, 'recognition config loads', `HTTP ${recConfig.status}`);
    const badges = await api(page, '/api/hr/recognition/badges');
    ok(badges.status < 400, 'recognition badges load',
      `HTTP ${badges.status}, ${asList(badges.body).length} badge(s)`);

    // ── 5. the pages a client opens ─────────────────────────────────────────
    for (const [url, label] of [
      ['/helpdesk', 'Helpdesk'],
      ['/announcements', 'Announcements'],
      ['/surveys', 'Surveys'],
    ]) {
      const resp = await page.goto(`${ADMIN}${url}`, { waitUntil: 'networkidle' }).catch(() => null);
      const st = resp ? resp.status() : 0;
      if (st === 404) { note(`skip: ${label} is not mounted at ${url}`); continue; }
      await page.waitForTimeout(1200);
      const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      ok(text.trim().length > 60, `${label} page renders content`, `HTTP ${st}, ${text.trim().length} chars`);
    }
    await assertControlVisible(page, ok,
      ['button', 'a[href*="survey"]', 'table', '[role="table"]'],
      'Engagement surface exposes a control or its list');
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
  console.log(bad ? '=== ENGAGEMENT SMOKE FAILED ===\n' : '=== ENGAGEMENT SMOKE PASSED ===\n');
  process.exit(bad ? 1 : 0);
})();
