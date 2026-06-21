const crypto = require('crypto');
const prisma = require('./prisma');
const { ROLES } = require('./roles');

const INBOX_TYPES = {
  BOOKING_CREATED: 'booking_created',
  APPOINTMENT_CONFIRMED: 'appointment_confirmed',
  APPOINTMENT_CANCELLED: 'appointment_cancelled',
  APPOINTMENT_RESCHEDULED: 'appointment_rescheduled',
  CUSTOMER_CANCELLED: 'customer_cancelled',
};

function formatDateLabel(date) {
  const d = new Date(date);
  return d.toISOString().slice(0, 10);
}

function formatWhenLabel({ date, startTime, endTime }) {
  const day = formatDateLabel(date);
  return `${day} · ${startTime}${endTime ? `-${endTime}` : ''}`;
}

async function createNotifications(items = []) {
  const rows = items.filter(Boolean).filter((item) => item.businessId && (item.userId || item.customerId));
  if (rows.length === 0) return [];
  return prisma.$transaction(
    rows.map((data) => prisma.inboxNotification.create({ data }))
  );
}

async function listBusinessAdminRecipients(businessId, excludeUserIds = []) {
  return prisma.user.findMany({
    where: {
      businessId,
      role: ROLES.BUSINESS_ADMIN,
      isActive: true,
      id: excludeUserIds.length ? { notIn: excludeUserIds } : undefined,
    },
    select: { id: true, name: true, email: true },
  });
}

function getActorLabel(req) {
  if (req?.authType === 'customer') return 'customer';
  if (req?.user?.role === ROLES.STAFF) return 'staff';
  if (req?.user?.role === ROLES.BUSINESS_ADMIN) return 'business admin';
  if (req?.user?.role === ROLES.USER) return 'customer';
  return 'team';
}

async function listInboxNotificationsForRequest(req, { unreadOnly = false, limit = 50 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 100);
  // Operator inbox is scoped to the operator's *current* business, not just
  // their user id. Without this, a staffer who later joined a different
  // business could still see notifications from the old one — and (per the
  // 2026-05-12 incident) any operator with a stray customer cookie could
  // see another vertical's customer notifications through the user-id path.
  // A user with no business in scope (e.g. a SUPER_ADMIN, or a freshly-created
  // operator) has businessId === null. Prisma's `businessId` filter is a
  // non-nullable String, so passing `businessId: null` throws
  // PrismaClientValidationError — and because this controller is a raw async
  // handler, that rejection went unhandled and CRASHED the whole backend
  // (taking payments and every other route down with it). Omit the business
  // scope when there is no business; fall back to the user-id scope.
  const where = req.authType === 'customer'
    ? { customerId: req.customer.id }
    : req.user.businessId
      ? { userId: req.user.id, businessId: req.user.businessId }
      : { userId: req.user.id };

  if (unreadOnly) where.readAt = null;

  const notifications = await prisma.inboxNotification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      appointment: {
        select: {
          id: true,
          date: true,
          startTime: true,
          endTime: true,
          status: true,
          service: { select: { name: true } },
          staff: { select: { id: true, name: true } },
          business: { select: { id: true, name: true, slug: true } },
        },
      },
    },
  });

  const unreadCount = await prisma.inboxNotification.count({
    where: {
      ...where,
      readAt: null,
    },
  });

  return { notifications, unreadCount };
}

async function markInboxNotificationReadForRequest(req, id) {
  const existing = await prisma.inboxNotification.findUnique({
    where: { id },
    select: { id: true, userId: true, customerId: true, readAt: true },
  });
  if (!existing) return null;

  const owns = req.authType === 'customer'
    ? existing.customerId === req.customer.id
    : existing.userId === req.user.id;
  if (!owns) return null;

  // Operator may only mark-read notifications scoped to their own business —
  // matches the list filter above so the two views stay consistent. Skip the
  // business scope when the user has no business (businessId:null would throw
  // PrismaClientValidationError); the user-id ownership check above still holds.
  if (req.authType !== 'customer' && req.user.businessId) {
    const scoped = await prisma.inboxNotification.findFirst({
      where: { id, businessId: req.user.businessId },
      select: { id: true },
    });
    if (!scoped) return null;
  }

  return prisma.inboxNotification.update({
    where: { id },
    data: { readAt: existing.readAt || new Date() },
  });
}

async function markAllInboxNotificationsReadForRequest(req) {
  const where = req.authType === 'customer'
    ? { customerId: req.customer.id, readAt: null }
    : req.user.businessId
      ? { userId: req.user.id, businessId: req.user.businessId, readAt: null }
      : { userId: req.user.id, readAt: null };

  const result = await prisma.inboxNotification.updateMany({
    where,
    data: { readAt: new Date() },
  });
  return result.count;
}

function firstHeaderValue(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .find(Boolean) || '';
}

function originFromHost(host, proto) {
  const cleanHost = firstHeaderValue(host).replace(/\/+$/, '');
  if (!cleanHost) return null;

  const cleanProto = firstHeaderValue(proto).replace(/:$/, '').toLowerCase();
  const finalProto = cleanProto === 'http' || cleanProto === 'https'
    ? cleanProto
    : (/^(localhost|127(?:\.\d{1,3}){3})(:\d+)?$/i.test(cleanHost) ? 'http' : 'https');

  try {
    return new URL(`${finalProto}://${cleanHost}`).origin;
  } catch {
    return null;
  }
}

function resolvePublicOrigin(req) {
  const origin = firstHeaderValue(req.get('origin'));
  if (origin) {
    try {
      return new URL(origin).origin;
    } catch {
      // ignore malformed origin
    }
  }

  const forwardedOrigin = originFromHost(
    req.get('x-forwarded-host'),
    req.get('x-forwarded-proto') || req.protocol
  );
  if (forwardedOrigin) return forwardedOrigin;

  const referer = req.get('referer');
  if (referer) {
    try {
      const url = new URL(referer);
      return url.origin;
    } catch {
      // ignore malformed referer
    }
  }

  const hostOrigin = originFromHost(
    req.get('host'),
    req.get('x-forwarded-proto') || req.protocol
  );
  if (hostOrigin) return hostOrigin;

  const base = process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL;
  if (base) return base.replace(/\/$/, '');

  return `https://${process.env.PLATFORM_DOMAIN || 'sitepresso.com'}`;
}

async function ensureCalendarFeedTokenForRequest(req) {
  if (req.authType === 'customer') {
    if (req.customer.calendarFeedToken) return req.customer.calendarFeedToken;
    const token = crypto.randomBytes(24).toString('hex');
    await prisma.customer.update({
      where: { id: req.customer.id },
      data: { calendarFeedToken: token },
    });
    req.customer.calendarFeedToken = token;
    return token;
  }

  if (req.user.calendarFeedToken) return req.user.calendarFeedToken;
  const token = crypto.randomBytes(24).toString('hex');
  await prisma.user.update({
    where: { id: req.user.id },
    data: { calendarFeedToken: token },
  });
  req.user.calendarFeedToken = token;
  return token;
}

const { resolveApiBaseUrl } = require('../utils/apiBaseUrl');

async function buildCalendarFeedLinks(req) {
  const token = await ensureCalendarFeedTokenForRequest(req);
  const origin = resolveApiBaseUrl();
  const feedPath = req.authType === 'customer'
    ? `/api/calendar/customer/${token}.ics`
    : `/api/calendar/user/${token}.ics`;
  const httpsUrl = `${origin}${feedPath}`;
  const webcalUrl = httpsUrl.replace(/^https?:\/\//, 'webcal://');
  const googleUrl = `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(httpsUrl)}`;
  return {
    httpsUrl,
    webcalUrl,
    googleUrl,
  };
}

module.exports = {
  INBOX_TYPES,
  buildCalendarFeedLinks,
  createNotifications,
  formatDateLabel,
  formatWhenLabel,
  getActorLabel,
  listBusinessAdminRecipients,
  listInboxNotificationsForRequest,
  markAllInboxNotificationsReadForRequest,
  markInboxNotificationReadForRequest,
};
