'use strict';

/*
 * biometric.live.test.js — LIVE (hr_test) end-to-end proof for Feature 28.
 * Plain-node (no jest). Run with the hr_test schema URL:
 *   DATABASE_URL="$BASE?schema=hr_test" node \
 *     backend/src/hr/attendance/biometric/__tests__/biometric.live.test.js
 *
 * Proves the spec acceptance tests against the UNTOUCHED derivation engine:
 *   1. A CSV/file batch of device punches → AttendancePunch rows (source=BIOMETRIC,
 *      isManual=false) + recompute runs → the day derives PRESENT/OT via derive.js.
 *   2. Dedup — the same event ingested twice = ONE RawPunchEvent + ONE punch.
 *   3. Derive-by-time-order pairs IN/OUT when direction is missing (DERIVE mode);
 *      a night shift (22:00 IN → 06:00 OUT next day) pairs across midnight via the
 *      existing engine (we add nothing).
 *   4. The push webhook rejects a bad/missing secret (401) and accepts a good one,
 *      returning the ZK "OK" ACK for an ADMS device.
 *   5. Tenant isolation — a device/map/event in tenant A is invisible to tenant B.
 *   6. Provenance columns (punchDeviceId / rawPunchEventId) are stamped.
 *   7. Reprocess an UNMAPPED row after adding a map; manual flip + discard.
 *
 * Self-contained fixture under the prefix F28T; cleaned up at start + end.
 */

const assert = require('assert');
const prisma = require('../../../../core/lib/prisma');
const { recompute } = require('../../service');
const ingest = require('../ingest.service');
const committer = require('../committer');
const devicesSvc = require('../devices.service');
const webhook = require('../webhook.controller');
const { mintSecret } = require('../deviceSecret');

const PREFIX = 'F28T';
let pass = 0; let fail = 0; const fails = [];
const log = (...a) => console.log(...a);
function check(name, cond) { if (cond) { pass += 1; } else { fail += 1; fails.push(name); log(`  FAIL  ${name}`); } }
function day(s) { return new Date(`${s}T00:00:00Z`); }

// ── express-double for the webhook controller ──
function fakeReq({ params = {}, headers = {}, query = {}, body = '' }) {
  const lc = {}; for (const k of Object.keys(headers)) lc[k.toLowerCase()] = headers[k];
  return { params, query, body, get: (h) => headers[h] || lc[String(h).toLowerCase()] || undefined };
}
function fakeRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    type() { return this; },
    set(k, v) { if (typeof k === 'object') Object.assign(this.headers, k); else this.headers[k] = v; return this; },
    json(p) { this.body = p; this._json = true; return this; },
    send(p) { this.body = p; return this; },
  };
}

async function cleanup(businessId) {
  const devs = await prisma.punchDevice.findMany({ where: { businessId, name: { startsWith: PREFIX } }, select: { id: true } });
  const devIds = devs.map((d) => d.id);
  if (devIds.length) {
    const raws = await prisma.rawPunchEvent.findMany({ where: { businessId, deviceId: { in: devIds } }, select: { attendancePunchId: true } });
    const punchIds = raws.map((r) => r.attendancePunchId).filter(Boolean);
    if (punchIds.length) await prisma.attendancePunch.deleteMany({ where: { id: { in: punchIds } } });
    await prisma.rawPunchEvent.deleteMany({ where: { businessId, deviceId: { in: devIds } } });
    await prisma.deviceEmployeeMap.deleteMany({ where: { businessId, deviceId: { in: devIds } } });
    await prisma.punchDevice.deleteMany({ where: { id: { in: devIds } } });
  }
  await prisma.deviceEmployeeMap.deleteMany({ where: { businessId, deviceCode: { startsWith: PREFIX } } });
  const emps = await prisma.employee.findMany({ where: { businessId, code: { startsWith: PREFIX } }, select: { id: true } });
  const empIds = emps.map((e) => e.id);
  if (empIds.length) {
    await prisma.attendancePunch.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    await prisma.attendance.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    await prisma.shiftAssignment.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    await prisma.employmentRecord.deleteMany({ where: { businessId, employeeId: { in: empIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: empIds } } });
  }
  await prisma.shiftPattern.deleteMany({ where: { businessId, code: { startsWith: PREFIX } } });
}

async function main() {
  log('\n=== Feature 28 biometric ingestion proof (LIVE hr_test) ===\n');

  // Resolve the seeded India tenant + a second tenant for isolation.
  const bizs = await prisma.business.findMany({ select: { id: true, name: true } });
  const demo = bizs.find((b) => /demo/i.test(b.name)) || bizs[0];
  const other = bizs.find((b) => b.id !== demo.id);
  const businessId = demo.id;
  const otherBusinessId = other ? other.id : null;
  const entity = await prisma.entity.findFirst({ where: { businessId, countryCode: 'IN' } });
  const location = await prisma.location.findFirst({ where: { businessId, entityId: entity.id } });
  assert(entity, 'IN entity must exist in hr_test seed');

  await cleanup(businessId);
  if (otherBusinessId) await cleanup(otherBusinessId);

  // ── Fixture: 2 employees, a day-shift + a night-shift, on the IN entity ──
  const mkEmp = (code) => prisma.employee.create({ data: { businessId, code: `${PREFIX}-${code}`, firstName: code, lastName: 'T', status: 'ACTIVE', isActive: true, countryCode: 'IN' } });
  const dayEmp = await mkEmp('DAY');
  const nightEmp = await mkEmp('NIGHT');
  for (const e of [dayEmp, nightEmp]) {
    await prisma.employmentRecord.create({ data: { businessId, employeeId: e.id, entityId: entity.id, locationId: location ? location.id : null, employmentType: 'FULL_TIME', workerCategory: 'STAFF', changeReason: 'HIRE', effectiveFrom: day('2027-01-01'), isCurrent: true } });
  }
  const dayShift = await prisma.shiftPattern.create({ data: { businessId, entityId: entity.id, code: `${PREFIX}-GEN`, name: 'Gen', startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceInMinutes: 10, fullDayMinutes: 480, halfDayThresholdMinutes: 240, weeklyOffDays: '0,6', otEligible: true, dailyOtThresholdMin: 480, isActive: true } });
  const nightShift = await prisma.shiftPattern.create({ data: { businessId, entityId: entity.id, code: `${PREFIX}-NGT`, name: 'Night', startTime: '22:00', endTime: '06:00', breakMinutes: 0, graceInMinutes: 10, fullDayMinutes: 480, halfDayThresholdMinutes: 240, weeklyOffDays: '0,6', isNightShift: true, isActive: true } });
  await prisma.shiftAssignment.create({ data: { businessId, employeeId: dayEmp.id, shiftPatternId: dayShift.id, effectiveFrom: day('2027-06-01'), effectiveTo: day('2027-06-30') } });
  await prisma.shiftAssignment.create({ data: { businessId, employeeId: nightEmp.id, shiftPatternId: nightShift.id, effectiveFrom: day('2027-06-01'), effectiveTo: day('2027-06-30') } });
  await prisma.overtimeRule.deleteMany({ where: { businessId, entityId: entity.id, dailyThresholdMin: 480, weekdayMultiplier: 1.5 } });

  // A device (DERIVE direction; eSSL CSV), with a per-device map for the day emp's
  // enroll-no, and a tenant-wide map for the night emp's enroll-no.
  const device = await devicesSvc.createDevice({ businessId, actorId: 'TEST', body: { name: `${PREFIX}-GATE`, vendor: 'ESSL', entityId: entity.id, locationId: location ? location.id : null, serialNumber: `${PREFIX}-SN-1`, directionMode: 'DERIVE' } });
  await devicesSvc.createMap({ businessId, actorId: 'TEST', body: { deviceCode: '1042', employeeId: dayEmp.id, deviceId: device.id } });
  await devicesSvc.createMap({ businessId, actorId: 'TEST', body: { deviceCode: '5000', employeeId: nightEmp.id } }); // tenant-wide

  // ── 1+3 (day, DERIVE) : a Monday 2027-06-07 in IST, 09:00 IN / 18:30 OUT (no dir) ──
  const dayNormalised = [
    { deviceCode: '1042', localTimeRaw: '2027-06-07 09:00:00', rawDirection: null, rawPayload: {} },
    { deviceCode: '1042', localTimeRaw: '2027-06-07 18:30:00', rawDirection: null, rawPayload: {} },
  ];
  const sum1 = await ingest.ingestBatch({ businessId, device: await prisma.punchDevice.findUnique({ where: { id: device.id } }), normalised: dayNormalised });
  check('day batch materialised 2', sum1.materialised === 2);
  check('day batch 0 unmapped', sum1.unmapped === 0);

  const dayPunches = await prisma.attendancePunch.findMany({ where: { businessId, employeeId: dayEmp.id }, orderBy: { punchAt: 'asc' } });
  check('day punches count=2', dayPunches.length === 2);
  check('day punch source=BIOMETRIC', dayPunches.every((p) => p.source === 'BIOMETRIC'));
  check('day punch isManual=false', dayPunches.every((p) => p.isManual === false));
  check('day derive-by-time IN then OUT', dayPunches[0].punchType === 'IN' && dayPunches[1].punchType === 'OUT');
  check('day provenance punchDeviceId set', dayPunches.every((p) => p.punchDeviceId === device.id));
  check('day provenance rawPunchEventId set', dayPunches.every((p) => !!p.rawPunchEventId));
  // 09:00 IST → 03:30Z (verifies tz.js reuse, NOT new Date()).
  check('day IN punchAt resolved in IST (03:30Z)', dayPunches[0].punchAt.toISOString() === '2027-06-07T03:30:00.000Z');

  // The daily Attendance rollup the UNTOUCHED engine derived.
  const dayAtt = await prisma.attendance.findFirst({ where: { businessId, employeeId: dayEmp.id, date: day('2027-06-07') } });
  check('day Attendance row present', !!dayAtt);
  check('day status PRESENT', dayAtt && dayAtt.status === 'PRESENT');
  // 09:00→18:30 minus 60 break = 510 worked; 510-480 = 30 OT (engine math).
  check('day workedMinutes 510 (engine)', dayAtt && dayAtt.workedMinutes === 510);
  check('day overtimeMinutes 30 (engine)', dayAtt && dayAtt.overtimeMinutes === 30);

  // ── 2 (dedup) : re-ingest the SAME day batch → no new rows ──
  const before = await prisma.rawPunchEvent.count({ where: { businessId, deviceId: device.id } });
  const punchesBefore = await prisma.attendancePunch.count({ where: { businessId, employeeId: dayEmp.id } });
  const sum2 = await ingest.ingestBatch({ businessId, device: await prisma.punchDevice.findUnique({ where: { id: device.id } }), normalised: dayNormalised });
  const after = await prisma.rawPunchEvent.count({ where: { businessId, deviceId: device.id } });
  const punchesAfter = await prisma.attendancePunch.count({ where: { businessId, employeeId: dayEmp.id } });
  check('dedup: no new RawPunchEvent', after === before);
  check('dedup: no new AttendancePunch', punchesAfter === punchesBefore);
  check('dedup: batch reports 2 duplicate', sum2.duplicate === 2 && sum2.materialised === 0);

  // ── 3 (night, cross-midnight) : 22:00 2027-06-08 IN / 06:00 2027-06-09 OUT ──
  const nightNormalised = [
    { deviceCode: '5000', localTimeRaw: '2027-06-08 22:00:00', rawDirection: null, rawPayload: {} },
    { deviceCode: '5000', localTimeRaw: '2027-06-09 06:00:00', rawDirection: null, rawPayload: {} },
  ];
  const sumN = await ingest.ingestBatch({ businessId, device: await prisma.punchDevice.findUnique({ where: { id: device.id } }), normalised: nightNormalised });
  check('night batch materialised 2 (tenant-wide map)', sumN.materialised === 2 && sumN.unmapped === 0);
  const nightAtt = await prisma.attendance.findFirst({ where: { businessId, employeeId: nightEmp.id, date: day('2027-06-08') } });
  check('night Attendance present on start day', !!nightAtt);
  check('night status PRESENT (cross-midnight paired by engine)', nightAtt && nightAtt.status === 'PRESENT');
  check('night workedMinutes 480 (engine paired across midnight)', nightAtt && nightAtt.workedMinutes === 480);

  // ── 4 (webhook auth) : a ZK ADMS device, bad secret 401, good secret OK ──
  const zk = await devicesSvc.createDevice({ businessId, actorId: 'TEST', body: { name: `${PREFIX}-ZK`, vendor: 'ZKTECO', entityId: entity.id, locationId: location ? location.id : null, serialNumber: `${PREFIX}-SN-ZK`, directionMode: 'DERIVE' } });
  await devicesSvc.createMap({ businessId, actorId: 'TEST', body: { deviceCode: '1042', employeeId: dayEmp.id, deviceId: zk.id } });
  const { secret } = await devicesSvc.rotateSecret({ businessId, actorId: 'TEST', id: zk.id });

  // bad secret → 401
  {
    const res = fakeRes();
    await webhook.ingestPunch(fakeReq({ params: { deviceSerial: `${PREFIX}-SN-ZK` }, headers: { 'X-Device-Secret': 'wrong' }, body: '1042\t2027-06-10 09:00:00\t0\n' }), res);
    check('webhook bad secret → 401', res.statusCode === 401);
  }
  // missing secret → 401
  {
    const res = fakeRes();
    await webhook.ingestPunch(fakeReq({ params: { deviceSerial: `${PREFIX}-SN-ZK` }, headers: {}, body: '1042\t2027-06-10 09:00:00\t0\n' }), res);
    check('webhook missing secret → 401', res.statusCode === 401);
  }
  // good secret → OK ack (ZK plain text) + punch lands
  {
    const res = fakeRes();
    const attlog = '1042\t2027-06-10 09:00:00\t0\n1042\t2027-06-10 18:30:00\t0\n';
    await webhook.ingestPunch(fakeReq({ params: { deviceSerial: `${PREFIX}-SN-ZK` }, headers: { 'X-Device-Secret': secret }, body: attlog }), res);
    check('webhook good secret → 200', res.statusCode === 200);
    check('webhook ZK ACK is text "OK:"', typeof res.body === 'string' && res.body.startsWith('OK'));
    const zkAtt = await prisma.attendance.findFirst({ where: { businessId, employeeId: dayEmp.id, date: day('2027-06-10') } });
    check('webhook punch derived a PRESENT day', zkAtt && zkAtt.status === 'PRESENT');
    // webhook retry is idempotent (dedupKey)
    const res2 = fakeRes();
    const cntBefore = await prisma.attendancePunch.count({ where: { businessId, employeeId: dayEmp.id, punchAt: { gte: day('2027-06-10'), lt: day('2027-06-11') } } });
    await webhook.ingestPunch(fakeReq({ params: { deviceSerial: `${PREFIX}-SN-ZK` }, headers: { 'X-Device-Secret': secret }, body: attlog }), res2);
    const cntAfter = await prisma.attendancePunch.count({ where: { businessId, employeeId: dayEmp.id, punchAt: { gte: day('2027-06-10'), lt: day('2027-06-11') } } });
    check('webhook retry idempotent (no new punch)', cntAfter === cntBefore);
  }

  // ── 5 (tenant isolation) : tenant B cannot see tenant A's device/events ──
  if (otherBusinessId) {
    const seenByOther = await prisma.punchDevice.findFirst({ where: { id: device.id, businessId: otherBusinessId } });
    check('tenant isolation: device invisible to other tenant', seenByOther === null);
    const evOther = await prisma.rawPunchEvent.count({ where: { businessId: otherBusinessId, deviceId: device.id } });
    check('tenant isolation: events invisible to other tenant', evOther === 0);
    // listDevices for the other tenant must not include our device
    const otherList = await devicesSvc.listDevices({ businessId: otherBusinessId, query: {} });
    check('tenant isolation: listDevices excludes A device', !otherList.items.some((d) => d.id === device.id));
  } else {
    log('  (skip tenant isolation — only one tenant in hr_test)');
  }

  // ── 7 (reprocess) : an UNMAPPED code lands, then map + reprocess materialises ──
  const unmappedBatch = [{ deviceCode: '9999', localTimeRaw: '2027-06-11 09:00:00', rawDirection: null, rawPayload: {} }, { deviceCode: '9999', localTimeRaw: '2027-06-11 18:30:00', rawDirection: null, rawPayload: {} }];
  const sumU = await ingest.ingestBatch({ businessId, device: await prisma.punchDevice.findUnique({ where: { id: device.id } }), normalised: unmappedBatch });
  check('unmapped batch parks 2 unmapped', sumU.unmapped === 2 && sumU.materialised === 0);
  const parked = await prisma.rawPunchEvent.count({ where: { businessId, deviceId: device.id, deviceCode: '9999', status: 'UNMAPPED' } });
  check('2 UNMAPPED raw events parked', parked === 2);
  // map 9999 → nightEmp's twin (use dayEmp here is fine for the proof) and reprocess
  await devicesSvc.createMap({ businessId, actorId: 'TEST', body: { deviceCode: '9999', employeeId: dayEmp.id, deviceId: device.id } });
  const rep = await devicesSvc.reprocess({ businessId, actorId: 'TEST', statuses: ['UNMAPPED'], deviceId: device.id });
  check('reprocess remaps 2', rep.remapped === 2);
  check('reprocess materialises 2', rep.materialised === 2);
  const repAtt = await prisma.attendance.findFirst({ where: { businessId, employeeId: dayEmp.id, date: day('2027-06-11') } });
  check('reprocessed day derived PRESENT', repAtt && repAtt.status === 'PRESENT');

  // ── manual correction : flip then discard one of the 06-11 punches ──
  {
    const ev = await prisma.rawPunchEvent.findFirst({ where: { businessId, deviceId: device.id, deviceCode: '9999', status: 'MATERIALISED' }, orderBy: { punchAt: 'asc' } });
    const flipped = await devicesSvc.correctEvent({ businessId, actorId: 'TEST', id: ev.id, action: 'flip' });
    check('correct flip OK', flipped.ok === true && flipped.resolvedType === 'OUT');
    const punch = await prisma.attendancePunch.findFirst({ where: { id: ev.attendancePunchId } });
    check('correct flip updated punchType', punch && punch.punchType === 'OUT');
    const discarded = await devicesSvc.correctEvent({ businessId, actorId: 'TEST', id: ev.id, action: 'discard' });
    check('correct discard OK', discarded.ok === true);
    const ev2 = await prisma.rawPunchEvent.findFirst({ where: { id: ev.id } });
    check('discard → IGNORED (raw kept, not deleted)', ev2 && ev2.status === 'IGNORED' && ev2.attendancePunchId === null);
    const gone = await prisma.attendancePunch.findFirst({ where: { id: ev.attendancePunchId } });
    check('discard soft-removed the punch', gone === null);
  }

  // ── F18 committer + dedup natural key (door 1 spine) ──
  {
    // Simulate the F18 commit path: a fake job + a row's normalized payload.
    const job = await prisma.importJob.create({ data: { businessId, entityId: entity.id, kind: 'BIOMETRIC', status: 'COMMITTING', fileName: `${PREFIX}.csv`, fileKey: `k/${PREFIX}`, fileHash: `${PREFIX}-${Date.now()}`, mimeType: 'text/csv', rowCount: 1, mappingJson: {}, optionsJson: { deviceId: device.id }, uploadedBy: 'TEST' } });
    const r = await prisma.$transaction((tx) => committer.commitBiometricPunch(tx, job, { deviceCode: '1042', localTimeRaw: '2027-06-12 09:00:00', rawDirection: null }, { dryRun: false }));
    check('committer landed a RawPunchEvent', r.targetType === 'RawPunchEvent' && r.isNew === true);
    const post = await committer.recomputeBatchForJob({ businessId, jobId: job.id });
    check('committer post-commit materialised', post.materialised >= 1);
    const att = await prisma.attendance.findFirst({ where: { businessId, employeeId: dayEmp.id, date: day('2027-06-12') } });
    check('committer day derived a row', !!att);
    await prisma.importJob.update({ where: { id: job.id }, data: { status: 'COMMITTED' } });
    // cleanup the import job + its events
    const evs = await prisma.rawPunchEvent.findMany({ where: { importJobId: job.id }, select: { attendancePunchId: true } });
    await prisma.attendancePunch.deleteMany({ where: { id: { in: evs.map((e) => e.attendancePunchId).filter(Boolean) } } });
    await prisma.rawPunchEvent.deleteMany({ where: { importJobId: job.id } });
    await prisma.importJob.delete({ where: { id: job.id } });
  }

  // ── FIX 1 (HIGH) : two GENUINE same-minute punches → TWO RawPunchEvent rows ──
  // 09:01:10 and 09:01:55 differ only in seconds. They must NOT collapse on the
  // @@unique(dedupKey) spine (which previously dropped one → MISSING_PUNCH/inverted).
  {
    // A TRUST_DEVICE device with a 0s dedup window so the de-bounce does not mask
    // the spine behaviour we are testing (this is the spine, not the de-bounce).
    const secDev = await devicesSvc.createDevice({ businessId, actorId: 'TEST', body: { name: `${PREFIX}-SEC`, vendor: 'ESSL', entityId: entity.id, locationId: location ? location.id : null, serialNumber: `${PREFIX}-SN-SEC`, directionMode: 'TRUST_DEVICE', dedupWindowSec: 0 } });
    await devicesSvc.createMap({ businessId, actorId: 'TEST', body: { deviceCode: '7001', employeeId: dayEmp.id, deviceId: secDev.id } });
    const sameMinute = [
      { deviceCode: '7001', localTimeRaw: '2027-06-13 09:01:10', rawDirection: 'IN', rawPayload: {} },
      { deviceCode: '7001', localTimeRaw: '2027-06-13 09:01:55', rawDirection: 'OUT', rawPayload: {} },
    ];
    const sumS = await ingest.ingestBatch({ businessId, device: await prisma.punchDevice.findUnique({ where: { id: secDev.id } }), normalised: sameMinute });
    const raws = await prisma.rawPunchEvent.findMany({ where: { businessId, deviceId: secDev.id, deviceCode: '7001' }, orderBy: { punchAt: 'asc' } });
    check('FIX1: two same-minute punches → 2 RawPunchEvent rows (not collapsed)', raws.length === 2);
    check('FIX1: the two rows have DISTINCT punchAt (seconds kept)', raws.length === 2 && raws[0].punchAt.getTime() !== raws[1].punchAt.getTime());
    check('FIX1: punchAt :10 kept seconds (03:31:10Z IST)', raws[0] && raws[0].punchAt.toISOString() === '2027-06-13T03:31:10.000Z');
    check('FIX1: punchAt :55 kept seconds (03:31:55Z IST)', raws[1] && raws[1].punchAt.toISOString() === '2027-06-13T03:31:55.000Z');
    check('FIX1: distinct dedupKeys', raws.length === 2 && raws[0].dedupKey !== raws[1].dedupKey);
    check('FIX1: both materialised as 2 punches (IN + OUT)', sumS.materialised === 2);
  }

  // ── FIX 2/3 (MED) : multi-device day does NOT cross-contaminate provenance ──
  // The same employee punches on TWO gates the same day: a DERIVE gate at `location`
  // and a TRUST_DEVICE gate at NO location. After BOTH ingests run (the 2nd would
  // previously re-stamp the 1st's punch under its own device/location), each punch
  // must keep ITS OWN device's punchDeviceId + locationId.
  {
    const gateA = await devicesSvc.createDevice({ businessId, actorId: 'TEST', body: { name: `${PREFIX}-GATE-A`, vendor: 'ESSL', entityId: entity.id, locationId: location ? location.id : null, serialNumber: `${PREFIX}-SN-A`, directionMode: 'DERIVE', dedupWindowSec: 60 } });
    const gateB = await devicesSvc.createDevice({ businessId, actorId: 'TEST', body: { name: `${PREFIX}-GATE-B`, vendor: 'MATRIX', entityId: entity.id, locationId: null, serialNumber: `${PREFIX}-SN-B`, directionMode: 'TRUST_DEVICE', dedupWindowSec: 0 } });
    await devicesSvc.createMap({ businessId, actorId: 'TEST', body: { deviceCode: '8001', employeeId: dayEmp.id, deviceId: gateA.id } });
    await devicesSvc.createMap({ businessId, actorId: 'TEST', body: { deviceCode: '8002', employeeId: dayEmp.id, deviceId: gateB.id } });
    // Gate A: 09:00 IN (DERIVE). Gate B: 18:30 with a device OUT token (TRUST).
    await ingest.ingestBatch({ businessId, device: await prisma.punchDevice.findUnique({ where: { id: gateA.id } }), normalised: [{ deviceCode: '8001', localTimeRaw: '2027-06-14 09:00:00', rawDirection: null, rawPayload: {} }] });
    // Gate B ingests LAST → its materialise re-resolves the whole day window. It must
    // NOT re-stamp gate A's 09:00 punch with gate B's device/location.
    await ingest.ingestBatch({ businessId, device: await prisma.punchDevice.findUnique({ where: { id: gateB.id } }), normalised: [{ deviceCode: '8002', localTimeRaw: '2027-06-14 18:30:00', rawDirection: 'OUT', rawPayload: {} }] });

    const punches = await prisma.attendancePunch.findMany({ where: { businessId, employeeId: dayEmp.id, punchAt: { gte: day('2027-06-14'), lt: day('2027-06-15') } }, orderBy: { punchAt: 'asc' } });
    check('FIX2: two punches on the day (one per gate)', punches.length === 2);
    const pIn = punches[0]; const pOut = punches[1];
    check('FIX2: gate-A 09:00 punch keeps gate-A provenance', pIn && pIn.punchDeviceId === gateA.id);
    check('FIX2: gate-A punch keeps gate-A location (not overwritten)', pIn && pIn.locationId === (location ? location.id : null));
    check('FIX2: gate-B 18:30 punch keeps gate-B provenance', pOut && pOut.punchDeviceId === gateB.id);
    check('FIX2: gate-B punch keeps gate-B (null) location', pOut && pOut.locationId === null);
    // Per-event mode honoured: gate-B's TRUST OUT token stayed OUT despite the day's
    // alternation starting with gate-A's DERIVE IN.
    check('FIX2: gate-A IN / gate-B device-OUT labels per-event', pIn && pOut && pIn.punchType === 'IN' && pOut.punchType === 'OUT');
  }

  // ── FIX 4a (LOW) : a DATE-ONLY punch is FLAGGED (ERROR), never landed at 00:00 ──
  {
    const dateOnlyDev = await devicesSvc.createDevice({ businessId, actorId: 'TEST', body: { name: `${PREFIX}-DO`, vendor: 'ESSL', entityId: entity.id, locationId: location ? location.id : null, serialNumber: `${PREFIX}-SN-DO`, directionMode: 'DERIVE' } });
    await devicesSvc.createMap({ businessId, actorId: 'TEST', body: { deviceCode: '6001', employeeId: dayEmp.id, deviceId: dateOnlyDev.id } });
    const sumD = await ingest.ingestBatch({ businessId, device: await prisma.punchDevice.findUnique({ where: { id: dateOnlyDev.id } }), normalised: [{ deviceCode: '6001', localTimeRaw: '2027-06-15', rawDirection: null, rawPayload: {} }] });
    check('FIX4a: date-only punch parked ERROR (not materialised)', sumD.error === 1 && sumD.materialised === 0);
    const doRow = await prisma.rawPunchEvent.findFirst({ where: { businessId, deviceId: dateOnlyDev.id, deviceCode: '6001' } });
    check('FIX4a: date-only landed as ERROR status', doRow && doRow.status === 'ERROR');
    // The epoch sentinel punchAt is used for an unparseable row — NOT a local-midnight punch.
    check('FIX4a: no AttendancePunch at local 00:00 created', doRow && doRow.attendancePunchId === null);
    const midnightPunch = await prisma.attendancePunch.findFirst({ where: { businessId, employeeId: dayEmp.id, punchAt: { gte: day('2027-06-15'), lt: day('2027-06-16') } } });
    check('FIX4a: no midnight AttendancePunch on the target civil day', midnightPunch === null);
  }

  // ── FIX 4b (LOW) : webhook gives a CONSTANT 401 + no tenant oracle in the audit ──
  {
    // Unknown serial (no device anywhere) and a real serial with a BAD secret must
    // both return an identical 401 body, and NEITHER may write the owning tenant's
    // businessId into the audit log (the cross-tenant enumeration oracle).
    const zkSerial = `${PREFIX}-SN-ZK`; // real serial from test 4 (owned by `businessId`)
    const before = await prisma.auditLog.count({ where: { action: 'biometric.ingest_rejected', businessId } });

    const resUnknown = fakeRes();
    await webhook.ingestPunch(fakeReq({ params: { deviceSerial: `${PREFIX}-NOPE-XYZ` }, headers: { 'X-Device-Secret': 'whatever' }, body: '1\t2027-06-16 09:00:00\t0\n' }), resUnknown);
    const resBad = fakeRes();
    await webhook.ingestPunch(fakeReq({ params: { deviceSerial: zkSerial }, headers: { 'X-Device-Secret': 'definitely-wrong' }, body: '1\t2027-06-16 09:00:00\t0\n' }), resBad);

    check('FIX4b: unknown-serial → 401', resUnknown.statusCode === 401);
    check('FIX4b: bad-secret-real-serial → 401', resBad.statusCode === 401);
    check('FIX4b: CONSTANT body (unknown == bad-secret)', resUnknown.body === resBad.body && resUnknown.body === 'unauthorized');
    // No new audit row carries the owning tenant's businessId (oracle closed).
    const afterOwner = await prisma.auditLog.count({ where: { action: 'biometric.ingest_rejected', businessId } });
    check('FIX4b: no audit row stamped with owning tenant businessId', afterOwner === before);
    // The reject IS still audited — but with businessId null (no tenant leak).
    const nullAudits = await prisma.auditLog.findMany({ where: { action: 'biometric.ingest_rejected', businessId: null }, orderBy: { createdAt: 'desc' }, take: 10 });
    const forZk = nullAudits.filter((a) => a.meta && a.meta.serial === zkSerial);
    check('FIX4b: bad-secret reject audited with businessId=null', forZk.length >= 1);
    // cleanup the audit rows this block created (null-tenant rejects for our serials)
    const mine = nullAudits.filter((a) => a.meta && typeof a.meta.serial === 'string' && a.meta.serial.startsWith(PREFIX)).map((a) => a.id);
    if (mine.length) await prisma.auditLog.deleteMany({ where: { id: { in: mine } } });
  }

  await cleanup(businessId);
  if (otherBusinessId) await cleanup(otherBusinessId);

  log(`\nbiometric.live: ${pass} passed, ${fail} failed`);
  if (fail) { log('FAILS:', fails.join('; ')); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error('FATAL', e); try { await prisma.$disconnect(); } catch (_e) { /* */ } process.exit(1); });
