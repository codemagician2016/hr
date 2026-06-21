const prisma = require('./prisma');
const {
  PRICING_REFERENCE_VERSION,
  ZONES,
  COUNTRIES,
} = require('./pricingReferenceData');

const PRICING_REFERENCE_VERSION_KEY = '_internal.pricing_reference_version';

let syncPromise = null;
let hasSynced = false;

async function syncPricingReferenceData() {
  const versionRow = await prisma.systemSetting.findUnique({
    where: { key: PRICING_REFERENCE_VERSION_KEY },
  });
  if (versionRow?.value === PRICING_REFERENCE_VERSION) {
    hasSynced = true;
    return false;
  }

  await prisma.$transaction(async (tx) => {
    for (const zone of ZONES) {
      await tx.pricingZone.upsert({
        where: { slug: zone.slug },
        update: {
          name: zone.name,
          multiplier: zone.multiplier,
          sortOrder: zone.sortOrder,
          isActive: true,
        },
        create: {
          slug: zone.slug,
          name: zone.name,
          multiplier: zone.multiplier,
          sortOrder: zone.sortOrder,
        },
      });
    }

    const zonesBySlug = Object.fromEntries(
      (await tx.pricingZone.findMany({
        select: { id: true, slug: true },
      })).map((zone) => [zone.slug, zone.id]),
    );

    for (const [code, name, region, currencyCode, currencySymbol, zoneSlug] of COUNTRIES) {
      const existing = await tx.countryZoneAssignment.findUnique({
        where: { countryCode: code },
        select: { id: true, isOverride: true },
      });

      if (existing) {
        await tx.countryZoneAssignment.update({
          where: { id: existing.id },
          data: {
            countryName: name,
            region,
            currencyCode,
            currencySymbol,
            ...(existing.isOverride ? {} : { zoneId: zonesBySlug[zoneSlug] }),
          },
        });
      } else {
        await tx.countryZoneAssignment.create({
          data: {
            countryCode: code,
            countryName: name,
            region,
            currencyCode,
            currencySymbol,
            zoneId: zonesBySlug[zoneSlug],
            isOverride: false,
          },
        });
      }
    }
    await tx.systemSetting.upsert({
      where: { key: PRICING_REFERENCE_VERSION_KEY },
      update: { value: PRICING_REFERENCE_VERSION },
      create: {
        key: PRICING_REFERENCE_VERSION_KEY,
        value: PRICING_REFERENCE_VERSION,
      },
    });
  });

  hasSynced = true;
  return true;
}

async function ensurePricingReferenceData() {
  if (hasSynced) return false;

  if (!syncPromise) {
    syncPromise = syncPricingReferenceData()
      .catch((err) => {
        syncPromise = null;
        throw err;
      })
      .then((result) => {
        syncPromise = null;
        return result;
      });
  }

  return syncPromise;
}

module.exports = {
  ensurePricingReferenceData,
};
