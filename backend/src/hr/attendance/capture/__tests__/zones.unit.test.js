'use strict';

/*
 * zones.unit.test.js — DB-FREE tests for the Feature 39 polygon-geofence primitives:
 *   - geo.js normalizeRing / pointInRing / distanceToRingM / ringCentroid
 *   - geo.js evaluatePunchZones (multi-zone verdict incl. legacy radius zones)
 *   - policy.resolvePolicy EMPLOYEE-scope precedence (faked db)
 *   - policy.loadZones resolution order: employee links > location links > radius (faked db)
 *
 * Plain-node (built-in assert, no jest):
 *   node backend/src/hr/attendance/capture/__tests__/zones.unit.test.js
 */

const {
  normalizeRing, pointInRing, distanceToRingM, ringCentroid, evaluatePunchZones,
} = require('../../geo');
const { resolvePolicy, loadZones } = require('../policy');

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed += 1; } else { failed += 1; fails.push(name); console.error(`  FAIL  ${name}`); }
}

/* ── normalizeRing ───────────────────────────────────────────────────────────*/
// A ~200m square around Connaught Place, New Delhi (lng,lat order — GeoJSON).
const CP = [[77.216, 28.632], [77.218, 28.632], [77.218, 28.634], [77.216, 28.634]];
check('valid open ring accepted', Array.isArray(normalizeRing(CP)) && normalizeRing(CP).length === 4);
check('closed ring (first==last) accepted + unclosed', normalizeRing([...CP, CP[0]]).length === 4);
check('consecutive dupes dropped', normalizeRing([CP[0], CP[0], CP[1], CP[2], CP[3]]).length === 4);
check('<3 distinct vertices rejected', normalizeRing([CP[0], CP[1], CP[0]]) === null);
check('out-of-range lng rejected', normalizeRing([[181, 28], [77, 28], [77, 29]]) === null);
check('out-of-range lat rejected', normalizeRing([[77, 91], [78, 28], [77, 29]]) === null);
check('zero-area (collinear) rejected', normalizeRing([[77, 28], [77.001, 28], [77.002, 28]]) === null);
check('junk rejected', normalizeRing('nope') === null && normalizeRing(null) === null);

/* ── pointInRing ─────────────────────────────────────────────────────────────*/
const ring = normalizeRing(CP);
check('centre point inside', pointInRing(28.633, 77.217, ring) === true);
check('north of ring outside', pointInRing(28.64, 77.217, ring) === false);
check('west of ring outside', pointInRing(28.633, 77.21, ring) === false);
check('vertex counts as inside', pointInRing(28.632, 77.216, ring) === true);
check('edge midpoint counts as inside', pointInRing(28.632, 77.217, ring) === true);
// Concave "L" polygon: the notch must be OUTSIDE.
const L = normalizeRing([[0, 0], [0.004, 0], [0.004, 0.004], [0.002, 0.004], [0.002, 0.002], [0, 0.002]]);
check('concave L: inside the foot', pointInRing(0.001, 0.001, L) === true);
check('concave L: inside the arm', pointInRing(0.003, 0.003, L) === true);
check('concave L: the notch is outside', pointInRing(0.003, 0.001, L) === false);

/* ── distanceToRingM ─────────────────────────────────────────────────────────*/
// At the equator 0.001° of longitude ≈ 111.3 m. A point 0.001° west of the ring's
// western edge (lng 0) must be ≈ 111 m away.
const EQ = normalizeRing([[0, 0], [0.004, 0], [0.004, 0.004], [0, 0.004]]);
{
  const d = distanceToRingM(0.002, -0.001, EQ);
  check('distance ~111m from west edge', d != null && Math.abs(d - 111.3) < 2);
  const dOn = distanceToRingM(0, 0.002, EQ);
  check('on-edge distance ~0', dOn != null && dOn < 0.5);
}

/* ── ringCentroid ────────────────────────────────────────────────────────────*/
{
  const c = ringCentroid([[0, 0], [2, 0], [2, 2], [0, 2]]);
  check('square centroid at (1,1)', c && Math.abs(c.lng - 1) < 1e-9 && Math.abs(c.lat - 1) < 1e-9);
}

/* ── evaluatePunchZones ──────────────────────────────────────────────────────*/
const polyZone = { kind: 'POLYGON', id: 'f1', name: 'HQ', ring: CP };
const radiusZone = { kind: 'RADIUS', id: 'loc1', name: 'Office radius', lat: 28.633, lng: 77.217, radiusM: 150 };
{
  const none = evaluatePunchZones({ geoLat: 28.633, geoLng: 77.217 }, []);
  check('no zones → not evaluated', none.evaluated === false && none.outOfGeofence === null);
  const noCoords = evaluatePunchZones({}, [polyZone]);
  check('no coords → not evaluated', noCoords.evaluated === false);
  const inside = evaluatePunchZones({ geoLat: 28.633, geoLng: 77.217 }, [polyZone]);
  check('inside polygon → in-fence d=0', inside.evaluated === true && inside.outOfGeofence === false && inside.distanceM === 0 && inside.insideZoneId === 'f1');
  const out = evaluatePunchZones({ geoLat: 28.64, geoLng: 77.217 }, [polyZone]);
  check('outside polygon → out + distance>0 + nearest', out.evaluated === true && out.outOfGeofence === true && out.distanceM > 0 && out.nearestZoneId === 'f1');
  const inRadius = evaluatePunchZones({ geoLat: 28.6335, geoLng: 77.2172 }, [radiusZone]);
  check('inside radius zone → in-fence', inRadius.evaluated === true && inRadius.outOfGeofence === false);
  const outRadius = evaluatePunchZones({ geoLat: 28.66, geoLng: 77.217 }, [radiusZone]);
  check('outside radius zone → out, distance past edge', outRadius.outOfGeofence === true && outRadius.distanceM > 0);
  const anyOf = evaluatePunchZones({ geoLat: 28.633, geoLng: 77.217 }, [radiusZone, polyZone]);
  check('any-of: inside one of several zones passes', anyOf.outOfGeofence === false);
  const badZone = evaluatePunchZones({ geoLat: 28.633, geoLng: 77.217 }, [{ kind: 'POLYGON', id: 'x', ring: 'junk' }]);
  check('unusable zone alone → not evaluated (graceful)', badZone.evaluated === false);
}

/* ── resolvePolicy EMPLOYEE precedence (faked db) ───────────────────────────*/
function fakeDb(policyRows, links = [], fences = []) {
  return {
    attendanceCapturePolicy: { findMany: async () => policyRows },
    attendanceFenceLink: { findMany: async ({ where }) => links.filter((l) => l.isActive !== false && (where.OR || []).some((o) => o.scopeKind === l.scopeKind && o.scopeId === l.scopeId)) },
    attendanceGeoFence: { findMany: async ({ where }) => fences.filter((f) => f.isActive !== false && where.id.in.includes(f.id)) },
  };
}
(async () => {
  const rows = [
    { scope: 'TENANT', scopeId: null, requireFace: false, name: 'tenant' },
    { scope: 'EMPLOYEE_GROUP', scopeId: 'dep1', requireFace: false, name: 'dept' },
    { scope: 'EMPLOYEE', scopeId: 'emp1', requireFace: true, name: 'personal' },
  ];
  const p1 = await resolvePolicy('biz', { employeeId: 'emp1', departmentId: 'dep1' }, fakeDb(rows));
  check('EMPLOYEE scope beats EMPLOYEE_GROUP', p1.name === 'personal' && p1.requireFace === true);
  const p2 = await resolvePolicy('biz', { employeeId: 'emp2', departmentId: 'dep1' }, fakeDb(rows));
  check('other employee falls to dept scope', p2.name === 'dept');
  const p3 = await resolvePolicy('biz', {}, fakeDb(rows));
  check('no ctx falls to tenant scope', p3.name === 'tenant');

  /* ── loadZones resolution order ────────────────────────────────────────────*/
  const fences = [
    { id: 'fEmp', name: 'Personal zone', polygonJson: CP, isActive: true },
    { id: 'fLoc', name: 'Office zone', polygonJson: EQ, isActive: true },
  ];
  const bothLinks = [
    { fenceId: 'fEmp', scopeKind: 'EMPLOYEE', scopeId: 'emp1', isActive: true },
    { fenceId: 'fLoc', scopeKind: 'LOCATION', scopeId: 'loc1', isActive: true },
  ];
  const location = { id: 'loc1', geoLat: 28.633, geoLng: 77.217, geofenceM: 100 };

  const z1 = await loadZones('biz', { employeeId: 'emp1', locationId: 'loc1', location }, fakeDb([], bothLinks, fences));
  check('employee links override location links', z1.length === 1 && z1[0].id === 'fEmp');

  const z2 = await loadZones('biz', { employeeId: 'emp2', locationId: 'loc1', location }, fakeDb([], bothLinks, fences));
  check('no personal links → location links', z2.length === 1 && z2[0].id === 'fLoc');

  const z3 = await loadZones('biz', { employeeId: 'emp2', locationId: 'loc1', location }, fakeDb([], [], fences));
  check('no links at all → legacy radius', z3.length === 1 && z3[0].kind === 'RADIUS' && z3[0].radiusM === 100);

  const z4 = await loadZones('biz', { employeeId: 'emp2', locationId: 'loc1', location: null }, fakeDb([], [], []));
  check('nothing configured → no zones', z4.length === 0);

  // Fence rows missing/inactive → fall through to radius (graceful).
  const z5 = await loadZones('biz', { employeeId: 'emp1', locationId: 'loc1', location }, fakeDb([], bothLinks, [{ id: 'fEmp', name: 'x', polygonJson: CP, isActive: false }]));
  check('inactive fence behind a link → radius fallback', z5.length === 1 && z5[0].kind === 'RADIUS');

  console.log(`zones.unit: ${passed} passed, ${failed} failed`);
  if (failed) { console.error('FAILED:', fails.join('; ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
