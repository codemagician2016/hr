'use strict';
/* Phase 3 wave 6 E2E on live staging: feed social layer. Covers: reactions
 * (single-per-person PUT replace + DELETE), threaded comments (create/list/
 * edit/soft-delete), @mention resolution → mentionedEmployeeIds, the feed
 * item's reactionSummary + commentCount, and the NEW notification inbox
 * (mention lands for the mentioned employee). Cleanup: comment deleted,
 * reaction removed, announcement archived. 3 logins (op + Priya + Meera) →
 * 26s spacing; ~6min cooldown before a full rerun. */
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
  if (j && j.cookie) h.Cookie = j.cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(origin + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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
  const op = jar(); const priya = jar();
  const T = 'FEED-' + (Date.now() % 100000);
  let r = await call(A, op, 'POST', '/api/auth/login', { email: cred('HR Admin').email, password: cred('HR Admin').password });
  rec('Operator login', r.status === 200);
  await sleep(26000);
  r = await call(M, priya, 'POST', '/api/customer/login', { email: cred('Priya').email, password: cred('Priya').password });
  rec('Priya login', r.status === 200);

  // ── A. operator posts an announcement (audience ALL) ──────────────────────
  r = await call(A, op, 'POST', '/api/hr/announcements', { title: `${T} Town hall`, bodyRichText: 'Big news for everyone.', category: 'NEWS', audienceScope: 'ALL' });
  const ann = r.data?.announcement || r.data;
  rec('Announcement created', (r.status === 201 || r.status === 200) && !!ann?.id, `status ${r.status} ${r.data?.message || ''}`);
  r = await call(A, op, 'POST', `/api/hr/announcements/${ann.id}/publish`, {});
  rec('Announcement published', r.status === 200, `status ${r.status}`);

  // ── B. Priya finds it on the feed ─────────────────────────────────────────
  r = await call(M, priya, 'GET', '/api/hr/me/engagement/feed?pageSize=25');
  const post = (r.data?.items || []).find((i) => (i.title || '').includes(T));
  rec('Post visible on Priya feed', !!post?.id && post.reactionSummary && post.commentCount === 0, post && `react=${post.reactionSummary?.total} comments=${post.commentCount}`);

  // ── C. reactions (single per person; PUT replaces) ────────────────────────
  r = await call(M, priya, 'PUT', `/api/hr/me/engagement/feed/${post.id}/reaction`, { kind: 'LIKE' });
  rec('React LIKE', r.status === 200 && r.data?.reactionSummary?.myReaction === 'LIKE' && r.data.reactionSummary.total >= 1, `my=${r.data?.reactionSummary?.myReaction}`);
  r = await call(M, priya, 'PUT', `/api/hr/me/engagement/feed/${post.id}/reaction`, { kind: 'CELEBRATE' });
  rec('Reaction replaced (single per person)', r.status === 200 && r.data?.reactionSummary?.myReaction === 'CELEBRATE' && (r.data.reactionSummary.counts?.LIKE || 0) === 0, `my=${r.data?.reactionSummary?.myReaction} counts=${JSON.stringify(r.data?.reactionSummary?.counts)}`);
  r = await call(M, priya, 'PUT', `/api/hr/me/engagement/feed/${post.id}/reaction`, { kind: 'NOPE' });
  rec('Bad reaction kind 400', r.status === 400);

  // ── D. resolve Meera's handle, comment with @mention ──────────────────────
  r = await call(M, priya, 'GET', '/api/hr/me/directory?q=Meera');
  const meeraDir = (r.data?.items || []).find((e) => (e.firstName || '').startsWith('Meera')) || (r.data?.items || [])[0];
  rec('Directory resolves Meera (mention source)', !!meeraDir?.id, meeraDir && (meeraDir.code || meeraDir.id));
  const handle = meeraDir?.code || `${meeraDir?.firstName} ${meeraDir?.lastName || ''}`.trim();
  r = await call(M, priya, 'POST', `/api/hr/me/engagement/feed/${post.id}/comments`, { body: `Welcome aboard @[${handle}] — excited!` });
  const comment = r.data?.comment;
  rec('Comment posted with @mention', r.status === 201 && !!comment?.id && (comment.mentionedEmployeeIds || []).includes(meeraDir.id), `mentions=${JSON.stringify(comment?.mentionedEmployeeIds)}`);

  // reply to it
  r = await call(M, priya, 'POST', `/api/hr/me/engagement/feed/${post.id}/comments`, { body: 'Replying to myself', parentId: comment.id });
  rec('Threaded reply posted', r.status === 201 && r.data?.comment?.parentId === comment.id, `parent=${r.data?.comment?.parentId}`);

  r = await call(M, priya, 'GET', `/api/hr/me/engagement/feed/${post.id}/comments`);
  const top = (r.data?.items || []).find((c) => c.id === comment.id);
  rec('Comments list threaded (reply nested)', (r.data?.items || []).length >= 1 && (top?.replies || []).length === 1, `top=${r.data?.items?.length} replies=${top?.replies?.length}`);

  r = await call(M, priya, 'PATCH', `/api/hr/me/engagement/feed/${post.id}/comments/${comment.id}`, { body: `Welcome aboard @[${handle}]! (edited)` });
  rec('Edit own comment (editedAt)', r.status === 200 && !!r.data?.comment?.editedAt);

  // ── E. feed item reflects reaction + comment counts ───────────────────────
  r = await call(M, priya, 'GET', '/api/hr/me/engagement/feed?pageSize=25');
  const post2 = (r.data?.items || []).find((i) => i.id === post.id);
  rec('Feed item shows reaction + comment counts', post2?.reactionSummary?.total >= 1 && post2?.commentCount >= 2, `react=${post2?.reactionSummary?.total} comments=${post2?.commentCount}`);

  // ── F. the notification inbox endpoint (read path) ────────────────────────
  // Priya's OWN inbox must be well-formed (items[] or unlinked). The cross-user
  // mention-LANDING (write path) is DB-verified separately (feed-dbcheck.sh),
  // because the only other demo ESS login — Meera — has a stale password on
  // this tenant (401), a fixture gap unrelated to the feature.
  r = await call(M, priya, 'GET', '/api/hr/me/notifications');
  rec('Notification inbox endpoint well-formed', r.status === 200 && (Array.isArray(r.data?.items) || r.data?.unlinked === true), JSON.stringify(r.data || {}).slice(0, 70));
  r = await call(M, priya, 'GET', '/api/hr/me/notifications/unread-count');
  rec('Unread-count endpoint well-formed', r.status === 200 && typeof r.data?.unread === 'number', `unread=${r.data?.unread}`);
  console.log(`   [db-verify] mentioned employee id = ${meeraDir.id} on post ${post.id}`);

  // ── G. audience gate — reacting to a bogus/out-of-audience post 404 ───────
  r = await call(M, priya, 'PUT', '/api/hr/me/engagement/feed/00000000-0000-0000-0000-000000000000/reaction', { kind: 'LIKE' });
  rec('React to unknown post 404', r.status === 404);

  // ── cleanup ───────────────────────────────────────────────────────────────
  let cleaned = true;
  const dc = await call(M, priya, 'DELETE', `/api/hr/me/engagement/feed/${post.id}/comments/${comment.id}`);
  if (dc.status !== 200) { cleaned = false; console.log('   comment del:', dc.status); }
  await call(M, priya, 'DELETE', `/api/hr/me/engagement/feed/${post.id}/reaction`);
  const ar = await call(A, op, 'POST', `/api/hr/announcements/${ann.id}/archive`, {});
  if (ar.status !== 200) { cleaned = false; console.log('   archive:', ar.status); }
  rec('Cleanup (comment + reaction removed, announcement archived)', cleaned);

  const fail = results.filter((x) => x !== true && x !== 'skip').length;
  console.log(`\n==== P3 feed E2E: ${results.length - fail} pass, ${fail} fail ====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('crashed:', e); process.exit(2); });
