// Subscribe & Save — recurring order generation.
//
// CustomerSubscription rows (shop/controllers/subscriptions.controller.js) carry
// a nextDeliveryAt, but nothing ever consumed it — a customer could subscribe and
// no follow-up order was ever placed. This cron materializes the due deliveries:
// for every ACTIVE subscription whose nextDeliveryAt has passed, it generates a
// real PENDING order (the tenant fulfils + collects, like a COD order) and
// advances the schedule by one interval.
//
// There is no card-on-file / mandate in the platform yet, so generated orders are
// created unpaid (paymentMethod 'cod', status PENDING) rather than auto-charged —
// that's the honest, deliverable behaviour today. Auto-charge would need saved
// payment methods (SetupIntent / e-mandate), a separate larger feature.
'use strict';

const prisma = require('./prisma');

// Mirror of subscriptions.controller's addInterval (WEEKLY/MONTHLY × count).
function addInterval(from, kind, count) {
  const d = new Date(from);
  if (kind === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + count);
  else d.setUTCDate(d.getUTCDate() + 7 * count);
  return d;
}

// Process every ACTIVE subscription that is due now. Returns a summary.
// Each subscription advances its schedule even if its product/customer became
// invalid, so a single broken row can never wedge the queue or loop forever.
async function materializeDueSubscriptions({ now = new Date(), limit = 200 } = {}) {
  const due = await prisma.customerSubscription.findMany({
    where: { status: 'ACTIVE', nextDeliveryAt: { lte: now } },
    take: limit,
    orderBy: { nextDeliveryAt: 'asc' },
  });

  let created = 0;
  let skipped = 0;
  for (const sub of due) {
    // Advance from max(nextDeliveryAt, now) so a long cron outage produces ONE
    // catch-up order, not a backlog flood, and the next run is in the future.
    const base = sub.nextDeliveryAt && sub.nextDeliveryAt > now ? sub.nextDeliveryAt : now;
    const nextAt = addInterval(base, sub.intervalKind, sub.intervalCount);

    try {
      const [product, customer] = await Promise.all([
        prisma.product.findUnique({
          where: { id: sub.productId },
          select: { id: true, businessId: true, name: true, slug: true, priceMinor: true, currency: true, isPublished: true },
        }),
        prisma.customer.findUnique({
          where: { id: sub.customerId },
          select: { id: true, email: true, name: true },
        }),
      ]);

      // Skip (but still advance) if the product was unpublished/deleted, moved
      // business, or the customer has no email to send the order to.
      if (!product || product.businessId !== sub.businessId || !product.isPublished || !customer?.email) {
        await prisma.customerSubscription.update({ where: { id: sub.id }, data: { nextDeliveryAt: nextAt } });
        skipped += 1;
        continue;
      }

      // Reuse the customer's most recent delivery address. Without a prior order
      // we have no address, so skip (advance) rather than create an undeliverable
      // order — recurring delivery presupposes an established address on file.
      const lastOrder = await prisma.order.findFirst({
        where: { businessId: sub.businessId, customerId: sub.customerId, shippingAddress: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { shippingAddress: true, fulfillmentType: true, locationId: true },
      });
      if (!lastOrder?.shippingAddress) {
        await prisma.customerSubscription.update({ where: { id: sub.id }, data: { nextDeliveryAt: nextAt } });
        skipped += 1;
        continue;
      }

      const unitMinor = Math.max(0, product.priceMinor || 0);
      const discountedUnit = Math.round(unitMinor * (1 - Math.min(50, sub.discountPct || 0) / 100));
      const lineTotal = discountedUnit * sub.quantity;

      const order = await prisma.order.create({
        data: {
          businessId: sub.businessId,
          customerId: sub.customerId,
          customerEmail: customer.email,
          customerName: customer.name || 'Customer',
          shippingAddress: lastOrder.shippingAddress,
          paymentMethod: 'cod',
          fulfillmentType: lastOrder.fulfillmentType || 'DELIVERY',
          locationId: lastOrder.locationId || null,
          currency: product.currency || 'INR',
          subtotalMinor: lineTotal,
          totalMinor: lineTotal,
          status: 'PENDING',
          notes: 'Auto-generated from a Subscribe & Save subscription',
          items: {
            create: [{
              productId: product.id,
              productName: product.name,
              productSlug: product.slug,
              quantity: sub.quantity,
              priceMinor: discountedUnit,
              lineTotalMinor: lineTotal,
            }],
          },
        },
        select: { id: true },
      });

      await prisma.customerSubscription.update({
        where: { id: sub.id },
        data: { nextDeliveryAt: nextAt, lastDeliveryAt: now },
      });

      // Reuse the order webhook so tenant integrations see the recurring order.
      try {
        const { safeEmit } = require('./webhookDispatcher');
        safeEmit('order.created', { id: order.id, source: 'subscription', subscriptionId: sub.id }, sub.businessId);
      } catch { /* webhook is best-effort */ }

      created += 1;
    } catch (err) {
      // Advance the schedule even on failure so one bad row can't block the rest
      // or regenerate forever on the next tick.
      await prisma.customerSubscription.update({ where: { id: sub.id }, data: { nextDeliveryAt: nextAt } }).catch(() => {});
      // eslint-disable-next-line no-console
      console.error('[subscriptionMaterializer] failed for', sub.id, err?.message || err);
    }
  }

  return { due: due.length, created, skipped };
}

module.exports = { materializeDueSubscriptions, addInterval };
