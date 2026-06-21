const prisma = require('../../core/lib/prisma');
const { ROLES } = require('../../core/lib/roles');
const { billingAccessState } = require('../../core/lib/billingAccess');
const { DEFAULT_CURRENCY } = require('../../core/lib/currency');
const {
  getPaddleTransaction,
  getPaddleTransactionInvoice,
  isPaddleConfigured,
} = require('../../core/lib/paddle');
const {
  invoiceAvailableForTransaction,
} = require('../../core/lib/paddleBillingViews');
const { cancelBusinessSubscription } = require('../../core/lib/accountDeletion');

function parsePageSize(value, fallback = 20, max = 30) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

// GET /api/admin/email-deliveries — platform-wide email activity
async function emailDeliveryActivity(req, res) {
  const businessId = String(req.query.businessId || '').trim() || null;
  const status = String(req.query.status || '').trim().toUpperCase() || null;
  const eventKey = String(req.query.eventKey || '').trim() || null;
  const recipient = String(req.query.recipient || '').trim().toLowerCase() || null;
  const take = parsePageSize(req.query.limit, 30, 100);

  const where = {
    ...(businessId ? { businessId } : {}),
    ...(status ? { status } : {}),
    ...(eventKey ? { eventKey } : {}),
    ...(recipient ? { recipientEmail: { contains: recipient, mode: 'insensitive' } } : {}),
  };

  const [deliveries, totals] = await Promise.all([
    prisma.emailDelivery.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        eventKey: true,
        category: true,
        provider: true,
        senderEmail: true,
        recipientEmail: true,
        actualRecipientEmail: true,
        recipientName: true,
        subject: true,
        status: true,
        businessId: true,
        appointmentId: true,
        userId: true,
        customerId: true,
        subscriptionId: true,
        metadata: true,
        providerMessageId: true,
        errorMessage: true,
        overrideApplied: true,
        attemptedAt: true,
        sentAt: true,
        createdAt: true,
      },
    }),
    prisma.emailDelivery.groupBy({
      by: ['status'],
      where,
      _count: { status: true },
    }),
  ]);

  const businessIds = [...new Set(deliveries.map((item) => item.businessId).filter(Boolean))];
  const businesses = businessIds.length > 0
    ? await prisma.business.findMany({
        where: { id: { in: businessIds } },
        select: { id: true, name: true, slug: true },
      })
    : [];
  const businessMap = Object.fromEntries(businesses.map((item) => [item.id, item]));

  const summary = {
    pending: 0,
    sent: 0,
    failed: 0,
  };
  totals.forEach((row) => {
    if (row.status === 'PENDING') summary.pending = row._count.status;
    if (row.status === 'SENT') summary.sent = row._count.status;
    if (row.status === 'FAILED') summary.failed = row._count.status;
  });

  res.json({
    deliveries: deliveries.map((delivery) => ({
      ...delivery,
      business: delivery.businessId ? businessMap[delivery.businessId] || null : null,
    })),
    summary,
    filters: {
      businessId,
      status,
      eventKey,
      recipient,
      limit: take,
    },
  });
}

// A currentPeriodEnd more than 50 years out is the "forever / no renewal"
// convention (matches subscription.controller's FOREVER sentinel) — e.g. a
// LIFETIME_FREE coupon pushes it to 2099.
const FIFTY_YEARS_MS = 50 * 365 * 24 * 60 * 60 * 1000;

function couponBenefitLabel(benefitType, benefitValue, benefitUnit) {
  switch (benefitType) {
    case 'LIFETIME_FREE': return 'Lifetime free';
    case 'FREE_PERIOD': return `${benefitValue || ''} ${String(benefitUnit || 'days').toLowerCase()} free`.trim();
    case 'PERCENT_OFF': return `${benefitValue || ''}% off`;
    case 'FIXED_OFF': return `${benefitValue || ''} off`;
    default: return 'Promotion';
  }
}

// Friendly billing summary so the admin list can show "Lifetime promo — no
// renewal needed" / "Promo: 3 months free, renews <date>" instead of a bare
// ACTIVE. Reads the subscription period + the latest admin-coupon redemption.
function billingSummary(business, red) {
  const sub = business?.subscription || null;
  const periodEnd = sub?.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  const lifetime = !!periodEnd && (periodEnd.getTime() - Date.now() > FIFTY_YEARS_MS);
  const promo = red?.coupon
    ? {
        code: red.coupon.code,
        benefitType: red.coupon.benefitType,
        label: couponBenefitLabel(red.coupon.benefitType, red.coupon.benefitValue, red.coupon.benefitUnit),
      }
    : null;
  return {
    lifetime,
    renewsAt: !lifetime && periodEnd ? periodEnd.toISOString() : null,
    promo,
  };
}

// GET /api/admin/businesses — list all with subscription + plan + counts
async function listBusinesses(req, res) {
  const businesses = await prisma.business.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      subscription: { include: { tier: true } },
      _count: {
        select: {
          appointments: true,
          users: true, // total users (includes STAFF + BUSINESS_ADMIN)
        },
      },
      users: {
        where: { role: ROLES.BUSINESS_ADMIN },
        select: { email: true, name: true },
        take: 1,
      },
    },
  });

  // Add a separate staff count for each (users array only has one BUSINESS_ADMIN due to take:1)
  const businessIds = businesses.map((b) => b.id);
  const staffCounts = await prisma.user.groupBy({
    by: ['businessId'],
    where: { businessId: { in: businessIds }, role: ROLES.STAFF, isActive: true },
    _count: { businessId: true },
  });
  const staffByBiz = Object.fromEntries(staffCounts.map((s) => [s.businessId, s._count.businessId]));

  // Latest admin-coupon redemption per business (AdminCouponRedemption has no
  // back-relation on Business, so query it separately, newest first, and keep
  // the first seen per business). Powers the "promotion applied" note.
  const redemptions = await prisma.adminCouponRedemption.findMany({
    where: { businessId: { in: businessIds } },
    include: { coupon: { select: { code: true, benefitType: true, benefitValue: true, benefitUnit: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const redemptionByBiz = {};
  for (const r of redemptions) { if (!redemptionByBiz[r.businessId]) redemptionByBiz[r.businessId] = r; }

  const rows = businesses.map((b) => ({
    id: b.id,
    shortId: b.shortId,
    name: b.name,
    slug: b.slug,
    category: b.category,
    isActive: b.isActive,
    createdAt: b.createdAt,
    admin: b.users[0] || null,
    subscription: b.subscription
      ? {
          status: b.subscription.status,
          theme: b.subscription.theme,
          billingCycle: b.subscription.billingCycle,
          currentPeriodEnd: b.subscription.currentPeriodEnd,
          tier: b.subscription.tier
            ? { id: b.subscription.tier.id, name: b.subscription.tier.name, slug: b.subscription.tier.slug }
            : null,
        }
      : null,
    staffCount: staffByBiz[b.id] || 0,
    appointmentCount: b._count.appointments,
    // The real lifecycle stage (onboarding / active / grace / expired) from the
    // billing state machine — not the raw gateway subscription status, which can
    // read "ACTIVE" on a free/lapsed tenant. The admin list shows this so the
    // STATUS reflects each tenant's true stage.
    billingStage: billingAccessState(b).state,
    // Friendly billing summary: is it a lifetime/no-renewal comp, when does it
    // renew, and was a promo (admin coupon) applied — so "ACTIVE" can read
    // "Lifetime promo — no renewal needed" etc.
    billing: billingSummary(b, redemptionByBiz[b.id]),
  }));

  res.json({ businesses: rows });
}

// GET /api/admin/stats — platform-wide snapshot
async function stats(req, res) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalBusinesses,
    activeSubscriptions,
    totalStaff,
    totalAppointments,
    byTier,
    activeSubsForMrr,
    trialBusinesses,
    churnedLast30Days,
    pastDueSubscriptions,
  ] = await Promise.all([
    prisma.business.count(),
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    prisma.user.count({ where: { role: ROLES.STAFF, isActive: true } }),
    prisma.appointment.count(),
    prisma.subscription.groupBy({
      by: ['tierId'],
      _count: { tierId: true },
    }),
    // For MRR: each active subscription's tier + cycle, looked up against
    // the default TierPrice (countryCode=null) and normalised to monthly.
    prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
      select: { tierId: true, billingCycle: true },
    }),
    // Trialing = trial window still open and not yet converted to paid.
    prisma.subscription.count({
      where: { trialConvertedAt: null, trialEndsAt: { gt: now } },
    }),
    // Churn = cancellations in the last 30 days.
    prisma.subscription.count({
      where: { status: 'CANCELLED', updatedAt: { gte: thirtyDaysAgo } },
    }),
    prisma.subscription.count({ where: { status: 'PAST_DUE' } }),
  ]);

  const tiers = await prisma.pricingTier.findMany({ select: { id: true, name: true, slug: true } });
  const tierIndex = Object.fromEntries(tiers.map((t) => [t.id, t]));
  const businessesPerTier = byTier.map((row) => ({
    tierId: row.tierId,
    tierName: tierIndex[row.tierId]?.name || 'Unknown',
    tierSlug: tierIndex[row.tierId]?.slug || null,
    count: row._count.tierId,
  }));

  // MRR estimate per currency. Uses each tier's default TierPrice
  // (countryCode=null) so per-country overrides don't double-count and
  // tiers without a default are skipped. Annual cycles are normalised to
  // their monthly equivalent (amountAnnualMinor / 12). Sum is reported per
  // currency because tiers may price in USD/INR/EUR independently — the
  // dashboard chooses what to display.
  const tierPrices = await prisma.tierPrice.findMany({
    where: { countryCode: null },
    select: { tierId: true, amountMonthlyMinor: true, amountAnnualMinor: true, currencyCode: true },
  });
  const priceByTier = Object.fromEntries(tierPrices.map((p) => [p.tierId, p]));
  const mrrByCurrency = {};
  for (const sub of activeSubsForMrr) {
    const price = priceByTier[sub.tierId];
    if (!price) continue;
    const perMonthMinor = sub.billingCycle === 'YEARLY'
      ? Math.round(price.amountAnnualMinor / 12)
      : price.amountMonthlyMinor;
    const cur = price.currencyCode || DEFAULT_CURRENCY;
    mrrByCurrency[cur] = (mrrByCurrency[cur] || 0) + perMonthMinor;
  }

  res.json({
    totalBusinesses,
    activeSubscriptions,
    totalStaff,
    totalAppointments,
    businessesPerTier,
    mrrByCurrency,
    trialBusinesses,
    churnedLast30Days,
    pastDueSubscriptions,
  });
}

// GET /api/admin/billing — recent platform billing activity from the local ledger
async function billingActivity(req, res) {
  const businessesWithPaddleCustomer = await prisma.subscription.count({
    where: { paddleCustomerId: { not: null } },
  });
  const [paidSubscriptions, pastDueSubscriptions, scheduledDowngrades] = await Promise.all([
    prisma.subscription.count({
      where: {
        paddleCustomerId: { not: null },
        status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] },
        tier: { slug: { not: 'free' } },
      },
    }),
    prisma.subscription.count({
      where: {
        paddleCustomerId: { not: null },
        status: 'PAST_DUE',
      },
    }),
    prisma.subscription.count({
      where: {
        paddleCustomerId: { not: null },
        pendingTierSlug: 'free',
      },
    }),
  ]);

  const businessId = String(req.query.businessId || '').trim() || null;
  const status = String(req.query.status || '').trim().toUpperCase() || null;
  const take = parsePageSize(req.query.perPage, 20, 30);
  const after = String(req.query.after || '').trim() || null;
  const where = {
    ...(businessId ? { businessId } : {}),
    ...(status && status !== 'ALL' ? { status } : {}),
  };
  const cursor = after ? { cursor: { id: after }, skip: 1 } : {};

  const [
    purchases,
    grossRows,
    adjustmentRows,
    ledgerPurchases,
    paymentAttempts,
    adjustments,
  ] = await Promise.all([
    prisma.billingPurchase.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
      ...cursor,
      include: {
        business: { select: { id: true, name: true, slug: true } },
      },
    }),
    prisma.billingPurchase.groupBy({
      by: ['actualCurrencyCode'],
      where: {
        actualCurrencyCode: { not: null },
        actualTotalMinor: { not: null },
        status: { in: ['COMPLETED', 'BILLED', 'READY'] },
      },
      _sum: { actualTotalMinor: true, actualTaxMinor: true },
    }).catch(() => []),
    prisma.adjustmentLedger.groupBy({
      by: ['currencyCode'],
      where: {
        currencyCode: { not: null },
        status: { in: ['APPROVED', 'COMPLETED'] },
      },
      _sum: { amountMinor: true },
    }).catch(() => []),
    prisma.billingPurchase.count({ where: businessId ? { businessId } : {} }).catch(() => 0),
    prisma.paymentAttempt.count({ where: businessId ? { businessId } : {} }).catch(() => 0),
    prisma.adjustmentLedger.count({ where: businessId ? { businessId } : {} }).catch(() => 0),
  ]);

  const grossByCurrency = Object.fromEntries(grossRows
    .filter((row) => row.actualCurrencyCode)
    .map((row) => [row.actualCurrencyCode, {
      totalMinor: row._sum.actualTotalMinor || 0,
      taxMinor: row._sum.actualTaxMinor || 0,
      netMinor: (row._sum.actualTotalMinor || 0) - (row._sum.actualTaxMinor || 0),
    }]));
  const adjustmentsByCurrency = Object.fromEntries(adjustmentRows
    .filter((row) => row.currencyCode)
    .map((row) => [row.currencyCode, row._sum.amountMinor || 0]));

  const transactions = purchases.map((purchase) => {
    const metadata = purchase.metadata && typeof purchase.metadata === 'object' ? purchase.metadata : {};
    const statusText = String(purchase.status || 'recorded').toUpperCase();
    return {
      id: purchase.paddleTransactionId || purchase.id,
      purchaseId: purchase.id,
      createdAt: purchase.createdAt,
      billedAt: purchase.updatedAt,
      business: purchase.business || null,
      plan: {
        name: metadata.tierSlug
          ? String(metadata.tierSlug).replace(/[-_]/g, ' ')
          : String(purchase.productKind || 'Billing').replace(/[-_]/g, ' '),
        slug: metadata.tierSlug || null,
      },
      productKind: purchase.productKind,
      checkoutKind: purchase.checkoutKind,
      status: statusText,
      totalMinor: purchase.actualTotalMinor ?? purchase.expectedAmountMinor,
      taxMinor: purchase.actualTaxMinor,
      netMinor: purchase.actualTotalMinor != null
        ? purchase.actualTotalMinor - Number(purchase.actualTaxMinor || 0)
        : null,
      currencyCode: purchase.actualCurrencyCode || purchase.expectedCurrencyCode,
      invoiceNumber: purchase.invoiceNumber || purchase.paddleTransactionId || purchase.id,
      hasInvoice: Boolean(purchase.paddleTransactionId && ['COMPLETED', 'BILLED', 'READY'].includes(statusText)),
      paddleTransactionId: purchase.paddleTransactionId,
      paddleSubscriptionId: purchase.paddleSubscriptionId,
    };
  });

  return res.json({
    configured: isPaddleConfigured(),
    source: 'local_ledger',
    summary: {
      businessesWithPaddleCustomer,
      paidSubscriptions,
      pastDueSubscriptions,
      scheduledDowngrades,
      ledgerPurchases,
      paymentAttempts,
      adjustments,
      grossByCurrency,
      adjustmentsByCurrency,
    },
    transactions,
    pagination: {
      nextAfter: purchases.length === take ? purchases[purchases.length - 1]?.id || null : null,
    },
  });
}

// POST /api/admin/billing/invoices/:transactionId — temporary Paddle invoice URL
async function billingInvoice(req, res) {
  if (!isPaddleConfigured()) {
    return res.status(500).json({ message: 'Paddle is not configured on the backend.' });
  }

  try {
    const transaction = await getPaddleTransaction(req.params.transactionId);
    if (!invoiceAvailableForTransaction(transaction)) {
      return res.status(409).json({ message: 'A PDF invoice is not available for this payment yet.' });
    }

    const invoice = await getPaddleTransactionInvoice(req.params.transactionId, 'inline');
    if (!invoice?.url) {
      return res.status(502).json({ message: 'Paddle did not return an invoice URL.' });
    }

    return res.json({ url: invoice.url });
  } catch (err) {
    console.error('[billingInvoice] error:', err?.message || err);
    return res.status(err?.status || 500).json({
      message: err?.message || 'Could not load the invoice PDF.',
    });
  }
}

// GET /api/admin/dashboard — full platform analytics for graphical dashboard
async function dashboardAnalytics(req, res) {
  const { businessId, days = 30 } = req.query;
  const daysNum = Math.min(parseInt(days) || 30, 365);
  const since = new Date();
  since.setDate(since.getDate() - daysNum);

  const bizFilter = businessId ? { businessId } : {};

  const [
    dailyBookings,
    hourlyDistribution,
    bookingsByDow,
    statusCounts,
    revenueByService,
    staffPerformance,
    businessLocations,
    topBusinesses,
    customerGrowth,
    bookingDuration,
  ] = await Promise.all([
    // Daily bookings time-series (for line chart)
    prisma.$queryRaw`
      SELECT TO_CHAR(date, 'YYYY-MM-DD') as day, COUNT(*)::int as bookings
      FROM "Appointment"
      WHERE date >= ${since}
      ${businessId ? prisma.$queryRaw`AND "businessId" = ${businessId}` : prisma.$queryRaw``}
      GROUP BY day ORDER BY day
    `.catch(() => []),

    // Hourly distribution (what time do people book?)
    prisma.$queryRaw`
      SELECT CAST(SPLIT_PART("startTime", ':', 1) AS INT) as hour, COUNT(*)::int as count
      FROM "Appointment"
      WHERE date >= ${since} AND status IN ('CONFIRMED', 'COMPLETED')
      ${businessId ? prisma.$queryRaw`AND "businessId" = ${businessId}` : prisma.$queryRaw``}
      GROUP BY hour ORDER BY hour
    `.catch(() => []),

    // Bookings by day of week (bar chart)
    prisma.$queryRaw`
      SELECT EXTRACT(DOW FROM date)::int as dow, COUNT(*)::int as count
      FROM "Appointment"
      WHERE date >= ${since}
      ${businessId ? prisma.$queryRaw`AND "businessId" = ${businessId}` : prisma.$queryRaw``}
      GROUP BY dow ORDER BY dow
    `.catch(() => []),

    // Status distribution (pie chart)
    prisma.appointment.groupBy({
      by: ['status'],
      where: { date: { gte: since }, ...bizFilter },
      _count: { status: true },
    }),

    // Revenue by service (horizontal bar)
    prisma.$queryRaw`
      SELECT s.name, s.price, COUNT(a.id)::int as bookings, (COUNT(a.id) * s.price)::float as revenue
      FROM "Appointment" a JOIN "Service" s ON a."serviceId" = s.id
      WHERE a.date >= ${since} AND a.status IN ('CONFIRMED', 'COMPLETED')
      ${businessId ? prisma.$queryRaw`AND a."businessId" = ${businessId}` : prisma.$queryRaw``}
      GROUP BY s.id, s.name, s.price
      ORDER BY revenue DESC LIMIT 10
    `.catch(() => []),

    // Staff performance (appointments + avg duration)
    prisma.$queryRaw`
      SELECT u.name, COUNT(a.id)::int as appointments,
        ROUND(AVG(
          CAST(SPLIT_PART(a."endTime", ':', 1) AS INT) * 60 +
          CAST(SPLIT_PART(a."endTime", ':', 2) AS INT) -
          CAST(SPLIT_PART(a."startTime", ':', 1) AS INT) * 60 -
          CAST(SPLIT_PART(a."startTime", ':', 2) AS INT)
        ))::int as avg_duration_min
      FROM "Appointment" a JOIN "User" u ON a."staffId" = u.id
      WHERE a.date >= ${since} AND a.status IN ('CONFIRMED', 'COMPLETED')
      ${businessId ? prisma.$queryRaw`AND a."businessId" = ${businessId}` : prisma.$queryRaw``}
      GROUP BY u.id, u.name ORDER BY appointments DESC LIMIT 10
    `.catch(() => []),

    // Business locations (geo-like — address + category + stats)
    prisma.business.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, slug: true, category: true, address: true,
        _count: { select: { appointments: true, customers: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),

    // Top businesses by bookings
    prisma.$queryRaw`
      SELECT b.name, b.slug, b.category, COUNT(a.id)::int as bookings
      FROM "Appointment" a JOIN "Business" b ON a."businessId" = b.id
      WHERE a.date >= ${since}
      GROUP BY b.id, b.name, b.slug, b.category
      ORDER BY bookings DESC LIMIT 10
    `.catch(() => []),

    // Customer growth over time (monthly)
    prisma.$queryRaw`
      SELECT TO_CHAR("createdAt", 'YYYY-MM') as month, COUNT(*)::int as new_customers
      FROM "Customer"
      WHERE "createdAt" >= ${since}
      ${businessId ? prisma.$queryRaw`AND "businessId" = ${businessId}` : prisma.$queryRaw``}
      GROUP BY month ORDER BY month
    `.catch(() => []),

    // Booking duration distribution
    prisma.$queryRaw`
      SELECT
        CASE
          WHEN (CAST(SPLIT_PART("endTime",':',1) AS INT)*60 + CAST(SPLIT_PART("endTime",':',2) AS INT)) -
               (CAST(SPLIT_PART("startTime",':',1) AS INT)*60 + CAST(SPLIT_PART("startTime",':',2) AS INT)) <= 15 THEN '15min'
          WHEN (CAST(SPLIT_PART("endTime",':',1) AS INT)*60 + CAST(SPLIT_PART("endTime",':',2) AS INT)) -
               (CAST(SPLIT_PART("startTime",':',1) AS INT)*60 + CAST(SPLIT_PART("startTime",':',2) AS INT)) <= 30 THEN '30min'
          WHEN (CAST(SPLIT_PART("endTime",':',1) AS INT)*60 + CAST(SPLIT_PART("endTime",':',2) AS INT)) -
               (CAST(SPLIT_PART("startTime",':',1) AS INT)*60 + CAST(SPLIT_PART("startTime",':',2) AS INT)) <= 60 THEN '1hr'
          ELSE '1hr+'
        END as duration_bucket,
        COUNT(*)::int as count
      FROM "Appointment"
      WHERE date >= ${since}
      ${businessId ? prisma.$queryRaw`AND "businessId" = ${businessId}` : prisma.$queryRaw``}
      GROUP BY duration_bucket
    `.catch(() => []),
  ]);

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  res.json({
    period: { days: daysNum, since: since.toISOString() },
    dailyBookings,
    hourlyDistribution: hourlyDistribution.map(h => ({ hour: `${h.hour}:00`, count: h.count })),
    bookingsByDow: bookingsByDow.map(d => ({ day: dayNames[d.dow], count: d.count })),
    statusDistribution: Object.fromEntries(statusCounts.map(s => [s.status, s._count.status])),
    revenueByService,
    staffPerformance,
    businessLocations: businessLocations.map(b => ({
      id: b.id, name: b.name, slug: b.slug, category: b.category,
      address: b.address, appointments: b._count.appointments,
      customers: b._count.customers,
      domain: `${b.slug}.sitepresso.com`,
    })),
    topBusinesses,
    customerGrowth,
    bookingDuration,
  });
}

// GET /api/admin/businesses/:id/analytics — comprehensive per-business stats
async function businessAnalytics(req, res) {
  const { id } = req.params;
  const business = await prisma.business.findUnique({ where: { id }, select: { id: true, name: true, slug: true, createdAt: true } });
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const now = new Date();
  const todayStart = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const weekStart = new Date(todayStart); weekStart.setDate(todayStart.getDate() - todayStart.getDay() + 1);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [
    totalCustomers,
    totalStaff,
    totalAppointments,
    todayAppointments,
    weekAppointments,
    monthAppointments,
    prevMonthAppointments,
    statusBreakdown,
    popularServices,
    staffUtilization,
    recentCustomers,
    appointmentsByDow,
    monthlyTrend,
  ] = await Promise.all([
    // Totals
    prisma.customer.count({ where: { businessId: id } }),
    prisma.user.count({ where: { businessId: id, role: ROLES.STAFF, isActive: true } }),
    prisma.appointment.count({ where: { businessId: id } }),
    prisma.appointment.count({ where: { businessId: id, date: { gte: todayStart } } }),
    prisma.appointment.count({ where: { businessId: id, date: { gte: weekStart } } }),
    prisma.appointment.count({ where: { businessId: id, date: { gte: monthStart } } }),
    prisma.appointment.count({ where: { businessId: id, date: { gte: prevMonthStart, lt: monthStart } } }),

    // Status breakdown
    prisma.appointment.groupBy({
      by: ['status'],
      where: { businessId: id },
      _count: { status: true },
    }),

    // Popular services (top 5)
    prisma.appointment.groupBy({
      by: ['serviceId'],
      where: { businessId: id, status: { in: ['CONFIRMED', 'COMPLETED'] } },
      _count: { serviceId: true },
      orderBy: { _count: { serviceId: 'desc' } },
      take: 5,
    }),

    // Staff utilization (appointments per staff)
    prisma.appointment.groupBy({
      by: ['staffId'],
      where: { businessId: id, status: { in: ['CONFIRMED', 'COMPLETED'] } },
      _count: { staffId: true },
      orderBy: { _count: { staffId: 'desc' } },
    }),

    // Recent customers (last 10)
    prisma.customer.findMany({
      where: { businessId: id },
      select: { id: true, name: true, email: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),

    // Appointments by day of week (for "busiest day" analysis)
    prisma.$queryRaw`
      SELECT EXTRACT(DOW FROM date) as dow, COUNT(*)::int as count
      FROM "Appointment" WHERE "businessId" = ${id}
      GROUP BY dow ORDER BY dow
    `,

    // Monthly trend (last 6 months)
    prisma.$queryRaw`
      SELECT TO_CHAR(date, 'YYYY-MM') as month, COUNT(*)::int as count
      FROM "Appointment" WHERE "businessId" = ${id}
        AND date >= NOW() - INTERVAL '6 months'
      GROUP BY month ORDER BY month
    `,
  ]);

  // Resolve service names for popular services
  const serviceIds = popularServices.map(s => s.serviceId);
  const services = await prisma.service.findMany({
    where: { id: { in: serviceIds } },
    select: { id: true, name: true, price: true },
  });
  const serviceMap = Object.fromEntries(services.map(s => [s.id, s]));

  // Resolve staff names
  const staffIds = staffUtilization.map(s => s.staffId);
  const staffMembers = await prisma.user.findMany({
    where: { id: { in: staffIds } },
    select: { id: true, name: true },
  });
  const staffMap = Object.fromEntries(staffMembers.map(s => [s.id, s]));

  // Estimated revenue (sum of service prices for completed/confirmed)
  const revenueAppts = await prisma.appointment.findMany({
    where: { businessId: id, status: { in: ['CONFIRMED', 'COMPLETED'] } },
    select: { serviceId: true },
  });
  let estimatedRevenue = 0;
  for (const a of revenueAppts) {
    const svc = serviceMap[a.serviceId];
    if (svc) estimatedRevenue += svc.price;
  }

  // Growth rate (this month vs last month)
  const growthRate = prevMonthAppointments > 0
    ? ((monthAppointments - prevMonthAppointments) / prevMonthAppointments * 100).toFixed(1)
    : null;

  // Day names for busiest day
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const busiestDay = appointmentsByDow.length > 0
    ? appointmentsByDow.reduce((a, b) => a.count > b.count ? a : b)
    : null;

  res.json({
    business: { id: business.id, name: business.name, slug: business.slug, memberSince: business.createdAt },
    overview: {
      totalCustomers,
      totalStaff,
      totalAppointments,
      todayAppointments,
      weekAppointments,
      monthAppointments,
      estimatedRevenue: Math.round(estimatedRevenue * 100) / 100,
      growthRate: growthRate ? `${growthRate}%` : 'N/A',
    },
    statusBreakdown: Object.fromEntries(statusBreakdown.map(s => [s.status, s._count.status])),
    popularServices: popularServices.map(s => ({
      name: serviceMap[s.serviceId]?.name || 'Unknown',
      price: serviceMap[s.serviceId]?.price || 0,
      bookings: s._count.serviceId,
    })),
    staffUtilization: staffUtilization.map(s => ({
      name: staffMap[s.staffId]?.name || 'Unknown',
      appointments: s._count.staffId,
    })),
    recentCustomers,
    busiestDay: busiestDay ? { day: dayNames[busiestDay.dow], count: busiestDay.count } : null,
    monthlyTrend,
  });
}

// PUT /api/admin/businesses/:id/suspend — pause or resume a business
async function toggleSuspend(req, res) {
  const { id } = req.params;
  const { suspend, reason } = req.body;

  const business = await prisma.business.findUnique({ where: { id } });
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const updated = await prisma.business.update({
    where: { id },
    data: {
      isActive: !suspend,
      suspendedReason: suspend ? (reason || 'Suspended by platform admin') : null,
      suspendedAt: suspend ? new Date() : null,
    },
    select: { id: true, name: true, slug: true, isActive: true, suspendedReason: true, suspendedAt: true },
  });

  console.log(`Business ${updated.name} (${updated.slug}) ${suspend ? 'SUSPENDED' : 'RESUMED'} by admin`);
  res.json({ business: updated });
}

// DELETE /api/admin/businesses/:id — permanently delete a business and all its
// linked data (users, appointments, products, pages, etc.). Cascade rules in
// schema.prisma do the heavy lifting; we just delete the Business row.
// Caller must include `?confirmSlug=<slug>` matching the target — last-chance
// safety against accidental destructive clicks.
async function deleteBusiness(req, res) {
  const { id } = req.params;
  const confirmSlug = String(req.query.confirmSlug || '').trim();

  const business = await prisma.business.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, _count: { select: { users: true, appointments: true } } },
  });
  if (!business) return res.status(404).json({ message: 'Business not found' });

  if (!confirmSlug || confirmSlug !== business.slug) {
    return res.status(400).json({
      message: 'confirmSlug query param must match the business slug exactly',
      expected: business.slug,
    });
  }

  // Active-subscription guard — a tenant that's currently paying can't be deleted
  // (by super-admin OR self-serve). Cancel it / let the period lapse first; once
  // the subscription is over, delete is allowed.
  const sub = await prisma.subscription.findUnique({
    where: { businessId: id },
    include: { tier: { select: { slug: true } } },
  });
  const FREE_TIER_SLUGS = new Set(['free', 'static-free', 'ecom-free', 'trial']);
  const accessState = sub ? billingAccessState({ subscription: sub }).state : 'none';
  const hasActivePaidSub = sub
    && (accessState === 'active' || accessState === 'grace')
    && sub.tier && !FREE_TIER_SLUGS.has(sub.tier.slug);
  if (hasActivePaidSub) {
    return res.status(409).json({
      message: 'This tenant has an active subscription and can’t be deleted. Cancel it (or wait until the current billing period ends), then delete.',
      code: 'active_subscription',
    });
  }

  // Stop billing before the cascade delete (C10): superadmin hard-delete never
  // cancelled the subscription, so deleted tenants kept being charged. Cancel on
  // whatever gateway the tenant sits on (Paddle / Stripe / Razorpay).
  await cancelBusinessSubscription(id, { reason: 'superadmin_delete' });

  await prisma.business.delete({ where: { id } });
  console.log(
    `[superadmin] Business ${business.name} (${business.slug}) DELETED — cascaded ${business._count.users} users + ${business._count.appointments} appointments`,
  );
  res.json({
    deleted: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      users: business._count.users,
      appointments: business._count.appointments,
    },
  });
}

// GET /api/admin/settings — get all system settings
async function getSettings(req, res) {
  const rows = await prisma.systemSetting.findMany({
    where: { NOT: { key: { startsWith: '_internal.' } } },
  });
  const settings = {};
  rows.forEach((r) => { settings[r.key] = r.value; });
  // Mask sensitive values
  if (settings.VERCEL_TOKEN) settings.VERCEL_TOKEN = settings.VERCEL_TOKEN.slice(0, 8) + '...' + settings.VERCEL_TOKEN.slice(-4);
  res.json({ settings });
}

// PUT /api/admin/settings — update a system setting
async function updateSetting(req, res) {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ message: 'Key is required' });

  const ALLOWED_KEYS = ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_BUSINESS_PROJECT_ID', 'PRICING_CONFIG'];
  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(400).json({ message: `Key must be one of: ${ALLOWED_KEYS.join(', ')}` });
  }

  if (!value || !value.trim()) {
    // Delete the setting
    await prisma.systemSetting.deleteMany({ where: { key } });
    return res.json({ message: `${key} removed` });
  }

  await prisma.systemSetting.upsert({
    where: { key },
    update: { value: value.trim() },
    create: { key, value: value.trim() },
  });
  res.json({ message: `${key} updated` });
}

module.exports = {
  emailDeliveryActivity,
  billingActivity,
  billingInvoice,
  listBusinesses,
  stats,
  dashboardAnalytics,
  businessAnalytics,
  toggleSuspend,
  deleteBusiness,
  getSettings,
  updateSetting,
};
