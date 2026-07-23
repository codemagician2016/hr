'use strict';

/**
 * feedSocial.js — PURE (no DB, no I/O) helpers for the feed social layer
 * (reactions + comments + @mentions). Every function here is deterministic and
 * unit-tested in __tests__/feedSocial.unit.test.js. The DB/notification wiring
 * lives in feedSocial.service.js, which composes these.
 *
 * Four primitives:
 *   1. parseMentions(body)           → extract @handle tokens (dedup, ignore emails
 *                                       + code fences/inline code).
 *   2. summarizeReactions(rows, me)  → { counts, total, myReaction } for one post.
 *   3. assembleThread(comments)      → top-level + one level of replies, with the
 *                                       soft-deleted "[deleted]" placeholder rule.
 *   4. resolveNotificationTargets()  → who gets a comment/mention notification
 *                                       (author≠actor, self-mention out, no dupes).
 */

// The set of reaction kinds the product ships with. `kind` is stored as a free
// String so a new reaction never needs a migration; this list is the validation
// allowlist + the canonical summary ordering. Callers may extend it.
const REACTION_KINDS = Object.freeze(['LIKE', 'CELEBRATE', 'SUPPORT', 'INSIGHTFUL', 'LOVE']);

const DELETED_PLACEHOLDER = '[deleted]';

// ── 1. @mention parser ───────────────────────────────────────────────────────
//
// MENTION SYNTAX (documented):
//   @[token]   bracketed — the token may contain spaces / dots so a full name or an
//              email-like handle works: "@[Jane Doe]", "@[jane.doe@acme.com]",
//              "@[EMP-0007]".
//   @handle    bare — a run of [A-Za-z0-9._+-] (a code / single-word handle / email
//              local-part). A bare @ only starts a mention at the start of the string
//              or after whitespace/punctuation, so an EMAIL (john@acme.com — the @ is
//              preceded by a word char) is NEVER read as a mention.
// Content inside fenced code blocks (``` … ```) and inline code (` … `) is ignored.
// Returns the raw token strings, de-duplicated case-insensitively (first-seen order).
// Resolution of a token → employee happens in the service (via the directory).
function stripCode(body) {
  // Remove fenced blocks first (``` … ```), then inline spans (` … `). Non-greedy.
  return String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

function parseMentions(body) {
  const text = stripCode(body);
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const token = String(raw || '').trim();
    if (!token) return;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  };

  // SINGLE-PASS scan so tokens come out in true document order (first-seen), regardless
  // of whether they are the bracket or the bare form. Two alternatives:
  //   group 1 → @[ … ]  bracketed (may contain spaces / dots / an @).
  //   group 3 → bare @token, where group 2 is the required leading boundary — the char
  //             before '@' must NOT be a word/email char, so "john@acme.com" (the @ is
  //             preceded by 'n') is never a mention.
  const re = /@\[([^\]]+)\]|(^|[^A-Za-z0-9._%+-])@([A-Za-z0-9._+-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) { push(m[1]); continue; }
    // Bare token — trim trailing punctuation (a sentence-final dot).
    push(String(m[3]).replace(/[.]+$/, ''));
  }
  return out;
}

// ── 2. reaction-summary aggregator ───────────────────────────────────────────
//
// rows: [{ kind, employeeId }] — every reaction on ONE post (single-reaction model,
// so at most one row per employeeId). myEmployeeId: the caller (or null).
// Returns { counts: { KIND: n, … } (only non-zero), total, myReaction: KIND|null }.
function summarizeReactions(rows, myEmployeeId) {
  const counts = {};
  let total = 0;
  let myReaction = null;
  for (const r of rows || []) {
    if (!r || !r.kind) continue;
    counts[r.kind] = (counts[r.kind] || 0) + 1;
    total += 1;
    if (myEmployeeId && r.employeeId === myEmployeeId) myReaction = r.kind;
  }
  return { counts, total, myReaction };
}

// Aggregate summaries for MANY posts at once. `rows` spans several announcements;
// returns Map<announcementId, summary>. Used to enrich a feed page in one pass.
function summarizeReactionsByPost(rows, myEmployeeId) {
  const byPost = new Map();
  for (const r of rows || []) {
    if (!r || !r.announcementId) continue;
    if (!byPost.has(r.announcementId)) byPost.set(r.announcementId, []);
    byPost.get(r.announcementId).push(r);
  }
  const out = new Map();
  for (const [annId, list] of byPost) out.set(annId, summarizeReactions(list, myEmployeeId));
  return out;
}

// ── 3. threaded-comment assembler ────────────────────────────────────────────
//
// Input: a FLAT list of comment rows for one post, each shaped
//   { id, parentId, deletedAt, body, authorEmployeeId, ... }
// Output: an array of top-level nodes, each with a `replies` array (one level deep).
// Rules:
//   - A live (deletedAt == null) comment renders normally.
//   - A soft-deleted comment is OMITTED, UNLESS it is a top-level comment that still
//     has at least one LIVE reply — then it renders as a "[deleted]" placeholder
//     (body replaced, author stripped, `deleted: true`) so the thread keeps its shape.
//   - A soft-deleted REPLY (a leaf) is always omitted.
// `shape` maps a raw row → the DTO; it receives (row, { deleted }). Ordering of the
// input is preserved (callers pre-sort by createdAt asc).
function assembleThread(comments, shape) {
  const toDto = typeof shape === 'function'
    ? shape
    : (row, meta) => ({
        id: row.id,
        parentId: row.parentId || null,
        body: meta.deleted ? DELETED_PLACEHOLDER : row.body,
        authorEmployeeId: meta.deleted ? null : row.authorEmployeeId,
        deleted: !!meta.deleted,
        editedAt: meta.deleted ? null : (row.editedAt || null),
        createdAt: row.createdAt,
      });

  const rows = Array.isArray(comments) ? comments : [];
  const tops = rows.filter((c) => !c.parentId);
  const repliesByParent = new Map();
  for (const c of rows) {
    if (!c.parentId) continue;
    if (!repliesByParent.has(c.parentId)) repliesByParent.set(c.parentId, []);
    repliesByParent.get(c.parentId).push(c);
  }

  const out = [];
  for (const top of tops) {
    const rawReplies = repliesByParent.get(top.id) || [];
    const liveReplies = rawReplies.filter((r) => !r.deletedAt);
    const isDeleted = !!top.deletedAt;
    // A deleted top-level with no live replies vanishes entirely.
    if (isDeleted && liveReplies.length === 0) continue;
    const node = toDto(top, { deleted: isDeleted });
    node.replies = liveReplies.map((r) => toDto(r, { deleted: false }));
    node.replyCount = node.replies.length;
    out.push(node);
  }
  return out;
}

// ── 4. notification-target resolution ────────────────────────────────────────
//
// Decide who gets notified when `actorId` comments on a post authored by
// `postAuthorId`, mentioning `mentionedIds`. Operates on a SINGLE id-space (the
// service runs it in User-id space); pure set logic:
//   - commentTarget = postAuthorId, only when it exists AND differs from the actor
//     (never notify yourself about your own comment).
//   - mentionTargets = unique(mentionedIds) minus the actor (self-mention excluded)
//     minus the commentTarget (the author already gets the comment notification — no
//     double-notify).
function resolveNotificationTargets({ postAuthorId, actorId, mentionedIds } = {}) {
  const commentTarget = postAuthorId && postAuthorId !== actorId ? postAuthorId : null;
  const seen = new Set();
  const mentionTargets = [];
  for (const id of mentionedIds || []) {
    if (!id) continue;
    if (id === actorId) continue;            // self-mention excluded
    if (id === commentTarget) continue;      // already covered by the comment notif
    if (seen.has(id)) continue;              // dedupe
    seen.add(id);
    mentionTargets.push(id);
  }
  return { commentTarget, mentionTargets };
}

module.exports = {
  REACTION_KINDS,
  DELETED_PLACEHOLDER,
  parseMentions,
  summarizeReactions,
  summarizeReactionsByPost,
  assembleThread,
  resolveNotificationTargets,
};
