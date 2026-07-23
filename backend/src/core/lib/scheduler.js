const cron = require('node-cron');
const prisma = require('./prisma');
const { isLaunchFreePeriod } = require('./launchPeriod');
const { isPaidTier } = require('./featuresCatalog');
const { ROLES } = require('./roles');
const { sendBookingReminderEmail, sendStaffInviteReminderEmail, sendTrialExpiringEmail, sendAppointmentAutoCancelledEmail, sendAppointmentReviewRequestEmail, sendOrderReviewRequestEmail } = require('../utils/email');
const { EMAIL_EVENTS } = require('./emailEvents');
const { resolveRecipientLocale } = require('./locale');

// HR operator console login URL for a tenant. Replaces the deleted vertical
// staffPortalUrlForBusiness helper (booking/shop staff portals). All operator
// users (HR/Finance/Manager) sign in at the platform path-based portal.
function staffPortalUrlForBusiness(business, platformBaseUrl) {
  const base = String(platformBaseUrl || '').replace(/\/$/, '');
  const slug = business?.slug;
  return slug ? `${base}/${slug}/staff` : `${base}/business`;
}
const {
  customDomainProvider,
  provisionCustomDomain,
} = require('../controllers/subscription.controller');

function nowInTimezone(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  const h = parts.find((p) => p.type === 'hour')?.value;
  const min = parts.find((p) => p.type === 'minute')?.value;

  return { dateStr: `${y}-${m}-${d}`, hour: Number(h), min: Number(min) };
}

function getNextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function processBookingReminders() {
  try {
    const startRange = new Date(Date.now() - 2 * 86400000);
    const endRange = new Date(Date.now() + 3 * 86400000);

    const appointments = await prisma.appointment.findMany({
      where: {
        status: { in: ['PENDING', 'CONFIRMED'] },
        date: { gte: startRange, lte: endRange },
      },
      include: {
        business: { select: { id: true, name: true, timezone: true, address: true, appointmentReminderConfig: true } },
        service: { select: { name: true } },
        staff: { select: { name: true } },
        customer: { select: { id: true, name: true, email: true, phone: true } },
        user: { select: { id: true, name: true, email: true } },
        reminders: { select: { kind: true } },
      },
    });

    // Multi-channel reminders: fire through the notification router, which picks
    // WhatsApp -> SMS -> email per the business's NotificationConfig. Dedup is an
    // AppointmentReminder row (unique on appointmentId + kind).
    const { sendNotification } = require('./notifications/router');

    for (const appt of appointments) {
      try {
      // Doctor v2 — a single malformed row (null business/date/startTime) must
      // not throw and abort the whole reminder run.
      if (!appt.business || !appt.date || !appt.startTime) continue;
      // Doctor v2 — respect a per-business reminder opt-out.
      if (appt.business.appointmentReminderConfig && appt.business.appointmentReminderConfig.enabled === false) continue;
      const sentKinds = new Set((appt.reminders || []).map((r) => r.kind));
      const tz = appt.business.timezone || 'UTC';
      const { dateStr: currentLocalDay, hour: currentLocalHour } = nowInTimezone(tz);

      const apptLocalDay = appt.date.toISOString().slice(0, 10);
      const apptHour = Number(appt.startTime.split(':')[0]);

      const recipientEmail = appt.customer?.email || appt.user?.email || null;
      const recipientPhone = appt.customer?.phone || null;
      const recipientName = appt.customer?.name || appt.user?.name || 'there';
      if (!recipientEmail && !recipientPhone) continue;

      // Send one reminder (kind) at most once. Terminal failures (opt-out, no
      // channel, missing config) record a SKIPPED row so we don't retry forever;
      // transient failures leave no row so the next cron run retries.
      const fire = async (kind, templateKey, variables) => {
        if (sentKinds.has(kind)) return;
        let result;
        try {
          result = await sendNotification({
            businessId: appt.business.id, recipientPhone, recipientEmail,
            templateKey, variables, triggeredBy: 'BOOKING_REMINDER', appointmentId: appt.id,
          });
        } catch (e) {
          console.error(`reminder ${appt.id}/${kind} error:`, e.message);
          return;
        }
        const terminal = ['OPTED_OUT', 'NO_VIABLE_CHANNEL', 'UNKNOWN_TEMPLATE', 'CONFIG_MISSING'].includes(result?.reason);
        if (!result?.ok && !terminal) {
          console.error(`reminder ${appt.id}/${kind} failed:`, result?.reason);
          return;
        }
        await prisma.appointmentReminder.create({
          data: {
            appointmentId: appt.id, businessId: appt.business.id, kind,
            channel: result?.channel || 'AUTO', scheduledFor: new Date(),
            sentAt: result?.ok ? new Date() : null,
            status: result?.ok ? 'SENT' : 'SKIPPED',
            error: result?.ok ? null : String(result?.reason || '').slice(0, 200),
          },
        }).catch(() => { /* unique race / cancelled appt */ });
        sentKinds.add(kind);
      };

      // Day-before (~24h): tomorrow is the appointment day and we've reached the hour.
      if (getNextDay(currentLocalDay) === apptLocalDay && currentLocalHour >= apptHour - 1) {
        await fire('DAY_BEFORE', 'REMINDER_DAY_BEFORE', { NAME: recipientName, BIZ: appt.business.name, TIME: appt.startTime });
      }

      // Hour-of (~within 2h on the appointment day).
      if (currentLocalDay === apptLocalDay && apptHour - currentLocalHour <= 2 && apptHour - currentLocalHour >= 0) {
        await fire('HOUR_OF', 'REMINDER_HOUR_OF', { BIZ: appt.business.name, TIME: appt.startTime });
      }
      } catch (e) {
        console.error(`[reminders] appt ${appt?.id} skipped:`, e.message);
      }
    }
  } catch (error) {
    console.error('Error in processBookingReminders:', error.message);
  }
}

/**
 * Auto-cancel PENDING appointments whose start time has already passed.
 *
 * Business-logic: a booking that was never confirmed by the time the slot
 * arrived is effectively a no-go. Leaving it sitting in PENDING forever
 * clutters the admin dashboard and leaves the customer wondering. We flip
 * it to CANCELLED and email the customer an apology + a "book again" link.
 *
 * Guards:
 * - Only PENDING → CANCELLED. Confirmed / completed / no-show / already-
 *   cancelled are never touched.
 * - Grace period of 5 minutes past the start so a last-second confirm
 *   doesn't race with the cron tick.
 * - Only customers who have an email on file get notified; others are just
 *   silently cancelled (they were probably booked manually by staff).
 * - sendTrackedEmail dedupes on eventKey + appointmentId so even if the
 *   cron fires twice, the apology email only goes out once per appointment.
 */
async function processAutoCancellations() {
  try {
    const graceMs = 5 * 60 * 1000;
    const cutoff = new Date(Date.now() - graceMs);

    // Candidates: PENDING appointments that started before `cutoff`.
    // We compare against the full start-of-day + startTime so we correctly
    // catch slots from earlier today, not just past days.
    const candidates = await prisma.appointment.findMany({
      where: {
        status: 'PENDING',
        date: { lte: new Date(Date.now() + 24 * 60 * 60 * 1000) }, // look at today + earlier
      },
      include: {
        business: { select: { id: true, name: true, slug: true, timezone: true } },
        service: { select: { name: true } },
        staff: { select: { name: true } },
        customer: { select: { id: true, name: true, email: true, preferredLanguage: true } },
        user: { select: { id: true, name: true, email: true, preferredLanguage: true } },
      },
    });

    for (const appt of candidates) {
      const [h, m] = (appt.startTime || '00:00').split(':').map(Number);
      // Appointment.date stored as UTC-midnight of the local date; add the
      // HH:MM offset to get the actual slot start, then interpret in the
      // business's timezone via the string trick.
      const apptDateStr = appt.date.toISOString().slice(0, 10);
      const localWall = new Date(`${apptDateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
      // Approximate: Prisma stored DateTime is UTC-midnight, so localWall
      // is in server-local time. Convert to real-UTC by subtracting the
      // timezone offset.
      const slotStartUtcMs = Date.UTC(
        Number(apptDateStr.slice(0, 4)),
        Number(apptDateStr.slice(5, 7)) - 1,
        Number(apptDateStr.slice(8, 10)),
        h,
        m,
        0,
      );
      // `slotStartUtcMs` is actually "slot start in business-local wall
      // time interpreted as UTC". For the cron check we compare to `Date.now()`
      // interpreted the same way: if the business is in UTC+5, their 2pm slot
      // is our 2pm-UTC in this calc. We pull the business TZ offset from Intl.
      const tz = appt.business?.timezone || 'UTC';
      const offsetMinutes = getTimezoneOffsetMinutes(tz, new Date(slotStartUtcMs));
      const trueSlotStartMs = slotStartUtcMs - offsetMinutes * 60 * 1000;

      if (trueSlotStartMs > cutoff.getTime()) continue; // not yet due

      // Flip to CANCELLED.
      await prisma.appointment.update({
        where: { id: appt.id },
        data: { status: 'CANCELLED' },
      }).catch((e) => console.error(`[AutoCancel] update failed for ${appt.id}:`, e.message));

      // Notify the customer. Silent no-op if no email on file.
      const recipientEmail = appt.customer?.email || appt.user?.email;
      if (!recipientEmail) continue;
      const recipientName = appt.customer?.name || appt.user?.name || 'Customer';
      const recipientLocale = resolveRecipientLocale({ customer: appt.customer, user: appt.user, business: appt.business });

      await sendAppointmentAutoCancelledEmail(recipientEmail, {
        userName:      recipientName,
        businessName:  appt.business.name,
        businessId:    appt.business.id,
        businessSlug:  appt.business.slug,
        serviceName:   appt.service?.name || 'Appointment',
        staffName:     appt.staff?.name || '',
        date:          apptDateStr,
        startTime:     appt.startTime,
        endTime:       appt.endTime,
        appointmentId: appt.id,
        customerId:    appt.customer?.id || null,
        userId:        appt.user?.id || null,
        locale:        recipientLocale,
      }).catch((e) => console.error(`[AutoCancel] email failed for ${appt.id}:`, e.message));

      console.log(`[AutoCancel] ${appt.id} (${appt.business.name}) — ${apptDateStr} ${appt.startTime}`);
    }
  } catch (err) {
    console.error('Error in processAutoCancellations:', err.message);
  }
}

// Minutes offset from UTC for a given IANA tz + moment. Positive = east of UTC.
function getTimezoneOffsetMinutes(tz, date) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const get = (type) => Number(fmt.find((p) => p.type === type)?.value);
    const localMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((localMs - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/**
 * Send a review-request email ~24 hours after an appointment is marked
 * COMPLETED. Business admins opt-in via the `reviewRequestEnabled` flag
 * on Business and configure their review link (Google / Yelp / internal).
 *
 * Guards:
 * - Only COMPLETED status gets a request. PENDING / CONFIRMED / NO_SHOW /
 *   CANCELLED never do.
 * - The appointment's updatedAt (the moment status flipped to COMPLETED)
 *   must be at least 24h ago — gives the customer time to reflect before
 *   we nag them.
 * - Only one email per appointment: EmailDelivery rows with the
 *   APPOINTMENT_REVIEW_REQUEST eventKey are checked up-front to dedupe.
 * - Silent skip if the business has no review link or has toggled
 *   reviewRequestEnabled off.
 * - Silent skip if the customer has no email on file.
 * - Window capped at 14 days old so a long-dormant appointment doesn't
 *   surprise a customer with "how was your visit?" weeks later.
 */
async function processReviewRequests() {
  try {
    const windowStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const windowEnd   = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const candidates = await prisma.appointment.findMany({
      where: {
        status: 'COMPLETED',
        updatedAt: { gte: windowStart, lte: windowEnd },
      },
      include: {
        business: { select: { id: true, name: true, reviewRequestEnabled: true, reviewRequestLink: true, defaultLanguage: true } },
        service:  { select: { name: true } },
        staff:    { select: { name: true } },
        customer: { select: { id: true, name: true, email: true, preferredLanguage: true } },
        user:     { select: { id: true, name: true, email: true, preferredLanguage: true } },
      },
    });
    if (candidates.length === 0) return;

    const sent = await prisma.emailDelivery.findMany({
      where: {
        eventKey: EMAIL_EVENTS.APPOINTMENT_REVIEW_REQUEST,
        appointmentId: { in: candidates.map((a) => a.id) },
      },
      select: { appointmentId: true },
    });
    const sentIds = new Set(sent.map((d) => d.appointmentId));

    for (const appt of candidates) {
      if (sentIds.has(appt.id)) continue;
      if (!appt.business?.reviewRequestEnabled) continue;
      if (!appt.business?.reviewRequestLink) continue;

      const recipientEmail = appt.customer?.email || appt.user?.email;
      if (!recipientEmail) continue;
      const recipientName = appt.customer?.name || appt.user?.name || 'Customer';
      const recipientLocale = resolveRecipientLocale({ customer: appt.customer, user: appt.user, business: appt.business });

      await sendAppointmentReviewRequestEmail(recipientEmail, {
        userName:      recipientName,
        businessName:  appt.business.name,
        businessId:    appt.business.id,
        reviewLink:    appt.business.reviewRequestLink,
        serviceName:   appt.service?.name || 'Appointment',
        staffName:     appt.staff?.name || '',
        date:          appt.date.toISOString().slice(0, 10),
        appointmentId: appt.id,
        customerId:    appt.customer?.id || null,
        userId:        appt.user?.id || null,
        locale:        recipientLocale,
      }).catch((e) => console.error(`[ReviewRequest] email failed for ${appt.id}:`, e.message));

      console.log(`[ReviewRequest] sent to ${recipientEmail} for appointment ${appt.id}`);
    }
  } catch (err) {
    console.error('Error in processReviewRequests:', err.message);
  }
}

// Ecommerce counterpart of processReviewRequests: 24h–14d after an order is
// DELIVERED, email the buyer a review request (gated on the same Business
// reviewRequestEnabled + reviewRequestLink). Deduped per order via the
// ORDER_REVIEW_REQUEST EmailDelivery metadata.orderId.
async function processOrderReviewRequests() {
  try {
    const windowStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const windowEnd   = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const candidates = await prisma.order.findMany({
      where: { status: 'DELIVERED', deliveredAt: { gte: windowStart, lte: windowEnd } },
      include: {
        business: { select: { id: true, name: true, reviewRequestEnabled: true, reviewRequestLink: true, defaultLanguage: true } },
      },
    });
    if (candidates.length === 0) return;

    const sent = await prisma.emailDelivery.findMany({
      where: { eventKey: EMAIL_EVENTS.ORDER_REVIEW_REQUEST, createdAt: { gte: windowStart } },
      select: { metadata: true },
    });
    const sentOrderIds = new Set(sent.map((d) => d.metadata?.orderId).filter(Boolean));

    for (const order of candidates) {
      if (sentOrderIds.has(order.id)) continue;
      if (!order.business?.reviewRequestEnabled) continue;
      if (!order.business?.reviewRequestLink) continue;
      const recipientEmail = order.customerEmail;
      if (!recipientEmail) continue;

      const recipientLocale = resolveRecipientLocale({ business: order.business });
      await sendOrderReviewRequestEmail(recipientEmail, {
        userName:     order.customerName || 'Customer',
        businessName: order.business.name,
        businessId:   order.business.id,
        reviewLink:   order.business.reviewRequestLink,
        serviceName:  'your recent order',
        date:         (order.deliveredAt || order.placedAt || new Date()).toISOString().slice(0, 10),
        orderId:      order.id,
        customerId:   order.customerId || null,
        locale:       recipientLocale,
      }).catch((e) => console.error(`[OrderReviewRequest] email failed for ${order.id}:`, e.message));

      sentOrderIds.add(order.id);
      console.log(`[OrderReviewRequest] sent to ${recipientEmail} for order ${order.id}`);
    }
  } catch (err) {
    console.error('Error in processOrderReviewRequests:', err.message);
  }
}

async function processStaffInviteReminders() {
  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const pendingStaff = await prisma.user.findMany({
      where: {
        role: ROLES.STAFF,
        isActive: true,
        createdAt: {
          lte: twoDaysAgo,
          gte: threeDaysAgo,
        },
        // A simple heuristic for "never logged in": no lastLogin field exists in this schema, 
        // so we check if they've had the reminder sent. 
        // Ideally we'd also check if they haven't verified or logged in, 
        // but since we lack a lastLogin field, we will just rely on the fact that if they are active, they might be logged in.
        // Wait, the schema has no lastLogin. We will just send it if they were created 2 days ago and no reminder was sent.
        // To be safe, we'll assume they need a reminder.
      },
      include: {
        business: { select: { id: true, name: true, slug: true, vertical: true } },
      },
    });

    const deliveries = await prisma.emailDelivery.findMany({
      where: {
        eventKey: EMAIL_EVENTS.STAFF_INVITE_REMINDER,
        userId: { in: pendingStaff.map((s) => s.id) },
      },
      select: { userId: true },
    });

    const sentUserIds = new Set(deliveries.map((d) => d.userId));

    for (const staff of pendingStaff) {
      if (sentUserIds.has(staff.id) || !staff.business) continue;

      const platformDomain = process.env.PLATFORM_DOMAIN || 'sitepresso.com';
      const platformBaseUrl = (process.env.NEXT_PUBLIC_PLATFORM_URL || process.env.FRONTEND_URL || `https://${platformDomain}`).replace(/\/$/, '');
      const loginUrl = staffPortalUrlForBusiness(staff.business, platformBaseUrl);

      await sendStaffInviteReminderEmail(staff.email, staff.name, loginUrl, {
        businessName: staff.business.name,
        businessId: staff.business.id,
        userId: staff.id,
      }).catch(e => console.error(`Failed to send staff invite reminder to ${staff.id}:`, e.message));
    }
  } catch (error) {
    console.error('Error in processStaffInviteReminders:', error.message);
  }
}

/**
 * Legacy app-level no-card trial expiry. Public trials are now Paddle
 * card-required trials; this job is retained only to clean up old rows that
 * have trial dates but no Paddle subscription.
 *
 * Email notification deferred — copy + cadence is a product decision the
 * user wants to review. For now, downgrade silently and rely on the in-app
 * banner (TrialBanner component) to show "trial ended, you're on Free".
 *
 * Idempotent: once downgraded the trialConvertedAt stays NULL but the cron
 * skips them via tier slug check ("already on free, no work to do").
 */
async function processTrialExpiry() {
  if (isLaunchFreePeriod()) {
    console.log('[processTrialExpiry] Launch free period active — skipping trial downgrade.');
    return;
  }
  try {
    const now = new Date();
    const expired = await prisma.subscription.findMany({
      where: {
        trialEndsAt: { lt: now },
        trialConvertedAt: null,
        // Only downgrade GATEWAY-LESS trials. A trial backed by a gateway
        // subscription (Paddle/Stripe/Razorpay) is converted (or cancelled) by
        // that gateway's webhook — force-downgrading it here would yank a paying
        // customer to free the moment their first charge's webhook lags past
        // the local trialEndsAt. (B2)
        paddleSubscriptionId: null,
        stripeSubscriptionId: null,
        razorpaySubscriptionId: null,
      },
      include: {
        tier: { select: { slug: true } },
        business: { select: { id: true, name: true, vertical: true } },
      },
    });
    if (expired.length === 0) return;

    // Downgrade to the free tier that MATCHES each business's vertical (free /
    // static-free / ecom-free) so trial expiry never re-creates a plan-vertical
    // mismatch. Cache per slug.
    const { freeTierSlugForVertical, FREE_TIER_SLUGS } = require('./subscriptionBilling');
    const freeTierCache = new Map();
    async function resolveFreeTier(vertical) {
      const slug = freeTierSlugForVertical(vertical);
      if (!freeTierCache.has(slug)) {
        let t = await prisma.pricingTier.findFirst({ where: { slug, isActive: true }, select: { id: true, slug: true } });
        if (!t) t = await prisma.pricingTier.findFirst({ where: { slug: 'free', isActive: true }, select: { id: true, slug: true } });
        freeTierCache.set(slug, t);
      }
      return freeTierCache.get(slug);
    }

    let downgraded = 0;
    for (const sub of expired) {
      const target = await resolveFreeTier(sub.business?.vertical);
      if (!target) { console.error('[TrialExpiry] No free tier found — cannot downgrade sub', sub.id); continue; }
      // Skip if they're already on the right free tier.
      if (FREE_TIER_SLUGS.has(sub.tier?.slug) && sub.tierId === target.id) continue;

      await prisma.subscription.update({
        where: { id: sub.id },
        data: { tierId: target.id },
      }).catch((e) => console.error(`[TrialExpiry] update failed for sub ${sub.id}:`, e.message));

      console.log(`[TrialExpiry] sub ${sub.id} (${sub.business?.name || 'unknown'}) trial expired → downgraded to Free`);
      downgraded += 1;
    }
    if (downgraded > 0) console.log(`[TrialExpiry] downgraded ${downgraded} expired trial${downgraded === 1 ? '' : 's'} to Free`);
  } catch (err) {
    console.error('Error in processTrialExpiry:', err.message);
  }
}

async function processTrialReminders() {
  try {
    const today = new Date();
    // 3 days from now
    const targetDateStart = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
    targetDateStart.setUTCHours(0, 0, 0, 0);
    const targetDateEnd = new Date(targetDateStart.getTime() + 24 * 60 * 60 * 1000);

    const expiringSubscriptions = await prisma.subscription.findMany({
      where: {
        status: 'TRIALING',
        currentPeriodEnd: {
          gte: targetDateStart,
          lt: targetDateEnd,
        },
      },
      include: {
        business: { select: { id: true, name: true } },
      },
    });

    const deliveries = await prisma.emailDelivery.findMany({
      where: {
        eventKey: EMAIL_EVENTS.TRIAL_EXPIRING,
        businessId: { in: expiringSubscriptions.map(s => s.businessId) },
      },
      select: { businessId: true },
    });

    const sentBusinessIds = new Set(deliveries.map(d => d.businessId));

    for (const sub of expiringSubscriptions) {
      if (sentBusinessIds.has(sub.businessId) || !sub.business) continue;

      const admin = await prisma.user.findFirst({
        where: { businessId: sub.businessId, role: ROLES.BUSINESS_ADMIN },
        select: { name: true, email: true },
      });

      if (admin && admin.email) {
        await sendTrialExpiringEmail(admin.email, admin.name, {
          businessName: sub.business.name,
          businessId: sub.businessId,
        }).catch(e => console.error(`Failed to send trial expiring reminder to ${sub.businessId}:`, e.message));
      }
    }
  } catch (error) {
    console.error('Error in processTrialReminders:', error.message);
  }
}

async function processCustomDomainProvisioning() {
  try {
    const platformDomain = (process.env.PLATFORM_DOMAIN || 'drifthr.com').toLowerCase();
    const pending = await prisma.subscription.findMany({
      where: {
        customDomain: { not: null },
        // Platform subdomains ({slug}.drifthr.com) are provisioned ACTIVE by
        // subdomainProvision; they are NOT tenant-owned custom domains and must
        // never be re-run through the custom-domain TXT challenge (which would
        // downgrade them to PENDING_DNS and take the subdomain offline).
        NOT: { customDomain: { endsWith: `.${platformDomain}` } },
        OR: [
          { customDomainVerified: false },
          // Keep ACTIVE domains in the sweep too. If DNS expires or breaks
          // after launch, the next check marks it as an issue so SEO stops
          // publishing that custom domain instead of serving dead canonicals.
          { customDomainStatus: { in: ['PENDING_DNS', 'PENDING_SSL', 'FAILED', 'ACTIVE'] } },
        ],
      },
      orderBy: { customDomainCheckedAt: 'asc' },
      take: 50,
      include: {
        business: { select: { id: true, slug: true, vertical: true } },
      },
    });

    let activated = 0;
    let checked = 0;
    for (const sub of pending) {
      if (!sub.customDomain || !sub.business) continue;
      checked += 1;

      const provisioning = await provisionCustomDomain({
        domain: sub.customDomain,
        business: sub.business,
        priorSubscription: sub,
      });
      const domainStatus = provisioning.domainStatus || {
        verified: false,
        status: 'PENDING_DNS',
        message: provisioning.suggestion?.message || 'DNS needs one more step before activation.',
      };

      await prisma.subscription.update({
        where: { businessId: sub.businessId },
        data: {
          customHostnameId: provisioning.customHostnameId,
          customDomainVerified: domainStatus.verified,
          customDomainStatus: domainStatus.status,
          customDomainStatusMessage: domainStatus.message,
          customDomainCheckedAt: new Date(),
        },
      });

      if (domainStatus.status === 'ACTIVE') activated += 1;
    }

    if (checked > 0) {
      console.log(`[Scheduler] custom domains checked=${checked} active=${activated}`);
    }
  } catch (error) {
    console.error('[Scheduler] custom domain provisioning failed:', error.message);
  }
}

async function processPaddleWebhookRetries() {
  try {
    if (!prisma.paddleWebhookEvent) return;
    const { processPendingPaddleWebhookEvents } = require('../controllers/paddle.controller');
    const summary = await processPendingPaddleWebhookEvents({ limit: 25 });
    if (summary.processed > 0 || summary.failed > 0) {
      console.log(`[Scheduler] paddle webhooks: ${JSON.stringify(summary)}`);
    }
  } catch (err) {
    console.error('[Scheduler] paddle webhook retry failed:', err.message);
  }
}

async function processStripeWebhookRetries() {
  try {
    if (!prisma.stripeWebhookEvent) return;
    const { processPendingStripeWebhookEvents } = require('../controllers/stripe.controller');
    const summary = await processPendingStripeWebhookEvents({ limit: 25 });
    if (summary.processed > 0 || summary.failed > 0) {
      console.log(`[Scheduler] stripe webhooks: ${JSON.stringify(summary)}`);
    }
  } catch (err) {
    console.error('[Scheduler] stripe webhook retry failed:', err.message);
  }
}

async function reconcileStuckRazorpaySubscriptionsTask() {
  try {
    if (!prisma.subscription) return;
    const { reconcileStuckRazorpaySubscriptions } = require('../controllers/razorpay.controller');
    const summary = await reconcileStuckRazorpaySubscriptions({ limit: 25 });
    if (summary?.reconciled) {
      console.log(`[Scheduler] razorpay reconcile: ${JSON.stringify(summary)}`);
    }
  } catch (err) {
    console.error('[Scheduler] razorpay reconcile failed:', err.message);
  }
}

async function processRazorpayWebhookRetries() {
  try {
    if (!prisma.razorpayWebhookEvent) return;
    const { processPendingRazorpayWebhookEvents } = require('../controllers/razorpay.controller');
    const summary = await processPendingRazorpayWebhookEvents({ limit: 25 });
    if (summary.processed > 0 || summary.failed > 0) {
      console.log(`[Scheduler] razorpay webhooks: ${JSON.stringify(summary)}`);
    }
  } catch (err) {
    console.error('[Scheduler] razorpay webhook retry failed:', err.message);
  }
}

async function processPaddleReconciliation() {
  try {
    const { reconcilePaddleBilling } = require('./paddleReconciliation');
    const summary = await reconcilePaddleBilling({ subscriptionLimit: 50 });
    if (
      summary.subscriptionsChanged > 0
      || summary.skipped
    ) {
      console.log(`[Scheduler] paddle reconcile: ${JSON.stringify(summary)}`);
    }
  } catch (err) {
    console.error('[Scheduler] paddle reconcile failed:', err.message);
  }
}

// C4: old launch-free grants wrote paid tiers with no Paddle subscription.
// When their local period lapses, convert them to the same grace/renew-gate
// path as a failed paid subscription so they cannot become free-forever rows.
async function processLaunchFreeExpiry() {
  if (isLaunchFreePeriod()) return;

  try {
    const { getPastDueGraceDays } = require('./subscriptionBilling');
    const now = new Date();
    const expired = await prisma.subscription.findMany({
      where: {
        paddleSubscriptionId: null,
        currentPeriodEnd: { lte: now },
        status: { in: ['ACTIVE', 'TRIALING'] },
      },
      include: {
        tier: { select: { slug: true } },
        business: { select: { id: true, name: true } },
      },
      take: 100,
    });
    if (!expired.length) return;

    const graceDays = getPastDueGraceDays();
    let transitioned = 0;
    for (const sub of expired) {
      if (!isPaidTier(sub.tier?.slug)) continue;
      const pastDueSince = sub.pastDueSince || sub.currentPeriodEnd || now;
      const accessGraceUntil = graceDays > 0
        ? new Date(new Date(pastDueSince).getTime() + graceDays * 24 * 60 * 60 * 1000)
        : null;
      const ok = await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          status: 'PAST_DUE',
          pastDueSince,
          accessGraceUntil,
        },
      }).then(() => true).catch((e) => {
        console.error(`[LaunchFreeExpiry] update failed for sub ${sub.id}:`, e.message);
        return false;
      });
      if (ok) {
        transitioned += 1;
        console.log(`[LaunchFreeExpiry] ${sub.business?.name || sub.businessId} moved to PAST_DUE grace`);
      }
    }
    if (transitioned > 0) console.log(`[LaunchFreeExpiry] transitioned ${transitioned} launch-free subscription(s)`);
  } catch (err) {
    console.error('[Scheduler] launch-free expiry failed:', err.message);
  }
}

// F10: enforce the past_due dunning grace. Subscriptions kept on their paid tier
// during grace are downgraded to free + EXPIRED once accessGraceUntil lapses,
// even if no further Paddle webhook arrives.
async function expirePastDueGraceSubscriptions() {
  try {
    const { getFreeTierForVertical, FREE_TIER_SLUGS } = require('./subscriptionBilling');
    const expired = await prisma.subscription.findMany({
      where: { status: 'PAST_DUE', accessGraceUntil: { lte: new Date() } },
      select: { businessId: true, tier: { select: { slug: true } }, business: { select: { vertical: true } } },
    });
    if (!expired.length) return;
    const tierCache = new Map();
    async function freeTierFor(vertical) {
      const key = String(vertical || '').toUpperCase();
      if (!tierCache.has(key)) tierCache.set(key, await getFreeTierForVertical(vertical));
      return tierCache.get(key);
    }
    let downgraded = 0;
    for (const sub of expired) {
      if (FREE_TIER_SLUGS.has(sub.tier?.slug)) continue; // already on a free tier
      const target = await freeTierFor(sub.business?.vertical);
      if (!target) continue;
      const ok = await prisma.subscription.update({
        where: { businessId: sub.businessId },
        data: { tierId: target.id, status: 'EXPIRED', accessGraceUntil: null },
      }).then(() => true).catch(() => false);
      if (ok) downgraded += 1;
    }
    if (downgraded > 0) console.log(`[Scheduler] past_due grace expired: downgraded ${downgraded} subscription(s)`);
  } catch (err) {
    console.error('[Scheduler] past_due grace expiry failed:', err.message);
  }
}

async function processPendingPlanChanges() {
  try {
    const due = await prisma.subscription.findMany({
      where: {
        pendingTierSlug: { not: null },
        pendingChangeEffectiveAt: { lte: new Date() },
      },
      select: {
        id: true,
        businessId: true,
        status: true,
        pendingTierSlug: true,
        pendingBillingCycle: true,
        pendingChangeEffectiveAt: true,
        pendingVertical: true,
        business: { select: { name: true } },
      },
      take: 100,
    });
    if (!due.length) return;

    let applied = 0;
    for (const sub of due) {
      const tier = await prisma.pricingTier.findUnique({
        where: { slug: sub.pendingTierSlug },
        select: { id: true, slug: true },
      }).catch(() => null);
      if (!tier) {
        console.error(`[Scheduler] pending plan change skipped; tier ${sub.pendingTierSlug} not found for ${sub.businessId}`);
        continue;
      }
      // Apply the scheduled tier/cycle, but NEVER re-activate a sub that lapsed
      // (PAST_DUE / PAUSED / CANCELLED) before its effective date — forcing
      // status:'ACTIVE' there would re-grant paid access with no payment and
      // override dunning. Only stamp ACTIVE for an already-entitling sub. (B3)
      const curStatus = String(sub.status || '').toUpperCase();
      const reactivate = curStatus === 'ACTIVE' || curStatus === 'TRIALING';
      const ok = await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          tierId: tier.id,
          billingCycle: sub.pendingBillingCycle || undefined,
          ...(reactivate ? { status: 'ACTIVE' } : {}),
          pendingTierSlug: null,
          pendingBillingCycle: null,
          pendingChangeEffectiveAt: null,
          pendingVertical: null,
        },
      }).then(() => true).catch((err) => {
        console.error(`[Scheduler] pending plan change failed for ${sub.businessId}:`, err.message);
        return false;
      });
      // Apply a scheduled vertical change too, rather than silently dropping it
      // when nulling pendingVertical. Latent today (cross-vertical changes are
      // blocked at selectPlan) but plumbed through every scheduled branch. (B12)
      if (ok && sub.pendingVertical) {
        await prisma.business.update({ where: { id: sub.businessId }, data: { vertical: sub.pendingVertical } })
          .catch((err) => console.error(`[Scheduler] pending vertical change failed for ${sub.businessId}:`, err.message));
      }
      if (ok) {
        applied += 1;
        console.log(`[Scheduler] pending plan change applied: ${sub.business?.name || sub.businessId} → ${tier.slug}`);
      }
    }
    if (applied > 0) console.log(`[Scheduler] applied ${applied} pending plan change(s)`);
  } catch (err) {
    console.error('[Scheduler] pending plan change sweep failed:', err.message);
  }
}

// Water-purifier AMC: remind customers of an upcoming/overdue service visit
// (filter replacement). Daily; deduped via ServiceVisit.reminderSentAt so a
// customer is reminded at most once per scheduled visit.
async function processServiceVisitReminders() {
  try {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const horizon = new Date(Date.now() + 3 * 86400000);
    const visits = await prisma.serviceVisit.findMany({
      where: { status: { in: ['SCHEDULED', 'ASSIGNED'] }, reminderSentAt: null, dueBy: { not: null, lte: horizon } },
      take: 500,
      include: {
        business: { select: { name: true, subscription: { select: { theme: true } } } },
        amcContract: { select: { contractNumber: true, customer: { select: { name: true, email: true } } } },
        installedUnit: { select: { customer: { select: { name: true, email: true } } } },
      },
    });
    const { sendEmail } = require('../utils/email');
    for (const v of visits) {
      if (String(v.business?.subscription?.theme || '').toLowerCase() !== 'water_purifier') continue;
      const cust = v.amcContract?.customer || v.installedUnit?.customer;
      const email = cust?.email;
      if (email && !email.endsWith('@guest.sitepresso.local')) {
        const when = v.scheduledFor || v.dueBy;
        const dateLabel = when ? new Date(when).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'soon';
        try {
          await sendEmail({
            to: email,
            subject: `Service due — ${v.business.name}`,
            html: `<p>Hi ${esc(cust.name || 'there')},</p><p>Your water purifier is due for a ${esc((v.kind || 'service').toLowerCase())} service${v.amcContract ? ` under AMC ${esc(v.amcContract.contractNumber)}` : ''} on <b>${esc(dateLabel)}</b>. We'll be in touch to confirm a time — or reply to reschedule.</p><p>${esc(v.business.name)}</p>`,
          });
        } catch (e) { console.error('service reminder email failed:', e.message); }
      }
      await prisma.serviceVisit.update({ where: { id: v.id }, data: { reminderSentAt: new Date() } }).catch(() => {});
    }
  } catch (error) {
    console.error('Error in processServiceVisitReminders:', error.message);
  }
}

function initScheduler() {
  console.log('[Scheduler] Initializing cron jobs...');
  // Run booking reminders every 15 minutes
  cron.schedule('*/15 * * * *', () => {
    processBookingReminders();
  });

  // Water-purifier service-visit / filter-due reminders — daily at 09:00.
  cron.schedule('0 9 * * *', () => {
    processServiceVisitReminders();
  });

  // Auto-cancel stale PENDING appointments every 5 minutes so a customer
  // isn't left wondering for long after their slot passes.
  cron.schedule('*/5 * * * *', () => {
    processAutoCancellations();
  });

  // Custom domains: once a customer adds DNS, keep retrying Cloudflare SaaS
  // registration/SSL in the background. This makes the admin button a status
  // check, not a support-team dependency.
  cron.schedule('*/5 * * * *', () => {
    processCustomDomainProvisioning();
  });

  // Review-request emails — hourly sweep so the 24h-old threshold is
  // respected within ~1h of hitting it, without spamming the DB.
  cron.schedule('17 * * * *', () => {
    processReviewRequests();
  });

  // Ecommerce order review requests — staggered to :47 so the two sweeps
  // don't overlap.
  cron.schedule('47 * * * *', () => {
    processOrderReviewRequests();
  });

  // Run staff invite reminders daily at noon
  cron.schedule('0 12 * * *', () => {
    processStaffInviteReminders();
    processTrialReminders();
  });

  // App-level trial expiry — hourly check for trials that crossed the
  // trialEndsAt threshold. Hourly is fine for day-precision trials and
  // means the longest a customer keeps trial features past expiry is
  // ~60 min (acceptable; we err on customer's favour).
  cron.schedule('23 * * * *', () => {
    processTrialExpiry();
  });

  cron.schedule('29 * * * *', () => {
    processLaunchFreeExpiry();
  });

  // Provider price refresh — daily at 06:00 UTC. Pulls Twilio Pricing API
  // for every routed country and upserts ProviderPriceCache. MSG91 manual
  // rates re-applied. Customer-visible slot counts auto-recompute on the
  // next render — no PM2 reload needed.
  cron.schedule('0 6 * * *', async () => {
    try {
      const { refreshAllPrices } = require('./notifications/priceCache');
      const summary = await refreshAllPrices({ logger: console });
      console.log(`[Scheduler] priceCache refresh: ${JSON.stringify(summary)}`);
    } catch (err) {
      console.error('[Scheduler] priceCache refresh failed:', err.message);
    }
  });

  // Paddle Billing — process verified webhook events that were queued by the
  // HTTP endpoint or left pending after a process crash. The endpoint returns
  // quickly; this sweep is the reliability backstop.
  cron.schedule('* * * * *', () => {
    processPaddleWebhookRetries();
  });

  // Stripe (NZ) + Razorpay (IN) subscription webhooks — same reliability
  // backstop as Paddle. Both gateways ACK-then-process and never retry a 200, so
  // without these sweeps a crash/deploy between ACK and processing permanently
  // strands a paid subscriber's activation/charge event.
  cron.schedule('* * * * *', () => {
    processStripeWebhookRetries();
  });
  cron.schedule('* * * * *', () => {
    processRazorpayWebhookRetries();
  });
  // Pull-based activation backstop for Razorpay: recovers paid subscribers stuck
  // on "Trial" when the webhook never recorded (bad secret / unregistered
  // endpoint), which the webhook-retry drain above cannot fix. Every 5 min.
  cron.schedule('*/5 * * * *', () => {
    reconcileStuckRazorpaySubscriptionsTask();
  });

  // Razorpay charge-at-will self-billing — DORMANT unless RAZORPAY_CHARGE_AT_WILL
  // is 'on' (chargeDueTokenSubscriptions self-gates + no-ops otherwise). Hourly
  // at :40; two-phase per sub (pre-debit notice → charge the exact amount).
  cron.schedule('40 * * * *', async () => {
    try {
      const { chargeDueTokenSubscriptions, chargeAtWillEnabled } = require('./billing/chargeAtWill');
      if (!chargeAtWillEnabled()) return;
      const r = await chargeDueTokenSubscriptions();
      if (r && (r.charged || r.failed || r.reauth)) console.log('[chargeAtWill]', JSON.stringify(r));
    } catch (err) {
      console.error('[Scheduler] chargeDueTokenSubscriptions failed:', err.message);
    }
  });

  // Paddle Billing reconciliation — backstop for missed webhooks and DB/API
  // write failures. Webhooks remain the fast path; this sweep repairs drift.
  cron.schedule('7,37 * * * *', () => {
    processPaddleReconciliation();
  });

  // Past_due dunning grace expiry — downgrade subscriptions whose grace window lapsed.
  cron.schedule('17,47 * * * *', () => {
    expirePastDueGraceSubscriptions();
  });

  // Billing plan changes — downgrades take effect at renewal. This sweep is a
  // webhook backstop so entitlements flip even if the gateway event is delayed.
  cron.schedule('19,49 * * * *', () => {
    processPendingPlanChanges();
  });

  // Marketing automation — trigger detection runs hourly to find new
  // candidates (birthdays today, appointments completed in the last hour,
  // etc.) and create AutomationEnrollment rows.
  cron.schedule('5 * * * *', async () => {
    try {
      const { detectAll } = require('./marketing/triggerDetector');
      const summary = await detectAll({ logger: console });
      console.log(`[Scheduler] marketing trigger detect: ${JSON.stringify(summary)}`);
    } catch (err) {
      console.error('[Scheduler] marketing trigger detect failed:', err.message);
    }
  });

  // Marketing automation — send dispatcher runs every 5 minutes. Picks up
  // PENDING enrollments where scheduledFor <= now, applies frequency caps
  // + opt-outs, fires through the smart channel router.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { dispatchDue } = require('./marketing/dispatcher');
      const summary = await dispatchDue({ logger: console });
      if (summary.processed > 0) {
        console.log(`[Scheduler] marketing dispatch: ${JSON.stringify(summary)}`);
      }
    } catch (err) {
      console.error('[Scheduler] marketing dispatch failed:', err.message);
    }
  });

  // Sprint 1.7 — Webhook delivery dispatcher runs every minute.
  cron.schedule('* * * * *', async () => {
    try {
      const { dispatchPendingRetries } = require('./webhookDispatcher');
      const r = await dispatchPendingRetries({ limit: 100 });
      if (r.processed > 0) console.log(`[Scheduler] webhook dispatch: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error('[Scheduler] webhook dispatch failed:', err.message);
    }
  });

  // ECOMMERCE — auto-cancel PENDING orders older than 30 minutes. Industry
  // standard (Shopify, Stripe Checkout): unpaid orders expire so reserved
  // stock + coupon counts get released back. Runs every 5 minutes.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const r = await expirePendingOrders();
      if (r.expired > 0) console.log(`[Scheduler] expired ${r.expired} pending orders`);
    } catch (err) {
      console.error('[Scheduler] pending order expiry failed:', err.message);
    }
  });

  // ECOMMERCE — Subscribe & Save: generate due recurring orders. Runs every
  // 6 hours (subscriptions are weekly/monthly, so this is ample) and catches up
  // any subscription whose nextDeliveryAt has passed.
  cron.schedule('15 */6 * * *', async () => {
    try {
      const { materializeDueSubscriptions } = require('./subscriptionMaterializer');
      const r = await materializeDueSubscriptions();
      if (r.created > 0 || r.skipped > 0) {
        console.log(`[Scheduler] subscriptions: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] subscription materializer failed:', err.message);
    }
  });

  // GDPR Article 17 — purge accounts whose 30-day grace period has expired.
  // Daily at 03:30 (low-traffic window). The sweep anonymises PII but keeps
  // transaction shells (bookings/enquiries) per policy B1.
  cron.schedule('30 3 * * *', async () => {
    try {
      const { sweepExpiredDeletions } = require('./accountDeletion');
      const r = await sweepExpiredDeletions();
      if (r.businesses + r.staff + r.customers > 0) {
        console.log(`[Scheduler] purged accounts: ${r.businesses} businesses, ${r.staff} staff, ${r.customers} customers`);
      }
    } catch (err) {
      console.error('[Scheduler] account deletion sweep failed:', err.message);
    }
  });

  // HR Leave Management (Feature 6) — nightly accrual. For each active employee
  // × assigned policy, post a due ACCRUAL tick (idempotent on lastAccrualAt).
  // Pure math in leave/accrual.js; the runner writes the append-only ledger.
  cron.schedule('0 1 * * *', async () => {
    try {
      const { runNightlyAccrual } = require('../../hr/leave/accrualRunner');
      const r = await runNightlyAccrual({ asOf: new Date() });
      if (r.accrued > 0 || r.errors > 0) {
        console.log(`[Scheduler] leave accrual: ${JSON.stringify(r)}`);
      }
      // Leave-audit — carried-lot expiry sweep (carryForwardExpiryMonths was
      // schema-only; this enforces it). Idempotent per lot; cheap when nothing
      // is due, so it rides the same nightly tick.
      const { runCarriedLotExpiry } = require('../../hr/leave/accrualRunner');
      const lx = await runCarriedLotExpiry({ asOf: new Date() });
      if (lx.lapsed > 0 || lx.errors > 0) {
        console.log(`[Scheduler] leave lot-expiry: ${JSON.stringify(lx)}`);
      }
    } catch (err) {
      console.error('[Scheduler] leave accrual failed:', err.message);
    }
  });

  // HR Leave Management (Feature 6) — year-end / anniversary roll. Gated to roll
  // dates (IN financial-year start 1 Apr; NZ anniversaries handled per-employee
  // by the manual /runs/carry-forward endpoint). Runs daily at 02:00 and self-
  // gates: only fires the IN FY roll on 1 April. Carry-forward + lapse, append-only.
  cron.schedule('0 2 * * *', async () => {
    try {
      const now = new Date();
      const isInFyRollDay = now.getUTCMonth() === 3 && now.getUTCDate() === 1; // 1 April
      if (!isInFyRollDay) return;
      const { runCarryForward } = require('../../hr/leave/accrualRunner');
      // Closing period is last financial year, e.g. on 2027-04-01 we roll "2026-27".
      const startY = now.getUTCFullYear() - 1;
      const periodCode = `${startY}-${String((startY + 1) % 100).padStart(2, '0')}`;
      const businesses = await prisma.business.findMany({ select: { id: true }, take: 5000 });
      let carried = 0; let lapsed = 0;
      for (const b of businesses) {
        const r = await runCarryForward({ businessId: b.id, periodCode, dryRun: false });
        carried += r.carriedTotal; lapsed += r.lapsedTotal;
      }
      console.log(`[Scheduler] leave year-end roll ${periodCode}: carried ${carried}, lapsed ${lapsed}`);
    } catch (err) {
      console.error('[Scheduler] leave year-end roll failed:', err.message);
    }
  });

  // HR Investment-Proof Workflow (Feature 20) — daily 09:00 window lifecycle +
  // reminders. Idempotent + tenant-safe. Moves DRAFT→OPEN→CLOSED→LOCKED on the
  // configured dates and fans out notifications (open nudge, T-14/T-3 reminders,
  // deadline "unverified excluded" warning). The TDS DECLARED→VERIFIED switch itself
  // is DATE-DRIVEN in the assembler (asOf >= proofDeadline), so a missed tick never
  // affects correctness — this cron only drives status + notifications.
  cron.schedule('0 9 * * *', async () => {
    try {
      const { runProofWindowSweep } = require('../../hr/tax/investmentProof/proofWindowRunner');
      const r = await runProofWindowSweep({ asOf: new Date() });
      if (r.opened + r.closed + r.locked + r.remindersSent + r.errors > 0) {
        console.log(`[Scheduler] investment-proof window sweep: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] investment-proof window sweep failed:', err.message);
    }
  });

  // HR Approvals (Feature 10 §5.5) — SLA escalation sweep. The engine's whole
  // SLA / auto-decision feature (REMIND / ESCALATE / AUTO_APPROVE / AUTO_REJECT)
  // is dead in prod until this is scheduled. Every 10 min: scan PENDING requests
  // whose slaDueAt has lapsed and apply the active level's onTimeoutAction. The
  // runner is tenant-safe (each request is businessId-scoped), idempotent, and
  // every state change is version-guarded — but we also gate on an in-process
  // `escalationRunning` flag so a slow sweep can never overlap the next tick.
  let escalationRunning = false;
  cron.schedule('*/10 * * * *', async () => {
    if (escalationRunning) { console.log('[Scheduler] escalation sweep still running — skipping tick'); return; }
    escalationRunning = true;
    try {
      const { sweepEscalations } = require('../../hr/approvals/escalationRunner');
      const r = await sweepEscalations({ asOf: new Date() });
      if (r.scanned > 0 || r.errors > 0) {
        console.log(`[Scheduler] approval escalation: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] approval escalation failed:', err.message);
    } finally {
      escalationRunning = false;
    }
  });

  // HR Attendance (Feature 2) — nightly absent/no-punch sweep. Recompute is
  // event-driven (a punch/regularization/import fires it), so a scheduled
  // employee who never punches produces NO Attendance row and the day's ABSENT
  // status + LOP never materialise. Nightly at 01:30 (after leave accrual at
  // 01:00, before payroll windows) we re-derive the PRIOR civil day for every
  // ACTIVE employee per tenant via the SAME service.recompute the punch flow
  // calls — so absent days book their status + lopFraction. Idempotent (recompute
  // upserts + never touches a locked/frozen row), batched, per-tenant. Guarded
  // against overlap with an in-process flag (a 1000+-employee sweep can outrun a
  // tick).
  let attendanceSweepRunning = false;
  cron.schedule('30 1 * * *', async () => {
    if (attendanceSweepRunning) { console.log('[Scheduler] attendance sweep still running — skipping tick'); return; }
    attendanceSweepRunning = true;
    try {
      const { sweepPriorDay } = require('../../hr/attendance/attendanceSweep');
      const r = await sweepPriorDay({ asOf: new Date() });
      if (r.written > 0 || r.errors > 0) {
        console.log(`[Scheduler] attendance sweep: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] attendance sweep failed:', err.message);
    } finally {
      attendanceSweepRunning = false;
    }
  });

  // HR Comp-off (Feature 30) — nightly EARN runner. Runs at 01:45, AFTER the
  // attendance sweep (01:30) has materialised the HOLIDAY_WORKED rows that are the
  // canonical earn signal. Scans those rows per tenant and mints a CompOffCredit per
  // worked rest-day (idempotent on the @@unique guard; tenant-safe; per-row failures
  // skipped). When requireApproval, opens a COMP_OFF approval request; else finalizes
  // the credit immediately. Guarded against overlap with an in-process flag.
  let compOffEarnRunning = false;
  cron.schedule('45 1 * * *', async () => {
    if (compOffEarnRunning) { console.log('[Scheduler] comp-off earn still running — skipping tick'); return; }
    compOffEarnRunning = true;
    try {
      const { runCompOffEarn } = require('../../hr/leave/compoff/compOffEarnRunner');
      const r = await runCompOffEarn({ asOf: new Date() });
      if (r.minted > 0 || r.errors > 0) {
        console.log(`[Scheduler] comp-off earn: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] comp-off earn failed:', err.message);
    } finally {
      compOffEarnRunning = false;
    }
  });

  // HR Probation (Program P1.4) — nightly sweep at 02:15 (after attendance
  // 01:30 / comp-off earn 01:45). Reminds managers/HR remindDaysBefore the
  // probation end date and, where the tenant's ProbationPolicy says
  // autoConfirm, flips PROBATION→ACTIVE via provision.confirmProbation
  // (idempotent) + issues the configured CONFIRMATION letter. Per-employee
  // failures are counted, never thrown. In-process overlap guard.
  let probationSweepRunning = false;
  cron.schedule('15 2 * * *', async () => {
    if (probationSweepRunning) { console.log('[Scheduler] probation sweep still running — skipping tick'); return; }
    probationSweepRunning = true;
    try {
      const { runProbationSweep } = require('../../hr/lifecycle/probationSweep');
      const r = await runProbationSweep({ asOf: new Date() });
      if (r.reminded > 0 || r.confirmed > 0 || r.errors > 0) {
        console.log(`[Scheduler] probation sweep: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] probation sweep failed:', err.message);
    } finally {
      probationSweepRunning = false;
    }
  });

  // HR Documents (Program P1.7) — nightly expiry reminders at 03:30 (after the
  // comp-off expiry family). Notifies employee + HR for documents expiring in
  // exactly 30/7/1/0 days (exact-day match = naturally deduped). Per-row
  // fail-soft; in-process overlap guard.
  let docExpiryRunning = false;
  cron.schedule('30 3 * * *', async () => {
    if (docExpiryRunning) { console.log('[Scheduler] doc-expiry sweep still running — skipping tick'); return; }
    docExpiryRunning = true;
    try {
      const { runDocumentExpirySweep } = require('../../hr/documents/documentExpiryRunner');
      const r = await runDocumentExpirySweep({ asOf: new Date() });
      if (r.reminded > 0 || r.errors > 0) {
        console.log(`[Scheduler] doc-expiry sweep: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] doc-expiry sweep failed:', err.message);
    } finally {
      docExpiryRunning = false;
    }
  });

  // HR Comp-off (Feature 30) — nightly EXPIRY/LAPSE runner. Runs at 03:00. Lapses
  // ACTIVE comp-off lots whose per-credit expiresOn has passed (append-only LAPSE +
  // aggregate-balance drop, version-locked, idempotent), expires PENDING-past-expiry
  // credits, and fans out "expiring soon" reminders. Tenant-safe; in-process guard.
  let compOffExpiryRunning = false;
  cron.schedule('0 3 * * *', async () => {
    if (compOffExpiryRunning) { console.log('[Scheduler] comp-off expiry still running — skipping tick'); return; }
    compOffExpiryRunning = true;
    try {
      const { runCompOffExpiry } = require('../../hr/leave/compoff/compOffExpiryRunner');
      const r = await runCompOffExpiry({ asOf: new Date() });
      if (r.lapsed > 0 || r.remindersSent > 0 || r.errors > 0) {
        console.log(`[Scheduler] comp-off expiry: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] comp-off expiry failed:', err.message);
    } finally {
      compOffExpiryRunning = false;
    }
  });

  // FLAG (Feature 28 — shared edit): Biometric ingestion. Two ticks, both with the
  // standard in-process overlap guard (a slow tenant loop must never overlap the next
  // tick). (1) SFTP/folder POLL every 10 min — pulls new device export files since
  // each device's pollCursor and ingests them through the SAME adapter→RawPunchEvent→
  // recompute path (idempotent by dedupKey). (2) Stale-device WATCHDOG every 15 min —
  // alerts canManageAttendance ops when a device goes silent past expectedSilenceMin.
  // Tenant-isolated, per-device failures skipped, engine UNTOUCHED (only recompute).
  let biometricPollRunning = false;
  cron.schedule('*/10 * * * *', async () => {
    if (biometricPollRunning) { console.log('[Scheduler] biometric poll still running — skipping tick'); return; }
    biometricPollRunning = true;
    try {
      const { runPoll } = require('../../hr/attendance/biometric/poll.runner');
      const r = await runPoll({ now: new Date() });
      if (r.files > 0 || r.errors > 0) console.log(`[Scheduler] biometric poll: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error('[Scheduler] biometric poll failed:', err.message);
    } finally {
      biometricPollRunning = false;
    }
  });

  let biometricWatchdogRunning = false;
  cron.schedule('*/15 * * * *', async () => {
    if (biometricWatchdogRunning) { console.log('[Scheduler] biometric watchdog still running — skipping tick'); return; }
    biometricWatchdogRunning = true;
    try {
      const { runDeviceWatchdog } = require('../../hr/attendance/biometric/watchdog.runner');
      const r = await runDeviceWatchdog({ now: new Date() });
      if (r.alerts > 0 || r.errors > 0) console.log(`[Scheduler] biometric watchdog: ${JSON.stringify(r)}`);
    } catch (err) {
      console.error('[Scheduler] biometric watchdog failed:', err.message);
    } finally {
      biometricWatchdogRunning = false;
    }
  });

  // HR Statutory Compliance (Feature 23) — daily 07:00 UTC (≈12:30 IST). One block,
  // three steps: (1) generate upcoming obligation stubs from each tenant's active
  // ComplianceObligation × StatutoryRegistration, (2) advance PENDING→DUE / →OVERDUE,
  // (3) fan out T-7/T-3/T-1/due/overdue reminders to canManageStatutory users via
  // notifyHrEvent. Tenant-safe, idempotent, version-guarded; the in-process flag
  // prevents a slow sweep from overlapping the next tick (copied verbatim from the
  // escalation/attendance sweeps above). NO collision with payroll fileRun()'s
  // remittance writer — both key on (businessId, entityId, kind, taxPeriod[,state]).
  let complianceSweepRunning = false;
  cron.schedule('0 7 * * *', async () => {
    if (complianceSweepRunning) { console.log('[Scheduler] compliance sweep still running — skipping tick'); return; }
    complianceSweepRunning = true;
    try {
      const r = require('../../hr/payroll/compliance/calendarRunner');
      const g = await r.generateUpcomingObligations({ asOf: new Date() });
      const s = await r.sweepComplianceStatus({ asOf: new Date() });
      const n = await r.sendComplianceReminders({ asOf: new Date() });
      if (g.created || s.overdue || s.due || n.sent || g.errors || s.errors || n.errors) {
        console.log(`[Scheduler] compliance: gen=${JSON.stringify(g)} sweep=${JSON.stringify(s)} remind=${JSON.stringify(n)}`);
      }
    } catch (err) {
      console.error('[Scheduler] compliance sweep failed:', err.message);
    } finally {
      complianceSweepRunning = false;
    }
  });

  // Feature 37 — LMS training-calendar sweep (daily 08:00). New-joiner auto-assign
  // (POSH 30-day), annual/periodic recurrence re-assign, and T-7/T-1/overdue reminders
  // (deduped via the enrollment lastReminderStage cursor). Structural copy of the
  // compliance/proof-window sweeps: per-tenant (businessId null = all), per-row
  // try/catch inside the runner, idempotent (cycle unique), in-process overlap guard.
  let learningSweepRunning = false;
  cron.schedule('0 8 * * *', async () => {
    if (learningSweepRunning) { console.log('[Scheduler] learning sweep still running — skipping tick'); return; }
    learningSweepRunning = true;
    try {
      const { runSweep } = require('../../hr/talent/learning/learningReminderRunner');
      const r = await runSweep({ asOf: new Date() });
      if (r.newJoiner.created || r.recurrence.created || r.reminders.sent
        || r.newJoiner.errors || r.recurrence.errors || r.reminders.errors) {
        console.log(`[Scheduler] learning: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] learning sweep failed:', err.message);
    } finally {
      learningSweepRunning = false;
    }
  });

  // Feature 33 — Pulse Surveys + eNPS schedule sweep (daily 06:20 UTC). Three passes:
  // CLOSE lapsed occurrences (one-shot surveys flip PUBLISHED→CLOSED + author notify),
  // SPAWN the next occurrence of each due recurring pulse (idempotent on the
  // @@unique([surveyId, seq]) + per-occurrence notifiedAt invite stamp — never
  // re-blasts), and REMIND non-responders once past ~50% of an open window. Opening
  // is date-driven (the ESS feed filters live occurrences itself), so a missed tick
  // never loses a window — the next tick catches up idempotently. Tenant-safe,
  // per-row fail-soft, in-process overlap guard (copied from the comp-off blocks).
  let pulseSweepRunning = false;
  cron.schedule('20 6 * * *', async () => {
    if (pulseSweepRunning) { console.log('[Scheduler] pulse survey sweep still running — skipping tick'); return; }
    pulseSweepRunning = true;
    try {
      const { runPulseScheduleSweep } = require('../../hr/engagement/surveys/pulseScheduleRunner');
      const r = await runPulseScheduleSweep({ asOf: new Date() });
      if (r.closedOccurrences + r.closedSurveys + r.spawned + r.goLiveNotified + r.remindersSent + r.errors > 0) {
        console.log(`[Scheduler] pulse survey sweep: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] pulse survey sweep failed:', err.message);
    } finally {
      pulseSweepRunning = false;
    }
  });

  // Feature 35 — R&R points expiry (nightly 03:40, after the comp-off expiry family).
  // FIFO lapse of stale earned points for tenants with pointsExpiryMonths configured
  // (OFF by default): ONE negative EXPIRY ledger row per employee (append-only,
  // version-locked wallet debit), naturally idempotent — a re-run recomputes 0.
  // Tenant-safe, per-employee fail-soft, in-process overlap guard.
  let pointsExpiryRunning = false;
  cron.schedule('40 3 * * *', async () => {
    if (pointsExpiryRunning) { console.log('[Scheduler] points expiry still running — skipping tick'); return; }
    pointsExpiryRunning = true;
    try {
      const { runPointsExpiry } = require('../../hr/recognition/pointsExpiryRunner');
      const r = await runPointsExpiry({ asOf: new Date() });
      if (r.employees > 0 || r.errors > 0) {
        console.log(`[Scheduler] points expiry: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] points expiry failed:', err.message);
    } finally {
      pointsExpiryRunning = false;
    }
  });

  // Feature 35 — R&R award-cycle lifecycle (daily 06:50, beside the pulse sweep).
  // Flips OPEN cycles past their nomination window → CLOSED (+ nudges the cycle
  // creator to shortlist/decide) and catches up any WON nomination still missing
  // its F9 certificate (eventual consistency for the consumer's deferred issue).
  // Conditional flips = idempotent; per-row fail-soft; in-process overlap guard.
  let awardLifecycleRunning = false;
  cron.schedule('50 6 * * *', async () => {
    if (awardLifecycleRunning) { console.log('[Scheduler] award lifecycle still running — skipping tick'); return; }
    awardLifecycleRunning = true;
    try {
      const { runAwardCycleLifecycle } = require('../../hr/recognition/awardCycleRunner');
      const r = await runAwardCycleLifecycle({ asOf: new Date() });
      if (r.closed > 0 || r.certificates > 0 || r.errors > 0) {
        console.log(`[Scheduler] award lifecycle: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] award lifecycle failed:', err.message);
    } finally {
      awardLifecycleRunning = false;
    }
  });

  // Reports Platform — scheduled report deliveries (hourly at :25). A schedule
  // is due when its cronPreset+anchor+hourUtc window opens (pure due-ness math,
  // unit-tested) and lastRunAt is not already inside the window, so a restart
  // never double-sends and a missed tick is simply skipped until the next
  // window. Renders the saved definition under the CREATOR's F1 scope and
  // emails the CSV/XLSX/PDF as an attachment. Per-schedule fail-soft; the
  // in-process flag prevents a slow render batch from overlapping the next tick
  // (copied verbatim from the compliance/learning sweep blocks above).
  let reportSchedulesRunning = false;
  cron.schedule('25 * * * *', async () => {
    if (reportSchedulesRunning) { console.log('[Scheduler] report schedules still running — skipping tick'); return; }
    reportSchedulesRunning = true;
    try {
      const { runDueReportSchedules } = require('../../hr/reports/reportScheduleRunner');
      const r = await runDueReportSchedules({ asOf: new Date() });
      if (r.due > 0 || r.failed > 0 || r.errors > 0) {
        console.log(`[Scheduler] report schedules: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] report schedules failed:', err.message);
    } finally {
      reportSchedulesRunning = false;
    }
  });

  // Feature 36 — interview slot-proposal expiry sweep (every 30 min). Flips
  // PROPOSED proposals past their expiresAt → EXPIRED (conditional/idempotent) and
  // notifies the proposer in-app so a stale "awaiting candidate" card doesn't sit
  // forever. Tenant-safe, per-row fail-soft, in-process overlap guard.
  let slotExpiryRunning = false;
  cron.schedule('*/30 * * * *', async () => {
    if (slotExpiryRunning) { console.log('[Scheduler] slot expiry still running — skipping tick'); return; }
    slotExpiryRunning = true;
    try {
      const { sweepExpiredSlotProposals } = require('../../hr/talent/recruitment/recruitmentCommsRunner');
      const r = await sweepExpiredSlotProposals({ asOf: new Date() });
      if (r.expired > 0 || r.errors > 0) {
        console.log(`[Scheduler] slot expiry: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] slot expiry failed:', err.message);
    } finally {
      slotExpiryRunning = false;
    }
  });

  // Feature 36 — interview-feedback nudge (daily 09:10). Reminds panellists with an
  // un-submitted DRAFT scorecard past the grace window after a COMPLETED interview,
  // deep-linked to their scorecard, deduped one per (interview, panellist, day).
  // Tenant-safe, per-row fail-soft, in-process overlap guard.
  let feedbackNudgeRunning = false;
  cron.schedule('10 9 * * *', async () => {
    if (feedbackNudgeRunning) { console.log('[Scheduler] feedback nudge still running — skipping tick'); return; }
    feedbackNudgeRunning = true;
    try {
      const { runInterviewFeedbackNudge } = require('../../hr/talent/recruitment/recruitmentCommsRunner');
      const r = await runInterviewFeedbackNudge({ asOf: new Date() });
      if (r.nudged > 0 || r.errors > 0) {
        console.log(`[Scheduler] interview feedback nudge: ${JSON.stringify(r)}`);
      }
    } catch (err) {
      console.error('[Scheduler] interview feedback nudge failed:', err.message);
    } finally {
      feedbackNudgeRunning = false;
    }
  });
}

// Find PENDING orders older than `maxAgeMinutes` (default 30) and cancel
// them: mark CANCELLED, restore stock, roll back coupon redemption. Mirrors
// the buyer-initiated cancel flow but driven by a cron timeout. Returns
// { expired: <count> }.
async function expirePendingOrders({ maxAgeMinutes = 30 } = {}) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const stale = await prisma.order.findMany({
    where: { status: 'PENDING', placedAt: { lt: cutoff } },
    include: { items: true },
  });
  if (stale.length === 0) return { expired: 0 };

  for (const order of stale) {
    try {
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.order.findUnique({ where: { id: order.id } });
        if (!fresh || fresh.status !== 'PENDING') return; // raced with payment
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
        for (const item of order.items) {
          const p = await tx.product.findUnique({ where: { id: item.productId } });
          if (p && typeof p.stockQty === 'number') {
            await tx.product.update({ where: { id: p.id }, data: { stockQty: p.stockQty + item.quantity } });
          }
        }
        if (order.couponCode) {
          const coupon = await tx.coupon.findFirst({
            where: { businessId: order.businessId, code: order.couponCode },
          });
          if (coupon) {
            await tx.couponRedemption.deleteMany({ where: { couponId: coupon.id, orderId: order.id } });
            await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { decrement: 1 } } });
          }
        }
      });
    } catch (err) {
      console.error(`[expirePendingOrders] order ${order.id} failed:`, err.message);
    }
  }
  return { expired: stale.length };
}

module.exports = {
  initScheduler,
  processBookingReminders,
  processAutoCancellations,
  processPaddleWebhookRetries,
  processStripeWebhookRetries,
  processRazorpayWebhookRetries,
  processPaddleReconciliation,
  processLaunchFreeExpiry,
  processPendingPlanChanges,
  expirePastDueGraceSubscriptions,
  processReviewRequests,
  processOrderReviewRequests,
  processStaffInviteReminders,
  processTrialReminders,
  processTrialExpiry,
  expirePendingOrders,
};
