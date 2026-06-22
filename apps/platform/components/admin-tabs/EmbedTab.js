'use client';

// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// page split.

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea, Empty, formatAdminDate, formatAdminDateTime, formatMoneyMinor } from '@/components/admin-ui';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { getPlatformDomain } from '@/lib/platformDomain';

function EmbedTab({ business }) {
  const platformDomain = getPlatformDomain();
  const host = business?.slug ? `${business.slug}.${platformDomain}` : `YOUR-SLUG.${platformDomain}`;
  const origin = `https://${host}`;

  const basicSnippet = `<!-- DriftHR booking button — paste into any page -->
<div data-sitepresso-book></div>
<script src="${origin}/embed.js" async></script>`;

  const customSnippet = `<!-- DriftHR — customised button -->
<div
  data-sitepresso-book
  data-sitepresso-label="Book appointment"
  data-sitepresso-color="#4f46e5"
  data-sitepresso-size="large">
</div>
<script src="${origin}/embed.js" async></script>`;

  const ownButtonSnippet = `<!-- DriftHR — use your own button -->
<button data-sitepresso-book class="your-button-class">
  Schedule a visit
</button>
<script src="${origin}/embed.js" async></script>`;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Embed on your own website</h2>
        <p className="text-sm text-gray-600 mb-4">
          Keep the website you already have — WordPress, Wix, Webflow, Squarespace, a custom site, anything. Paste this snippet wherever you want customers to see a &ldquo;Book now&rdquo; button. Clicking it opens your full booking flow in a popup without taking visitors off your page.
        </p>

        <SnippetBlock label="Basic button (recommended)" code={basicSnippet} />

        <div className="mt-6">
          <SnippetBlock label="Customise the button" code={customSnippet} />
          <p className="text-xs text-gray-500 mt-2">
            Change the button text, colour, and size via <code className="px-1 py-0.5 bg-gray-100 rounded">data-sitepresso-*</code> attributes. Size accepts <code className="px-1 py-0.5 bg-gray-100 rounded">small</code>, <code className="px-1 py-0.5 bg-gray-100 rounded">medium</code>, or <code className="px-1 py-0.5 bg-gray-100 rounded">large</code>.
          </p>
        </div>

        <div className="mt-6">
          <SnippetBlock label="Use your own button" code={ownButtonSnippet} />
          <p className="text-xs text-gray-500 mt-2">
            Put <code className="px-1 py-0.5 bg-gray-100 rounded">data-sitepresso-book</code> on an existing <code>&lt;button&gt;</code> or <code>&lt;a&gt;</code> element and the script attaches a click handler — your styles stay intact.
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-2">Quick start guide</h3>
        <ol className="text-sm text-gray-700 space-y-2 list-decimal pl-5">
          <li>Copy the <strong>Basic button</strong> snippet above.</li>
          <li>Open your website&rsquo;s editor. Find the page or block where you want the button to appear.</li>
          <li>Paste the snippet into an &ldquo;HTML&rdquo; / &ldquo;Custom code&rdquo; / &ldquo;Embed&rdquo; block. (Most site builders have one — in WordPress use a &ldquo;Custom HTML&rdquo; block; in Webflow use an &ldquo;Embed&rdquo; element; in Squarespace use a &ldquo;Code Block&rdquo;.)</li>
          <li>Save/publish. A <em>Book now</em> button appears where you pasted it.</li>
          <li>Visitors who click it get a popup with your full booking flow — services, staff, times, confirmation — all themed the way you set up in this admin.</li>
        </ol>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-sm text-amber-900">
        <p className="font-semibold">Before you paste this anywhere</p>
        <p className="mt-1">Make sure your business is <strong>Live</strong> (not in draft). If it&rsquo;s not live, the popup will show a &ldquo;coming soon&rdquo; message instead of the booking form.</p>
      </div>
    </div>
  );
}

function SnippetBlock({ label, code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      alert('Could not copy — select the text and copy manually.');
    }
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="text-xs font-medium px-2.5 py-1 rounded-md border border-indigo-600 text-indigo-600 hover:bg-indigo-50"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="bg-gray-900 text-gray-100 p-3.5 rounded-lg overflow-x-auto text-xs leading-relaxed font-mono select-all">
        {code}
      </pre>
    </div>
  );
}

// ============================================================================
// Scheduling tab — unified home for availability. Four pill sub-tabs:
//   • Team          — every service provider's weekly schedule (lunch too)
//   • Open hours    — business opening hours + holidays
//   • Time off      — staff leave approval queue
//   • Booking rules — bookingType + any booking-wide policy knobs
// Replaces the old Hours / My hours / Leave trio with a single entry point.
// ============================================================================
const TEAM_SUB_TABS = [
  { key: 'members',  label: 'Members',       sub: 'Invite staff, update names, roles, and permissions' },
  { key: 'schedule', label: 'Schedule',      sub: 'Weekly schedule per provider incl. lunch breaks' },
  { key: 'timeoff',  label: 'Time off',      sub: 'Approve staff leave' },
  { key: 'rules',    label: 'Booking rules', sub: 'How customers can book with you' },
];


export default EmbedTab;
