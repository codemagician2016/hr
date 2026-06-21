// Schemas for the business-admin endpoints. Setup is the one that
// onboarding hits to create / update the Business row; validators for
// hours and holidays live in hours.schema.js, leave in leave.schema.js.

const { z } = require('zod');
const { SUPPORTED_LOCALES } = require('../../../i18n/translator');

const reviewLinkSchema = z
  .string()
  .trim()
  .max(500, 'Review link must be 500 characters or less')
  .refine((v) => v === '' || /^https?:\/\//i.test(v), {
    message: 'Review link must start with http:// or https://',
  })
  .transform((v) => v || '')
  .optional()
  .nullable();

const setupBusinessSchema = z.object({
  name: z
    .string({ required_error: 'Business name is required' })
    .trim()
    .min(1, 'Business name is required')
    .max(120, 'Business name must be 120 characters or less'),
  slug: z.string().trim().max(80).optional().nullable(),
  description: z.string().max(500, 'Description must be 500 characters or less').optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  state: z.string().max(120).optional().nullable(),
  country: z.string().trim().toUpperCase().max(2).optional().nullable(),
  timezone: z.string().trim().max(80).optional().nullable(),
  // phone + email get their own validators inside the controller because
  // they share rules with signup (validatePhone / validateSignupEmail
  // including the disposable-email block). Schema only ensures strings.
  phone: z.string().max(80).optional().nullable(),
  email: z.string().max(200).optional().nullable(),
  // Billing contact name + tax id collected on the same onboarding step.
  // Mirrored into the billing profile (billingContactName / billingTaxId)
  // so the Billing & Plan page shows the same details. Both optional.
  contactName: z.string().max(160).optional().nullable(),
  taxId: z.string().max(80).optional().nullable(),
  // Structured address parts from the country-aware address block (the single
  // `address` field is line 1). Mirrored into the billing profile too.
  addressLine2: z.string().max(240).optional().nullable(),
  city: z.string().max(120).optional().nullable(),
  postalCode: z.string().max(40).optional().nullable(),
  category: z.string().max(80).optional().nullable(),
  // Profession key from the SECTORS taxonomy in lib/professions.js.
  // Onboarding picks this via cascading sector → profession dropdowns;
  // server uses it to derive the recommended vertical when the client
  // doesn't supply one. Legacy free-text categories without a matching
  // key still work — the field is optional + we don't enforce taxonomy
  // membership at schema level (controller does the lookup).
  profession: z.string().max(80).optional().nullable(),
  // Theme key picked from THEME_CATALOG (availableThemes.js). Controller
  // uses it for theme-aware CMS seeding so the storefront ships with
  // on-brand services/team out of the box. Optional — without it, the
  // controller falls back to deriving theme from profession.
  theme: z.string().max(80).optional().nullable(),
  bookingType: z.enum(['PREPAID', 'POSTPAID']).optional(),
  reviewRequestEnabled: z.coerce.boolean().optional(),
  reviewRequestLink: reviewLinkSchema,
  // When true, new bookings land as CONFIRMED instead of PENDING. Off
  // by default; admins opt in from Settings → Bookings.
  autoConfirmBookings: z.coerce.boolean().optional(),
  // Tenant's "house language" — used as fallback when a visitor hasn't
  // picked a language yet. Empty string clears the preference.
  defaultLanguage: z
    .union([z.enum(SUPPORTED_LOCALES), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v === '' ? null : v)),
  // Product vertical the business is configured for. Drives admin nav
  // filtering + storefront layout. Optional in setup payload — defaults
  // to APPOINTMENT (current product) for any tenant that doesn't pick
  // explicitly. Onboarding wizard step 1 will set this going forward.
  vertical: z
    .enum(['STATIC', 'APPOINTMENT', 'ECOMMERCE'])
    .optional(),
  // Default currency (ISO 4217) the admin's new-product form pre-fills.
  // Empty / null clears back to "follow the platform default".
  defaultCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .max(3)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
});

// PATCH /api/business/settings — partial update for the few free-form
// settings that don't have their own dedicated endpoint. Empty string +
// null both clear the value back to "no preference".
const updateBusinessSettingsSchema = z.object({
  defaultLanguage: z
    .union([z.enum(SUPPORTED_LOCALES), z.literal(''), z.null()])
    .optional()
    .transform((v) => (v === '' ? null : v)),
  defaultCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .max(3)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null)),
  // ECOMMERCE storefront UX settings
  announcementBarEnabled: z.boolean().optional(),
  announcementBarText: z.string().max(500).optional().nullable(),
  announcementBarBgColor: z.string().max(20).optional(),
  announcementBarTextColor: z.string().max(20).optional(),
  wishlistEnabled: z.boolean().optional(),
  wishlistIconType: z.enum(['bookmark', 'heart']).optional(),
  categoryGridDisplay: z.enum(['main', 'sub', 'leaf']).optional(),
  // ECOMMERCE 3-level category feature (Phase 0508). Lower bound = 1
  // (flat catalog, no nesting), upper = 5 (reserved for higher tiers
  // later). Default in DB is 2. Backend categoryDepth.js enforces
  // every create/move against this cap.
  categoryMaxDepth: z.number().int().min(1).max(5).optional(),
  // Payment-mode policy (admin-controlled). The storefront only renders
  // allowed methods; checkout enforces the rule too.
  paymentMode: z.enum(['BOTH', 'COD_ONLY', 'PREPAID_ONLY']).optional(),
  // Click & Collect master switch — when false, storefront hides the
  // pickup option even if pickup locations exist.
  pickupEnabled: z.boolean().optional(),
  // ECOMMERCE multi-store / multi-region mode (2026-05-12). Controls how
  // the storefront resolves the shopper's delivery context.
  //   OFF         = single-location, no LocationPrompt
  //   FULFILLMENT = single storefront with admin-managed fulfillment locations
  //   CHAIN       = Pak'nSave-style; shopper picks a physical store
  //   REGIONAL    = Shopify-Markets-style; shopper picks a region
  //   BOTH        = region first, store within region
  multiStoreMode: z.enum(['OFF', 'FULFILLMENT', 'CHAIN', 'REGIONAL', 'BOTH']).optional(),
  // Home-delivery model (2026-06-06) — how home delivery is offered, separate
  // from pickupEnabled. SCHEDULED = time-window slots, ASAP = no windows,
  // NONE = pickup-only (no home delivery). The controller blocks NONE while
  // pickup is off so a store always keeps one way to fulfil orders.
  deliveryMode: z.enum(['SCHEDULED', 'ASAP', 'NONE']).optional(),
  // Store-level FLAT delivery (deliver-anywhere baseline). Minor units; the
  // free-over threshold zeroes the fee above it. deliveryEtaMinutes = ASAP ETA
  // shown when no zone applies. Nullable to allow clearing the ETA.
  flatDeliveryFeeMinor: z.number().int().min(0).max(100000000).optional(),
  flatFreeDeliveryThresholdMinor: z.number().int().min(0).max(100000000).optional(),
  deliveryEtaMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  // Per-tenant feature overrides — { featureKey: boolean }. Controller
  // validates keys against the catalog and coerces values to boolean;
  // we keep the schema permissive (record of booleans) to avoid coupling
  // this file to the catalog. Null clears all overrides.
  featureFlags: z
    .union([z.record(z.boolean()), z.null()])
    .optional(),
});

module.exports = { setupBusinessSchema, updateBusinessSettingsSchema };
