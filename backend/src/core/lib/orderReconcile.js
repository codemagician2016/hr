'use strict';

// Pure (DB-free) money math for grocery pick-exception reconciliation.
//
// During picking a grocery order can change shape: a sold-by-weight item is
// weighed to its actual weight, an out-of-stock line is substituted for
// another product, or a line is "shorted" (some/all units unavailable and
// refunded). Each of those changes what the customer should actually be
// charged. These helpers recompute line + order totals from the persisted
// OrderItem pick-state so the admin endpoints and the customer approval flow
// agree on the numbers. Side-effect-free on purpose — unit-testable and reused
// in several places.

// Substitution states whose price the customer has (implicitly or explicitly)
// agreed to. A still-PROPOSED swap bills nothing extra until it resolves.
const SUBSTITUTION_APPLIED = new Set(['ACCEPTED', 'AUTO_ACCEPTED']);

// Price (minor units) for `grams` of a sold-by-weight product at `pricePerKgMinor`.
function weightLineMinor(pricePerKgMinor, grams) {
  if (!pricePerKgMinor || !grams) return 0;
  return Math.round((pricePerKgMinor * grams) / 1000);
}

// What a single line should bill given its current pick state.
function effectiveLineTotal(item) {
  if (!item) return 0;
  const status = item.fulfillmentStatus || 'PENDING';

  // Accepted substitution → bill the replacement (by weight when the
  // substitute is itself sold by weight, else price × qty).
  if (status === 'SUBSTITUTED' && SUBSTITUTION_APPLIED.has(item.substitutionStatus)) {
    if (item.substituteWeightGrams && item.pricePerKgMinor) {
      return weightLineMinor(item.pricePerKgMinor, item.substituteWeightGrams);
    }
    const qty = item.substituteQuantity || item.quantity || 0;
    return (item.substitutePriceMinor || 0) * qty;
  }

  // Shorted → only the fulfilled remainder is billed.
  if (status === 'SHORTED') {
    const fulfilled = Math.max(0, (item.quantity || 0) - (item.shortedQuantity || 0));
    if (item.soldByWeight) {
      return fulfilled > 0 && item.pickedWeightGrams
        ? weightLineMinor(item.pricePerKgMinor, item.pickedWeightGrams)
        : 0;
    }
    return (item.priceMinor || 0) * fulfilled;
  }

  // Picked sold-by-weight line → reprice from the actual weighed amount.
  if (item.soldByWeight && item.pickedWeightGrams) {
    return weightLineMinor(item.pricePerKgMinor, item.pickedWeightGrams);
  }

  // Untouched, or picked exactly as ordered.
  return item.lineTotalMinor || 0;
}

// Recompute order subtotal + total from current line states. Mirrors the
// checkout formula: total = max(0, subtotal + shipping + tax − discount), with
// the slot surcharge already folded into shippingMinor at checkout.
function reconcileTotals(order) {
  const items = order?.items || [];
  const subtotalMinor = items.reduce((sum, it) => sum + effectiveLineTotal(it), 0);
  const shippingMinor = order?.shippingMinor || 0;
  const taxMinor = order?.taxMinor || 0;
  const discountMinor = order?.discountMinor || 0;
  const adjustedTotalMinor = Math.max(0, subtotalMinor + shippingMinor + taxMinor - discountMinor);
  const originalTotalMinor = order?.totalMinor || 0;
  // Positive deltaMinor = the customer was charged more than now due → owed a
  // refund. Negative = order grew (rare; capped by policy, never auto-charged).
  const deltaMinor = originalTotalMinor - adjustedTotalMinor;
  return { subtotalMinor, adjustedTotalMinor, originalTotalMinor, deltaMinor };
}

// Has this line reached a state that no longer blocks picking from completing?
// A substitution still awaiting customer approval (PROPOSED) blocks; everything
// else (picked, shorted, accepted/rejected substitution) is resolved.
function isLineResolved(item, pickedQuantity) {
  const status = item?.fulfillmentStatus || 'PENDING';
  if (status === 'SUBSTITUTED') return item.substitutionStatus !== 'PROPOSED';
  if (status === 'SHORTED') return true;
  if (item?.soldByWeight) return item.pickedWeightGrams != null;
  return (pickedQuantity || 0) >= (item?.quantity || 0);
}

// Grocery fulfilment KPIs over a set of order rows (each with items +
// promisedAt/deliveredAt/pickedUpAt). Pure so the reports endpoint can hand it
// query results and it stays unit-testable. Rates are percentages to 1 dp, or
// null when there's no denominator (so the UI can show "—" instead of 0%).
function computeFulfillmentRates(orders) {
  let total = 0;
  let promised = 0;
  let onTime = 0;
  let orderedUnits = 0;
  let fulfilledUnits = 0;
  let ordersWithSubstitution = 0;
  let ordersWithShort = 0;

  for (const o of orders || []) {
    total += 1;
    const completedAt = o.deliveredAt || o.pickedUpAt || null;
    if (o.promisedAt && completedAt) {
      promised += 1;
      if (new Date(completedAt).getTime() <= new Date(o.promisedAt).getTime()) onTime += 1;
    }
    let subbed = false;
    let shorted = false;
    for (const it of o.items || []) {
      const qty = it.quantity || 0;
      orderedUnits += qty;
      const short = it.fulfillmentStatus === 'SHORTED' ? (it.shortedQuantity || 0) : 0;
      fulfilledUnits += Math.max(0, qty - short); // substituted lines count as filled
      if (it.fulfillmentStatus === 'SUBSTITUTED') subbed = true;
      if (it.fulfillmentStatus === 'SHORTED') shorted = true;
    }
    if (subbed) ordersWithSubstitution += 1;
    if (shorted) ordersWithShort += 1;
  }

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
  return {
    totalOrders: total,
    promisedOrders: promised,
    onTimeOrders: onTime,
    onTimeRate: pct(onTime, promised),
    orderedUnits,
    fulfilledUnits,
    fillRate: pct(fulfilledUnits, orderedUnits),
    ordersWithSubstitution,
    substitutionRate: pct(ordersWithSubstitution, total),
    ordersWithShort,
    shortRate: pct(ordersWithShort, total),
  };
}

module.exports = {
  SUBSTITUTION_APPLIED,
  weightLineMinor,
  effectiveLineTotal,
  reconcileTotals,
  isLineResolved,
  computeFulfillmentRates,
};
