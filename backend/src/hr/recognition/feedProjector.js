'use strict';

/**
 * feedProjector.js — Feature 35 §4.1 Option A (chosen): the recognition WALL *is*
 * the Cycle-1 engagement feed. When a recognition POSTS we write ONE
 * CELEBRATION-category Announcement so it flows through the EXISTING
 * /me/engagement/feed (audience scoping, pagination, read receipts) with zero new
 * feed code. The Recognition row stays the system-of-record; the announcement is
 * the projection (Recognition.announcementId links them).
 *
 * Audience mirror (visibility → Announcement.audienceScope):
 *   PUBLIC  → ALL         (the whole tenant wall)
 *   TEAM    → DEPARTMENT  (the recipients' current departments)
 *   PRIVATE → SPECIFIC    (the recipients + the giver only)
 * The feed audience chokepoint (feedWhereForEmployee) keeps a narrowed projection
 * off the wrong wall — no new visibility logic (§8 "visibility leaks").
 *
 * The projection is created PUBLISHED with notifiedAt STAMPED so the announcement
 * fan-out can never re-blast the audience — recognition notifications are the
 * domain-level 'recognition.received' events fired by the posting path instead.
 *
 * Runs INSIDE the caller's tx (give-inline or the RECOGNITION consumer).
 */

function fullName(emp) {
  if (!emp) return 'A colleague';
  return [emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code || 'A colleague';
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** PURE — compose the projected announcement title + body from the loaded parts. */
function composeProjection({ giver, recipients, value, badge, message, pointsEach }) {
  const giverName = fullName(giver);
  const names = joinNames(recipients.map(fullName));
  const forValue = value ? ` for “${value.name}”` : '';
  const title = `🎉 ${giverName} recognised ${names}${forValue}`;
  const parts = [];
  if (badge) parts.push(`${badge.icon ? `${badge.icon} ` : ''}Badge: ${badge.name}`);
  if (pointsEach > 0) parts.push(`+${pointsEach} point(s) each`);
  const tagLine = parts.length ? `\n\n${parts.join(' · ')}` : '';
  const body = `${String(message || '').trim()}${tagLine}`;
  return { title, body };
}

/**
 * Project a just-POSTED recognition onto the engagement feed. Returns the created
 * Announcement (or null when nothing to project). Idempotent: a recognition that
 * already carries announcementId is a no-op.
 */
async function projectRecognitionToFeed(tx, { recognition, now = new Date() }) {
  if (!recognition || recognition.announcementId) return null;
  const businessId = recognition.businessId;

  const [giver, recipients, value, badge] = await Promise.all([
    tx.employee.findFirst({
      where: { id: recognition.giverEmployeeId, businessId },
      select: { id: true, code: true, firstName: true, lastName: true, userId: true },
    }),
    tx.recognitionRecipient.findMany({
      where: { recognitionId: recognition.id },
      select: { employeeId: true, employee: { select: { id: true, code: true, firstName: true, lastName: true } } },
    }),
    recognition.valueId
      ? tx.recognitionValue.findFirst({ where: { id: recognition.valueId, businessId }, select: { name: true, icon: true } })
      : null,
    recognition.badgeId
      ? tx.recognitionBadge.findFirst({ where: { id: recognition.badgeId, businessId }, select: { name: true, icon: true } })
      : null,
  ]);
  const recipientEmployees = recipients.map((r) => r.employee).filter(Boolean);
  if (!recipientEmployees.length) return null;

  const { title, body } = composeProjection({
    giver, recipients: recipientEmployees, value, badge,
    message: recognition.message, pointsEach: recognition.pointsEach || 0,
  });

  // Audience mirror.
  let audience = { audienceScope: 'ALL', audienceEntityIds: [], audienceDeptIds: [], audienceEmployeeIds: [] };
  if (recognition.visibility === 'PRIVATE') {
    const ids = [...new Set([...recipientEmployees.map((e) => e.id), recognition.giverEmployeeId])];
    audience = { audienceScope: 'SPECIFIC', audienceEntityIds: [], audienceDeptIds: [], audienceEmployeeIds: ids };
  } else if (recognition.visibility === 'TEAM') {
    const recs = await tx.employmentRecord.findMany({
      where: { businessId, isCurrent: true, employeeId: { in: recipientEmployees.map((e) => e.id) } },
      select: { departmentId: true },
    });
    const deptIds = [...new Set(recs.map((r) => r.departmentId).filter(Boolean))];
    audience = deptIds.length
      ? { audienceScope: 'DEPARTMENT', audienceEntityIds: [], audienceDeptIds: deptIds, audienceEmployeeIds: [] }
      // No resolvable department — fall back to SPECIFIC (never leak wider than asked).
      : { audienceScope: 'SPECIFIC', audienceEntityIds: [], audienceDeptIds: [], audienceEmployeeIds: [...new Set([...recipientEmployees.map((e) => e.id), recognition.giverEmployeeId])] };
  }

  const ann = await tx.announcement.create({
    data: {
      businessId,
      authorUserId: (giver && giver.userId) || 'SYSTEM',
      authorName: fullName(giver),
      title: title.slice(0, 300),
      bodyRichText: body.slice(0, 50000),
      category: 'CELEBRATION',
      ...audience,
      pinned: false,
      status: 'PUBLISHED',
      publishedAt: now,
      // Stamp notifiedAt so the announcement publish fan-out can never re-blast —
      // the recognition path fires its own 'recognition.received' notifications.
      notifiedAt: now,
    },
  });

  await tx.recognition.updateMany({
    where: { id: recognition.id, announcementId: null },
    data: { announcementId: ann.id },
  });
  return ann;
}

module.exports = { projectRecognitionToFeed, composeProjection };
