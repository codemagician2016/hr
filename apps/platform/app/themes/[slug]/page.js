import Link from 'next/link';
import { notFound } from 'next/navigation';
import { publishedThemePages, getThemePage } from '@/lib/seoThemePages';
import { buildMetadata, absoluteUrl, SITE_NAME } from '@/lib/seo';

export async function generateStaticParams() {
  return publishedThemePages().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }) {
  const page = getThemePage(params.slug);
  if (!page) return {};
  return buildMetadata({
    title: page.metaTitle,
    description: page.metaDescription,
    path: `/themes/${page.slug}`,
    type: 'website',
  });
}

// SoftwareApplication + Product + FAQPage for one theme page.
function themeJsonLd(page) {
  const path = `/themes/${page.slug}`;
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: `${page.h1} — ${SITE_NAME}`,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      url: absoluteUrl(path),
      description: page.directAnswer,
      offers: { '@type': 'Offer', category: 'SaaS subscription' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: page.h1,
      description: page.metaDescription,
      brand: { '@type': 'Brand', name: SITE_NAME },
      url: absoluteUrl(path),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: page.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ];
}

// Pick readable text colour for a coloured button (rough luminance).
function readableOn(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#0F1923' : '#FFFFFF';
}

export default function ThemePage({ params }) {
  const page = getThemePage(params.slug);
  if (!page) notFound();
  const { preview: pv } = page;

  return (
    <div className="min-h-screen bg-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(themeJsonLd(page)) }}
      />
      <Nav />

      <main>
        {/* HERO */}
        <section className="max-w-6xl mx-auto px-6 lg:px-8 pt-14 pb-10">
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-5">
            <Link href="/#themes" className="hover:text-gray-700">Templates</Link>
            <span>/</span>
            <span className="text-gray-600">{page.categoryLabel}</span>
          </div>
          <div className="grid lg:grid-cols-2 gap-10 items-center">
            <div>
              <h1 className="text-3xl lg:text-5xl font-bold text-gray-900 leading-tight">{page.h1}</h1>
              <p className="mt-5 text-lg text-gray-600 leading-relaxed">{page.directAnswer}</p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link
                  href={page.signupHref}
                  className="inline-flex items-center gap-1.5 px-6 py-3 bg-gray-900 hover:bg-gray-800 text-white font-semibold rounded-xl transition-all"
                >
                  Start your 30-day free trial →
                </Link>
                <Link href="/#pricing" className="inline-flex items-center px-5 py-3 border border-gray-300 hover:border-gray-900 text-gray-800 font-semibold rounded-xl transition-colors">
                  See pricing
                </Link>
              </div>
              <p className="mt-4 text-sm text-gray-400">Live in minutes · no code · use your own domain</p>
            </div>

            {/* LIVE PREVIEW — rendered with the theme's real palette */}
            <ThemePreview pv={pv} />
          </div>
        </section>

        {/* WHAT YOU GET */}
        <section className="max-w-6xl mx-auto px-6 lg:px-8 py-12 border-t border-gray-100">
          <h2 className="text-2xl font-bold text-gray-900 mb-8">What you get</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-7">
            {page.features.map((f) => (
              <div key={f.title}>
                <h3 className="text-base font-semibold text-gray-900 mb-1.5">{f.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* BEST FOR + CUSTOMISE */}
        <section className="max-w-6xl mx-auto px-6 lg:px-8 py-12 border-t border-gray-100 grid md:grid-cols-2 gap-10">
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-3">Who it's for</h2>
            <p className="text-gray-600 leading-relaxed">{page.bestFor}</p>
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900 mb-3">Make it yours</h2>
            <p className="text-gray-600 leading-relaxed">{page.customise}</p>
          </div>
        </section>

        {/* FAQ */}
        <section className="max-w-3xl mx-auto px-6 lg:px-8 py-12 border-t border-gray-100">
          <h2 className="text-2xl font-bold text-gray-900 mb-7">Questions, answered</h2>
          <div className="divide-y divide-gray-100">
            {page.faq.map((f) => (
              <div key={f.q} className="py-4">
                <p className="font-semibold text-gray-900 mb-1">{f.q}</p>
                <p className="text-gray-600 text-sm leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA BAND */}
        <section className="max-w-6xl mx-auto px-6 lg:px-8 pb-4">
          <div className="p-8 lg:p-10 bg-violet-50 border border-violet-100 rounded-2xl text-center">
            <h2 className="text-2xl font-bold text-gray-900 mb-3">Start with the {page.h1.replace(' Website Template', '')} template</h2>
            <p className="text-gray-600 mb-6">Pick it, customise it, connect your domain, and go live the same day.</p>
            <Link
              href={page.signupHref}
              className="inline-flex items-center gap-1.5 px-6 py-3 bg-gray-900 hover:bg-gray-800 text-white font-semibold rounded-xl transition-all"
            >
              Start your 30-day free trial →
            </Link>
          </div>
        </section>

        {/* RELATED */}
        <section className="max-w-6xl mx-auto px-6 lg:px-8 py-12">
          <h3 className="text-lg font-bold text-gray-900 mb-5">Related templates</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            {page.related.map((r) => (
              <Link
                key={r.href}
                href={r.href}
                className="group block p-4 border border-gray-200 rounded-xl hover:border-gray-300 hover:shadow-sm transition-all"
              >
                <p className="text-sm font-semibold text-gray-900 group-hover:text-violet-600 transition-colors">{r.label} →</p>
              </Link>
            ))}
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

function ThemePreview({ pv }) {
  const ctaText = readableOn(pv.primary);
  return (
    <div className="rounded-2xl overflow-hidden shadow-xl ring-1 ring-black/5">
      {/* faux browser chrome */}
      <div className="flex items-center gap-1.5 px-4 py-3 bg-gray-100 border-b border-gray-200">
        <span className="h-3 w-3 rounded-full bg-red-400" />
        <span className="h-3 w-3 rounded-full bg-amber-400" />
        <span className="h-3 w-3 rounded-full bg-green-400" />
        <span className="ml-3 text-[11px] text-gray-400">your-salon.sitepresso.com</span>
      </div>
      {/* themed hero, using the real palette */}
      <div style={{ background: pv.bg, color: pv.text, fontFamily: pv.font }} className="px-7 py-12 text-center">
        <p style={{ color: pv.muted, letterSpacing: '0.18em' }} className="text-[11px] uppercase mb-4">{pv.tagline}</p>
        <h3 style={{ color: pv.text, fontFamily: pv.font }} className="text-2xl lg:text-[28px] font-bold leading-snug mb-6">{pv.heroHeadline}</h3>
        <span style={{ background: pv.primary, color: ctaText }} className="inline-block px-5 py-2.5 rounded-lg text-sm font-semibold">{pv.ctaLabel}</span>
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          {pv.trust.map((t) => (
            <span key={t} style={{ background: pv.surface, color: pv.muted, border: `1px solid ${pv.muted}33` }} className="text-[11px] px-2.5 py-1 rounded-full">{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Nav() {
  return (
    <nav className="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 h-20 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <img src="/drifthr-logo.svg" alt="DriftHR" className="h-16 w-auto" />
        </Link>
        <div className="hidden md:flex items-center gap-7 text-sm text-gray-600">
          <Link href="/#how-it-works" className="hover:text-gray-900">How it works</Link>
          <Link href="/#themes" className="text-gray-900 font-semibold">Themes</Link>
          <Link href="/#pricing" className="hover:text-gray-900">Pricing</Link>
          <Link href="/blog" className="hover:text-gray-900">Blog</Link>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/login" className="hidden sm:inline-flex items-center px-4 py-2.5 border border-gray-300 hover:border-gray-900 text-gray-800 text-sm font-semibold rounded-xl transition-colors">
            Sign in
          </Link>
          <Link href="/signup?redirect=/onboarding" className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold rounded-xl transition-all">
            Start trial →
          </Link>
        </div>
      </div>
    </nav>
  );
}

function Footer() {
  return (
    <footer className="border-t border-gray-100 bg-gray-50">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-12 flex flex-col md:flex-row items-center justify-between gap-4">
        <Link href="/">
          <img src="/drifthr-logo.svg" alt="DriftHR" className="h-10 w-auto" />
        </Link>
        <p className="text-sm text-gray-400">© {new Date().getFullYear()} DriftHR. Effortless HR & payroll.</p>
        <div className="flex gap-6 text-sm text-gray-500">
          <Link href="/blog" className="hover:text-gray-900">Blog</Link>
          <Link href="/#pricing" className="hover:text-gray-900">Pricing</Link>
          <Link href="/#faq" className="hover:text-gray-900">FAQ</Link>
          <Link href="/signup" className="hover:text-gray-900">Sign up</Link>
        </div>
      </div>
    </footer>
  );
}
