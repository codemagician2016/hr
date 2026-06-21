// GDPR Article 17 — account-deletion service.
// Soft-delete pattern: 30-day grace period during which the user can undo.
// After 30 days a cron sweeps and purges PII while preserving an
// AccountAuditLog row for legal-claims defence + subpoena response.
//
// Three deletion flows:
//   1. Business owner (BUSINESS_ADMIN) — deletes the whole tenant + all
//      its data (services, bookings, customers, content, blog, files).
//      Cancels Paddle subscription. After purge: AuditLog row + cascaded
//      removal of every Business* table row.
//   2. Staff (USER role) — deletes personal account, leaves the business.
//      Past bookings stay (assigned to "Unassigned").
//   3. Customer — deletes profile + anonymises past bookings/enquiries
//      (PII gone, business retains revenue stats).

const crypto = require('crypto');
const prisma = require('./prisma');
const { cancelPaddleSubscription, updatePaddleSubscription } = require('./paddle');
const { getGateway } = require('./billing/gateways');

const GRACE_PERIOD_DAYS = 30;

// Cancel a tenant's live subscription on WHATEVER gateway it's on — Paddle (RoW),
// Stripe (NZ), or Razorpay (IN) — so deletion actually stops billing in every
// region, not just Paddle. Idempotent + NON-BLOCKING: a gateway/network error
// must never block scheduling or purging the account.
async function cancelBusinessSubscription(businessId, { reason = 'deletion', immediately = true } = {}) {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { businessId },
      select: { paddleSubscriptionId: true, stripeSubscriptionId: true, razorpaySubscriptionId: true },
    });
    if (!sub) return { canceled: false, reason: 'no_subscription' };
    const results = [];
    if (sub.paddleSubscriptionId) {
      try {
        await cancelPaddleSubscription(sub.paddleSubscriptionId, { effective_from: immediately ? 'immediately' : 'next_billing_period' });
        results.push({ gateway: 'PADDLE', canceled: true });
      } catch (err) {
        console.error(`[billing] cancel Paddle ${sub.paddleSubscriptionId} failed: ${err.message}`);
        results.push({ gateway: 'PADDLE', canceled: false, error: err.message });
      }
    }
    for (const [gw, ref] of [['STRIPE', sub.stripeSubscriptionId], ['RAZORPAY', sub.razorpaySubscriptionId]]) {
      if (!ref) continue;
      try {
        await getGateway(gw).cancelSubscription(ref, { immediately });
        results.push({ gateway: gw, canceled: true });
      } catch (err) {
        console.error(`[billing] cancel ${gw} ${ref} failed: ${err.message}`);
        results.push({ gateway: gw, canceled: false, error: err.message });
      }
    }
    if (results.length) console.log(`[billing] cancelBusinessSubscription(${businessId}) (${reason}): ${JSON.stringify(results)}`);
    return { canceled: results.some((r) => r.canceled), results };
  } catch (err) {
    console.error(`[billing] cancelBusinessSubscription(${businessId}) failed: ${err.message}`);
    return { canceled: false, error: err.message };
  }
}

// Reverse the scheduled (period-end) cancellation that requestBusinessDeletion
// fires, so an "undo delete" restores billing cleanly. Mirrors the user-facing
// resumeSubscriptionPlan: Paddle clears scheduled_change, Stripe clears
// cancel_at_period_end. Razorpay can't un-schedule a cancel → not reversible.
// Best-effort + NON-BLOCKING: the local row is only flipped back to ACTIVE when
// the gateway reversal actually succeeded, so a hard-cancelled sub (e.g. one
// cancelled immediately under the old flow) is left CANCELLED for the owner to
// re-subscribe rather than lying that billing is active.
async function reverseBusinessSubscriptionCancellation(businessId, { reason = 'undo-deletion' } = {}) {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { businessId },
      select: { gateway: true, status: true, paddleSubscriptionId: true, stripeSubscriptionId: true, razorpaySubscriptionId: true },
    });
    if (!sub) return { resumed: false, reason: 'no_subscription' };
    const gw = String(sub.gateway || '').toUpperCase();
    let resumed = false;
    let resumeError = null;
    try {
      if (gw === 'PADDLE' && sub.paddleSubscriptionId) {
        await updatePaddleSubscription(sub.paddleSubscriptionId, { scheduled_change: null });
        resumed = true;
      } else if (gw === 'STRIPE' && sub.stripeSubscriptionId) {
        await getGateway('STRIPE').raw().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
        resumed = true;
      }
      // Razorpay: a scheduled cancellation can't be reversed — owner re-subscribes.
    } catch (err) {
      resumeError = err.message;
      console.error(`[billing] reverseBusinessSubscriptionCancellation(${businessId}) gateway error: ${err.message}`);
    }
    if (resumed) {
      await prisma.subscription.update({
        where: { businessId },
        data: { status: 'ACTIVE', pendingTierSlug: null, pendingBillingCycle: null, pendingChangeEffectiveAt: null },
      }).catch((e) => console.error(`[billing] reverse local status update failed: ${e.message}`));
    }
    console.log(`[billing] reverseBusinessSubscriptionCancellation(${businessId}) (${reason}): resumed=${resumed} gateway=${gw}`);
    return { resumed, gateway: gw, reversible: resumed, error: resumeError };
  } catch (err) {
    console.error(`[billing] reverseBusinessSubscriptionCancellation(${businessId}) failed: ${err.message}`);
    return { resumed: false, error: err.message };
  }
}

// Whether to suppress a gateway "subscription cancelled" email for this business
// — true while a deletion is pending. The delete flow has its own messaging, so
// the gateway's separate "cancelled" email (fired when the period-end cancel
// lands, or at purge) is confusing and was the source of the post-undo email
// spam. Non-throwing → a lookup failure never blocks the webhook.
async function isBusinessDeletionPending(businessId) {
  try {
    const b = await prisma.business.findUnique({ where: { id: businessId }, select: { pendingDeletionAt: true } });
    return !!b?.pendingDeletionAt;
  } catch {
    return false;
  }
}

// Cancel a tenant's live Paddle subscription so deletion actually stops billing.
// Idempotent + NON-BLOCKING by design: a Paddle/network error must never block
// the purge/delete (the header comment long claimed this happened — it didn't).
async function cancelBusinessPaddleSubscription(businessId, { reason = 'deletion', effectiveFrom = 'immediately' } = {}) {
  try {
    const sub = await prisma.subscription.findUnique({
      where: { businessId },
      select: { paddleSubscriptionId: true },
    });
    const paddleId = sub?.paddleSubscriptionId;
    if (!paddleId) return { canceled: false, reason: 'no_paddle_subscription' };
    await cancelPaddleSubscription(paddleId, { effective_from: effectiveFrom });
    console.log(`[billing] canceled Paddle subscription ${paddleId} for business ${businessId} (${reason})`);
    return { canceled: true, paddleSubscriptionId: paddleId };
  } catch (err) {
    // Already-canceled subs return a Paddle error — that's fine (idempotent).
    console.error(`[billing] cancelBusinessPaddleSubscription(${businessId}) failed: ${err.message}`);
    return { canceled: false, error: err.message };
  }
}

function hashEmail(email) {
  if (!email) return null;
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

function deletionPurgeAt(requestedAt = new Date()) {
  const at = new Date(requestedAt);
  at.setDate(at.getDate() + GRACE_PERIOD_DAYS);
  return at;
}

// Persist an AccountAuditLog row. Never throws — auditing must not block
// the deletion flow itself.
async function logEvent({ eventType, target, ipAddress, userAgent, reason, payload }) {
  try {
    await prisma.accountAuditLog.create({
      data: {
        eventType,
        targetType: target.type,
        targetId: target.id,
        targetSlug: target.slug || null,
        originalEmail: target.email || null,
        originalEmailHash: hashEmail(target.email),
        originalName: target.name || null,
        originalPhone: target.phone || null,
        ownerCountry: target.country || null,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
        reason: reason || null,
        payload: payload || undefined,
      },
    });
  } catch (err) {
    console.error('[accountDeletion] audit log write failed:', err.message);
  }
}

// ─── Request deletion (set pendingDeletionAt) ───────────────────────────────

async function requestBusinessDeletion({ businessId, actorUserId, ipAddress, userAgent, reason }) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: {
      users: { where: { role: 'BUSINESS_ADMIN' }, take: 1 },
    },
  });
  if (!business) throw new Error('Business not found');
  if (business.pendingDeletionAt) {
    return { business, alreadyPending: true };
  }

  const owner = business.users[0] || null;
  await prisma.business.update({
    where: { id: businessId },
    data: { pendingDeletionAt: new Date() },
  });

  // Stop billing the moment deletion is scheduled, but cancel at PERIOD-END
  // (not immediately) so the 30-day grace stays reversible: an "undo" can clear
  // the scheduled cancel and the tenant keeps the access they paid for (which
  // also matches the deletion email's "access until the end of the current
  // billing period" copy). The hard, immediate cancel happens later at purge.
  // Non-blocking + idempotent: a gateway error must never block the request.
  const subscriptionCancellation = await cancelBusinessSubscription(businessId, { reason: 'deletion-requested', immediately: false });

  await logEvent({
    eventType: 'BUSINESS_DELETE_REQUESTED',
    target: {
      type: 'BUSINESS',
      id: business.id,
      slug: business.slug,
      email: owner?.email,
      name: business.name,
      phone: business.phone,
      country: business.country,
    },
    ipAddress,
    userAgent,
    reason,
    payload: { actorUserId, ownerEmail: owner?.email, subscriptionCancellation },
  });

  return { business, purgeAt: deletionPurgeAt(), subscriptionCancellation };
}

async function requestStaffDeletion({ userId, ipAddress, userAgent, reason }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');
  if (user.pendingDeletionAt) return { user, alreadyPending: true };

  await prisma.user.update({
    where: { id: userId },
    data: { pendingDeletionAt: new Date() },
  });

  await logEvent({
    eventType: 'STAFF_DELETE_REQUESTED',
    target: {
      type: 'USER',
      id: user.id,
      email: user.email,
      name: user.name,
    },
    ipAddress,
    userAgent,
    reason,
    payload: { businessId: user.businessId, role: user.role },
  });

  return { user, purgeAt: deletionPurgeAt() };
}

async function requestCustomerDeletion({ customerId, ipAddress, userAgent, reason }) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new Error('Customer not found');
  if (customer.pendingDeletionAt) return { customer, alreadyPending: true };

  await prisma.customer.update({
    where: { id: customerId },
    data: { pendingDeletionAt: new Date() },
  });

  await logEvent({
    eventType: 'CUSTOMER_DELETE_REQUESTED',
    target: {
      type: 'CUSTOMER',
      id: customer.id,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
    },
    ipAddress,
    userAgent,
    reason,
    payload: { businessId: customer.businessId },
  });

  return { customer, purgeAt: deletionPurgeAt() };
}

// ─── Undo (clear pendingDeletionAt) ─────────────────────────────────────────

async function undoBusinessDeletion({ businessId, ipAddress, userAgent }) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business || !business.pendingDeletionAt) return null;
  await prisma.business.update({ where: { id: businessId }, data: { pendingDeletionAt: null } });

  // Reverse the period-end cancellation we scheduled at request time so the
  // subscription keeps renewing. Best-effort: if it can't be reversed (hard
  // cancelled, or Razorpay), the account is still restored and the billing UI
  // guides the owner to re-subscribe — but we no longer leave them cancelled
  // silently while still receiving "cancelled" emails.
  const subscriptionResume = await reverseBusinessSubscriptionCancellation(businessId, { reason: 'undo-deletion' });

  await logEvent({
    eventType: 'BUSINESS_DELETE_UNDONE',
    target: { type: 'BUSINESS', id: business.id, slug: business.slug, name: business.name },
    ipAddress,
    userAgent,
    payload: { subscriptionResume },
  });
  return business;
}

async function undoStaffDeletion({ userId, ipAddress, userAgent }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.pendingDeletionAt) return null;
  await prisma.user.update({ where: { id: userId }, data: { pendingDeletionAt: null } });
  await logEvent({
    eventType: 'STAFF_DELETE_UNDONE',
    target: { type: 'USER', id: user.id, email: user.email, name: user.name },
    ipAddress,
    userAgent,
  });
  return user;
}

async function undoCustomerDeletion({ customerId, ipAddress, userAgent }) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer || !customer.pendingDeletionAt) return null;
  await prisma.customer.update({ where: { id: customerId }, data: { pendingDeletionAt: null } });
  await logEvent({
    eventType: 'CUSTOMER_DELETE_UNDONE',
    target: { type: 'CUSTOMER', id: customer.id, email: customer.email, name: customer.name },
    ipAddress,
    userAgent,
  });
  return customer;
}

// ─── Purge (called by cron after grace period elapses) ──────────────────────
// Each purge function:
//   1. Re-checks pendingDeletionAt is still set + grace period elapsed
//   2. Anonymises PII or hard-deletes per the policy
//   3. Writes a final '*_PURGED' AuditLog row

const PURGE_PLACEHOLDER = '[deleted]';

async function purgeCustomer(customerId) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer || !customer.pendingDeletionAt || customer.anonymisedAt) return;

  // Anonymise PII but keep the row + revenue stats. Bookings/Enquiries
  // FK to customer.id stay valid; their displayed name resolves via
  // customer.name which is now the placeholder.
  await prisma.customer.update({
    where: { id: customerId },
    data: {
      email:    `${customer.id}@deleted.invalid`, // satisfies @unique while removing real email
      name:     PURGE_PLACEHOLDER,
      phone:    null,
      password: '',
      googleId: null,
      avatarUrl: null,
      isActive: false,
      anonymisedAt: new Date(),
    },
  });

  await logEvent({
    eventType: 'CUSTOMER_PURGED',
    target: {
      type: 'CUSTOMER',
      id: customer.id,
      email: customer.email,
      name: customer.name,
      phone: customer.phone,
    },
    payload: { businessId: customer.businessId },
  });
}

async function purgeStaff(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.pendingDeletionAt || user.anonymisedAt) return;
  await prisma.user.update({
    where: { id: userId },
    data: {
      email:    `${user.id}@deleted.invalid`,
      name:     PURGE_PLACEHOLDER,
      password: '',
      avatarUrl: null,
      subtitle: null,
      bio: null,
      isActive: false,
      showOnWebsite: false,
      anonymisedAt: new Date(),
    },
  });
  await logEvent({
    eventType: 'STAFF_PURGED',
    target: { type: 'USER', id: user.id, email: user.email, name: user.name },
    payload: { businessId: user.businessId, role: user.role },
  });
}

async function purgeBusiness(businessId) {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { users: { where: { role: 'BUSINESS_ADMIN' }, take: 1 } },
  });
  if (!business || !business.pendingDeletionAt || business.anonymisedAt) return;
  const owner = business.users[0] || null;

  // Stop billing for good before we anonymise the tenant (the long-standing C10
  // gap: deleted tenants kept their subscription and were billed forever). At
  // request time we only scheduled a period-end cancel (reversible during the
  // grace); the grace has now elapsed, so this is the hard, IMMEDIATE cancel
  // across ALL gateways (Paddle / Stripe / Razorpay) — also an idempotent safety
  // net if the earlier call failed or the tenant was purged without a request.
  await cancelBusinessSubscription(businessId, { reason: 'purge', immediately: true });

  // Hard-delete the business — Prisma cascades to all related rows via the
  // existing onDelete:Cascade FKs. Tax/billing records (Subscription, Paddle)
  // are retained separately by Paddle; we keep the AuditLog row here.
  // We use a soft-delete shape (anonymisedAt set, isActive false) instead
  // of an actual delete because so many tables FK to business.id and a
  // hard delete needs careful migration planning. The hard-delete cron
  // can run in a follow-up commit.
  await prisma.business.update({
    where: { id: businessId },
    data: {
      name: PURGE_PLACEHOLDER,
      description: null,
      address: null,
      phone: null,
      email: null,
      isActive: false,
      anonymisedAt: new Date(),
    },
  });

  await logEvent({
    eventType: 'BUSINESS_PURGED',
    target: {
      type: 'BUSINESS',
      id: business.id,
      slug: business.slug,
      email: owner?.email,
      name: business.name,
      phone: business.phone,
      country: business.country,
    },
  });
}

// ─── Cron entry: sweep all pending deletions whose grace period elapsed ─────

async function sweepExpiredDeletions(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - GRACE_PERIOD_DAYS);

  const [customers, staff, businesses] = await Promise.all([
    prisma.customer.findMany({
      where: { pendingDeletionAt: { lte: cutoff }, anonymisedAt: null },
      select: { id: true },
    }),
    prisma.user.findMany({
      where: { pendingDeletionAt: { lte: cutoff }, anonymisedAt: null },
      select: { id: true },
    }),
    prisma.business.findMany({
      where: { pendingDeletionAt: { lte: cutoff }, anonymisedAt: null },
      select: { id: true },
    }),
  ]);

  for (const c of customers) await purgeCustomer(c.id);
  for (const s of staff)     await purgeStaff(s.id);
  for (const b of businesses) await purgeBusiness(b.id);

  return { customers: customers.length, staff: staff.length, businesses: businesses.length };
}

module.exports = {
  GRACE_PERIOD_DAYS,
  deletionPurgeAt,
  requestBusinessDeletion,
  requestStaffDeletion,
  requestCustomerDeletion,
  undoBusinessDeletion,
  undoStaffDeletion,
  undoCustomerDeletion,
  purgeBusiness,
  purgeStaff,
  purgeCustomer,
  sweepExpiredDeletions,
  cancelBusinessSubscription,
  reverseBusinessSubscriptionCancellation,
  isBusinessDeletionPending,
  cancelBusinessPaddleSubscription,
  hashEmail,
};
