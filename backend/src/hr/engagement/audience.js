'use strict';

/**
 * audience.js — Announcement audience scoping (tenant + Feature-1-aware).
 *
 * THE single chokepoint that decides "does THIS employee see THIS announcement".
 * An announcement targets the whole tenant (ALL) or narrows to one-or-more entities
 * / departments / a specific employee set. A reader is in-audience when their CURRENT
 * employment segment (entity/department, from the isCurrent EmploymentRecord) or their
 * own employeeId intersects the target.
 *
 * Two surfaces share this module:
 *   - resolveEmployeeSegment(businessId, employeeId)
 *       → { entityId, departmentId } for the reader's CURRENT segment (one cheap read).
 *   - audienceMatchesEmployee(announcement, segment, employeeId)
 *       → boolean in-memory intersection (no per-announcement join).
 *   - feedWhereForEmployee({ businessId, employeeId, segment, now })
 *       → a Prisma `where` that returns ONLY published + in-window + in-audience rows,
 *         so the DB never ships an out-of-audience announcement to the wire.
 *
 * Tenant isolation is ALWAYS carried by businessId in the where (never relaxed here).
 */

const prisma = require('../../core/lib/prisma');

const SCOPE = Object.freeze({ ALL: 'ALL', ENTITY: 'ENTITY', DEPARTMENT: 'DEPARTMENT', SPECIFIC: 'SPECIFIC' });

// Feature 37 (LMS) — the course-assignment audience IS the announcement audience model,
// plus a ROLE band (target employees by their assigned BusinessRole). LEARNING_SCOPE
// extends SCOPE additively; the announcement SCOPE above is untouched so its feed +
// notification suites stay green. resolveLearningAudienceEmployees() below reuses the
// announcement fan-out branches verbatim and only ADDS the ROLE branch.
const LEARNING_SCOPE = Object.freeze({ ...SCOPE, ROLE: 'ROLE' });

/**
 * Resolve the reader's CURRENT employment segment (entity + department). Reads the
 * one EmploymentRecord flagged isCurrent (the denormalised "now" segment the rest of
 * the platform maintains per revision). Returns { entityId, departmentId } — either
 * may be null (a not-yet-provisioned employee has no current record → {null,null},
 * which still matches an ALL announcement but no narrowed one, fail-closed).
 */
async function resolveEmployeeSegment(businessId, employeeId) {
  if (!businessId || !employeeId) return { entityId: null, departmentId: null };
  const rec = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: { entityId: true, departmentId: true },
    orderBy: { effectiveFrom: 'desc' },
  });
  return { entityId: rec ? rec.entityId : null, departmentId: rec ? rec.departmentId || null : null };
}

/**
 * In-memory audience test — does `announcement` reach the employee with `segment`?
 * Pure; no DB. Used to double-gate a single fetched announcement (defence-in-depth
 * on top of the feed where), and by the notification fan-out recipient filter.
 */
function audienceMatchesEmployee(announcement, segment, employeeId) {
  if (!announcement) return false;
  const scope = announcement.audienceScope || SCOPE.ALL;
  if (scope === SCOPE.ALL) return true;
  if (scope === SCOPE.ENTITY) {
    const ids = announcement.audienceEntityIds || [];
    return !!segment && !!segment.entityId && ids.includes(segment.entityId);
  }
  if (scope === SCOPE.DEPARTMENT) {
    const ids = announcement.audienceDeptIds || [];
    return !!segment && !!segment.departmentId && ids.includes(segment.departmentId);
  }
  if (scope === SCOPE.SPECIFIC) {
    const ids = announcement.audienceEmployeeIds || [];
    return !!employeeId && ids.includes(employeeId);
  }
  return false;
}

/**
 * Build the Prisma `where` for the ESS news feed of one employee. Returns ONLY
 * PUBLISHED announcements whose go-live has passed (publishedAt <= now) and whose
 * expiry (if any) is still in the future — AND that the employee is in-audience for.
 * Tenant-scoped by businessId. The audience clause is an OR over the four scopes so a
 * single indexed query returns the in-audience set (no client-side filtering needed).
 */
function feedWhereForEmployee({ businessId, employeeId, segment, now = new Date() }) {
  const audienceOr = [{ audienceScope: SCOPE.ALL }];
  if (segment && segment.entityId) {
    audienceOr.push({ audienceScope: SCOPE.ENTITY, audienceEntityIds: { has: segment.entityId } });
  }
  if (segment && segment.departmentId) {
    audienceOr.push({ audienceScope: SCOPE.DEPARTMENT, audienceDeptIds: { has: segment.departmentId } });
  }
  if (employeeId) {
    audienceOr.push({ audienceScope: SCOPE.SPECIFIC, audienceEmployeeIds: { has: employeeId } });
  }
  return {
    businessId,
    status: 'PUBLISHED',
    publishedAt: { not: null, lte: now },
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    AND: [{ OR: audienceOr }],
  };
}

/**
 * Resolve the set of recipient employees for a published announcement (for the
 * notification fan-out). Returns Employee rows (id + contact + notifyPrefs) limited
 * to the announcement's audience, active + non-deleted only. Capped to avoid a
 * runaway fan-out on a huge ALL audience (the IN_APP feed remains the source of truth;
 * multi-channel push is best-effort).
 */
async function resolveAudienceEmployees(announcement, { cap = 2000 } = {}) {
  const businessId = announcement.businessId;
  const base = { businessId, deletedAt: null, isActive: true, status: 'ACTIVE' };
  const scope = announcement.audienceScope || SCOPE.ALL;
  const select = {
    id: true, code: true, firstName: true, lastName: true, userId: true,
    workEmail: true, personalEmail: true, phone: true, countryCode: true, notifyPrefs: true,
  };

  if (scope === SCOPE.SPECIFIC) {
    const ids = announcement.audienceEmployeeIds || [];
    if (!ids.length) return [];
    return prisma.employee.findMany({ where: { ...base, id: { in: ids } }, select, take: cap });
  }
  if (scope === SCOPE.ALL) {
    return prisma.employee.findMany({ where: base, select, take: cap });
  }
  // ENTITY / DEPARTMENT — match via the employee's CURRENT employment segment.
  const recWhere = { businessId, isCurrent: true };
  if (scope === SCOPE.ENTITY) {
    const ids = announcement.audienceEntityIds || [];
    if (!ids.length) return [];
    recWhere.entityId = { in: ids };
  } else if (scope === SCOPE.DEPARTMENT) {
    const ids = announcement.audienceDeptIds || [];
    if (!ids.length) return [];
    recWhere.departmentId = { in: ids };
  }
  const recs = await prisma.employmentRecord.findMany({ where: recWhere, select: { employeeId: true }, take: cap });
  const empIds = [...new Set(recs.map((r) => r.employeeId))];
  if (!empIds.length) return [];
  return prisma.employee.findMany({ where: { ...base, id: { in: empIds } }, select, take: cap });
}

/**
 * Feature 37 (LMS) — resolve the recipient employees for a CourseAssignment. This is
 * the announcement fan-out (resolveAudienceEmployees) with one ADDED branch: ROLE,
 * which targets employees whose linked User.businessRoleId is in audienceRoleIds. The
 * assignment record shares the same field shape as Announcement
 * (audienceScope/audienceEntityIds/audienceDeptIds/audienceEmployeeIds) plus
 * audienceRoleIds. Returns Employee rows (id + contact), active + non-deleted only,
 * capped — same convention as the announcement fan-out. NO new scope engine.
 */
async function resolveLearningAudienceEmployees(assignment, { cap = 2000 } = {}) {
  const scope = assignment.audienceScope || LEARNING_SCOPE.ALL;
  if (scope === LEARNING_SCOPE.ROLE) {
    const businessId = assignment.businessId;
    const base = { businessId, deletedAt: null, isActive: true, status: 'ACTIVE' };
    const select = {
      id: true, code: true, firstName: true, lastName: true, userId: true,
      workEmail: true, personalEmail: true, phone: true, countryCode: true, notifyPrefs: true,
    };
    const roleIds = assignment.audienceRoleIds || [];
    if (!roleIds.length) return [];
    // Employee -> User (userId) -> User.businessRoleId ∈ roleIds.
    return prisma.employee.findMany({
      where: { ...base, user: { is: { businessRoleId: { in: roleIds } } } },
      select,
      take: cap,
    });
  }
  // ALL / ENTITY / DEPARTMENT / SPECIFIC — identical to the announcement fan-out.
  return resolveAudienceEmployees(assignment, { cap });
}

module.exports = {
  SCOPE,
  LEARNING_SCOPE,
  resolveEmployeeSegment,
  audienceMatchesEmployee,
  feedWhereForEmployee,
  resolveAudienceEmployees,
  resolveLearningAudienceEmployees,
};
