'use client';

import { reopenCookieConsent } from '@/components/CookieConsent';

export const COOKIES_VERSION = '1.0.0-2026-04-28';

export default function CookieNoticePage() {
  return (
    <>
      <p className="text-xs font-mono uppercase tracking-[0.15em] text-indigo-600">Legal</p>
      <h1>Cookie Notice</h1>
      <p className="text-sm text-gray-500 mt-0 mb-8">
        Effective date: 28 April 2026 · Version 1.0
      </p>

      <p>
        This notice explains the cookies and similar technologies used on
        sitepresso.com and on storefronts hosted by DriftHR (the
        &ldquo;<strong>Service</strong>&rdquo;), and how you can manage your choices.
        It complements our <a href="/legal/privacy">Privacy Policy</a>.
      </p>

      <h2>What is a cookie?</h2>
      <p>
        A cookie is a small text file stored in your browser when you visit a website.
        It lets the site recognise you on subsequent visits, keep you signed in, and
        remember basic preferences. Some cookies are set by DriftHR directly
        (&ldquo;first-party&rdquo;); others are set by service providers we use
        (&ldquo;third-party&rdquo;).
      </p>

      <h2>Cookies we use</h2>

      <h3>Strictly necessary (always on)</h3>
      <p>
        These cookies are essential for the Service to function. We don&rsquo;t
        ask for consent because the Service can&rsquo;t work without them.
      </p>
      <div className="not-prose my-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-900">
              <th className="py-2 pr-4 font-semibold">Cookie</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 font-semibold">Duration</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-mono text-xs">token</td>
              <td className="py-3 pr-4 align-top">Authentication for signed-in business admins / staff / customers</td>
              <td className="py-3 align-top">Session, up to 30 days</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-mono text-xs">NEXT_LOCALE</td>
              <td className="py-3 pr-4 align-top">Remember the language you picked</td>
              <td className="py-3 align-top">1 year</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-mono text-xs">NEXT_LOCALE_EXPLICIT</td>
              <td className="py-3 pr-4 align-top">Marks that you picked the language manually (so we don&rsquo;t override it)</td>
              <td className="py-3 align-top">1 year</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-mono text-xs">sitepresso:cart-session</td>
              <td className="py-3 pr-4 align-top">localStorage. Identifies your shopping cart on e-commerce storefronts before sign-in.</td>
              <td className="py-3 align-top">Until cleared</td>
            </tr>
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-mono text-xs">sitepresso:cookie-consent</td>
              <td className="py-3 pr-4 align-top">localStorage. Remembers your choice on this banner so we don&rsquo;t re-prompt on every page.</td>
              <td className="py-3 align-top">Until cleared</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Analytics (only with your consent)</h3>
      <p>
        These help us understand how DriftHR is used so we can improve it.
        They&rsquo;re only set if you click &ldquo;Accept all&rdquo; on the cookie banner.
      </p>
      <div className="not-prose my-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="text-left border-b-2 border-gray-900">
              <th className="py-2 pr-4 font-semibold">Service</th>
              <th className="py-2 pr-4 font-semibold">Purpose</th>
              <th className="py-2 font-semibold">Provider</th>
            </tr>
          </thead>
          <tbody className="text-gray-700">
            <tr className="border-b border-gray-200">
              <td className="py-3 pr-4 align-top font-mono text-xs">ph_*</td>
              <td className="py-3 pr-4 align-top">Aggregate page-view + click event analytics. We also enable optional session replay with PII masked.</td>
              <td className="py-3 align-top">PostHog (US)</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>What we don&rsquo;t use</h3>
      <ul>
        <li>No advertising or marketing cookies.</li>
        <li>No cross-site behavioural-tracking cookies.</li>
        <li>No third-party social-media cookies (Facebook Pixel, Twitter Pixel, etc.).</li>
      </ul>

      <h2>Manage your choices</h2>
      <p>
        You can change your cookie preferences at any time. We&rsquo;ll respect
        the new choice immediately — analytics cookies stop firing the moment
        you reject.
      </p>
      <p>
        <button
          type="button"
          onClick={() => reopenCookieConsent()}
          className="not-prose inline-flex items-center px-4 py-2 rounded-lg bg-gray-900 hover:bg-black text-white text-sm font-semibold"
        >
          Open cookie preferences
        </button>
      </p>
      <p>
        You can also disable cookies in your browser settings entirely; in that
        case the Service may not work correctly because the strictly-necessary
        cookies above will be blocked.
      </p>

      <h2>International transfers</h2>
      <p>
        PostHog stores its data in the United States. By accepting analytics
        cookies you consent to that transfer. The provider participates in the
        EU-US Data Privacy Framework and otherwise relies on Standard
        Contractual Clauses for the transfer.
      </p>

      <h2>Changes</h2>
      <p>
        We&rsquo;ll update this notice if our cookie use changes (for example,
        if we add a new analytics tool). We&rsquo;ll re-prompt for consent when
        we add a new optional cookie type.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about cookies: <a href="mailto:support@sitepresso.com">support@sitepresso.com</a><br />
        Loominfo Limited, 17A Prictor Street, Papakura, Auckland, New Zealand
      </p>

      <p className="text-xs text-gray-500 mt-12 pt-6 border-t border-gray-200">
        Version 1.0.0-2026-04-28.
      </p>
    </>
  );
}
