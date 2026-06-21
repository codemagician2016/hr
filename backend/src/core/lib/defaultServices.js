// Seeds a brand-new business with two generic services so the booking
// flow works immediately — the admin doesn't need to configure anything
// before sharing their booking link with a customer.
//
// The admin can edit / rename / reprice / delete these anytime from the
// Services tab. They're just starter stubs.

const prisma = require('./prisma');
const { DEFAULT_CURRENCY } = require('./currency');

// Generic catalogue. Same three services fit a consultant, a salon, a
// clinic, a legal practice, a tutor — the names are neutral.
const DEFAULT_SERVICE_TEMPLATES = [
  {
    name: 'Initial consultation',
    description: 'A first meeting to understand your needs and get started.',
    duration: 30,
    basePriceUsd: 40,
    features: ['30-minute one-on-one', 'No commitment required'],
    highlighted: true,
  },
  {
    name: 'Follow-up appointment',
    description: 'A shorter session to continue from a previous visit.',
    duration: 20,
    basePriceUsd: 25,
    features: ['20-minute session'],
    highlighted: false,
  },
  {
    name: 'Quick chat',
    description: 'A short check-in for fast questions or status updates.',
    duration: 15,
    basePriceUsd: 15,
    features: ['15-minute call', 'Great for quick follow-ups'],
    highlighted: false,
  },
];

// Default storefront-display services. Decoupled from the booking-side
// Service[] table — what shows on the homepage. Admin edits these in
// the Web editor, completely independent of admin → Services.
//
// Each business gets these 3 starter cards seeded once. After that the
// admin can edit, rename, reorder, add, or delete from the editor.
const DEFAULT_CMS_SERVICES = [
  {
    name: 'Initial consultation',
    description: 'A welcoming first session where we learn what you need and how we can help.',
    duration: '30 min',
    priceCaption: 'from',
    features: ['One-on-one', 'No commitment'],
    imageUrl: '',
    highlighted: true,
  },
  {
    name: 'Follow-up appointment',
    description: 'A continuation of your previous visit, focused on progress and next steps.',
    duration: '20 min',
    priceCaption: 'from',
    features: ['Continued care', 'Personalised plan'],
    imageUrl: '',
    highlighted: false,
  },
  {
    name: 'Quick chat',
    description: 'Short check-ins for fast questions, status updates, or quick follow-ups.',
    duration: '15 min',
    priceCaption: 'from',
    features: ['Fast & convenient', 'Phone or video'],
    imageUrl: '',
    highlighted: false,
  },
];

// Default storefront-display team members. Placeholder bios with stock-
// style avatar URLs. Admin edits these in the Web editor → Team section.
// Independent of admin → Team (which feeds the booking form).
const DEFAULT_CMS_TEAM = [
  {
    name: 'Alex Morgan',
    role: 'Founder',
    bio: 'Started this business with a simple goal — helping every customer feel heard and looked after.',
    imageUrl: '',
    showOnWebsite: true,
  },
  {
    name: 'Sam Patel',
    role: 'Senior Practitioner',
    bio: 'Ten years of hands-on experience and a knack for making first-timers feel completely at ease.',
    imageUrl: '',
    showOnWebsite: true,
  },
  {
    name: 'Jordan Lee',
    role: 'Specialist',
    bio: 'Calm, attentive, and obsessed with the small details that make every visit feel personal.',
    imageUrl: '',
    showOnWebsite: true,
  },
];

// Approximate FX rates (USD → local). Refreshed manually — these are
// only used to generate default prices. The admin edits them to match
// reality, so precision doesn't matter. We deliberately round to
// "memorable" numbers (e.g. ₹1500 not ₹1487).
const FX_FROM_USD = {
  USD: 1, EUR: 0.92, GBP: 0.78, AUD: 1.55, CAD: 1.35, NZD: 1.65,
  CHF: 0.88, SEK: 10.5, NOK: 10.8, DKK: 6.85, ISK: 140,
  JPY: 150, KRW: 1350, TWD: 32, SGD: 1.35, HKD: 7.8, CNY: 7.2, THB: 36,
  MYR: 4.7, IDR: 16000, PHP: 57, VND: 25000,
  INR: 85, PKR: 280, BDT: 110, LKR: 300, NPR: 135,
  AED: 3.67, SAR: 3.75, QAR: 3.64, KWD: 0.307, BHD: 0.376, OMR: 0.385,
  ILS: 3.7, TRY: 32, EGP: 48,
  ZAR: 18, NGN: 1500, KES: 130, GHS: 15, MAD: 10, TND: 3.1, DZD: 135,
  BRL: 5.0, MXN: 18, ARS: 1000, CLP: 950, COP: 4200, PEN: 3.75, UYU: 42,
  PLN: 4.0, CZK: 23, HUF: 360, RON: 4.6, BGN: 1.8,
  RUB: 95, UAH: 42,
};

// Currency rounding conventions so the default prices look sensible:
//   ₹500, $40, €35, ¥5000 — not ₹487, $39.20, ¥4987.
function roundToNice(amount, currency) {
  if (amount <= 0) return 0;
  // Zero-decimal currencies — round to nearest 100 (small) or 1000 (big)
  if (['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'COP'].includes(currency)) {
    if (amount < 2000) return Math.round(amount / 100) * 100;
    return Math.round(amount / 500) * 500;
  }
  // Large-denomination currencies — round to nearest 10 or 50
  if (['INR', 'PKR', 'BDT', 'NGN', 'LKR', 'NPR', 'PHP', 'EGP', 'TRY', 'HUF', 'RUB', 'UAH', 'DZD', 'TWD', 'THB', 'MXN', 'ARS', 'CZK', 'RON', 'UYU'].includes(currency)) {
    if (amount < 100) return Math.round(amount / 10) * 10;
    if (amount < 1000) return Math.round(amount / 50) * 50;
    return Math.round(amount / 100) * 100;
  }
  // Three-decimal Middle-East currencies — round to nearest 0.5
  if (['KWD', 'BHD', 'OMR', 'JOD'].includes(currency)) {
    return Math.round(amount * 2) / 2;
  }
  // Default: whole-currency unit (USD, EUR, GBP, AUD, etc.)
  return Math.round(amount);
}

function computeLocalPrice(basePriceUsd, zoneMultiplier, currency) {
  const fx = FX_FROM_USD[currency];
  if (!fx) return null; // unknown currency — leave price blank for admin to set
  const raw = basePriceUsd * (zoneMultiplier || 1) * fx;
  return roundToNice(raw, currency);
}

/**
 * Seed default services for a newly created business.
 *
 * Idempotent: if the business already has services (e.g. a retry hit
 * this after the first call succeeded), we skip. Errors are swallowed
 * and logged — default seeding must NEVER fail the signup flow. A
 * business can create services manually if seeding fails.
 */
async function seedDefaultServices(businessId, country) {
  try {
    const existing = await prisma.service.count({ where: { businessId } });
    if (existing > 0) return;

    // Pull currency + zone multiplier from the pricing catalogue. Falls
    // back to USD at 1.0× if the country isn't in CountryZoneAssignment
    // (shouldn't happen — we seed all countries — but defensive).
    let currency = 'USD';
    let multiplier = 1;
    if (country) {
      const row = await prisma.countryZoneAssignment.findUnique({
        where: { countryCode: country.toUpperCase() },
        include: { zone: { select: { multiplier: true } } },
      });
      if (row) {
        currency = row.currencyCode || DEFAULT_CURRENCY;
        multiplier = Number(row.zone?.multiplier || 1);
      }
    }

    for (const tpl of DEFAULT_SERVICE_TEMPLATES) {
      const price = computeLocalPrice(tpl.basePriceUsd, multiplier, currency);
      await prisma.service.create({
        data: {
          businessId,
          name: tpl.name,
          description: tpl.description,
          duration: tpl.duration,
          price,
          features: JSON.stringify(tpl.features),
          highlighted: tpl.highlighted,
        },
      });
    }
  } catch (err) {
    console.error(`[defaultServices] seeding failed for business ${businessId}:`, err.message);
  }
}

/**
 * Seed default CMS Services + Team content. These power the storefront
 * homepage display, decoupled from the booking-side Service[] / User[]
 * tables. Idempotent: skipped if BusinessContent already has cmsServices
 * or cmsTeam set.
 *
 * Prices on the CMS services are computed at seed time using the same
 * zone multiplier + currency rounding as booking services so the
 * homepage and booking form start in sync, even though they then drift
 * independently.
 */
async function seedDefaultCmsContent(businessId, country, themeKey = null) {
  try {
    let currency = 'USD';
    let multiplier = 1;
    if (country) {
      const row = await prisma.countryZoneAssignment.findUnique({
        where: { countryCode: country.toUpperCase() },
        include: { zone: { select: { multiplier: true } } },
      });
      if (row) {
        currency = row.currencyCode || DEFAULT_CURRENCY;
        multiplier = Number(row.zone?.multiplier || 1);
      }
    }

    // Theme-aware seed: if the picked theme provides homepage CMS services
    // (e.g. math_tuition's "Primary / GCSE / A-Level" subjects), seed those
    // instead of the generic "Initial consultation / Follow-up / Quick chat"
    // stubs so the storefront looks on-brand the moment it goes live.
    const { listCmsServices, listCmsTeam } = require('./themeRegistry');
    const themeServices = themeKey ? listCmsServices(themeKey) : [];
    const themeTeam     = themeKey ? listCmsTeam(themeKey)     : [];

    const sourceServices = themeServices.length > 0 ? themeServices : DEFAULT_CMS_SERVICES;
    const cmsServices = sourceServices.map((tpl, idx) => {
      const basePriceUsd = tpl.basePriceUsd ?? DEFAULT_SERVICE_TEMPLATES[idx]?.basePriceUsd;
      const price = basePriceUsd ? computeLocalPrice(basePriceUsd, multiplier, currency) : null;
      // Strip helper-only fields the storefront doesn't expect.
      const { basePriceUsd: _strip, ...rest } = tpl;
      return {
        ...rest,
        price: price != null ? String(price) : (tpl.price ?? ''),
        currency,
      };
    });

    // Upsert: only fill cmsServices / cmsTeam if they're not already set.
    const existing = await prisma.businessContent.findUnique({
      where: { businessId },
      select: { id: true, cmsServices: true, cmsTeam: true },
    });

    if (existing) {
      const patch = {};
      if (!existing.cmsServices) patch.cmsServices = JSON.stringify(cmsServices);
      if (!existing.cmsTeam)     patch.cmsTeam = JSON.stringify(themeTeam.length > 0 ? themeTeam : DEFAULT_CMS_TEAM);
      if (Object.keys(patch).length > 0) {
        await prisma.businessContent.update({ where: { businessId }, data: patch });
      }
    } else {
      await prisma.businessContent.create({
        data: {
          businessId,
          cmsServices: JSON.stringify(cmsServices),
          cmsTeam: JSON.stringify(themeTeam.length > 0 ? themeTeam : DEFAULT_CMS_TEAM),
        },
      });
    }
  } catch (err) {
    console.error(`[defaultServices] CMS seed failed for business ${businessId}:`, err.message);
  }
}

/**
 * Seed default weekly business hours — 9am–5pm Mon-Fri, closed weekends.
 * Matches the implicit default that booking falls back to when no
 * BusinessHours rows exist, but makes them explicit + visible in Settings
 * → Business hours so the admin can see what they're working with and
 * adjust without having to tick every day individually.
 *
 * Idempotent. Skipped if the business already has any BusinessHours rows.
 */
async function seedDefaultBusinessHours(businessId) {
  try {
    const existing = await prisma.businessHours.count({ where: { businessId } });
    if (existing > 0) return;

    // Sunday=0 … Saturday=6. Mon-Fri open, Sat/Sun closed.
    const rows = Array.from({ length: 7 }, (_, dow) => ({
      businessId,
      dayOfWeek: dow,
      openTime: '09:00',
      closeTime: '17:00',
      isClosed: dow === 0 || dow === 6,
    }));
    await prisma.businessHours.createMany({ data: rows });
  } catch (err) {
    console.error(`[defaultServices] hours seeding failed for business ${businessId}:`, err.message);
  }
}

module.exports = {
  seedDefaultServices,
  seedDefaultCmsContent,
  seedDefaultBusinessHours,
  // Exported for tests / admin "reset defaults" flows.
  DEFAULT_SERVICE_TEMPLATES,
  DEFAULT_CMS_SERVICES,
  DEFAULT_CMS_TEAM,
  computeLocalPrice,
  roundToNice,
};
