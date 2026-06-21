/* eslint-disable no-console */
// Idempotent seed for the pricing admin module.
// Safe to re-run: uses upsert on natural keys (slug / countryCode / (tierId, featureKey) / (tierId, countryCode)).
// Runs via:  npx prisma db seed   (see backend/package.json prisma.seed)

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// -----------------------------------------------------------------------------
// Tiers  (base USD, monthly)
// -----------------------------------------------------------------------------

// Vertical-aware tiers. Each row carries an explicit vertical so the
// `(vertical × tier × zone)` matrix in pricing admin renders cleanly.
// Slugs are vertical-prefixed for STATIC + ECOMMERCE (slug @unique on
// PricingTier) — backend resolves by tierId once selected so the prefix
// is just a stable lookup key.
//
// Pricing intent (USD base, multiplied by zone for non-USD countries):
//   STATIC      → cheaper than APPOINTMENT (no booking engine)
//   APPOINTMENT → existing booking ladder (unchanged)
//   ECOMMERCE   → between APPOINTMENT and STATIC; transaction fees go
//                 to Razorpay/Stripe Connect, so SaaS price stays small
// 2026-06-03: `slug='free'` is an internal no-charge fallback because
// backend entitlement, signup, cancellation, and trial-expiry code rely on
// FREE_TIER_SLUG for safe downgrades. It is not part of the public paid
// catalog. Paid appointment Solo lives at slug='solo'. Static/ecommerce
// entry tiers keep their vertical-specific slugs and are paid products.
//
// Marketing-card content (tagline, features[], ctaLabel, highlighted,
// includedStaff) is seeded into PricingTier so the public landing page
// renders without admin having to fill anything in.
const TIERS = [
  // ── APPOINTMENT — Appointments (platform-managed billing + payment rails) ─
  {
    slug: 'free', vertical: 'APPOINTMENT', name: 'Free', sortOrder: 0, badge: null,
    description: 'No-charge fallback tier for signup, cancellation and expired trials.',
    tagline: 'Stay online while you choose a plan.',
    ctaLabel: 'Internal fallback', highlighted: false, includedStaff: 1, trialDays: null,
    features: [
      '1 staff member',
      '.sitepresso.com subdomain',
      'Basic enquiry and booking presence',
      '"Powered by Sitepresso" branding',
    ],
  },
  {
    slug: 'solo', vertical: 'APPOINTMENT', name: 'Solo', sortOrder: 1, badge: null,
    description: 'Solo practitioner — paid entry tier.',
    tagline: 'Take your first booking by tonight.',
    ctaLabel: 'Start 30-day trial', highlighted: false, includedStaff: 1, trialDays: 30,
    features: [
      '1 staff member',
      '.sitepresso.com subdomain',
      'Stripe Connect / Razorpay ready',
      'Email reminders',
      'Google / Apple calendar sync',
      '"Powered by Sitepresso" branding',
    ],
  },
  {
    slug: 'starter', vertical: 'APPOINTMENT', name: 'Starter', sortOrder: 2, badge: null,
    description: 'Solo practitioner with a small practice.',
    tagline: 'Look like you paid an agency.',
    ctaLabel: 'Start 30-day trial', highlighted: false, includedStaff: 2, trialDays: 30,
    features: [
      'Everything in Solo',
      'Up to 2 staff members',
      'Custom domain (yours.com)',
      'Branding watermark removed',
      '200 SMS reminders / month',
      'Basic CRM & client notes',
    ],
  },
  {
    slug: 'professional', vertical: 'APPOINTMENT', name: 'Professional', sortOrder: 3, badge: 'Most Popular',
    description: 'Small clinic / team (2–10 staff).',
    tagline: 'Built for teams that convert enquiries to revenue.',
    ctaLabel: 'Start 30-day trial', highlighted: true, includedStaff: 10, trialDays: 30,
    features: [
      'Everything in Starter',
      'Up to 10 staff members',
      'Service & staff routing',
      'Full CRM with tags & segments',
      'Marketing automation',
      'Unlimited SMS reminders',
      'Advanced intake forms',
      'Analytics & reports',
      'AI content generation — SEO meta & blog copy',
    ],
  },
  {
    slug: 'business', vertical: 'APPOINTMENT', name: 'Business', sortOrder: 4, badge: null,
    description: 'Multi-location / group practice.',
    tagline: 'Multi-location, unlimited staff, priority support.',
    ctaLabel: 'Talk to sales', ctaHref: 'mailto:sales@sitepresso.com', highlighted: false, trialDays: 30,
    features: [
      'Everything in Professional',
      'Unlimited staff',
      'Multi-location (coming Q3 2026)',
      'Role-based access control (coming Q3 2026)',
      'API access & webhooks (coming Q3 2026)',
      'Priority support',
      'Dedicated success manager',
    ],
  },
  {
    slug: 'custom', vertical: 'APPOINTMENT', name: 'Custom / Contact Sales', sortOrder: 5, badge: null,
    description: 'Custom appointment operations with more staff, branches, integrations, and support.',
    tagline: 'Custom limits for larger teams.',
    ctaLabel: 'Contact sales', ctaHref: 'mailto:sales@sitepresso.com', highlighted: false, trialDays: null,
    isCustomPriced: true,
    features: [
      'More staff and branches',
      'Custom usage limits',
      'Migration and onboarding support',
      'Custom integrations',
      'Priority success support',
    ],
  },

  // ── STATIC — Marketing site (no payments) ────────────────────────────────
  {
    slug: 'static-free', vertical: 'STATIC', name: 'Solo', sortOrder: 1, badge: null,
    description: 'Single-page marketing site — entry tier.',
    tagline: 'One page. Online today. Done.',
    ctaLabel: 'Start 30-day trial', highlighted: false, trialDays: 30,
    features: [
      '1 page',
      '.sitepresso.com subdomain',
      'Mobile-responsive',
      'Basic SEO',
      'Contact form',
      '"Powered by Sitepresso" branding',
    ],
  },
  {
    slug: 'static-starter', vertical: 'STATIC', name: 'Starter', sortOrder: 2, badge: null,
    description: 'Small marketing site with custom domain.',
    tagline: 'Your brand on your own domain.',
    ctaLabel: 'Start 30-day trial', highlighted: false, trialDays: 30,
    features: [
      'Up to 5 pages',
      'Custom domain',
      'Branding watermark removed',
      'Contact form with file uploads',
      'Basic SEO + sitemap',
      'Mobile-responsive',
    ],
  },
  {
    slug: 'static-professional', vertical: 'STATIC', name: 'Professional', sortOrder: 3, badge: 'Most Popular',
    description: 'Multi-page site with CMS + SEO tools.',
    tagline: 'A real marketing site that ranks.',
    ctaLabel: 'Start 30-day trial', highlighted: true, trialDays: 30,
    features: [
      'Everything in Starter',
      'Unlimited pages',
      'Built-in blog',
      'Advanced SEO + schema markup',
      'AI content generation — SEO meta & blog copy',
      'Site analytics',
      'Custom code blocks',
    ],
  },
  {
    slug: 'static-business', vertical: 'STATIC', name: 'Business', sortOrder: 4, badge: null,
    description: 'Agencies with multiple client sites.',
    tagline: 'Multi-site for agencies and growing teams.',
    ctaLabel: 'Talk to sales', ctaHref: 'mailto:sales@sitepresso.com', highlighted: false, trialDays: 30,
    features: [
      'Everything in Professional',
      'Up to 5 sites',
      'Up to 5 team seats',
      'Priority support',
      'Dedicated success manager',
    ],
  },
  {
    slug: 'static-custom', vertical: 'STATIC', name: 'Custom / Contact Sales', sortOrder: 5, badge: null,
    description: 'Custom website package for more pages, teams, sites, integrations, and support.',
    tagline: 'Custom limits for content-heavy teams.',
    ctaLabel: 'Contact sales', ctaHref: 'mailto:sales@sitepresso.com', highlighted: false, trialDays: null,
    isCustomPriced: true,
    features: [
      'More pages, sites, and staff',
      'Custom content and SEO limits',
      'Migration and onboarding support',
      'Custom integrations',
      'Priority success support',
    ],
  },

  // ── ECOMMERCE — Online shop (Razorpay Route / Stripe Connect) ────────────
  {
    slug: 'ecom-free', vertical: 'ECOMMERCE', name: 'Starter Commerce', sortOrder: 1, badge: null,
    description: 'Single online shop with one store owner/admin.',
    tagline: 'One store, one staff seat, online today.',
    ctaLabel: 'Start 30-day trial', highlighted: false, trialDays: 30,
    includedStaff: 1,
    features: [
      '1 storefront',
      '1 staff seat included',
      'Up to 10 fulfillment locations',
      'Products, categories and brands',
      'Cart, checkout and order dashboard',
      'Basic inventory edits',
      'Email order receipts',
    ],
  },
  {
    slug: 'ecom-starter', vertical: 'ECOMMERCE', name: 'Fulfillment Commerce', sortOrder: 2, badge: null,
    description: 'Shopify-style: one storefront with warehouses behind it.',
    tagline: 'One storefront, multiple fulfillment locations.',
    ctaLabel: 'Start 30-day trial', highlighted: false, trialDays: 30,
    includedStaff: 5,
    features: [
      'Everything in Starter Commerce',
      '5 staff seats included',
      'Up to 10 fulfillment locations',
      'Per-location inventory',
      'Purchase receiving',
      'Delivery and pickup setup',
      'Custom domain',
    ],
  },
  {
    slug: 'ecom-professional', vertical: 'ECOMMERCE', name: 'Commerce Pro', sortOrder: 3, badge: 'Most Popular',
    description: 'Larger Shopify-style operation with advanced fulfilment controls.',
    tagline: 'Built for serious warehouse operations.',
    ctaLabel: 'Start 30-day trial', highlighted: true, trialDays: 30,
    includedStaff: 10,
    features: [
      'Everything in Fulfillment Commerce',
      '10 staff seats included',
      'Up to 10 fulfillment locations',
      'Picklist and scanner workflow',
      'Stock transfers and adjustments',
      'Advanced inventory reports',
      'Roles and location permissions',
      'AI content generation — product copy, SEO & blog',
    ],
  },
  {
    slug: 'ecom-business', vertical: 'ECOMMERCE', name: 'Grocery Chain', sortOrder: 4, badge: null,
    description: 'Pak’nSave-style: online + offline branches with separate stock and pricing.',
    tagline: 'Branch-level ecommerce for grocery chains.',
    ctaLabel: 'Talk to sales', ctaHref: 'mailto:sales@sitepresso.com', highlighted: false, trialDays: 30,
    includedStaff: 30,
    features: [
      '3 physical branches included',
      '30 staff included',
      'Branch-specific inventory and pricing',
      'POS-ready branch workflows',
      'Pickup, delivery slots and riders per branch',
      'Store-scoped team permissions',
      'Priority support',
    ],
  },
  {
    slug: 'ecom-custom', vertical: 'ECOMMERCE', name: 'Custom / Contact Sales', sortOrder: 5, badge: null,
    description: 'More branches, more staff, custom limits, and migration support.',
    tagline: 'Custom commerce limits for growing chains.',
    ctaLabel: 'Contact sales', ctaHref: 'mailto:sales@sitepresso.com', highlighted: false, trialDays: null,
    isCustomPriced: true,
    features: [
      'More branches and fulfillment locations',
      'More staff, riders, and pickers',
      'Custom product, order, and inventory limits',
      'Migration and onboarding support',
      'Priority success support',
    ],
  },
];

// Base USD monthly price per self-serve tier. Custom/contact-sales tiers are
// intentionally omitted here; they are quoted and activated manually.
// STATIC vertical    : $5  / $12 / $29 / $79
// APPOINTMENT vertical: $9 / $19 / $49 / $129  (also drives BASE_USD below)
// ECOMMERCE vertical  : $29 / $39 / $99 / $299  (the canonical all-paid prices —
//   this seed is the single source of truth; apply-all-paid-pricing.js sets the
//   same 39/99/299, so the displayed price is deterministic regardless of which
//   ran. 2026-06-04: ecom-starter 79→39, ecom-professional 149→99.)
// Annual is 9.6× monthly (~20% yearly discount).
const TIER_BASE_USD_MONTHLY = {
  // APPOINTMENT
  free: 0, solo: 9, starter: 19, professional: 49, business: 129,
  // STATIC
  'static-free': 5, 'static-starter': 12, 'static-professional': 29, 'static-business': 79,
  // ECOMMERCE
  'ecom-free': 29, 'ecom-starter': 39, 'ecom-professional': 99, 'ecom-business': 299,
};

// -----------------------------------------------------------------------------
// Zones  (PPP multipliers applied to base USD)
// -----------------------------------------------------------------------------

const ZONES = [
  { slug: 'zone-1', name: 'Zone 1 — Premium markets',             multiplier: '1.0000', sortOrder: 1 },
  { slug: 'zone-2', name: 'Zone 2 — Mid-tier developed',          multiplier: '0.8500', sortOrder: 2 },
  { slug: 'zone-3', name: 'Zone 3 — Emerging markets',            multiplier: '0.6500', sortOrder: 3 },
  { slug: 'zone-4', name: 'Zone 4 — Price-sensitive emerging',    multiplier: '0.5000', sortOrder: 4 },
];

// -----------------------------------------------------------------------------
// Countries  (ISO 3166-1 alpha-2 → zone + default currency)
// -----------------------------------------------------------------------------
// Format: [countryCode, countryName, region, currencyCode, currencySymbol, zoneSlug]

const COUNTRIES = [
  ['US', "United States", 'North America', 'USD', '$', 'zone-1'],
  ['CA', "Canada", 'North America', 'CAD', 'C$', 'zone-1'],
  ['GB', "United Kingdom", 'Europe', 'GBP', '£', 'zone-1'],
  ['IE', "Ireland", 'Europe', 'EUR', '€', 'zone-1'],
  ['AU', "Australia", 'Oceania', 'AUD', 'A$', 'zone-1'],
  ['NZ', "New Zealand", 'Oceania', 'NZD', 'NZ$', 'zone-1'],
  ['SG', "Singapore", 'Asia', 'SGD', 'S$', 'zone-1'],
  ['HK', "Hong Kong", 'Asia', 'HKD', 'HK$', 'zone-1'],
  ['CH', "Switzerland", 'Europe', 'CHF', 'Fr.', 'zone-1'],
  ['NO', "Norway", 'Europe', 'NOK', 'kr', 'zone-1'],
  ['DK', "Denmark", 'Europe', 'DKK', 'kr', 'zone-1'],
  ['SE', "Sweden", 'Europe', 'SEK', 'kr', 'zone-1'],
  ['FI', "Finland", 'Europe', 'EUR', '€', 'zone-1'],
  ['NL', "Netherlands", 'Europe', 'EUR', '€', 'zone-1'],
  ['DE', "Germany", 'Europe', 'EUR', '€', 'zone-1'],
  ['FR', "France", 'Europe', 'EUR', '€', 'zone-1'],
  ['BE', "Belgium", 'Europe', 'EUR', '€', 'zone-1'],
  ['AT', "Austria", 'Europe', 'EUR', '€', 'zone-1'],
  ['LU', "Luxembourg", 'Europe', 'EUR', '€', 'zone-1'],
  ['IS', "Iceland", 'Europe', 'ISK', 'kr', 'zone-1'],
  ['IL', "Israel", 'Middle East', 'ILS', '₪', 'zone-2'],
  ['AE', "United Arab Emirates", 'Middle East', 'AED', 'AED ', 'zone-1'],
  ['QA', "Qatar", 'Middle East', 'QAR', 'QAR ', 'zone-1'],
  ['ES', "Spain", 'Europe', 'EUR', '€', 'zone-2'],
  ['IT', "Italy", 'Europe', 'EUR', '€', 'zone-2'],
  ['PT', "Portugal", 'Europe', 'EUR', '€', 'zone-2'],
  ['GR', "Greece", 'Europe', 'EUR', '€', 'zone-2'],
  ['CZ', "Czech Republic", 'Europe', 'CZK', 'Kč', 'zone-2'],
  ['PL', "Poland", 'Europe', 'PLN', 'zł', 'zone-2'],
  ['SK', "Slovakia", 'Europe', 'EUR', '€', 'zone-2'],
  ['SI', "Slovenia", 'Europe', 'EUR', '€', 'zone-2'],
  ['EE', "Estonia", 'Europe', 'EUR', '€', 'zone-2'],
  ['LT', "Lithuania", 'Europe', 'EUR', '€', 'zone-2'],
  ['LV', "Latvia", 'Europe', 'EUR', '€', 'zone-2'],
  ['CY', "Cyprus", 'Europe', 'EUR', '€', 'zone-2'],
  ['MT', "Malta", 'Europe', 'EUR', '€', 'zone-2'],
  ['KR', "South Korea", 'Asia', 'KRW', '₩', 'zone-2'],
  ['JP', "Japan", 'Asia', 'JPY', '¥', 'zone-2'],
  ['TW', "Taiwan", 'Asia', 'TWD', 'NT$', 'zone-2'],
  ['SA', "Saudi Arabia", 'Middle East', 'SAR', 'SAR ', 'zone-2'],
  ['KW', "Kuwait", 'Middle East', 'KWD', 'KWD ', 'zone-2'],
  ['BH', "Bahrain", 'Middle East', 'BHD', 'BHD ', 'zone-2'],
  ['OM', "Oman", 'Middle East', 'OMR', 'OMR ', 'zone-2'],
  ['BR', "Brazil", 'South America', 'BRL', 'R$', 'zone-3'],
  ['MX', "Mexico", 'North America', 'MXN', 'MX$', 'zone-3'],
  ['AR', "Argentina", 'South America', 'ARS', 'AR$', 'zone-3'],
  ['CL', "Chile", 'South America', 'CLP', 'CL$', 'zone-3'],
  ['CO', "Colombia", 'South America', 'COP', 'COL$', 'zone-3'],
  ['PE', "Peru", 'South America', 'PEN', 'S/', 'zone-3'],
  ['UY', "Uruguay", 'South America', 'UYU', '$U', 'zone-2'],
  ['CR', "Costa Rica", 'North America', 'CRC', '₡', 'zone-3'],
  ['PA', "Panama", 'North America', 'USD', '$', 'zone-2'],
  ['ZA', "South Africa", 'Africa', 'ZAR', 'R', 'zone-3'],
  ['TR', "Turkey", 'Europe', 'TRY', '₺', 'zone-3'],
  ['RO', "Romania", 'Europe', 'RON', 'lei', 'zone-3'],
  ['BG', "Bulgaria", 'Europe', 'BGN', 'лв', 'zone-3'],
  ['HU', "Hungary", 'Europe', 'HUF', 'Ft', 'zone-2'],
  ['HR', "Croatia", 'Europe', 'EUR', '€', 'zone-3'],
  ['RS', "Serbia", 'Europe', 'RSD', 'РСД', 'zone-3'],
  ['UA', "Ukraine", 'Europe', 'UAH', '₴', 'zone-4'],
  ['MY', "Malaysia", 'Asia', 'MYR', 'RM', 'zone-3'],
  ['TH', "Thailand", 'Asia', 'THB', '฿', 'zone-3'],
  ['PH', "Philippines", 'Asia', 'PHP', '₱', 'zone-4'],
  ['VN', "Vietnam", 'Asia', 'VND', '₫', 'zone-4'],
  ['ID', "Indonesia", 'Asia', 'IDR', 'Rp', 'zone-4'],
  ['CN', "China", 'Asia', 'CNY', '¥', 'zone-3'],
  ['RU', "Russia", 'Europe', 'RUB', '₽', 'zone-3'],
  ['IN', "India", 'Asia', 'INR', '₹', 'zone-4'],
  ['PK', "Pakistan", 'Asia', 'PKR', '₨', 'zone-4'],
  ['BD', "Bangladesh", 'Asia', 'BDT', '৳', 'zone-4'],
  ['LK', "Sri Lanka", 'Asia', 'LKR', 'Rs', 'zone-4'],
  ['NP', "Nepal", 'Asia', 'NPR', 'Rs', 'zone-4'],
  ['BT', "Bhutan", 'Asia', 'BTN', 'Nu.', 'zone-4'],
  ['MM', "Myanmar", 'Asia', 'MMK', 'K', 'zone-4'],
  ['KH', "Cambodia", 'Asia', 'KHR', '៛', 'zone-4'],
  ['LA', "Laos", 'Asia', 'LAK', '₭', 'zone-4'],
  ['NG', "Nigeria", 'Africa', 'NGN', '₦', 'zone-4'],
  ['KE', "Kenya", 'Africa', 'KES', 'KSh', 'zone-4'],
  ['GH', "Ghana", 'Africa', 'GHS', '₵', 'zone-4'],
  ['EG', "Egypt", 'Africa', 'EGP', 'E£', 'zone-4'],
  ['MA', "Morocco", 'Africa', 'MAD', 'MAD ', 'zone-4'],
  ['TN', "Tunisia", 'Africa', 'TND', 'TND ', 'zone-4'],
  ['DZ', "Algeria", 'Africa', 'DZD', 'DZD ', 'zone-4'],
  ['ET', "Ethiopia", 'Africa', 'ETB', 'Br', 'zone-4'],
  ['TZ', "Tanzania", 'Africa', 'TZS', 'TSh', 'zone-4'],
  ['UG', "Uganda", 'Africa', 'UGX', 'USh', 'zone-4'],
  ['RW', "Rwanda", 'Africa', 'RWF', 'FRw', 'zone-4'],
  ['SN', "Senegal", 'Africa', 'XOF', 'CFA', 'zone-4'],
  ['CI', "Côte d'Ivoire", 'Africa', 'XOF', 'CFA', 'zone-4'],
  ['AD', "Andorra", 'Europe', 'EUR', '€', 'zone-1'],
  ['AL', "Albania", 'Europe', 'ALL', 'L', 'zone-3'],
  ['BA', "Bosnia and Herzegovina", 'Europe', 'BAM', 'KM', 'zone-3'],
  ['BY', "Belarus", 'Europe', 'BYN', 'Br', 'zone-3'],
  ['FO', "Faroe Islands", 'Europe', 'DKK', 'kr', 'zone-1'],
  ['GG', "Guernsey", 'Europe', 'GBP', '£', 'zone-1'],
  ['GI', "Gibraltar", 'Europe', 'GIP', '£', 'zone-2'],
  ['GL', "Greenland", 'Europe', 'DKK', 'kr', 'zone-1'],
  ['IM', "Isle of Man", 'Europe', 'GBP', '£', 'zone-1'],
  ['JE', "Jersey", 'Europe', 'GBP', '£', 'zone-1'],
  ['LI', "Liechtenstein", 'Europe', 'CHF', 'Fr.', 'zone-1'],
  ['MC', "Monaco", 'Europe', 'EUR', '€', 'zone-1'],
  ['MD', "Moldova", 'Europe', 'MDL', 'L', 'zone-3'],
  ['ME', "Montenegro", 'Europe', 'EUR', '€', 'zone-3'],
  ['MK', "North Macedonia", 'Europe', 'MKD', 'ден', 'zone-3'],
  ['SM', "San Marino", 'Europe', 'EUR', '€', 'zone-1'],
  ['VA', "Vatican City", 'Europe', 'EUR', '€', 'zone-1'],
  ['XK', "Kosovo", 'Europe', 'EUR', '€', 'zone-3'],
  ['AF', "Afghanistan", 'Asia', 'AFN', '؋', 'zone-4'],
  ['AM', "Armenia", 'Asia', 'AMD', '֏', 'zone-3'],
  ['AZ', "Azerbaijan", 'Asia', 'AZN', '₼', 'zone-3'],
  ['BN', "Brunei", 'Asia', 'BND', 'B$', 'zone-2'],
  ['GE', "Georgia", 'Asia', 'GEL', '₾', 'zone-3'],
  ['IQ', "Iraq", 'Middle East', 'IQD', 'IQD ', 'zone-3'],
  ['IR', "Iran", 'Middle East', 'IRR', 'IRR ', 'zone-4'],
  ['JO', "Jordan", 'Middle East', 'JOD', 'JOD ', 'zone-4'],
  ['KG', "Kyrgyzstan", 'Asia', 'KGS', 'с', 'zone-4'],
  ['KP', "North Korea", 'Asia', 'KPW', '₩', 'zone-4'],
  ['KZ', "Kazakhstan", 'Asia', 'KZT', '₸', 'zone-3'],
  ['LB', "Lebanon", 'Middle East', 'LBP', 'LBP ', 'zone-4'],
  ['MN', "Mongolia", 'Asia', 'MNT', '₮', 'zone-4'],
  ['MV', "Maldives", 'Asia', 'MVR', 'Rf', 'zone-3'],
  ['PS', "Palestine", 'Middle East', 'ILS', '₪', 'zone-4'],
  ['SY', "Syria", 'Middle East', 'SYP', '£S', 'zone-4'],
  ['TJ', "Tajikistan", 'Asia', 'TJS', 'SM', 'zone-4'],
  ['TL', "Timor-Leste", 'Asia', 'USD', '$', 'zone-4'],
  ['TM', "Turkmenistan", 'Asia', 'TMT', 'm', 'zone-3'],
  ['UZ', "Uzbekistan", 'Asia', 'UZS', 'soʻm', 'zone-4'],
  ['YE', "Yemen", 'Middle East', 'YER', 'YER ', 'zone-4'],
  ['AO', "Angola", 'Africa', 'AOA', 'Kz', 'zone-4'],
  ['BF', "Burkina Faso", 'Africa', 'XOF', 'CFA', 'zone-4'],
  ['BI', "Burundi", 'Africa', 'BIF', 'FBu', 'zone-4'],
  ['BJ', "Benin", 'Africa', 'XOF', 'CFA', 'zone-4'],
  ['BW', "Botswana", 'Africa', 'BWP', 'P', 'zone-3'],
  ['CD', "Congo (DRC)", 'Africa', 'CDF', 'FC', 'zone-4'],
  ['CF', "Central African Republic", 'Africa', 'XAF', 'FCFA', 'zone-4'],
  ['CG', "Congo (Republic)", 'Africa', 'XAF', 'FCFA', 'zone-4'],
  ['CM', "Cameroon", 'Africa', 'XAF', 'FCFA', 'zone-4'],
  ['CV', "Cape Verde", 'Africa', 'CVE', '$', 'zone-4'],
  ['DJ', "Djibouti", 'Africa', 'DJF', 'Fdj', 'zone-4'],
  ['ER', "Eritrea", 'Africa', 'ERN', 'Nfk', 'zone-4'],
  ['GA', "Gabon", 'Africa', 'XAF', 'FCFA', 'zone-3'],
  ['GM', "Gambia", 'Africa', 'GMD', 'D', 'zone-4'],
  ['GN', "Guinea", 'Africa', 'GNF', 'FG', 'zone-4'],
  ['GQ', "Equatorial Guinea", 'Africa', 'XAF', 'FCFA', 'zone-3'],
  ['GW', "Guinea-Bissau", 'Africa', 'XOF', 'CFA', 'zone-4'],
  ['KM', "Comoros", 'Africa', 'KMF', 'CF', 'zone-4'],
  ['LR', "Liberia", 'Africa', 'LRD', 'L$', 'zone-4'],
  ['LS', "Lesotho", 'Africa', 'LSL', 'L', 'zone-4'],
  ['LY', "Libya", 'Africa', 'LYD', 'LYD ', 'zone-3'],
  ['MG', "Madagascar", 'Africa', 'MGA', 'Ar', 'zone-4'],
  ['ML', "Mali", 'Africa', 'XOF', 'CFA', 'zone-4'],
  ['MR', "Mauritania", 'Africa', 'MRU', 'UM', 'zone-4'],
  ['MU', "Mauritius", 'Africa', 'MUR', 'Rs', 'zone-3'],
  ['MW', "Malawi", 'Africa', 'MWK', 'MK', 'zone-4'],
  ['MZ', "Mozambique", 'Africa', 'MZN', 'MT', 'zone-4'],
  ['NA', "Namibia", 'Africa', 'NAD', 'N$', 'zone-3'],
  ['NE', "Niger", 'Africa', 'XOF', 'CFA', 'zone-4'],
  ['SC', "Seychelles", 'Africa', 'SCR', 'SR', 'zone-2'],
  ['SD', "Sudan", 'Africa', 'SDG', '£S', 'zone-4'],
  ['SL', "Sierra Leone", 'Africa', 'SLL', 'Le', 'zone-4'],
  ['SO', "Somalia", 'Africa', 'SOS', 'S', 'zone-4'],
  ['SS', "South Sudan", 'Africa', 'SSP', 'SS£', 'zone-4'],
  ['ST', "São Tomé and Príncipe", 'Africa', 'STN', 'Db', 'zone-4'],
  ['SZ', "Eswatini", 'Africa', 'SZL', 'E', 'zone-4'],
  ['TD', "Chad", 'Africa', 'XAF', 'FCFA', 'zone-4'],
  ['TG', "Togo", 'Africa', 'XOF', 'CFA', 'zone-4'],
  ['ZM', "Zambia", 'Africa', 'ZMW', 'ZK', 'zone-4'],
  ['ZW', "Zimbabwe", 'Africa', 'ZWL', 'Z$', 'zone-4'],
  ['AG', "Antigua and Barbuda", 'North America', 'XCD', 'EC$', 'zone-2'],
  ['AI', "Anguilla", 'North America', 'XCD', 'EC$', 'zone-2'],
  ['AW', "Aruba", 'North America', 'AWG', 'ƒ', 'zone-2'],
  ['BB', "Barbados", 'North America', 'BBD', 'Bds$', 'zone-2'],
  ['BM', "Bermuda", 'North America', 'BMD', 'BD$', 'zone-1'],
  ['BO', "Bolivia", 'South America', 'BOB', 'Bs.', 'zone-4'],
  ['BS', "Bahamas", 'North America', 'BSD', 'B$', 'zone-2'],
  ['BZ', "Belize", 'North America', 'BZD', 'BZ$', 'zone-3'],
  ['CU', "Cuba", 'North America', 'CUP', '₱', 'zone-3'],
  ['CW', "Curaçao", 'North America', 'ANG', 'ƒ', 'zone-2'],
  ['DM', "Dominica", 'North America', 'XCD', 'EC$', 'zone-3'],
  ['DO', "Dominican Republic", 'North America', 'DOP', 'RD$', 'zone-3'],
  ['EC', "Ecuador", 'South America', 'USD', '$', 'zone-3'],
  ['FK', "Falkland Islands", 'South America', 'FKP', '£', 'zone-1'],
  ['GD', "Grenada", 'North America', 'XCD', 'EC$', 'zone-3'],
  ['GF', "French Guiana", 'South America', 'EUR', '€', 'zone-2'],
  ['GP', "Guadeloupe", 'North America', 'EUR', '€', 'zone-2'],
  ['GT', "Guatemala", 'North America', 'GTQ', 'Q', 'zone-3'],
  ['GY', "Guyana", 'South America', 'GYD', 'G$', 'zone-2'],
  ['HN', "Honduras", 'North America', 'HNL', 'L', 'zone-4'],
  ['HT', "Haiti", 'North America', 'HTG', 'G', 'zone-4'],
  ['JM', "Jamaica", 'North America', 'JMD', 'J$', 'zone-3'],
  ['KN', "Saint Kitts and Nevis", 'North America', 'XCD', 'EC$', 'zone-2'],
  ['KY', "Cayman Islands", 'North America', 'KYD', 'CI$', 'zone-1'],
  ['LC', "Saint Lucia", 'North America', 'XCD', 'EC$', 'zone-3'],
  ['MQ', "Martinique", 'North America', 'EUR', '€', 'zone-2'],
  ['MS', "Montserrat", 'North America', 'XCD', 'EC$', 'zone-2'],
  ['NI', "Nicaragua", 'North America', 'NIO', 'C$', 'zone-4'],
  ['PR', "Puerto Rico", 'North America', 'USD', '$', 'zone-2'],
  ['PY', "Paraguay", 'South America', 'PYG', '₲', 'zone-3'],
  ['SR', "Suriname", 'South America', 'SRD', '$', 'zone-3'],
  ['SV', "El Salvador", 'North America', 'USD', '$', 'zone-4'],
  ['TC', "Turks and Caicos", 'North America', 'USD', '$', 'zone-2'],
  ['TT', "Trinidad and Tobago", 'North America', 'TTD', 'TT$', 'zone-2'],
  ['VC', "Saint Vincent and the Grenadines", 'North America', 'XCD', 'EC$', 'zone-3'],
  ['VE', "Venezuela", 'South America', 'VES', 'Bs.', 'zone-4'],
  ['VG', "British Virgin Islands", 'North America', 'USD', '$', 'zone-2'],
  ['VI', "U.S. Virgin Islands", 'North America', 'USD', '$', 'zone-2'],
  ['AS', "American Samoa", 'Oceania', 'USD', '$', 'zone-3'],
  ['CK', "Cook Islands", 'Oceania', 'NZD', 'NZ$', 'zone-2'],
  ['FJ', "Fiji", 'Oceania', 'FJD', 'FJ$', 'zone-3'],
  ['FM', "Micronesia", 'Oceania', 'USD', '$', 'zone-4'],
  ['GU', "Guam", 'Oceania', 'USD', '$', 'zone-2'],
  ['KI', "Kiribati", 'Oceania', 'AUD', 'A$', 'zone-4'],
  ['MH', "Marshall Islands", 'Oceania', 'USD', '$', 'zone-4'],
  ['MP', "Northern Mariana Islands", 'Oceania', 'USD', '$', 'zone-2'],
  ['NC', "New Caledonia", 'Oceania', 'XPF', 'F', 'zone-2'],
  ['NR', "Nauru", 'Oceania', 'AUD', 'A$', 'zone-3'],
  ['NU', "Niue", 'Oceania', 'NZD', 'NZ$', 'zone-2'],
  ['PF', "French Polynesia", 'Oceania', 'XPF', 'F', 'zone-2'],
  ['PG', "Papua New Guinea", 'Oceania', 'PGK', 'K', 'zone-4'],
  ['PW', "Palau", 'Oceania', 'USD', '$', 'zone-3'],
  ['SB', "Solomon Islands", 'Oceania', 'SBD', 'SI$', 'zone-4'],
  ['TO', "Tonga", 'Oceania', 'TOP', 'T$', 'zone-3'],
  ['TV', "Tuvalu", 'Oceania', 'AUD', 'A$', 'zone-3'],
  ['VU', "Vanuatu", 'Oceania', 'VUV', 'Vt', 'zone-4'],
  ['WF', "Wallis and Futuna", 'Oceania', 'XPF', 'F', 'zone-3'],
  ['WS', "Samoa", 'Oceania', 'WST', 'T', 'zone-4'],
];


// -----------------------------------------------------------------------------
// Feature matrix
// -----------------------------------------------------------------------------
// Rows = feature keys, columns = tier slugs. Values per feature_type:
//   BOOLEAN   -> 'true' | 'false'
//   NUMERIC   -> '<int>' (use '-1' for unlimited via UNLIMITED type instead)
//   UNLIMITED -> 'unlimited'
//
const FEATURE_MATRIX = [
  // key,                        type,        display,                                free,        solo,       starter,     professional, business
  ['staff_count',                'NUMERIC',   'Staff members',                        '1',         '1',        '2',         '10',         'unlimited'],
  ['bookings_per_month',         'NUMERIC',   'Bookings per month',                   '10',        '50',       'unlimited', 'unlimited',  'unlimited'],
  ['custom_domain',              'BOOLEAN',   'Custom domain',                        'false',     'false',    'true',      'true',       'true'],
  ['remove_branding',            'BOOLEAN',   'Remove "Powered by" branding',         'false',     'false',    'true',      'true',       'true'],
  ['calendar_sync',              'BOOLEAN',   'Google / Apple calendar sync',         'false',     'false',    'true',      'true',       'true'],
  ['sms_reminders_monthly',      'NUMERIC',   'SMS reminders per month',              '0',         '0',        '200',       '1000',       '5000'],
  ['email_reminders',            'BOOLEAN',   'Email reminders',                      'true',      'true',     'true',      'true',       'true'],
  ['intake_forms_basic',         'BOOLEAN',   'Basic intake forms',                   'true',      'true',     'true',      'true',       'true'],
  ['intake_forms_advanced',      'BOOLEAN',   'Advanced forms (conditional, files)',  'false',     'false',    'false',     'true',       'true'],
  ['department_service_routing', 'BOOLEAN',   'Department / service routing',         'false',     'false',    'false',     'true',       'true'],
  ['waiting_list',               'BOOLEAN',   'Waiting list',                         'false',     'false',    'false',     'true',       'true'],
  ['basic_crm',                  'BOOLEAN',   'Basic CRM (clients, notes)',           'false',     'true',     'true',      'true',       'true'],
  ['advanced_crm',               'BOOLEAN',   'Advanced CRM (tags, segments)',        'false',     'false',    'false',     'true',       'true'],
  ['automated_marketing',        'BOOLEAN',   'Automated marketing',                  'false',     'false',    'false',     'true',       'true'],
  ['reports_analytics',          'BOOLEAN',   'Reports & analytics',                  'false',     'false',    'false',     'true',       'true'],
  ['multi_location',             'BOOLEAN',   'Multi-location',                       'false',     'false',    'false',     'false',      'true'],
  ['rbac_permissions',           'BOOLEAN',   'Role-based permissions',               'false',     'false',    'false',     'false',      'true'],
  ['api_access',                 'BOOLEAN',   'API access & webhooks',                'false',     'false',    'false',     'false',      'true'],
  ['white_label',                'BOOLEAN',   'White label',                          'false',     'false',    'false',     'false',      'true'],
  ['priority_support',           'BOOLEAN',   'Priority support',                     'false',     'false',    'false',     'false',      'true'],
  ['multi_language_booking',     'BOOLEAN',   'Multi-language booking page',          'false',     'false',    'false',     'true',       'true'],
];

// -----------------------------------------------------------------------------
// Prices  (base USD + explicit local-currency overrides)
// -----------------------------------------------------------------------------
// Currency decimal handling — ISO 4217 minor units.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'COP', 'IDR', 'PYG', 'UGX', 'RWF', 'XAF', 'XOF', 'KMF', 'DJF', 'GNF', 'BIF',
]);
const THREE_DECIMAL_CURRENCIES = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']);

function toMinor(amount, currency) {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return Math.round(amount);
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return Math.round(amount * 1000);
  return Math.round(amount * 100);
}

// 20% annual discount: annual = monthly × 12 × 0.80 (=monthly × 9.6)
function annualFromMonthly(monthlyMinor) {
  return Math.round(monthlyMinor * 9.6);
}

// 2026-04-29 — base USD tier prices (the canonical per-tier price before zones).
// APPOINTMENT vertical drives this map; STATIC + ECOMMERCE per-country
// overrides are derived via STATIC_RATIO / ECOM_RATIO below. This stays
// aligned with TIER_BASE_USD_MONTHLY['<slug>'] above for the APPOINTMENT
// slugs (free → $0 fallback, solo → $9, starter $19, professional $49, business $129).
const BASE_USD = {
  free:         0,
  solo:         9,
  starter:      19,
  professional: 49,
  business:     129,
};

// Vertical price ratios used when mirroring per-country overrides from
// APPOINTMENT to STATIC + ECOMMERCE. New (2026-04-29):
//   STATIC      ≈ 60% of APPOINTMENT
//   ECOMMERCE   uses each ecommerce facility tier's own base-vs-appointment
//               ratio because Starter/Fulfillment/Pro/Chain do not scale
//               evenly from the booking ladder.
const STATIC_RATIO = 0.60;
function ecommerceRatioFor(appointmentSlug) {
  const ecomSlug = appointmentSlug === 'solo' ? 'ecom-free' : `ecom-${appointmentSlug}`;
  const appointmentBase = BASE_USD[appointmentSlug] || 1;
  const ecomBase = TIER_BASE_USD_MONTHLY[ecomSlug] || appointmentBase;
  return ecomBase / appointmentBase;
}

// Country-specific overrides — APPOINTMENT prices in local currency, rounded
// for marketing. STATIC + ECOMMERCE are mirrored automatically via the ratios
// above. Numbers refreshed 2026-06-03 to match the $0/$9/$19/$49/$129 USD
// ladder. Super-admin can fine-tune any cell in `Pricing → Prices`.
const COUNTRY_OVERRIDES = {
  US: { free: 0, solo: 9,      starter: 19,    professional: 49,    business: 129    },
  GB: { free: 0, solo: 7,      starter: 15,    professional: 39,    business: 99     },
  // EU is applied below to the 17 EUR countries in the zone lists
  AU: { free: 0, solo: 14,     starter: 29,    professional: 75,    business: 199    },
  CA: { free: 0, solo: 12,     starter: 25,    professional: 65,    business: 169    },
  NZ: { free: 0, solo: 14,     starter: 29,    professional: 75,    business: 199    },
  SG: { free: 0, solo: 12,     starter: 25,    professional: 65,    business: 169    },
  JP: { free: 0, solo: 900,    starter: 1900,  professional: 4900,  business: 12900  },
  KR: { free: 0, solo: 9000,   starter: 19000, professional: 49000, business: 129000 },
  BR: { free: 0, solo: 25,     starter: 49,    professional: 129,   business: 339    },
  MX: { free: 0, solo: 99,     starter: 199,   professional: 499,   business: 1299   },
  TR: { free: 0, solo: 169,    starter: 349,   professional: 899,   business: 2299   },
  ZA: { free: 0, solo: 89,     starter: 179,   professional: 449,   business: 1199   },
  IN: { free: 0, solo: 299,    starter: 599,   professional: 1499,  business: 3999   },
  PK: { free: 0, solo: 999,    starter: 1999,  professional: 4999,  business: 12999  },
  NG: { free: 0, solo: 4900,   starter: 9500,  professional: 24000, business: 64000  },
  BD: { free: 0, solo: 499,    starter: 999,   professional: 2499,  business: 6499   },
  EG: { free: 0, solo: 149,    starter: 299,   professional: 749,   business: 1999   },
};

// EUR countries get zone-aware EUR pricing (base Zone 1 multiplied by zone).
// Without this, every EUR country would show identical prices and the zone
// multiplier would be ignored for them (see publicPricing.controller.js).
const EUR_ZONE_OVERRIDES = {
  'zone-1': { free: 0, solo: 8,  starter: 17, professional: 45, business: 119 },
  'zone-2': { free: 0, solo: 7,  starter: 14, professional: 38, business: 99  },
  'zone-3': { free: 0, solo: 5,  starter: 11, professional: 29, business: 76  },
  'zone-4': { free: 0, solo: 4,  starter: 9,  professional: 22, business: 59  },
};
for (const [code, , , currency, , zoneSlug] of COUNTRIES) {
  if (currency !== 'EUR' || COUNTRY_OVERRIDES[code]) continue;
  const prices = EUR_ZONE_OVERRIDES[zoneSlug];
  if (prices) COUNTRY_OVERRIDES[code] = prices;
}

// -----------------------------------------------------------------------------
// Seed
// -----------------------------------------------------------------------------

async function seedTiers() {
  for (const t of TIERS) {
    // Marketing-card content (tagline, features[], ctaLabel, etc.) is the
    // source of truth for the public landing page. Super-admin can override
    // any of these via /admin#pricing — this seed seeds the defaults and
    // refreshes them on every deploy unless an admin has explicitly edited.
    const cardContent = {
      tagline:       t.tagline ?? null,
      features:      Array.isArray(t.features) ? t.features : [],
      ctaLabel:      t.ctaLabel ?? null,
      ctaHref:       t.ctaHref ?? null,
      highlighted:   !!t.highlighted,
      includedStaff: t.includedStaff ?? null,
    };
    const tier = await prisma.pricingTier.upsert({
      where: { slug: t.slug },
      update: {
        name: t.name, description: t.description, badge: t.badge, sortOrder: t.sortOrder,
        isCustomPriced: !!t.isCustomPriced, isActive: true, trialDays: t.trialDays ?? null,
        vertical: t.vertical || 'APPOINTMENT',
        ...cardContent,
      },
      create: {
        slug: t.slug, name: t.name, description: t.description, badge: t.badge,
        sortOrder: t.sortOrder, isCustomPriced: !!t.isCustomPriced, trialDays: t.trialDays ?? null,
        vertical: t.vertical || 'APPOINTMENT',
        ...cardContent,
      },
    });

    // Seed the base USD price row (countryCode = null) so the public
    // pricing API can resolve the tier without per-country overrides.
    // Idempotent: re-running the seed with the same prices is a no-op.
    const baseUsdMonthly = TIER_BASE_USD_MONTHLY[t.slug];
    if (typeof baseUsdMonthly === 'number') {
      const monthlyMinor = Math.round(baseUsdMonthly * 100);
      const annualMinor = Math.round(monthlyMinor * 9.6);
      const existingBase = await prisma.tierPrice.findFirst({
        where: { tierId: tier.id, countryCode: null },
      });
      if (existingBase) {
        await prisma.tierPrice.update({
          where: { id: existingBase.id },
          data: {
            currencyCode: 'USD',
            amountMonthlyMinor: monthlyMinor,
            amountAnnualMinor: annualMinor,
          },
        });
      } else {
        await prisma.tierPrice.create({
          data: {
            tierId: tier.id, countryCode: null, currencyCode: 'USD',
            amountMonthlyMinor: monthlyMinor, amountAnnualMinor: annualMinor,
          },
        });
      }
    }
  }
  console.log(`  ✓ ${TIERS.length} tiers upserted (appointment free+4 paid tiers, static/ecom paid tiers + base USD prices)`);
}

async function seedZones() {
  for (const z of ZONES) {
    await prisma.pricingZone.upsert({
      where: { slug: z.slug },
      update: { name: z.name, multiplier: z.multiplier, sortOrder: z.sortOrder, isActive: true },
      create: { slug: z.slug, name: z.name, multiplier: z.multiplier, sortOrder: z.sortOrder },
    });
  }
  console.log(`  ✓ ${ZONES.length} zones upserted`);
}

async function seedCountries() {
  const zonesBySlug = Object.fromEntries(
    (await prisma.pricingZone.findMany()).map((z) => [z.slug, z.id]),
  );
  let n = 0;
  for (const [code, name, region, currency, symbol, zoneSlug] of COUNTRIES) {
    const existing = await prisma.countryZoneAssignment.findUnique({
      where: { countryCode: code },
      select: { id: true, isOverride: true },
    });

    if (existing) {
      // Preserve admin-picked zones while still refreshing the reference data.
      await prisma.countryZoneAssignment.update({
        where: { id: existing.id },
        data: {
          countryName: name,
          region,
          currencyCode: currency,
          currencySymbol: symbol,
          ...(existing.isOverride ? {} : { zoneId: zonesBySlug[zoneSlug] }),
        },
      });
    } else {
      await prisma.countryZoneAssignment.create({
        data: {
          countryCode: code,
          countryName: name,
          region,
          currencyCode: currency,
          currencySymbol: symbol,
          zoneId: zonesBySlug[zoneSlug],
          isOverride: false,
        },
      });
    }
    n++;
  }
  console.log(`  ✓ ${n} countries upserted`);
}

async function seedFeatures() {
  const tiers = await prisma.pricingTier.findMany();
  const tiersBySlug = Object.fromEntries(tiers.map((t) => [t.slug, t.id]));
  let n = 0;
  for (let i = 0; i < FEATURE_MATRIX.length; i++) {
    const row = FEATURE_MATRIX[i];
    const [key, type, displayLabel, free, solo, starter, professional, business] = row;
    const values = { free, solo, starter, professional, business };
    for (const tierSlug of Object.keys(values)) {
      if (!tiersBySlug[tierSlug]) continue;
      const rawVal = values[tierSlug];
      const featureType = rawVal === 'unlimited' ? 'UNLIMITED' : type;
      await prisma.tierFeature.upsert({
        where: { tierId_featureKey: { tierId: tiersBySlug[tierSlug], featureKey: key } },
        update: { featureType, featureValue: rawVal, displayLabel, sortOrder: i },
        create: {
          tierId: tiersBySlug[tierSlug], featureKey: key, featureType, featureValue: rawVal,
          displayLabel, sortOrder: i,
        },
      });
      n++;
    }
  }
  console.log(`  ✓ ${n} tier-feature rows upserted (${FEATURE_MATRIX.length} features × appointment tiers)`);
}

async function seedPrices() {
  const tiers = await prisma.pricingTier.findMany();
  const tiersBySlug = Object.fromEntries(tiers.map((t) => [t.slug, t.id]));
  // 2026-06-03: `free` is the true zero-price fallback; paid appointment
  // Solo is `solo`.
  const allSlugs = ['free', 'solo', 'starter', 'professional', 'business'];

  let n = 0;

  // 1) Base USD price per tier (countryCode = null).
  //    Prisma doesn't allow null in compound-unique where-clauses, so do
  //    findFirst then update/create manually.
  for (const slug of allSlugs) {
    const tierId = tiersBySlug[slug];
    const monthlyUsd = BASE_USD[slug];
    const monthlyMinor = toMinor(monthlyUsd, 'USD');
    const annualMinor = annualFromMonthly(monthlyMinor);
    const existing = await prisma.tierPrice.findFirst({
      where: { tierId, countryCode: null },
    });
    if (existing) {
      await prisma.tierPrice.update({
        where: { id: existing.id },
        data: { currencyCode: 'USD', amountMonthlyMinor: monthlyMinor, amountAnnualMinor: annualMinor },
      });
    } else {
      await prisma.tierPrice.create({
        data: {
          tierId, countryCode: null, currencyCode: 'USD',
          amountMonthlyMinor: monthlyMinor, amountAnnualMinor: annualMinor,
        },
      });
    }
    n++;
  }

  // 2) Country-specific overrides — APPOINTMENT first, then mirror to
  //    STATIC (×0.5) and ECOMMERCE (×0.8). Mirroring keeps the per-country
  //    catalogue complete for all 12 tiers without forcing the user to
  //    enter every cell by hand. They can still override any value via
  //    super-admin → Pricing → Prices subtab.
  const countries = await prisma.countryZoneAssignment.findMany();
  const countryCurrency = Object.fromEntries(countries.map((c) => [c.countryCode, c.currencyCode]));

  // Helper — round to a "marketing-friendly" number ending in 9/99/999
  // rather than the raw 0.5×/0.8× output (e.g., $14.5 → $15, ₹1439 → ₹1399).
  // Step granularity is one order of magnitude smaller than the value,
  // so 1439 snaps to 1399 (step 100), not 999 (step 1000). For float
  // currencies under 100 we just round to integer — no charm needed.
  function roundMarketing(value, currency) {
    if (value <= 0) return 0;
    const isFloatCurrency = !ZERO_DECIMAL_CURRENCIES.has(currency);
    if (isFloatCurrency && value < 100) {
      return Math.round(value);
    }
    let step;
    if (value < 1000)        step = 10;   // 100-999      → 99, 199, 299, …
    else if (value < 100000) step = 100;  // 1000-99999   → 1099, 1199, …, 1399, 1499, …
    else                     step = 1000; // 100000+      → 99999, 199999, …
    const rounded = Math.round(value / step) * step;
    return Math.max(step - 1, rounded - 1);
  }

  // Helper — write one (tier, country) override row, idempotent.
  async function upsertCountryPrice(tierId, countryCode, currency, monthlyAmount) {
    const monthlyMinor = toMinor(monthlyAmount, currency);
    const annualMinor = annualFromMonthly(monthlyMinor);
    await prisma.tierPrice.upsert({
      where: { tierId_countryCode: { tierId, countryCode } },
      update: { currencyCode: currency, amountMonthlyMinor: monthlyMinor, amountAnnualMinor: annualMinor, isOverride: true },
      create: { tierId, countryCode, currencyCode: currency, amountMonthlyMinor: monthlyMinor, amountAnnualMinor: annualMinor, isOverride: true },
    });
  }

  for (const [countryCode, tierPrices] of Object.entries(COUNTRY_OVERRIDES)) {
    const currency = countryCurrency[countryCode];
    if (!currency) continue; // country not seeded — skip
    for (const slug of allSlugs) {
      const amount = tierPrices[slug];
      if (amount == null) continue;

      // APPOINTMENT (the source of truth for the per-country price)
      await upsertCountryPrice(tiersBySlug[slug], countryCode, currency, amount);
      n++;

      if (slug === 'free') continue;

      // STATIC mirror — 60% of APPOINTMENT, marketing-rounded.
      const staticSlug = slug === 'solo' ? 'static-free' : `static-${slug}`;
      if (tiersBySlug[staticSlug]) {
        const staticAmount = roundMarketing(amount * STATIC_RATIO, currency);
        await upsertCountryPrice(tiersBySlug[staticSlug], countryCode, currency, staticAmount);
        n++;
      }

      // ECOMMERCE mirror — facility-tier base ratio, marketing-rounded.
      const ecomSlug = slug === 'solo' ? 'ecom-free' : `ecom-${slug}`;
      if (tiersBySlug[ecomSlug]) {
        const ecomAmount = roundMarketing(amount * ecommerceRatioFor(slug), currency);
        await upsertCountryPrice(tiersBySlug[ecomSlug], countryCode, currency, ecomAmount);
        n++;
      }
    }
  }

  console.log(`  ✓ ${n} tier-price rows upserted (3 verticals × per-country overrides + base USD)`);
}

async function moveLegacySoloPaddlePriceIds() {
  const freeTier = await prisma.pricingTier.findUnique({ where: { slug: 'free' }, select: { id: true } });
  const soloTier = await prisma.pricingTier.findUnique({ where: { slug: 'solo' }, select: { id: true } });
  if (!freeTier || !soloTier) return;

  const freePrices = await prisma.tierPrice.findMany({
    where: {
      tierId: freeTier.id,
      OR: [
        { paddlePriceIdMonthly: { not: null } },
        { paddlePriceIdAnnual: { not: null } },
      ],
    },
  });

  let moved = 0;
  for (const freePrice of freePrices) {
    const soloPrice = await prisma.tierPrice.findFirst({
      where: {
        tierId: soloTier.id,
        countryCode: freePrice.countryCode,
      },
    });
    if (!soloPrice) continue;

    await prisma.tierPrice.update({
      where: { id: soloPrice.id },
      data: {
        paddlePriceIdMonthly: soloPrice.paddlePriceIdMonthly || freePrice.paddlePriceIdMonthly,
        paddlePriceIdAnnual: soloPrice.paddlePriceIdAnnual || freePrice.paddlePriceIdAnnual,
        lastSyncedToPaddleAt: soloPrice.lastSyncedToPaddleAt || freePrice.lastSyncedToPaddleAt,
      },
    });
    await prisma.tierPrice.update({
      where: { id: freePrice.id },
      data: {
        paddlePriceIdMonthly: null,
        paddlePriceIdAnnual: null,
        lastSyncedToPaddleAt: null,
      },
    });
    moved += 1;
  }

  if (moved > 0) {
    console.log(`  ✓ moved ${moved} legacy Solo Paddle price row(s) from free → solo`);
  }
}

async function main() {
  console.log('Seeding pricing admin…');
  await seedTiers();
  await seedZones();
  await seedCountries();
  await seedFeatures();
  await seedPrices();
  await moveLegacySoloPaddlePriceIds();
  console.log('Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
