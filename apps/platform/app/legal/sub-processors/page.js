export const metadata = {
  title: 'Sub-Processors · DriftHR',
  description: 'Third-party service providers DriftHR uses to deliver the Service.',
};

export default function SubProcessorsPage() {
  return (
    <>
      <p className="text-xs font-mono uppercase tracking-[0.15em] text-indigo-600">Legal</p>
      <h1>Sub-Processors</h1>
      <p className="text-sm text-gray-500 mt-0 mb-8">Last updated: 28 April 2026</p>

      <p>
        DriftHR uses the following third-party service providers (&ldquo;sub-processors&rdquo;)
        to deliver the Service. Each is bound by contract to protect personal data handled on our
        behalf and to process it only on our documented instructions, consistent with our
        {' '}<a href="/legal/privacy">Privacy Policy</a> and any Data Processing Addendum we have
        with you.
      </p>

      <h2>Infrastructure</h2>
      <div className="not-prose my-8 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-900">
              <th className="py-2 pr-4 font-semibold">Sub-processor</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 pr-4 font-semibold">Data location</th>
              <th className="py-2 font-semibold">Data handled</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Amazon Web Services, Inc.</td>
              <td className="py-3 pr-4 align-top">Hosting (EC2), object storage (S3), transactional email (SES), DDoS protection (Shield)</td>
              <td className="py-3 pr-4 align-top">Asia Pacific (Mumbai), <code>ap-south-1</code></td>
              <td className="py-3 align-top">All Service data including personal information</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Cloudflare, Inc.</td>
              <td className="py-3 pr-4 align-top">DNS, edge security (proxy + WAF + DDoS), Origin Certificate for the EC2 origin, Turnstile bot-protection on public forms</td>
              <td className="py-3 pr-4 align-top">Global edge network</td>
              <td className="py-3 align-top">DNS lookups, IP address, user-agent, device characteristics at submission time</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Subscription billing (what you pay us)</h2>
      <div className="not-prose my-8 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-900">
              <th className="py-2 pr-4 font-semibold">Sub-processor</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 pr-4 font-semibold">Data location</th>
              <th className="py-2 font-semibold">Data handled</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Paddle.com Market Limited</td>
              <td className="py-3 pr-4 align-top">Merchant of Record for DriftHR subscription payments outside India and New Zealand &mdash; checkout, taxes, card processing, invoices, dunning</td>
              <td className="py-3 pr-4 align-top">UK / EU / US</td>
              <td className="py-3 align-top">Billing name and address, email, payment method (handled by Paddle; we receive only token + last-4), country of residence for tax</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Razorpay Software Pvt Ltd</td>
              <td className="py-3 pr-4 align-top">Subscription billing for India-based accounts &mdash; hosted authorization, mandates, recurring payments, invoices</td>
              <td className="py-3 pr-4 align-top">India</td>
              <td className="py-3 align-top">Billing name, email, phone, payment method, country of residence for tax, subscription amount</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Stripe Payments Europe Ltd / Stripe, Inc.</td>
              <td className="py-3 pr-4 align-top">Subscription billing for New Zealand-based accounts &mdash; hosted checkout, recurring payments, invoices</td>
              <td className="py-3 pr-4 align-top">EU / US</td>
              <td className="py-3 align-top">Billing name and address, email, payment method, country of residence for tax, subscription amount</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>End-customer payments (what your buyers pay you, e-commerce only)</h2>
      <p>
        These providers handle money flowing directly from your end customers to you. Loominfo
        never holds end-customer funds. You connect a provider in your shop settings and the
        provider settles funds to your bank.
      </p>
      <div className="not-prose my-8 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-900">
              <th className="py-2 pr-4 font-semibold">Sub-processor</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 pr-4 font-semibold">Data location</th>
              <th className="py-2 font-semibold">Data handled</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Razorpay Software Pvt Ltd</td>
              <td className="py-3 pr-4 align-top">Razorpay Route &mdash; payment splits and seller settlements for India-based shops</td>
              <td className="py-3 pr-4 align-top">India</td>
              <td className="py-3 align-top">Buyer name, email, phone, payment method, transaction amount, shipping address (passed to seller)</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Stripe Payments Europe Ltd / Stripe, Inc.</td>
              <td className="py-3 pr-4 align-top">Stripe Connect &mdash; payment splits and seller settlements for global shops outside India</td>
              <td className="py-3 pr-4 align-top">EU / US</td>
              <td className="py-3 align-top">Buyer name, email, phone, payment method, transaction amount, shipping address (passed to seller)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Communications</h2>
      <div className="not-prose my-8 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-900">
              <th className="py-2 pr-4 font-semibold">Sub-processor</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 pr-4 font-semibold">Data location</th>
              <th className="py-2 font-semibold">Data handled</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Amazon SES (AWS, Inc.)</td>
              <td className="py-3 pr-4 align-top">Transactional email delivery (signup OTP, booking confirmations, order receipts, password reset, etc.)</td>
              <td className="py-3 pr-4 align-top">Asia Pacific (Mumbai)</td>
              <td className="py-3 align-top">Recipient email, subject, body content (which may include name, booking, or order details)</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">MSG91 Communications Pvt Ltd</td>
              <td className="py-3 pr-4 align-top">SMS delivery for India-based recipients (DLT-compliant)</td>
              <td className="py-3 pr-4 align-top">India</td>
              <td className="py-3 align-top">Recipient phone, message content (OTPs, booking reminders, order updates)</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Twilio Inc.</td>
              <td className="py-3 pr-4 align-top">SMS delivery for non-India recipients (global)</td>
              <td className="py-3 pr-4 align-top">Global (US-headquartered)</td>
              <td className="py-3 align-top">Recipient phone, message content</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Optional integrations</h2>
      <p>
        These run only when the relevant feature is enabled by the Business or chosen by the
        end Customer.
      </p>
      <div className="not-prose my-8 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-900">
              <th className="py-2 pr-4 font-semibold">Sub-processor</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 pr-4 font-semibold">Data location</th>
              <th className="py-2 font-semibold">Data handled</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Google LLC &mdash; Google Sign-In</td>
              <td className="py-3 pr-4 align-top">Optional social login for end customers</td>
              <td className="py-3 pr-4 align-top">Global</td>
              <td className="py-3 align-top">Email, name, Google user ID &mdash; only when the user chooses Google sign-in</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Google LLC &mdash; Calendar / Meet</td>
              <td className="py-3 pr-4 align-top">Optional video-meeting integration for appointment bookings</td>
              <td className="py-3 pr-4 align-top">Global</td>
              <td className="py-3 align-top">Calendar events, meeting URLs &mdash; only when the Business connects Google Workspace</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Zoom Video Communications, Inc.</td>
              <td className="py-3 pr-4 align-top">Optional video-meeting integration for appointment bookings</td>
              <td className="py-3 pr-4 align-top">US</td>
              <td className="py-3 align-top">Meeting metadata &mdash; only when the Business connects Zoom</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Microsoft Corporation &mdash; Teams</td>
              <td className="py-3 pr-4 align-top">Optional video-meeting integration for appointment bookings</td>
              <td className="py-3 pr-4 align-top">Global</td>
              <td className="py-3 align-top">Meeting metadata &mdash; only when the Business connects Microsoft 365</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Operational tooling</h2>
      <div className="not-prose my-8 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-900">
              <th className="py-2 pr-4 font-semibold">Sub-processor</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 pr-4 font-semibold">Data location</th>
              <th className="py-2 font-semibold">Data handled</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">Functional Software, Inc. (Sentry)</td>
              <td className="py-3 pr-4 align-top">Server-side error tracking</td>
              <td className="py-3 pr-4 align-top">EU (Frankfurt)</td>
              <td className="py-3 align-top">Stack traces, request URLs, IP, user-agent. We scrub email and request bodies before send.</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-medium">PostHog Inc.</td>
              <td className="py-3 pr-4 align-top">Product analytics (only with consent), session replay (only with consent)</td>
              <td className="py-3 pr-4 align-top">US</td>
              <td className="py-3 align-top">Page views, click events, anonymous user ID. PII is masked in session replay.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Changes to this list</h2>
      <p>
        We will update this page within 30 days of adding, removing, or changing a sub-processor.
        Business customers who wish to be notified by email when this list changes can subscribe
        at <a href="mailto:support@sitepresso.com?subject=Subscribe to sub-processor updates">support@sitepresso.com</a>.
      </p>

      <h2>Objections</h2>
      <p>
        If you have a reasonable objection to a specific sub-processor we use, contact us at
        <a href="mailto:support@sitepresso.com"> support@sitepresso.com</a> within 30 days of this
        page being updated, and we will work with you in good faith to find a resolution.
      </p>

      <p className="text-xs text-gray-500 mt-12 pt-6 border-t border-gray-200">
        This page is referenced from our <a href="/legal/terms">Terms of Service</a> and
        {' '}<a href="/legal/privacy">Privacy Policy</a>.
      </p>
    </>
  );
}
