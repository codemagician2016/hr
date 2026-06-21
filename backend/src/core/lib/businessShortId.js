// businessShortId.js — human-friendly 8-digit business codes.
//
// The uuid `Business.id` is unusable for humans (read it out, type it into a
// coupon's business-restriction field, etc.). `Business.shortId` is a unique
// 8-digit numeric string assigned on create and backfilled for existing rows.
// Nullable in the schema so the column adds cleanly; coupon matching treats a
// null shortId as "no match" rather than erroring.

const prisma = require('./prisma');

// Random 8-digit code in [10000000, 99999999] — 90M-wide space, so collisions
// are vanishingly rare; retry a handful of times anyway to be safe.
async function generateUniqueBusinessShortId(client = prisma, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const candidate = String(Math.floor(10000000 + Math.random() * 90000000));
    const existing = await client.business.findUnique({
      where: { shortId: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }
  throw new Error('Could not allocate a unique business short id after retries');
}

// Idempotent: returns the existing shortId or assigns + persists a new one.
async function ensureBusinessShortId(businessId, client = prisma) {
  const biz = await client.business.findUnique({
    where: { id: businessId },
    select: { shortId: true },
  });
  if (biz?.shortId) return biz.shortId;
  const shortId = await generateUniqueBusinessShortId(client);
  await client.business.update({ where: { id: businessId }, data: { shortId } });
  return shortId;
}

module.exports = { generateUniqueBusinessShortId, ensureBusinessShortId };
