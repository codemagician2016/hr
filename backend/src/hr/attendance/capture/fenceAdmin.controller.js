'use strict';

/**
 * fenceAdmin.controller.js — HR-admin surface for polygon geofences (Feature 39).
 * Operator session (req.user); tenant-scoped by req.user.businessId on EVERY query;
 * mutations canManageAttendance-gated at the route. Covers:
 *   - AttendanceGeoFence  : named map-drawn polygons (CRUD; polygon validated).
 *   - AttendanceFenceLink : attach a fence to a LOCATION (office zone) or to ONE
 *                           EMPLOYEE (individual restriction — overrides office zones).
 *   - Effective-zone preview: what zones a given employee actually resolves to.
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const { normalizeRing, ringCentroid } = require('../geo');
const capture = require('./policy');

// ── GET /attendance/capture/fences — fences + links (+ human labels) ──────────
async function listFences(req, res, next) {
  try {
    const { businessId } = req.user;
    const [fences, links] = await Promise.all([
      prisma.attendanceGeoFence.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
      prisma.attendanceFenceLink.findMany({ where: { businessId, isActive: true }, orderBy: { createdAt: 'asc' } }),
    ]);
    // Resolve link target labels in two small queries.
    const locIds = [...new Set(links.filter((l) => l.scopeKind === 'LOCATION').map((l) => l.scopeId))];
    const empIds = [...new Set(links.filter((l) => l.scopeKind === 'EMPLOYEE').map((l) => l.scopeId))];
    const [locs, emps] = await Promise.all([
      locIds.length ? prisma.location.findMany({ where: { businessId, id: { in: locIds } }, select: { id: true, name: true, code: true } }) : [],
      empIds.length ? prisma.employee.findMany({ where: { businessId, id: { in: empIds } }, select: { id: true, code: true, firstName: true, lastName: true } }) : [],
    ]);
    const locById = Object.fromEntries(locs.map((l) => [l.id, l]));
    const empById = Object.fromEntries(emps.map((e) => [e.id, e]));
    const linksByFence = {};
    for (const l of links) {
      const label = l.scopeKind === 'LOCATION'
        ? (locById[l.scopeId] ? locById[l.scopeId].name : 'Unknown location')
        : (empById[l.scopeId] ? `${empById[l.scopeId].firstName} ${empById[l.scopeId].lastName} (${empById[l.scopeId].code})` : 'Unknown employee');
      (linksByFence[l.fenceId] = linksByFence[l.fenceId] || []).push({ ...l, label });
    }
    res.json({ items: fences.map((f) => ({ ...f, links: linksByFence[f.id] || [] })) });
  } catch (e) { next(e); }
}

// ── POST /attendance/capture/fences { id?, name, description?, polygonJson, isActive? }
// Create or update (id present → update). The polygon is validated HARD at save so a
// degenerate ring can never silently disable a geofence at punch time.
async function upsertFence(req, res, next) {
  try {
    const { businessId } = req.user;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) return res.status(400).json({ message: 'name is required' });
    const ring = normalizeRing(b.polygonJson);
    if (!ring) return res.status(422).json({ message: 'polygonJson must be a closed ring of ≥3 [lng,lat] vertices with a non-zero area' });
    const centroid = ringCentroid(ring);
    const data = {
      name,
      description: b.description ? String(b.description) : null,
      polygonJson: ring, // store the CLEANED open ring — what the evaluator consumes
      centroidLat: centroid ? centroid.lat : null,
      centroidLng: centroid ? centroid.lng : null,
      isActive: b.isActive === false ? false : true,
    };
    let row;
    if (b.id) {
      const existing = await prisma.attendanceGeoFence.findFirst({ where: { id: b.id, businessId }, select: { id: true } });
      if (!existing) return res.status(404).json({ message: 'fence not found' });
      row = await prisma.attendanceGeoFence.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } });
    } else {
      row = await prisma.attendanceGeoFence.create({ data: { businessId, createdBy: req.user.id || null, ...data } });
    }
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.fence.upsert', entityType: 'AttendanceGeoFence', entityId: row.id }).catch(() => {});
    res.status(201).json(row);
  } catch (e) { next(e); }
}

// ── DELETE /attendance/capture/fences/:id — remove a fence + its links ────────
async function deleteFence(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await prisma.attendanceGeoFence.findFirst({ where: { id: req.params.id, businessId }, select: { id: true } });
    if (!row) return res.status(404).json({ message: 'fence not found' });
    await prisma.$transaction([
      prisma.attendanceFenceLink.deleteMany({ where: { businessId, fenceId: row.id } }),
      prisma.attendanceGeoFence.delete({ where: { id: row.id } }),
    ]);
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.fence.delete', entityType: 'AttendanceGeoFence', entityId: row.id }).catch(() => {});
    res.json({ deleted: true });
  } catch (e) { next(e); }
}

// ── POST /attendance/capture/fences/:id/links { scopeKind, scopeId } ──────────
// Attach the fence to an office location or an individual employee (tenant-validated).
async function addFenceLink(req, res, next) {
  try {
    const { businessId } = req.user;
    const fence = await prisma.attendanceGeoFence.findFirst({ where: { id: req.params.id, businessId }, select: { id: true } });
    if (!fence) return res.status(404).json({ message: 'fence not found' });
    const scopeKind = req.body && req.body.scopeKind;
    const scopeId = req.body && req.body.scopeId;
    if (!['LOCATION', 'EMPLOYEE'].includes(scopeKind) || !scopeId) {
      return res.status(400).json({ message: "scopeKind must be 'LOCATION' or 'EMPLOYEE' with a scopeId" });
    }
    if (scopeKind === 'LOCATION') {
      const loc = await prisma.location.findFirst({ where: { id: scopeId, businessId }, select: { id: true } });
      if (!loc) return res.status(404).json({ message: 'location not found in this tenant' });
    } else {
      const emp = await prisma.employee.findFirst({ where: { id: scopeId, businessId, deletedAt: null }, select: { id: true } });
      if (!emp) return res.status(404).json({ message: 'employee not found in this tenant' });
    }
    const row = await prisma.attendanceFenceLink.upsert({
      where: { businessId_fenceId_scopeKind_scopeId: { businessId, fenceId: fence.id, scopeKind, scopeId } },
      create: { businessId, fenceId: fence.id, scopeKind, scopeId, createdBy: req.user.id || null },
      update: { isActive: true },
    });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.fence.link.add', entityType: 'AttendanceFenceLink', entityId: row.id, meta: { scopeKind, scopeId } }).catch(() => {});
    res.status(201).json(row);
  } catch (e) { next(e); }
}

// ── DELETE /attendance/capture/fences/:id/links/:linkId ───────────────────────
async function deleteFenceLink(req, res, next) {
  try {
    const { businessId } = req.user;
    const row = await prisma.attendanceFenceLink.findFirst({
      where: { id: req.params.linkId, businessId, fenceId: req.params.id },
      select: { id: true },
    });
    if (!row) return res.status(404).json({ message: 'fence link not found' });
    await prisma.attendanceFenceLink.delete({ where: { id: row.id } });
    await writeAudit({ businessId, actorId: req.user.id, action: 'attendance.fence.link.delete', entityType: 'AttendanceFenceLink', entityId: row.id }).catch(() => {});
    res.json({ deleted: true });
  } catch (e) { next(e); }
}

// ── GET /attendance/capture/employees/:employeeId/zones — effective-zone preview ─
// What zones would a punch by THIS employee be evaluated against right now (and
// which policy scope applies)? Powers the admin "restrict this employee" UX.
async function employeeZones(req, res, next) {
  try {
    const { businessId } = req.user;
    const emp = await prisma.employee.findFirst({
      where: { id: req.params.employeeId, businessId, deletedAt: null },
      select: { id: true, code: true, firstName: true, lastName: true },
    });
    if (!emp) return res.status(404).json({ message: 'employee not found' });
    const employment = await prisma.employmentRecord.findFirst({
      where: { businessId, employeeId: emp.id, isCurrent: true },
      select: {
        entityId: true, locationId: true, departmentId: true,
        location: { select: { id: true, name: true, geoLat: true, geoLng: true, geofenceM: true } },
      },
    });
    const ctx = {
      employeeId: emp.id,
      entityId: employment ? employment.entityId : null,
      locationId: employment ? employment.locationId : null,
      departmentId: employment ? employment.departmentId : null,
      location: employment ? employment.location : null,
    };
    const [zones, policy] = await Promise.all([
      capture.loadZones(businessId, ctx),
      capture.resolvePolicy(businessId, ctx),
    ]);
    res.json({
      employee: emp,
      locationName: employment && employment.location ? employment.location.name : null,
      zones,
      policy: {
        scope: policy.scope,
        requireGeo: !!policy.requireGeo,
        requireIp: !!policy.requireIp,
        requireFace: !!policy.requireFace,
        geoEnforce: !!policy.geoEnforce,
        ipEnforce: !!policy.ipEnforce,
        faceEnforce: !!policy.faceEnforce,
      },
    });
  } catch (e) { next(e); }
}

module.exports = {
  listFences,
  upsertFence,
  deleteFence,
  addFenceLink,
  deleteFenceLink,
  employeeZones,
};
