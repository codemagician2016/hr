#!/usr/bin/env node
// Local multi-store test setup for an ecommerce tenant.
// Usage: node scripts/setup-ecom-multistore-test.js [slug] [mode]
//   slug default: shop-test
//   mode default: CHAIN (use FULFILLMENT to test Shopify-style)

require('dotenv').config();
if (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('Appoint@2024Secure@')) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace('Appoint@2024Secure@', 'Appoint%402024Secure@');
}
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const slug = process.argv[2] || 'shop-test';
const mode = (process.argv[3] || 'CHAIN').toUpperCase();

const STORE_FIXTURES = [
  {
    key: 'borough',
    name: 'Main Store - Borough Market',
    addressLine1: '21 Borough Market',
    city: 'London',
    state: 'England',
    postalCode: 'SE1 9AB',
    country: 'GB',
    phone: '+442071234567',
    isPrimary: true,
    codePrefix: 'BOR',
    stockBase: 70,
    priceDelta: 0,
  },
  {
    key: 'canary',
    name: 'Canary Wharf Store',
    addressLine1: '12 Canada Square',
    city: 'London',
    state: 'England',
    postalCode: 'E14 5AB',
    country: 'GB',
    phone: '+442071234568',
    isPrimary: false,
    codePrefix: 'CAN',
    stockBase: 36,
    priceDelta: 25,
  },
  {
    key: 'wembley',
    name: 'Wembley Grocery Store',
    addressLine1: '88 High Road',
    city: 'London',
    state: 'England',
    postalCode: 'HA9 7BN',
    country: 'GB',
    phone: '+442071234569',
    isPrimary: false,
    codePrefix: 'WEM',
    stockBase: 18,
    priceDelta: -15,
  },
];

const SLOT_FIXTURES = [
  { startTime: '08:00', endTime: '11:00', capacity: 20, slotType: 'SAME_DAY', surchargeMinor: 0 },
  { startTime: '12:00', endTime: '15:00', capacity: 18, slotType: 'STANDARD', surchargeMinor: 0 },
  { startTime: '17:00', endTime: '20:00', capacity: 12, slotType: 'EXPRESS', surchargeMinor: 199 },
];

const dayHours = {
  0: null,
  1: { open: '08:00', close: '21:00' },
  2: { open: '08:00', close: '21:00' },
  3: { open: '08:00', close: '21:00' },
  4: { open: '08:00', close: '21:00' },
  5: { open: '08:00', close: '22:00' },
  6: { open: '09:00', close: '22:00' },
};

async function upsertLocation(businessId, store) {
  const existing = await prisma.businessLocation.findFirst({
    where: { businessId, name: store.name },
  });
  const data = {
    businessId,
    name: store.name,
    addressLine1: store.addressLine1,
    city: store.city,
    state: store.state,
    postalCode: store.postalCode,
    country: store.country,
    phone: store.phone,
    isActive: true,
    isPrimary: store.isPrimary,
  };
  if (existing) {
    return prisma.businessLocation.update({ where: { id: existing.id }, data });
  }
  return prisma.businessLocation.create({ data });
}

async function main() {
  if (!['CHAIN', 'FULFILLMENT', 'OFF'].includes(mode)) {
    throw new Error('Mode must be CHAIN, FULFILLMENT, or OFF');
  }

  const business = await prisma.business.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true },
  });
  if (!business) throw new Error(`Business not found for slug "${slug}"`);

  await prisma.business.update({
    where: { id: business.id },
    data: {
      multiStoreMode: mode,
      vertical: 'ECOMMERCE',
      defaultCurrency: 'GBP',
      country: 'GB',
    },
  });

  const locations = [];
  for (const store of STORE_FIXTURES) {
    const location = await upsertLocation(business.id, store);
    locations.push({ ...store, id: location.id });
  }
  await prisma.businessLocation.updateMany({
    where: { businessId: business.id, id: { notIn: locations.map((location) => location.id) } },
    data: { isActive: false, isPrimary: false },
  });
  await prisma.businessLocation.updateMany({
    where: { businessId: business.id, id: { in: locations.filter((location) => !location.isPrimary).map((location) => location.id) } },
    data: { isPrimary: false },
  });

  const products = await prisma.product.findMany({
    where: { businessId: business.id, isPublished: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    take: 24,
    select: { id: true, name: true, slug: true, sku: true, priceMinor: true },
  });
  if (products.length === 0) {
    throw new Error('No published products found. Seed products first, then rerun this script.');
  }

  for (const [storeIndex, location] of locations.entries()) {
    for (const [productIndex, product] of products.entries()) {
      const aisle = `A${(productIndex % 6) + 1}`;
      const rack = `R${Math.floor(productIndex / 6) + 1}`;
      const shelf = `S${(storeIndex % 3) + 1}`;
      const onHand = Math.max(0, location.stockBase + ((productIndex * 7 + storeIndex * 11) % 42) - (productIndex % 5 === 0 ? 20 : 0));
      const supplierSku = `${location.codePrefix}-SUP-${String(productIndex + 1).padStart(3, '0')}`;
      const localPickCode = `${location.codePrefix}-${String(productIndex + 1).padStart(4, '0')}`;

      const stock = await prisma.inventoryStock.upsert({
        where: { productId_locationId: { productId: product.id, locationId: location.id } },
        create: {
          businessId: business.id,
          productId: product.id,
          locationId: location.id,
          onHand,
          reserved: 0,
          reorderPoint: 10,
          reorderQty: 40,
          unitCostMinor: Math.max(1, Math.round(product.priceMinor * 0.62)),
          supplierSku,
          localPickCode,
          aisleCode: aisle,
          rackCode: rack,
          shelfCode: shelf,
          binLocation: `${aisle} / ${rack} / ${shelf}`,
        },
        update: {
          onHand,
          reorderPoint: 10,
          reorderQty: 40,
          unitCostMinor: Math.max(1, Math.round(product.priceMinor * 0.62)),
          supplierSku,
          localPickCode,
          aisleCode: aisle,
          rackCode: rack,
          shelfCode: shelf,
          binLocation: `${aisle} / ${rack} / ${shelf}`,
        },
      });

      const adjustmentCount = await prisma.inventoryAdjustment.count({
        where: { stockId: stock.id, sourceType: 'LOCAL_MULTI_STORE_SEED' },
      });
      if (adjustmentCount === 0) {
        await prisma.inventoryAdjustment.create({
          data: {
            businessId: business.id,
            stockId: stock.id,
            delta: onHand,
            reason: 'GRN_RECEIPT',
            note: `Initial multi-store stock for ${location.name}`,
            sourceType: 'LOCAL_MULTI_STORE_SEED',
            sourceId: `${location.key}:${product.slug}`,
            onHandAfter: onHand,
          },
        });
      }

      const hiddenInWembley = location.key === 'wembley' && productIndex % 7 === 0;
      await prisma.productLocationOverride.upsert({
        where: { productId_locationId: { productId: product.id, locationId: location.id } },
        create: {
          businessId: business.id,
          productId: product.id,
          locationId: location.id,
          priceMinor: product.priceMinor + location.priceDelta,
          comparePriceMinor: null,
          isAvailable: !hiddenInWembley,
        },
        update: {
          priceMinor: product.priceMinor + location.priceDelta,
          isAvailable: !hiddenInWembley,
        },
      });
    }

    await prisma.ecomPickupLocation.upsert({
      where: { id: `local-pickup-${location.key}` },
      create: {
        id: `local-pickup-${location.key}`,
        businessId: business.id,
        locationId: location.id,
        name: `${location.name} Pickup Counter`,
        addressLine1: location.addressLine1,
        city: location.city,
        region: location.state,
        postalCode: location.postalCode,
        countryCode: location.country,
        contactPhone: location.phone,
        contactEmail: 'pickup@example.com',
        hours: dayHours,
        prepTimeMinutes: location.key === 'borough' ? 20 : 35,
        pickupInstructions: 'Bring your order number and collect from the customer service counter.',
        isActive: true,
        sortOrder: storeIndex,
      },
      update: {
        locationId: location.id,
        name: `${location.name} Pickup Counter`,
        addressLine1: location.addressLine1,
        city: location.city,
        region: location.state,
        postalCode: location.postalCode,
        countryCode: location.country,
        contactPhone: location.phone,
        hours: dayHours,
        isActive: true,
      },
    });

    for (const dayOfWeek of [1, 2, 3, 4, 5, 6]) {
      for (const slot of SLOT_FIXTURES) {
        const existing = await prisma.ecomDeliverySlot.findFirst({
          where: {
            businessId: business.id,
            locationId: location.id,
            dayOfWeek,
            startTime: slot.startTime,
            endTime: slot.endTime,
          },
          select: { id: true },
        });
        const data = {
          businessId: business.id,
          locationId: location.id,
          dayOfWeek,
          startTime: slot.startTime,
          endTime: slot.endTime,
          capacity: slot.capacity,
          slotType: slot.slotType,
          surchargeMinor: slot.surchargeMinor,
          isActive: true,
          notes: `${location.name} ${slot.slotType.toLowerCase()} slot`,
        };
        if (existing) await prisma.ecomDeliverySlot.update({ where: { id: existing.id }, data });
        else await prisma.ecomDeliverySlot.create({ data });
      }
    }
  }

  console.log(`Configured ${business.name} (${business.slug}) for ${mode}`);
  console.log(`Locations: ${locations.map((l) => l.name).join(', ')}`);
  console.log(`Products stocked per location: ${products.length}`);
  console.log('Test notes: Borough has deepest stock, Canary has slightly higher prices, Wembley has lower prices and a few unavailable products.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
