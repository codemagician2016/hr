export const metadata = {
  title: 'Terms of Service · DriftHR',
  description: 'Terms of Service for DriftHR, operated by Loominfo Limited.',
};

// IMPORTANT: This document is a comprehensive starter drafted from common
// SaaS practice adapted to NZ Privacy Act 2020, GDPR, CCPA/CPRA, and
// international norms. It is NOT a substitute for advice from a
// qualified New Zealand commercial lawyer (with input from a privacy
// specialist for the cross-border bits). Have it reviewed before
// relying on it in production. Items in [SQUARE BRACKETS] are
// placeholders for facts only the company can confirm.

export const TERMS_VERSION = '2.0.0-2026-04-28';

export default function TermsPage() {
  return (
    <>
      <p className="text-xs font-mono uppercase tracking-[0.15em] text-indigo-600">Legal</p>
      <h1>Terms of Service</h1>
      <p className="text-sm text-gray-500 mt-0 mb-8">
        Effective date: 28 April 2026 · Version 2.0
      </p>

      <p>
        These Terms of Service (&ldquo;<strong>Terms</strong>&rdquo;) form a binding agreement between
        you (&ldquo;<strong>you</strong>&rdquo;, &ldquo;<strong>Business</strong>&rdquo;,
        &ldquo;<strong>Seller</strong>&rdquo;, or &ldquo;<strong>Customer</strong>&rdquo; as the
        context requires) and <strong>Loominfo Limited</strong>, a company registered in New Zealand
        under company number 9429052682902 with its registered office at
        17A Prictor Street, Papakura, Auckland, New Zealand
        (&ldquo;<strong>Loominfo</strong>&rdquo;, &ldquo;<strong>we</strong>&rdquo;,
        &ldquo;<strong>us</strong>&rdquo;). Loominfo operates the <strong>DriftHR</strong>
        platform at sitepresso.com (the &ldquo;<strong>Service</strong>&rdquo;).
      </p>

      <p>
        By creating an account, using the Service, or clicking &ldquo;I agree&rdquo;, you accept
        these Terms together with the linked <a href="/legal/privacy">Privacy Policy</a>,
        <a href="/legal/refund"> Refund Policy</a>, and <a href="/legal/sub-processors">Sub-Processors</a> page.
        If you do not agree, do not use the Service.
      </p>

      <h2>1. The Service</h2>
      <p>
        DriftHR is a multi-tenant software-as-a-service platform that lets businesses
        (&ldquo;<strong>Businesses</strong>&rdquo;) launch a hosted website on their own domain or
        a DriftHR subdomain. The Service supports three product verticals:
      </p>
      <ul>
        <li><strong>Marketing site (Static)</strong> &mdash; informational pages, contact form, custom CMS pages.</li>
        <li><strong>Booking site (Appointment)</strong> &mdash; calendar, services, staff, customer portal, accept appointments online.</li>
        <li><strong>Online shop (E-commerce)</strong> &mdash; product catalogue, cart, checkout, orders, fulfilment.</li>
      </ul>
      <p>
        End users of a Business&rsquo;s site (&ldquo;<strong>Customers</strong>&rdquo;) may book
        appointments, send enquiries, place product orders, or otherwise interact with the
        Business. The Business is responsible for the goods, services, content, and customer
        relationship; Loominfo provides only the underlying software.
      </p>

      <h2>2. Eligibility</h2>
      <p>
        You must be at least 18 years old (or the legal age of majority in your jurisdiction) and
        able to form a legally binding contract. If you sign up on behalf of a company or other
        entity, you warrant that you are authorised to bind that entity to these Terms.
      </p>

      <h2>3. Your account</h2>
      <p>
        You are responsible for the security of your account credentials and for all activity
        under your account. You must notify us immediately at
        {' '}<a href="mailto:support@sitepresso.com">support@sitepresso.com</a> if you suspect
        unauthorised access. We may suspend any account we reasonably believe has been compromised
        or is being used in breach of these Terms.
      </p>

      <h2>4. Acceptable use</h2>
      <p>You must not, and must not permit anyone else to:</p>
      <ul>
        <li>use the Service for any unlawful purpose or in violation of applicable laws;</li>
        <li>send unsolicited bulk messages, spam, phishing, scams, or fraudulent communications;</li>
        <li>upload or distribute malware, infringing content, hate speech, sexually explicit material involving minors, or content that glorifies or incites violence;</li>
        <li>sell counterfeit goods or items prohibited by law in either the seller or the buyer&rsquo;s jurisdiction;</li>
        <li>attempt to gain unauthorised access to the Service, other users&rsquo; accounts, or our underlying systems;</li>
        <li>scrape, mirror, reverse-engineer, or probe the Service for vulnerabilities except under a written security research agreement with us;</li>
        <li>use the Service to harass, stalk, dox, or otherwise harm any person;</li>
        <li>resell, white-label, or sublicence the Service without our prior written consent.</li>
      </ul>
      <p>Breach of this section may result in immediate suspension or termination of the Service without refund.</p>

      <h2>5. Content you provide</h2>
      <p>
        You retain ownership of content you upload to the Service (including business details,
        logos, photos, written copy, products, services, prices, customer records, orders, and
        end-customer personal data).
      </p>
      <p>
        You grant Loominfo a worldwide, non-exclusive, royalty-free licence to host, store, copy,
        display, transmit, and distribute that content strictly to the extent necessary to operate,
        provide, secure, and improve the Service for you and your Customers, and to anonymously
        aggregate it for product analytics and benchmarking.
      </p>
      <p>
        You warrant that you have all rights necessary to upload your content and that your
        content does not infringe the rights of any third party. You are responsible for the
        accuracy and lawfulness of content you publish, including product descriptions, service
        prices, and any claims about your goods or services.
      </p>

      <h2>6. Customer data &mdash; data roles</h2>
      <p>
        Where you are a Business storing personal data about your own end customers on the
        Service, you are the data &ldquo;controller&rdquo; (GDPR / UK GDPR), the
        &ldquo;agency&rdquo; (NZ Privacy Act), or the &ldquo;business&rdquo; (CCPA/CPRA) of that
        data, and we act as your &ldquo;processor&rdquo; / &ldquo;agent&rdquo; / &ldquo;service
        provider&rdquo; respectively. We process your customers&rsquo; personal data only on your
        documented instructions, consistent with our <a href="/legal/privacy">Privacy Policy</a>
        {' '}and any Data Processing Addendum we enter into with you. A current list of our
        sub-processors is at <a href="/legal/sub-processors">/legal/sub-processors</a>.
      </p>
      <p>
        You are responsible for: (a) having a lawful basis to collect and store your customers&rsquo;
        data; (b) providing your customers with appropriate notice of how their data is used,
        including identifying us as your processor; (c) honouring data-subject requests
        (access / correct / delete / port) you receive; and (d) complying with applicable laws
        in the jurisdictions where you and your customers reside.
      </p>

      <h2>7. E-commerce: marketplace role and money flow</h2>
      <p>
        Where you operate an Online Shop on the Service, end-customer payments for goods and
        services flow directly from the buyer to you via your connected payment processor
        (currently <strong>Razorpay Route</strong> for Indian sellers and
        {' '}<strong>Stripe Connect</strong> for global sellers; see Sub-Processors for the full
        list). <strong>Loominfo never holds, settles, or remits buyer funds on your behalf.</strong>
        {' '}You are the seller of record. You are solely responsible for fulfilment, shipping,
        returns, refunds to buyers, GST/VAT, sales tax, customs duties, and any consumer-protection
        obligations in the jurisdictions where you sell.
      </p>
      <p>
        Loominfo&rsquo;s separate fee for use of the platform (the subscription fee) is paid by
        you to us under section 8 below. That subscription fee is independent of any sales you
        make through the Service.
      </p>

      <h2>8. Fees, card-required trial, subscriptions, and renewals</h2>
      <p>
        Public DriftHR plans are paid subscriptions. We may keep an internal fallback state
        for expired, cancelled, or support-managed accounts.
      </p>
      <p>
        <strong>Card-required trial.</strong> Some paid plans include a trial. Trial availability,
        duration, and gateway are shown at checkout for the plan you select. Your payment method
        is captured at checkout, but the first subscription charge is not taken until the trial
        ends unless you cancel before then. A trial may only be used once per account.
      </p>
      <p>
        <strong>Paid subscriptions.</strong> Paid plans are billed in advance on a monthly or
        yearly cycle and auto-renew unless you cancel before the renewal date through your
        account settings. Subscription checkout is routed by billing country: Paddle acts as
        Merchant of Record where Paddle processes the subscription, while India is processed
        through Razorpay and New Zealand through Stripe.
      </p>
      <p>
        <strong>No refund after charge.</strong> Because the first subscription charge happens
        after the trial period, fees once charged are non-refundable except where required by law
        (including the New Zealand Consumer Guarantees Act 1993 and any equivalent statutory
        consumer-protection law in your jurisdiction) or as set out in our
        {' '}<a href="/legal/refund">Refund Policy</a>.
      </p>
      <p>
        <strong>Price changes.</strong> We may change subscription fees on at least 30 days&rsquo;
        written notice; the new price applies from your next renewal. If you do not accept the
        new price, you may cancel before it takes effect.
      </p>

      <h2>9. Payment processing</h2>
      <p>
        <strong>For DriftHR subscription payments</strong> (what you pay us): we use a
        country-routed billing stack: <strong>Paddle</strong> for most countries,
        <strong> Razorpay</strong> for India, and <strong>Stripe</strong> for New Zealand.
        These providers handle checkout and payment-card data. Loominfo does not store full
        payment card numbers.
      </p>
      <p>
        <strong>For end-customer payments to Businesses</strong> (what your buyers pay you): see
        section 7 above.
      </p>
      <p>
        Where any subscription payment fails or is reversed, we may suspend your access until the
        balance is resolved.
      </p>

      <h2>10. Availability, support, and changes</h2>
      <p>
        We aim to make the Service available 24/7 but do not guarantee uninterrupted or
        error-free operation. We may perform planned maintenance or make changes that temporarily
        affect availability, and we may modify, add, or remove features at our discretion.
      </p>
      <p>
        Support is provided primarily by email at
        {' '}<a href="mailto:support@sitepresso.com">support@sitepresso.com</a>. Response-time
        targets and any service credits are described on the relevant pricing page.
      </p>

      <h2>11. Termination</h2>
      <p>
        You may terminate at any time by cancelling your subscription and closing your account.
        We may terminate or suspend your account (a) immediately for material breach of these
        Terms (including section 4 acceptable use), (b) on 30 days&rsquo; written notice for
        convenience, or (c) if we discontinue the Service.
      </p>
      <p>
        On termination we will delete your account data within 30 days, except where we are
        required by law to retain it longer (for example tax records). You may request an export
        of your data before termination using your in-product Settings or by emailing us.
      </p>

      <h2>12. Intellectual property</h2>
      <p>
        Loominfo and its licensors retain all right, title, and interest in the Service,
        including all software, code, designs, trademarks, and the &ldquo;DriftHR&rdquo;
        brand. We grant you a limited, non-exclusive, non-transferable licence to use the
        Service for your business during the term of these Terms. No other licence is granted.
      </p>

      <h2>13. Disclaimers</h2>
      <p>
        To the maximum extent permitted by law, the Service is provided &ldquo;as is&rdquo; and
        &ldquo;as available&rdquo;. We disclaim all implied warranties including merchantability,
        fitness for a particular purpose, and non-infringement.
      </p>
      <p>
        Nothing in these Terms excludes, limits, or modifies any consumer guarantee, right or
        remedy conferred by the New Zealand Consumer Guarantees Act 1993 or any equivalent
        consumer-protection law in your jurisdiction that cannot lawfully be excluded.
      </p>

      <h2>14. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, Loominfo&rsquo;s total aggregate liability to you
        arising out of or relating to these Terms or the Service, in any rolling 12-month period,
        is limited to the greater of (a) the subscription fees you have paid to us in that period,
        or (b) NZ$500.
      </p>
      <p>
        We are not liable for indirect, incidental, special, consequential, exemplary, or
        punitive damages, or for any loss of profits, revenue, goodwill, anticipated savings,
        sales, or data, however arising. We are not liable for end-customer disputes you have with
        your own buyers, including refund disputes, fulfilment disputes, or chargebacks &mdash;
        you are the seller of record.
      </p>

      <h2>15. Indemnity</h2>
      <p>
        You will indemnify and hold Loominfo (including its officers, employees, and contractors)
        harmless from any claim, loss, liability, or expense (including reasonable legal fees)
        arising out of or relating to: your use of the Service; content you upload; products or
        services you sell through the Service; your breach of these Terms; or your breach of any
        law (including consumer-protection, privacy, tax, or product-safety law).
      </p>

      <h2>16. Governing law and disputes</h2>
      <p>
        These Terms are governed by the laws of New Zealand. The parties submit to the
        <strong> exclusive jurisdiction of the courts of New Zealand sitting in Auckland</strong>.
      </p>
      <p>
        Where a mandatory consumer-protection statute in your jurisdiction grants you a right
        to bring proceedings in your local courts, that right is preserved &mdash; this is a
        statement of fact under those laws, not an additional concession.
      </p>

      <h2>17. Changes to these Terms</h2>
      <p>
        We may update these Terms from time to time. If a change is material we will notify you
        by email, in-product notice, or by requiring you to accept an updated version on your
        next sign-in at least 30 days before it takes effect. Your continued use of the Service
        after the effective date constitutes acceptance.
      </p>

      <h2>18. General</h2>
      <p>
        These Terms (together with the linked Privacy Policy, Refund Policy, and
        Sub-Processors page) are the entire agreement between you and Loominfo relating to the
        Service. If a provision is held unenforceable, the remainder will stay in effect. Our
        failure to enforce any right is not a waiver. You may not assign these Terms without our
        consent; we may assign them to an affiliate or successor in connection with a merger,
        acquisition, or sale of assets.
      </p>

      <h2>19. Contact</h2>
      <p>
        Questions about these Terms: <a href="mailto:support@sitepresso.com">support@sitepresso.com</a><br />
        Loominfo Limited, 17A Prictor Street, Papakura, Auckland, New Zealand<br />
        Company number: 9429052682902
      </p>

      <p className="text-xs text-gray-500 mt-12 pt-6 border-t border-gray-200">
        Version 2.0.0-2026-04-28. Previous versions are available on request.
      </p>
    </>
  );
}
