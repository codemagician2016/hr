'use strict';

/**
 * announcements.service.js — Announcement domain logic (operator authoring + the
 * notification fan-out). Pure-ish over Prisma; HTTP shaping lives in the controllers.
 *
 * Lifecycle: DRAFT → PUBLISHED → ARCHIVED. publishedAt may be FUTURE-dated (scheduled
 * go-live): the ESS feed filters publishedAt <= now, so a publish with a future
 * publishedAt is a "scheduled" announcement that appears when its time comes — no cron
 * needed. Notification fan-out fires only when the announcement is LIVE at publish time
 * (publishedAt <= now); a future-scheduled one does not notify until... (kept simple:
 * we notify at the publish action when it is already live; scheduled ones surface in
 * the feed silently — acceptable for v1, documented).
 */

const prisma = require('../../core/lib/prisma');
const { SCOPE, resolveAudienceEmployees } = require('./audience');
const { notifyHrEvent } = require('../integrations/notifications');

const CATEGORIES = new Set(['NEWS', 'POLICY', 'EVENT', 'HOLIDAY', 'CELEBRATION', 'GENERAL']);
const SCOPES = new Set(['ALL', 'ENTITY', 'DEPARTMENT', 'SPECIFIC']);

// ── input normalisation ──────────────────────────────────────────────────────
function clampStr(v, max) {
  if (v == null) return v;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function normaliseAudience(input = {}) {
  const scope = SCOPES.has(input.audienceScope) ? input.audienceScope : SCOPE.ALL;
  const arr = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);
  return {
    audienceScope: scope,
    // Persist ONLY the array relevant to the scope (so a later scope flip cannot leak
    // a stale wide audience); the others reset to [].
    audienceEntityIds:   scope === SCOPE.ENTITY ? arr(input.audienceEntityIds) : [],
    audienceDeptIds:     scope === SCOPE.DEPARTMENT ? arr(input.audienceDeptIds) : [],
    audienceEmployeeIds: scope === SCOPE.SPECIFIC ? arr(input.audienceEmployeeIds) : [],
  };
}

/** Validate + coerce a create/edit payload. Returns { ok, data?, error? }. */
function validate(input = {}, { partial = false } = {}) {
  if (!partial) {
    if (!input.title || !String(input.title).trim()) return { ok: false, error: 'title is required' };
    if (!input.bodyRichText || !String(input.bodyRichText).trim()) return { ok: false, error: 'bodyRichText is required' };
  }
  if (input.category != null && !CATEGORIES.has(input.category)) return { ok: false, error: `Unknown category "${input.category}"` };
  if (input.audienceScope != null && !SCOPES.has(input.audienceScope)) return { ok: false, error: `Unknown audienceScope "${input.audienceScope}"` };
  // Narrowed scopes must name at least one target (else the announcement reaches nobody).
  const scope = input.audienceScope;
  if (scope === SCOPE.ENTITY && !(Array.isArray(input.audienceEntityIds) && input.audienceEntityIds.length))
    return { ok: false, error: 'ENTITY audience requires audienceEntityIds' };
  if (scope === SCOPE.DEPARTMENT && !(Array.isArray(input.audienceDeptIds) && input.audienceDeptIds.length))
    return { ok: false, error: 'DEPARTMENT audience requires audienceDeptIds' };
  if (scope === SCOPE.SPECIFIC && !(Array.isArray(input.audienceEmployeeIds) && input.audienceEmployeeIds.length))
    return { ok: false, error: 'SPECIFIC audience requires audienceEmployeeIds' };
  // Dates
  for (const k of ['publishedAt', 'expiresAt']) {
    if (input[k] != null && input[k] !== '' && Number.isNaN(Date.parse(input[k])))
      return { ok: false, error: `${k} must be a valid ISO date` };
  }
  if (input.publishedAt && input.expiresAt && Date.parse(input.expiresAt) <= Date.parse(input.publishedAt))
    return { ok: false, error: 'expiresAt must be after publishedAt' };
  return { ok: true };
}

// ── CRUD ─────────────────────────────────────────────────────────────────────
async function create({ businessId, author, input }) {
  const v = validate(input);
  if (!v.ok) return { error: v.error };
  const aud = normaliseAudience(input);
  const ann = await prisma.announcement.create({
    data: {
      businessId,
      authorUserId: author.id,
      authorName: author.name || null,
      title: clampStr(String(input.title).trim(), 300),
      bodyRichText: clampStr(String(input.bodyRichText), 50000),
      category: CATEGORIES.has(input.category) ? input.category : 'NEWS',
      ...aud,
      pinned: !!input.pinned,
      status: 'DRAFT',
      publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    },
  });
  return { announcement: ann };
}

async function update({ businessId, id, input }) {
  const existing = await prisma.announcement.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  const v = validate(input, { partial: true });
  if (!v.ok) return { error: v.error };

  const data = {};
  if (input.title != null) data.title = clampStr(String(input.title).trim(), 300);
  if (input.bodyRichText != null) data.bodyRichText = clampStr(String(input.bodyRichText), 50000);
  if (input.category != null) data.category = input.category;
  if (input.pinned != null) data.pinned = !!input.pinned;
  if (input.publishedAt !== undefined) data.publishedAt = input.publishedAt ? new Date(input.publishedAt) : null;
  if (input.expiresAt !== undefined) data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (input.audienceScope != null) Object.assign(data, normaliseAudience(input));
  data.version = { increment: 1 };

  const ann = await prisma.announcement.update({ where: { id: existing.id }, data });
  return { announcement: ann };
}

/**
 * Publish — flip DRAFT/ARCHIVED → PUBLISHED, stamp publishedAt if not already set
 * (or honour a future-dated schedule), then fan out notifications when it is LIVE.
 * Returns { announcement, notified }.
 */
async function publish({ businessId, id, now = new Date() }) {
  const existing = await prisma.announcement.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  const publishedAt = existing.publishedAt || now;
  const ann = await prisma.announcement.update({
    where: { id: existing.id },
    data: { status: 'PUBLISHED', publishedAt, archivedAt: null, version: { increment: 1 } },
  });
  // Notify only when LIVE now (a future-scheduled publishedAt surfaces silently in the
  // feed at its time). Best-effort, fire-and-forget — never blocks/throws the publish.
  let notified = 0;
  if (publishedAt <= now && (!ann.expiresAt || ann.expiresAt > now)) {
    notified = await fanOutAnnouncement(ann).catch(() => 0);
  }
  return { announcement: ann, notified };
}

async function archive({ businessId, id }) {
  const existing = await prisma.announcement.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  const ann = await prisma.announcement.update({
    where: { id: existing.id },
    data: { status: 'ARCHIVED', archivedAt: new Date(), version: { increment: 1 } },
  });
  return { announcement: ann };
}

async function remove({ businessId, id }) {
  const existing = await prisma.announcement.findFirst({ where: { id, businessId } });
  if (!existing) return { notFound: true };
  // Hard-delete a DRAFT (never published, no read receipts worth keeping); else archive.
  if (existing.status === 'DRAFT') {
    await prisma.announcement.delete({ where: { id: existing.id } });
    return { deleted: true };
  }
  return archive({ businessId, id });
}

// ── operator list (all statuses, newest-first, paginated) ────────────────────
async function adminList({ businessId, status, category, page = 1, pageSize = 25 }) {
  const where = { businessId };
  if (status && ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(status)) where.status = status;
  if (category && CATEGORIES.has(category)) where.category = category;
  const take = Math.max(1, Math.min(100, Number(pageSize) || 25));
  const skip = (Math.max(1, Number(page) || 1) - 1) * take;
  const [items, total] = await Promise.all([
    prisma.announcement.findMany({
      where,
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      skip, take,
    }),
    prisma.announcement.count({ where }),
  ]);
  return { items, total, page: Math.max(1, Number(page) || 1), pageSize: take };
}

// ── notification fan-out ─────────────────────────────────────────────────────
/**
 * Fan a PUBLISHED announcement out to its audience. Writes an IN_APP Notification per
 * recipient (the inbox source-of-truth) and best-effort multi-channel push via the
 * existing router (respecting each employee's notifyPrefs opt-out). Returns the count
 * of in-app notifications written. Never throws.
 */
async function fanOutAnnouncement(ann) {
  let recipients = [];
  try {
    recipients = await resolveAudienceEmployees(ann);
  } catch (_e) { recipients = []; }
  if (!recipients.length) return 0;

  const biz = await prisma.business.findUnique({ where: { id: ann.businessId }, select: { name: true } }).catch(() => null);
  const bizName = (biz && biz.name) || 'your employer';
  const link = '/feed';

  let written = 0;
  for (const emp of recipients) {
    // IN_APP — only when the employee has a portal user (recipientUserId is required).
    if (emp.userId) {
      try {
        await prisma.notification.create({
          data: {
            businessId: ann.businessId,
            recipientUserId: emp.userId,
            type: 'ONBOARDING_TASK', // closest existing in-app type; dataJson carries the real kind
            channel: 'IN_APP',
            title: ann.title,
            body: 'New announcement',
            entityType: 'Announcement',
            entityId: ann.id,
            dataJson: { kind: 'ANNOUNCEMENT', announcementId: ann.id, category: ann.category },
          },
        });
        written += 1;
      } catch (_e) { /* best-effort */ }
    }
    // Multi-channel push — respect per-employee opt-out (notifyPrefs.optOut).
    const prefs = emp.notifyPrefs || null;
    if (prefs && prefs.optOut === true) continue;
    const email = emp.workEmail || emp.personalEmail || null;
    const phone = emp.phone || null;
    if (!email && !phone) continue;
    notifyHrEvent({
      businessId: ann.businessId,
      event: 'announcement.published',
      recipientEmail: email,
      recipientPhone: phone,
      recipientCountry: emp.countryCode || undefined,
      variables: {
        NAME: emp.firstName || 'there',
        BIZ: bizName,
        TITLE: ann.title,
        LINK: link,
      },
      triggeredBy: `HR_ANNOUNCEMENT:${ann.id}:${emp.id}`,
    }).catch(() => {});
  }
  return written;
}

module.exports = {
  CATEGORIES, SCOPES,
  validate, normaliseAudience,
  create, update, publish, archive, remove, adminList,
  fanOutAnnouncement,
};
