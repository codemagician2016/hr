export const metadata = {
  title: 'Refund Policy · Sitepresso',
  description: 'Refund Policy for Sitepresso subscriptions, operated by Loominfo Limited.',
};

// IMPORTANT: This is a starter draft. Sitepresso uses card-required subscription
// trials before the first charge. NZ Consumer Guarantees Act,
// EU consumer-withdrawal rights for B2C, and equivalent mandatory statutes
// still apply on top of this policy. Have a NZ commercial lawyer review
// before launch.

export const REFUND_VERSION = '1.0.0-2026-04-28';

export default function RefundPage() {
  return (
    <>
      <p className="text-xs font-mono uppercase tracking-[0.15em] text-indigo-600">Legal</p>
      <h1>Refund Policy</h1>
      <p className="text-sm text-gray-500 mt-0 mb-8">
        Effective date: 28 April 2026 · Version 1.0
      </p>

      <p>
        This Refund Policy applies to subscription fees you pay to <strong>Loominfo Limited</strong>
        {' '}(NZBN 9429052682902) for the Sitepresso platform at sitepresso.com (the
        &ldquo;<strong>Service</strong>&rdquo;). It does <em>not</em> apply to refunds you give
        your own end customers for products or services you sell through the Service &mdash; you
        are the seller of record for those (see <a href="/legal/terms#section-7">Terms section 7</a>).
      </p>

      <h2>1. Try before you buy &mdash; plan-configured trials</h2>
      <p>
        Some paid Sitepresso plans include a <strong>card-required trial</strong>.
        Trial availability and duration are shown at checkout for the plan you select.
        Your payment method is captured at checkout, but the first subscription charge is
        not taken until the trial ends unless you cancel before then.
      </p>
      <p>
        At the end of the trial:
      </p>
      <ul>
        <li>If the subscription remains active, the selected billing gateway charges the first subscription fee automatically.</li>
        <li>If you cancel before the trial ends, future subscription charges stop.</li>
      </ul>

      <h2>2. No refund after charge</h2>
      <p>
        Because you can evaluate the Service for 30 days before the first subscription charge,
        fees are <strong>non-refundable once charged</strong>. This applies to:
      </p>
      <ul>
        <li>Monthly subscription fees once a billing cycle has begun.</li>
        <li>Annual subscription fees, including for unused months remaining in the year.</li>
        <li>Plan upgrades mid-cycle.</li>
        <li>Add-ons, additional staff seats, SMS credits, or any other paid feature.</li>
      </ul>
      <p>
        You may cancel renewal at any time through your account settings. Cancellation stops
        future charges; it does not refund the current cycle.
      </p>

      <h2>3. Statutory rights we cannot exclude</h2>
      <p>
        Nothing in this policy excludes, limits, or modifies any consumer guarantee, right, or
        remedy that you are entitled to under a mandatory law that cannot lawfully be excluded.
        In particular:
      </p>
      <ul>
        <li>
          <strong>New Zealand &mdash; Consumer Guarantees Act 1993.</strong> If you are a consumer
          (not in trade) under NZ law, your statutory guarantees apply on top of this policy. Where
          the Service has a substantial failure that we cannot remedy in a reasonable time, you
          may be entitled to a refund or to reject the Service.
        </li>
        <li>
          <strong>EU/EEA &mdash; Consumer Rights Directive.</strong> Where you are a consumer in
          the EU/EEA buying as a natural person for non-professional purposes, you have a 14-day
          right of withdrawal beginning when the contract is concluded, except where you have
          expressly requested immediate provision of the digital service and acknowledged that
          you lose the withdrawal right by doing so. By starting your paid subscription before
          the 14th day after sign-up, you agree to immediate provision and waive the withdrawal
          right.
        </li>
        <li>
          <strong>UK &mdash; Consumer Contracts Regulations 2013</strong> apply equivalently for
          UK consumers.
        </li>
        <li>
          <strong>Australia &mdash; Australian Consumer Law.</strong> Consumer guarantees apply on
          top of this policy.
        </li>
        <li>
          <strong>Other jurisdictions.</strong> Where local law grants you a non-waivable refund
          right, that right takes precedence over the no-refund stance above.
        </li>
      </ul>
      <p>
        If you believe a mandatory consumer-protection statute entitles you to a refund, email
        {' '}<a href="mailto:support@sitepresso.com">support@sitepresso.com</a> with your account
        email, the charge in question, and the basis of your claim. We will respond within 14
        days.
      </p>

      <h2>4. Discretionary refunds we may grant</h2>
      <p>
        We may, at our discretion and outside any legal obligation, grant a refund or service
        credit in cases such as:
      </p>
      <ul>
        <li>A duplicate charge caused by a billing error on our side.</li>
        <li>A clear malfunction of the Service that we cannot remedy in a reasonable period and that materially affects your use of the paid plan.</li>
        <li>You were charged after we discontinued a feature we had advertised as included in your plan.</li>
        <li>Sitepresso shuts down the Service while you have prepaid time remaining (in which case we will refund the unused portion pro rata).</li>
      </ul>
      <p>
        Discretionary refunds, if granted, are issued back to the original payment method within
        14 days of approval and are made via the relevant subscription payment processor
        (Paddle, Razorpay, or Stripe), which may take 3-10 business days to clear depending
        on your bank.
      </p>

      <h2>5. Chargebacks</h2>
      <p>
        If you raise a payment-card chargeback or dispute without first contacting us, we may
        suspend your account while we investigate. Where the chargeback is upheld, we may
        terminate your account and recover any fees and dispute charges incurred. We strongly
        prefer to resolve any billing concern by email before you involve your card issuer.
      </p>

      <h2>6. End-customer refunds (e-commerce)</h2>
      <p>
        If you operate an Online Shop on the Service and your buyer asks for a refund:
      </p>
      <ul>
        <li>You are the seller of record. Your published store policy and applicable consumer-protection law govern whether a refund is owed.</li>
        <li>Refunds to buyers are issued through your connected payment processor (Razorpay Route, Stripe Connect, or whichever provider you have integrated). Loominfo never holds buyer funds.</li>
        <li>You can mark an order as REFUNDED in admin to keep your records consistent; this is a status change in our system, not a money movement.</li>
        <li>Sitepresso&rsquo;s subscription fee to you is unaffected by refunds you give your buyers.</li>
      </ul>

      <h2>7. How to request a refund or raise a billing concern</h2>
      <p>
        Email <a href="mailto:support@sitepresso.com">support@sitepresso.com</a> with:
      </p>
      <ul>
        <li>The email address on your Sitepresso account.</li>
        <li>The charge date and amount.</li>
        <li>The reason for your request, including any statutory basis if relying on local consumer-protection law.</li>
      </ul>
      <p>
        We aim to acknowledge within 2 business days and resolve within 14 days. Complex
        statutory-rights claims may take longer; we will keep you informed.
      </p>

      <h2>8. Changes to this policy</h2>
      <p>
        We may update this Refund Policy. Material changes take effect 30 days after we notify
        registered account holders by email or in-product notice; the new version applies to
        charges occurring after the effective date. Charges made before that date are governed
        by the version in force at the time.
      </p>

      <h2>9. Contact</h2>
      <p>
        <a href="mailto:support@sitepresso.com">support@sitepresso.com</a><br />
        Loominfo Limited, 17A Prictor Street, Papakura, Auckland, New Zealand<br />
        Company number: 9429052682902
      </p>

      <p className="text-xs text-gray-500 mt-12 pt-6 border-t border-gray-200">
        Version 1.0.0-2026-04-28.
      </p>
    </>
  );
}
