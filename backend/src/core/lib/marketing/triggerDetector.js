// Trigger detection — runs hourly, finds candidates whose conditions
// match an enabled AutomationCampaign, and creates PENDING
// AutomationEnrollment rows. The send dispatcher (every 5 min) picks
// up due enrollments and routes them through the smart channel router.
//
// Idempotent: AutomationEnrollment has a compound unique index on
// (businessId, campaignId, customerId, triggeredAt, triggerSourceId)
// so repeated cron runs won't double-enroll the same trigger.
//
// Frequency caps + opt-out checks happen at SEND time (in the dispatcher),
// so the trigger detector can be aggressive about creating enrollments —
// they get marked SUPPRESSED if a cap is hit, leaving an audit trail.
'use strict';

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { CAMPAIGNS_BY_KEY } = require('./campaigns');

// Compute when a campaign should fire given a trigger time.
function computeScheduledFor({ campaignKey, customDelayHours, triggeredAt }) {
  const def = CAMPAIGNS_BY_KEY[campaignKey];
  if (!def) return new Date(triggeredAt);
  const hours = customDelayHours ?? def.delayHours ?? 0;
  const out = new Date(triggeredAt);
  out.setTime(out.getTime() + hours * 3600 * 1000);
  return out;
}

// Helper: enroll a recipient in a campaign. Idempotent.
async function enrollOnce({
  businessId,
  campaign,
  customerId,
  recipientEmail,
  recipientPhone,
  recipientName,
  triggeredAt,
  triggerSourceId,
  variables,
}) {
  const scheduledFor = computeScheduledFor({
    campaignKey: campaign.campaignKey,
    customDelayHours: campaign.delayHoursOverride,
    triggeredAt,
  });
  try {
    await prisma.automationEnrollment.create({
      data: {
        businessId,
        campaignId: campaign.id,
        customerId,
        recipientEmail,
        recipientPhone,
        recipientName,
        triggeredAt,
        scheduledFor,
        status: 'PENDING',
        variables: variables || null,
        triggerSourceId,
      },
    });
    return { created: true };
  } catch (err) {
    // Unique constraint violation = already enrolled. Idempotent skip.
    if (err.code === 'P2002') return { created: false, reason: 'ALREADY_ENROLLED' };
    throw err;
  }
}

// =============================================================================
// Trigger: BIRTHDAY — fires once per year on customer's birthday (month/day match)
// =============================================================================
async function detectBirthday({ businessId, campaign, now }) {
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  // Pull customers with DOB matching today (regardless of year).
  const customers = await prisma.$queryRaw`
    SELECT id, email, phone, name FROM "Customer"
    WHERE "businessId" = ${businessId}
      AND "dateOfBirth" IS NOT NULL
      AND EXTRACT(MONTH FROM "dateOfBirth") = ${month}
      AND EXTRACT(DAY FROM "dateOfBirth") = ${day}
      AND "isActive" = true
  `;
  let n = 0;
  for (const c of customers) {
    await enrollOnce({
      businessId,
      campaign,
      customerId: c.id,
      recipientEmail: c.email,
      recipientPhone: c.phone,
      recipientName: c.name,
      // Truncate to UTC midnight so re-runs the same day don't double-enroll.
      triggeredAt: new Date(Date.UTC(now.getUTCFullYear(), month - 1, day)),
      triggerSourceId: `BIRTHDAY_${now.getUTCFullYear()}_${month}_${day}`,
    });
    n++;
  }
  return n;
}

// =============================================================================
// Trigger: APPOINTMENT_COMPLETED — fires when an appointment hits status=COMPLETED
// =============================================================================
async function detectPostVisit({ businessId, campaign, now }) {
  // Find COMPLETED appointments in the last 24h that haven't been enrolled yet.
  // The unique index on (businessId, campaignId, customerId, triggeredAt,
  // triggerSourceId=appointmentId) makes this idempotent.
  const since = new Date(now);
  since.setUTCHours(since.getUTCHours() - 25); // small overlap to catch races
  const appts = await prisma.appointment.findMany({
    where: {
      businessId,
      status: 'COMPLETED',
      updatedAt: { gte: since },
      customerId: { not: null },
    },
    select: {
      id: true,
      customerId: true,
      updatedAt: true,
      customer: { select: { id: true, email: true, phone: true, name: true } },
      staff:    { select: { name: true } },
    },
  });
  let n = 0;
  for (const a of appts) {
    if (!a.customer) continue;
    await enrollOnce({
      businessId,
      campaign,
      customerId: a.customer.id,
      recipientEmail: a.customer.email,
      recipientPhone: a.customer.phone,
      recipientName: a.customer.name,
      triggeredAt: a.updatedAt,
      triggerSourceId: `APPT_${a.id}`,
      variables: { STAFF: a.staff?.name || '' },
    });
    n++;
  }
  return n;
}

// =============================================================================
// Trigger: APPOINTMENT_NO_SHOW — fires when an appt was marked CANCELLED for no-show
// =============================================================================
async function detectNoShow({ businessId, campaign, now }) {
  const since = new Date(now);
  since.setUTCHours(since.getUTCHours() - 25);
  // We treat any CANCELLED appointment older than 7 days as eligible —
  // dispatcher delays the send. Only customers we have email/phone for.
  const appts = await prisma.appointment.findMany({
    where: {
      businessId,
      status: 'CANCELLED',
      updatedAt: { gte: since },
      customerId: { not: null },
    },
    select: {
      id: true,
      customerId: true,
      startTime: true,
      updatedAt: true,
      customer: { select: { id: true, email: true, phone: true, name: true } },
    },
  });
  let n = 0;
  for (const a of appts) {
    if (!a.customer) continue;
    const dateOfVisit = a.startTime ? a.startTime.toISOString().slice(0, 10) : '';
    await enrollOnce({
      businessId,
      campaign,
      customerId: a.customer.id,
      recipientEmail: a.customer.email,
      recipientPhone: a.customer.phone,
      recipientName: a.customer.name,
      triggeredAt: a.updatedAt,
      triggerSourceId: `APPT_${a.id}`,
      variables: { DATE_OF_VISIT: dateOfVisit },
    });
    n++;
  }
  return n;
}

// =============================================================================
// Trigger: CUSTOMER_LAPSED — 90 days since last appointment, no upcoming
// =============================================================================
async function detectLapsed({ businessId, campaign, now }) {
  // Customers whose last appointment was 85-95 days ago (small window to
  // avoid catching everyone "lapsed" on first run; we widen if needed).
  const lo = new Date(now); lo.setUTCDate(lo.getUTCDate() - 95);
  const hi = new Date(now); hi.setUTCDate(hi.getUTCDate() - 85);

  const lapsed = await prisma.$queryRaw`
    SELECT c.id, c.email, c.phone, c.name, MAX(a."startTime") as "lastVisit"
    FROM "Customer" c
    INNER JOIN "Appointment" a ON a."customerId" = c.id
    WHERE c."businessId" = ${businessId}
      AND a.status = 'COMPLETED'
      AND c."isActive" = true
    GROUP BY c.id
    HAVING MAX(a."startTime") BETWEEN ${lo} AND ${hi}
       AND NOT EXISTS (
         SELECT 1 FROM "Appointment" upcoming
         WHERE upcoming."customerId" = c.id
           AND upcoming."startTime" > ${now}
           AND upcoming.status NOT IN ('CANCELLED','COMPLETED')
       )
  `;
  let n = 0;
  for (const c of lapsed) {
    await enrollOnce({
      businessId,
      campaign,
      customerId: c.id,
      recipientEmail: c.email,
      recipientPhone: c.phone,
      recipientName: c.name,
      // Bucket per UTC week so a customer doesn't get re-enrolled day after day.
      triggeredAt: new Date(Math.floor(now.getTime() / (7 * 86400 * 1000)) * 7 * 86400 * 1000),
      triggerSourceId: 'LAPSED_90D',
    });
    n++;
  }
  return n;
}

// =============================================================================
// Trigger: CUSTOMER_ANNIVERSARY — 365 days since first appointment
// =============================================================================
async function detectAnniversary({ businessId, campaign, now }) {
  // Customers whose oldest appointment is exactly 365±1 days old.
  const lo = new Date(now); lo.setUTCDate(lo.getUTCDate() - 366);
  const hi = new Date(now); hi.setUTCDate(hi.getUTCDate() - 364);

  const anniv = await prisma.$queryRaw`
    SELECT c.id, c.email, c.phone, c.name, MIN(a."startTime") as "firstVisit"
    FROM "Customer" c
    INNER JOIN "Appointment" a ON a."customerId" = c.id
    WHERE c."businessId" = ${businessId}
      AND a.status IN ('COMPLETED', 'CONFIRMED')
      AND c."isActive" = true
    GROUP BY c.id
    HAVING MIN(a."startTime") BETWEEN ${lo} AND ${hi}
  `;
  let n = 0;
  for (const c of anniv) {
    await enrollOnce({
      businessId,
      campaign,
      customerId: c.id,
      recipientEmail: c.email,
      recipientPhone: c.phone,
      recipientName: c.name,
      triggeredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
      triggerSourceId: 'ANNIVERSARY_1Y',
    });
    n++;
  }
  return n;
}

// =============================================================================
// Trigger: ABANDONED_CART — carts with items but no recent checkout
// =============================================================================
async function detectAbandonedCart({ businessId, campaign, now }) {
  // Carts with items, last updated 1-24h ago, customer has email,
  // and no order created from this cart.
  const lo = new Date(now); lo.setUTCHours(lo.getUTCHours() - 24);
  const hi = new Date(now); hi.setUTCHours(hi.getUTCHours() - 1);

  const carts = await prisma.cart.findMany({
    where: {
      businessId,
      updatedAt: { gte: lo, lte: hi },
      customerId: { not: null },
      items: { some: {} },
    },
    include: {
      customer: { select: { id: true, email: true, phone: true, name: true } },
      items: { select: { id: true } },
    },
    take: 200,
  });

  let n = 0;
  for (const c of carts) {
    if (!c.customer || !c.customer.email) continue;
    await enrollOnce({
      businessId,
      campaign,
      customerId: c.customer.id,
      recipientEmail: c.customer.email,
      recipientPhone: c.customer.phone,
      recipientName: c.customer.name,
      triggeredAt: c.updatedAt,
      triggerSourceId: `CART_${c.id}`,
      variables: { ITEM_COUNT: String(c.items.length) },
    });
    n++;
  }
  return n;
}

// =============================================================================
// Trigger: APPOINTMENT_MILESTONE — when the count crosses 5/10/25/50/100
// =============================================================================
async function detectMilestone({ businessId, campaign, now }) {
  const milestones = CAMPAIGNS_BY_KEY.LOYALTY_MILESTONE.milestones || [5, 10, 25, 50, 100];
  // We look at COMPLETED appointments updated in the last 25h — the trigger
  // fires when the *latest* completed appointment makes the count cross a
  // milestone.
  const since = new Date(now);
  since.setUTCHours(since.getUTCHours() - 25);
  const recentCompleted = await prisma.appointment.findMany({
    where: {
      businessId,
      status: 'COMPLETED',
      updatedAt: { gte: since },
      customerId: { not: null },
    },
    select: {
      id: true,
      customerId: true,
      updatedAt: true,
      customer: { select: { id: true, email: true, phone: true, name: true } },
    },
  });
  let n = 0;
  for (const a of recentCompleted) {
    if (!a.customer) continue;
    const totalCount = await prisma.appointment.count({
      where: {
        businessId,
        customerId: a.customerId,
        status: 'COMPLETED',
      },
    });
    if (!milestones.includes(totalCount)) continue;
    await enrollOnce({
      businessId,
      campaign,
      customerId: a.customer.id,
      recipientEmail: a.customer.email,
      recipientPhone: a.customer.phone,
      recipientName: a.customer.name,
      triggeredAt: a.updatedAt,
      triggerSourceId: `MILESTONE_${totalCount}`,
      variables: { VISIT_COUNT: String(totalCount), GIFT_LABEL: 'small treat' },
    });
    n++;
  }
  return n;
}

// =============================================================================
// Public — process all enabled campaigns for all businesses
// =============================================================================
async function detectAll({ now = new Date(), logger = console } = {}) {
  const enabledCampaigns = await prisma.automationCampaign.findMany({
    where: { isEnabled: true },
  });

  const summary = { totalEnrollments: 0, byCampaign: {}, errors: [] };

  for (const camp of enabledCampaigns) {
    const def = CAMPAIGNS_BY_KEY[camp.campaignKey];
    if (!def) continue;
    let count = 0;
    try {
      switch (def.triggerType) {
        case 'CUSTOMER_BIRTHDAY':       count = await detectBirthday({ businessId: camp.businessId, campaign: camp, now }); break;
        case 'APPOINTMENT_COMPLETED':   count = await detectPostVisit({ businessId: camp.businessId, campaign: camp, now }); break;
        case 'APPOINTMENT_NO_SHOW':     count = await detectNoShow({ businessId: camp.businessId, campaign: camp, now }); break;
        case 'CUSTOMER_LAPSED':         count = await detectLapsed({ businessId: camp.businessId, campaign: camp, now }); break;
        case 'CUSTOMER_ANNIVERSARY':    count = await detectAnniversary({ businessId: camp.businessId, campaign: camp, now }); break;
        case 'APPOINTMENT_MILESTONE':   count = await detectMilestone({ businessId: camp.businessId, campaign: camp, now }); break;
        case 'ABANDONED_CART':          count = await detectAbandonedCart({ businessId: camp.businessId, campaign: camp, now }); break;
      }
      summary.totalEnrollments += count;
      summary.byCampaign[camp.campaignKey] = (summary.byCampaign[camp.campaignKey] || 0) + count;
    } catch (err) {
      logger.error?.(`[trigger] ${camp.campaignKey} for business ${camp.businessId}: ${err.message}`);
      summary.errors.push({ campaignKey: camp.campaignKey, businessId: camp.businessId, message: err.message });
    }
  }

  return summary;
}

module.exports = {
  detectAll,
  detectBirthday,
  detectPostVisit,
  detectNoShow,
  detectLapsed,
  detectAnniversary,
  detectMilestone,
  detectAbandonedCart,
  computeScheduledFor,
  enrollOnce,
};
