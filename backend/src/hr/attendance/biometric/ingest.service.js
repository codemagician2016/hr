'use strict';

/**
 * ingest.service.js — Feature 28 INGEST CORE. The ONE pipeline behind all three
 * doors (CSV import, push webhook, SFTP/folder poll). It lands raw vendor punch
 * logs as canonical AttendancePunch rows EXACTLY the way the ESS web punch does
 * (meAttendance.controller#createPunch: source=BIOMETRIC, isManual=false) and then
 * calls the EXISTING recompute (attendance/service.js). It NEVER re-implements
 * IN/OUT pairing / night-shift / geofence / holiday-leave overlap / OT / LOP —
 * those stay in the UNTOUCHED derive.js / service.js.
 *
 * Per source, identically (§5):
 *   1. resolve device;
 *   2. resolve tz (device → location → entity → business, via resolveTimezone);
 *   3. punchAt = zonedWallTimeToUtc(date, time, tz) — REUSING tz.js (never new Date);
 *   4. dedupKey = sha256(businessId|deviceId|deviceCode|punchAt|rawDirection);
 *   5. UPSERT RawPunchEvent on (businessId, dedupKey) — the dedup gate;
 *   6. resolve employeeId via DeviceEmployeeMap (device → tenant-wide → Employee.code);
 *   7. resolve direction (direction.js: DERIVE / TRUST_DEVICE / ALL_IN + de-bounce);
 *   8. materialise — create AttendancePunch + recompute (the verbatim ESS reuse).
 *
 * 3-layer idempotency: (1) event dedupKey @@unique; (2) F18 fileHash (the import
 * door); (3) recompute's daily (businessId, employeeId, date) upsert + isLocked skip.
 *
 * Batching: a CSV/SFTP batch collects the distinct (employeeId, localDay) pairs and
 * recomputes once per pair at the END (recompute walks a range; a 6-punch day is
 * derived once). The push door materialises per-event but coalesces the day's
 * recompute. The engine is called, never forked.
 */

const crypto = require('crypto');
const prisma = require('../../../core/lib/prisma');
const { recompute } = require('../service');
const { resolveTimezone, civilDateInTz, zonedWallTimeToUtc, tzOffsetMs } = require('../tz');
const { getAdapter } = require('./adapters');
const { resolveDayDirections } = require('./direction');

// ── small civil-day helpers (mirror attendanceSweep / meAttendance) ──
function civilKeyToDate(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key));
  if (!m) { const t = new Date(key); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())); }
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}
function utcDay(value) {
  const t = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}
// 'HH:MM' local wall-clock of a UTC instant in `tz` (for the night-shift pre-dawn test).
function _hhmmInTz(instant, tz) {
  const ms = (instant instanceof Date ? instant.getTime() : new Date(instant).getTime());
  const local = new Date(ms + tzOffsetMs(ms, tz));
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(local.getUTCHours())}:${p2(local.getUTCMinutes())}`;
}

/**
 * sha256(businessId|deviceId|deviceCode|punchAt.toISOString()|rawDirection|localTimeRaw).
 *
 * `localTimeRaw` (the device's full literal timestamp WITH seconds) is part of the
 * key so two genuine same-minute punches can NEVER collide on the @@unique spine.
 * punchAt now carries seconds too (zonedWallTimeToUtc accepts :SS), but the raw
 * string is the belt-and-braces guarantee: even a minute-rounded punchAt cannot
 * fold two distinct device lines into one row (→ silent MISSING_PUNCH / inverted
 * IN-OUT). Older callers that omit localTimeRaw get the prior key shape unchanged.
 */
function computeDedupKey({ businessId, deviceId, deviceCode, punchAt, rawDirection, localTimeRaw }) {
  const iso = punchAt instanceof Date ? punchAt.toISOString() : new Date(punchAt).toISOString();
  const parts = [businessId, deviceId || '', deviceCode || '', iso, rawDirection == null ? '' : String(rawDirection)];
  if (localTimeRaw != null && localTimeRaw !== '') parts.push(String(localTimeRaw));
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ── device timezone resolution (device override → location → entity → business) ──
async function resolveDeviceTz(db, device, business) {
  if (device.timezone) return device.timezone;
  let location = null; let entity = null;
  if (device.locationId) {
    location = await db.location.findFirst({ where: { id: device.locationId, businessId: device.businessId }, select: { timezone: true, countryCode: true } });
  }
  if (device.entityId) {
    entity = await db.entity.findFirst({ where: { id: device.entityId, businessId: device.businessId }, select: { timezone: true, countryCode: true } });
  }
  return resolveTimezone({}, { location, entity, business });
}

// ── employee timezone resolution (mirrors meAttendance.resolveEmployeeTz) ──
async function resolveEmployeeTz(db, businessId, employeeId) {
  const employment = await db.employmentRecord.findFirst({
    where: { businessId, employeeId, isCurrent: true },
    select: {
      entity: { select: { timezone: true, countryCode: true } },
      location: { select: { timezone: true, countryCode: true } },
    },
  });
  const emp = await db.employee.findFirst({ where: { id: employeeId, businessId }, select: { countryCode: true } });
  const business = await db.business.findFirst({ where: { id: businessId }, select: { timezone: true } });
  return resolveTimezone(
    { countryCode: emp ? emp.countryCode : null },
    { location: employment ? employment.location : null, entity: employment ? employment.entity : null, business },
  );
}

async function isDayLocked(db, businessId, employeeId, day) {
  const row = await db.attendance.findFirst({ where: { businessId, employeeId, date: utcDay(day), isLocked: true }, select: { id: true } });
  return !!row;
}

/**
 * resolveEmployeeId — DeviceEmployeeMap (device row → tenant-wide row) → Employee.code
 * fallback (per device.fallbackToEmployeeCode). Returns { employeeId } or null.
 */
async function resolveEmployeeId(db, businessId, device, deviceCode) {
  if (!deviceCode) return null;
  // 1. device-specific map row.
  let map = await db.deviceEmployeeMap.findFirst({ where: { businessId, deviceId: device.id, deviceCode } });
  // 2. tenant-wide map row (deviceId null).
  if (!map) map = await db.deviceEmployeeMap.findFirst({ where: { businessId, deviceId: null, deviceCode } });
  if (map) {
    const emp = await db.employee.findFirst({ where: { id: map.employeeId, businessId, deletedAt: null }, select: { id: true } });
    if (emp) return emp.id;
  }
  // 3. fallback to Employee.code.
  if (device.fallbackToEmployeeCode) {
    const emp = await db.employee.findFirst({ where: { businessId, code: deviceCode, deletedAt: null }, select: { id: true } });
    if (emp) return emp.id;
  }
  return null;
}

/**
 * landRawEvents — for a batch of NormalisedRawEvent (adapter output), resolve tz +
 * punchAt + dedupKey, UPSERT RawPunchEvent (dedup), and resolve+stash employeeId.
 * Returns { events:[{row, isNew, employeeId}], counts } where row is the persisted
 * RawPunchEvent. Pure landing — NO materialisation (caller does that after grouping).
 *
 * importJobId is stamped when ingested through the F18 file/poll door.
 */
async function landRawEvents(db, { businessId, device, business, normalised, importJobId = null }) {
  const tz = await resolveDeviceTz(db, device, business);
  const clockOffsetMs = (device.clockOffsetSec || 0) * 1000;
  const landed = [];
  const counts = { received: 0, duplicate: 0, error: 0, unmapped: 0 };

  for (const n of normalised || []) {
    counts.received += 1;
    // Resolve the local wall-clock → true UTC instant in the device TZ (REUSE tz.js).
    // Keep FULL precision (HH:MM:SS, slice 0,8) so two genuine same-minute punches
    // resolve to two distinct instants — never collapsed into one row.
    const lt = n.localTimeRaw || '';
    const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(lt);
    const tmIdx = lt.indexOf(' ');
    const hhmmss = tmIdx >= 0 ? lt.slice(tmIdx + 1).slice(0, 8) : '';
    let punchAt = dm && hhmmss ? zonedWallTimeToUtc(lt.slice(0, 10), hhmmss, tz) : null;
    if (punchAt && clockOffsetMs) punchAt = new Date(punchAt.getTime() + clockOffsetMs);

    if (!punchAt || Number.isNaN(punchAt.getTime()) || !n.deviceCode) {
      // Unparseable timestamp or empty code → park as ERROR (row isolation, §12 #18).
      // We still record the raw event for the muster-roll trail, with a synthetic
      // dedupKey so the @@unique never collides two distinct bad rows.
      counts.error += 1;
      const dedupKey = computeDedupKey({ businessId, deviceId: device.id, deviceCode: n.deviceCode, punchAt: new Date(0), rawDirection: `${lt}|${n.rawDirection || ''}|err` });
      const row = await upsertRaw(db, {
        businessId, deviceId: device.id, importJobId, deviceCode: n.deviceCode || '', localTimeRaw: lt,
        punchAt: new Date(0), rawDirection: n.rawDirection || null, rawPayloadJson: n.rawPayload || {},
        status: 'ERROR', reason: !n.deviceCode ? 'missing device code' : `unparseable timestamp "${lt}"`, dedupKey,
      });
      landed.push({ row: row.row, isNew: row.isNew, employeeId: null, materialisable: false });
      continue;
    }

    const dedupKey = computeDedupKey({ businessId, deviceId: device.id, deviceCode: n.deviceCode, punchAt, rawDirection: n.rawDirection, localTimeRaw: lt });
    const employeeId = await resolveEmployeeId(db, businessId, device, n.deviceCode);
    const status = employeeId ? 'MAPPED' : 'UNMAPPED';
    if (!employeeId) counts.unmapped += 1;

    const res = await upsertRaw(db, {
      businessId, deviceId: device.id, importJobId, deviceCode: n.deviceCode, localTimeRaw: lt,
      punchAt, rawDirection: n.rawDirection || null, rawPayloadJson: n.rawPayload || {},
      status, reason: employeeId ? null : `no mapping for device code "${n.deviceCode}"`,
      employeeId: employeeId || null, dedupKey,
    });
    if (!res.isNew) counts.duplicate += 1;
    landed.push({ row: res.row, isNew: res.isNew, employeeId, materialisable: !!employeeId && res.isNew });
  }

  return { tz, landed, counts };
}

/**
 * upsertRaw — the DEDUP GATE. Insert a RawPunchEvent; on the (businessId, dedupKey)
 * unique collision return the EXISTING row (isNew=false) — a webhook retry / SFTP
 * re-poll / re-uploaded CSV inserts nothing new. We do NOT mutate an existing row
 * (immutable spine) beyond leaving it as-is.
 */
async function upsertRaw(db, data) {
  const existing = await db.rawPunchEvent.findFirst({ where: { businessId: data.businessId, dedupKey: data.dedupKey } });
  if (existing) return { row: existing, isNew: false };
  try {
    const row = await db.rawPunchEvent.create({ data });
    return { row, isNew: true };
  } catch (e) {
    if (e.code === 'P2002') {
      const again = await db.rawPunchEvent.findFirst({ where: { businessId: data.businessId, dedupKey: data.dedupKey } });
      if (again) return { row: again, isNew: false };
    }
    throw e;
  }
}

/**
 * materialiseEmployeeDay — for ONE (employeeId, civilDay) gather the day's events
 * over a NIGHT-SHIFT-AWARE window (the civil day PLUS the pre-dawn hours of the next
 * day, so a 22:00 IN and its 06:00-next-day OUT resolve as one alternating session —
 * §6.2/§12 #3). Resolve directions, create/refresh the AttendancePunch rows, then
 * recompute the civil days the punches actually touch (recompute walks the range, so
 * the cross-midnight pairing/worked-minutes stays in the UNTOUCHED engine).
 *
 * Re-resolve-the-whole-window is the §6.2 late-punch fix: a punch can arrive before
 * its pair, so each new event re-labels the already-created punches.
 *
 * NIGHT_LOOKAHEAD_H — how far into the next civil day an open IN can pair its OUT.
 * 9h covers any single overnight shift's OUT (22:00→06:00/07:00 lands ≤09:00 next
 * day) while staying clear of a genuine next-MORNING day-shift IN (~09:00+). The
 * pre-dawn extension is only "owned" by the prior day when the prior day actually had
 * a late-evening event (priorLateExists), so a normal 09:00 day-shift IN is never
 * pulled into the previous day.
 */
const NIGHT_LOOKAHEAD_H = 9;

async function materialiseEmployeeDay(db, { businessId, employeeId, device, civilDayKey, tenantEnforceUnused }) {
  // The civil-day window in the EMPLOYEE tz (a device may be at a different site than
  // the employee's home location; the punch's day is the employee's civil day, exactly
  // as recompute buckets it).
  const empTz = await resolveEmployeeTz(db, businessId, employeeId);
  const dayDate = civilKeyToDate(civilDayKey);

  // Period-lock guard — mirror meAttendance#isDayLocked. A frozen day is parked
  // LOCKED, never written (recompute would skip it anyway, but we want a clean status
  // + operator-visible reason rather than a silent no-op).
  if (await isDayLocked(db, businessId, employeeId, dayDate)) {
    await db.rawPunchEvent.updateMany({
      where: { businessId, employeeId, status: { in: ['MAPPED', 'MATERIALISED'] }, punchAt: dayWindow(civilDayKey, empTz) },
      data: { status: 'LOCKED', reason: 'target day is frozen (period closed)' },
    });
    return { locked: true, materialised: 0, duplicate: 0 };
  }

  // Night-aware window: [civil-day 00:00, next-day 00:00 + NIGHT_LOOKAHEAD_H).
  const dayWin = dayWindow(civilDayKey, empTz);
  const win = { gte: dayWin.gte, lt: new Date(dayWin.lt.getTime() + NIGHT_LOOKAHEAD_H * 3600 * 1000) };
  // But an early-morning OUT that belongs to the PRIOR day's night session must NOT be
  // re-owned here (the prior day already paired it). Skip events that fall in the
  // pre-dawn hours of THIS civil day when an event also exists late on the prior day.
  const dayEventsAll = await db.rawPunchEvent.findMany({
    where: { businessId, employeeId, punchAt: win, status: { in: ['MAPPED', 'MATERIALISED', 'DUPLICATE'] } },
    orderBy: { punchAt: 'asc' },
  });
  // Drop a leading pre-dawn run that belongs to the prior civil day's session: an event
  // before this day's "morning boundary" (NIGHT_LOOKAHEAD_H after 00:00) is only ours
  // if NO event sits late on the prior day (i.e. it is this day's own first punch).
  const morningBoundary = new Date(dayWin.gte.getTime() + NIGHT_LOOKAHEAD_H * 3600 * 1000);
  const priorLateExists = (await db.rawPunchEvent.count({
    where: { businessId, employeeId, status: { in: ['MAPPED', 'MATERIALISED', 'DUPLICATE'] }, punchAt: { gte: new Date(dayWin.gte.getTime() - 6 * 3600 * 1000), lt: dayWin.gte } },
  })) > 0;
  const dayEvents = dayEventsAll.filter((e) => {
    const t = new Date(e.punchAt).getTime();
    if (t < morningBoundary.getTime() && priorLateExists) return false; // owned by prior night session
    return true;
  });
  if (!dayEvents.length) return { locked: false, materialised: 0, duplicate: 0 };

  // DEVICE-SCOPED resolution: a multi-device site can have one employee punching on
  // two gates in a day (e.g. a DERIVE main-gate + a TRUST_DEVICE plant-gate). Resolve
  // and stamp each event under ITS OWN device — never let the single passed-in device
  // re-label / re-provenance another device's punches. The passed-in `device` is only
  // the fallback (the event's own deviceId is authoritative; matches the dedup spine).
  const deviceCache = new Map();
  if (device && device.id) deviceCache.set(device.id, device);
  async function deviceForEvent(ev) {
    const id = ev.deviceId || (device && device.id) || null;
    if (!id) return device || null;
    if (deviceCache.has(id)) return deviceCache.get(id);
    const d = await db.punchDevice.findFirst({ where: { id, businessId } }) || device || null;
    deviceCache.set(id, d);
    return d;
  }
  // Pre-load each event's device so the resolver can apply per-event mode/dedup window.
  const evDevices = new Map();
  for (const ev of dayEvents) evDevices.set(ev.id, await deviceForEvent(ev));

  const resolution = resolveDayDirections(
    dayEvents.map((e) => {
      const d = evDevices.get(e.id) || device;
      return {
        id: e.id, punchAtMs: new Date(e.punchAt).getTime(), rawDirection: e.rawDirection,
        mode: d ? d.directionMode : device && device.directionMode,
        dedupWindowSec: d ? d.dedupWindowSec : device && device.dedupWindowSec,
      };
    }),
    { mode: device.directionMode, dedupWindowSec: device.dedupWindowSec },
  );
  const byId = new Map(resolution.map((r) => [r.id, r]));

  let materialised = 0; let duplicate = 0;
  for (const ev of dayEvents) {
    const r = byId.get(ev.id);
    if (!r) continue;
    const evDevice = evDevices.get(ev.id) || device; // stamp under the event's OWN device
    if (r.duplicate) {
      // De-bounced: mark DUPLICATE; remove any AttendancePunch it had created.
      if (ev.attendancePunchId) {
        await db.attendancePunch.deleteMany({ where: { id: ev.attendancePunchId, businessId } });
      }
      await db.rawPunchEvent.update({ where: { id: ev.id }, data: { status: 'DUPLICATE', resolvedType: null, attendancePunchId: null, reason: 'de-bounced (double-tap within dedup window)' } });
      duplicate += 1;
      continue;
    }
    // Create or update the AttendancePunch with the resolved label. Provenance/location
    // come from the EVENT'S device, so a cross-device re-materialise never overwrites
    // one gate's location/punchDeviceId with another's.
    if (ev.attendancePunchId) {
      await db.attendancePunch.updateMany({
        where: { id: ev.attendancePunchId, businessId },
        data: { punchType: r.punchType, punchAt: ev.punchAt, locationId: (evDevice && evDevice.locationId) || null, punchDeviceId: evDevice ? evDevice.id : null },
      });
      await db.rawPunchEvent.update({ where: { id: ev.id }, data: { status: 'MATERIALISED', resolvedType: r.punchType } });
    } else {
      const punch = await db.attendancePunch.create({
        data: {
          businessId,
          employeeId,
          punchType: r.punchType, // IN/OUT/BREAK_* (§6.2)
          source: 'BIOMETRIC', // never trust a client source; this IS a device
          punchAt: ev.punchAt, // true UTC instant
          locationId: (evDevice && evDevice.locationId) || null, // seeds geofence + holiday scope in recompute
          deviceId: (evDevice && evDevice.serialNumber) || null, // existing free-text column (back-compat)
          punchDeviceId: evDevice ? evDevice.id : null, // new provenance FK-by-id
          rawPunchEventId: ev.id,
          isManual: false, // counts in recompute immediately
          // geoLat/geoLng left null — a gate device has no per-punch GPS; the geofence
          // check no-ops gracefully (evaluatePunchGeofence → evaluated:false).
        },
      });
      await db.rawPunchEvent.update({ where: { id: ev.id }, data: { status: 'MATERIALISED', resolvedType: r.punchType, attendancePunchId: punch.id } });
    }
    materialised += 1;
  }

  // SAME call the web/mobile punch makes — derivation is UNTOUCHED. recompute the
  // civil days this session's punches touch: the day itself + the next day (a night
  // shift's OUT lands on day+1, so the engine must re-derive both to pair it). recompute
  // walks the range and is idempotent; the cross-midnight pairing stays in derive.js.
  const nextDay = new Date(dayDate.getTime() + 86400000);
  await recompute(businessId, employeeId, dayDate, nextDay, db === prisma ? undefined : db);
  return { locked: false, materialised, duplicate };
}

// Half-open UTC instant window for a civil day key in `tz`, as a Prisma filter.
function dayWindow(civilDayKey, tz) {
  const gte = zonedWallTimeToUtc(civilDayKey, '00:00', tz);
  const nextKey = civilDateInTz(new Date(civilKeyToDate(civilDayKey).getTime() + 86400000), tz);
  const lt = zonedWallTimeToUtc(nextKey, '00:00', tz);
  return { gte, lt };
}

/**
 * ingestBatch — the high-level entry used by the push webhook + the poll cron. Given
 * a resolved active device + a normalised event list, land + materialise + recompute,
 * advancing device.lastSeenAt. Returns { received, materialised, duplicate, unmapped,
 * locked, error }.
 *
 * The CSV file door does NOT use this (it goes through the F18 committer per row); it
 * shares landRawEvents + materialiseEmployeeDay via the committer module.
 */
async function ingestBatch({ businessId, device, normalised, importJobId = null }) {
  const business = await prisma.business.findFirst({ where: { id: businessId }, select: { timezone: true } });
  const { tz, landed, counts } = await landRawEvents(prisma, { businessId, device, business, normalised, importJobId });

  // Group the materialisable events by (employeeId, civil-day in EMPLOYEE tz). ONLY a
  // NEW event (isNew) triggers (re)materialisation of its day — a re-ingested duplicate
  // (dedupKey hit) is a pure no-op, so a retry/re-poll/re-upload never re-derives. A
  // NEW event re-resolves the WHOLE day (materialiseEmployeeDay re-labels existing
  // punches), so a late-arriving pair still re-pairs correctly. A night IN at 22:00
  // also marks the NEXT civil day so its early-morning OUT-day is re-derived.
  const dayKeysByEmp = new Map(); // employeeId → Set(civilDayKey)
  for (const l of landed) {
    if (!l.employeeId || !l.isNew) continue;
    const ev = l.row;
    const empTz = await cachedEmpTz(businessId, l.employeeId);
    const key = civilDateInTz(ev.punchAt, empTz);
    if (!dayKeysByEmp.has(l.employeeId)) dayKeysByEmp.set(l.employeeId, new Set());
    dayKeysByEmp.get(l.employeeId).add(key);
    // An EARLY-MORNING event (pre-NIGHT_LOOKAHEAD_H, e.g. a 06:00 OUT) may be the OUT of
    // the PRIOR day's night session, so re-resolve day D-1 (its open IN re-pairs). Only
    // pre-dawn events mark the prior day — a normal daytime punch never does.
    const hourLocal = Number(/(\d{2}):/.exec(_hhmmInTz(ev.punchAt, empTz))?.[1] || '12');
    if (hourLocal < NIGHT_LOOKAHEAD_H) {
      const prevKey = civilDateInTz(new Date(ev.punchAt.getTime() - 86400000), empTz);
      dayKeysByEmp.get(l.employeeId).add(prevKey);
    }
  }

  let materialised = 0; let duplicate = counts.duplicate; let locked = 0;
  for (const [employeeId, keys] of dayKeysByEmp.entries()) {
    for (const civilDayKey of keys) {
      const r = await materialiseEmployeeDay(prisma, { businessId, employeeId, device, civilDayKey });
      materialised += r.materialised;
      duplicate += r.duplicate;
      if (r.locked) locked += 1;
    }
  }

  // Advance health watermark (best-effort).
  if (counts.received > 0) {
    try { await prisma.punchDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }); } catch (_e) { /* best-effort */ }
  }
  // High-unmapped-rate watchdog (§11) — best-effort, never throws into ingest.
  try {
    const { notifyHighUnmapped } = require('./watchdog.runner');
    await notifyHighUnmapped({ businessId, device, received: counts.received, unmapped: counts.unmapped });
  } catch (_e) { /* best-effort */ }
  _empTzCache.clear();

  return {
    received: counts.received,
    materialised,
    duplicate,
    unmapped: counts.unmapped,
    locked,
    error: counts.error,
    tz,
  };
}

// tiny per-batch employee-tz cache (cleared at the end of each ingestBatch).
const _empTzCache = new Map();
async function cachedEmpTz(businessId, employeeId) {
  const k = `${businessId}|${employeeId}`;
  if (_empTzCache.has(k)) return _empTzCache.get(k);
  const tz = await resolveEmployeeTz(prisma, businessId, employeeId);
  _empTzCache.set(k, tz);
  return tz;
}

// ── device resolution helpers shared by the doors ──
async function findDeviceBySerial(businessId, serialNumber) {
  if (!serialNumber) return null;
  return prisma.punchDevice.findFirst({ where: { businessId, serialNumber, deletedAt: null } });
}

/** Parse a raw pushed body using the device's adapter. */
function parseWithDevice(device, body) {
  const adapter = getAdapter(device.adapterKey);
  if (!adapter) return { error: `no adapter for adapterKey "${device.adapterKey}"`, events: [] };
  try {
    return { events: adapter.parse(body, device) || [] };
  } catch (e) {
    return { error: `adapter parse failed: ${e.message}`, events: [] };
  }
}

module.exports = {
  ingestBatch,
  landRawEvents,
  materialiseEmployeeDay,
  resolveEmployeeId,
  resolveDeviceTz,
  resolveEmployeeTz,
  isDayLocked,
  computeDedupKey,
  upsertRaw,
  findDeviceBySerial,
  parseWithDevice,
  _internals: { civilKeyToDate, utcDay, dayWindow, hhmmInTz: _hhmmInTz },
};
