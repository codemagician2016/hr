// Embedded Razorpay Checkout for SaaS-subscription activation.
//
// Why this exists: the backend creates a Razorpay Subscription and returns its
// hosted `short_url`. That page is TERMINAL — after the buyer authorizes the
// mandate, Razorpay never redirects back, so the user is stranded and tends to
// re-authorize repeatedly. Opening Checkout.js with the `subscription_id`
// instead gives us a `handler` callback that fires (client-side, session intact)
// the moment authorization completes, so we can bring the user straight back to
// the admin where the existing ?billing=success&gateway=razorpay sync activates
// the plan. It authorizes the SAME already-created subscription — it never
// creates a new subscription or charge.

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export function loadRazorpayCheckout() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('Razorpay Checkout needs a browser'));
    if (window.Razorpay) return resolve(window.Razorpay);
    const existing = document.querySelector(`script[src="${CHECKOUT_SRC}"]`);
    if (existing) {
      if (window.Razorpay) return resolve(window.Razorpay);
      existing.addEventListener('load', () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay failed to initialise'))));
      existing.addEventListener('error', () => reject(new Error('Razorpay Checkout failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Razorpay failed to initialise')));
    script.onerror = () => reject(new Error('Razorpay Checkout failed to load'));
    document.body.appendChild(script);
  });
}

// Open the embedded checkout for an already-created subscription.
// onSuccess fires after the buyer authorizes; onDismiss fires if they close it.
// Throws if Checkout.js can't load (callers should fall back to the hosted URL).
export async function openRazorpaySubscriptionCheckout({
  keyId,
  subscriptionId,
  name = 'DriftHR',
  description = 'Activate your plan',
  prefill = {},
  onSuccess,
  onDismiss,
  onFailed,
}) {
  if (!keyId || !subscriptionId) throw new Error('Razorpay Checkout requires keyId + subscriptionId');
  const Razorpay = await loadRazorpayCheckout();
  const rzp = new Razorpay({
    key: keyId,
    subscription_id: subscriptionId,
    name,
    description,
    ...(prefill && Object.keys(prefill).length ? { prefill } : {}),
    handler: () => { if (typeof onSuccess === 'function') onSuccess(); },
    modal: { ondismiss: () => { if (typeof onDismiss === 'function') onDismiss(); } },
  });
  if (typeof onFailed === 'function') {
    rzp.on('payment.failed', (resp) => onFailed(resp));
  }
  rzp.open();
  return rzp;
}
