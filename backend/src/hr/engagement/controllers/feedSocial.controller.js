'use strict';

/**
 * feedSocial.controller.js — ESS reactions + comments on the news feed, mounted
 * under /api/hr/me/engagement (customer session). SELF-ONLY: the acting employee is
 * resolved ENTIRELY from the session (withSelf), so a body/query employeeId is
 * structurally ignored. Every write is audience-gated inside the service (a caller
 * can only react/comment on an in-audience post) and tenant-walled by businessId.
 *
 * Surfaces:
 *   PUT    /feed/:id/reaction            — set/replace my single reaction {kind}
 *   DELETE /feed/:id/reaction            — remove my reaction
 *   GET    /feed/:id/comments            — threaded comments (paginated)
 *   POST   /feed/:id/comments            — add a comment/reply {body, parentId?}
 *   PATCH  /feed/:id/comments/:commentId — edit my comment {body}
 *   DELETE /feed/:id/comments/:commentId — delete my comment (soft)
 */

const svc = require('../feedSocial.service');
const { withSelf } = require('./meEngagement.controller');

// Map a service error code → HTTP status + message.
function sendServiceError(res, e) {
  switch (e && e.code) {
    case 'BAD_KIND':        return res.status(400).json({ message: 'Unknown reaction kind' });
    case 'EMPTY_BODY':      return res.status(400).json({ message: 'Comment body is required' });
    case 'BODY_TOO_LONG':   return res.status(400).json({ message: 'Comment is too long' });
    case 'NOT_IN_AUDIENCE': return res.status(404).json({ message: 'Post not found' });
    case 'PARENT_NOT_FOUND':return res.status(404).json({ message: 'Parent comment not found' });
    case 'NOT_FOUND':       return res.status(404).json({ message: 'Comment not found' });
    case 'FORBIDDEN':       return res.status(403).json({ message: 'You can only modify your own comment' });
    default: return null; // not a tagged service error — bubble to next(e)
  }
}

// PUT /me/engagement/feed/:id/reaction  { kind }
async function setReaction(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const { summary } = await svc.setReaction(businessId, employee, req.params.id, (req.body || {}).kind);
    return res.json({ ok: true, reactionSummary: summary });
  } catch (e) { return sendServiceError(res, e) || next(e); }
}

// DELETE /me/engagement/feed/:id/reaction
async function removeReaction(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const summary = await svc.removeReaction(businessId, employee, req.params.id);
    return res.json({ ok: true, reactionSummary: summary });
  } catch (e) { return sendServiceError(res, e) || next(e); }
}

// GET /me/engagement/feed/:id/comments?page=&pageSize=
async function listComments(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    // Audience-gate the read too — no reading comments on an out-of-audience post.
    const post = await svc.getInAudiencePost(businessId, employee, req.params.id);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    const out = await svc.listComments(businessId, req.params.id, {
      page: req.query.page, pageSize: req.query.pageSize,
    });
    return res.json(out);
  } catch (e) { return sendServiceError(res, e) || next(e); }
}

// POST /me/engagement/feed/:id/comments  { body, parentId? }
async function createComment(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const { body, parentId } = req.body || {};
    const comment = await svc.createComment(businessId, employee, req.params.id, { body, parentId });
    return res.status(201).json({ ok: true, comment });
  } catch (e) { return sendServiceError(res, e) || next(e); }
}

// PATCH /me/engagement/feed/:id/comments/:commentId  { body }
async function editComment(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const comment = await svc.editComment(businessId, employee, req.params.id, req.params.commentId, { body: (req.body || {}).body });
    return res.json({ ok: true, comment });
  } catch (e) { return sendServiceError(res, e) || next(e); }
}

// DELETE /me/engagement/feed/:id/comments/:commentId  (author soft-delete)
async function deleteComment(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const out = await svc.deleteComment(
      businessId,
      { actorEmployeeId: employee.id, mode: 'author', announcementId: req.params.id },
      req.params.commentId,
    );
    return res.json(out);
  } catch (e) { return sendServiceError(res, e) || next(e); }
}

module.exports = { setReaction, removeReaction, listComments, createComment, editComment, deleteComment };
