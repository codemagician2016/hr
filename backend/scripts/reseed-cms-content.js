#!/usr/bin/env node
// One-shot reseeder for existing tenants. CMS Services + Team became
// decoupled from booking-side Service[] / User[]: every business now
// renders its homepage from BusinessContent.cmsServices / cmsTeam JSON.
// Pre-decouple tenants have null in those columns, which means the
// storefront falls through to profession-default content. Running this
// fills both columns with the seeded 3 starter cards (Initial / Follow-up
// / Quick chat) + 3 placeholder team members so the homepage looks
// complete out of the box.
//
// Usage:
//   node backend/scripts/reseed-cms-content.js            # only fill where null
//   node backend/scripts/reseed-cms-content.js --force    # overwrite existing CMS content too

const prisma = require('../src/lib/prisma');
const { seedDefaultCmsContent } = require('../src/lib/defaultServices');

async function main() {
  const force = process.argv.includes('--force');
  const businesses = await prisma.business.findMany({
    select: { id: true, name: true, country: true },
  });
  console.log(`[reseed-cms] ${businesses.length} businesses to process (force=${force})`);

  let filled = 0;
  let skipped = 0;
  for (const b of businesses) {
    if (force) {
      await prisma.businessContent.updateMany({
        where: { businessId: b.id },
        data: { cmsServices: null, cmsTeam: null },
      });
    }
    await seedDefaultCmsContent(b.id, b.country);
    const after = await prisma.businessContent.findUnique({
      where: { businessId: b.id },
      select: { cmsServices: true, cmsTeam: true },
    });
    if (after?.cmsServices && after?.cmsTeam) filled++;
    else skipped++;
    console.log(`  · ${b.name || b.id}: cmsServices=${after?.cmsServices ? 'ok' : 'empty'}, cmsTeam=${after?.cmsTeam ? 'ok' : 'empty'}`);
  }
  console.log(`[reseed-cms] done. filled=${filled}, skipped=${skipped}`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
