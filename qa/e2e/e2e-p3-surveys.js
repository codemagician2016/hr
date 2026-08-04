'use strict';
/* Phase 3 wave 1 E2E on live staging: Pulse Surveys + eNPS. Covers: builder
 * validation (ENPS driver rule), publish + occurrence #1, ESS list/fill/submit
 * through the ANONYMITY FIREWALL (no employeeId on ballots — receipt only),
 * double-submit 409, dismiss, k-suppression on results (below-k hides
 * numbers), anonymity-lock 409, close + archive. Cleanup: archive the survey.
 * Ops: 26s between logins; ~6min cooldown between full runs. */
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
  const T = 'P3S-' + (Date.now() % 1000);
  let r = await call(A, op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { email: cred('Priya').email, password: cred('Priya').password });
  rec('Priya login', r.status === 200);

  // ── A. builder validation ─────────────────────────────────────────────────
  r = await call(A, op, 'POST', '/api/hr/surveys', {
    title: `${T} bad enps`, type: 'ENPS', anonymous: true, audienceScope: 'ALL', windowDays: 7,
    questions: [{ orderIndex: 0, type: 'TEXT', prompt: 'why?', required: false }],
  });
  rec('ENPS without NPS driver rejected', r.status === 400 || r.status === 422, `status ${r.status} ${r.data?.message || ''}`);

  // ── B. create + publish an anonymous eNPS pulse ───────────────────────────
  r = await call(A, op, 'POST', '/api/hr/surveys', {
    title: `${T} quarterly eNPS`, description: 'How are we doing?', type: 'ENPS',
    anonymous: true, minResponsesToShow: 5, audienceScope: 'ALL', windowDays: 7,
    questions: [
      { orderIndex: 0, type: 'NPS', prompt: 'How likely are you to recommend us as a place to work?', required: true, isEnpsDriver: true },
      { orderIndex: 1, type: 'TEXT', prompt: 'What is the main reason for your score?', required: false },
      { orderIndex: 2, type: 'SCALE', prompt: 'I feel supported by my manager', required: false, scaleMin: 1, scaleMax: 5, scaleMinLabel: 'Strongly disagree', scaleMaxLabel: 'Strongly agree' },
    ],
  });
  const survey = r.data?.survey || r.data;
  rec('eNPS survey created (DRAFT)', r.status === 201 && survey?.status === 'DRAFT', `status ${r.status} ${r.data?.message || ''}`);

  r = await call(A, op, 'POST', `/api/hr/surveys/${survey.id}/publish`, {});
  const pub = r.data?.survey || r.data;
  rec('Published (occurrence #1 opened)', r.status === 200 && (pub?.status === 'PUBLISHED' || pub?.survey?.status === 'PUBLISHED'), `status ${r.status} ${r.data?.message || ''}`);

  // ── C. ESS fill through the firewall ──────────────────────────────────────
  r = await call(M, priya, 'GET', '/api/hr/me/engagement/surveys');
  const myItems = r.data?.items || r.data || [];
  const mine = (Array.isArray(myItems) ? myItems : []).find((s) => (s.survey?.title || '').includes(T));
  const occId = mine?.occurrenceId;
  rec('ESS lists the open pulse (Pending)', !!mine && !!occId, occId);

  r = await call(M, priya, 'GET', `/api/hr/me/engagement/surveys/${occId}`);
  const detail = r.data || {};
  const qs = detail.survey?.questions || detail.questions || [];
  const qByType = (t) => qs.find((q) => q.type === t);
  rec('Fill view returns questions', r.status === 200 && qs.length === 3, `q=${qs.length}`);

  r = await call(M, priya, 'POST', `/api/hr/me/engagement/surveys/${occId}/submit`, { answers: [] });
  rec('Missing required answer 422', r.status === 422, `status ${r.status}`);

  r = await call(M, priya, 'POST', `/api/hr/me/engagement/surveys/${occId}/submit`, {
    answers: [
      { questionId: qByType('NPS').id, numericValue: 9 },
      { questionId: qByType('TEXT').id, textValue: `${T} great place, keep the flexibility` },
      { questionId: qByType('SCALE').id, numericValue: 4 },
    ],
  });
  const receipt = r.data?.receiptToken;
  rec('Submit through firewall → receipt only', r.status === 200 || r.status === 201 ? !!receipt && !r.data?.employeeId : false, `status ${r.status} receipt=${receipt ? 'yes' : 'no'}`);

  r = await call(M, priya, 'POST', `/api/hr/me/engagement/surveys/${occId}/submit`, {
    answers: [{ questionId: qByType('NPS').id, numericValue: 2 }],
  });
  rec('Double-submit 409', r.status === 409, `status ${r.status}`);

  r = await call(M, priya, 'GET', '/api/hr/me/engagement/surveys');
  const mineAfter = (r.data?.items || []).find((s) => (s.survey?.title || '').includes(T));
  rec('ESS badge flips to Done/Submitted', mineAfter?.state === 'SUBMITTED', `state=${mineAfter && mineAfter.state}`);

  // ── D. k-suppression: 1 response < k=5 → totals hidden ───────────────────
  r = await call(A, op, 'GET', `/api/hr/surveys/${survey.id}/results`);
  const res1 = r.data || {};
  const suppressed = JSON.stringify(res1).includes('suppress') || res1.suppressed === true
    || (res1.enps == null && !JSON.stringify(res1).includes('"enps":'))
    || JSON.stringify(res1).match(/"suppressed"\s*:\s*true/);
  rec('Results k-suppressed below floor (1 < 5)', r.status === 200 && !!suppressed, JSON.stringify(res1).slice(0, 120));

  // Verbatims gate: without ack → 400.
  r = await call(A, op, 'GET', `/api/hr/surveys/${survey.id}/results/verbatims`);
  rec('Verbatims require explicit ack (400)', r.status === 400, `status ${r.status}`);

  // ── E. anonymity lock: PATCH anonymous flip → 409 once a response exists ──
  r = await call(A, op, 'GET', `/api/hr/surveys/${survey.id}`);
  const freshVersion = r.data?.survey?.version;
  r = await call(A, op, 'PATCH', `/api/hr/surveys/${survey.id}`, { anonymous: false, version: freshVersion });
  const lockOk = r.status === 409;
  rec('Anonymity flip blocked (ANONYMITY_LOCKED)', lockOk, `status ${r.status} ${r.data?.message || r.data?.error || ''}`);

  // ── F. close + archive (cleanup) ──────────────────────────────────────────
  r = await call(A, op, 'POST', `/api/hr/surveys/${survey.id}/close`, {});
  rec('Survey closed', r.status === 200);
  r = await call(M, priya, 'GET', '/api/hr/me/engagement/surveys');
  const gone = !(r.data?.items || []).some((s) => (s.survey?.title || '').includes(T));
  rec('Closed pulse leaves the ESS list', gone);
  r = await call(A, op, 'POST', `/api/hr/surveys/${survey.id}/archive`, {});
  rec('Archived (cleanup)', r.status === 200);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P3 surveys E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
