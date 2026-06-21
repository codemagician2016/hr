#!/usr/bin/env node
/*
 * READ-ONLY subscription/deletion diagnostic.
 *
 * Usage (run on the box, where DATABASE_URL + Paddle keys live):
 *   node scripts/diagnose-subscription.js <slug>      # default: ecom8
 *
 * Prints the local Business + Subscription state, the recent account-deletion
 * audit trail, and — if the sub sits on Paddle — the LIVE gateway status, then
 * a verdict on whether the subscription is resumable or needs a fresh checkout.
 * It writes NOTHING. Built to diagnose the "cancellation emails after undo
 * delete" case (e.g. ecom8): pre-fix, delete cancelled the gateway sub
 * IMMEDIATELY, so an undo could not un-cancel it.
 */

const prisma = require('../src/core/lib/prisma');

async function main() {
  const slug = (process.argv[2] || 'ecom8').trim();
  console.log(`\n=== Subscription diagnostic for slug "${slug}" ===\n`);

  const business = await prisma.business.findUnique({
    where: { slug },
    select: {
      id: true, slug: true, name: true, vertical: true, country: true,
      isActive: true, pendingDeletionAt: true, anonymisedAt: true, createdAt: true,
    },
  });
  if (!business) {
    console.log(`No business found for slug "${slug}".`);
    return;
  }
  console.log('BUSINESS');
  console.table([{
    id: business.id, name: business.name, vertical: business.vertical,
    isActive: business.isActive,
    pendingDeletionAt: business.pendingDeletionAt,
    anonymisedAt: business.anonymisedAt,
  }]);

  const sub = await prisma.subscription.findUnique({ where: { businessId: business.id } });
  if (!sub) {
    console.log('\nNo Subscription row.');
  } else {
    console.log('\nSUBSCRIPTION (local)');
    console.table([{
      gateway: sub.gateway, status: sub.status,
      tier: sub.tierId, pendingTierSlug: sub.pendingTierSlug,
      currentPeriodEnd: sub.currentPeriodEnd,
      pendingChangeEffectiveAt: sub.pendingChangeEffectiveAt,
      paddle: sub.paddleSubscriptionId, stripe: sub.stripeSubscriptionId, razorpay: sub.razorpaySubscriptionId,
    }]);
  }

  const audit = await prisma.accountAuditLog.findMany({
    where: { targetType: 'BUSINESS', targetId: business.id },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { eventType: true, createdAt: true, reason: true, payload: true },
  });
  console.log('\nDELETION AUDIT TRAIL (most recent 10)');
  if (!audit.length) console.log('  (none)');
  for (const a of audit) {
    console.log(`  ${a.createdAt.toISOString()}  ${a.eventType}${a.reason ? `  reason=${a.reason}` : ''}`);
  }

  // Live gateway truth (Paddle only — Stripe/Razorpay would need their SDKs).
  if (sub?.gateway === 'PADDLE' && sub.paddleSubscriptionId) {
    console.log('\nPADDLE (live gateway status)');
    try {
      const { getPaddleSubscription } = require('../src/core/lib/paddle');
      const live = await getPaddleSubscription(sub.paddleSubscriptionId);
      const d = live?.data || live;
      console.table([{
        id: d?.id, status: d?.status,
        scheduled_change: d?.scheduled_change ? JSON.stringify(d.scheduled_change) : null,
        next_billed_at: d?.next_billed_at, canceled_at: d?.canceled_at,
      }]);
      verdict(sub, d);
    } catch (err) {
      console.log(`  Could not fetch live Paddle status: ${err.message}`);
    }
  } else if (sub) {
    console.log(`\n(Live gateway check only implemented for Paddle; this sub is on ${sub.gateway}.)`);
  }

  console.log('');
}

function verdict(sub, paddleData) {
  const status = String(paddleData?.status || '').toLowerCase();
  const scheduled = paddleData?.scheduled_change;
  console.log('\nVERDICT');
  if (status === 'active' && scheduled?.action === 'cancel') {
    console.log('  Scheduled to cancel at period end → RESUMABLE (clear scheduled_change). The new');
    console.log('  undo flow handles this automatically.');
  } else if (status === 'active') {
    console.log('  Active, no scheduled cancel → already healthy. The cancel emails should stop once');
    console.log('  the local row reflects ACTIVE (re-sync if it shows CANCELLED).');
  } else if (status === 'canceled') {
    console.log('  HARD CANCELLED at Paddle → NOT resumable. This is the pre-fix ecom8 case (delete');
    console.log('  cancelled immediately). Remediation: the owner must re-subscribe (fresh checkout),');
    console.log('  or comp them a new subscription. The new code prevents this going forward by');
    console.log('  cancelling at period-end instead.');
  } else {
    console.log(`  Paddle status="${status}" — inspect manually.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
