'use strict';

/*
 * feedSocial.unit.test.js — the PURE feed social layer (feedSocial.js). Plain-node,
 * NO DB (mirrors reports/__tests__ style):
 *   node backend/src/hr/engagement/__tests__/feedSocial.unit.test.js
 *
 * Covers: the @mention parser (extract/dedupe/ignore emails+code-fences), the
 * reaction-summary aggregator (counts per kind + myReaction, single-reaction model),
 * the threaded-comment assembler (top-level + one level of replies + the soft-deleted
 * "[deleted]" placeholder rule), and notification-target resolution (author≠actor,
 * distinct mentions, self-mention excluded, no double-notify).
 */

const assert = require('assert');
const {
  parseMentions,
  summarizeReactions,
  summarizeReactionsByPost,
  assembleThread,
  resolveNotificationTargets,
} = require('../feedSocial');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }
function eq(name, a, b) { assert.deepStrictEqual(a, b, name); passed += 1; }

function main() {
  /* ── 1. @mention parser ─────────────────────────────────────────────────── */
  {
    // Bare handles + bracketed full names.
    eq('bare + bracket tokens',
      parseMentions('hey @EMP-0007 and @[Jane Doe], welcome!'),
      ['EMP-0007', 'Jane Doe']);

    // Emails are NOT mentions (the @ is preceded by a word char).
    eq('email is not a mention',
      parseMentions('ping me at john@acme.com please'),
      []);

    // A bracketed email-like handle IS a mention (explicit).
    eq('bracketed email handle',
      parseMentions('cc @[jane.doe@acme.com]'),
      ['jane.doe@acme.com']);

    // Dedup is case-insensitive, first-seen order preserved.
    eq('dedupe case-insensitive',
      parseMentions('@alice @Alice @bob @ALICE'),
      ['alice', 'bob']);

    // Code fences + inline code are ignored.
    eq('ignore fenced code',
      parseMentions('see ```\n@notamention\n``` but @real counts'),
      ['real']);
    eq('ignore inline code',
      parseMentions('`@nope` yet @yep'),
      ['yep']);

    // Trailing punctuation on a bare handle is trimmed.
    eq('trailing punctuation trimmed',
      parseMentions('thanks @carol.'),
      ['carol']);

    // Empty / nullish input is safe.
    eq('empty body → []', parseMentions(''), []);
    eq('null body → []', parseMentions(null), []);

    // @ at start of string.
    eq('mention at start', parseMentions('@lead please review'), ['lead']);
  }

  /* ── 2. reaction-summary aggregator (single-reaction model) ─────────────── */
  {
    const rows = [
      { kind: 'LIKE', employeeId: 'e1' },
      { kind: 'LIKE', employeeId: 'e2' },
      { kind: 'CELEBRATE', employeeId: 'e3' },
      { kind: 'LOVE', employeeId: 'me' },
    ];
    const s = summarizeReactions(rows, 'me');
    eq('counts per kind', s.counts, { LIKE: 2, CELEBRATE: 1, LOVE: 1 });
    ok('total is 4', s.total === 4);
    ok('myReaction resolved', s.myReaction === 'LOVE');

    const none = summarizeReactions(rows, 'stranger');
    ok('myReaction null when caller has not reacted', none.myReaction === null);
    ok('total unaffected by caller', none.total === 4);

    const empty = summarizeReactions([], 'me');
    eq('empty counts', empty.counts, {});
    ok('empty total 0', empty.total === 0 && empty.myReaction === null);

    // Batch across posts.
    const multi = [
      { announcementId: 'a1', kind: 'LIKE', employeeId: 'e1' },
      { announcementId: 'a1', kind: 'LOVE', employeeId: 'me' },
      { announcementId: 'a2', kind: 'SUPPORT', employeeId: 'e9' },
    ];
    const byPost = summarizeReactionsByPost(multi, 'me');
    ok('a1 summary total 2', byPost.get('a1').total === 2);
    ok('a1 myReaction LOVE', byPost.get('a1').myReaction === 'LOVE');
    ok('a2 summary total 1', byPost.get('a2').total === 1);
    ok('a2 myReaction null', byPost.get('a2').myReaction === null);
  }

  /* ── 3. threaded-comment assembler ──────────────────────────────────────── */
  {
    const t = (iso) => new Date(iso);
    const rows = [
      { id: 'c1', parentId: null, deletedAt: null, body: 'top one', authorEmployeeId: 'a', createdAt: t('2026-01-01') },
      { id: 'r1', parentId: 'c1', deletedAt: null, body: 'reply to c1', authorEmployeeId: 'b', createdAt: t('2026-01-02') },
      { id: 'c2', parentId: null, deletedAt: t('2026-01-03'), body: 'deleted parent', authorEmployeeId: 'a', createdAt: t('2026-01-01') },
      { id: 'r2', parentId: 'c2', deletedAt: null, body: 'live reply under deleted parent', authorEmployeeId: 'c', createdAt: t('2026-01-04') },
      { id: 'c3', parentId: null, deletedAt: t('2026-01-05'), body: 'deleted parent no live replies', authorEmployeeId: 'a', createdAt: t('2026-01-01') },
      { id: 'r3', parentId: 'c3', deletedAt: t('2026-01-06'), body: 'also deleted reply', authorEmployeeId: 'd', createdAt: t('2026-01-06') },
      { id: 'r4', parentId: 'c1', deletedAt: t('2026-01-07'), body: 'deleted reply on live parent', authorEmployeeId: 'e', createdAt: t('2026-01-07') },
    ];
    const thread = assembleThread(rows);

    // c1 (live) with one live reply r1 (the deleted reply r4 is dropped).
    const c1 = thread.find((n) => n.id === 'c1');
    ok('c1 present', !!c1);
    ok('c1 not deleted', c1.deleted === false && c1.body === 'top one');
    ok('c1 has exactly one live reply', c1.replies.length === 1 && c1.replies[0].id === 'r1');
    ok('c1 replyCount', c1.replyCount === 1);

    // c2 (deleted) survives as a placeholder because r2 is a live reply.
    const c2 = thread.find((n) => n.id === 'c2');
    ok('c2 present as placeholder', !!c2 && c2.deleted === true);
    ok('c2 body is [deleted]', c2.body === '[deleted]');
    ok('c2 author stripped', c2.authorEmployeeId === null);
    ok('c2 keeps its live reply', c2.replies.length === 1 && c2.replies[0].id === 'r2');

    // c3 (deleted, no live replies) vanishes entirely.
    ok('c3 omitted', !thread.find((n) => n.id === 'c3'));

    // No orphan replies at the top level.
    ok('no replies leaked to top level', thread.every((n) => !n.parentId));
    ok('exactly two top-level nodes', thread.length === 2);
  }

  /* ── 4. notification-target resolution ──────────────────────────────────── */
  {
    // Author distinct from actor + two mentions (one is the actor → excluded).
    const r1 = resolveNotificationTargets({
      postAuthorId: 'author', actorId: 'actor', mentionedIds: ['m1', 'actor', 'm2'],
    });
    ok('commentTarget is author', r1.commentTarget === 'author');
    eq('mentions exclude self, deduped', r1.mentionTargets, ['m1', 'm2']);

    // Author == actor → no self comment notification.
    const r2 = resolveNotificationTargets({
      postAuthorId: 'x', actorId: 'x', mentionedIds: ['m1'],
    });
    ok('no self comment notif', r2.commentTarget === null);
    eq('mentions still delivered', r2.mentionTargets, ['m1']);

    // Author also mentioned → gets the comment notif only (no double-notify).
    const r3 = resolveNotificationTargets({
      postAuthorId: 'author', actorId: 'actor', mentionedIds: ['author', 'm3', 'm3'],
    });
    ok('r3 commentTarget author', r3.commentTarget === 'author');
    eq('author dropped from mentions, m3 deduped', r3.mentionTargets, ['m3']);

    // No author (machine post) → mentions only.
    const r4 = resolveNotificationTargets({
      postAuthorId: null, actorId: 'actor', mentionedIds: ['m1', 'm2'],
    });
    ok('no author → no comment target', r4.commentTarget === null);
    eq('mentions delivered', r4.mentionTargets, ['m1', 'm2']);

    // Self-only mention → nobody notified.
    const r5 = resolveNotificationTargets({
      postAuthorId: 'me', actorId: 'me', mentionedIds: ['me'],
    });
    ok('self comment excluded', r5.commentTarget === null);
    eq('self mention excluded', r5.mentionTargets, []);
  }

  console.log(`feedSocial.unit: ${passed} checks passed`);
}

main();
