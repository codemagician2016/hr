import Link from 'next/link';

export default function LegalLayout({ children }) {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 lg:px-8 py-5 flex items-center justify-between">
          <Link href="/" className="text-lg font-bold tracking-tight">DriftHR</Link>
          <nav className="flex items-center gap-5 text-sm text-gray-600">
            <Link href="/legal/terms" className="hover:text-gray-900">Terms</Link>
            <Link href="/legal/privacy" className="hover:text-gray-900">Privacy</Link>
            <Link href="/legal/refund" className="hover:text-gray-900">Refund</Link>
            <Link href="/legal/cookies" className="hover:text-gray-900">Cookies</Link>
            <Link href="/legal/dpa" className="hover:text-gray-900">DPA</Link>
            <Link href="/legal/sub-processors" className="hover:text-gray-900">Sub-processors</Link>
          </nav>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 lg:px-8 py-12 md:py-16">
        <article className="prose prose-gray max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-h1:text-4xl md:prose-h1:text-5xl prose-h1:mb-4 prose-h2:mt-10 prose-h2:mb-3 prose-h2:text-xl prose-p:leading-relaxed prose-p:text-gray-700 prose-li:text-gray-700 prose-a:text-indigo-600 prose-a:no-underline hover:prose-a:underline prose-strong:text-gray-900">
          {children}
        </article>
      </main>
      <footer className="border-t border-gray-200">
        <div className="max-w-5xl mx-auto px-6 lg:px-8 py-6 text-xs text-gray-500 flex items-center justify-between">
          <span>© {new Date().getFullYear()} Loominfo Limited. All rights reserved.</span>
          <span>Auckland, New Zealand</span>
        </div>
      </footer>
    </div>
  );
}
