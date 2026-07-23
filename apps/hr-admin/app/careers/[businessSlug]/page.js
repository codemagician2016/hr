'use client';

// PUBLIC careers board (Feature 12) — UNAUTHENTICATED. Renders the tenant's
// open, public roles from GET /api/public/careers/:businessSlug. No admin shell
// (ShellGate treats /careers/* as public), no auth, no internal scores. A
// candidate browses roles and clicks through to the JD + apply page.
//
// Careers CMS (Feature "Careers page"): the response now also carries
//   page  — the tenant's PUBLISHED CMS page ({headline, subheadline, aboutHtml,
//           cultureHtml, heroImageUrl, customSections[], socialLinks{}, perks[]})
//           or null when nothing is published. The backend already SANITISED the
//           rich-text on write, so aboutHtml/cultureHtml/customSections[].bodyHtml
//           are safe to inject via dangerouslySetInnerHTML.
//   brand — the tenant's active brand ({logoUrl, primaryColor, accentColor,
//           footerText}) or null.
// Both are OPTIONAL: when page is null the hero/empty-state/footer fall back to
// EXACTLY today's hard-coded copy, so a tenant who never set up a CMS page sees
// an identical board to before this change.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { get } from '@/lib/api';

// Footer social links — friendly labels for the keys the backend allows.
const SOCIAL_LABELS = {
  linkedin: 'LinkedIn', twitter: 'Twitter', x: 'X', facebook: 'Facebook',
  instagram: 'Instagram', youtube: 'YouTube', github: 'GitHub',
  glassdoor: 'Glassdoor', website: 'Website',
};

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

  // Brand theme + copy. Fall back to today's exact behaviour when brand/page are
  // absent so an un-configured tenant's board is byte-identical to before.
  const brand = data?.brand || null;
  const cms = data?.page || null;
  const primary = brand?.primaryColor || 'var(--theme-primary, #4f46e5)';
  const accent = brand?.accentColor || primary;
  const footerText = brand?.footerText || 'Powered by DriftHR';
  const headline = cms?.headline || data?.business?.name || 'Open roles';
  const subheadline = cms?.subheadline
    || "We're hiring. Browse our open roles and apply directly — it only takes a minute.";
  const socialEntries = cms?.socialLinks
    ? Object.entries(cms.socialLinks).filter(([, v]) => !!v)
    : [];

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-3xl mx-auto px-5 py-10">
        {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        {!data && !error && <div className="text-sm text-gray-400">Loading…</div>}
        {data && (
          <>
            <header className="mb-8">
              {brand?.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={brand.logoUrl} alt={data.business?.name || 'Company logo'} className="h-10 w-auto mb-4 object-contain" />
              )}
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">Careers</div>
              <h1 className="text-3xl font-semibold text-gray-900 mt-1">{headline}</h1>
              <p className="text-sm text-gray-500 mt-2">{subheadline}</p>
              {cms?.heroImageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={cms.heroImageUrl} alt="" className="mt-5 w-full rounded-2xl border border-gray-200 object-cover max-h-72" />
              )}
            </header>

            {/* CMS rich-text — About + Culture. Backend sanitised on write. */}
            {cms?.aboutHtml && (
              <section className="mb-8">
                <div className="careers-prose text-sm leading-relaxed text-gray-700" dangerouslySetInnerHTML={{ __html: cms.aboutHtml }} />
              </section>
            )}
            {cms?.cultureHtml && (
              <section className="mb-8">
                <div className="careers-prose text-sm leading-relaxed text-gray-700" dangerouslySetInnerHTML={{ __html: cms.cultureHtml }} />
              </section>
            )}

            {/* Perks — chips. */}
            {cms?.perks && cms.perks.length > 0 && (
              <section className="mb-8">
                <div className="flex flex-wrap gap-2">
                  {cms.perks.map((perk, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm text-gray-700"
                      style={{ borderColor: accent }}
                    >
                      {perk.icon && <span aria-hidden="true">{perk.icon}</span>}
                      <span>{perk.label}</span>
                    </span>
                  ))}
                </div>
              </section>
            )}

            {/* Custom sections — already ordered by the backend. */}
            {cms?.customSections && cms.customSections.length > 0 && (
              <div className="mb-8 space-y-6">
                {cms.customSections.map((sec, i) => (
                  <section key={i}>
                    {sec.title && <h2 className="text-lg font-semibold text-gray-900 mb-2">{sec.title}</h2>}
                    {sec.bodyHtml && (
                      <div className="careers-prose text-sm leading-relaxed text-gray-700" dangerouslySetInnerHTML={{ __html: sec.bodyHtml }} />
                    )}
                  </section>
                ))}
              </div>
            )}

            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-400 mb-3">Open roles</h2>

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
                    <span className="shrink-0 text-sm font-medium" style={{ color: primary }}>View &amp; apply →</span>
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

            <footer className="mt-12 text-center text-[11px] text-gray-400">
              {socialEntries.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
                  {socialEntries.map(([key, url]) => (
                    <a key={key} href={url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline" style={{ color: primary }}>
                      {SOCIAL_LABELS[key] || key}
                    </a>
                  ))}
                </div>
              )}
              {footerText}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
