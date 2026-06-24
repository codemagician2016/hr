'use strict';

/**
 * meEngagement.controller.js — the EMPLOYEE (ESS) engagement surface, mounted at
 * /api/hr/me/engagement. CUSTOMER session (req.customer); SELF-ONLY by construction —
 * the subject employee is resolved ENTIRELY from the session (workEmail/personalEmail/
 * linked User), so a body/query employeeId is structurally ignored and a cross-employee
 * read is impossible. Cross-tenant is blocked by businessId on every where.
 *
 * Surfaces:
 *   GET  /feed              — the news feed (published + in-audience + not expired,
 *                             pinned-first, paginated) with per-row read state.
 *   GET  /feed/unread-count — the unread badge number.
 *   POST /feed/:id/read     — mark one announcement as read (idempotent).
 *   POST /feed/read-all     — mark every currently-visible announcement as read.
 *   GET  /celebrations      — upcoming birthdays + anniversaries (window-bounded,
 *                             privacy-aware, no DOB-year leak).
 */

const prisma = require('../../../core/lib/prisma');
const { feedWhereForEmployee, resolveEmployeeSegment } = require('../audience');
const { buildCelebrations } = require('../celebrations');

// Resolve the session customer's own Employee (mirror of essPerformance.resolveSelf).
async function resolveSelf(businessId, customer) {
  if (!customer || !customer.email) return null;
  const select = { id: true, code: true, firstName: true, lastName: true, status: true, isActive: true };
  const byEmail = await prisma.employee.findFirst({
    where: { businessId, deletedAt: null, OR: [{ workEmail: customer.email }, { personalEmail: customer.email }] },
    select,
  });
  if (byEmail) return byEmail;
  return prisma.employee.findFirst({
    where: { businessId, deletedAt: null, user: { is: { email: customer.email } } },
    select,
  });
}

async function withSelf(req, res) {
  const { businessId } = req.customer;
  const employee = await resolveSelf(businessId, req.customer);
  if (!employee) { res.status(404).json({ message: 'No employee record is linked to your account' }); return null; }
  return { businessId, employee };
}

function publicFeedItem(a, readSet) {
  return {
    id: a.id,
    title: a.title,
    bodyRichText: a.bodyRichText,
    category: a.category,
    pinned: a.pinned,
    publishedAt: a.publishedAt,
    expiresAt: a.expiresAt,
    authorName: a.authorName,
    read: readSet.has(a.id),
  };
}

// GET /me/engagement/feed — paginated, pinned-first, newest-first.
async function feed(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const segment = await resolveEmployeeSegment(businessId, employee.id);
    const now = new Date();
    const where = feedWhereForEmployee({ businessId, employeeId: employee.id, segment, now });

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Math.min(50, Number(req.query.pageSize) || 10));
    const skip = (page - 1) * pageSize;

    const [rows, total] = await Promise.all([
      prisma.announcement.findMany({
        where,
        orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }],
        skip, take: pageSize,
      }),
      prisma.announcement.count({ where }),
    ]);

    // Per-row read state in one query (this page only).
    const ids = rows.map((r) => r.id);
    const reads = ids.length
      ? await prisma.announcementRead.findMany({
          where: { businessId, employeeId: employee.id, announcementId: { in: ids } },
          select: { announcementId: true },
        })
      : [];
    const readSet = new Set(reads.map((r) => r.announcementId));

    return res.json({
      items: rows.map((a) => publicFeedItem(a, readSet)),
      total, page, pageSize,
    });
  } catch (e) { return next(e); }
}

// GET /me/engagement/feed/unread-count — the badge number (whole in-audience feed).
async function unreadCount(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const segment = await resolveEmployeeSegment(businessId, employee.id);
    const where = feedWhereForEmployee({ businessId, employeeId: employee.id, segment, now: new Date() });
    const [visible, readCount] = await Promise.all([
      prisma.announcement.count({ where }),
      // Read receipts that point at a still-visible announcement. Counting reads of
      // currently-visible rows avoids over-counting expired/archived ones.
      prisma.announcementRead.count({
        where: { businessId, employeeId: employee.id, announcement: where },
      }),
    ]);
    const unread = Math.max(0, visible - readCount);
    return res.json({ unread, visible });
  } catch (e) { return next(e); }
}

// POST /me/engagement/feed/:id/read — mark one as read (idempotent upsert). 404 if the
// announcement is not in THIS employee's audience (no cross-audience read receipts).
async function markRead(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const segment = await resolveEmployeeSegment(businessId, employee.id);
    const where = feedWhereForEmployee({ businessId, employeeId: employee.id, segment, now: new Date() });
    const visible = await prisma.announcement.findFirst({ where: { ...where, id: req.params.id }, select: { id: true } });
    if (!visible) return res.status(404).json({ message: 'Announcement not found' });
    await prisma.announcementRead.upsert({
      where: { announcementId_employeeId: { announcementId: visible.id, employeeId: employee.id } },
      create: { businessId, announcementId: visible.id, employeeId: employee.id },
      update: {}, // already read — no-op (idempotent)
    });
    return res.json({ ok: true, read: true });
  } catch (e) { return next(e); }
}

// POST /me/engagement/feed/read-all — mark every currently-visible announcement read.
async function markAllRead(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const segment = await resolveEmployeeSegment(businessId, employee.id);
    const where = feedWhereForEmployee({ businessId, employeeId: employee.id, segment, now: new Date() });
    const visible = await prisma.announcement.findMany({ where, select: { id: true } });
    if (visible.length) {
      await prisma.announcementRead.createMany({
        data: visible.map((a) => ({ businessId, announcementId: a.id, employeeId: employee.id })),
        skipDuplicates: true,
      });
    }
    return res.json({ ok: true, marked: visible.length });
  } catch (e) { return next(e); }
}

// GET /me/engagement/celebrations?windowDays=30 — upcoming birthdays + anniversaries.
// Company-wide warmth: celebrations are visible across the tenant (scope = whole active
// tenant), privacy-aware (opt-out hidden, no DOB-year leak). The signed-in employee's
// OWN entries are flagged so the UI can say "It's your birthday!".
async function celebrations(req, res, next) {
  try {
    const ctx = await withSelf(req, res); if (!ctx) return undefined;
    const { businessId, employee } = ctx;
    const windowDays = Number(req.query.windowDays) || 30;
    const out = await buildCelebrations({ businessId, windowDays });
    const flagSelf = (item) => ({ ...item, isSelf: item.employeeId === employee.id });
    return res.json({
      birthdays: out.birthdays.map(flagSelf),
      anniversaries: out.anniversaries.map(flagSelf),
      windowDays: out.windowDays,
    });
  } catch (e) { return next(e); }
}

module.exports = { feed, unreadCount, markRead, markAllRead, celebrations };
