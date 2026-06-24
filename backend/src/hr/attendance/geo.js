'use strict';

/**
 * geo.js — PURE geofence math for attendance punches (Cycle 0).
 *
 * No DB, no I/O, no prisma, no Date.now. Plain-`node` unit-testable. The caller
 * (service.js recompute / the punch controllers) resolves the assigned Location's
 * geofence config and the punch coords, then asks this module whether the punch
 * fell outside the allowed radius.
 *
 * Haversine (great-circle distance) — NO external dependency, mean Earth radius
 * 6 371 008 m (IUGG). Accurate to well under a metre at city/site scale, which is
 * far finer than any sane geofence radius (tens–hundreds of metres).
 */

const EARTH_RADIUS_M = 6371008.8;

function toNum(v) {
  if (v == null) return null;
  // Prisma Decimal → string/number; accept either. NaN/empty → null (no coord).
  const n = typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
}

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * haversineMeters(lat1, lng1, lat2, lng2) → great-circle distance in metres,
 * or null if any coordinate is missing/non-finite (so callers degrade gracefully
 * rather than crash on a partial punch / un-geofenced location).
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const a1 = toNum(lat1); const o1 = toNum(lng1);
  const a2 = toNum(lat2); const o2 = toNum(lng2);
  if (a1 == null || o1 == null || a2 == null || o2 == null) return null;
  const dLat = toRad(a2 - a1);
  const dLng = toRad(o2 - o1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(a1)) * Math.cos(toRad(a2)) * s2 * s2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

/**
 * evaluatePunchGeofence(punch, location, opts?) → geofence verdict for ONE punch.
 *
 * GRACEFUL DEGRADATION — returns `{ evaluated:false, ... }` (no flag) when:
 *   - there is no location, or it has no geofence (geoLat/geoLng/geofenceM missing/≤0)
 *   - the punch carries no coords (geoLat/geoLng missing)
 * In those cases the punch is never marked out-of-geofence and nothing throws.
 *
 * When BOTH the location geofence AND the punch coords are present, computes the
 * Haversine distance and compares against geofenceM:
 *   { evaluated:true, distanceM, outOfGeofence: distanceM > geofenceM, enforce }
 *
 * `enforce` resolution (warn-vs-enforce): the per-location Location.geofenceEnforce
 * wins; a tenant-wide default may be passed via opts.tenantEnforce (e.g. from
 * Business.featureFlags.attendance.geofenceEnforce). Default = false (WARN ONLY).
 * Note: `enforce` is advisory metadata here — derive.js surfaces the OUT_OF_GEOFENCE
 * exception off `outOfGeofence` regardless; a hard block (if ever added) keys off
 * `enforce`. This keeps "flag everyone, block only where configured" honest.
 */
function evaluatePunchGeofence(punch, location, opts) {
  const o = opts || {};
  const loc = location || {};
  const fenceLat = toNum(loc.geoLat);
  const fenceLng = toNum(loc.geoLng);
  const radius = toNum(loc.geofenceM);
  const enforce = loc.geofenceEnforce != null
    ? !!loc.geofenceEnforce
    : !!o.tenantEnforce;

  // No usable location geofence → nothing to evaluate.
  if (fenceLat == null || fenceLng == null || radius == null || radius <= 0) {
    return { evaluated: false, distanceM: null, outOfGeofence: null, enforce };
  }
  const punchLat = toNum(punch && punch.geoLat);
  const punchLng = toNum(punch && punch.geoLng);
  // Punch carried no coords → nothing to evaluate (don't penalise a kiosk/biometric
  // punch that legitimately has no GPS).
  if (punchLat == null || punchLng == null) {
    return { evaluated: false, distanceM: null, outOfGeofence: null, enforce };
  }

  const distanceM = haversineMeters(fenceLat, fenceLng, punchLat, punchLng);
  if (distanceM == null) {
    return { evaluated: false, distanceM: null, outOfGeofence: null, enforce };
  }
  return {
    evaluated: true,
    distanceM: Math.round(distanceM),
    outOfGeofence: distanceM > radius,
    enforce,
  };
}

module.exports = { haversineMeters, evaluatePunchGeofence, EARTH_RADIUS_M };
