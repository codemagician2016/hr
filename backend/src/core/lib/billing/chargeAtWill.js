//
// chargeAtWill.js — Razorpay "charge-at-will" billing engine (India / UPI Autopay
// + card e-mandate). The alternative to Razorpay Subscriptions: register a
// mandate ONCE with a high max_amount (ceiling), then OUR cron charges the EXACT
// amount each cycle. Plan up/downgrades become an amount change — no re-mandate,
// no "can't update a UPI subscription in place" dead-end.
//
// ⚠️⚠️ DORMANT until RAZORPAY_CHARGE_AT_WILL === 'on'. Everything that moves real
// money (chargeToken, the cron, mandate confirm) is gated by chargeAtWillEnabled()
// AND must be proven in the Razorpay SANDBOX first. Search this file for
// "VERIFY-IN-SANDBOX" — those are the Razorpay-API specifics to confirm against a
// live test mandate before enabling. See docs/RAZORPAY_CHARGE_AT_WILL.md.
//
// Indian recurring rails (RBI/NPCI): a single recurring debit ABOVE ₹15,000
// needs the customer to authenticate THAT debit (AFA); at or below ₹15,000 it is
// silent after a 24h pre-debit notice. So monthly mandates use a ₹15,000 ceiling
// (covers every monthly plan + upgrade, fully silent); annual mandates use the
// annual amount as the ceiling (one customer tap per renewal when > ₹15k).
//
const prisma = require('../prisma');
const { getGateway } = require('./gatewayRouter');
const { recordGatewayPayment } = require('../billingLedger');

const RUPEE_MINOR = 100;
const UPI_AFA_CEILING_MINOR = 15000 * RUPEE_MINOR; // ₹15,000 — silent-debit ceiling
const IN = 'IN';

function chargeAtWillEnabled() {
  return String(process.env.RAZORPAY_CHARGE_AT_WILL || '').toLowerCase() === 'on';
}

function normalizeCycle(c) {
  return String(c || '').toUpperCase() === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
}

// The exact amount to debit for one cycle of `tier` on `billingCycle` (INR minor).
function cycleChargeMinor(tierPrice, billingCycle) {
  if (!tierPrice) return null;
  return normalizeCycle(billingCycle) === 'YEARLY'
    ? Number(tierPrice.amountAnnualMinor)
    : Number(tierPrice.amountMonthlyMinor);
}

// Mandate ceiling (max_amount) to register at authorization.
//  • monthly → ₹15,000 flat: covers every monthly plan + any upgrade, stays
//    silent forever (no per-charge AFA).
//  • annual → the annual amount: the single mandate covers the yearly debit
//    (the customer taps to approve each renewal when it exceeds ₹15k).
function mandateCeilingMinor({ billingCycle, annualAmountMinor } = {}) {
  if (normalizeCycle(billingCycle) === 'YEARLY') {
    return Math.max(Number(annualAmountMinor) || 0, UPI_AFA_CEILING_MINOR);
  }
  return UPI_AFA_CEILING_MINOR;
}

async function razorpayTierPrice(tierId) {
  return prisma.tierPrice.findFirst({ where: { tierId, countryCode: IN } });
}

// Prorated upgrade difference owed NOW = (new − old) × remaining fraction of the
// current period. Returns 0 if not computable or non-positive.
function prorationDiffMinor({ subscription, fromMinor, toMinor, now = new Date() }) {
  const delta = Number(toMinor) - Number(fromMinor);
  if (!(delta > 0)) return 0;
  const end = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  if (!end || end.getTime() <= now.getTime()) return 0;
  const cycleMs = normalizeCycle(subscription?.billingCycle) === 'YEARLY' ? 365 * 864e5 : 30 * 864e5;
  const remaining = Math.min(1, Math.max(0, (end.getTime() - now.getTime()) / cycleMs));
  return Math.round(delta * remaining);
}

function addCycle(date, billingCycle) {
  const d = new Date(date);
  if (normalizeCycle(billingCycle) === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Mandate authorization (sign-up / migration). Returns the order + customer
//    for the frontend Razorpay Checkout.js `recurring:1` flow. The token_id
//    arrives on the auth payment → confirmMandate() persists it.
// ─────────────────────────────────────────────────────────────────────────────
async function startMandateAuth({ business, tier, billingCycle, method = 'upi', subscription }) {
  if (!chargeAtWillEnabled()) { const e = new Error('Charge-at-will is not enabled.'); e.status = 409; throw e; }
  const gw = getGateway('RAZORPAY');
  if (!gw.isConfigured()) { const e = new Error('Razorpay is not configured.'); e.status = 503; throw e; }
  const price = await razorpayTierPrice(tier.id);
  if (!price) { const e = new Error(`No INR price for ${tier.name}.`); e.status = 409; throw e; }

  const firstChargeMinor = cycleChargeMinor(price, billingCycle);
  const ceiling = mandateCeilingMinor({ billingCycle, annualAmountMinor: price.amountAnnualMinor });

  const customer = subscription?.razorpayCustomerId
    ? { id: subscription.razorpayCustomerId }
    : await gw.createCustomer({
        name: business.name || undefined,
        email: business.billingEmail || business.email || undefined,
        contact: business.phone || undefined,
        notes: { businessId: business.id },
      });

  // VERIFY-IN-SANDBOX: order.token{max_amount,frequency} shape for UPI Autopay.
  const order = await gw.createAuthOrder({
    amountMinor: firstChargeMinor,
    currency: price.currencyCode || 'INR',
    method,
    customerId: customer.id,
    maxAmountMinor: ceiling,
    frequency: 'as_presented', // we present a variable amount each cycle
    receipt: `cawauth:${business.id}:${tier.slug}:${normalizeCycle(billingCycle)}`,
    notes: { businessId: business.id, tierSlug: tier.slug, billingCycle: normalizeCycle(billingCycle) },
  });

  // Stash the intent + ceiling; the tier is applied only on confirmMandate.
  await prisma.subscription.update({
    where: { businessId: business.id },
    data: {
      gateway: 'RAZORPAY',
      razorpayCustomerId: customer.id,
      mandateMaxAmount: ceiling,
      mandateMethod: method,
      mandateStatus: 'initiated',
      pendingTierSlug: tier.slug,
      pendingBillingCycle: normalizeCycle(billingCycle),
    },
  });

  return {
    action: 'authorize',
    gateway: 'RAZORPAY',
    orderId: order.id,
    customerId: customer.id,
    amountMinor: firstChargeMinor,
    maxAmountMinor: ceiling,
    currency: price.currencyCode || 'INR',
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    recurring: true,
    message: `Authorize the mandate to activate ${tier.name}.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Confirm the mandate after the customer authorizes (Checkout.js success).
//    Verifies the signature, captures token_id, activates the TOKEN subscription.
// ─────────────────────────────────────────────────────────────────────────────
async function confirmMandate({ businessId, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!chargeAtWillEnabled()) { const e = new Error('Charge-at-will is not enabled.'); e.status = 409; throw e; }
  const crypto = require('crypto');
  const gw = getGateway('RAZORPAY');
  // VERIFY-IN-SANDBOX: signature = HMAC_SHA256(order_id|payment_id, key_secret).
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '')
    .update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
  if (!razorpaySignature || expected !== String(razorpaySignature)) {
    const e = new Error('Mandate signature verification failed.'); e.status = 400; throw e;
  }

  // VERIFY-IN-SANDBOX: payment.token_id is the reusable mandate token on the
  // recurring auth payment.
  const payment = await gw.getPayment(razorpayPaymentId);
  const tokenId = payment?.token_id || payment?.token?.id || null;
  if (!tokenId) { const e = new Error('No mandate token on the authorization payment.'); e.status = 502; throw e; }

  const sub = await prisma.subscription.findUnique({ where: { businessId }, include: { tier: true } });
  const tierSlug = sub?.pendingTierSlug;
  const billingCycle = normalizeCycle(sub?.pendingBillingCycle || sub?.billingCycle);
  const tier = tierSlug ? await prisma.pricingTier.findUnique({ where: { slug: tierSlug } }) : sub?.tier;
  if (!tier) { const e = new Error('No target tier to activate.'); e.status = 409; throw e; }

  const now = new Date();
  const updated = await prisma.subscription.update({
    where: { businessId },
    data: {
      gateway: 'RAZORPAY',
      billingModel: 'TOKEN',
      razorpayTokenId: tokenId,
      mandateStatus: 'confirmed',
      status: 'ACTIVE',
      tierId: tier.id,
      billingCycle,
      activatedAt: sub?.activatedAt || now,
      currentPeriodEnd: addCycle(now, billingCycle),
      nextChargeAt: addCycle(now, billingCycle),
      preDebitNotifiedAt: null,
      pendingTierSlug: null,
      pendingBillingCycle: null,
      pendingChangeEffectiveAt: null,
    },
    include: { tier: true },
  });

  // The auth payment itself is the first cycle's charge — record it.
  if (payment?.amount) {
    await recordGatewayPayment({
      businessId, provider: 'razorpay', gatewayTransactionId: razorpayPaymentId,
      amountMinor: payment.amount, currencyCode: payment.currency || 'INR', status: 'COMPLETED',
      metadata: { kind: 'mandate_auth', tokenId },
    }).catch(() => {});
  }
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Plan change for a TOKEN subscriber — NO gateway plan update (that's the
//    whole point). Upgrade = charge the prorated difference now + flip the tier;
//    downgrade = schedule the lower amount for the next cycle. Eliminates the
//    UPI "can't update in place" dead-end.
// ─────────────────────────────────────────────────────────────────────────────
async function applyTokenPlanChange({ subscription, targetTier, targetBillingCycle, direction, now = new Date() }) {
  if (!chargeAtWillEnabled()) { const e = new Error('Charge-at-will is not enabled.'); e.status = 409; throw e; }
  const billingCycle = normalizeCycle(targetBillingCycle || subscription.billingCycle);
  const targetPrice = await razorpayTierPrice(targetTier.id);
  if (!targetPrice) { const e = new Error(`No INR price for ${targetTier.name}.`); e.status = 409; throw e; }
  const newCycleMinor = cycleChargeMinor(targetPrice, billingCycle);

  // max_amount guard: a charge above the registered ceiling needs a fresh mandate.
  if (Number(newCycleMinor) > Number(subscription.mandateMaxAmount || 0)) {
    return { action: 'reauthorize', reason: 'amount_exceeds_mandate_ceiling',
      message: 'This plan exceeds your authorized mandate limit — please re-authorize a higher mandate.' };
  }

  if (direction === 'downgrade') {
    await prisma.subscription.update({
      where: { businessId: subscription.businessId },
      data: {
        pendingTierSlug: targetTier.slug,
        pendingBillingCycle: billingCycle,
        pendingChangeEffectiveAt: subscription.currentPeriodEnd || addCycle(now, billingCycle),
      },
    });
    return { action: 'scheduled', effectiveAt: subscription.currentPeriodEnd,
      message: `${targetTier.name} starts at your next renewal — you'll be charged the lower amount then.` };
  }

  // Upgrade (or same-rank): charge the prorated difference now, flip the tier
  // immediately. Next cycle charges the new full amount.
  const currentPrice = subscription.tierId ? await razorpayTierPrice(subscription.tierId) : null;
  const fromMinor = currentPrice ? cycleChargeMinor(currentPrice, subscription.billingCycle) : 0;
  const diff = prorationDiffMinor({ subscription, fromMinor, toMinor: newCycleMinor, now });

  if (diff > 0) {
    if (diff > Number(subscription.mandateMaxAmount || 0)) {
      return { action: 'reauthorize', reason: 'proration_exceeds_mandate_ceiling',
        message: 'The upgrade charge exceeds your mandate limit — please re-authorize.' };
    }
    const gw = getGateway('RAZORPAY');
    // VERIFY-IN-SANDBOX: recurring charge on the saved token for the diff.
    const { payment } = await gw.chargeToken({
      customerId: subscription.razorpayCustomerId,
      tokenId: subscription.razorpayTokenId,
      amountMinor: diff,
      currency: targetPrice.currencyCode || 'INR',
      receipt: `cawup:${subscription.businessId}:${targetTier.slug}:${now.toISOString().slice(0, 10)}`,
      description: `Upgrade to ${targetTier.name} (prorated)`,
      notes: { businessId: subscription.businessId, kind: 'upgrade_proration' },
    });
    await recordGatewayPayment({
      businessId: subscription.businessId, provider: 'razorpay',
      gatewayTransactionId: payment?.id || `caw_up_${Date.now()}`,
      amountMinor: diff, currencyCode: targetPrice.currencyCode || 'INR', status: 'COMPLETED',
      metadata: { kind: 'upgrade_proration', tier: targetTier.slug },
    }).catch(() => {});
  }

  const updated = await prisma.subscription.update({
    where: { businessId: subscription.businessId },
    data: {
      tierId: targetTier.id,
      billingCycle,
      pendingTierSlug: null, pendingBillingCycle: null, pendingChangeEffectiveAt: null,
    },
    include: { tier: true },
  });
  return { action: 'updated', subscription: updated,
    message: diff > 0
      ? `Upgraded to ${targetTier.name}. We charged the prorated difference now; the full amount applies next cycle.`
      : `Updated to ${targetTier.name}.` };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The self-billing cron. Two-phase per due sub: pre-debit notify (≥24h ahead
//    for UPI) → charge the exact current amount. Atomic claim, idempotent,
//    max_amount-guarded, dunning on failure. Runs ONLY when the flag is on.
// ─────────────────────────────────────────────────────────────────────────────
const PRE_DEBIT_LEAD_MS = 24 * 60 * 60 * 1000;

async function alreadyChargedThisCycle(businessId, cycleKey) {
  // Idempotency backstop: a COMPLETED attempt tagged with this cycle key means
  // the charge already went through (DB update may have failed mid-way).
  const existing = await prisma.paymentAttempt.findFirst({
    where: { businessId, status: 'COMPLETED', metadata: { path: ['cycleKey'], equals: cycleKey } },
  }).catch(() => null);
  return Boolean(existing);
}

async function chargeDueTokenSubscriptions({ now = new Date() } = {}) {
  if (!chargeAtWillEnabled()) return { skipped: 'disabled' };
  const gw = getGateway('RAZORPAY');
  if (!gw.isConfigured()) return { skipped: 'not_configured' };

  const due = await prisma.subscription.findMany({
    where: {
      gateway: 'RAZORPAY', billingModel: 'TOKEN', mandateStatus: 'confirmed',
      razorpayTokenId: { not: null },
      status: { in: ['ACTIVE', 'PAST_DUE'] },
      nextChargeAt: { not: null, lte: new Date(now.getTime() + PRE_DEBIT_LEAD_MS + 60 * 60 * 1000) },
    },
    include: { tier: true },
    take: 200,
  });

  let charged = 0, notified = 0, failed = 0, reauth = 0;
  for (const sub of due) {
    try {
      const chargeAt = new Date(sub.nextChargeAt);
      // Phase 1 — pre-debit notification (UPI) ≥24h before the charge.
      const needNotice = sub.mandateMethod === 'upi';
      if (needNotice && !sub.preDebitNotifiedAt && chargeAt.getTime() - now.getTime() > 0) {
        // VERIFY-IN-SANDBOX: Razorpay UPI Autopay pre-debit notification API.
        // (Until wired, we just stamp the notice timestamp so the 24h gate holds.)
        await prisma.subscription.update({ where: { businessId: sub.businessId }, data: { preDebitNotifiedAt: now } });
        notified++;
        continue;
      }
      // Don't charge before the due time, or before the notice window elapsed.
      if (chargeAt.getTime() > now.getTime()) continue;
      if (needNotice && sub.preDebitNotifiedAt && now.getTime() - new Date(sub.preDebitNotifiedAt).getTime() < PRE_DEBIT_LEAD_MS) continue;

      // Apply a due downgrade before computing the amount.
      let tier = sub.tier;
      let billingCycle = normalizeCycle(sub.billingCycle);
      if (sub.pendingTierSlug && sub.pendingChangeEffectiveAt && new Date(sub.pendingChangeEffectiveAt).getTime() <= now.getTime()) {
        const pendingTier = await prisma.pricingTier.findUnique({ where: { slug: sub.pendingTierSlug } });
        if (pendingTier) { tier = pendingTier; billingCycle = normalizeCycle(sub.pendingBillingCycle || billingCycle); }
      }
      const price = await razorpayTierPrice(tier.id);
      const amountMinor = cycleChargeMinor(price, billingCycle);
      if (!(amountMinor > 0)) continue;

      // max_amount guard.
      if (amountMinor > Number(sub.mandateMaxAmount || 0)) {
        await prisma.subscription.update({ where: { businessId: sub.businessId }, data: { mandateStatus: 'reauth_required' } });
        reauth++;
        continue;
      }

      const cycleKey = `${sub.businessId}:${chargeAt.toISOString().slice(0, 10)}`;
      if (await alreadyChargedThisCycle(sub.businessId, cycleKey)) {
        // Already paid — just advance the clock.
        await prisma.subscription.update({
          where: { businessId: sub.businessId },
          data: { currentPeriodEnd: addCycle(chargeAt, billingCycle), nextChargeAt: addCycle(chargeAt, billingCycle), preDebitNotifiedAt: null },
        });
        continue;
      }

      // Atomic claim: only one worker advances lastChargeAttemptAt for this tick.
      const claim = await prisma.subscription.updateMany({
        where: { businessId: sub.businessId, nextChargeAt: sub.nextChargeAt },
        data: { lastChargeAttemptAt: now },
      });
      if (claim.count !== 1) continue; // someone else claimed it

      // Phase 2 — charge. VERIFY-IN-SANDBOX: chargeToken response shape.
      const { payment } = await gw.chargeToken({
        customerId: sub.razorpayCustomerId, tokenId: sub.razorpayTokenId,
        amountMinor, currency: price.currencyCode || 'INR',
        receipt: `caw:${cycleKey}`, description: `${tier.name} (${billingCycle.toLowerCase()})`,
        notes: { businessId: sub.businessId, cycleKey, tier: tier.slug },
      });
      await recordGatewayPayment({
        businessId: sub.businessId, provider: 'razorpay',
        gatewayTransactionId: payment?.id || `caw_${cycleKey}`,
        amountMinor, currencyCode: price.currencyCode || 'INR', status: 'COMPLETED',
        metadata: { kind: 'recurring', cycleKey, tier: tier.slug },
      });
      await prisma.subscription.update({
        where: { businessId: sub.businessId },
        data: {
          status: 'ACTIVE', tierId: tier.id, billingCycle,
          currentPeriodEnd: addCycle(chargeAt, billingCycle),
          nextChargeAt: addCycle(chargeAt, billingCycle),
          preDebitNotifiedAt: null, pastDueSince: null, accessGraceUntil: null,
          ...(sub.pendingTierSlug ? { pendingTierSlug: null, pendingBillingCycle: null, pendingChangeEffectiveAt: null } : {}),
        },
      });
      charged++;
    } catch (err) {
      failed++;
      // Dunning: mark PAST_DUE with a grace window; the existing
      // expirePastDueGraceSubscriptions cron downgrades on grace expiry.
      await prisma.subscription.update({
        where: { businessId: sub.businessId },
        data: {
          status: 'PAST_DUE',
          pastDueSince: sub.pastDueSince || now,
          accessGraceUntil: sub.accessGraceUntil || new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
        },
      }).catch(() => {});
      console.error(`[chargeAtWill] charge failed for ${sub.businessId}:`, err.message);
    }
  }
  return { charged, notified, failed, reauth, scanned: due.length };
}

module.exports = {
  chargeAtWillEnabled,
  cycleChargeMinor,
  mandateCeilingMinor,
  prorationDiffMinor,
  startMandateAuth,
  confirmMandate,
  applyTokenPlanChange,
  chargeDueTokenSubscriptions,
  UPI_AFA_CEILING_MINOR,
};
