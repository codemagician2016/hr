/* eslint-disable no-console */
//
// applyRenewalGrace.js — one-time transition for the renew-gate rollout.
//
// When the launch-free promo ends, tenants who selected a PAID tier during the
// promo are `status: ACTIVE` with NO Paddle subscription — so the renew-gate
// (billingAccess.js) would stop them IMMEDIATELY. This grants them a grace
// window (default 7 days) by stamping `accessGraceUntil`, so they get a heads-up
// to renew before their site is gated.
//
// We deliberately DO NOT flip them to PAST_DUE — the dunning scheduler downgrades
// PAST_DUE subs to the free tier, but the owner wants a renew-gate, not a silent
// downgrade. Keeping status ACTIVE + a future accessGraceUntil yields `grace`
// now → `needs_renewal` after it lapses, untouched by the scheduler.
//
// Usage:  node scripts/applyRenewalGrace.js            (apply)
//         GRACE_DAYS=7 node scripts/applyRenewalGrace.js
//         DRY_RUN=1 node scripts/applyRenewalGrace.js   (preview only)

const { PrismaClient } = require('@prisma/client');
const { isPaidTier } = require('../src/core/lib/featuresCatalog');

const prisma = new PrismaClient();
const GRACE_DAYS = Number(process.env.GRACE_DAYS || 7);
const DRY = String(process.env.DRY_RUN || '') === '1';

async function main() {
  const now = new Date();
  const graceUntil = new Date(now.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);

  const subs = await prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      paddleSubscriptionId: null,
    },
    select: {
      id: true, businessId: true, status: true, accessGraceUntil: true,
      tier: { select: { slug: true } },
      business: { select: { slug: true, name: true } },
    },
  });

  const targets = subs.filter((s) =>
    isPaidTier(s.tier?.slug)
    && !(s.accessGraceUntil && new Date(s.accessGraceUntil).getTime() > now.getTime()));

  console.log(`renew-grace: ${targets.length} paid-tier free-granted tenant(s) → grace until ${graceUntil.toISOString()} (DRY_RUN=${DRY ? 'yes' : 'no'})`);
  for (const s of targets) {
    console.log(`  ${s.business?.slug} (${s.business?.name}) tier=${s.tier?.slug}`);
    if (!DRY) {
      await prisma.subscription.update({
        where: { id: s.id },
        data: { accessGraceUntil: graceUntil, pastDueSince: now },
      });
    }
  }
  console.log(DRY ? 'DRY_RUN — nothing written.' : 'done.');
}

main().catch((e) => { console.error('applyRenewalGrace failed:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
