export const metadata = {
  title: 'Privacy Policy · Sitepresso',
  description: 'How Loominfo Limited collects, uses, and protects personal information on Sitepresso.',
};

// IMPORTANT: This is a comprehensive starter draft for global compliance
// (NZ Privacy Act 2020 · GDPR · UK GDPR · CCPA/CPRA · PIPEDA · Australian
// Privacy Act 1988). It is NOT a substitute for advice from a qualified
// privacy lawyer. Items in [SQUARE BRACKETS] are placeholders only the
// company can confirm.

export const PRIVACY_VERSION = '2.0.0-2026-04-28';

export default function PrivacyPage() {
  return (
    <>
      <p className="text-xs font-mono uppercase tracking-[0.15em] text-indigo-600">Legal</p>
      <h1>Privacy Policy</h1>
      <p className="text-sm text-gray-500 mt-0 mb-8">
        Effective date: 28 April 2026 · Version 2.0
      </p>

      <p>
        This Privacy Policy explains how <strong>Loominfo Limited</strong>
        (&ldquo;<strong>Loominfo</strong>&rdquo;, &ldquo;<strong>we</strong>&rdquo;,
        &ldquo;<strong>us</strong>&rdquo;) collects, uses, discloses, and protects personal
        information when you use the Sitepresso platform at sitepresso.com (the
        &ldquo;<strong>Service</strong>&rdquo;).
      </p>
      <p>
        We comply with the New Zealand Privacy Act 2020 and &mdash; where they apply &mdash; the
        EU General Data Protection Regulation (GDPR), the UK GDPR, the California Consumer
        Privacy Act / California Privacy Rights Act (CCPA/CPRA), the Canadian Personal Information
        Protection and Electronic Documents Act (PIPEDA), the Australian Privacy Act 1988, and
        equivalent privacy laws in jurisdictions where we have users.
      </p>

      <h2>Who we are and how to contact us</h2>
      <p>
        <strong>Loominfo Limited</strong>, a company registered in New Zealand under company
        number 9429052682902.<br />
        Registered office: 17A Prictor Street, Papakura, Auckland, New Zealand.<br />
        General privacy contact: <a href="mailto:support@sitepresso.com">support@sitepresso.com</a>
      </p>
      <p>
        <strong>Privacy Officer</strong> (designated under New Zealand Privacy Act 2020 s23):
        Kiran Pal Singh, reachable at <a href="mailto:support@sitepresso.com">support@sitepresso.com</a>.
        The Privacy Officer is responsible for ensuring our compliance with the Privacy Act,
        handling privacy enquiries, and dealing with data-subject requests.
      </p>
      <p>
        For EU/EEA, UK, and other-jurisdiction residents, please contact us via the address
        and email above. As a New Zealand-based company without an EU establishment, we have
        not yet appointed an EU/UK GDPR Article 27 representative. We will do so as our user
        base in those jurisdictions grows. Until then, EU/UK residents can exercise their
        rights directly via the contact above; complaints can be raised with their national
        supervisory authority.
      </p>

      <h2>1. Personal information we collect</h2>

      <p><strong>From Business account holders</strong> (you, when you sign up):</p>
      <ul>
        <li>Identity: name, email address, phone number, password (hashed), preferred language.</li>
        <li>Business details: business name, address, country, timezone, category, vertical, contact email and phone, logo and branding assets.</li>
        <li>Billing: payment-card data is collected and stored by the subscription payment processor used for your billing country (Paddle, Razorpay, or Stripe); we receive only a token, limited payment metadata, and billing-country information.</li>
        <li>Content: anything you upload to your storefront &mdash; pages, services, products, prices, photos, videos, copy, and your end-customers&rsquo; data that you choose to store on the Service.</li>
      </ul>

      <p><strong>From end Customers of Businesses</strong> (visitors to a Business&rsquo;s site):</p>
      <ul>
        <li>Booking, enquiry, or order details &mdash; name, email, phone, message, shipping address (if applicable), product selections, dates and times.</li>
        <li>Customer-account credentials if you create an account on a Business&rsquo;s storefront.</li>
        <li>Technical data &mdash; IP address, device type, browser, operating system, referral source.</li>
        <li>Strictly necessary cookies for authentication, session management, and shopping-cart state (where applicable).</li>
      </ul>

      <p><strong>From everyone who uses the Service:</strong></p>
      <ul>
        <li>Service-operational logs &mdash; pages visited, actions taken, timestamps, error reports.</li>
        <li>Correspondence you send us (email, support tickets, in-product feedback).</li>
        <li>Optional analytics events if we have asked for and received your consent (see Cookies below).</li>
      </ul>

      <h2>2. Why we collect it (legal bases under GDPR / equivalents)</h2>
      <ul>
        <li><strong>Contract performance</strong> &mdash; to provide the Service you signed up for, send essential service emails (booking confirmations, security alerts, billing receipts), and process payments.</li>
        <li><strong>Legitimate interests</strong> &mdash; to prevent fraud and abuse, secure the Service, debug and improve features, and analyse usage in aggregate. We have assessed that these interests are not overridden by your rights.</li>
        <li><strong>Legal obligation</strong> &mdash; to comply with tax, accounting, regulatory, and law-enforcement obligations.</li>
        <li><strong>Consent</strong> &mdash; where legally required (for example non-essential analytics cookies, or opt-in marketing emails), we rely on your consent which you can withdraw at any time. Withdrawal does not affect prior lawful processing.</li>
        <li><strong>Vital interests</strong> &mdash; in rare cases involving a serious threat to life or safety.</li>
      </ul>

      <h2>3. Data roles (Controller / Processor)</h2>
      <p>
        When a Business stores personal data about its own end customers on the Service, the
        Business is the &ldquo;controller&rdquo; (GDPR), &ldquo;agency&rdquo; (NZ Privacy Act),
        or &ldquo;business&rdquo; (CCPA) of that data. Loominfo acts as the
        &ldquo;processor&rdquo;, &ldquo;agent&rdquo;, or &ldquo;service provider&rdquo;
        respectively. We process your customers&rsquo; personal data only on the Business&rsquo;s
        documented instructions, consistent with these Terms and any Data Processing Addendum.
      </p>
      <p>
        For data we collect directly from you (Businesses signing up for the platform, or end
        Customers using platform-level features such as the customer portal), Loominfo is the
        controller / business.
      </p>

      <h2>4. How we share personal information</h2>
      <p>
        We share personal data only with the sub-processors listed on our
        {' '}<a href="/legal/sub-processors">Sub-Processors</a> page. All sub-processors are bound
        by written contract to protect your data and may only process it on our documented
        instructions. We require them to provide at least an equivalent level of protection to
        what is set out in this Policy.
      </p>
      <p>
        We do <strong>not</strong> sell personal information. We do not share your personal
        information for cross-context behavioural advertising. Under CCPA/CPRA terminology, we do
        not &ldquo;sell&rdquo; or &ldquo;share&rdquo; personal information.
      </p>
      <p>
        We may disclose personal data where legally required &mdash; for example, in response to
        a valid subpoena, court order, or request from a competent authority &mdash; and we will
        challenge overly broad requests where we reasonably can. We may also disclose data in
        connection with a corporate transaction (merger, acquisition, asset sale) provided the
        recipient is bound by privacy obligations no less protective than this Policy.
      </p>

      <h2>5. International transfers</h2>
      <p>
        The Service is hosted on Amazon Web Services in the Asia Pacific (Mumbai) region
        (<code>ap-south-1</code>) on our staging environment, and on the same region for
        production. Where your data is transferred outside the country in which you reside
        &mdash; for example, EU/UK data transferred to our AWS region &mdash; the transfer is
        safeguarded by:
      </p>
      <ul>
        <li>The European Commission&rsquo;s Standard Contractual Clauses (SCCs) and the UK&rsquo;s International Data Transfer Agreement (IDTA) where applicable, with supplementary measures (encryption in transit and at rest).</li>
        <li>AWS&rsquo;s certifications including ISO 27001, ISO 27017, ISO 27018, SOC 1/2/3, and the EU Cloud Code of Conduct.</li>
      </ul>
      <p>
        For New Zealand transfers, we comply with Information Privacy Principle 12 of the Privacy
        Act 2020. A copy of our SCCs / IDTA is available on request.
      </p>

      <h2>6. How long we keep your data</h2>
      <ul>
        <li>Active accounts: for as long as you use the Service.</li>
        <li><strong>Closed accounts &mdash; 30-day grace period:</strong> when you click &ldquo;Delete my account&rdquo; in Settings, your account is marked for deletion immediately and your storefront / personal data becomes unavailable to others, but the underlying records are kept for 30 days so you can sign back in to undo if you change your mind. After 30 days, an automatic process anonymises personal data: name, email, and phone are removed from active tables.</li>
        <li><strong>Transaction shells (anonymised):</strong> bookings, enquiries, orders, and payment records are kept after deletion with personal details removed (your name shows as &ldquo;Deleted user&rdquo;). This lets the business retain accurate revenue / activity history. They cannot be linked back to you without a court order.</li>
        <li><strong>Account audit log (kept indefinitely):</strong> for legal-claims defence (GDPR Article 17(3)(e)) and law-enforcement subpoena response, we keep an immutable record of: business name, owner email (plaintext + SHA-256 hash), country, signup IP, deletion timestamp, deletion-request IP, and the deletion reason if you provided one. This record is only accessible to internal compliance staff and never used for marketing.</li>
        <li>Payment records: retained for the period required by tax law in our and your jurisdiction (typically 7 years in NZ, 6 years in the EU/UK).</li>
        <li>Anonymised and aggregated analytics: may be retained indefinitely.</li>
        <li>Backups: encrypted database backups are taken daily and retained for 7 days locally. Deletion requests are honoured on the live system within 30 days; they propagate through backup rotation within 7 days of the request.</li>
        <li>Operational and security logs: retained at least 14 days, longer if we are investigating an incident.</li>
      </ul>

      <h2>7. Your rights</h2>
      <p>Depending on where you live, you have some or all of these rights. We will honour valid requests within 30 days at no charge.</p>
      <ul>
        <li><strong>Access</strong> &mdash; obtain a copy of the personal data we hold about you.</li>
        <li><strong>Rectification</strong> &mdash; correct data that is inaccurate or incomplete.</li>
        <li><strong>Erasure (&ldquo;right to be forgotten&rdquo;)</strong> &mdash; subject to lawful retention.</li>
        <li><strong>Portability</strong> &mdash; receive your data in a structured, commonly used, machine-readable format.</li>
        <li><strong>Objection</strong> &mdash; object to processing based on legitimate interests, including profiling.</li>
        <li><strong>Restriction</strong> &mdash; restrict processing in certain circumstances.</li>
        <li><strong>Withdraw consent</strong> &mdash; where we rely on consent, you can withdraw it at any time.</li>
        <li><strong>Automated decision-making</strong> &mdash; we do not currently use solely automated decision-making that produces legal or similarly significant effects on you.</li>
        <li><strong>Lodge a complaint</strong> &mdash; with your supervisory or data-protection authority.</li>
      </ul>

      <p><strong>California (CCPA/CPRA) specific rights</strong>:</p>
      <ul>
        <li>Right to know the categories and specific pieces of personal information we collect, use, and disclose.</li>
        <li>Right to delete personal information.</li>
        <li>Right to correct inaccurate personal information.</li>
        <li>Right to opt-out of sale or sharing &mdash; not applicable, we do neither.</li>
        <li>Right to limit use of sensitive personal information &mdash; we collect only what is necessary to operate the Service.</li>
        <li>Right to non-discrimination for exercising any of the above.</li>
        <li>Authorised agents may submit requests on your behalf with verifiable proof of authority.</li>
      </ul>

      <p><strong>How to exercise rights:</strong> email
        {' '}<a href="mailto:support@sitepresso.com">support@sitepresso.com</a> with a clear
        description of your request and enough information to verify your identity (for example,
        the email on your account). We will respond within 30 days; for complex requests we may
        extend this once by a further 60 days, with notice.
      </p>

      <p>
        New Zealand residents may complain to the Office of the Privacy Commissioner at
        {' '}<a href="https://www.privacy.org.nz" target="_blank" rel="noopener noreferrer">privacy.org.nz</a>.<br />
        EU residents may complain to their national data-protection authority &mdash; a list is at
        {' '}<a href="https://edpb.europa.eu/about-edpb/about-edpb/members_en" target="_blank" rel="noopener noreferrer">edpb.europa.eu</a>.<br />
        UK residents may complain to the Information Commissioner&rsquo;s Office at
        {' '}<a href="https://ico.org.uk" target="_blank" rel="noopener noreferrer">ico.org.uk</a>.<br />
        California residents may complain to the California Privacy Protection Agency.
      </p>

      <h2>8. Security</h2>
      <p>
        We take reasonable steps to protect personal information from loss, misuse, and
        unauthorised access, modification, or disclosure. The controls in place today are:
      </p>
      <ul>
        <li><strong>Encryption in transit</strong> &mdash; TLS 1.2+ enforced for every connection between visitors, our application, and our backend services.</li>
        <li><strong>Encryption of credentials and tokens</strong> &mdash; passwords are hashed with bcrypt; OAuth refresh tokens are encrypted with AES-256-GCM before storage. We do not store payment-card data.</li>
        <li><strong>Network-layer protection</strong> &mdash; AWS Shield Standard (automatic DDoS protection) and AWS Global Accelerator absorb attacks at the AWS edge before traffic reaches our servers.</li>
        <li><strong>Application-layer protection</strong> &mdash; nginx rate limits (request-per-second and concurrent-connection caps per IP), fail2ban (bans IPs that probe SSH, HTTP auth, or rate-limit boundaries), and CrowdSec (community threat intel with iptables firewall bouncer).</li>
        <li><strong>Bot protection on public forms</strong> &mdash; Cloudflare Turnstile (when configured for a tenant).</li>
        <li><strong>Daily database backups</strong> with local 7-day rotation, encrypted with AES-256 (GPG symmetric).</li>
        <li><strong>Operational logs</strong> &mdash; nginx access and error logs, application error logs (via Sentry), and a structured audit log of pricing and subscription changes.</li>
        <li><strong>Pinned dependencies</strong> with manual review on update; we run <code>npm audit</code> on a recurring schedule and apply patches promptly.</li>
        <li><strong>SSH access</strong> to production locked to an allowlisted home/office IP and protected by SSH keys (no password auth).</li>
      </ul>
      <p>
        We are continuing to mature these controls. Items on our pre-launch hardening list
        (planned before we accept paid customers at scale): EBS volume-level encryption at rest
        for the database disk, off-site encrypted backup mirroring (S3, separate region),
        formal logrotate retention policy, and an incident-response runbook.
      </p>
      <p>
        No system is perfect. In the event of a personal-data breach that is likely to result in
        a risk to your rights, we will notify you and the relevant supervisory authority without
        undue delay and in any case within 72 hours where required by law (GDPR Art. 33-34, NZ
        Privacy Act Notifiable Privacy Breach scheme, equivalents elsewhere).
      </p>

      <h2>9. Cookies and similar technologies</h2>
      <p>
        We use a small set of strictly-necessary cookies for authentication, session management,
        cart persistence (e-commerce), and language preference. These do not require consent
        under GDPR ePrivacy because they are essential to deliver the Service you requested.
      </p>
      <p>
        For non-essential analytics cookies (currently PostHog product analytics), we surface
        a consent banner on first visit and only set those cookies after you click
        &ldquo;Accept all&rdquo;. You can change your mind at any time via the
        &ldquo;Cookie preferences&rdquo; link in the footer; rejecting analytics stops new
        events being captured immediately.
      </p>
      <p>
        Full details &mdash; including the exact cookies, what they do, and how long they live
        &mdash; are at <a href="/legal/cookies">Cookie Notice</a>.
      </p>
      <p>
        You can also disable cookies in your browser; parts of the Service will not function
        without the strictly-necessary set.
      </p>

      <h2>10. Children</h2>
      <p>
        The Service is not directed to children under 16. We do not knowingly collect personal
        data from children. If you believe we have collected data from a child, please contact us
        at <a href="mailto:support@sitepresso.com">support@sitepresso.com</a> and we will delete
        it. Where a Business uses our platform to take bookings or sell to minors, the Business
        is responsible for parental-consent obligations under COPPA, GDPR Art. 8, and equivalents.
      </p>

      <h2>11. Marketing</h2>
      <p>
        We may send you product update emails and occasional marketing communications to your
        registered account email. You can opt out at any time using the &ldquo;unsubscribe&rdquo;
        link in any marketing email, or by emailing us. Essential service emails (security
        alerts, payment receipts, booking and order confirmations) cannot be unsubscribed from
        while your account is active.
      </p>

      <h2>12. Changes to this policy</h2>
      <p>
        We may update this Privacy Policy. We&rsquo;ll notify you of material changes by email or
        in-product notice at least 30 days before they take effect, and we&rsquo;ll update the
        version number and effective date at the top of this page.
      </p>

      <h2>13. Contact</h2>
      <p>
        <a href="mailto:support@sitepresso.com">support@sitepresso.com</a><br />
        Loominfo Limited, 17A Prictor Street, Papakura, Auckland, New Zealand<br />
        Company number: 9429052682902
      </p>

      <p className="text-xs text-gray-500 mt-12 pt-6 border-t border-gray-200">
        Version 2.0.0-2026-04-28.
      </p>
    </>
  );
}
