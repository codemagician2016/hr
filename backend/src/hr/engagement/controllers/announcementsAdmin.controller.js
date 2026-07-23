'use strict';

/**
 * announcementsAdmin.controller.js — operator authoring surface for the company
 * news feed, mounted at /api/hr/announcements. OPERATOR session (req.user); every
 * route is requirePermission('canManageAnnouncements') (Owner + HR-Admin). Tenant
 * isolation: businessId from req.user on every where (no cross-tenant read/write).
 */

const svc = require('../announcements.service');

function publicAnnouncement(a) {
  return {
    id: a.id,
    title: a.title,
    bodyRichText: a.bodyRichText,
    category: a.category,
    audienceScope: a.audienceScope,
    audienceEntityIds: a.audienceEntityIds || [],
    audienceDeptIds: a.audienceDeptIds || [],
    audienceEmployeeIds: a.audienceEmployeeIds || [],
    pinned: a.pinned,
    status: a.status,
    publishedAt: a.publishedAt,
    expiresAt: a.expiresAt,
    archivedAt: a.archivedAt,
    authorName: a.authorName,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    version: a.version,
  };
}

// GET /announcements — operator list (all statuses), paginated, pinned+newest first.
async function list(req, res, next) {
  try {
    const { businessId } = req.user;
    const { status, category, page, pageSize } = req.query || {};
    const out = await svc.adminList({ businessId, status, category, page, pageSize });
    return res.json({ items: out.items.map(publicAnnouncement), total: out.total, page: out.page, pageSize: out.pageSize });
  } catch (e) { return next(e); }
}

// GET /announcements/:id — single (operator).
async function get(req, res, next) {
  try {
    const { businessId } = req.user;
    const prisma = require('../../../core/lib/prisma');
    const a = await prisma.announcement.findFirst({ where: { id: req.params.id, businessId } });
    if (!a) return res.status(404).json({ message: 'Announcement not found' });
    return res.json({ announcement: publicAnnouncement(a) });
  } catch (e) { return next(e); }
}

// POST /announcements — create a DRAFT.
async function create(req, res, next) {
  try {
    const { businessId } = req.user;
    const author = { id: req.user.id, name: req.user.name || null };
    const out = await svc.create({ businessId, author, input: req.body || {} });
    if (out.error) return res.status(400).json({ message: out.error });
    return res.status(201).json({ announcement: publicAnnouncement(out.announcement) });
  } catch (e) { return next(e); }
}

// PATCH /announcements/:id — edit (any status; editing a PUBLISHED one keeps it live).
async function update(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.update({ businessId, id: req.params.id, input: req.body || {} });
    if (out.notFound) return res.status(404).json({ message: 'Announcement not found' });
    if (out.error) return res.status(400).json({ message: out.error });
    return res.json({ announcement: publicAnnouncement(out.announcement) });
  } catch (e) { return next(e); }
}

// POST /announcements/:id/publish — go live (+ fan out notifications when live now).
async function publish(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.publish({ businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Announcement not found' });
    return res.json({ announcement: publicAnnouncement(out.announcement), notified: out.notified });
  } catch (e) { return next(e); }
}

// POST /announcements/:id/archive — retire from the feed.
async function archive(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.archive({ businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Announcement not found' });
    return res.json({ announcement: publicAnnouncement(out.announcement) });
  } catch (e) { return next(e); }
}

// POST /announcements/:id/pin  +  /unpin — toggle pinned. (plain factory — returns
// the handler synchronously so the route gets a function, not a Promise.)
function setPinned(pinned) {
  return async function (req, res, next) {
    try {
      const { businessId } = req.user;
      const out = await svc.update({ businessId, id: req.params.id, input: { pinned } });
      if (out.notFound) return res.status(404).json({ message: 'Announcement not found' });
      return res.json({ announcement: publicAnnouncement(out.announcement) });
    } catch (e) { return next(e); }
  };
}

// DELETE /announcements/:id — hard-delete a DRAFT, else archive.
async function remove(req, res, next) {
  try {
    const { businessId } = req.user;
    const out = await svc.remove({ businessId, id: req.params.id });
    if (out.notFound) return res.status(404).json({ message: 'Announcement not found' });
    if (out.deleted) return res.json({ deleted: true });
    return res.json({ announcement: publicAnnouncement(out.announcement) });
  } catch (e) { return next(e); }
}

// DELETE /announcements/feed/comments/:commentId — MODERATION: soft-delete ANY feed
// comment in the tenant (operator override, canManageAnnouncements). Reuses the feed
// social service's soft-delete in 'operator' mode so a moderated thread keeps its shape
// (a deleted parent with live replies renders as a "[deleted]" placeholder).
async function removeFeedComment(req, res, next) {
  try {
    const { businessId } = req.user;
    const feedSocial = require('../feedSocial.service');
    const out = await feedSocial.deleteComment(businessId, { mode: 'operator' }, req.params.commentId);
    return res.json(out);
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return res.status(404).json({ message: 'Comment not found' });
    return next(e);
  }
}

module.exports = {
  list, get, create, update, publish, archive, remove,
  pin: setPinned(true), unpin: setPinned(false),
  removeFeedComment,
};
