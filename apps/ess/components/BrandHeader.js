'use client';

// Branded header — the visible white-label surface. Renders the tenant's logo
// (or business name fallback) against the brand color resolved by
// TenantProvider. Reads var(--theme-*) so it restyles automatically per tenant.

import Link from 'next/link';
import { useTenant } from '@/components/TenantProvider';

export default function BrandHeader() {
  const { tenant, theme } = useTenant();
  const business = tenant?.business || {};
  const logoUrl = theme?.logoUrl || business.logoUrl || null;
  const tenantName = business.name || business.displayName || null;
  const name = tenantName || 'DriftHR';

  return (
    <header
      className="sticky top-0 z-20 w-full border-b"
      style={{
        background: 'var(--theme-primary)',
        color: 'var(--theme-on-primary)',
        borderColor: 'var(--theme-primary-dark)',
      }}
    >
      <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
        <Link href="/" aria-label={`${name} — home`} className="flex items-center gap-2 min-w-0">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={`${name} logo`}
              className="h-8 w-auto max-w-[140px] rounded bg-white/10 object-contain"
            />
          ) : tenantName ? (
            <span className="text-base font-semibold tracking-tight truncate">{tenantName}</span>
          ) : (
            // No tenant brand — show the DriftHR white logo (header sits on the brand color).
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/drifthr-logo-white.svg" alt="DriftHR" className="h-7 w-auto" />
          )}
        </Link>
        <span className="ml-auto text-xs/5 opacity-80 hidden sm:inline">
          Employee Self-Service
        </span>
      </div>
    </header>
  );
}
