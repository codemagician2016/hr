'use strict';

/**
 * captureAdmin.controller.js — HR-admin surface for the multi-mode Attendance
 * Capture Policy (Feature 2). Operator session (req.user); tenant-scoped by
 * req.user.businessId on EVERY query. All mutations are canManageAttendance-gated
 * at the route. Covers:
 *   - AttendanceCapturePolicy  : per-tenant / per-scope mode policy (geo/IP/face) CRUD.
 *   - LocationOfficeIp         : the office CIDR allow-list per location (IP mode).
 *   - Review queue             : flagged punches (off-network / low face score / etc.)
 *                                that a human clears or rejects.
 *
 * This controller NEVER touches derive.js / service.js engine math. Clearing a
 * flagged punch only flips its review status; it does not re-derive the day (the
 * rollup already reflects the punch). Geofence config still lives on Location.
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');

const SCOPES = ['TENANT', 'ENTITY', 'LOCATION', 'EMPLOYEE_GROUP', 'EMPLOYEE'];

function asBool(v, dflt = false) {
  if (v === true || v === false) return v;
  if (v == null) return dflt;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return !!v;
}
function asThreshold(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n));
}

// ── GET /attendance/capture/policies — list this tenant's capture policies ────
async function listPolicies(req, res, next) {
  try {
    const { businessId } = req.user;
    const rows = await prisma.attendanceCapturePolicy.findMany({
      where: { businessId },
      orderBy: [{ scope: 'asc' }, { updatedAt: 'desc' }],
    });
    res.json({ items: rows });
  } catch (e) { next(e); }
}

// ── POST /attendance/capture/policies — create/replace a policy for a scope ───
// One active policy per (tenant, scope, scopeId): we UPSERT on that unique key so
// re-saving the same scope edits in place rather than 409-ing.
async function upsertPolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    const scope = SCOPES.includes(b.scope) ? b.scope : 'TENANT';
    const scopeId = scope === 'TENANT' ? null : (b.scopeId || null);
    if (scope !== 'TENANT' && !scopeId) {
      return res.status(400).json({ message: `scopeId is required for scope ${scope}` });
    }
    // Validate the scope target exists in THIS tenant (IDOR-safe; no cross-tenant ids).
    if (scope === 'ENTITY' && scopeId) {
      const ent = await prisma.entity.findFirst({ where: { id: scopeId, businessId }, select: { id: true } });
      if (!ent) return res.status(404).json({ message: 'entity not found in this tenant' });
    }
    if (scope === 'LOCATION' && scopeId) {
      const loc = await prisma.location.findFirst({ where: { id: scopeId, businessId }, select: { id: true } });
      if (!loc) return res.status(404).json({ message: 'location not found in this tenant' });
    }
    if (scope === 'EMPLOYEE_GROUP' && scopeId) {
      const dep = await prisma.department.findFirst({ where: { id: scopeId, businessId }, select: { id: true } });
      if (!dep) return res.status(404).json({ message: 'department (employee group) not found in this tenant' });
    }
    if (scope === 'EMPLOYEE' && scopeId) {
      // Feature 39 — per-person policy override (highest precedence in the resolver).
      const emp = await prisma.employee.findFirst({ where: { id: scopeId, businessId, deletedAt: null }, select: { id: true } });
      if (!emp) return res.status(404).json({ message: 'employee not found in this tenant' });
    }

    const data = {
      name: b.name || null,
      requireGeo: asBool(b.requireGeo),
      requireIp: asBool(b.requireIp),
      requireFace: asBool(b.requireFace),
      geoEnforce: asBool(b.geoEnforce),
      ipEnforce: asBool(b.ipEnforce),
      faceEnforce: asBool(b.faceEnforce),
      faceThreshold: asThreshold(b.faceThreshold),
      isActive: asBool(b.isActive, true),
    };

    // find-then-write, NOT prisma.upsert: the compound unique includes the
    // NULLABLE scopeId, and Prisma rejects null inside a unique `where` input —
    // a TENANT-scope save (scopeId null) 500s under upsert (found by the
    // Feature-40 end-to-end audit; the @@unique still guards racing creates).
    const existing = await prisma.attendanceCapturePolicy.findFirst({
      where: { businessId, scope, scopeId },
      select: { id: true },
    });
    const row = existing
      ? await prisma.attendanceCapturePolicy.update({
          where: { id: existing.id },
          data: { ...data, version: { increment: 1 } },
        })
      : await prisma.attendanceCapturePolicy.create({
          data: { businessId, scope, scopeId, createdBy: req.user.id || null, ...data },
        });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.capture.policy.upsert', entityType: 'AttendanceCapturePolicy', entityId: row.id }).catch(() => {});
    res.status(201).json(row);
  } catch (e) { next(e); }
}

// ── DELETE /attendance/capture/policies/:id — remove a policy (tenant-scoped) ──
async function deletePolicy(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await prisma.attendanceCapturePolicy.findFirst({ where: { id: req.params.id, businessId }, select: { id: true } });
    if (!row) return res.status(404).json({ message: 'policy not found' });
    await prisma.attendanceCapturePolicy.delete({ where: { id: row.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.capture.policy.delete', entityType: 'AttendanceCapturePolicy', entityId: row.id }).catch(() => {});
    res.json({ deleted: true });
  } catch (e) { next(e); }
}

// ── GET /attendance/capture/locations/:locationId/ips — list office CIDRs ──────
async function listLocationIps(req, res, next) {
  try {
    const { businessId } = req.user;
    const { locationId } = req.params;
    const loc = await prisma.location.findFirst({ where: { id: locationId, businessId }, select: { id: true } });
    if (!loc) return res.status(404).json({ message: 'location not found' });
    const rows = await prisma.locationOfficeIp.findMany({
      where: { businessId, locationId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ items: rows });
  } catch (e) { next(e); }
}

// Minimal CIDR/IP syntax guard (reuses ip.js parser) so a malformed entry can't land.
const { parseCidr } = require('./ip');

// ── POST /attendance/capture/locations/:locationId/ips { cidr, label } ────────
async function addLocationIp(req, res, next) {
  try {
    const { businessId } = req.user;
    const { locationId } = req.params;
    const cidr = String((req.body && req.body.cidr) || '').trim();
    if (!cidr) return res.status(400).json({ message: 'cidr is required' });
    if (!parseCidr(cidr)) return res.status(422).json({ message: 'cidr is not a valid IPv4/IPv6 CIDR or address' });
    const loc = await prisma.location.findFirst({ where: { id: locationId, businessId }, select: { id: true } });
    if (!loc) return res.status(404).json({ message: 'location not found' });
    const row = await prisma.locationOfficeIp.create({
      data: { businessId, locationId, cidr, label: (req.body && req.body.label) || null, createdBy: req.user.id || null },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.capture.ip.add', entityType: 'LocationOfficeIp', entityId: row.id }).catch(() => {});
    res.status(201).json(row);
  } catch (e) { next(e); }
}

// ── DELETE /attendance/capture/locations/:locationId/ips/:id ──────────────────
async function deleteLocationIp(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await prisma.locationOfficeIp.findFirst({ where: { id: req.params.id, businessId, locationId: req.params.locationId }, select: { id: true } });
    if (!row) return res.status(404).json({ message: 'CIDR entry not found' });
    await prisma.locationOfficeIp.delete({ where: { id: row.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.capture.ip.delete', entityType: 'LocationOfficeIp', entityId: row.id }).catch(() => {});
    res.json({ deleted: true });
  } catch (e) { next(e); }
}

// ── GET /attendance/capture/review?status=PENDING — the flagged-punch queue ────
function clampPage(query) {
  const take = Math.min(Math.max(parseInt(query.pageSize, 10) || 25, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}
async function listReviewQueue(req, res, next) {
  try {
    const { businessId } = req.user;
    const { take, skip, page } = clampPage(req.query);
    // Default to the PENDING flagged punches; allow CLEARED/REJECTED filtering too.
    const status = ['PENDING', 'CLEARED', 'REJECTED'].includes(req.query.status) ? req.query.status : 'PENDING';
    const where = { businessId, captureFlagged: true, reviewStatus: status };
    const [items, total] = await Promise.all([
      prisma.attendancePunch.findMany({
        where,
        orderBy: { punchAt: 'desc' },
        skip,
        take,
        select: {
          id: true, employeeId: true, punchType: true, punchAt: true, source: true,
          locationId: true, geoLat: true, geoLng: true, outOfGeofence: true, geoDistanceM: true,
          ipAddress: true, ipAllowed: true, selfieUrl: true,
          faceMatchScore: true, faceMatched: true, faceMatchStatus: true,
          captureMethods: true, captureFlagReasons: true, reviewStatus: true,
          reviewedBy: true, reviewedAt: true, reviewNote: true,
        },
      }),
      prisma.attendancePunch.count({ where }),
    ]);
    // Resolve employee labels for the rows (small set, one query).
    const empIds = [...new Set(items.map((p) => p.employeeId))];
    let empById = {};
    if (empIds.length) {
      const emps = await prisma.employee.findMany({
        where: { businessId, id: { in: empIds } },
        select: { id: true, code: true, firstName: true, lastName: true },
      });
      empById = Object.fromEntries(emps.map((e) => [e.id, e]));
    }
    res.json({ items: items.map((p) => ({ ...p, employee: empById[p.employeeId] || null })), total, page, pageSize: take });
  } catch (e) { next(e); }
}

// ── POST /attendance/capture/review/:id { decision: 'CLEAR'|'REJECT', note? } ──
// Acts on ONE flagged punch. CLEAR = HR accepts it as legitimate; REJECT = out of
// policy. Tenant-scoped (a foreign punch id → 404). Does NOT re-derive the day.
async function actOnReview(req, res, next) {
  try {
    const { businessId } = req.user;
    const punch = await prisma.attendancePunch.findFirst({
      where: { id: req.params.id, businessId, captureFlagged: true },
      select: { id: true, reviewStatus: true },
    });
    if (!punch) return res.status(404).json({ message: 'flagged punch not found' });
    const decision = String((req.body && req.body.decision) || '').toUpperCase();
    const next2 = decision === 'CLEAR' ? 'CLEARED' : decision === 'REJECT' ? 'REJECTED' : null;
    if (!next2) return res.status(400).json({ message: "decision must be 'CLEAR' or 'REJECT'" });
    const updated = await prisma.attendancePunch.update({
      where: { id: punch.id },
      data: {
        reviewStatus: next2,
        reviewedBy: req.user.id || null,
        reviewedAt: new Date(),
        reviewNote: (req.body && req.body.note) || null,
      },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: `attendance.capture.review.${next2.toLowerCase()}`, entityType: 'AttendancePunch', entityId: punch.id }).catch(() => {});
    res.json(updated);
  } catch (e) { next(e); }
}

module.exports = {
  listPolicies,
  upsertPolicy,
  deletePolicy,
  listLocationIps,
  addLocationIp,
  deleteLocationIp,
  listReviewQueue,
  actOnReview,
};
