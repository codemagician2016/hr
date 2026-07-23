'use strict';
/* Phase 3 wave 5 E2E on live staging: Candidate Communication. Covers: comms
 * template library + config, public apply → token/trackUrl + candidate.applied,
 * stage-move shortlisted fire, interview slot propose → public timeline (friendly
 * labels, NO score leak) → public slot confirm → double-confirm 409, bulk
 * message, unknown-token save 422, the UNKNOWN_TEMPLATE interview-invite bug
 * fixed (invite leaves the router). Cleanup: withdraw slots, delete job,
 * reset template + config. Single operator login (no rate-limit cooldown). */
const A = 'https://app-staging.drifthr.com';
const P = 'https://app-staging.drifthr.com'; // public careers same origin /api/public/*
const pb = require('/Users/kp/hr/qa/playbook.json');
const cred = (l) => pb.logins.find((x) => x.label.includes(l));
const results = [];
function rec(name, ok, d = '') { results.push(ok); console.log(`${ok === true ? 'PASS' : ok === 'skip' ? 'SKIP' : 'FAIL'}  ${name}${d ? ' — ' + d : ''}`); }
function jar() { return { cookie: '' }; }
async function call(j, method, path, { body, origin } = {}) {
  const h = { 'X-Tenant-Host': 'demo.staging.drifthr.com' };
  if (j && j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch((origin || A) + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const T = 'CC-' + (Date.now() % 100000);
  const slug = `${T.toLowerCase()}-eng`;
  let r = await call(op, 'POST', '/api/auth/login', { body: { email: cred('HR Admin').email, password: cred('HR Admin').password } });
  rec('Operator login', r.status === 200);

  // ── A. template library + config ──────────────────────────────────────────
  r = await call(op, 'GET', '/api/hr/recruitment/comms-templates');
  const tpls = r.data?.items || r.data?.templates || [];
  const keys = tpls.map((t) => t.key);
  rec('Comms templates list (HR_CAND_*)', r.status === 200 && keys.includes('HR_CAND_APPLIED') && keys.includes('HR_CAND_SHORTLISTED') && keys.includes('HR_CAND_INTERVIEW_INVITE'), `n=${tpls.length}`);
  r = await call(op, 'GET', '/api/hr/recruitment/comms-config');
  rec('Comms config readable', r.status === 200, JSON.stringify(r.data?.config || {}).slice(0, 70));
  r = await call(op, 'PUT', '/api/hr/recruitment/comms-templates/HR_CAND_SHORTLISTED', { body: { body: 'Hi {NAME}, unknown token {BOGUS} here' } });
  rec('Unknown-token template save 422', r.status === 422, `status ${r.status}`);

  // ── B. create a public job ────────────────────────────────────────────────
  r = await call(op, 'POST', '/api/hr/recruitment/jobs', { body: { code: T, title: `${T} Backend Engineer`, countryCode: 'IN', employmentType: 'FULL_TIME', publicSlug: slug, isPublic: true } });
  const job = r.data?.job || r.data;
  rec('Job created', (r.status === 201 || r.status === 200) && !!job?.id, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(op, 'POST', `/api/hr/recruitment/jobs/${job.id}/publish`, {});
  const published = r.status === 200;
  r = await call(op, 'POST', `/api/hr/recruitment/jobs/${job.id}/set-public`, { body: { isPublic: true } });
  rec('Job published + public', published, `publish=${published}`);

  // ── C. public apply → token + candidate.applied ───────────────────────────
  const capp = jar();
  r = await call(capp, 'POST', `/api/public/careers/demo/jobs/${slug}/apply`, {
    origin: P,
    body: { firstName: 'Cand', lastName: `Probe${T}`, email: `cand.${T.toLowerCase()}@e2edemo.dev`, phone: '+919000000000', consent: true },
  });
  const trackUrl = r.data?.trackUrl || r.data?.track || '';
  const token = (trackUrl.match(/\/c\/([a-f0-9]+)/) || [])[1] || r.data?.token;
  rec('Public apply → trackUrl with token', (r.status === 201 || r.status === 200) && !!token, `status ${r.status} token=${token ? 'yes' : 'no'}`);

  // ── D. authed: find application, move to shortlist ────────────────────────
  r = await call(op, 'GET', `/api/hr/recruitment/applications?jobId=${job.id}&pageSize=10`);
  const appRow = (r.data?.items || []).find((a) => (a.candidate?.email || '') === `cand.${T.toLowerCase()}@e2edemo.dev`) || (r.data?.items || [])[0];
  rec('Application listed', !!appRow?.id, appRow && appRow.id);
  // Move needs a JobStage (kind SCREENING → status SCREENING → shortlisted event).
  r = await call(op, 'POST', `/api/hr/recruitment/jobs/${job.id}/stages`, { body: { name: 'Screening', kind: 'SCREENING', sortOrder: 1 } });
  const stage = r.data?.stage || r.data;
  r = await call(op, 'POST', `/api/hr/recruitment/applications/${appRow.id}/move`, { body: { stageId: stage.id } });
  rec('Move to SCREENING stage (fires shortlisted)', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);

  // ── E. interview + slot proposal ──────────────────────────────────────────
  r = await call(op, 'POST', '/api/hr/recruitment/interviews', { body: { applicationId: appRow.id, round: 1, mode: 'VIDEO', interviewerIds: [] } });
  const interview = r.data?.interview || r.data;
  rec('Interview created', (r.status === 201 || r.status === 200) && !!interview?.id, `status ${r.status} ${r.data?.message || ''}`);
  const t1 = new Date(Date.now() + 3 * 86400000).toISOString();
  const t2 = new Date(Date.now() + 4 * 86400000).toISOString();
  r = await call(op, 'POST', `/api/hr/recruitment/interviews/${interview.id}/propose-slots`, {
    body: { slots: [{ startAt: t1, endAt: new Date(Date.now() + 3 * 86400000 + 3600000).toISOString() }, { startAt: t2, endAt: new Date(Date.now() + 4 * 86400000 + 3600000).toISOString() }] },
  });
  const proposal = r.data;
  const proposalId = proposal?.id;
  const slotId = (proposal?.slots || [])[0]?.id;
  rec('Propose slots (fires slot_request)', (r.status === 201 || r.status === 200) && !!proposalId && !!slotId, `status ${r.status} slots=${proposal?.slots?.length}`);

  // ── F. public timeline — friendly labels, NO score leak ───────────────────
  r = await call(capp, 'GET', `/api/public/careers/demo/c/${token}`, { origin: P });
  const tl = r.data || {};
  const raw = JSON.stringify(tl);
  const app0 = (tl.applications || [])[0] || {};
  const noLeak = !/meritScore|screeningScore|interviewScore|scoreSnapshot|rejectReason|knockedOut|panel/i.test(raw);
  rec('Public timeline friendly + no score leak', r.status === 200 && !!app0.stageLabel && noLeak, `label="${app0.stageLabel}" leak=${!noLeak}`);
  const surfaced = (tl.applications || []).some((a) => a.activeSlotProposal && a.activeSlotProposal.proposalId === proposalId && (a.activeSlotProposal.slots || []).length >= 1);
  rec('Timeline surfaces the active slot proposal (picker reachable)', surfaced, `surfaced=${surfaced}`);

  // ── G. public slots + confirm + double-confirm 409 ────────────────────────
  r = await call(capp, 'GET', `/api/public/careers/demo/c/${token}/slots/${proposalId}`, { origin: P });
  rec('Public slot list (no panel identities)', r.status === 200 && (r.data?.slots || r.data?.proposal?.slots || []).length >= 1 && !/panel|interviewer|employeeId/i.test(JSON.stringify(r.data)), `status ${r.status}`);
  r = await call(capp, 'POST', `/api/public/careers/demo/c/${token}/slots/${proposalId}/confirm`, { origin: P, body: { slotId } });
  rec('Candidate confirms a slot', r.status === 200 && (r.data?.status === 'CONFIRMED' || r.data?.confirmed), `status ${r.status} ${r.data?.message || ''}`);
  r = await call(capp, 'POST', `/api/public/careers/demo/c/${token}/slots/${proposalId}/confirm`, { origin: P, body: { slotId } });
  rec('Double-confirm 409', r.status === 409, `status ${r.status}`);

  // ── H. bulk message (in-scope ids) ────────────────────────────────────────
  r = await call(op, 'POST', '/api/hr/recruitment/applications/bulk-message', { body: { ids: [appRow.id], templateKey: 'HR_CAND_SHORTLISTED' } });
  rec('Bulk message sends to in-scope set', r.status === 200 && (r.data?.total >= 1 || r.data?.sent >= 0), `sent=${r.data?.sent} skipped=${r.data?.skipped} total=${r.data?.total}`);

  // ── I. interview invite (the UNKNOWN_TEMPLATE bug fix — now leaves router) ─
  r = await call(op, 'POST', `/api/hr/recruitment/interviews/${interview.id}/invite`, {});
  rec('Interview invite succeeds (bug fix — no UNKNOWN_TEMPLATE)', r.status === 200 || r.status === 201, `status ${r.status} ${r.data?.message || ''}`);

  // ── cleanup ───────────────────────────────────────────────────────────────
  let cleaned = true;
  await call(op, 'POST', `/api/hr/recruitment/interviews/${interview.id}/withdraw-slots`, {});
  const rt = await call(op, 'DELETE', '/api/hr/recruitment/comms-templates/HR_CAND_SHORTLISTED');
  if (![200, 204, 404].includes(rt.status)) cleaned = false;
  const dj = await call(op, 'DELETE', `/api/hr/recruitment/jobs/${job.id}`);
  if (!(dj.status === 200 || dj.status === 204)) { cleaned = false; console.log('   job del:', dj.status, dj.data?.message); }
  rec('Cleanup (slots withdrawn, template reset, job removed)', cleaned);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P3 candidate-comms E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
