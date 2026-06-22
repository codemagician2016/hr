import Link from 'next/link';
import { notFound } from 'next/navigation';
import articles from '@/lib/blogArticles';
import { buildMetadata, articleJsonLd } from '@/lib/seo';

export async function generateStaticParams() {
  return articles.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }) {
  const article = articles.find((a) => a.slug === params.slug);
  if (!article) return {};
  return buildMetadata({
    title: `${article.title} — DriftHR Blog`,
    description: article.excerpt,
    path: `/blog/${article.slug}`,
    type: 'article',
    publishedTime: article.publishedAt,
  });
}

export default function ArticlePage({ params }) {
  const article = articles.find((a) => a.slug === params.slug);
  if (!article) notFound();

  const related = articles
    .filter((a) => a.slug !== article.slug && a.category === article.category)
    .slice(0, 3);

  return (
    <div className="min-h-screen bg-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            articleJsonLd({
              title: article.title,
              description: article.excerpt,
              path: `/blog/${article.slug}`,
              publishedTime: article.publishedAt,
            })
          ),
        }}
      />
      <Nav />
      <main className="max-w-3xl mx-auto px-6 py-16">
        <Link href="/blog" className="text-sm text-gray-400 hover:text-gray-700 transition-colors mb-8 inline-flex items-center gap-1">
          ← Back to Blog
        </Link>

        <div className="flex items-center gap-2 mb-4 mt-6">
          <span className="text-xs font-semibold text-violet-600 uppercase tracking-wider">
            {article.category}
          </span>
          <span className="text-gray-300">·</span>
          <span className="text-xs text-gray-400">{article.readTime} min read</span>
          <span className="text-gray-300">·</span>
          <span className="text-xs text-gray-400">
            {new Date(article.publishedAt).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'long', year: 'numeric',
            })}
          </span>
        </div>

        <h1 className="text-3xl lg:text-4xl font-bold text-gray-900 leading-tight mb-6">
          {article.title}
        </h1>

        <p className="text-lg text-gray-500 mb-10 border-b border-gray-100 pb-10">
          {article.excerpt}
        </p>

        <div
          className="prose prose-lg prose-gray max-w-none
            prose-h2:text-2xl prose-h2:font-bold prose-h2:text-gray-900 prose-h2:mt-10 prose-h2:mb-4
            prose-p:text-gray-600 prose-p:leading-relaxed
            prose-ul:text-gray-600 prose-ol:text-gray-600
            prose-li:my-1
            prose-strong:text-gray-900"
          dangerouslySetInnerHTML={{ __html: article.content }}
        />

        <div className="mt-16 p-8 bg-violet-50 border border-violet-100 rounded-2xl text-center">
          <p className="text-sm font-semibold text-violet-600 uppercase tracking-wider mb-2">
            Ready to launch?
          </p>
          <h2 className="text-2xl font-bold text-gray-900 mb-3">
            Get your website live in 5 minutes
          </h2>
          <p className="text-gray-600 mb-6">
            Pick your industry, choose a plan, customise, and go live.
          </p>
          <Link
            href="/signup?redirect=/onboarding"
            className="inline-flex items-center gap-1.5 px-6 py-3 bg-gray-900 hover:bg-gray-800 text-white font-semibold rounded-xl transition-all"
          >
            Start now →
          </Link>
        </div>

        {related.length > 0 && (
          <div className="mt-16">
            <h3 className="text-lg font-bold text-gray-900 mb-6">Related articles</h3>
            <div className="grid gap-4 sm:grid-cols-3">
              {related.map((a) => (
                <Link
                  key={a.slug}
                  href={`/blog/${a.slug}`}
                  className="group block p-4 border border-gray-200 rounded-xl hover:border-gray-300 hover:shadow-sm transition-all"
                >
                  <p className="text-xs text-violet-600 font-semibold uppercase tracking-wider mb-2">
                    {a.category}
                  </p>
                  <p className="text-sm font-semibold text-gray-900 group-hover:text-violet-600 transition-colors leading-snug">
                    {a.title}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        )}
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
          <img src="/drifthr-logo.svg" alt="DriftHR" className="h-16 w-auto" />
        </Link>
        <div className="hidden md:flex items-center gap-7 text-sm text-gray-600">
          <Link href="/#how-it-works" className="hover:text-gray-900">How it works</Link>
          <Link href="/#themes" className="hover:text-gray-900">Themes</Link>
          <Link href="/#pricing" className="hover:text-gray-900">Pricing</Link>
          <Link href="/#faq" className="hover:text-gray-900">FAQ</Link>
          <Link href="/blog" className="text-gray-900 font-semibold">Blog</Link>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/login"
            className="hidden sm:inline-flex items-center px-4 py-2.5 border border-gray-300 hover:border-gray-900 text-gray-800 text-sm font-semibold rounded-xl transition-colors">
            Sign in
          </Link>
          <Link href="/signup?redirect=/onboarding"
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold rounded-xl transition-all">
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
        <p className="text-sm text-gray-400">
          © {new Date().getFullYear()} DriftHR. Effortless HR & payroll.
        </p>
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
