// ECOMMERCE multi-store (2026-05-11) - customer area -> store resolution.
//
// Delivery areas can now be defined by:
//   EcomDeliveryZone.postcodes (JSON array of strings)
//   EcomDeliveryZone.polygon   (polygon GeoJSON-ish shape or radius object)
//
// All modes return the same { location, zone } candidates so storefront,
// admin tester, and checkout share one source of truth.

'use strict';

function normalisePostal(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalisePoint(value) {
  if (!value || typeof value !== 'object') return null;
  const lat = finiteNumber(value.lat ?? value.latitude);
  const lng = finiteNumber(value.lng ?? value.lon ?? value.longitude);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function zoneMatchesPostal(zone, normInput) {
  const codes = Array.isArray(zone.postcodes) ? zone.postcodes : [];
  for (const raw of codes) {
    if (normalisePostal(raw) === normInput) return true;
  }
  return false;
}

function normaliseCoordinatePair(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const lng = finiteNumber(pair[0]);
  const lat = finiteNumber(pair[1]);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lng, lat];
}

function coordinateRingFromValue(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const ring = Array.isArray(value[0]?.[0]) ? value[0] : value;
  return ring.map(normaliseCoordinatePair).filter(Boolean);
}

function withoutClosingDuplicate(points) {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first[0] - last[0]) < 1e-12 && Math.abs(first[1] - last[1]) < 1e-12) {
    return points.slice(0, -1);
  }
  return points;
}

function normaliseZoneGeometry(rawGeometry) {
  if (!rawGeometry) return null;

  const geometry = rawGeometry.type === 'Feature' && rawGeometry.geometry
    ? rawGeometry.geometry
    : rawGeometry;

  const type = String(geometry.type || geometry.mode || '').toLowerCase();
  if (type === 'radius' || type === 'circle') {
    const center = normalisePoint(geometry.center || geometry);
    const radiusMeters = finiteNumber(
      geometry.radiusMeters
        ?? geometry.radius_meters
        ?? (geometry.radiusKm !== undefined ? Number(geometry.radiusKm) * 1000 : undefined)
        ?? geometry.radius,
    );
    if (!center || radiusMeters === null || radiusMeters <= 0) return null;
    return { type: 'radius', center, radiusMeters };
  }

  const rawCoordinates = Array.isArray(geometry)
    ? geometry
    : (geometry.coordinates || geometry.points || []);
  const coordinates = withoutClosingDuplicate(coordinateRingFromValue(rawCoordinates));
  if (coordinates.length < 3) return null;
  return { type: 'polygon', coordinates };
}

function pointOnSegment(point, a, b) {
  const x = point.lng;
  const y = point.lat;
  const x1 = a[0];
  const y1 = a[1];
  const x2 = b[0];
  const y2 = b[1];
  const cross = (y - y1) * (x2 - x1) - (x - x1) * (y2 - y1);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (x - x1) * (x2 - x1) + (y - y1) * (y2 - y1);
  if (dot < 0) return false;
  const lengthSq = ((x2 - x1) ** 2) + ((y2 - y1) ** 2);
  return dot <= lengthSq + 1e-10;
}

function isPointInPolygon(pointInput, coordinatesInput) {
  const point = normalisePoint(pointInput);
  const coordinates = withoutClosingDuplicate(coordinateRingFromValue(coordinatesInput));
  if (!point || coordinates.length < 3) return false;

  let inside = false;
  for (let i = 0, j = coordinates.length - 1; i < coordinates.length; j = i, i += 1) {
    const a = coordinates[j];
    const b = coordinates[i];
    if (pointOnSegment(point, a, b)) return true;

    const xi = b[0];
    const yi = b[1];
    const xj = a[0];
    const yj = a[1];
    const intersects = ((yi > point.lat) !== (yj > point.lat))
      && (point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function haversineMeters(pointInput, centerInput) {
  const point = normalisePoint(pointInput);
  const center = normalisePoint(centerInput);
  if (!point || !center) return Infinity;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const dLat = toRad(center.lat - point.lat);
  const dLng = toRad(center.lng - point.lng);
  const lat1 = toRad(point.lat);
  const lat2 = toRad(center.lat);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * (Math.sin(dLng / 2) ** 2);
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function zoneMatchesCoordinates(zone, pointInput) {
  const point = normalisePoint(pointInput);
  const geometry = normaliseZoneGeometry(zone?.polygon);
  if (!point || !geometry) return false;
  if (geometry.type === 'radius') {
    return haversineMeters(point, geometry.center) <= geometry.radiusMeters;
  }
  return isPointInPolygon(point, geometry.coordinates);
}

async function listActiveZones({ prisma, businessId }) {
  if (!businessId) return [];
  return prisma.ecomDeliveryZone.findMany({
    where: { businessId, isActive: true },
    select: {
      id: true,
      name: true,
      slug: true,
      cityId: true,
      primaryLocationId: true,
      postcodes: true,
      polygon: true,
      sortOrder: true,
      deliveryFeeMinor: true,
      freeDeliveryThresholdMinor: true,
      expressSurchargeMinor: true,
      promiseMinutes: true,
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

async function resolveCandidatesForZones({ prisma, businessId, matchingZones }) {
  if (!businessId || !Array.isArray(matchingZones) || matchingZones.length === 0) {
    return [];
  }

  const pinnedLocationIds = new Set();
  const cityPoolIds = new Set();
  const zoneByLocationId = new Map();
  const zoneByCityId = new Map();

  for (const zone of matchingZones) {
    if (zone.primaryLocationId) {
      pinnedLocationIds.add(zone.primaryLocationId);
      if (!zoneByLocationId.has(zone.primaryLocationId)) {
        zoneByLocationId.set(zone.primaryLocationId, zone);
      }
    } else if (zone.cityId) {
      cityPoolIds.add(zone.cityId);
      if (!zoneByCityId.has(zone.cityId)) zoneByCityId.set(zone.cityId, zone);
    }
  }

  let poolLocationIds = [];
  if (cityPoolIds.size > 0) {
    const cities = await prisma.ecomServiceCity.findMany({
      where: { businessId, id: { in: Array.from(cityPoolIds) }, isActive: true },
      select: { id: true, slug: true, name: true },
    });
    if (cities.length > 0) {
      const citySlugs = cities.map((city) => (city.slug || '').toLowerCase());
      const poolLocs = await prisma.businessLocation.findMany({
        where: { businessId, isActive: true },
        select: { id: true, city: true },
      });
      const matched = poolLocs.filter((location) => {
        const lc = (location.city || '').toLowerCase();
        return citySlugs.includes(lc)
          || cities.some((city) => (city.name || '').toLowerCase() === lc);
      });
      poolLocationIds = matched.map((location) => location.id);
      for (const location of matched) {
        if (!zoneByLocationId.has(location.id)) {
          const lc = (location.city || '').toLowerCase();
          const city = cities.find((item) => (
            (item.slug || '').toLowerCase() === lc
              || (item.name || '').toLowerCase() === lc
          ));
          if (city) {
            const zone = zoneByCityId.get(city.id);
            if (zone) zoneByLocationId.set(location.id, zone);
          }
        }
      }
    }
  }

  const allIds = Array.from(new Set([...pinnedLocationIds, ...poolLocationIds]));
  if (allIds.length === 0) return [];

  const locations = await prisma.businessLocation.findMany({
    where: { businessId, id: { in: allIds }, isActive: true },
    select: {
      id: true,
      name: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      phone: true,
      isPrimary: true,
    },
  });

  return locations.map((location) => ({
    location,
    zone: zoneByLocationId.get(location.id) || null,
  })).sort((a, b) => {
    const ao = a.zone?.sortOrder ?? 9999;
    const bo = b.zone?.sortOrder ?? 9999;
    if (ao !== bo) return ao - bo;
    if (a.location.isPrimary !== b.location.isPrimary) return a.location.isPrimary ? -1 : 1;
    return (a.location.name || '').localeCompare(b.location.name || '');
  });
}

async function resolveByPostalCode({ prisma, businessId, postalCode }) {
  const normInput = normalisePostal(postalCode);
  if (!businessId || !normInput) {
    return { postalCode: normInput, candidates: [] };
  }

  const zones = await listActiveZones({ prisma, businessId });
  const matchingZones = zones.filter((zone) => zoneMatchesPostal(zone, normInput));
  const candidates = await resolveCandidatesForZones({ prisma, businessId, matchingZones });
  return { postalCode: normInput, candidates };
}

async function resolveByCoordinates({ prisma, businessId, lat, lng }) {
  const point = normalisePoint({ lat, lng });
  if (!businessId || !point) {
    return { point, candidates: [] };
  }

  const zones = await listActiveZones({ prisma, businessId });
  const matchingZones = zones.filter((zone) => zoneMatchesCoordinates(zone, point));
  const candidates = await resolveCandidatesForZones({ prisma, businessId, matchingZones });
  return { point, candidates };
}

module.exports = {
  normalisePostal,
  normalisePoint,
  normaliseZoneGeometry,
  zoneMatchesPostal,
  zoneMatchesCoordinates,
  isPointInPolygon,
  haversineMeters,
  resolveByPostalCode,
  resolveByCoordinates,
};
