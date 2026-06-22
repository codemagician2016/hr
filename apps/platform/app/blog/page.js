import Link from 'next/link';
import articles from '@/lib/blogArticles';
import { buildMetadata } from '@/lib/seo';

export const metadata = buildMetadata({
  title: 'Blog — DriftHR',
  description: 'Guides, comparisons, and strategies to help service businesses get online, get found, and get booked.',
  path: '/blog',
});

const PAGE_SIZE = 9;
const CATEGORIES = ['All', ...Array.from(new Set(articles.map((a) => a.category)))];

function buildHref({ category, page }) {
  const params = new URLSearchParams();
  if (category && category !== 'All') params.set('category', category);
  if (page && page > 1) params.set('page', String(page));
  const qs = params.toString();
  return qs ? `/blog?${qs}` : '/blog';
}

export default function BlogPage({ searchParams }) {
  const category = searchParams?.category || 'All';
  const page = Math.max(1, parseInt(searchParams?.page || '1', 10));

  const filtered = category === 'All' ? articles : articles.filter((a) => a.category === category);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(totalPages, 1));
  const paginated = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);

  return (
    <div className="min-h-screen bg-white">
      <Nav />
      <main>
        <header className="max-w-7xl mx-auto px-6 lg:px-8 pt-16 pb-10">
          <p className="text-sm font-semibold text-violet-600 uppercase tracking-widest mb-3">Blog</p>
          <h1 className="text-4xl lg:text-5xl font-bold text-gray-900 mb-4">
            Grow your service business
          </h1>
          <p className="text-lg text-gray-500 max-w-2xl">
            Guides, comparisons, and strategies to help you get online, get found, and get booked.
          </p>
        </header>

        <div className="max-w-7xl mx-auto px-6 lg:px-8 pb-6">
          <div className="flex gap-2 flex-wrap">
            {CATEGORIES.map((cat) => (
              <Link
                key={cat}
                href={buildHref({ category: cat, page: 1 })}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  category === cat
                    ? 'bg-gray-900 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {cat}
              </Link>
            ))}
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-6 lg:px-8 pb-10">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {paginated.map((article) => (
              <Link
                key={article.slug}
                href={`/blog/${article.slug}`}
                className="group block bg-white border border-gray-200 rounded-2xl overflow-hidden hover:shadow-lg hover:border-gray-300 transition-all"
              >
                <div className="h-2 bg-gradient-to-r from-violet-500 to-violet-700" />
                <div className="p-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-xs font-semibold text-violet-600 uppercase tracking-wider">
                      {article.category}
                    </span>
                    <span className="text-gray-300">·</span>
                    <span className="text-xs text-gray-400">{article.readTime} min read</span>
                  </div>
                  <h2 className="text-lg font-bold text-gray-900 group-hover:text-violet-600 transition-colors leading-snug mb-3">
                    {article.title}
                  </h2>
                  <p className="text-sm text-gray-500 line-clamp-3 mb-4">{article.excerpt}</p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-400">
                      {new Date(article.publishedAt).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', year: 'numeric',
                      })}
                    </span>
                    <span className="text-sm font-semibold text-gray-900 group-hover:text-violet-600 transition-colors">
                      Read →
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>

        {totalPages > 1 && (
          <div className="max-w-7xl mx-auto px-6 lg:px-8 pb-24">
            <p className="text-center text-sm text-gray-400 mb-4">
              Page {currentPage} of {totalPages}
            </p>
            <div className="flex justify-center gap-2 flex-wrap">
              <Link
                href={buildHref({ category, page: currentPage - 1 })}
                aria-disabled={currentPage === 1}
                className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
                  currentPage === 1
                    ? 'border-gray-200 text-gray-300 pointer-events-none'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                }`}
              >
                Prev
              </Link>
              {pageNumbers.map((n) => (
                <Link
                  key={n}
                  href={buildHref({ category, page: n })}
                  className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
                    n === currentPage
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {n}
                </Link>
              ))}
              <Link
                href={buildHref({ category, page: currentPage + 1 })}
                aria-disabled={currentPage === totalPages}
                className={`px-4 py-2 rounded-full text-sm font-medium border transition-colors ${
                  currentPage === totalPages
                    ? 'border-gray-200 text-gray-300 pointer-events-none'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                }`}
              >
                Next
              </Link>
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
