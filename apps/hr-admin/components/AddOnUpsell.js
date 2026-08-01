'use client';

import Link from 'next/link';

// Premium upsell shown when a paid add-on isn't on the tenant's plan. Consistent
// across the Recruitment console and its Settings sub-pages. DriftHR brand.
export default function AddOnUpsell({
  title = 'Talent Acquisition',
  blurb = 'Post jobs on your careers page, screen and score candidates objectively, run interviews, and hire straight into onboarding — all in one place.',
  bullets = [
    'Branded careers page + one-click apply',
    'Objective screening + interview scorecards',
    'Merit-list ranking, zero gut-feel',
    'Hire straight into onboarding',
  ],
  href = '/settings?tab=billing',
  cta = 'Add Talent Acquisition',
}) {
  return (
    <div className="p-6">
      <div className="mx-auto max-w-2xl">
        <div className="relative overflow-hidden rounded-3xl border border-gray-200/70 bg-white shadow-sm">
          <div className="relative px-8 pt-10 pb-8 text-center">
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: 'radial-gradient(700px 240px at 50% -40%, color-mix(in srgb, var(--theme-primary,#16B6A6) 22%, transparent), transparent 62%)' }}
              aria-hidden="true"
            />
            <div className="relative">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl text-white shadow-md" style={{ background: 'linear-gradient(135deg, var(--theme-primary,#16B6A6), #16243B)' }}>
                <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                  <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <p className="mt-4 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--theme-primary,#16B6A6)' }}>Premium add-on</p>
              <h2 className="mt-1 text-2xl font-bold tracking-tight text-gray-900">{title}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">{blurb}</p>
            </div>
          </div>
          <div className="px-8 pb-9">
            <ul className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm text-gray-700 sm:grid-cols-2">
              {bullets.map((b, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0" fill="none" aria-hidden="true">
                    <circle cx="10" cy="10" r="10" fill="var(--theme-primary,#16B6A6)" opacity="0.12" />
                    <path d="M5.5 10.5l3 3 6-6.5" stroke="var(--theme-primary,#16B6A6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
            <div className="mt-7 flex flex-col items-center gap-2">
              <Link
                href={href}
                className="inline-flex items-center justify-center rounded-xl px-6 py-3 text-sm font-semibold text-white shadow-sm transition-transform active:scale-[0.98]"
                style={{ background: 'linear-gradient(135deg, var(--theme-primary,#16B6A6), #0f9d8f)' }}
              >
                {cta}
              </Link>
              <p className="text-xs text-gray-400">14-day trial · cancel anytime · or ask your admin to enable it</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
