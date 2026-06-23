'use client';

// PUBLIC careers board (Feature 12) — UNAUTHENTICATED. Renders the tenant's
// open, public roles from GET /api/public/careers/:businessSlug. No admin shell
// (ShellGate treats /careers/* as public), no auth, no internal scores. A
// candidate browses roles and clicks through to the JD + apply page.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { get } from '@/lib/api';

export default function CareersBoardPage() {
  const { businessSlug } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setError('');
    try { setData(await get(`/api/public/careers/${businessSlug}`, { page, pageSize: 20 })); }
    catch (e) { setError(e.status === 404 ? 'This careers page was not found.' : e.message); }
  }, [businessSlug, page]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-3xl mx-auto px-5 py-10">
        {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {!data && !error && <div className="text-sm text-gray-400">Loading…</div>}
        {data && (
          <>
            <header className="mb-8">
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Careers</div>
              <h1 className="text-3xl font-semibold text-gray-900 mt-1">{data.business?.name || 'Open roles'}</h1>
              <p className="text-sm text-gray-500 mt-2">We're hiring. Browse our open roles and apply directly — it only takes a minute.</p>
            </header>

            {data.items.length === 0 && (
              <div className="rounded-2xl border border-dashed border-gray-300 p-10 text-center text-gray-500">No open roles right now. Check back soon!</div>
            )}

            <div className="space-y-3">
              {data.items.map((job) => (
                <Link
                  key={job.id} href={`/careers/${businessSlug}/jobs/${job.publicSlug}`}
                  className="block rounded-2xl border border-gray-200 bg-white p-5 shadow-sm hover:shadow-md hover:border-gray-300 transition"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-base font-semibold text-gray-900">{job.title}</div>
                      <div className="text-xs text-gray-500 mt-1 flex flex-wrap gap-2">
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5">{(job.employmentType || '').replace(/_/g, ' ') || 'Full time'}</span>
                        <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5">{job.countryCode}</span>
                        {job.openings > 1 && <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5">{job.openings} openings</span>}
                      </div>
                    </div>
                    <span className="shrink-0 text-sm font-medium" style={{ color: 'var(--theme-primary, #4f46e5)' }}>View &amp; apply →</span>
                  </div>
                </Link>
              ))}
            </div>

            {data.pagination && data.pagination.totalPages > 1 && (
              <div className="flex items-center justify-center gap-3 mt-6 text-sm text-gray-500">
                <button disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-3 py-1.5 border rounded-lg disabled:opacity-40">Prev</button>
                <span>Page {data.pagination.page} of {data.pagination.totalPages}</span>
                <button disabled={page >= data.pagination.totalPages} onClick={() => setPage(page + 1)} className="px-3 py-1.5 border rounded-lg disabled:opacity-40">Next</button>
              </div>
            )}

            <footer className="mt-12 text-center text-[11px] text-gray-400">Powered by DriftHR</footer>
          </>
        )}
      </div>
    </div>
  );
}
