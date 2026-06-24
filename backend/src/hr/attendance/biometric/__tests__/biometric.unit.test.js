'use strict';

/*
 * biometric.unit.test.js — DB-FREE unit tests for the Feature 28 PURE pieces.
 * Plain-node (built-in assert, no jest):
 *   node backend/src/hr/attendance/biometric/__tests__/biometric.unit.test.js
 *
 * Covers: the per-vendor adapters (golden lines — a real ZK ATTLOG, an eSSL CSV/.dat,
 * a Cams JSON, a Matrix JSON), the local-time normaliser (incl. DD-MM-YYYY + 12h),
 * the direction resolver (DERIVE alternation incl. odd counts; TRUST_DEVICE token
 * map; ALL_IN; de-bounce), and dedupKey stability.
 */

const assert = require('assert');
const path = require('path');

const esslCsv = require('../adapters/esslCsv');
const zktecoAdms = require('../adapters/zktecoAdms');
const camsRest = require('../adapters/camsRest');
const matrixCosec = require('../adapters/matrixCosec');
const genericCsv = require('../adapters/genericCsv');
const { normalizeLocalTime } = require('../adapters/normalizeTime');
const { resolveDayDirections, mapTrustToken } = require('../direction');
const { computeDedupKey } = require('../ingest.service');

let passed = 0; let failed = 0; const fails = [];
function check(name, cond) { if (cond) { passed += 1; } else { failed += 1; fails.push(name); console.error(`  FAIL  ${name}`); } }

// ── normalizeLocalTime ───────────────────────────────────────────────────────
check('norm ISO space', normalizeLocalTime('2026-06-24 09:01:33') === '2026-06-24 09:01:33');
check('norm ISO T', normalizeLocalTime('2026-06-24T09:01:33') === '2026-06-24 09:01:33');
check('norm no-seconds', normalizeLocalTime('2026-06-24 09:01') === '2026-06-24 09:01:00');
check('norm DD-MM-YYYY', normalizeLocalTime('24-06-2026 09:01:33') === '2026-06-24 09:01:33');
check('norm DD/MM/YYYY', normalizeLocalTime('24/06/2026 9:01') === '2026-06-24 09:01:00');
check('norm 12h PM', normalizeLocalTime('2026-06-24 06:30:00 PM') === '2026-06-24 18:30:00');
check('norm 12h 12AM', normalizeLocalTime('2026-06-24 12:05:00 AM') === '2026-06-24 00:05:00');
check('norm junk → null', normalizeLocalTime('not a date') === null);

// ── eSSL CSV adapter (header rows) ───────────────────────────────────────────
{
  const rows = [
    { EnrollNo: '1042', DateTime: '2026-06-24 09:01:33', Status: 'C/In' },
    { EnrollNo: '1042', DateTime: '2026-06-24 18:02:10', Status: 'C/Out' },
  ];
  const out = esslCsv.parse(rows, {});
  check('essl rows count', out.length === 2);
  check('essl code', out[0].deviceCode === '1042');
  check('essl time normalised', out[0].localTimeRaw === '2026-06-24 09:01:33');
  check('essl direction passthrough', out[1].rawDirection === 'C/Out');
}
// eSSL .dat fallback (whitespace columns, no header)
{
  const dat = '  1042  2026-06-24 09:01:33  0\n  1043  2026-06-24 09:05:00  0\n';
  const out = esslCsv.parse(dat, {});
  check('essl .dat count', out.length === 2);
  check('essl .dat code', out[0].deviceCode === '1042');
  check('essl .dat time', out[0].localTimeRaw === '2026-06-24 09:01:33');
}

// ── ZKTeco ADMS adapter (tab-separated ATTLOG) ───────────────────────────────
{
  const attlog = '1042\t2026-06-24 09:01:33\t0\t1\t0\n1042\t2026-06-24 18:02:10\t1\t1\t0\n';
  const out = zktecoAdms.parse(attlog, {});
  check('zk attlog count', out.length === 2);
  check('zk pin', out[0].deviceCode === '1042');
  check('zk time', out[0].localTimeRaw === '2026-06-24 09:01:33');
  check('zk status passthrough', out[0].rawDirection === '0' && out[1].rawDirection === '1');
}

// ── Cams REST adapter (JSON) ─────────────────────────────────────────────────
{
  const body = [
    { EmployeeCode: '1042', AttendanceLogTime: '2026-06-24 09:01:33', AttendanceType: 'IN' },
    { EmployeeCode: '1042', AttendanceLogTime: '2026-06-24 18:02:10', AttendanceType: 'OUT' },
  ];
  const out = camsRest.parse(body, {});
  check('cams count', out.length === 2);
  check('cams code', out[0].deviceCode === '1042');
  check('cams dir', out[0].rawDirection === 'IN');
  // string body
  const out2 = camsRest.parse(JSON.stringify({ data: body }), {});
  check('cams string+data wrapper', out2.length === 2);
}

// ── Matrix COSEC adapter (JSON) ──────────────────────────────────────────────
{
  const body = { events: [{ UserID: '1042', EventDateTime: '2026-06-24 09:01:33', EventType: 'IN' }] };
  const out = matrixCosec.parse(body, {});
  check('matrix count', out.length === 1);
  check('matrix code', out[0].deviceCode === '1042');
}

// ── genericCsv ───────────────────────────────────────────────────────────────
{
  const out = genericCsv.parse([{ employeeCode: 'E1', localTime: '2026-06-24 09:00:00', direction: '' }], {});
  check('generic code', out[0].deviceCode === 'E1' && out[0].localTimeRaw === '2026-06-24 09:00:00');
}

// ── direction: DERIVE alternation (even) ─────────────────────────────────────
{
  const evs = [
    { id: 'a', punchAtMs: 1000 * 60 * 60 * 9, rawDirection: null },     // 09:00
    { id: 'b', punchAtMs: 1000 * 60 * 60 * 13, rawDirection: null },    // 13:00
    { id: 'c', punchAtMs: 1000 * 60 * 60 * 14, rawDirection: null },    // 14:00
    { id: 'd', punchAtMs: 1000 * 60 * 60 * 18, rawDirection: null },    // 18:00
  ];
  const r = resolveDayDirections(evs, { mode: 'DERIVE', dedupWindowSec: 60 });
  check('derive even labels', r.map((x) => x.punchType).join(',') === 'IN,OUT,IN,OUT');
}
// DERIVE odd count → last stays IN
{
  const evs = [
    { id: 'a', punchAtMs: 1000 * 60 * 60 * 9, rawDirection: null },
    { id: 'b', punchAtMs: 1000 * 60 * 60 * 13, rawDirection: null },
    { id: 'c', punchAtMs: 1000 * 60 * 60 * 18, rawDirection: null },
  ];
  const r = resolveDayDirections(evs, { mode: 'DERIVE', dedupWindowSec: 60 });
  check('derive odd last=IN', r.map((x) => x.punchType).join(',') === 'IN,OUT,IN');
}
// DERIVE unsorted input still sorts
{
  const evs = [
    { id: 'late', punchAtMs: 1000 * 60 * 60 * 18, rawDirection: null },
    { id: 'early', punchAtMs: 1000 * 60 * 60 * 9, rawDirection: null },
  ];
  const r = resolveDayDirections(evs, { mode: 'DERIVE', dedupWindowSec: 60 });
  const byId = Object.fromEntries(r.map((x) => [x.id, x.punchType]));
  check('derive sorts: early=IN late=OUT', byId.early === 'IN' && byId.late === 'OUT');
}
// de-bounce: two events within 60s → 2nd duplicate
{
  const evs = [
    { id: 'a', punchAtMs: 1000 * 60 * 60 * 9, rawDirection: null },
    { id: 'b', punchAtMs: 1000 * 60 * 60 * 9 + 3000, rawDirection: null }, // +3s
    { id: 'c', punchAtMs: 1000 * 60 * 60 * 18, rawDirection: null },
  ];
  const r = resolveDayDirections(evs, { mode: 'DERIVE', dedupWindowSec: 60 });
  const byId = Object.fromEntries(r.map((x) => [x.id, x]));
  check('debounce 2nd duplicate', byId.b.duplicate === true && byId.b.punchType === null);
  check('debounce keeps a=IN c=OUT', byId.a.punchType === 'IN' && byId.c.punchType === 'OUT');
}
// TRUST_DEVICE ZK status tokens
{
  const evs = [
    { id: 'a', punchAtMs: 100, rawDirection: '0' },
    { id: 'b', punchAtMs: 200, rawDirection: '1' },
    { id: 'c', punchAtMs: 300, rawDirection: '2' }, // break-start
    { id: 'd', punchAtMs: 400, rawDirection: '3' }, // break-end
  ];
  const r = resolveDayDirections(evs, { mode: 'TRUST_DEVICE', dedupWindowSec: 0 });
  check('trust ZK 0/1/2/3', r.map((x) => x.punchType).join(',') === 'IN,OUT,BREAK_START,BREAK_END');
}
// TRUST_DEVICE textual + unmappable falls to alternation
{
  const evs = [
    { id: 'a', punchAtMs: 100, rawDirection: 'C/In' },
    { id: 'b', punchAtMs: 200, rawDirection: 'AutoLog' }, // unmappable → alternation (after IN → OUT)
  ];
  const r = resolveDayDirections(evs, { mode: 'TRUST_DEVICE', dedupWindowSec: 0 });
  check('trust C/In→IN, AutoLog→OUT(alt)', r.map((x) => x.punchType).join(',') === 'IN,OUT');
}
// ALL_IN
{
  const evs = [{ id: 'a', punchAtMs: 100, rawDirection: null }, { id: 'b', punchAtMs: 99999999, rawDirection: null }];
  const r = resolveDayDirections(evs, { mode: 'ALL_IN', dedupWindowSec: 0 });
  check('all_in all IN', r.every((x) => x.punchType === 'IN'));
}
check('mapTrustToken C/Out → OUT', mapTrustToken('C/Out') === 'OUT');
check('mapTrustToken 4 (OT-in) → IN', mapTrustToken('4') === 'IN');

// ── dedupKey stability ───────────────────────────────────────────────────────
{
  const at = new Date('2026-06-24T03:31:33.000Z');
  const k1 = computeDedupKey({ businessId: 'biz', deviceId: 'dev', deviceCode: '1042', punchAt: at, rawDirection: '0' });
  const k2 = computeDedupKey({ businessId: 'biz', deviceId: 'dev', deviceCode: '1042', punchAt: new Date(at.getTime()), rawDirection: '0' });
  const k3 = computeDedupKey({ businessId: 'biz', deviceId: 'dev', deviceCode: '1042', punchAt: at, rawDirection: '1' });
  check('dedupKey stable for same input', k1 === k2);
  check('dedupKey differs on rawDirection', k1 !== k3);
  check('dedupKey is sha256 hex', /^[0-9a-f]{64}$/.test(k1));
}

console.log(`\nbiometric.unit: ${passed} passed, ${failed} failed`);
if (failed) { console.error('FAILS:', fails.join('; ')); process.exit(1); }
process.exit(0);
