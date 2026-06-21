#!/usr/bin/env node
/*
 * Backfill Business.shortId for every business missing one. Idempotent — safe
 * to re-run; only touches rows where shortId IS NULL. Run after the
 * 20260613170000_business_short_id migration:
 *   node -r dotenv/config scripts/backfill-business-short-id.js
 */
const prisma = require('../src/core/lib/prisma');
const { generateUniqueBusinessShortId } = require('../src/core/lib/businessShortId');

async function main() {
  const missing = await prisma.business.findMany({
    where: { shortId: null },
    select: { id: true, name: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`businesses missing shortId: ${missing.length}`);
  for (const b of missing) {
    const shortId = await generateUniqueBusinessShortId();
    await prisma.business.update({ where: { id: b.id }, data: { shortId } });
    console.log(`  ${b.slug} (${b.name}) -> ${shortId}`);
  }
  console.log('backfill done');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
