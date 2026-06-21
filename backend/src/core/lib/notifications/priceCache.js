// Price cache repository — read/write to ProviderPriceCache table.
// Daily cron refreshes from Twilio API + MSG91 manual config. Slot-count
// calculator and audit log read here at runtime.
//
// Channel string values match what the schema expects:
//   'SMS'                   — generic SMS via the country's preferred provider
//   'WHATSAPP_UTILITY'      — WA template messages (booking reminders, etc.)
//   'WHATSAPP_AUTHENTICATION' — WA OTP (cheapest category)
//   'WHATSAPP_MARKETING'    — WA promotional (most expensive)
//   'WHATSAPP_SERVICE'      — WA customer-initiated (free in 24h window)
'use strict';

const { PrismaClient } = require('@prisma/client');
const { getRate, getAllFallbackRates } = require('./twilioPricing');
const { listCountries } = require('./countryRouting');

const prisma = new PrismaClient();

const CHANNELS = Object.freeze({
  SMS: 'SMS',
  WHATSAPP_UTILITY: 'WHATSAPP_UTILITY',
  WHATSAPP_AUTHENTICATION: 'WHATSAPP_AUTHENTICATION',
  WHATSAPP_MARKETING: 'WHATSAPP_MARKETING',
  WHATSAPP_SERVICE: 'WHATSAPP_SERVICE',
});

// Read cached cost for a (country, channel). Returns null if not cached or
// the row was marked unavailable. Most callers should use getCostOrFallback
// which falls back to the hardcoded table when cache is empty.
async function getCachedCost(countryCode, channel) {
  if (!countryCode || !channel) return null;
  const row = await prisma.providerPriceCache.findUnique({
    where: {
      countryCode_channel: {
        countryCode: countryCode.toUpperCase(),
        channel,
      },
    },
  });
  if (!row || !row.isAvailable) return null;
  return Number(row.providerCostUsd);
}

// Read cached cost or fall back to the hardcoded reference table. Always
// returns a number > 0 for a country we route to; null only for completely
// unsupported countries.
async function getCostOrFallback(countryCode, channel) {
  const cached = await getCachedCost(countryCode, channel);
  if (cached !== null) return cached;

  const fallback = getAllFallbackRates()[countryCode?.toUpperCase()];
  if (!fallback) return null;
  if (channel === CHANNELS.SMS) return fallback.sms ?? null;
  if (channel === CHANNELS.WHATSAPP_UTILITY) return fallback.whatsappUtility ?? null;
  // Other WA categories priced relative to utility:
  if (channel === CHANNELS.WHATSAPP_AUTHENTICATION) return (fallback.whatsappUtility ?? 0) * 0.5;
  if (channel === CHANNELS.WHATSAPP_MARKETING) return (fallback.whatsappUtility ?? 0) * 3;
  if (channel === CHANNELS.WHATSAPP_SERVICE) return 0; // free in 24h customer-initiated window
  return null;
}

// Upsert a single price row. Idempotent.
async function upsertPrice({ countryCode, channel, providerCostUsd, source }) {
  return prisma.providerPriceCache.upsert({
    where: {
      countryCode_channel: {
        countryCode: countryCode.toUpperCase(),
        channel,
      },
    },
    update: {
      providerCostUsd,
      source,
      isAvailable: providerCostUsd > 0,
      lastRefreshedAt: new Date(),
    },
    create: {
      countryCode: countryCode.toUpperCase(),
      channel,
      providerCostUsd,
      source,
      isAvailable: providerCostUsd > 0,
      lastRefreshedAt: new Date(),
    },
  });
}

// Daily refresh job — called by the cron. For each country in our routing
// table: fetch live rate (or fall back), upsert SMS + WhatsApp variants.
// Returns a summary of what changed.
async function refreshAllPrices({ logger = console } = {}) {
  const countries = listCountries();
  let updated = 0;
  let failed = 0;
  let unchanged = 0;
  const usedFallback = [];

  for (const country of countries) {
    try {
      const rate = await getRate(country);
      if (!rate) {
        failed++;
        logger.warn?.(`[priceCache] no rate for ${country}`);
        continue;
      }

      const before = await getCachedCost(country, CHANNELS.SMS);
      await upsertPrice({
        countryCode: country,
        channel: CHANNELS.SMS,
        providerCostUsd: rate.sms,
        source: rate.source,
      });

      // WhatsApp utility (the rate that drives most reminder traffic)
      await upsertPrice({
        countryCode: country,
        channel: CHANNELS.WHATSAPP_UTILITY,
        providerCostUsd: rate.whatsappUtility,
        source: rate.source,
      });

      // Derived WA categories (Authentication = ½ utility, Marketing = 3× utility)
      // Stored explicitly so admin price overrides work uniformly.
      await upsertPrice({
        countryCode: country,
        channel: CHANNELS.WHATSAPP_AUTHENTICATION,
        providerCostUsd: rate.whatsappUtility * 0.5,
        source: rate.source,
      });
      await upsertPrice({
        countryCode: country,
        channel: CHANNELS.WHATSAPP_MARKETING,
        providerCostUsd: rate.whatsappUtility * 3,
        source: rate.source,
      });
      await upsertPrice({
        countryCode: country,
        channel: CHANNELS.WHATSAPP_SERVICE,
        providerCostUsd: 0, // customer-initiated 24h window — free
        source: rate.source,
      });

      if (before === rate.sms) unchanged++;
      else updated++;
      if (rate.source.includes('FALLBACK')) usedFallback.push(country);
    } catch (err) {
      failed++;
      logger.error?.(`[priceCache] ${country}: ${err.message}`);
    }
  }

  return { totalCountries: countries.length, updated, unchanged, failed, usedFallback };
}

module.exports = {
  CHANNELS,
  getCachedCost,
  getCostOrFallback,
  upsertPrice,
  refreshAllPrices,
};
