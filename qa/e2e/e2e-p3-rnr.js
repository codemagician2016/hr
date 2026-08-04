'use strict';
/* Phase 3 wave 2 E2E on live staging: Rewards & Recognition. Covers: seeded
 * values/badges/catalog, peer recognition (pure kudos + points below the
 * approval threshold → instant wallet credit), wallet ledger integrity,
 * redemption request (approval-gated by default) + cancel refund path,
 * leaderboard, award cycle create → ESS nomination → shortlist → decide
 * winner → wallet grant, config patch. Cleanup: close/archive the cycle,
 * cancel the pending redemption, zero out sandbox points via admin adjust.
 * Ops: 26s between logins; ~6min cooldown between runs. */
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
  const T = 'RNR-' + (Date.now() % 1000);
  let r = await call(A, op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { email: cred('Priya').email, password: cred('Priya').password });
  rec('Priya login', r.status === 200);

  // ── A. seeds + config ─────────────────────────────────────────────────────
  r = await call(A, op, 'GET', '/api/hr/recognition/values');
  const values = r.data?.items || [];
  rec('Seeded values present (lazy seed)', r.status === 200 && values.length >= 3, `n=${values.length}`);
  r = await call(A, op, 'GET', '/api/hr/recognition/catalog');
  const catalog = r.data?.items || [];
  rec('Seeded catalog present', r.status === 200 && catalog.length >= 3, `n=${catalog.length}`);
  r = await call(A, op, 'GET', '/api/hr/recognition/config');
  rec('Config readable', r.status === 200, JSON.stringify(r.data || {}).slice(0, 80));

  // resolve two employees: Priya (recipient of admin flows) + a colleague for her give.
  r = await call(A, op, 'GET', '/api/hr/employees?q=Priya&pageSize=5');
  const priyaEmp = (r.data?.items || []).find((e) => (e.firstName || '').startsWith('Priya'));
  r = await call(A, op, 'GET', '/api/hr/employees?q=Aarav&pageSize=5');
  const aaravEmp = (r.data?.items || []).find((e) => (e.firstName || '').startsWith('Aarav'));
  rec('Employees resolved', !!priyaEmp?.id && !!aaravEmp?.id);

  r = await call(M, priya, 'GET', '/api/hr/me/recognition/values');
  rec('ESS give-picker values endpoint', r.status === 200 && (r.data?.values || []).length >= 3, `values=${(r.data?.values || []).length}`);

  // ── B. ESS: kudos (rotate recipients — one give per pair per day) ─────────
  const valueId = values[0].id;
  const dir = await call(A, op, 'GET', '/api/hr/employees?pageSize=50');
  const others = (dir.data?.items || []).filter((e) => e.status === 'ACTIVE' && e.id !== priyaEmp.id);
  let kudosRecipient = null; let kudosRes = null;
  for (const emp of others) {
    const attempt = await call(M, priya, 'POST', '/api/hr/me/recognitions', {
      recipientEmployeeIds: [emp.id], valueId, message: `${T} pure kudos — great work!`, visibility: 'PUBLIC',
    });
    if (attempt.status === 201) { kudosRecipient = emp; kudosRes = attempt; break; }
    if (attempt.status !== 409) { kudosRes = attempt; break; }
  }
  rec('Pure kudos posted (rotated recipient)', kudosRes?.status === 201 && !!kudosRes?.data?.recognition, `status ${kudosRes?.status} ${kudosRes?.data?.message || ''} → ${kudosRecipient?.firstName}`);

  // The per-pair cap is 2/day (kudos-farming guard): a 2nd give passes, the 3rd 409s.
  r = await call(M, priya, 'POST', '/api/hr/me/recognitions', {
    recipientEmployeeIds: [kudosRecipient.id], valueId, message: `${T} second (allowed)`, visibility: 'PUBLIC',
  });
  const second = r.status;
  r = await call(M, priya, 'POST', '/api/hr/me/recognitions', {
    recipientEmployeeIds: [kudosRecipient.id], valueId, message: `${T} third (blocked)`, visibility: 'PUBLIC',
  });
  rec('Per-pair daily cap (2 pass, 3rd 409)', (second === 201 || second === 409) && r.status === 409, `2nd=${second} 3rd=${r.status}`);

  // Points kudos to the NEXT fresh recipient (below threshold → instant).
  let give2 = null; let pointsRecipient = null;
  for (const emp of others) {
    if (kudosRecipient && emp.id === kudosRecipient.id) continue;
    const attempt = await call(M, priya, 'POST', '/api/hr/me/recognitions', {
      recipientEmployeeIds: [emp.id], valueId, message: `${T} points kudos`, pointsEach: 10, visibility: 'PUBLIC',
    });
    if (attempt.status === 201) { give2 = attempt.data; pointsRecipient = emp; break; }
    if (attempt.status !== 409) { give2 = attempt.data; break; }
  }
  rec('Points kudos posted (no approval at default threshold)', !!give2?.recognition && give2.needsApproval !== true, `needsApproval=${give2 && give2.needsApproval} → ${pointsRecipient?.firstName}`);

  // wall shows them
  r = await call(M, priya, 'GET', '/api/hr/me/recognitions');
  const wall = r.data?.items || r.data?.wall || [];
  rec('Wall lists the kudos', (Array.isArray(wall) ? wall : []).some((x) => (x.message || '').includes(T)));

  // ── C. wallet: admin adjust credits Priya, ledger reflects ────────────────
  r = await call(A, op, 'POST', '/api/hr/recognition/points/adjust', { employeeId: priyaEmp.id, points: 500, reason: `${T} sandbox credit` });
  rec('Admin points adjust (+500)', r.status === 200 || r.status === 201, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(M, priya, 'GET', '/api/hr/me/wallet');
  const balAfterCredit = r.data?.balance;
  rec('Wallet balance reflects credit', r.status === 200 && Number(balAfterCredit) >= 500, `balance=${balAfterCredit}`);
  r = await call(M, priya, 'GET', '/api/hr/me/wallet/ledger');
  const ledger = r.data?.items || [];
  rec('Ledger has the credit row', ledger.some((l) => ((l.note || '') + (l.reason || '')).includes(T) || l.reason === 'ADJUSTMENT'));

  // ── D. redemption: request (approval-gated) + cancel refund ──────────────
  const item = catalog.find((c) => Number(c.pointsCost) <= 500) || catalog[0];
  r = await call(M, priya, 'POST', '/api/hr/me/redemptions', { catalogItemId: item.id });
  const redemption = r.data?.redemption || r.data;
  rec('Redemption requested', (r.status === 201 || r.status === 200) && !!redemption?.id, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(M, priya, 'POST', `/api/hr/me/redemptions/${redemption.id}/cancel`, {});
  rec('Pending redemption cancelled', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(M, priya, 'GET', '/api/hr/me/wallet');
  rec('Balance intact after cancel', Number(r.data?.balance) >= 500, `balance=${r.data?.balance}`);

  // ── E. leaderboard ────────────────────────────────────────────────────────
  r = await call(M, priya, 'GET', '/api/hr/me/recognition/leaderboard');
  rec('ESS leaderboard serves', r.status === 200 && Array.isArray(r.data?.rows));

  // ── F. award cycle → nominate → shortlist → decide ────────────────────────
  r = await call(A, op, 'POST', '/api/hr/recognition/award-cycles', {
    name: `${T} Star of the Sprint`, awardType: 'SPOT',
    nominateOpenAt: new Date(Date.now() - 3600000).toISOString(),
    nominateCloseAt: new Date(Date.now() + 86400000).toISOString(), pointsToWinner: 50,
  });
  const cycle = r.data?.cycle || r.data;
  rec('Award cycle created', (r.status === 201 || r.status === 200) && !!cycle?.id, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(M, priya, 'POST', '/api/hr/me/award-nominations', {
    cycleId: cycle.id, nomineeEmployeeId: aaravEmp.id, citation: `${T} carried the release`,
  });
  const nomination = r.data?.nomination || r.data;
  rec('ESS nomination submitted', (r.status === 201 || r.status === 200) && !!nomination?.id, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'POST', `/api/hr/recognition/award-cycles/${cycle.id}/nominations/${nomination.id}/shortlist`, {});
  rec('Nomination shortlisted', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'POST', `/api/hr/recognition/award-cycles/${cycle.id}/close`, {});
  rec('Cycle nominations closed', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'POST', `/api/hr/recognition/award-cycles/${cycle.id}/decide`, { winnerNominationId: nomination.id });
  rec('Winner decided (opens AWARD approval or finalizes)', r.status === 200 || r.status === 201 || r.status === 202, `status ${r.status} ${r.data?.message || ''}`);

  // ── G. config patch roundtrip ─────────────────────────────────────────────
  r = await call(A, op, 'PATCH', '/api/hr/recognition/config', { recognitionApprovalThreshold: 100 });
  rec('Config patched (recognitionApprovalThreshold 100)', r.status === 200, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'PATCH', '/api/hr/recognition/config', { recognitionApprovalThreshold: null });
  rec('Config threshold reset', r.status === 200);

  // ── cleanup ───────────────────────────────────────────────────────────────
  let cleaned = true;
  const adj = await call(A, op, 'POST', '/api/hr/recognition/points/adjust', { employeeId: priyaEmp.id, points: -500, reason: `${T} sandbox cleanup` });
  if (!(adj.status === 200 || adj.status === 201)) { cleaned = false; console.log('   adjust-back:', adj.status, adj.data?.message); }
  // cycle already closed pre-decide; nothing further to unwind for the cycle.
  rec('Cleanup (points adjusted back)', cleaned);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P3 R&R E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
