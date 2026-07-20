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

/* ══════════════════════════════════════════════════════════════════════════════
 * Feature 39 — polygon geofence zones. Same purity rules as above: no DB, no I/O.
 * A "zone" is either a POLYGON (map-drawn AttendanceGeoFence outer ring, GeoJSON
 * [lng,lat] vertex order) or a RADIUS (the legacy Location circle). Ray-casting is
 * exact at office scale; distance-to-boundary uses an equirectangular projection
 * centred on the punch (sub-metre accurate at site scale — far finer than any fence).
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * normalizeRing(ring) → cleaned OPEN ring [[lng,lat], ...] or null when unusable.
 * Accepts a closed ring (first == last) and de-dupes consecutive duplicates. Null
 * when < 3 distinct vertices, any coord is non-finite/out-of-range, or the ring is
 * degenerate (zero area).
 */
function normalizeRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const pts = [];
  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lng = toNum(p[0]);
    const lat = toNum(p[1]);
    if (lng == null || lat == null || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    const prev = pts[pts.length - 1];
    if (prev && prev[0] === lng && prev[1] === lat) continue; // consecutive dupe
    pts.push([lng, lat]);
  }
  // Drop the explicit closing vertex if present.
  if (pts.length >= 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return null;
  // Degeneracy check: shoelace area in degree² must be non-zero.
  let area2 = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    area2 += x1 * y2 - x2 * y1;
  }
  if (area2 === 0) return null;
  return pts;
}

/** Ray-cast point-in-polygon; ring = OPEN [[lng,lat],...]. Boundary counts as inside. */
function pointInRing(lat, lng, ring) {
  const x = toNum(lng);
  const y = toNum(lat);
  if (x == null || y == null || !Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0]; const yi = ring[i][1];
    const xj = ring[j][0]; const yj = ring[j][1];
    // On-edge → inside (a punch exactly on the fence line is in-fence).
    if (onSegment(x, y, xi, yi, xj, yj)) return true;
    const intersects = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function onSegment(x, y, x1, y1, x2, y2) {
  const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
  if (Math.abs(cross) > 1e-12) return false;
  return x >= Math.min(x1, x2) - 1e-12 && x <= Math.max(x1, x2) + 1e-12
    && y >= Math.min(y1, y2) - 1e-12 && y <= Math.max(y1, y2) + 1e-12;
}

/**
 * distanceToRingM(lat, lng, ring) → metres from the point to the NEAREST boundary
 * segment (0 when on it). Equirectangular projection centred on the point.
 */
function distanceToRingM(lat, lng, ring) {
  const y0 = toNum(lat);
  const x0 = toNum(lng);
  if (x0 == null || y0 == null || !Array.isArray(ring) || ring.length < 2) return null;
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos(toRad(y0));
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const ax = (ring[j][0] - x0) * mPerDegLng;
    const ay = (ring[j][1] - y0) * mPerDegLat;
    const bx = (ring[i][0] - x0) * mPerDegLng;
    const by = (ring[i][1] - y0) * mPerDegLat;
    best = Math.min(best, pointToSegmentM(0, 0, ax, ay, bx, by));
  }
  return Number.isFinite(best) ? best : null;
}

function pointToSegmentM(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 <= 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

/** Area-weighted centroid of an OPEN ring → { lat, lng } (vertex mean on degenerate). */
function ringCentroid(ring) {
  const pts = normalizeRing(ring);
  if (!pts) return null;
  let a2 = 0; let cx = 0; let cy = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const w = x1 * y2 - x2 * y1;
    a2 += w;
    cx += (x1 + x2) * w;
    cy += (y1 + y2) * w;
  }
  if (a2 === 0) return null;
  return { lng: cx / (3 * a2), lat: cy / (3 * a2) };
}

/**
 * evaluatePunchZones(punch, zones) → the multi-zone geofence verdict.
 *
 * @param punch  { geoLat, geoLng }
 * @param zones  [{ kind:'POLYGON', id, name, ring } | { kind:'RADIUS', id, name, lat, lng, radiusM }]
 * @returns { evaluated, distanceM, outOfGeofence, insideZoneId, nearestZoneId }
 *
 * GRACEFUL DEGRADATION (mirrors evaluatePunchGeofence): no zones or no punch coords
 * → { evaluated:false } and the punch is never flagged. Inside ANY zone → in-fence
 * (distanceM 0); outside all → outOfGeofence with distanceM = metres to the nearest
 * zone boundary/centre-edge (what the HR review queue shows).
 */
function evaluatePunchZones(punch, zones) {
  const list = Array.isArray(zones) ? zones : [];
  const usable = [];
  for (const z of list) {
    if (!z) continue;
    if (z.kind === 'POLYGON') {
      const ring = normalizeRing(z.ring);
      if (ring) usable.push({ ...z, ring });
    } else if (z.kind === 'RADIUS') {
      const lat = toNum(z.lat); const lng = toNum(z.lng); const r = toNum(z.radiusM);
      if (lat != null && lng != null && r != null && r > 0) usable.push({ ...z, lat, lng, radiusM: r });
    }
  }
  if (!usable.length) return { evaluated: false, distanceM: null, outOfGeofence: null, insideZoneId: null, nearestZoneId: null };
  const lat = toNum(punch && punch.geoLat);
  const lng = toNum(punch && punch.geoLng);
  if (lat == null || lng == null) return { evaluated: false, distanceM: null, outOfGeofence: null, insideZoneId: null, nearestZoneId: null };

  let nearest = null;
  let nearestDist = Infinity;
  for (const z of usable) {
    if (z.kind === 'POLYGON') {
      if (pointInRing(lat, lng, z.ring)) {
        return { evaluated: true, distanceM: 0, outOfGeofence: false, insideZoneId: z.id || null, nearestZoneId: z.id || null };
      }
      const d = distanceToRingM(lat, lng, z.ring);
      if (d != null && d < nearestDist) { nearestDist = d; nearest = z; }
    } else {
      const d = haversineMeters(z.lat, z.lng, lat, lng);
      if (d == null) continue;
      if (d <= z.radiusM) {
        return { evaluated: true, distanceM: 0, outOfGeofence: false, insideZoneId: z.id || null, nearestZoneId: z.id || null };
      }
      const beyond = d - z.radiusM; // distance past the circle's edge
      if (beyond < nearestDist) { nearestDist = beyond; nearest = z; }
    }
  }
  return {
    evaluated: true,
    distanceM: Number.isFinite(nearestDist) ? Math.round(nearestDist) : null,
    outOfGeofence: true,
    insideZoneId: null,
    nearestZoneId: nearest ? nearest.id || null : null,
  };
}

module.exports = {
  haversineMeters,
  evaluatePunchGeofence,
  EARTH_RADIUS_M,
  // Feature 39 — polygon zones
  normalizeRing,
  pointInRing,
  distanceToRingM,
  ringCentroid,
  evaluatePunchZones,
};
