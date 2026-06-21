import Link from 'next/link';
import { notFound } from 'next/navigation';
import { publishedAnswerPages, getAnswerPage } from '@/lib/seoAnswerPages';
import { buildMetadata, absoluteUrl, articleJsonLd, SITE_NAME } from '@/lib/seo';

export async function generateStaticParams() {
  return publishedAnswerPages().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }) {
  const page = getAnswerPage(params.slug);
  if (!page) return {};
  return buildMetadata({
    title: page.metaTitle,
    description: page.metaDescription,
    path: `/answers/${page.slug}`,
    type: 'article',
    publishedTime: page.updatedAt,
  });
}

function answerJsonLd(page) {
  const path = `/answers/${page.slug}`;
  return [
    articleJsonLd({
      title: page.question,
      description: page.metaDescription,
      path,
      publishedTime: page.updatedAt,
    }),
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

export default function AnswerPage({ params }) {
  const page = getAnswerPage(params.slug);
  if (!page) notFound();

  const updated = new Date(page.updatedAt).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  return (
    <div className="min-h-screen bg-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(answerJsonLd(page)) }}
      />
      <Nav />

      <main className="max-w-3xl mx-auto px-6 py-14">
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-5">
          <Link href="/blog" className="hover:text-gray-700">Answers</Link>
          <span>/</span>
          <span className="text-gray-600">{page.categoryLabel}</span>
        </div>

        <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 leading-tight">{page.question}</h1>

        {/* AEO answer box — the citeable block */}
        <div className="mt-6 p-5 bg-violet-50 border-l-4 border-violet-500 rounded-r-xl">
          <p className="text-[15px] text-gray-800 leading-relaxed">{page.directAnswer}</p>
        </div>
        <p className="mt-3 text-xs text-gray-400">Reviewed {updated} by the {SITE_NAME} team</p>

        {/* Checklist */}
        <ol className="mt-10 space-y-5 list-none pl-0">
          {page.checklist.map((c, i) => (
            <li key={c.item} className="flex gap-4">
              <span className="flex-none mt-0.5 h-7 w-7 rounded-full bg-gray-900 text-white text-sm font-semibold flex items-center justify-center">{i + 1}</span>
              <div>
                <p className="font-semibold text-gray-900">{c.item}</p>
                <p className="text-sm text-gray-600 leading-relaxed mt-0.5">{c.why}</p>
              </div>
            </li>
          ))}
        </ol>

        <p className="mt-10 text-gray-700 leading-relaxed">{page.closing}</p>

        {/* Internal-link CTA */}
        <div className="mt-8 p-6 bg-gray-50 border border-gray-200 rounded-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <p className="text-gray-700 font-medium">Want this built for you, ready to edit?</p>
          <Link href={page.primaryCta.href} className="inline-flex flex-none items-center px-5 py-2.5 bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold rounded-xl transition-all">
            {page.primaryCta.label}
          </Link>
        </div>

        {/* FAQ */}
        <div className="mt-12">
          <h2 className="text-xl font-bold text-gray-900 mb-5">Related questions</h2>
          <div className="divide-y divide-gray-100">
            {page.faq.map((f) => (
              <div key={f.q} className="py-4">
                <p className="font-semibold text-gray-900 mb-1">{f.q}</p>
                <p className="text-gray-600 text-sm leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Related links */}
        <div className="mt-12 pt-8 border-t border-gray-100">
          <h3 className="text-sm font-bold text-gray-900 uppercase tracking-wider mb-4">Keep reading</h3>
          <ul className="space-y-2">
            {page.related.map((r) => (
              <li key={r.href}>
                <Link href={r.href} className="text-violet-600 hover:text-violet-800 font-medium text-sm">{r.label} →</Link>
              </li>
            ))}
          </ul>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <nav className="sticky top-0 z-50 bg-white/90 backdrop-blur-md border-b border-gray-100">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 h-20 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <img src="/brand/sitepresso-logo.svg" alt="Sitepresso" className="h-16 w-auto" />
        </Link>
        <div className="hidden md:flex items-center gap-7 text-sm text-gray-600">
          <Link href="/#how-it-works" className="hover:text-gray-900">How it works</Link>
          <Link href="/#themes" className="hover:text-gray-900">Themes</Link>
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
          <img src="/brand/sitepresso-logo.svg" alt="Sitepresso" className="h-10 w-auto" />
        </Link>
        <p className="text-sm text-gray-400">© {new Date().getFullYear()} Sitepresso. Websites in 5 Minutes.</p>
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
