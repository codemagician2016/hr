'use strict';

/**
 * meAttendance.controller.js — Employee Self-Service (ESS) attendance API,
 * mounted at /api/hr/me/attendance. CUSTOMER session (req.customer); the subject
 * employee is resolved ENTIRELY from the session (workEmail/personalEmail/linked
 * User), so there is NO `:employeeId` (or any other employee id) accepted from
 * the client — a cross-employee read/write is structurally impossible (SELF_ONLY).
 *
 * The ESS attendance page was previously pointed at the operator surface
 * (/api/hr/attendance/*), which is operator-JWT-only and 401s for a customer
 * session (audit #53/#55). This surface authenticates the customer session and
 * derives employeeId SERVER-SIDE for every read and every write (punch / timesheet
 * submit / correction), so a forged or foreign employeeId can never land on the
 * wrong person's record.
 *
 * Terminated/inactive employees are locked out (404) — the same ESS lockout the
 * rest of the /me/* surface applies.
 *
 * Punch derivation (recompute), the period-lock guard and the employee-timezone
 * civil-day bucketing mirror the operator attendance controller so the ESS and
 * operator paths agree on every rule.
 */

const prisma = require('../../core/lib/prisma');
const s3 = require('../../core/lib/s3');
const payrollService = require('../payroll/service');
const { recompute } = require('../attendance/service');
const { resolveTimezone, civilDateInTz } = require('../attendance/tz');
const { resolveApprover } = require('../lib/approvalRouting');
const { tenantCountry } = require('../tenant/countryContext');
// Feature 29 — ESS shift-swap rides the F10 SHIFT_SWAP approval engine.
const engine = require('../approvals/engine');
// Feature 2 (multi-mode capture) — policy resolver + enforcement (geo/IP/face).
const capture = require('../attendance/capture/policy');
const faceMatcher = require('../attendance/capture/faceMatcher');

const PUNCH_TYPES = ['IN', 'OUT', 'BREAK_START', 'BREAK_END'];
// Mirror the RegularizationKind enum in prisma/schema.prisma exactly — writing a
// value outside this set makes Prisma 500; we reject with a 400 instead.
const REGULARIZATION_KINDS = ['MISSED_PUNCH', 'LATE_WAIVER', 'EARLY_OUT_WAIVER', 'WFH', 'ON_DUTY'];

// ── self-employee bridge ─────────────────────────────────────────────────────
// Resolve the signed-in customer to their ACTIVE Employee. Returns the employee
// row or null. Terminated/soft-deleted/inactive → null (ESS lockout). Every
// handler below funnels through this — the employee id is NEVER taken from input.
async function resolveActiveSelf(req) {
  const { businessId } = req.customer;
  const employeeId = await payrollService.resolveSelfEmployee(businessId, req.customer);
  if (!employeeId) return null;
  const emp = await prisma.employee.findFirst({
    where: { id: employeeId, businessId, deletedAt: null },
    select: { id: true, countryCode: true, isActive: true },
  });
  if (!emp || emp.isActive === false) return null;
  return emp;
}

function clampPage(query) {
  const take = Math.min(Math.max(parseInt(query.pageSize, 10) || 50, 1), 200);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

function utcDay(value) {
  const t = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
function civilKeyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) return utcDay(new Date(key));
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

async function resolveEmployeeTz(businessId, employeeId, employee) {
  const employment = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: {
      entity: { select: { timezone: true, countryCode: true } },
      location: { select: { timezone: true, countryCode: true } },
    },
  });
  const business = await prisma.business.findFirst({ where: { id: businessId }, select: { timezone: true } });
  return resolveTimezone(
    { countryCode: employee ? employee.countryCode : null },
    { location: employment ? employment.location : null, entity: employment ? employment.entity : null, business },
  );
}
function civilDayInTz(instant, tz) {
  return civilKeyToDate(civilDateInTz(instant, tz));
}
async function isDayLocked(businessId, employeeId, day, db = prisma) {
  const row = await db.attendance.findFirst({
    where: { businessId, employeeId, date: utcDay(day), isLocked: true },
    select: { id: true },
  });
  return !!row;
}

const noEmployee = (res) => res.status(404).json({ message: 'No active employee record for this account' });

// Parse a geo coordinate from the punch body: a finite number in range, else null.
// Lat ∈ [-90,90], Lng ∈ [-180,180]. Anything else (string junk, out-of-range, NaN)
// degrades to null so a malformed coord never crashes / never marks out-of-geofence.
function parseCoord(v, max) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  return n;
}

// Feature 2 — validate an inbound selfie data URL (FACE capture). Accepts only a
// base64 image data URL within a sane size cap (DoS guard: size computed from the
// base64 length WITHOUT allocating). Returns { ok, dataUrl } or { ok:false, status,
// message }. A malformed/oversize selfie is rejected up-front (the matcher never sees
// junk). Mirrors documents.controller's validateDocDataUrl posture.
const MAX_SELFIE_BYTES = 6 * 1024 * 1024; // 6 MB — a phone selfie is well under this
function validateSelfieDataUrl(dataUrl) {
  if (dataUrl == null || dataUrl === '') return { ok: true, dataUrl: null }; // optional
  if (typeof dataUrl !== 'string') return { ok: false, status: 400, message: 'selfieDataUrl must be a data URL string' };
  const m = /^data:(image\/(?:png|jpe?g|webp))(;base64)?,(.*)$/i.exec(dataUrl);
  if (!m || !m[2]) return { ok: false, status: 422, message: 'selfieDataUrl must be a base64 image data URL (png/jpeg/webp)' };
  const b64 = m[3] || '';
  const approxBytes = Math.floor((b64.length * 3) / 4);
  if (approxBytes > MAX_SELFIE_BYTES) return { ok: false, status: 413, message: `Selfie exceeds the ${MAX_SELFIE_BYTES / (1024 * 1024)} MB limit` };
  return { ok: true, dataUrl, mime: m[1] };
}

// Store a selfie data URL for audit: real object storage when configured, else the
// data URL is persisted inline (dev/test) — same fallback documents.controller uses.
async function storeSelfie(businessId, dataUrl) {
  if (!dataUrl) return null;
  if (s3.isConfigured()) {
    try {
      const up = await s3.uploadDataUrl({ dataUrl, businessId, scope: 'attendance-selfie' });
      return up.url;
    } catch (_e) {
      return dataUrl; // never fail a punch on a storage hiccup — keep the bytes inline
    }
  }
  return dataUrl;
}

// Resolve the capture context (entity/location/department + the Location geofence
// row) for an employee's CURRENT employment. Used by the punch enforcement + the
// /policy preview endpoint. Tenant-scoped.
async function resolveCaptureContext(businessId, employeeId) {
  const employment = await prisma.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: {
      entityId: true, locationId: true, departmentId: true,
      location: { select: { id: true, geoLat: true, geoLng: true, geofenceM: true, geofenceEnforce: true } },
    },
  });
  return {
    entityId: employment ? employment.entityId : null,
    locationId: employment ? employment.locationId : null,
    departmentId: employment ? employment.departmentId : null,
    location: employment ? employment.location : null,
  };
}

// ── POST /me/attendance/punch — clock IN/OUT/BREAK (self only) ────────────────
// employeeId is derived from the session; the body carries { type, punchAt?,
// geoLat?, geoLng? } (coords drive the geofence check; source is NEVER trusted).
async function createPunch(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const { type } = req.body || {};
    if (!PUNCH_TYPES.includes(type)) {
      return res.status(400).json({ message: `type must be one of ${PUNCH_TYPES.join(', ')}` });
    }
    const punchAt = req.body && req.body.punchAt ? new Date(req.body.punchAt) : new Date();
    if (Number.isNaN(punchAt.getTime())) return res.status(400).json({ message: 'punchAt is not a valid date' });
    const geoLat = parseCoord(req.body && req.body.geoLat, 90);
    const geoLng = parseCoord(req.body && req.body.geoLng, 180);

    // Feature 2 — validate the optional selfie up-front (size/MIME) before any work.
    const selfieCheck = validateSelfieDataUrl(req.body && req.body.selfieDataUrl);
    if (!selfieCheck.ok) return res.status(selfieCheck.status).json({ message: selfieCheck.message });
    const selfieDataUrl = selfieCheck.dataUrl;

    const tz = await resolveEmployeeTz(businessId, emp.id, emp);
    const localDay = civilDayInTz(punchAt, tz);
    if (await isDayLocked(businessId, emp.id, localDay)) {
      return res.status(409).json({ message: 'Attendance for this day is locked (period closed)' });
    }

    // Stamp the assigned location so the punch carries its site context (and the
    // geofence is evaluated against it in recompute). Best-effort: a missing
    // employment/location simply leaves locationId null (no geofence → no flag).
    const ctx = await resolveCaptureContext(businessId, emp.id);

    // Feature 2 — resolve + ENFORCE the multi-mode capture policy (geo/IP/face).
    // The trusted req.ip (single nginx hop via app.set('trust proxy',1)) is NOT
    // spoofable via raw XFF. A hard ENFORCE failure rejects BEFORE we create the
    // punch; a WARN failure flags the punch + queues it for HR review.
    const verdict = await capture.evaluatePunchCapture(
      businessId,
      ctx,
      { geoLat, geoLng, ip: req.ip || null, selfieDataUrl },
      { employeeId: emp.id },
    );
    if (verdict.reject) {
      return res.status(403).json({
        message: verdict.reason || 'Punch rejected by attendance capture policy',
        reason: 'CAPTURE_POLICY',
        methods: verdict.methods,
        flags: verdict.flags,
      });
    }

    // Store the selfie for audit (object storage when configured; inline otherwise).
    const selfieUrl = await storeSelfie(businessId, selfieDataUrl);
    const marks = verdict.marks || {};
    const flagged = !!marks.captureFlagged;

    const punch = await prisma.attendancePunch.create({
      data: {
        businessId,
        employeeId: emp.id,
        punchType: type,
        source: 'WEB', // ESS self-punch — never trust a client-supplied source.
        punchAt,
        locationId: ctx.locationId || null,
        geoLat, // Decimal pass-through (validated finite + in range); null otherwise.
        geoLng,
        ipAddress: req.ip || null,
        selfieUrl,
        // Feature 2 capture marks (additive). reviewStatus PENDING parks a flagged
        // punch in the HR review queue; a clean punch carries no review row.
        captureMethods: marks.captureMethods || [],
        ipAllowed: marks.ipAllowed != null ? marks.ipAllowed : null,
        faceMatchScore: marks.faceMatchScore != null ? marks.faceMatchScore : null,
        faceMatched: marks.faceMatched != null ? marks.faceMatched : null,
        faceMatchStatus: marks.faceMatchStatus || null,
        captureFlagged: flagged,
        captureFlagReasons: marks.captureFlagReasons || [],
        reviewStatus: flagged ? 'PENDING' : null,
      },
    });
    // recompute runs the Haversine geofence check (geoLat/geoLng vs the assigned
    // Location.geofenceM) and stamps punch.outOfGeofence + surfaces OUT_OF_GEOFENCE.
    // (Engine math untouched — we only call recompute, exactly as before.)
    await recompute(businessId, emp.id, localDay, localDay);
    // Re-read so the response carries the geofence marker the recompute just stamped.
    const stamped = await prisma.attendancePunch.findUnique({ where: { id: punch.id } });
    res.status(201).json({ ...(stamped || punch), captureFlagged: flagged, captureFlagReasons: marks.captureFlagReasons || [] });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/policy — the capture policy that applies to ME ─────────
// Tells the mobile/web client which methods are required (so it can prompt for a
// selfie when FACE is on). SELF_ONLY: resolved from the session's employment.
async function getCapturePolicy(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ requireGeo: false, requireIp: false, requireFace: false, faceEnrolled: false });
    const { businessId } = req.customer;
    const ctx = await resolveCaptureContext(businessId, emp.id);
    const policy = await capture.resolvePolicy(businessId, ctx);
    const ref = await capture.loadFaceReference(businessId, emp.id);
    res.json({
      scope: policy.scope,
      requireGeo: !!policy.requireGeo,
      requireIp: !!policy.requireIp,
      requireFace: !!policy.requireFace,
      geoEnforce: !!policy.geoEnforce,
      ipEnforce: !!policy.ipEnforce,
      faceEnforce: !!policy.faceEnforce,
      // Does the assigned location actually have a geofence? (so the client knows geo
      // can be evaluated). Coords come from the location row in ctx.
      hasGeofence: !!(ctx.location && ctx.location.geoLat != null && ctx.location.geoLng != null && ctx.location.geofenceM),
      faceEnrolled: !!ref.hasReference,
    });
  } catch (e) { next(e); }
}

// ── POST /me/attendance/face/enroll { selfieDataUrl } — enroll MY reference face ─
// SELF_ONLY. Stores the reference selfie (audit) + computes an embedding via the
// pluggable matcher (null for the stub). Upserts the single active enrollment.
async function enrollFace(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const check = validateSelfieDataUrl(req.body && req.body.selfieDataUrl);
    if (!check.ok) return res.status(check.status).json({ message: check.message });
    if (!check.dataUrl) return res.status(400).json({ message: 'selfieDataUrl is required to enroll a face' });

    const imageUrl = await storeSelfie(businessId, check.dataUrl);
    const embedded = await faceMatcher.getMatcher().embed(check.dataUrl, {});

    const row = await prisma.faceEnrollment.upsert({
      where: { businessId_employeeId: { businessId, employeeId: emp.id } },
      create: {
        businessId, employeeId: emp.id, imageUrl,
        embedding: embedded.embedding || undefined,
        matcher: embedded.matcher || null,
        enrolledBy: emp.id,
      },
      update: {
        imageUrl,
        embedding: embedded.embedding || undefined,
        matcher: embedded.matcher || null,
        isActive: true,
        enrolledAt: new Date(),
        enrolledBy: emp.id,
        version: { increment: 1 },
      },
    });
    res.status(201).json({ enrolled: true, matcher: row.matcher, enrolledAt: row.enrolledAt });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/face — is MY face enrolled? (for the enrollment screen) ──
async function getFaceEnrollment(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ enrolled: false });
    const { businessId } = req.customer;
    const row = await prisma.faceEnrollment.findFirst({
      where: { businessId, employeeId: emp.id, isActive: true },
      select: { enrolledAt: true, matcher: true },
    });
    res.json({ enrolled: !!row, enrolledAt: row ? row.enrolledAt : null, matcher: row ? row.matcher : null });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/punches?from=&to= — own punches ────────────────────────
async function listPunches(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [], total: 0, page: 1, pageSize: 50 });
    const { businessId } = req.customer;
    const { from, to } = req.query;
    const { take, skip, page } = clampPage(req.query);

    const where = { businessId, employeeId: emp.id };
    if (from || to) {
      where.punchAt = {};
      if (from) where.punchAt.gte = new Date(from);
      if (to) where.punchAt.lte = new Date(to);
    }
    const [items, total] = await Promise.all([
      prisma.attendancePunch.findMany({ where, orderBy: { punchAt: 'desc' }, skip, take }),
      prisma.attendancePunch.count({ where }),
    ]);
    res.json({ items, total, page, pageSize: take });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/summary?from=&to= — own daily rollup buckets ───────────
async function summary(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ groupBy: 'status', total: 0, buckets: [] });
    const { businessId } = req.customer;
    const { from, to } = req.query;
    const where = { businessId, employeeId: emp.id };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = utcDay(from);
      if (to) where.date.lte = utcDay(to);
    }
    const grouped = await prisma.attendance.groupBy({
      by: ['status'], where, _count: { _all: true }, _sum: { lopFraction: true, overtimeMinutes: true },
    });
    const buckets = grouped.map((g) => ({
      key: g.status,
      count: g._count._all,
      lopDays: Number(g._sum.lopFraction || 0),
      overtimeMinutes: g._sum.overtimeMinutes || 0,
    }));
    res.json({ groupBy: 'status', total: buckets.reduce((a, b) => a + b.count, 0), buckets });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/days?from=&to= — own PER-DAY rollup rows ───────────────
// One row per civil day in range from the Attendance table (the authoritative
// per-day rollup the recompute writes). `summary` above groups by status for the
// dashboard donut; this returns the individual day rows the ESS "Attendance
// Details" table renders (date, status, firstIn/lastOut, workedMinutes, shift).
// SELF_ONLY: employeeId is the session's; the query carries only from/to.
async function listDays(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [] });
    const { businessId } = req.customer;
    const { from, to } = req.query;
    const where = { businessId, employeeId: emp.id };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = utcDay(from);
      if (to) where.date.lte = utcDay(to);
    }
    const rows = await prisma.attendance.findMany({
      where,
      orderBy: { date: 'asc' },
      select: {
        id: true, date: true, status: true, shiftPatternId: true,
        firstIn: true, lastOut: true, workedMinutes: true, breakMinutes: true,
        overtimeMinutes: true, lopFraction: true, isLocked: true,
      },
    });
    // Resolve shift labels for the patterns referenced (small set, one query).
    const patternIds = [...new Set(rows.map((r) => r.shiftPatternId).filter(Boolean))];
    let patternsById = {};
    if (patternIds.length) {
      const patterns = await prisma.shiftPattern.findMany({
        where: { businessId, id: { in: patternIds } },
        select: { id: true, name: true, code: true, startTime: true, endTime: true, isFlexi: true, isNightShift: true },
      });
      patternsById = Object.fromEntries(patterns.map((p) => [p.id, p]));
    }
    const items = rows.map((r) => ({
      ...r,
      lopFraction: Number(r.lopFraction || 0),
      shift: r.shiftPatternId ? (patternsById[r.shiftPatternId] || null) : null,
    }));
    res.json({ items });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/timesheets — own timesheets ────────────────────────────
async function listTimesheets(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [], total: 0 });
    const { businessId } = req.customer;
    const where = { businessId, employeeId: emp.id };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.timesheet.findMany({
      where, orderBy: { periodStart: 'desc' }, take: 100,
    });
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/timesheets/:id — own timesheet detail (+ day entries) ──
async function getTimesheet(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.status(404).json({ message: 'Timesheet not found' });
    const { businessId } = req.customer;
    // SELF_ONLY: a timesheet whose employeeId ≠ self resolves to 404 (IDOR-safe).
    const ts = await prisma.timesheet.findFirst({
      where: { id: req.params.id, businessId, employeeId: emp.id },
      include: { entries: { orderBy: { date: 'asc' } } },
    });
    if (!ts) return res.status(404).json({ message: 'Timesheet not found' });
    res.json(ts);
  } catch (e) { next(e); }
}

// ── POST /me/attendance/timesheets/:id/submit — submit own DRAFT timesheet ────
async function submitTimesheet(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.status(404).json({ message: 'Timesheet not found' });
    const { businessId } = req.customer;
    const ts = await prisma.timesheet.findFirst({
      where: { id: req.params.id, businessId, employeeId: emp.id },
    });
    if (!ts) return res.status(404).json({ message: 'Timesheet not found' });
    if (ts.status !== 'DRAFT' && ts.status !== 'REJECTED') {
      return res.status(409).json({ message: `Cannot submit a timesheet in status ${ts.status}` });
    }
    const updated = await prisma.timesheet.update({
      where: { id: ts.id },
      data: { status: 'SUBMITTED', submittedAt: new Date(), version: { increment: 1 } },
    });
    res.json(updated);
  } catch (e) { next(e); }
}

// ── GET /me/attendance/regularizations — own correction requests ──────────────
async function listRegularizations(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [] });
    const { businessId } = req.customer;
    const where = { businessId, employeeId: emp.id };
    if (req.query.status) where.status = req.query.status;
    const items = await prisma.attendanceRegularizationRequest.findMany({
      where, orderBy: { date: 'desc' }, take: 200,
    });
    res.json({ items });
  } catch (e) { next(e); }
}

// ── POST /me/attendance/regularizations — raise own correction request ────────
// employeeId is the session's; the body carries date/kind/reason/times only.
async function createRegularization(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const { date, requestedInAt, requestedOutAt, reason } = req.body || {};
    const kind = (req.body && req.body.kind) || 'MISSED_PUNCH';
    if (!date) return res.status(400).json({ message: 'date is required' });
    if (!REGULARIZATION_KINDS.includes(kind)) {
      return res.status(400).json({ message: `kind must be one of ${REGULARIZATION_KINDS.join(', ')}` });
    }
    if (!reason) return res.status(400).json({ message: 'reason is required' });

    const d = utcDay(date);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'date is not a valid YYYY-MM-DD' });
    if (await isDayLocked(businessId, emp.id, d)) {
      return res.status(409).json({ message: 'Attendance for this day is locked (period closed)' });
    }

    // Full employee row for approver routing (manager → escalate → HR fallback).
    const fullEmp = await prisma.employee.findFirst({ where: { id: emp.id, businessId, deletedAt: null } });
    const approver = await resolveApprover(fullEmp);

    const reqRow = await prisma.attendanceRegularizationRequest.create({
      data: {
        businessId,
        employeeId: emp.id,
        date: d,
        kind,
        requestedInAt: requestedInAt ? new Date(requestedInAt) : null,
        requestedOutAt: requestedOutAt ? new Date(requestedOutAt) : null,
        reason,
        status: 'PENDING',
        approvalRequestId: approver && approver.employeeId ? approver.employeeId
          : (approver && approver.userId ? approver.userId : null),
      },
    });
    res.status(201).json(reqRow);
  } catch (e) { next(e); }
}

// ── GET /me/attendance/schedule?from&to — own shift assignment + PUBLISHED roster ──
// Feature 29 — when from/to are supplied, also return the PUBLISHED roster week/month
// (per-day shift or OFF). The single covering assignment is still returned for the
// legacy "what's my shift" card; the roster[] drives the my-shifts strip. Only
// PUBLISHED cells are exposed (an employee never sees a DRAFT plan).
async function getSchedule(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ shift: null, assignment: null, roster: [] });
    const { businessId } = req.customer;
    const today = utcDay(new Date());
    const assignment = await prisma.shiftAssignment.findFirst({
      where: {
        businessId, employeeId: emp.id,
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      include: { shiftPattern: true },
    });

    let roster = [];
    if (req.query.from && req.query.to) {
      const rows = await prisma.rosterDay.findMany({
        where: { businessId, employeeId: emp.id, status: 'PUBLISHED', date: { gte: utcDay(req.query.from), lte: utcDay(req.query.to) } },
        include: { shiftPattern: { select: { id: true, code: true, name: true, startTime: true, endTime: true, breakMinutes: true, isNightShift: true } } },
        orderBy: { date: 'asc' },
      });
      roster = rows.map((r) => ({
        date: utcDay(r.date).toISOString().slice(0, 10),
        dayType: r.dayType, source: r.source, shift: r.shiftPattern || null,
      }));
    }

    if (!assignment) return res.json({ shift: null, assignment: null, roster });
    const { shiftPattern, ...assignmentRow } = assignment;
    res.json({ shift: shiftPattern || null, assignment: assignmentRow, roster });
  } catch (e) { next(e); }
}

// ── GET /me/attendance/holidays?year= — own market's holiday calendar ─────────
// countryCode is RESOLVED server-side from the TENANT (never client-supplied,
// never widened by a null per-row employee/entity countryCode).
async function listHolidays(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return res.json({ items: [], countryCode: null });
    const { businessId } = req.customer;
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    // F14 — fail-CLOSED on the TENANT country. The per-row employee/entity
    // countryCode is NOT consulted: the query is ALWAYS pinned to the tenant's HR
    // country so a null employee/entity countryCode can never widen the list to
    // off-country rows. tenantCountry throws fail-closed on a missing/ambiguous
    // tenant rather than returning every row.
    const holidayCountry = await tenantCountry(businessId);
    const where = { businessId, countryCode: holidayCountry, date: { gte: yearStart, lte: yearEnd } };
    const rows = await prisma.holiday.findMany({ where, orderBy: { date: 'asc' } });
    // Normalize to the shape the ESS schedule page expects (observedDate alias).
    const items = rows.map((h) => ({ ...h, observedDate: h.date }));
    res.json({ items, countryCode: holidayCountry });
  } catch (e) { next(e); }
}

/* ------------------------------------------------------------------ */
/* Feature 29 — ESS shift swaps (SELF_ONLY; subject from session)      */
/* ------------------------------------------------------------------ */

// GET /me/shifts/swaps — my swap requests (sent + received).
async function listMySwaps(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const items = await prisma.shiftSwapRequest.findMany({
      where: { businessId, OR: [{ requesterEmployeeId: emp.id }, { counterpartyEmployeeId: emp.id }] },
      orderBy: { createdAt: 'desc' },
      include: {
        requester: { select: { id: true, code: true, firstName: true, lastName: true } },
        counterparty: { select: { id: true, code: true, firstName: true, lastName: true } },
      },
    });
    res.json({ items: items.map((s) => ({ ...s, role: s.requesterEmployeeId === emp.id ? 'REQUESTER' : 'COUNTERPARTY' })) });
  } catch (e) { next(e); }
}

// A published, unlocked WORK/OFF cell must exist for (employee, day) to swap it.
async function publishedCell(businessId, employeeId, date, db = prisma) {
  return db.rosterDay.findFirst({ where: { businessId, employeeId, date: utcDay(date), status: 'PUBLISHED' } });
}

// POST /me/shifts/swaps { counterpartyEmployeeId, requesterDate, counterpartyDate, reason }
async function createMySwap(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const { counterpartyEmployeeId, requesterDate, counterpartyDate, reason } = req.body;
    if (!counterpartyEmployeeId || !requesterDate || !counterpartyDate || !reason) {
      return res.status(400).json({ message: 'counterpartyEmployeeId, requesterDate, counterpartyDate and reason are required' });
    }
    if (counterpartyEmployeeId === emp.id) return res.status(400).json({ message: 'Cannot swap with yourself' });
    // Counterparty must be a real, active peer in the SAME tenant (IDOR-safe).
    const cp = await prisma.employee.findFirst({ where: { id: counterpartyEmployeeId, businessId, deletedAt: null, isActive: true }, select: { id: true } });
    if (!cp) return res.status(404).json({ message: 'Counterparty not found' });
    // Both days must be PUBLISHED & unlocked.
    const [cellA, cellB] = await Promise.all([
      publishedCell(businessId, emp.id, requesterDate),
      publishedCell(businessId, counterpartyEmployeeId, counterpartyDate),
    ]);
    if (!cellA || !cellB) return res.status(409).json({ message: 'Both days must have a published roster shift to swap' });
    if (await isDayLocked(businessId, emp.id, requesterDate) || await isDayLocked(businessId, counterpartyEmployeeId, counterpartyDate)) {
      return res.status(409).json({ message: 'A day is in a locked attendance period' });
    }
    const created = await prisma.shiftSwapRequest.create({
      data: {
        businessId, requesterEmployeeId: emp.id, counterpartyEmployeeId,
        requesterDate: utcDay(requesterDate), counterpartyDate: utcDay(counterpartyDate),
        reason, counterpartyConsent: 'PENDING', status: 'PENDING',
      },
    });
    res.status(201).json(created);
  } catch (e) { next(e); }
}

// POST /me/shifts/swaps/:id/consent { decision: 'ACCEPT'|'DECLINE' }
// Only the COUNTERPARTY may call. ACCEPT opens the F10 chain; DECLINE closes it.
async function consentMySwap(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const swap = await prisma.shiftSwapRequest.findFirst({ where: { id: req.params.id, businessId } });
    // IDOR-safe: a non-counterparty caller gets a 404 (cannot even confirm existence).
    if (!swap || swap.counterpartyEmployeeId !== emp.id) return res.status(404).json({ message: 'Swap not found' });
    if (swap.status !== 'PENDING' || swap.counterpartyConsent !== 'PENDING') {
      return res.status(409).json({ message: `Swap is already ${swap.counterpartyConsent}/${swap.status}` });
    }
    const decision = String(req.body.decision || '').toUpperCase();
    if (decision === 'DECLINE') {
      const updated = await prisma.shiftSwapRequest.update({
        where: { id: swap.id },
        data: { counterpartyConsent: 'DECLINED', status: 'CANCELLED', decidedAt: new Date(), decidedBy: emp.id },
      });
      return res.json(updated);
    }
    if (decision !== 'ACCEPT') return res.status(400).json({ message: "decision must be 'ACCEPT' or 'DECLINE'" });

    // ACCEPT: mark consent + open the F10 SHIFT_SWAP manager chain (same as leave).
    const updated = await prisma.$transaction(async (tx) => {
      // Re-validate the file-time invariant IN-TX before opening the chain: both cells
      // must STILL be PUBLISHED and neither day locked. createMySwap checked this at
      // FILE time, but an admin may have reverted a cell to DRAFT or the period may have
      // locked since; applySwap re-checks again at APPROVE, but opening a doomed chain
      // here would only burn manager-queue time. Reading under the tx keeps the consent
      // decision and the cell/lock state consistent (no stale-read window). 409 if stale.
      const [cellA, cellB] = await Promise.all([
        publishedCell(businessId, swap.requesterEmployeeId, swap.requesterDate, tx),
        publishedCell(businessId, swap.counterpartyEmployeeId, swap.counterpartyDate, tx),
      ]);
      if (!cellA || !cellB) {
        const e = new Error('Both days must have a published roster shift to swap');
        e.code = 'SWAP_NOT_PUBLISHED';
        throw e;
      }
      const [lockA, lockB] = await Promise.all([
        isDayLocked(businessId, swap.requesterEmployeeId, swap.requesterDate, tx),
        isDayLocked(businessId, swap.counterpartyEmployeeId, swap.counterpartyDate, tx),
      ]);
      if (lockA || lockB) {
        const e = new Error('A day is in a locked attendance period');
        e.code = 'SWAP_LOCKED_DAY';
        throw e;
      }
      const u = await tx.shiftSwapRequest.update({ where: { id: swap.id }, data: { counterpartyConsent: 'ACCEPTED' } });
      const opened = await engine.openRequest({
        businessId,
        module: 'SHIFT_SWAP',
        entityType: 'ShiftSwapRequest',
        entityId: swap.id,
        requesterEmployeeId: swap.requesterEmployeeId,
        payload: { requesterDate: u.requesterDate, counterpartyDate: u.counterpartyDate, reason: u.reason, counterpartyEmployeeId: u.counterpartyEmployeeId },
        ctx: { entityId: swap.id },
      }, tx);
      const reqId = opened && opened.approvalRequest ? opened.approvalRequest.id : null;
      if (reqId) await tx.shiftSwapRequest.update({ where: { id: swap.id }, data: { approvalRequestId: reqId } });
      return tx.shiftSwapRequest.findUnique({ where: { id: swap.id } });
    });
    res.json(updated);
  } catch (e) {
    if (e && (e.code === 'DECISION_RACE' || e.code === 'P2025')) {
      return res.status(409).json({ message: 'Swap changed concurrently; please retry', reason: 'DECISION_RACE' });
    }
    if (e && e.code && String(e.code).startsWith('SWAP_')) {
      return res.status(409).json({ message: e.message, reason: e.code });
    }
    next(e);
  }
}

// POST /me/shifts/swaps/:id/withdraw — requester withdraws (drives engine.withdraw/cancel).
async function withdrawMySwap(req, res, next) {
  try {
    const emp = await resolveActiveSelf(req);
    if (!emp) return noEmployee(res);
    const { businessId } = req.customer;
    const swap = await prisma.shiftSwapRequest.findFirst({ where: { id: req.params.id, businessId } });
    if (!swap || swap.requesterEmployeeId !== emp.id) return res.status(404).json({ message: 'Swap not found' });
    if (swap.status !== 'PENDING') return res.status(409).json({ message: `Swap is already ${swap.status}` });
    // If an approval chain is open, cancel it (fires onCancel → CANCELLED). Otherwise
    // (consent still pending, no chain) just close the request directly.
    const open = await prisma.approvalRequest.findFirst({
      where: { businessId, module: 'SHIFT_SWAP', entityType: 'ShiftSwapRequest', entityId: swap.id, status: { in: ['PENDING', 'ESCALATED'] } },
    });
    if (open) {
      await engine.cancel({ approvalRequestId: open.id, actorUserId: emp.id, comment: req.body.reason || 'Withdrawn by requester' });
    } else {
      await prisma.shiftSwapRequest.updateMany({ where: { id: swap.id, status: 'PENDING' }, data: { status: 'CANCELLED', decidedAt: new Date(), decidedBy: emp.id } });
    }
    const fresh = await prisma.shiftSwapRequest.findUnique({ where: { id: swap.id } });
    res.json(fresh);
  } catch (e) { next(e); }
}

module.exports = {
  createPunch,
  // Feature 2 — multi-mode capture (policy preview + face enrolment)
  getCapturePolicy,
  enrollFace,
  getFaceEnrollment,
  listPunches,
  summary,
  listDays,
  listTimesheets,
  getTimesheet,
  submitTimesheet,
  listRegularizations,
  createRegularization,
  getSchedule,
  listHolidays,
  // Feature 29 — ESS shift swaps
  listMySwaps,
  createMySwap,
  consentMySwap,
  withdrawMySwap,
};
