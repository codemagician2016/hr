'use strict';

/*
 * geofence.unit.test.js — DB-FREE tests for the PURE geofence math (Cycle 0).
 * Plain-node (built-in assert, no jest):
 *   node backend/src/hr/attendance/__tests__/geofence.unit.test.js
 *
 * Covers:
 *   - haversineMeters: known great-circle distances + missing-coord → null.
 *   - evaluatePunchGeofence: inside / outside the radius, warn-vs-enforce resolution,
 *     graceful degradation (no location geofence, no punch coords).
 *   - evaluateDayGeofence (service helper): collapses a day's punches → flag +
 *     maxDistance + only-changed marker updates (idempotent re-run).
 *
 * The LIVE end-to-end proof (punch outside → OUT_OF_GEOFENCE surfaces via derive,
 * marker persisted, warn-vs-enforce on the day row) lives in fixes.rbac.test.js.
 */

const assert = require('assert');
const { haversineMeters, evaluatePunchGeofence } = require('../geo');
const { _internals: svc } = require('../service');

let passed = 0;
let failed = 0;
const fails = [];
function check(name, cond) {
  if (cond) { passed += 1; } else { failed += 1; fails.push(name); console.error(`  FAIL  ${name}`); }
}

/* ── haversineMeters ────────────────────────────────────────────────────────*/
// Same point → 0 m.
check('haversine same point = 0', haversineMeters(12.9716, 77.5946, 12.9716, 77.5946) === 0);
// ~1 degree of latitude ≈ 111.2 km (within 0.3%).
{
  const d = haversineMeters(0, 0, 1, 0);
  check('haversine 1° lat ≈ 111.2km', Math.abs(d - 111195) < 400);
}
// A small ~111 m step in latitude (0.001°) at the equator.
{
  const d = haversineMeters(0, 0, 0.001, 0);
  check('haversine 0.001° lat ≈ 111m', Math.abs(d - 111.2) < 1.5);
}
// Bengaluru office → ~150 m away point: between 140 and 160 m.
{
  // 0.00135° lat ≈ 150 m. Use a pure-north offset for a clean check.
  const d = haversineMeters(12.9716, 77.5946, 12.9716 + 0.00135, 77.5946);
  check('haversine ~150m north', d > 140 && d < 160);
}
// Missing / non-finite coords → null (graceful).
check('haversine missing lat → null', haversineMeters(null, 0, 1, 1) === null);
check('haversine NaN lng → null', haversineMeters(0, 'x', 1, 1) === null);

/* ── evaluatePunchGeofence ──────────────────────────────────────────────────*/
const LOC = { geoLat: 12.9716, geoLng: 77.5946, geofenceM: 100, geofenceEnforce: false };

// Inside the 100 m radius → not out, evaluated true.
{
  const v = evaluatePunchGeofence({ geoLat: 12.9716, geoLng: 77.5946 }, LOC);
  check('inside radius → evaluated, not out', v.evaluated === true && v.outOfGeofence === false && v.distanceM === 0);
}
// ~150 m north → outside the 100 m radius.
{
  const v = evaluatePunchGeofence({ geoLat: 12.9716 + 0.00135, geoLng: 77.5946 }, LOC);
  check('outside radius → outOfGeofence true', v.evaluated === true && v.outOfGeofence === true && v.distanceM > 100);
}
// At/within the boundary is NOT out (strict greater-than gate). Use a radius
// ceiling-ed above the unrounded distance so distance <= radius holds.
{
  const punch = { geoLat: 12.9716 + 0.00135, geoLng: 77.5946 };
  const dist = haversineMeters(LOC.geoLat, LOC.geoLng, punch.geoLat, punch.geoLng);
  const v = evaluatePunchGeofence(punch, { ...LOC, geofenceM: Math.ceil(dist) });
  check('distance <= radius → NOT out', v.outOfGeofence === false);
  // One metre tighter than the distance → out.
  const v2 = evaluatePunchGeofence(punch, { ...LOC, geofenceM: Math.floor(dist) - 1 });
  check('distance > radius → out', v2.outOfGeofence === true);
}

// warn-vs-enforce: per-location enforce wins.
{
  const warn = evaluatePunchGeofence({ geoLat: 12.99, geoLng: 77.60 }, { ...LOC, geofenceEnforce: false });
  const enf = evaluatePunchGeofence({ geoLat: 12.99, geoLng: 77.60 }, { ...LOC, geofenceEnforce: true });
  check('warn mode → enforce false', warn.enforce === false && warn.outOfGeofence === true);
  check('enforce mode → enforce true (still flags)', enf.enforce === true && enf.outOfGeofence === true);
}
// tenant default applies only when the location does not set geofenceEnforce.
{
  const loc = { geoLat: 12.9716, geoLng: 77.5946, geofenceM: 100 }; // no geofenceEnforce key
  const v = evaluatePunchGeofence({ geoLat: 12.99, geoLng: 77.60 }, loc, { tenantEnforce: true });
  check('tenant default enforce used when location unset', v.enforce === true);
  const locExplicitFalse = { ...loc, geofenceEnforce: false };
  const v2 = evaluatePunchGeofence({ geoLat: 12.99, geoLng: 77.60 }, locExplicitFalse, { tenantEnforce: true });
  check('per-location false overrides tenant true', v2.enforce === false);
}

/* ── graceful degradation ───────────────────────────────────────────────────*/
// No location at all → not evaluated, no flag, no throw.
check('no location → not evaluated', evaluatePunchGeofence({ geoLat: 1, geoLng: 1 }, null).evaluated === false);
// Location has no geofence (missing radius) → not evaluated.
check('location without geofenceM → not evaluated',
  evaluatePunchGeofence({ geoLat: 1, geoLng: 1 }, { geoLat: 1, geoLng: 1 }).evaluated === false);
// Location geofence but punch has no coords → not evaluated (kiosk/biometric).
check('punch without coords → not evaluated',
  evaluatePunchGeofence({}, LOC).evaluated === false);
// Zero / negative radius → treated as no geofence.
check('radius 0 → not evaluated',
  evaluatePunchGeofence({ geoLat: 12.99, geoLng: 77.60 }, { ...LOC, geofenceM: 0 }).evaluated === false);

/* ── evaluateDayGeofence (service collapse + marker updates) ─────────────────*/
{
  const inP = { id: 'p1', punchType: 'IN', geoLat: 12.9716, geoLng: 77.5946, outOfGeofence: null, geoDistanceM: null };
  const outP = { id: 'p2', punchType: 'OUT', geoLat: 12.9716 + 0.00135, geoLng: 77.5946, outOfGeofence: null, geoDistanceM: null };
  const r = svc.evaluateDayGeofence([inP, outP], LOC, false);
  check('day: any out punch → outOfGeofence true', r.outOfGeofence === true);
  check('day: maxDistanceM is the far one (>100)', r.maxDistanceM > 100);
  check('day: both markers need a write (were null)', r.markerUpdates.length === 2);
  check('day: IN marker false, OUT marker true',
    r.markerUpdates.find((u) => u.id === 'p1').outOfGeofence === false
    && r.markerUpdates.find((u) => u.id === 'p2').outOfGeofence === true);

  // Idempotent re-run: markers already match → no updates queued.
  const inP2 = { ...inP, outOfGeofence: false, geoDistanceM: 0 };
  const outDist = r.markerUpdates.find((u) => u.id === 'p2').geoDistanceM;
  const outP2 = { ...outP, outOfGeofence: true, geoDistanceM: outDist };
  const r2 = svc.evaluateDayGeofence([inP2, outP2], LOC, false);
  check('day: re-run with matching markers → no marker writes', r2.markerUpdates.length === 0);
  check('day: re-run still reports outOfGeofence', r2.outOfGeofence === true);

  // BREAK punches are ignored for the verdict.
  const brk = { id: 'b1', punchType: 'BREAK_START', geoLat: 12.99, geoLng: 77.60, outOfGeofence: null, geoDistanceM: null };
  const r3 = svc.evaluateDayGeofence([inP2, brk], LOC, false);
  check('day: BREAK punch ignored for geofence verdict', r3.outOfGeofence === false && r3.markerUpdates.length === 0);

  // No location → no flag, no updates (graceful).
  const r4 = svc.evaluateDayGeofence([inP, outP], null, false);
  check('day: no location → no flag / no writes', r4.outOfGeofence === false && r4.markerUpdates.length === 0);
}

/* ── tenantGeofenceEnforce (featureFlags resolution) ────────────────────────*/
check('tenant enforce: missing featureFlags → false', svc.tenantGeofenceEnforce({}) === false);
check('tenant enforce: flag set → true',
  svc.tenantGeofenceEnforce({ featureFlags: { attendance: { geofenceEnforce: true } } }) === true);
check('tenant enforce: unrelated flags → false',
  svc.tenantGeofenceEnforce({ featureFlags: { attendance: { somethingElse: true } } }) === false);

/* ── report ────────────────────────────────────────────────────────────────*/
console.log(`\ngeofence.unit: ${passed} passed, ${failed} failed`);
if (failed) { console.error('FAILURES:', fails.join('; ')); process.exit(1); }
console.log('=== ALL GEOFENCE UNIT TESTS PASSED ===');
