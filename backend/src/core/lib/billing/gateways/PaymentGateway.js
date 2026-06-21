//
// PaymentGateway — the contract every gateway adapter (Paddle/Stripe/Razorpay)
// implements so the rest of the app can drive billing without knowing which
// processor is behind a given customer. Methods return NORMALIZED shapes (see
// below) so callers never branch on the gateway.
//
// This is plain JS (no TS), so the "interface" is this documented base class:
// adapters override what they support; anything unimplemented throws loudly.
//
// Normalized event shape (returned by normalizeEvent):
//   {
//     gateway:               'PADDLE' | 'STRIPE' | 'RAZORPAY',
//     kind:                  'subscription_change' | 'transaction_completed'
//                            | 'payment_failed' | 'refund' | 'ignored',
//     internalStatus:        'TRIALING'|'ACTIVE'|'PAST_DUE'|'CANCELLED'|'PAUSED'|null,
//     gatewayCustomerId:     String|null,
//     gatewaySubscriptionId: String|null,
//     gatewayTransactionId:  String|null,   // invoice / payment / txn id
//     priceRef:              String|null,   // gateway price/plan id (→ tier lookup)
//     currency:              String|null,
//     amountMinor:           Number|null,
//     currentPeriodEnd:      Date|null,
//     metadata:              Object,         // our custom data (businessId, …)
//     rawType:               String,         // original event type, for logs
//   }
//
class PaymentGateway {
  constructor(name) {
    this.name = name;
  }

  // Is this gateway usable in the current environment (keys present)?
  isConfigured() { return false; }

  // 'test' | 'live' — used to gate sandbox-only tooling.
  environment() { return 'test'; }

  // Create a hosted subscription checkout. Returns { url, reference }.
  async createSubscriptionCheckout(/* { business, priceRef, quantity, trialDays, customerEmail, customerRef, successUrl, cancelUrl, metadata } */) {
    throw new Error(`${this.name}: createSubscriptionCheckout not implemented`);
  }

  // Verify + parse a raw webhook. Returns the gateway-native event or throws on
  // a bad signature.
  verifyWebhook(/* { rawBody, signatureHeader } */) {
    throw new Error(`${this.name}: verifyWebhook not implemented`);
  }

  // Map a gateway-native event to the normalized shape documented above.
  normalizeEvent(/* event */) {
    throw new Error(`${this.name}: normalizeEvent not implemented`);
  }

  async cancelSubscription(/* subscriptionRef, { immediately } */) {
    throw new Error(`${this.name}: cancelSubscription not implemented`);
  }

  async refund(/* { paymentRef, amountMinor } */) {
    throw new Error(`${this.name}: refund not implemented`);
  }
}

module.exports = { PaymentGateway };
