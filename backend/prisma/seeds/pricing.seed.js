/* eslint-disable no-console */
// Idempotent seed for the pricing admin module.
// Safe to re-run: uses upsert on natural keys (slug / countryCode / (tierId, featureKey) / (tierId, countryCode)).
// Runs via:  npx prisma db seed   (see backend/package.json prisma.seed)
//
// 2026-06-22 (billing-trim): re-seeded as an HR SaaS catalog. The website /
// commerce (STATIC / APPOINTMENT / ECOMMERCE) tiers were replaced with three
// HR plans — Starter / Growth / Enterprise — priced as a base monthly fee plus
// a per-active-employee overage (TierPrice.overageStaffPriceMinor). The PPP
// zone engine (PricingZone / CountryZoneAssignment / TierPrice / TierFeature)
// is reused as-is; only the catalog content changed. The file keeps its
// existing shape and the same `main()` entrypoint so `prisma db seed` still runs.
//
// !!! INDICATIVE PRICING !!!
// All amounts below (base fee + per-active-employee) are INDICATIVE STARTING
// POINTS for launch, not finalised commercial pricing. Super-admin can tune any
// cell in Pricing → Tiers / Prices. The three billing currencies are fixed by
// the gateway router: INR (Razorpay/India), NZD (Stripe/New Zealand), and USD
// (Paddle / rest-of-world MoR).

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// -----------------------------------------------------------------------------
// Tiers  (HR SaaS — base fee + per-active-employee, monthly)
// -----------------------------------------------------------------------------
// Three plans on the HR vertical:
//   Starter    → core HR + time (attendance, leave) + employee self-service.
//   Growth     → adds the payroll engine, IN/NZ statutory compliance,
//                documents, and white-label custom domain.
//   Enterprise → adds recruiting / performance / LMS talent suite and
//                API access + webhooks.
//
// Marketing-card content (tagline, features[], ctaLabel, highlighted,
// includedStaff) is seeded into PricingTier so the public landing page renders
// without admin having to fill anything in. `includedStaff` is the number of
// active employees the base fee covers; employees beyond that are billed at the
// per-active-employee overage on each TierPrice row.
const TIERS = [
  {
    // The Free landing tier. EVERY self-signup tenant is auto-provisioned onto
    // this at setup (business.controller → getFreeTierForVertical → 'free') and
    // any downgrade lands here, so it MUST exist — without it signup leaves the
    // tenant with NO Subscription and a broken billing portal. It is hidden from
    // the public pricing API (publicPricing filters slug==='free'); it exists
    // purely as the always-available zero-cost landing/fallback plan.
    slug: 'free', vertical: 'HR', name: 'Free', sortOrder: 0, badge: null,
    description: 'Get started free — core HR for your first few employees.',
    tagline: 'Free forever for small teams.',
    ctaLabel: 'Start free', highlighted: false, includedStaff: 5, trialDays: null,
    features: [
      'Up to 5 active employees',
      'Core HR — employee records & org chart',
      'Attendance & leave',
      'Employee self-service portal',
    ],
  },
  {
    slug: 'starter', vertical: 'HR', name: 'Starter', sortOrder: 1, badge: null,
    description: 'Core HR for small teams — people, org, attendance and leave.',
    tagline: 'Run your people ops without spreadsheets.',
    ctaLabel: 'Start 30-day trial', highlighted: false, includedStaff: 25, trialDays: 30,
    features: [
      'Up to 25 active employees included',
      'Core HR — employee records & org chart',
      'Attendance tracking',
      'Leave management',
      'Employee self-service portal',
      'Then per active employee / month',
    ],
  },
  {
    slug: 'growth', vertical: 'HR', name: 'Growth', sortOrder: 2, badge: 'Most Popular',
    description: 'Adds payroll, IN/NZ statutory compliance, documents and white-label.',
    tagline: 'Payroll and compliance, done correctly for India & New Zealand.',
    ctaLabel: 'Start 30-day trial', highlighted: true, includedStaff: 50, trialDays: 30,
    features: [
      'Everything in Starter',
      'Up to 50 active employees included',
      'Payroll engine',
      'India & New Zealand statutory compliance',
      'Document management',
      'White-label custom domain',
      'Then per active employee / month',
    ],
  },
  {
    slug: 'enterprise', vertical: 'HR', name: 'Enterprise', sortOrder: 3, badge: null,
    description: 'Full talent suite plus API access for larger, integrated teams.',
    tagline: 'Recruiting, performance and an open API for the whole org.',
    ctaLabel: 'Talk to sales', ctaHref: 'mailto:sales@example.com', highlighted: false,
    includedStaff: 100, trialDays: 30,
    features: [
      'Everything in Growth',
      'Up to 100 active employees included',
      'Recruiting (ATS)',
      'Performance management',
      'Learning management (LMS)',
      'API access & webhooks',
      'Priority support',
      'Then per active employee / month',
    ],
  },
];

// Base USD monthly price per HR tier (the base fee before per-employee overage,
// before PPP zones). INDICATIVE.
//   Starter $49 / Growth $149 / Enterprise $399.
const TIER_BASE_USD_MONTHLY = {
  starter: 49,
  growth: 149,
  enterprise: 399,
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
// The full PPP country list is retained so the zone engine keeps working for
// the Paddle (USD) rest-of-world group. India (INR/Razorpay) and New Zealand
// (NZD/Stripe) carry explicit per-country overrides below.

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
// Feature matrix  (HR feature catalog — gates entitlements per plan)
// -----------------------------------------------------------------------------
// Rows = HR feature keys (§6.4 of docs/17-reuse-map.md), columns = the three HR
// tier slugs. Plan gating:
//   Starter    → coreHr, attendance, leaveManagement, essPortal
//   Growth     → + payrollEngine, statutoryIN, statutoryNZ, documents, whiteLabelDomain
//   Enterprise → + recruiting, performance, lms, apiAccess, webhooks
// Values per feature_type:
//   BOOLEAN   -> 'true' | 'false'
//   NUMERIC   -> '<int>'
//   UNLIMITED -> 'unlimited'
//
// NOTE: statutoryIN / statutoryNZ are also COUNTRY-CONDITIONED at runtime
// (resolved true only when business.country matches). They sit on Growth+ here
// so the *plan* exposes the compliance module; the country gate is applied by
// the feature resolver, not by this catalog.
const FEATURE_MATRIX = [
  // key,                  type,        display,                              starter,     growth,      enterprise
  ['active_employees',     'NUMERIC',   'Active employees included',          '25',        '50',        '100'],
  ['coreHr',               'BOOLEAN',   'Core HR (people & org)',             'true',      'true',      'true'],
  ['attendance',           'BOOLEAN',   'Attendance tracking',                'true',      'true',      'true'],
  ['leaveManagement',      'BOOLEAN',   'Leave management',                   'true',      'true',      'true'],
  ['essPortal',            'BOOLEAN',   'Employee self-service portal',       'true',      'true',      'true'],
  ['payrollEngine',        'BOOLEAN',   'Payroll engine',                     'false',     'true',      'true'],
  ['statutoryIN',          'BOOLEAN',   'India statutory compliance',         'false',     'true',      'true'],
  ['statutoryNZ',          'BOOLEAN',   'New Zealand statutory compliance',   'false',     'true',      'true'],
  ['documents',            'BOOLEAN',   'Document management',                'false',     'true',      'true'],
  ['whiteLabelDomain',     'BOOLEAN',   'White-label custom domain',          'false',     'true',      'true'],
  ['recruiting',           'BOOLEAN',   'Recruiting (ATS)',                   'false',     'false',     'true'],
  ['performance',          'BOOLEAN',   'Performance management',             'false',     'false',     'true'],
  ['lms',                  'BOOLEAN',   'Learning management (LMS)',          'false',     'false',     'true'],
  ['apiAccess',            'BOOLEAN',   'API access',                         'false',     'false',     'true'],
  ['webhooks',             'BOOLEAN',   'Webhooks',                           'false',     'false',     'true'],
  ['priority_support',     'BOOLEAN',   'Priority support',                   'false',     'false',     'true'],
];

// -----------------------------------------------------------------------------
// Prices  (base fee + per-active-employee, base USD + INR/NZD overrides)
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

// Base USD HR tier prices — the canonical base fee per tier before zones.
// Stays aligned with TIER_BASE_USD_MONTHLY above. INDICATIVE.
const BASE_USD = {
  starter:    49,
  growth:     149,
  enterprise: 399,
};

// Per-active-employee USD overage (charged on each employee beyond the tier's
// included headcount). INDICATIVE.
const BASE_USD_PER_EMPLOYEE = {
  starter:    3,
  growth:     5,
  enterprise: 7,
};

// Explicit billing-currency overrides for our three gateway currencies. These
// are the ONLY currencies the gateway router bills in:
//   INR → Razorpay (India), NZD → Stripe (New Zealand), USD → Paddle (RoW).
// Each entry: { base: monthly base fee, perEmployee: per-active-employee }.
// All amounts INDICATIVE starting points — tune in Pricing → Prices.
const CURRENCY_PRICING = {
  // USD (Paddle / rest of world) — also the countryCode=null base rows.
  USD: {
    starter:    { base: 49,  perEmployee: 3 },
    growth:     { base: 149, perEmployee: 5 },
    enterprise: { base: 399, perEmployee: 7 },
  },
  // INR (Razorpay / India). ~₹83/USD, rounded to clean marketing numbers.
  INR: {
    starter:    { base: 3999,  perEmployee: 199 },
    growth:     { base: 11999, perEmployee: 349 },
    enterprise: { base: 29999, perEmployee: 499 },
  },
  // NZD (Stripe / New Zealand). ~NZ$1.65/USD, rounded.
  NZD: {
    starter:    { base: 79,  perEmployee: 5 },
    growth:     { base: 249, perEmployee: 8 },
    enterprise: { base: 649, perEmployee: 12 },
  },
};

// Which country each explicit billing currency maps to for per-country
// override rows. (USD stays on the countryCode=null base row.)
const CURRENCY_COUNTRY = {
  INR: 'IN',
  NZD: 'NZ',
};

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
        vertical: t.vertical || 'HR',
        ...cardContent,
      },
      create: {
        slug: t.slug, name: t.name, description: t.description, badge: t.badge,
        sortOrder: t.sortOrder, isCustomPriced: !!t.isCustomPriced, trialDays: t.trialDays ?? null,
        vertical: t.vertical || 'HR',
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
      const overageMinor = toMinor(BASE_USD_PER_EMPLOYEE[t.slug] || 0, 'USD');
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
            overageStaffPriceMinor: overageMinor,
          },
        });
      } else {
        await prisma.tierPrice.create({
          data: {
            tierId: tier.id, countryCode: null, currencyCode: 'USD',
            amountMonthlyMinor: monthlyMinor, amountAnnualMinor: annualMinor,
            overageStaffPriceMinor: overageMinor,
          },
        });
      }
    }
  }
  console.log(`  ✓ ${TIERS.length} HR tiers upserted (Starter / Growth / Enterprise + base USD prices)`);
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
    const [key, type, displayLabel, starter, growth, enterprise] = row;
    const values = { starter, growth, enterprise };
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
  console.log(`  ✓ ${n} tier-feature rows upserted (${FEATURE_MATRIX.length} HR features × 3 tiers)`);
}

async function seedPrices() {
  const tiers = await prisma.pricingTier.findMany();
  const tiersBySlug = Object.fromEntries(tiers.map((t) => [t.slug, t.id]));
  const allSlugs = ['starter', 'growth', 'enterprise'];

  let n = 0;

  // 1) Base USD price per tier (countryCode = null), with per-employee overage.
  //    Prisma doesn't allow null in compound-unique where-clauses, so do
  //    findFirst then update/create manually.
  for (const slug of allSlugs) {
    const tierId = tiersBySlug[slug];
    if (!tierId) continue;
    const usd = CURRENCY_PRICING.USD[slug];
    const monthlyMinor = toMinor(usd.base, 'USD');
    const annualMinor = annualFromMonthly(monthlyMinor);
    const overageMinor = toMinor(usd.perEmployee, 'USD');
    const existing = await prisma.tierPrice.findFirst({
      where: { tierId, countryCode: null },
    });
    if (existing) {
      await prisma.tierPrice.update({
        where: { id: existing.id },
        data: {
          currencyCode: 'USD',
          amountMonthlyMinor: monthlyMinor,
          amountAnnualMinor: annualMinor,
          overageStaffPriceMinor: overageMinor,
        },
      });
    } else {
      await prisma.tierPrice.create({
        data: {
          tierId, countryCode: null, currencyCode: 'USD',
          amountMonthlyMinor: monthlyMinor, amountAnnualMinor: annualMinor,
          overageStaffPriceMinor: overageMinor,
        },
      });
    }
    n++;
  }

  // 2) Explicit billing-currency overrides — INR (India / Razorpay) and
  //    NZD (New Zealand / Stripe). Each carries its own base fee + per-active-
  //    employee overage. USD already covers the rest of the world via Paddle.
  for (const [currency, country] of Object.entries(CURRENCY_COUNTRY)) {
    const pricing = CURRENCY_PRICING[currency];
    for (const slug of allSlugs) {
      const tierId = tiersBySlug[slug];
      if (!tierId || !pricing[slug]) continue;
      const { base, perEmployee } = pricing[slug];
      const monthlyMinor = toMinor(base, currency);
      const annualMinor = annualFromMonthly(monthlyMinor);
      const overageMinor = toMinor(perEmployee, currency);
      await prisma.tierPrice.upsert({
        where: { tierId_countryCode: { tierId, countryCode: country } },
        update: {
          currencyCode: currency,
          amountMonthlyMinor: monthlyMinor,
          amountAnnualMinor: annualMinor,
          overageStaffPriceMinor: overageMinor,
          isOverride: true,
        },
        create: {
          tierId, countryCode: country, currencyCode: currency,
          amountMonthlyMinor: monthlyMinor, amountAnnualMinor: annualMinor,
          overageStaffPriceMinor: overageMinor, isOverride: true,
        },
      });
      n++;
    }
  }

  console.log(`  ✓ ${n} tier-price rows upserted (USD base + INR/NZD overrides, base fee + per-employee)`);
}

async function main() {
  console.log('Seeding pricing admin (HR plans)…');
  await seedTiers();
  await seedZones();
  await seedCountries();
  await seedFeatures();
  await seedPrices();
  console.log('Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
