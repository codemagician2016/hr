'use strict';

/**
 * feedSocial.service.js — the DB + notification wiring for the feed social layer
 * (reactions + comments + @mentions). All the deterministic logic lives in the
 * PURE feedSocial.js; this module is the I/O boundary (Prisma + Notification rows).
 *
 * Tenant isolation: businessId is ANDed into every where. Audience gating: a caller
 * may only react/comment on a post that feedWhereForEmployee() would return for them
 * (assertInAudience) — no reacting to an out-of-audience announcement.
 *
 * Notifications are IN-APP only for v1 (Notification rows → the ESS inbox at
 * /me/notifications). Multi-channel push (email/SMS/WhatsApp) is intentionally NOT
 * wired here — comment/mention pings are high-volume and low-urgency; the in-app
 * inbox is the source of truth. (A HR_FEED_MENTION template can be added later.)
 * Notification writes are best-effort and NEVER throw into the request.
 */

const prisma = require('../../core/lib/prisma');
const { feedWhereForEmployee, resolveEmployeeSegment } = require('./audience');
const {
  REACTION_KINDS,
  parseMentions,
  summarizeReactions,
  summarizeReactionsByPost,
  assembleThread,
  resolveNotificationTargets,
} = require('./feedSocial');

const BODY_MAX = 8000;
const MENTION_TOKEN_CAP = 25;

function fullName(e) {
  if (!e) return 'A colleague';
  return e.preferredName || [e.firstName, e.lastName].filter(Boolean).join(' ') || e.code || 'A colleague';
}

/**
 * Return the announcement row IFF it is in THIS employee's audience (published +
 * in-window + audience match), else null. This is the react/comment gate — it reuses
 * the exact feed chokepoint so the social surface can never touch an out-of-audience
 * post. Selects the fields the notification fan-out needs (authorUserId/authorName).
 */
async function getInAudiencePost(businessId, employee, announcementId) {
  const segment = await resolveEmployeeSegment(businessId, employee.id);
  const where = feedWhereForEmployee({ businessId, employeeId: employee.id, segment, now: new Date() });
  return prisma.announcement.findFirst({
    where: { ...where, id: announcementId },
    select: { id: true, businessId: true, title: true, authorUserId: true, authorName: true },
  });
}

// ── Reactions ────────────────────────────────────────────────────────────────

function normalizeKind(raw) {
  const k = String(raw || '').trim().toUpperCase();
  return REACTION_KINDS.includes(k) ? k : null;
}

/**
 * Upsert the caller's SINGLE reaction on a post (react-again replaces the kind).
 * Returns { reaction, summary } or throws a tagged error (BAD_KIND / NOT_IN_AUDIENCE).
 */
async function setReaction(businessId, employee, announcementId, rawKind) {
  const kind = normalizeKind(rawKind);
  if (!kind) { const e = new Error('Unknown reaction kind'); e.code = 'BAD_KIND'; throw e; }
  const post = await getInAudiencePost(businessId, employee, announcementId);
  if (!post) { const e = new Error('Post not found'); e.code = 'NOT_IN_AUDIENCE'; throw e; }

  const reaction = await prisma.feedReaction.upsert({
    where: { announcementId_employeeId: { announcementId, employeeId: employee.id } },
    create: { businessId, announcementId, employeeId: employee.id, kind },
    update: { kind },
  });
  const summary = await reactionSummary(businessId, announcementId, employee.id);
  return { reaction, summary };
}

/** Remove the caller's reaction (idempotent). Returns the fresh summary. */
async function removeReaction(businessId, employee, announcementId) {
  const post = await getInAudiencePost(businessId, employee, announcementId);
  if (!post) { const e = new Error('Post not found'); e.code = 'NOT_IN_AUDIENCE'; throw e; }
  await prisma.feedReaction.deleteMany({ where: { businessId, announcementId, employeeId: employee.id } });
  return reactionSummary(businessId, announcementId, employee.id);
}

/** { counts, total, myReaction } for one post + caller. */
async function reactionSummary(businessId, announcementId, myEmployeeId) {
  const rows = await prisma.feedReaction.findMany({
    where: { businessId, announcementId },
    select: { kind: true, employeeId: true },
  });
  return summarizeReactions(rows, myEmployeeId);
}

/**
 * Batch enrichment for a feed PAGE: one reaction query + one comment-count groupBy
 * across all announcement ids. Returns Map<annId, { reactionSummary, commentCount }>.
 */
async function socialByPosts(businessId, announcementIds, myEmployeeId) {
  const ids = [...new Set((announcementIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;

  const [reactions, commentGroups] = await Promise.all([
    prisma.feedReaction.findMany({
      where: { businessId, announcementId: { in: ids } },
      select: { announcementId: true, kind: true, employeeId: true },
    }),
    prisma.feedComment.groupBy({
      by: ['announcementId'],
      where: { businessId, announcementId: { in: ids }, deletedAt: null },
      _count: { _all: true },
    }),
  ]);
  const reactionsByPost = summarizeReactionsByPost(reactions, myEmployeeId);
  const commentCountByPost = new Map(commentGroups.map((g) => [g.announcementId, g._count._all]));
  for (const id of ids) {
    out.set(id, {
      reactionSummary: reactionsByPost.get(id) || { counts: {}, total: 0, myReaction: null },
      commentCount: commentCountByPost.get(id) || 0,
    });
  }
  return out;
}

// ── Mentions ───────────────────────────────────────────────────────────────

/**
 * Resolve @mention tokens (from parseMentions) → distinct in-tenant employees.
 * A token matches by code / work email / personal email / preferred name / full
 * name (first+last) / first name — tenant-scoped, non-deleted. Returns
 * [{ id, userId, firstName, lastName, preferredName, code }] (deduped by id).
 */
async function resolveMentionedEmployees(businessId, tokens) {
  const list = (tokens || []).slice(0, MENTION_TOKEN_CAP);
  if (!list.length) return [];
  const select = { id: true, userId: true, firstName: true, lastName: true, preferredName: true, code: true };
  const found = new Map();
  for (const token of list) {
    const t = String(token).trim();
    if (!t) continue;
    const or = [
      { code: { equals: t, mode: 'insensitive' } },
      { workEmail: { equals: t, mode: 'insensitive' } },
      { personalEmail: { equals: t, mode: 'insensitive' } },
      { preferredName: { equals: t, mode: 'insensitive' } },
    ];
    const sp = t.indexOf(' ');
    if (sp > 0) {
      const first = t.slice(0, sp).trim();
      const last = t.slice(sp + 1).trim();
      if (first && last) or.push({ AND: [
        { firstName: { equals: first, mode: 'insensitive' } },
        { lastName: { equals: last, mode: 'insensitive' } },
      ] });
    } else {
      // Single-word handle — last-resort first-name match (deterministic by code).
      or.push({ firstName: { equals: t, mode: 'insensitive' } });
    }
    const emp = await prisma.employee.findFirst({
      where: { businessId, deletedAt: null, OR: or },
      select,
      orderBy: { code: 'asc' },
    });
    if (emp && !found.has(emp.id)) found.set(emp.id, emp);
  }
  return [...found.values()];
}

// ── Comments ─────────────────────────────────────────────────────────────────

/**
 * List comments for a post, threaded (top-level + one level of replies), paginated
 * over TOP-LEVEL comments (replies ride with their parent). Soft-deleted rows are
 * hidden unless a deleted top-level still has live replies ("[deleted]" placeholder).
 */
async function listComments(businessId, announcementId, { page = 1, pageSize = 20 } = {}) {
  const take = Math.max(1, Math.min(50, Number(pageSize) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;

  // Page the TOP-LEVEL comments (stable newest-last within a post reads naturally).
  const [topLevel, total] = await Promise.all([
    prisma.feedComment.findMany({
      where: { businessId, announcementId, parentId: null },
      orderBy: { createdAt: 'asc' },
      skip, take,
      select: commentSelect(),
    }),
    prisma.feedComment.count({ where: { businessId, announcementId, parentId: null } }),
  ]);
  const parentIds = topLevel.map((c) => c.id);
  const replies = parentIds.length
    ? await prisma.feedComment.findMany({
        where: { businessId, announcementId, parentId: { in: parentIds } },
        orderBy: { createdAt: 'asc' },
        select: commentSelect(),
      })
    : [];

  const items = assembleThread([...topLevel, ...replies], toCommentDto);
  return { items, total, page: Math.max(1, Number(page) || 1), pageSize: take };
}

function commentSelect() {
  return {
    id: true, announcementId: true, parentId: true, body: true,
    authorEmployeeId: true, mentionedEmployeeIds: true,
    editedAt: true, deletedAt: true, createdAt: true, updatedAt: true,
    author: { select: { id: true, firstName: true, lastName: true, preferredName: true, code: true } },
  };
}

function toCommentDto(row, meta) {
  const deleted = !!meta.deleted;
  return {
    id: row.id,
    announcementId: row.announcementId,
    parentId: row.parentId || null,
    body: deleted ? '[deleted]' : row.body,
    deleted,
    authorEmployeeId: deleted ? null : row.authorEmployeeId,
    authorName: deleted ? null : fullName(row.author),
    mentionedEmployeeIds: deleted ? [] : (row.mentionedEmployeeIds || []),
    editedAt: deleted ? null : (row.editedAt || null),
    createdAt: row.createdAt,
  };
}

/**
 * Create a comment (or reply). Resolves @mentions from the body, stores the target
 * employee ids, then fires IN-APP notifications (best-effort). One level of nesting
 * is enforced: a reply to a reply is re-pointed at the top-level ancestor.
 * `actor` = the authoring employee { id, userId, firstName, lastName, preferredName, code }.
 */
async function createComment(businessId, actor, announcementId, { body, parentId } = {}) {
  const text = String(body || '').trim();
  if (!text) { const e = new Error('Comment body is required'); e.code = 'EMPTY_BODY'; throw e; }
  if (text.length > BODY_MAX) { const e = new Error('Comment is too long'); e.code = 'BODY_TOO_LONG'; throw e; }

  const post = await getInAudiencePost(businessId, actor, announcementId);
  if (!post) { const e = new Error('Post not found'); e.code = 'NOT_IN_AUDIENCE'; throw e; }

  // Resolve the parent (one level deep). Reply-to-a-reply attaches to the ancestor.
  let effectiveParentId = null;
  if (parentId) {
    const parent = await prisma.feedComment.findFirst({
      where: { id: parentId, businessId, announcementId, deletedAt: null },
      select: { id: true, parentId: true },
    });
    if (!parent) { const e = new Error('Parent comment not found'); e.code = 'PARENT_NOT_FOUND'; throw e; }
    effectiveParentId = parent.parentId || parent.id;
  }

  // Resolve @mentions → employee ids (stored) + their user ids (for notifications).
  const tokens = parseMentions(text);
  const mentioned = await resolveMentionedEmployees(businessId, tokens);
  const mentionedEmployeeIds = mentioned.map((m) => m.id);

  const comment = await prisma.feedComment.create({
    data: {
      businessId,
      announcementId,
      authorEmployeeId: actor.id,
      body: text,
      parentId: effectiveParentId,
      mentionedEmployeeIds,
    },
    select: commentSelect(),
  });

  // Fire notifications (never throws).
  await dispatchCommentNotifications({ businessId, post, actor, comment, mentioned }).catch(() => {});

  return toCommentDto(comment, { deleted: false });
}

/**
 * Write IN-APP Notification rows for a new comment:
 *   - FEED_COMMENT → the post author's User (if employee-linked/known + ≠ actor).
 *   - FEED_MENTION → each mentioned employee's User (distinct, self excluded, and
 *     not double-notifying the author who already got FEED_COMMENT).
 * Target de-dup runs in USER-id space via resolveNotificationTargets. Best-effort.
 */
async function dispatchCommentNotifications({ businessId, post, actor, comment, mentioned }) {
  const actorUserId = actor.userId || null;
  const actorName = fullName(actor);
  // The announcement's author is stored as a User id (authorUserId); 'SYSTEM' for
  // machine-projected posts (e.g. recognition) has no inbox.
  const postAuthorUserId = post.authorUserId && post.authorUserId !== 'SYSTEM' ? post.authorUserId : null;

  // Map mentioned employees → their linked user ids (skip the unlinked).
  const mentionUserByEmp = new Map(mentioned.filter((m) => m.userId).map((m) => [m.userId, m]));
  const mentionedUserIds = [...mentionUserByEmp.keys()];

  const { commentTarget, mentionTargets } = resolveNotificationTargets({
    postAuthorId: postAuthorUserId,
    actorId: actorUserId,
    mentionedIds: mentionedUserIds,
  });

  const base = {
    businessId,
    channel: 'IN_APP',
    entityType: 'Announcement',
    entityId: post.id,
  };
  const snippet = comment.body.length > 140 ? `${comment.body.slice(0, 137)}…` : comment.body;

  const writes = [];
  if (commentTarget) {
    writes.push(prisma.notification.create({
      data: {
        ...base,
        recipientUserId: commentTarget,
        type: 'FEED_COMMENT',
        title: `${actorName} commented on your post`,
        body: snippet,
        dataJson: {
          kind: 'FEED_COMMENT', announcementId: post.id, commentId: comment.id,
          actorEmployeeId: actor.id, actorName,
        },
      },
    }).catch(() => null));
  }
  for (const uid of mentionTargets) {
    writes.push(prisma.notification.create({
      data: {
        ...base,
        recipientUserId: uid,
        type: 'FEED_MENTION',
        title: `${actorName} mentioned you`,
        body: snippet,
        dataJson: {
          kind: 'FEED_MENTION', announcementId: post.id, commentId: comment.id,
          actorEmployeeId: actor.id, actorName,
        },
      },
    }).catch(() => null));
  }
  if (writes.length) await Promise.all(writes);
  return { commentNotified: commentTarget ? 1 : 0, mentionsNotified: mentionTargets.length };
}

/** Edit a comment (author-only). Sets editedAt. Re-resolves mentions from the new body. */
async function editComment(businessId, actor, announcementId, commentId, { body } = {}) {
  const text = String(body || '').trim();
  if (!text) { const e = new Error('Comment body is required'); e.code = 'EMPTY_BODY'; throw e; }
  if (text.length > BODY_MAX) { const e = new Error('Comment is too long'); e.code = 'BODY_TOO_LONG'; throw e; }

  const existing = await prisma.feedComment.findFirst({
    where: { id: commentId, businessId, announcementId, deletedAt: null },
    select: { id: true, authorEmployeeId: true },
  });
  if (!existing) { const e = new Error('Comment not found'); e.code = 'NOT_FOUND'; throw e; }
  if (existing.authorEmployeeId !== actor.id) { const e = new Error('Not your comment'); e.code = 'FORBIDDEN'; throw e; }

  const mentioned = await resolveMentionedEmployees(businessId, parseMentions(text));
  const updated = await prisma.feedComment.update({
    where: { id: existing.id },
    data: { body: text, editedAt: new Date(), mentionedEmployeeIds: mentioned.map((m) => m.id) },
    select: commentSelect(),
  });
  return toCommentDto(updated, { deleted: false });
}

/**
 * Delete a comment. `mode`:
 *   'author'   — the caller must be the author (soft-delete own comment).
 *   'operator' — moderation (canManageAnnouncements); deletes ANY comment in-tenant.
 * Soft-delete (deletedAt) so a thread with live replies keeps its shape.
 */
async function deleteComment(businessId, { actorEmployeeId = null, mode = 'author', announcementId = null }, commentId) {
  const where = { id: commentId, businessId, deletedAt: null };
  if (announcementId) where.announcementId = announcementId;
  const existing = await prisma.feedComment.findFirst({
    where, select: { id: true, authorEmployeeId: true },
  });
  if (!existing) { const e = new Error('Comment not found'); e.code = 'NOT_FOUND'; throw e; }
  if (mode !== 'operator' && existing.authorEmployeeId !== actorEmployeeId) {
    const e = new Error('Not your comment'); e.code = 'FORBIDDEN'; throw e;
  }
  await prisma.feedComment.update({ where: { id: existing.id }, data: { deletedAt: new Date() } });
  return { ok: true, deleted: true, mode };
}

module.exports = {
  getInAudiencePost,
  setReaction,
  removeReaction,
  reactionSummary,
  socialByPosts,
  resolveMentionedEmployees,
  listComments,
  createComment,
  editComment,
  deleteComment,
  dispatchCommentNotifications,
  // re-exported for tests / callers
  normalizeKind,
  toCommentDto,
};
