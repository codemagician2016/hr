'use strict';

/**
 * committer.js — Feature 28 F18 import-door committer (`commitBiometricPunch`).
 *
 * The §3 "one new wrinkle vs F18": the existing commitAttendance writes the daily
 * Attendance ROLLUP directly (correct for historical migration). Biometric is the
 * opposite — it writes PUNCHES and lets recompute build the rollup. So we add this
 * NEW committer (we do NOT reuse commitAttendance). Both committers live behind the
 * SAME ImportJob machinery (upload → map → validate → dry-run-rollback-tx → commit →
 * report); imports.service dispatches kind=BIOMETRIC here.
 *
 * Per-row (inside the row's tx, dry-run or real): LAND a RawPunchEvent (dedup gate)
 * stamped with the job + device. We do NOT materialise/recompute per row — the F18
 * commit runs each row in its own tx, so recompute is deferred to a single
 * post-commit pass over the distinct (employeeId, civilDay) the batch touched
 * (recomputeBatch below). In DRY-RUN the whole simulation rolls back, so nothing
 * persists — the preview shows would-create / unmapped / locked counts truthfully.
 *
 * The committer NEVER edits attendance/service.js or derive.js — it only CALLS
 * recompute + creates punches, exactly like the ESS punch path.
 */

const prisma = require('../../../core/lib/prisma');
const { recompute } = require('../service');
const { resolveTimezone, civilDateInTz, zonedWallTimeToUtc } = require('../tz');
const { normalizeLocalTime } = require('./adapters/normalizeTime');
const {
  computeDedupKey, resolveEmployeeId, resolveDeviceTz, resolveEmployeeTz,
  isDayLocked, materialiseEmployeeDay, upsertRaw, _internals,
} = require('./ingest.service');

const { civilKeyToDate, utcDay } = _internals;

/**
 * Resolve the device the job targets (options.deviceId is required for a BIOMETRIC
 * import — it pins vendor/adapter/TZ/location). Cached on the tx-less prisma per call.
 */
async function resolveJobDevice(tx, businessId, job) {
  const deviceId = job.optionsJson && job.optionsJson.deviceId;
  if (!deviceId) throw new Error('a BIOMETRIC import requires options.deviceId (pick a device)');
  const device = await tx.punchDevice.findFirst({ where: { id: deviceId, businessId, deletedAt: null } });
  if (!device) throw new Error(`device "${deviceId}" not found in this tenant`);
  return device;
}

/**
 * commitBiometricPunch(tx, job, normalized, opts) — land ONE row's RawPunchEvent.
 * `normalized` is the validator output: { deviceCode, localTimeRaw, rawDirection? }.
 * Returns an F18 result obj { action, targetType, targetId, ... } + the touched
 * (employeeId, civilDay) so the post-commit pass can recompute.
 */
async function commitBiometricPunch(tx, job, n, opts) {
  const { businessId } = job;
  const device = await resolveJobDevice(tx, businessId, job);
  const business = await tx.business.findFirst({ where: { id: businessId }, select: { timezone: true } });
  const tz = await resolveDeviceTz(tx, device, business);

  const lt = normalizeLocalTime(n.localTimeRaw) || n.localTimeRaw || '';
  const dm = /^(\d{4})-(\d{2})-(\d{2})/.exec(lt);
  const tmIdx = lt.indexOf(' ');
  const hhmm = tmIdx >= 0 ? lt.slice(tmIdx + 1).slice(0, 5) : '';
  let punchAt = dm && hhmm ? zonedWallTimeToUtc(lt.slice(0, 10), hhmm, tz) : null;
  if (punchAt && device.clockOffsetSec) punchAt = new Date(punchAt.getTime() + device.clockOffsetSec * 1000);
  if (!punchAt || Number.isNaN(punchAt.getTime())) throw new Error(`unparseable timestamp "${n.localTimeRaw}"`);

  const dedupKey = computeDedupKey({ businessId, deviceId: device.id, deviceCode: n.deviceCode, punchAt, rawDirection: n.rawDirection });
  const employeeId = await resolveEmployeeId(tx, businessId, device, n.deviceCode);

  // Locked-day pre-check (parked LOCKED, never written) — only when we can resolve
  // the employee (an unmapped row is parked UNMAPPED regardless).
  let status = employeeId ? 'MAPPED' : 'UNMAPPED';
  let reason = employeeId ? null : `no mapping for device code "${n.deviceCode}"`;
  let civilDay = null;
  if (employeeId) {
    const empTz = await resolveEmployeeTz(tx, businessId, employeeId);
    civilDay = civilDateInTz(punchAt, empTz);
    if (await isDayLocked(tx, businessId, employeeId, civilKeyToDate(civilDay))) {
      status = 'LOCKED';
      reason = 'target day is frozen (period closed)';
    }
  }

  const res = await upsertRaw(tx, {
    businessId, deviceId: device.id, importJobId: job.id,
    deviceCode: n.deviceCode, localTimeRaw: lt, punchAt,
    rawDirection: n.rawDirection || null, rawPayloadJson: n.rawPayload || { deviceCode: n.deviceCode, localTime: lt, direction: n.rawDirection || null },
    status, reason, employeeId: employeeId || null, dedupKey,
  });

  const action = !res.isNew ? 'skipped'
    : status === 'UNMAPPED' ? 'unmapped'
      : status === 'LOCKED' ? 'locked'
        : 'created';

  return {
    action: action === 'created' ? 'created' : action === 'skipped' ? 'skipped' : 'created',
    // F18 wants created|updated|skipped for its counters; map our parked rows to
    // 'created' (they DID create a raw event) but carry the real disposition for the
    // report + the preview totals.
    disposition: action,
    targetType: 'RawPunchEvent',
    targetId: res.row.id,
    deviceCode: n.deviceCode,
    employeeId: employeeId || null,
    civilDay,
    isNew: res.isNew,
    rawStatus: status,
  };
}

/**
 * recomputeBatchForJob — POST-COMMIT pass. Find every MAPPED (not yet materialised)
 * RawPunchEvent this job landed, group by (employeeId, civil-day in the EMPLOYEE tz),
 * and materialise each day ONCE (create AttendancePunch rows + recompute). This is
 * the §6.1 batching: O(employees×days), not O(punches). Idempotent: re-running only
 * re-derives the same rows. Skips jobs/rows with no employee (UNMAPPED/LOCKED parked).
 */
async function recomputeBatchForJob({ businessId, jobId }) {
  const job = await prisma.importJob.findFirst({ where: { id: jobId, businessId }, select: { optionsJson: true } });
  const deviceId = job && job.optionsJson && job.optionsJson.deviceId;
  if (!deviceId) return { materialised: 0, days: 0, locked: 0 };
  const device = await prisma.punchDevice.findFirst({ where: { id: deviceId, businessId } });
  if (!device) return { materialised: 0, days: 0, locked: 0 };

  const rows = await prisma.rawPunchEvent.findMany({
    where: { businessId, importJobId: jobId, status: 'MAPPED', employeeId: { not: null } },
    select: { id: true, employeeId: true, punchAt: true },
  });
  // Group by (employeeId, civil-day in employee tz). An early-morning event also marks
  // the PRIOR civil day so a night session whose IN landed yesterday re-pairs (the
  // night-aware window in materialiseEmployeeDay owns/skips the pre-dawn run correctly).
  const tzCache = new Map();
  const byEmpDay = new Map();
  for (const r of rows) {
    let tz = tzCache.get(r.employeeId);
    if (!tz) { tz = await resolveEmployeeTz(prisma, businessId, r.employeeId); tzCache.set(r.employeeId, tz); }
    const key = civilDateInTz(r.punchAt, tz);
    const add = (k) => { const gk = `${r.employeeId}|${k}`; if (!byEmpDay.has(gk)) byEmpDay.set(gk, { employeeId: r.employeeId, civilDayKey: k }); };
    add(key);
    // An early-morning event may be the OUT of the prior day's night session; also
    // re-resolve day D-1 (materialiseEmployeeDay's night-aware window owns the pair).
    const localHour = Number(_internals.hhmmInTz(r.punchAt, tz).slice(0, 2));
    if (localHour < 9) add(civilDateInTz(new Date(new Date(r.punchAt).getTime() - 86400000), tz));
  }

  let materialised = 0; let locked = 0;
  for (const { employeeId, civilDayKey } of byEmpDay.values()) {
    const out = await materialiseEmployeeDay(prisma, { businessId, employeeId, device, civilDayKey });
    materialised += out.materialised;
    if (out.locked) locked += 1;
  }
  return { materialised, days: byEmpDay.size, locked };
}

module.exports = { commitBiometricPunch, recomputeBatchForJob, resolveJobDevice, _utils: { utcDay } };
