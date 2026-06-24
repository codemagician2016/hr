'use strict';

/**
 * devices.service.js — Feature 28 operator surface logic: device registry CRUD,
 * device-code→employee mapping CRUD, raw-event triage, reprocess + manual correction.
 * All tenant-scoped by businessId; gated by canManageAttendance at the route. The
 * ingest pipeline (ingest.service / committer) is reused for reprocess/correct, so a
 * corrected/reprocessed event flows through the SAME materialise + recompute path.
 */

const prisma = require('../../../core/lib/prisma');
const { writeAudit } = require('../../../core/lib/audit');
const { mintSecret } = require('./deviceSecret');
const { VENDOR_DEFAULT_ADAPTER, getAdapter, adapterKeys } = require('./adapters');
const ingest = require('./ingest.service');
const { recompute } = require('../service');
const { civilDateInTz } = require('../tz');

const VENDORS = ['ESSL', 'ZKTECO', 'MATRIX', 'MANTRA', 'CAMS', 'REALTIME', 'BIOMAX', 'GENERIC'];
const DIRECTION_MODES = ['TRUST_DEVICE', 'DERIVE', 'ALL_IN'];
const POLL_KINDS = ['SFTP', 'FOLDER'];

class BioError extends Error {
  constructor(code, message, statusCode = 400) { super(message || code); this.name = 'BioError'; this.code = code; this.statusCode = statusCode; }
}
const notFound = (m) => new BioError('NOT_FOUND', m, 404);
const badRequest = (c, m) => new BioError(c, m, 400);

function clampPage(query) {
  const take = Math.min(Math.max(parseInt(query.pageSize, 10) || 25, 1), 200);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}

// Strip secret hashes from a device row before returning it to the operator.
function safeDevice(d) {
  if (!d) return d;
  const { ingestSecretHash, pollConfigJson, ...rest } = d;
  // Hide secret refs inside pollConfigJson too.
  const safePoll = pollConfigJson ? { ...pollConfigJson, keyRef: pollConfigJson.keyRef ? '***' : undefined, __lastSilentAlertAt: undefined } : null;
  return { ...rest, hasIngestSecret: !!ingestSecretHash, pollConfig: safePoll };
}

// ── Devices ──────────────────────────────────────────────────────────────────
async function listDevices({ businessId, entityId, locationId, query = {} }) {
  const { take, skip, page } = clampPage(query);
  const where = { businessId, deletedAt: null };
  if (entityId) where.entityId = entityId;
  if (locationId) where.locationId = locationId;
  const [items, total] = await Promise.all([
    prisma.punchDevice.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    prisma.punchDevice.count({ where }),
  ]);
  // Today's punch count per device (cheap rollup for the health card).
  const out = [];
  for (const d of items) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const todayCount = await prisma.rawPunchEvent.count({ where: { businessId, deviceId: d.id, createdAt: { gte: since } } });
    out.push({ ...safeDevice(d), todayCount, health: deviceHealth(d) });
  }
  return { items: out, total, page, pageSize: take };
}

// green = seen in the last hour; amber = quiet but within expectedSilenceMin; red =
// silent past expectedSilenceMin (or never seen with a threshold set).
function deviceHealth(d) {
  const now = Date.now();
  const lastSeen = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0;
  const sinceMin = lastSeen ? (now - lastSeen) / 60000 : Infinity;
  if (lastSeen && sinceMin <= 60) return 'green';
  if (d.expectedSilenceMin && sinceMin > d.expectedSilenceMin) return 'red';
  if (!lastSeen) return 'amber';
  return 'amber';
}

async function getDevice({ businessId, id }) {
  const d = await prisma.punchDevice.findFirst({ where: { id, businessId, deletedAt: null } });
  if (!d) throw notFound('Device not found');
  return safeDevice(d);
}

async function createDevice({ businessId, actorId, body }) {
  const b = body || {};
  if (!b.name) throw badRequest('REQUIRED', 'name is required');
  if (!VENDORS.includes(b.vendor)) throw badRequest('BAD_VENDOR', `vendor must be one of ${VENDORS.join(', ')}`);
  if (!b.entityId) throw badRequest('REQUIRED', 'entityId is required');
  const entity = await prisma.entity.findFirst({ where: { id: b.entityId, businessId, deletedAt: null }, select: { id: true } });
  if (!entity) throw badRequest('UNKNOWN_ENTITY', `entityId "${b.entityId}" not found in this tenant`);
  if (b.locationId) {
    const loc = await prisma.location.findFirst({ where: { id: b.locationId, businessId, entityId: b.entityId }, select: { id: true } });
    if (!loc) throw badRequest('UNKNOWN_LOCATION', `locationId "${b.locationId}" not found under this entity`);
  }
  const adapterKey = b.adapterKey || VENDOR_DEFAULT_ADAPTER[b.vendor] || 'generic.csv';
  if (!getAdapter(adapterKey)) throw badRequest('BAD_ADAPTER', `adapterKey "${adapterKey}" is not registered (one of ${adapterKeys.join(', ')})`);
  const directionMode = b.directionMode && DIRECTION_MODES.includes(b.directionMode) ? b.directionMode : 'DERIVE';
  if (b.pollKind && !POLL_KINDS.includes(b.pollKind)) throw badRequest('BAD_POLL', `pollKind must be one of ${POLL_KINDS.join(', ')}`);

  const d = await prisma.punchDevice.create({
    data: {
      businessId, entityId: b.entityId, locationId: b.locationId || null,
      vendor: b.vendor, adapterKey, name: b.name, serialNumber: b.serialNumber || null,
      directionMode,
      dedupWindowSec: Number.isFinite(b.dedupWindowSec) ? b.dedupWindowSec : 60,
      fallbackToEmployeeCode: b.fallbackToEmployeeCode !== false,
      clockOffsetSec: Number.isFinite(b.clockOffsetSec) ? b.clockOffsetSec : 0,
      pollKind: b.pollKind || null,
      pollConfigJson: b.pollConfig || null,
      expectedSilenceMin: Number.isFinite(b.expectedSilenceMin) ? b.expectedSilenceMin : null,
      timezone: b.timezone || null,
      isActive: b.isActive !== false,
    },
  });
  await writeAudit({ businessId, actorId, action: 'biometric.device_create', entityType: 'PunchDevice', entityId: d.id, meta: { name: d.name, vendor: d.vendor, serial: d.serialNumber } });
  return safeDevice(d);
}

async function updateDevice({ businessId, actorId, id, body }) {
  const d = await prisma.punchDevice.findFirst({ where: { id, businessId, deletedAt: null } });
  if (!d) throw notFound('Device not found');
  const b = body || {};
  const data = {};
  for (const f of ['name', 'serialNumber', 'timezone']) if (b[f] !== undefined) data[f] = b[f];
  if (b.directionMode !== undefined) { if (!DIRECTION_MODES.includes(b.directionMode)) throw badRequest('BAD_MODE', 'bad directionMode'); data.directionMode = b.directionMode; }
  if (b.adapterKey !== undefined) { if (!getAdapter(b.adapterKey)) throw badRequest('BAD_ADAPTER', `adapterKey "${b.adapterKey}" not registered`); data.adapterKey = b.adapterKey; }
  if (b.dedupWindowSec !== undefined) data.dedupWindowSec = Number(b.dedupWindowSec) || 0;
  if (b.clockOffsetSec !== undefined) data.clockOffsetSec = Number(b.clockOffsetSec) || 0;
  if (b.fallbackToEmployeeCode !== undefined) data.fallbackToEmployeeCode = !!b.fallbackToEmployeeCode;
  if (b.expectedSilenceMin !== undefined) data.expectedSilenceMin = b.expectedSilenceMin == null ? null : Number(b.expectedSilenceMin);
  if (b.isActive !== undefined) data.isActive = !!b.isActive;
  if (b.pollKind !== undefined) { if (b.pollKind && !POLL_KINDS.includes(b.pollKind)) throw badRequest('BAD_POLL', 'bad pollKind'); data.pollKind = b.pollKind || null; }
  if (b.pollConfig !== undefined) data.pollConfigJson = b.pollConfig || null;
  if (b.locationId !== undefined) {
    if (b.locationId) { const loc = await prisma.location.findFirst({ where: { id: b.locationId, businessId, entityId: d.entityId }, select: { id: true } }); if (!loc) throw badRequest('UNKNOWN_LOCATION', 'locationId not under this entity'); }
    data.locationId = b.locationId || null;
  }
  data.version = { increment: 1 };
  const upd = await prisma.punchDevice.update({ where: { id }, data });
  await writeAudit({ businessId, actorId, action: 'biometric.device_update', entityType: 'PunchDevice', entityId: id, meta: { changed: Object.keys(data) } });
  return safeDevice(upd);
}

async function deleteDevice({ businessId, actorId, id }) {
  const d = await prisma.punchDevice.findFirst({ where: { id, businessId, deletedAt: null } });
  if (!d) throw notFound('Device not found');
  await prisma.punchDevice.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
  await writeAudit({ businessId, actorId, action: 'biometric.device_delete', entityType: 'PunchDevice', entityId: id, meta: { name: d.name } });
  return { ok: true };
}

// Mint/rotate the push secret — the RAW secret is returned ONCE; we store the hash.
async function rotateSecret({ businessId, actorId, id }) {
  const d = await prisma.punchDevice.findFirst({ where: { id, businessId, deletedAt: null } });
  if (!d) throw notFound('Device not found');
  const { raw, hash, last4 } = mintSecret();
  await prisma.punchDevice.update({ where: { id }, data: { ingestSecretHash: hash, ingestSecretLast4: last4, version: { increment: 1 } } });
  await writeAudit({ businessId, actorId, action: 'biometric.secret_rotate', entityType: 'PunchDevice', entityId: id, meta: { last4 } });
  return { secret: raw, last4 }; // shown ONCE
}

// ── Raw events (audit + triage) ────────────────────────────────────────────────
async function listEvents({ businessId, deviceId, status, from, to, query = {} }) {
  const { take, skip, page } = clampPage(query);
  const where = { businessId };
  if (deviceId) where.deviceId = deviceId;
  if (status) where.status = status;
  if (from || to) { where.punchAt = {}; if (from) where.punchAt.gte = new Date(from); if (to) where.punchAt.lte = new Date(to); }
  const [items, total] = await Promise.all([
    prisma.rawPunchEvent.findMany({ where, orderBy: { punchAt: 'desc' }, skip, take }),
    prisma.rawPunchEvent.count({ where }),
  ]);
  return { items, total, page, pageSize: take };
}

// Count UNMAPPED device codes seen in the last N days (the "unmapped codes" banner).
async function unmappedCodes({ businessId, days = 7 }) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const rows = await prisma.rawPunchEvent.findMany({
    where: { businessId, status: 'UNMAPPED', createdAt: { gte: since } },
    select: { deviceCode: true, deviceId: true },
    take: 5000,
  });
  const counts = new Map();
  for (const r of rows) { const k = r.deviceCode; counts.set(k, (counts.get(k) || 0) + 1); }
  return { items: [...counts.entries()].map(([deviceCode, count]) => ({ deviceCode, count })).sort((a, b) => b.count - a.count) };
}

// ── Mapping CRUD ───────────────────────────────────────────────────────────────
async function listMaps({ businessId, deviceId, query = {} }) {
  const { take, skip, page } = clampPage(query);
  const where = { businessId };
  if (deviceId !== undefined) where.deviceId = deviceId || null;
  const [items, total] = await Promise.all([
    prisma.deviceEmployeeMap.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { employee: { select: { id: true, code: true, firstName: true, lastName: true } } } }),
    prisma.deviceEmployeeMap.count({ where }),
  ]);
  return { items, total, page, pageSize: take };
}

async function createMap({ businessId, actorId, body }) {
  const b = body || {};
  if (!b.deviceCode) throw badRequest('REQUIRED', 'deviceCode is required');
  if (!b.employeeCode && !b.employeeId) throw badRequest('REQUIRED', 'employeeCode or employeeId is required');
  let employee = null;
  if (b.employeeId) employee = await prisma.employee.findFirst({ where: { id: b.employeeId, businessId, deletedAt: null }, select: { id: true } });
  else employee = await prisma.employee.findFirst({ where: { code: b.employeeCode, businessId, deletedAt: null }, select: { id: true } });
  if (!employee) throw badRequest('UNKNOWN_EMPLOYEE', 'employee not found in this tenant');
  let deviceId = b.deviceId || null;
  if (deviceId) { const d = await prisma.punchDevice.findFirst({ where: { id: deviceId, businessId, deletedAt: null }, select: { id: true } }); if (!d) throw badRequest('UNKNOWN_DEVICE', 'device not found'); }
  // Idempotent upsert on (businessId, deviceId, deviceCode).
  const existing = await prisma.deviceEmployeeMap.findFirst({ where: { businessId, deviceId, deviceCode: b.deviceCode } });
  let row;
  if (existing) row = await prisma.deviceEmployeeMap.update({ where: { id: existing.id }, data: { employeeId: employee.id } });
  else row = await prisma.deviceEmployeeMap.create({ data: { businessId, deviceId, deviceCode: b.deviceCode, employeeId: employee.id, createdBy: actorId || null } });
  await writeAudit({ businessId, actorId, action: 'biometric.map_create', entityType: 'DeviceEmployeeMap', entityId: row.id, meta: { deviceCode: b.deviceCode, employeeId: employee.id, deviceId } });
  return row;
}

async function deleteMap({ businessId, actorId, id }) {
  const m = await prisma.deviceEmployeeMap.findFirst({ where: { id, businessId } });
  if (!m) throw notFound('Mapping not found');
  await prisma.deviceEmployeeMap.delete({ where: { id } });
  await writeAudit({ businessId, actorId, action: 'biometric.map_delete', entityType: 'DeviceEmployeeMap', entityId: id, meta: { deviceCode: m.deviceCode } });
  return { ok: true };
}

// Bulk map upload: CSV of deviceCode,employeeCode (reuses the F18 csv parser).
async function bulkMaps({ businessId, actorId, deviceId = null, contentBase64 }) {
  if (!contentBase64) throw badRequest('NO_FILE', 'file content required');
  const csvLib = require('../../migration/parsers/csv');
  const { stripCommentLines } = require('../../migration/imports.service');
  const buf = Buffer.from(String(contentBase64).replace(/^data:[^;,]+;base64,/, ''), 'base64');
  const parsed = csvLib.parseCsv(stripCommentLines(buf.toString('utf8')));
  let created = 0; let failed = 0; const errors = [];
  for (const row of parsed.rows) {
    const lc = {}; for (const k of Object.keys(row)) lc[k.toLowerCase()] = row[k];
    const deviceCode = lc.devicecode || lc['device code'] || lc.code || lc.enrollno || lc.pin;
    const employeeCode = lc.employeecode || lc['employee code'] || lc.empcode;
    try { await createMap({ businessId, actorId, body: { deviceCode, employeeCode, deviceId } }); created += 1; }
    catch (e) { failed += 1; errors.push({ deviceCode, employeeCode, error: e.message }); }
  }
  await writeAudit({ businessId, actorId, action: 'biometric.map_bulk', entityType: 'DeviceEmployeeMap', meta: { created, failed } });
  return { created, failed, errors };
}

// ── Reprocess parked rows (UNMAPPED/LOCKED/ERROR) after a fix (§6.4 / §10.1) ────
async function reprocess({ businessId, actorId, statuses = ['UNMAPPED', 'LOCKED', 'ERROR'], deviceId = null }) {
  const where = { businessId, status: { in: statuses } };
  if (deviceId) where.deviceId = deviceId;
  const rows = await prisma.rawPunchEvent.findMany({ where, take: 5000 });
  let remapped = 0; let stillParked = 0;
  const tzCache = new Map();
  const toMaterialise = new Map(); // `${employeeId}|${civilDay}` → { employeeId, civilDayKey, deviceId }
  for (const ev of rows) {
    const device = await deviceFor(ev.deviceId, businessId);
    if (!device) { stillParked += 1; continue; }
    const employeeId = await ingest.resolveEmployeeId(prisma, businessId, device, ev.deviceCode);
    if (!employeeId) { stillParked += 1; continue; }
    // Re-MAP the raw event.
    await prisma.rawPunchEvent.update({ where: { id: ev.id }, data: { status: 'MAPPED', employeeId, reason: null } });
    remapped += 1;
    let tz = tzCache.get(employeeId); if (!tz) { tz = await ingest.resolveEmployeeTz(prisma, businessId, employeeId); tzCache.set(employeeId, tz); }
    const civilDayKey = civilDateInTz(ev.punchAt, tz);
    toMaterialise.set(`${employeeId}|${civilDayKey}`, { employeeId, civilDayKey, device });
  }
  let materialised = 0;
  for (const { employeeId, civilDayKey, device } of toMaterialise.values()) {
    const out = await ingest.materialiseEmployeeDay(prisma, { businessId, employeeId, device, civilDayKey });
    materialised += out.materialised;
  }
  await writeAudit({ businessId, actorId, action: 'biometric.reprocess', entityType: 'RawPunchEvent', meta: { scanned: rows.length, remapped, materialised, stillParked } });
  return { scanned: rows.length, remapped, materialised, stillParked };
}

async function deviceFor(deviceId, businessId) {
  if (!deviceId) return null;
  return prisma.punchDevice.findFirst({ where: { id: deviceId, businessId, deletedAt: null } });
}

// ── Manual correction (§10) — non-destructive ─────────────────────────────────
// action: 'remap' (set employeeId + re-materialise) | 'flip' (flip IN/OUT on the
// materialised punch) | 'discard' (mark IGNORED + soft-remove the punch).
async function correctEvent({ businessId, actorId, id, action, employeeId: newEmployeeId }) {
  const ev = await prisma.rawPunchEvent.findFirst({ where: { id, businessId } });
  if (!ev) throw notFound('Event not found');
  const device = await deviceFor(ev.deviceId, businessId);
  const before = { status: ev.status, employeeId: ev.employeeId, resolvedType: ev.resolvedType };

  if (action === 'discard') {
    if (ev.attendancePunchId) {
      const punch = await prisma.attendancePunch.findFirst({ where: { id: ev.attendancePunchId, businessId }, select: { id: true, employeeId: true, punchAt: true } });
      if (punch) {
        await prisma.attendancePunch.deleteMany({ where: { id: punch.id, businessId } });
        const tz = await ingest.resolveEmployeeTz(prisma, businessId, punch.employeeId);
        const dayKey = civilDateInTz(punch.punchAt, tz);
        await recompute(businessId, punch.employeeId, ingest._internals.civilKeyToDate(dayKey), ingest._internals.civilKeyToDate(dayKey));
      }
    }
    await prisma.rawPunchEvent.update({ where: { id }, data: { status: 'IGNORED', attendancePunchId: null, reason: 'operator-discarded' } });
    await writeAudit({ businessId, actorId, action: 'biometric.correct.discard', entityType: 'RawPunchEvent', entityId: id, meta: { before } });
    return { ok: true, action: 'discard' };
  }

  if (action === 'flip') {
    if (!ev.attendancePunchId || !ev.resolvedType) throw badRequest('NOT_MATERIALISED', 'event has no materialised punch to flip');
    const flipped = ev.resolvedType === 'IN' ? 'OUT' : ev.resolvedType === 'OUT' ? 'IN' : ev.resolvedType;
    await prisma.attendancePunch.updateMany({ where: { id: ev.attendancePunchId, businessId }, data: { punchType: flipped } });
    await prisma.rawPunchEvent.update({ where: { id }, data: { resolvedType: flipped } });
    const tz = await ingest.resolveEmployeeTz(prisma, businessId, ev.employeeId);
    const dayKey = civilDateInTz(ev.punchAt, tz);
    await recompute(businessId, ev.employeeId, ingest._internals.civilKeyToDate(dayKey), ingest._internals.civilKeyToDate(dayKey));
    await writeAudit({ businessId, actorId, action: 'biometric.correct.flip', entityType: 'RawPunchEvent', entityId: id, meta: { before, after: { resolvedType: flipped } } });
    return { ok: true, action: 'flip', resolvedType: flipped };
  }

  if (action === 'remap') {
    if (!newEmployeeId) throw badRequest('REQUIRED', 'employeeId is required to remap');
    const emp = await prisma.employee.findFirst({ where: { id: newEmployeeId, businessId, deletedAt: null }, select: { id: true } });
    if (!emp) throw badRequest('UNKNOWN_EMPLOYEE', 'employee not found');
    if (!device) throw badRequest('NO_DEVICE', 'event has no device to re-materialise against');
    await prisma.rawPunchEvent.update({ where: { id }, data: { employeeId: emp.id, status: 'MAPPED', reason: null } });
    const tz = await ingest.resolveEmployeeTz(prisma, businessId, emp.id);
    const dayKey = civilDateInTz(ev.punchAt, tz);
    const out = await ingest.materialiseEmployeeDay(prisma, { businessId, employeeId: emp.id, device, civilDayKey: dayKey });
    await writeAudit({ businessId, actorId, action: 'biometric.correct.remap', entityType: 'RawPunchEvent', entityId: id, meta: { before, after: { employeeId: emp.id } } });
    return { ok: true, action: 'remap', materialised: out.materialised };
  }

  throw badRequest('BAD_ACTION', `action must be remap | flip | discard`);
}

// Metadata for the device form (vendors + adapters + their default keys).
function meta() {
  return { vendors: VENDORS, directionModes: DIRECTION_MODES, pollKinds: POLL_KINDS, adapters: adapterKeys, vendorDefaultAdapter: VENDOR_DEFAULT_ADAPTER };
}

module.exports = {
  listDevices, getDevice, createDevice, updateDevice, deleteDevice, rotateSecret,
  listEvents, unmappedCodes, listMaps, createMap, deleteMap, bulkMaps,
  reprocess, correctEvent, meta, deviceHealth, safeDevice, BioError,
};
