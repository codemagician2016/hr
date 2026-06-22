'use client';

// Standalone "How to add a product" help page. Linked from the empty
// state in ProductsPanel. Five short steps + an FAQ. No video yet —
// pure copy + screenshots can land later. Standalone /admin path so
// it works for any tenant without going through the admin shell.

import Link from 'next/link';

export default function ProductsHelpPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4">
          <Link href="javascript:history.back()" className="text-sm text-gray-500 hover:text-gray-900">
            ← Back to admin
          </Link>
          <h1 className="mt-1 text-2xl sm:text-3xl font-bold text-gray-900">
            How to add a product
          </h1>
          <p className="mt-2 text-sm text-gray-600">
            A 5-minute walkthrough. By the end you'll have your first product live and visible on your storefront.
          </p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Step 1 */}
        <Step n={1} title="Open the Products tab">
          <p>
            From your admin sidebar, click <strong>Products</strong>. If your shop is empty, you'll see three options: <em>Add my first product</em>, <em>Load 500 sample products</em>, or <em>Import from CSV</em> (coming soon).
          </p>
          <Tip>Loading samples is a quick way to see how a real shop looks before you commit to typing your own. You can edit, delete, or replace anything later.</Tip>
        </Step>

        {/* Step 2 */}
        <Step n={2} title="Pick a category (or skip — you can fix it later)">
          <p>
            Categories are how customers filter your shop ("show me only Beverages"). New shops come with 8 starter categories already created. You can:
          </p>
          <ul className="list-disc pl-6 space-y-1 text-sm text-gray-700">
            <li>Use one of the starters (Produce, Dairy, Bakery, etc.)</li>
            <li>Open the <strong>Categories</strong> tab to add your own (e.g., "Bestsellers")</li>
            <li>Leave it blank — products without a category still show on the storefront, just not in any filter</li>
          </ul>
        </Step>

        {/* Step 3 */}
        <Step n={3} title="Fill in just three things">
          <p>For your first product, only three fields really matter:</p>
          <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-2 text-sm">
            <div><span className="font-mono text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Name *</span> What customers see on the card. e.g. "Whole Wheat Bread — 500g".</div>
            <div><span className="font-mono text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Price *</span> In your shop's default currency. The price field shows the active currency next to it.</div>
            <div><span className="font-mono text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">Image URL</span> One link to a product photo. You can paste any image URL (e.g., from Google Drive shared link, Imgur, your phone).</div>
          </div>
          <Tip>Everything else (description, stock count, weight, SKU, compare-price) is optional. You can always come back later.</Tip>
        </Step>

        {/* Step 4 */}
        <Step n={4} title="Set your shop's default currency">
          <p>
            DriftHR shops have <strong>one home currency</strong>. Every visitor — wherever they're browsing from — sees prices in that currency. Their card auto-converts at checkout.
          </p>
          <p className="text-sm text-gray-600 mt-2">
            Open <strong>Settings → Business</strong> and pick your currency once. Going forward, every new product form will auto-fill with that currency. Existing products keep their own currency until you edit them.
          </p>
        </Step>

        {/* Step 5 */}
        <Step n={5} title="Save and view it live">
          <p>
            Click <strong>Save</strong>. The product is added but starts as a draft. Toggle <strong>Published</strong> when you're happy with it; it shows on your storefront immediately.
          </p>
          <p className="text-sm text-gray-600 mt-2">
            Visit <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">your-slug.sitepresso.com/shop</code> in another tab to see it live. No publish button to click separately — published = visible.
          </p>
        </Step>

        {/* FAQ */}
        <section className="bg-white rounded-2xl border border-gray-200 p-5 sm:p-7">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Common questions</h2>
          <div className="space-y-4 text-sm">
            <Faq q="Can I bulk-import a spreadsheet of products?">
              Coming soon — CSV import is on the roadmap for the next release. Until then, the "Load samples" button is the fastest way to populate a lot of products at once.
            </Faq>
            <Faq q="What image formats / sizes work best?">
              Square photos around 600×600px in JPG or PNG render best. Anything under 1MB loads fast. Hosting your own (Imgur, Cloudinary, your S3) is fine — DriftHR fetches the URL on each page load.
            </Faq>
            <Faq q="Can different products have different currencies?">
              Yes — each product stores its own currency. But customers can only check out one currency at a time (the cart locks to the first item added). Most shops keep one currency across the whole catalog for simplicity.
            </Faq>
            <Faq q="What happens when stock hits zero?">
              The product card shows an "Out of stock" overlay and the Add-to-cart button disables. Customers can still see the product (so it ranks in search engines); they just can't buy.
            </Faq>
            <Faq q="How do customers pay me?">
              You connect Razorpay (India) or Stripe Connect (global) once, and orders flow through your gateway directly. DriftHR never holds your money — the platform fee is the monthly subscription, period.
            </Faq>
          </div>
        </section>

        <div className="text-center pt-4">
          <Link
            href="javascript:history.back()"
            className="inline-flex items-center px-5 py-2.5 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-black"
          >
            Back to my products →
          </Link>
        </div>
      </main>
    </div>
  );
}

function Step({ n, title, children }) {
  return (
    <section className="bg-white rounded-2xl border border-gray-200 p-5 sm:p-7">
      <div className="flex items-start gap-4">
        <span className="flex-shrink-0 w-9 h-9 rounded-full bg-indigo-600 text-white font-bold flex items-center justify-center text-sm">
          {n}
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <div className="mt-3 space-y-3 text-sm text-gray-700 leading-relaxed">
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

function Tip({ children }) {
  return (
    <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900 leading-snug">
      <span className="font-semibold">💡 Tip — </span>
      {children}
    </div>
  );
}

function Faq({ q, children }) {
  return (
    <details className="group">
      <summary className="cursor-pointer font-medium text-gray-900 hover:text-gray-700 list-none flex items-center justify-between">
        {q}
        <span className="text-gray-400 group-open:rotate-180 transition-transform">▾</span>
      </summary>
      <p className="mt-2 text-gray-600 leading-relaxed">{children}</p>
    </details>
  );
}
