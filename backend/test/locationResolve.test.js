// Unit tests for backend/src/core/lib/locationResolve.js
// (Multi-store Flow A — pincode → serving stores.)
// All Prisma calls are mocked so the suite stays fast and DB-free.

const {
  normalisePostal,
  normalisePoint,
  normaliseZoneGeometry,
  zoneMatchesPostal,
  zoneMatchesCoordinates,
  isPointInPolygon,
  haversineMeters,
  resolveByPostalCode,
  resolveByCoordinates,
} = require('../src/core/lib/locationResolve');

describe('normalisePostal', () => {
  test('uppercases and strips internal spaces', () => {
    expect(normalisePostal('ec1v 9hx')).toBe('EC1V9HX');
    expect(normalisePostal(' n1   1aa ')).toBe('N11AA');
  });
  test('passes IN-style pincodes through unchanged', () => {
    expect(normalisePostal('400001')).toBe('400001');
  });
  test('handles non-strings gracefully', () => {
    expect(normalisePostal(null)).toBe('');
    expect(normalisePostal(undefined)).toBe('');
    expect(normalisePostal(400001)).toBe('');
  });
});

describe('zoneMatchesPostal', () => {
  test('returns true when the array contains the normalised code', () => {
    const zone = { postcodes: ['EC1V 9HX', 'N1 1AA'] };
    expect(zoneMatchesPostal(zone, 'EC1V9HX')).toBe(true);
  });
  test('returns false when nothing matches', () => {
    expect(zoneMatchesPostal({ postcodes: ['400002'] }, '400001')).toBe(false);
  });
  test('handles missing / non-array postcodes', () => {
    expect(zoneMatchesPostal({}, '400001')).toBe(false);
    expect(zoneMatchesPostal({ postcodes: null }, '400001')).toBe(false);
  });
});

describe('coordinate geometry helpers', () => {
  const square = [
    [77.00, 28.00],
    [77.10, 28.00],
    [77.10, 28.10],
    [77.00, 28.10],
  ];

  test('normalisePoint accepts lat/lng or latitude/longitude', () => {
    expect(normalisePoint({ lat: '28.05', lng: '77.05' })).toEqual({ lat: 28.05, lng: 77.05 });
    expect(normalisePoint({ latitude: 28.05, longitude: 77.05 })).toEqual({ lat: 28.05, lng: 77.05 });
    expect(normalisePoint({ lat: 120, lng: 77.05 })).toBeNull();
  });

  test('normaliseZoneGeometry accepts polygon and radius shapes', () => {
    expect(normaliseZoneGeometry({ type: 'polygon', coordinates: square })).toEqual({ type: 'polygon', coordinates: square });
    expect(normaliseZoneGeometry({ type: 'Polygon', coordinates: [square] })).toEqual({ type: 'polygon', coordinates: square });
    expect(normaliseZoneGeometry({ type: 'radius', center: { lat: 28.05, lng: 77.05 }, radiusMeters: '1500' })).toEqual({
      type: 'radius',
      center: { lat: 28.05, lng: 77.05 },
      radiusMeters: 1500,
    });
  });

  test('point-in-polygon includes inside and boundary, excludes outside', () => {
    expect(isPointInPolygon({ lat: 28.05, lng: 77.05 }, square)).toBe(true);
    expect(isPointInPolygon({ lat: 28.00, lng: 77.05 }, square)).toBe(true);
    expect(isPointInPolygon({ lat: 28.20, lng: 77.05 }, square)).toBe(false);
  });

  test('radius matching uses metres around the center', () => {
    const zone = {
      polygon: {
        type: 'radius',
        center: { lat: 28.6139, lng: 77.2090 },
        radiusMeters: 2000,
      },
    };
    expect(zoneMatchesCoordinates(zone, { lat: 28.6150, lng: 77.2100 })).toBe(true);
    expect(zoneMatchesCoordinates(zone, { lat: 28.7000, lng: 77.3000 })).toBe(false);
    expect(haversineMeters({ lat: 28.6139, lng: 77.2090 }, { lat: 28.6139, lng: 77.2090 })).toBe(0);
  });

  test('zoneMatchesCoordinates supports raw polygon arrays for backward compatibility', () => {
    expect(zoneMatchesCoordinates({ polygon: square }, { lat: 28.05, lng: 77.05 })).toBe(true);
  });
});

describe('resolveByPostalCode', () => {
  function makePrisma({ zones = [], cities = [], locations = [] } = {}) {
    return {
      ecomDeliveryZone: {
        findMany: jest.fn().mockResolvedValue(zones),
      },
      ecomServiceCity: {
        findMany: jest.fn().mockResolvedValue(cities),
      },
      businessLocation: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          if (where?.id?.in) {
            return Promise.resolve(locations.filter((l) => where.id.in.includes(l.id)));
          }
          return Promise.resolve(locations);
        }),
      },
    };
  }

  test('returns empty candidates when postalCode is blank', async () => {
    const prisma = makePrisma();
    const out = await resolveByPostalCode({ prisma, businessId: 'biz', postalCode: '' });
    expect(out).toEqual({ postalCode: '', candidates: [] });
    expect(prisma.ecomDeliveryZone.findMany).not.toHaveBeenCalled();
  });

  test('returns empty candidates when businessId missing', async () => {
    const prisma = makePrisma();
    const out = await resolveByPostalCode({ prisma, businessId: null, postalCode: '400001' });
    expect(out.candidates).toEqual([]);
  });

  test('pinned single store: returns that store', async () => {
    const prisma = makePrisma({
      zones: [{ id: 'z1', name: 'Andheri W', slug: 'andheri-w', cityId: 'c1', primaryLocationId: 'loc-a', postcodes: ['400053'], sortOrder: 0, deliveryFeeMinor: 0, freeDeliveryThresholdMinor: 0 }],
      locations: [{ id: 'loc-a', name: 'Andheri', isPrimary: true, city: 'Mumbai' }],
    });
    const out = await resolveByPostalCode({ prisma, businessId: 'biz', postalCode: '400053' });
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].location.id).toBe('loc-a');
    expect(out.candidates[0].zone.id).toBe('z1');
  });

  test('returns no candidates when no zone matches', async () => {
    const prisma = makePrisma({
      zones: [{ id: 'z1', name: 'Andheri', cityId: 'c1', primaryLocationId: 'loc-a', postcodes: ['400053'], sortOrder: 0 }],
      locations: [{ id: 'loc-a', name: 'Andheri', isPrimary: true, city: 'Mumbai' }],
    });
    const out = await resolveByPostalCode({ prisma, businessId: 'biz', postalCode: '999999' });
    expect(out.candidates).toEqual([]);
  });

  test('multiple pinned stores sorted by zone.sortOrder then isPrimary', async () => {
    const prisma = makePrisma({
      zones: [
        { id: 'z2', name: 'Zone B', slug: 'b', cityId: 'c1', primaryLocationId: 'loc-b', postcodes: ['400001'], sortOrder: 10 },
        { id: 'z1', name: 'Zone A', slug: 'a', cityId: 'c1', primaryLocationId: 'loc-a', postcodes: ['400001'], sortOrder: 5 },
      ],
      locations: [
        { id: 'loc-a', name: 'Store A', isPrimary: false, city: 'Mumbai' },
        { id: 'loc-b', name: 'Store B', isPrimary: true,  city: 'Mumbai' },
      ],
    });
    const out = await resolveByPostalCode({ prisma, businessId: 'biz', postalCode: '400001' });
    expect(out.candidates.map((c) => c.location.id)).toEqual(['loc-a', 'loc-b']);
  });

  test('city pool: zone without primaryLocationId yields all active locations in the city', async () => {
    const prisma = makePrisma({
      zones: [{ id: 'z1', name: 'City Pool', slug: 'pool', cityId: 'c1', primaryLocationId: null, postcodes: ['400001'], sortOrder: 0 }],
      cities: [{ id: 'c1', slug: 'mumbai', name: 'Mumbai' }],
      locations: [
        { id: 'loc-1', name: 'Bandra',   isPrimary: true,  city: 'Mumbai' },
        { id: 'loc-2', name: 'Andheri',  isPrimary: false, city: 'mumbai' },
        { id: 'loc-3', name: 'Pune Hub', isPrimary: false, city: 'Pune' },
      ],
    });
    const out = await resolveByPostalCode({ prisma, businessId: 'biz', postalCode: '400001' });
    const ids = out.candidates.map((c) => c.location.id);
    expect(ids).toContain('loc-1');
    expect(ids).toContain('loc-2');
    expect(ids).not.toContain('loc-3');
    expect(ids[0]).toBe('loc-1'); // primary first within same sortOrder
  });

  test('whitespace + case normalisation matches UK-style codes', async () => {
    const prisma = makePrisma({
      zones: [{ id: 'z1', name: 'EC1V', slug: 'ec1v', cityId: 'c1', primaryLocationId: 'loc-a', postcodes: ['EC1V 9HX'], sortOrder: 0 }],
      locations: [{ id: 'loc-a', name: 'London City', isPrimary: true, city: 'London' }],
    });
    const out = await resolveByPostalCode({ prisma, businessId: 'biz', postalCode: 'ec1v9hx' });
    expect(out.postalCode).toBe('EC1V9HX');
    expect(out.candidates).toHaveLength(1);
  });

  test('dedupes when a location is referenced by both a pinned zone and a city pool zone', async () => {
    const prisma = makePrisma({
      zones: [
        { id: 'z1', name: 'Pinned', slug: 'p', cityId: 'c1', primaryLocationId: 'loc-a', postcodes: ['400001'], sortOrder: 0 },
        { id: 'z2', name: 'Pool',   slug: 'q', cityId: 'c1', primaryLocationId: null,    postcodes: ['400001'], sortOrder: 5 },
      ],
      cities: [{ id: 'c1', slug: 'mumbai', name: 'Mumbai' }],
      locations: [{ id: 'loc-a', name: 'Andheri', isPrimary: false, city: 'Mumbai' }],
    });
    const out = await resolveByPostalCode({ prisma, businessId: 'biz', postalCode: '400001' });
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].location.id).toBe('loc-a');
  });

  test('skips inactive city pools (no fallback)', async () => {
    const prisma = makePrisma({
      zones: [{ id: 'z1', name: 'Pool', slug: 'q', cityId: 'c-dead', primaryLocationId: null, postcodes: ['400001'], sortOrder: 0 }],
      cities: [], // findMany returns nothing for inactive cities
      locations: [{ id: 'loc-x', name: 'Test', isPrimary: false, city: 'Mumbai' }],
    });
    const out = await resolveByPostalCode({ prisma, businessId: 'biz', postalCode: '400001' });
    expect(out.candidates).toEqual([]);
  });
});

describe('resolveByCoordinates', () => {
  function makePrisma({ zones = [], cities = [], locations = [] } = {}) {
    return {
      ecomDeliveryZone: {
        findMany: jest.fn().mockResolvedValue(zones),
      },
      ecomServiceCity: {
        findMany: jest.fn().mockResolvedValue(cities),
      },
      businessLocation: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          if (where?.id?.in) {
            return Promise.resolve(locations.filter((l) => where.id.in.includes(l.id)));
          }
          return Promise.resolve(locations);
        }),
      },
    };
  }

  test('returns empty candidates when coordinates are invalid', async () => {
    const prisma = makePrisma();
    const out = await resolveByCoordinates({ prisma, businessId: 'biz', lat: 'abc', lng: 77 });
    expect(out).toEqual({ point: null, candidates: [] });
    expect(prisma.ecomDeliveryZone.findMany).not.toHaveBeenCalled();
  });

  test('pinned polygon zone returns its delivery branch', async () => {
    const prisma = makePrisma({
      zones: [{
        id: 'z-map',
        name: 'Map zone',
        slug: 'map-zone',
        cityId: 'c1',
        primaryLocationId: 'loc-a',
        postcodes: [],
        polygon: {
          type: 'polygon',
          coordinates: [
            [77.00, 28.00],
            [77.10, 28.00],
            [77.10, 28.10],
            [77.00, 28.10],
          ],
        },
        sortOrder: 0,
        deliveryFeeMinor: 0,
        freeDeliveryThresholdMinor: 0,
      }],
      locations: [{ id: 'loc-a', name: 'Map Branch', isPrimary: true, city: 'Delhi' }],
    });

    const out = await resolveByCoordinates({ prisma, businessId: 'biz', lat: 28.05, lng: 77.05 });
    expect(out.point).toEqual({ lat: 28.05, lng: 77.05 });
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].location.id).toBe('loc-a');
    expect(out.candidates[0].zone.id).toBe('z-map');
  });

  test('radius zone returns no candidates outside coverage', async () => {
    const prisma = makePrisma({
      zones: [{
        id: 'z-radius',
        name: 'Radius zone',
        slug: 'radius-zone',
        cityId: 'c1',
        primaryLocationId: 'loc-a',
        polygon: { type: 'radius', center: { lat: 28.6139, lng: 77.2090 }, radiusMeters: 1000 },
        sortOrder: 0,
      }],
      locations: [{ id: 'loc-a', name: 'Central', isPrimary: true, city: 'Delhi' }],
    });

    const out = await resolveByCoordinates({ prisma, businessId: 'biz', lat: 28.70, lng: 77.30 });
    expect(out.candidates).toEqual([]);
  });
});
