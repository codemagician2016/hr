'use strict';

/**
 * meNotifications.controller.js — the ESS NOTIFICATION INBOX, mounted at
 * /api/hr/me/notifications (customer session). SELF-ONLY: the caller's employee is
 * resolved from the session (withSelf — same active-status lockout as the feed), then
 * mapped to their linked User id (Notification.recipientUserId IS a User id). If the
 * employee has no linked User, the inbox is empty (graceful — never 404/500).
 *
 * This is the surface that makes @mentions + comment notifications actually LAND: the
 * announcement/recognition fan-outs and the feed social layer all write Notification
 * rows keyed by recipientUserId, but nothing on ESS read them until now (the bell read
 * /me/tasks). Tenant-walled by businessId; a caller only ever sees their own rows.
 *
 *   GET  /me/notifications                 — paginated inbox (newest first)
 *   GET  /me/notifications/unread-count     — the bell badge number
 *   POST /me/notifications/:id/read         — mark one read (idempotent)
 *   POST /me/notifications/read-all         — mark every unread read
 */

const prisma = require('../../../core/lib/prisma');
const { withSelf } = require('./meEngagement.controller');

function publicNotification(n) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    entityType: n.entityType,
    entityId: n.entityId,
    dataJson: n.dataJson || null,
    read: n.readAt != null,
    readAt: n.readAt,
    createdAt: n.createdAt,
  };
}

// GET /me/notifications?page=&pageSize=&unread=true
async function list(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    if (!employee.userId) return res.json({ items: [], total: 0, page: 1, pageSize: 0, unlinked: true });

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 20));
    const skip = (page - 1) * pageSize;
    const where = { businessId, recipientUserId: employee.userId };
    if (String(req.query.unread || '') === 'true') where.readAt = null;

    const [rows, total] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.notification.count({ where }),
    ]);
    return res.json({ items: rows.map(publicNotification), total, page, pageSize });
  } catch (e) { return next(e); }
}

// GET /me/notifications/unread-count
async function unreadCount(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    if (!employee.userId) return res.json({ unread: 0 });
    const unread = await prisma.notification.count({
      where: { businessId, recipientUserId: employee.userId, readAt: null },
    });
    return res.json({ unread });
  } catch (e) { return next(e); }
}

// POST /me/notifications/:id/read  (idempotent; 404 if not the caller's own row)
async function markRead(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    if (!employee.userId) return res.status(404).json({ message: 'Notification not found' });
    // updateMany with the ownership wall ANDed in (defence-in-depth IDOR guard) — a
    // caller can never mark someone else's notification read.
    const r = await prisma.notification.updateMany({
      where: { id: req.params.id, businessId, recipientUserId: employee.userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (r.count === 0) {
      // Either not found, not owned, or already read — disambiguate own-but-already-read.
      const exists = await prisma.notification.findFirst({
        where: { id: req.params.id, businessId, recipientUserId: employee.userId },
        select: { id: true },
      });
      if (!exists) return res.status(404).json({ message: 'Notification not found' });
    }
    return res.json({ ok: true, read: true });
  } catch (e) { return next(e); }
}

// POST /me/notifications/read-all
async function markAllRead(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    if (!employee.userId) return res.json({ ok: true, marked: 0 });
    const r = await prisma.notification.updateMany({
      where: { businessId, recipientUserId: employee.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return res.json({ ok: true, marked: r.count });
  } catch (e) { return next(e); }
}

module.exports = { list, unreadCount, markRead, markAllRead, publicNotification };
