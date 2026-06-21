// Budget engine — the heart of the messaging quota system.
//
// Computes customer-visible slot counts from three inputs:
//   1. tier_price_usd          — the tenant's plan price (after geo-IP zoning)
//   2. messagingBudgetPercent  — the super-admin-tunable knob (per tier)
//   3. per_country_provider_cost — from ProviderPriceCache (refreshed daily)
//
// Formula:
//   budget_usd        = tier_price_usd × messagingBudgetPercent / 100
//   sms_slots         = floor(budget_usd / sms_cost_for_country)
//   wa_slots          = floor(budget_usd / wa_utility_cost_for_country)
//
// Customer never sees the dollar budget — only the resulting slot counts.
// Slots share a budget — sending one SMS reduces the WhatsApp count
// proportionally. This is the "shared wallet" UX the user designed.
//
// At send time we deduct *actual* provider cost from BudgetUsage, so the
// counter reflects real economics (e.g., a Bangladesh recipient drains the
// budget at a different rate than a US recipient — both honest).
'use strict';

const { PrismaClient } = require('@prisma/client');
const { CHANNELS, getCostOrFallback } = require('./priceCache');

const prisma = new PrismaClient();

// 'YYYY-MM' string for the current calendar month (UTC). Cycle resets
// happen automatically because we key BudgetUsage rows by (business, cycle).
function getCurrentCycle(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Fetch the budget percentage that applies to a business this cycle.
// Priority:
//   1. NotificationConfig.budgetOverridePercent (super-admin per-tenant override)
//   2. PricingTier.messagingBudgetPercent (per-tier default)
//   3. 0% (email-only)
async function getBudgetPercent(businessId) {
  const sub = await prisma.subscription.findUnique({
    where: { businessId },
    include: { tier: true },
  });
  if (!sub?.tier) return 0;

  const config = await prisma.notificationConfig.findUnique({
    where: { businessId },
  });
  if (config?.budgetOverridePercent != null) {
    return Number(config.budgetOverridePercent);
  }
  return Number(sub.tier.messagingBudgetPercent || 0);
}

// Fetch the tier's plan price in USD for a tenant. Reads the tenant's
// country (from Business.country) and the matching TierPrice row, falling
// back to the base USD price if no country override exists.
//
// Returns { monthlyUsd, currencyCode } where monthlyUsd is the price
// CONVERTED to USD (so the budget engine speaks one currency end-to-end).
//
// Conversion rates: stored in the priceCache logic — we use a small static
// map for the major currencies. Production accuracy isn't critical because
// the result feeds slot-count display (off by 5% → ~5% slot variance, fine).
const FX_TO_USD = Object.freeze({
  USD: 1,
  CAD: 0.74, EUR: 1.07, GBP: 1.27, AUD: 0.66, NZD: 0.61,
  INR: 0.012, BRL: 0.20, MXN: 0.058, JPY: 0.0066, KRW: 0.00074,
  IDR: 0.000064, PHP: 0.018, THB: 0.029, VND: 0.000040, MYR: 0.22,
  SGD: 0.74, HKD: 0.13, TWD: 0.031, AED: 0.27, SAR: 0.27, ILS: 0.27,
  EGP: 0.020, ZAR: 0.054, NGN: 0.00066, KES: 0.0078, GHS: 0.067,
  TRY: 0.029, PKR: 0.0036, BDT: 0.0093, LKR: 0.0033, NPR: 0.0075,
  PLN: 0.25, SEK: 0.094, NOK: 0.092, DKK: 0.144, CHF: 1.13,
  HUF: 0.0027, CZK: 0.043, RON: 0.21, ARS: 0.0011, COP: 0.00024,
  CLP: 0.0011, PEN: 0.27, UYU: 0.025,
});

async function getTierPriceUsd(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { country: true },
  });
  const sub = await prisma.subscription.findUnique({
    where: { businessId },
    include: {
      tier: {
        include: {
          prices: true,
        },
      },
    },
  });
  if (!sub?.tier) return { monthlyUsd: 0, currencyCode: 'USD' };

  // Per-country override first; otherwise base USD (countryCode=null).
  const country = (business?.country || '').toUpperCase();
  const override = sub.tier.prices.find((p) => (p.countryCode || '').toUpperCase() === country);
  const base = sub.tier.prices.find((p) => !p.countryCode);

  const row = override || base;
  if (!row) return { monthlyUsd: 0, currencyCode: 'USD' };

  const monthlyMinor = Number(row.amountMonthlyMinor || 0);
  const currency = row.currencyCode || 'USD';
  const fx = FX_TO_USD[currency.toUpperCase()] ?? 1;
  // Most currencies have 2 decimal places; we store minor units (1/100).
  // Zero-decimal currencies (JPY, KRW, etc.) are stored as whole units.
  const ZERO_DEC = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'COP', 'IDR', 'PYG', 'UGX', 'RWF']);
  const monthlyMajor = ZERO_DEC.has(currency.toUpperCase()) ? monthlyMinor : monthlyMinor / 100;
  const monthlyUsd = monthlyMajor * fx;

  return { monthlyUsd, currencyCode: currency };
}

// Compute the USD budget for the current cycle for a given business.
// budget = tier_price_usd × budgetPercent / 100 + overage_purchased_this_cycle
async function computeBudgetUsd(businessId) {
  const [{ monthlyUsd }, percent, usage] = await Promise.all([
    getTierPriceUsd(businessId),
    getBudgetPercent(businessId),
    getOrCreateUsage(businessId),
  ]);
  const baseBudget = monthlyUsd * percent / 100;
  const overage = Number(usage.overagePurchasedUsd || 0);
  return baseBudget + overage;
}

// Compute slot counts for a tenant given the recipient country (often the
// same as tenant's country, but can differ for international customers).
// Returns { sms, whatsappUtility, smsCost, whatsappCost, budgetUsd, source }.
//
// Slot count = floor(remaining_budget / per_message_cost). We cap at the
// "starting" slot count (computed from the full budget, not the current
// remaining) so the customer-visible cap stays stable across the month.
async function computeSlotCounts(businessId, recipientCountry) {
  const country = String(recipientCountry || '').toUpperCase();
  const [budget, smsCost, waCost, usage] = await Promise.all([
    computeBudgetUsd(businessId),
    getCostOrFallback(country, CHANNELS.SMS),
    getCostOrFallback(country, CHANNELS.WHATSAPP_UTILITY),
    getOrCreateUsage(businessId),
  ]);

  if (budget <= 0) {
    return {
      sms: 0,
      whatsappUtility: 0,
      smsCost: smsCost,
      whatsappCost: waCost,
      budgetUsd: 0,
      remainingUsd: 0,
      country,
      smsAvailable: false,
      whatsappAvailable: false,
    };
  }

  const spent = Number(usage.smsSpentUsd || 0) + Number(usage.whatsappSpentUsd || 0);
  const remaining = Math.max(0, budget - spent);

  // Display caps: max possible at start of cycle (so the dashboard shows
  // "X of Y" with a stable Y). Cost null = channel unavailable in country.
  const smsStart = smsCost ? Math.floor(budget / smsCost) : 0;
  const waStart = waCost ? Math.floor(budget / waCost) : 0;
  const smsRemaining = smsCost ? Math.floor(remaining / smsCost) : 0;
  const waRemaining = waCost ? Math.floor(remaining / waCost) : 0;

  return {
    sms: smsRemaining,
    smsTotal: smsStart,
    whatsappUtility: waRemaining,
    whatsappUtilityTotal: waStart,
    smsCost,
    whatsappCost: waCost,
    budgetUsd: budget,
    remainingUsd: remaining,
    spentUsd: spent,
    country,
    // Hide the channel from UX if the slot count would be < 10/cycle —
    // not enough to be useful, suggest WhatsApp / Email instead.
    smsAvailable: !!smsCost && smsStart >= 10,
    whatsappAvailable: !!waCost && waStart >= 10,
  };
}

// Get or initialise the BudgetUsage row for the current cycle. Idempotent.
async function getOrCreateUsage(businessId, cycle = getCurrentCycle()) {
  const existing = await prisma.budgetUsage.findUnique({
    where: { businessId_cycle: { businessId, cycle } },
  });
  if (existing) return existing;
  return prisma.budgetUsage.create({
    data: {
      businessId,
      cycle,
      smsSpentUsd: 0,
      whatsappSpentUsd: 0,
      smsCount: 0,
      whatsappCount: 0,
      overagePurchasedUsd: 0,
    },
  });
}

// Record a successful send: deduct cost from budget, increment counter.
// Called by the smart router after the provider confirms send (or fails;
// failed sends still count if they reached the provider, since we still pay).
async function recordSpend({ businessId, channel, costUsd, cycle = getCurrentCycle() }) {
  const isSms = channel === CHANNELS.SMS;
  const isWa = channel?.startsWith?.('WHATSAPP');

  // Atomic upsert + increment. Prisma's upsert+update isn't atomic so we
  // wrap in a transaction.
  return prisma.$transaction(async (tx) => {
    const row = await tx.budgetUsage.upsert({
      where: { businessId_cycle: { businessId, cycle } },
      update: {},
      create: {
        businessId,
        cycle,
        smsSpentUsd: 0,
        whatsappSpentUsd: 0,
        smsCount: 0,
        whatsappCount: 0,
        overagePurchasedUsd: 0,
      },
    });
    return tx.budgetUsage.update({
      where: { id: row.id },
      data: {
        smsSpentUsd:      isSms ? { increment: costUsd } : undefined,
        smsCount:         isSms ? { increment: 1 }       : undefined,
        whatsappSpentUsd: isWa  ? { increment: costUsd } : undefined,
        whatsappCount:    isWa  ? { increment: 1 }       : undefined,
      },
    });
  });
}

// Add an overage pack to the current cycle's budget. This low-level helper
// should only be called after a payment has been confirmed by Paddle webhook.
async function addOveragePurchase({ businessId, amountUsd, cycle = getCurrentCycle() }) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.budgetUsage.upsert({
      where: { businessId_cycle: { businessId, cycle } },
      update: {},
      create: {
        businessId,
        cycle,
        smsSpentUsd: 0,
        whatsappSpentUsd: 0,
        smsCount: 0,
        whatsappCount: 0,
        overagePurchasedUsd: 0,
      },
    });
    return tx.budgetUsage.update({
      where: { id: row.id },
      data: { overagePurchasedUsd: { increment: amountUsd } },
    });
  });
}

// Idempotent overage grant for Paddle-paid top-ups. The grant row is created
// before the budget increment; its unique Paddle transaction ID prevents a
// retried or duplicated transaction.completed webhook from double-crediting.
async function addOveragePurchaseOnce({
  businessId,
  amountUsd,
  cycle = getCurrentCycle(),
  paddleTransactionId,
  purchaseId = null,
  metadata = {},
} = {}) {
  const amount = Number(amountUsd);
  if (!businessId) throw new Error('addOveragePurchaseOnce: businessId is required');
  if (!paddleTransactionId) throw new Error('addOveragePurchaseOnce: paddleTransactionId is required');
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('addOveragePurchaseOnce: amountUsd must be a positive number');
  }

  const existing = await prisma.messagingTopupGrant?.findUnique({
    where: { paddleTransactionId },
  }).catch(() => null);
  if (existing) return { granted: false, grant: existing, usage: null };

  try {
    return await prisma.$transaction(async (tx) => {
      if (!tx.messagingTopupGrant) {
        throw new Error('Messaging top-up grant ledger is not available. Run Prisma migrations and regenerate the client.');
      }

      const grant = await tx.messagingTopupGrant.create({
        data: {
          businessId,
          purchaseId,
          cycle,
          amountUsd: amount,
          currencyCode: 'USD',
          paddleTransactionId,
          metadata,
        },
      });

      const row = await tx.budgetUsage.upsert({
        where: { businessId_cycle: { businessId, cycle } },
        update: {},
        create: {
          businessId,
          cycle,
          smsSpentUsd: 0,
          whatsappSpentUsd: 0,
          smsCount: 0,
          whatsappCount: 0,
          overagePurchasedUsd: 0,
        },
      });

      const usage = await tx.budgetUsage.update({
        where: { id: row.id },
        data: { overagePurchasedUsd: { increment: amount } },
      });

      return { granted: true, grant, usage };
    });
  } catch (err) {
    if (err?.code === 'P2002') {
      const grant = await prisma.messagingTopupGrant.findUnique({
        where: { paddleTransactionId },
      });
      return { granted: false, grant, usage: null };
    }
    throw err;
  }
}

// Pre-send check: would this send go over budget? Returns
//   { allowed: true }                                   — go ahead
//   { allowed: false, reason: 'OVER_BUDGET' }           — block + trigger quotaExhaustedAction
//   { allowed: false, reason: 'CHANNEL_UNAVAILABLE' }   — block, country isn't supported
//
// Caller (smart router) decides what to do based on quotaExhaustedAction:
//   PAUSE → return failure to user, send falls back to email
//   STOP  → return failure, no fallback
async function checkBudget({ businessId, channel, recipientCountry }) {
  const country = String(recipientCountry || '').toUpperCase();
  const cost = await getCostOrFallback(country, channel);
  if (!cost && cost !== 0) return { allowed: false, reason: 'CHANNEL_UNAVAILABLE' };

  const [budget, usage] = await Promise.all([
    computeBudgetUsd(businessId),
    getOrCreateUsage(businessId),
  ]);
  const spent = Number(usage.smsSpentUsd || 0) + Number(usage.whatsappSpentUsd || 0);
  if (spent + cost > budget) {
    return { allowed: false, reason: 'OVER_BUDGET', cost, budget, spent };
  }
  return { allowed: true, cost, budget, spent, remaining: budget - spent };
}

// =============================================================================
// Pure helpers (no DB/IO) — exposed for unit tests.
// =============================================================================

const ZERO_DEC_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'COP', 'IDR', 'PYG', 'UGX', 'RWF',
]);

// Convert (amountInMinor, currency) → USD float.
function convertToUsd(amountMinor, currencyCode) {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return 0;
  const code = String(currencyCode || 'USD').toUpperCase();
  const fx = FX_TO_USD[code];
  if (fx == null) return 0;
  const major = ZERO_DEC_CURRENCIES.has(code) ? amountMinor : amountMinor / 100;
  return major * fx;
}

// Compute slot counts from budget + costs + spent. Pure math; no DB.
//   budget       — USD budget for the cycle
//   smsCost      — USD cost per SMS in recipient country (null = unsupported)
//   waCost       — USD cost per WhatsApp utility message
//   spent        — USD already drawn from this cycle's budget
//   minSlotsFloor — counts below this hide the channel from UX (default 10)
function deriveSlotCounts({ budget, smsCost, waCost, spent = 0, minSlotsFloor = 10 }) {
  const safeBudget = Math.max(0, Number(budget) || 0);
  const safeSpent = Math.max(0, Number(spent) || 0);
  // Round remaining to nearest cent (1e-2 precision) to avoid JS float
  // edge cases like $4 - $2.2 producing 1.7999...8 which would wrongly
  // floor to 44 SMS instead of 45. Real-money math operates in cents.
  const remainingRaw = safeBudget - safeSpent;
  const remaining = Math.max(0, Math.round(remainingRaw * 100) / 100);

  const smsStart = smsCost ? Math.floor(safeBudget / smsCost) : 0;
  const waStart = waCost ? Math.floor(safeBudget / waCost) : 0;
  const smsRemaining = smsCost ? Math.floor(remaining / smsCost) : 0;
  const waRemaining = waCost ? Math.floor(remaining / waCost) : 0;

  return {
    sms: smsRemaining,
    smsTotal: smsStart,
    whatsappUtility: waRemaining,
    whatsappUtilityTotal: waStart,
    smsCost,
    whatsappCost: waCost,
    budgetUsd: safeBudget,
    remainingUsd: remaining,
    spentUsd: safeSpent,
    smsAvailable: !!smsCost && smsStart >= minSlotsFloor,
    whatsappAvailable: !!waCost && waStart >= minSlotsFloor,
  };
}

module.exports = {
  getCurrentCycle,
  getBudgetPercent,
  getTierPriceUsd,
  computeBudgetUsd,
  computeSlotCounts,
  getOrCreateUsage,
  recordSpend,
  addOveragePurchase,
  addOveragePurchaseOnce,
  checkBudget,
  // pure helpers (testable without DB)
  FX_TO_USD,
  ZERO_DEC_CURRENCIES,
  convertToUsd,
  deriveSlotCounts,
};
