const { STARTER_DOMAIN_PRICING } = require('./pricing');
const { resolveRegistrarForTld } = require('./routing');

function starterPricingRows(now = new Date()) {
  return Object.entries(STARTER_DOMAIN_PRICING).map(([tld, price]) => ({
    tld,
    registrar: resolveRegistrarForTld(tld).registrar,
    wholesaleMinor: price.wholesaleMinor,
    retailMinor: price.retailMinor,
    renewalWholesaleMinor: price.renewalWholesaleMinor || null,
    renewalRetailMinor: price.renewalRetailMinor || price.retailMinor,
    currency: price.currency,
    isAvailable: true,
    requiresTrustee: Boolean(price.requiresTrustee),
    notes: price.notes || null,
    updatedAt: now,
  }));
}

async function syncDomainPricing({ prisma, rows = starterPricingRows() } = {}) {
  if (!prisma) {
    const err = new Error('syncDomainPricing requires a Prisma client.');
    err.code = 'PRISMA_REQUIRED';
    throw err;
  }

  for (const row of rows) {
    await prisma.domainPricing.upsert({
      where: { tld: row.tld },
      create: row,
      update: {
        registrar: row.registrar,
        wholesaleMinor: row.wholesaleMinor,
        retailMinor: row.retailMinor,
        renewalWholesaleMinor: row.renewalWholesaleMinor,
        renewalRetailMinor: row.renewalRetailMinor,
        currency: row.currency,
        isAvailable: row.isAvailable,
        requiresTrustee: row.requiresTrustee,
        notes: row.notes,
      },
    });
  }

  return { synced: rows.length };
}

module.exports = {
  starterPricingRows,
  syncDomainPricing,
};
