'use client';

// Branded header — the visible white-label surface. Renders the tenant's logo
// (or business name fallback) against the brand color resolved by
// TenantProvider. Reads var(--theme-*) so it restyles automatically per tenant.

import Link from 'next/link';
import { useTenant } from '@/components/TenantProvider';

export default function BrandHeader() {
  const { tenant, theme } = useTenant();
  const business = tenant?.business || {};
  // White-label brand: logo if set, else the business NAME wordmark — NEVER the
  // DriftHR vendor mark.
  const brand = tenant?.brand || {};
  const logoUrl = brand.logoUrl || theme?.logoUrl || business.logoUrl || null;
  const tenantName = brand.name || business.name || business.displayName || null;
  const name = tenantName || 'Portal';

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
          ) : (
            // No logo — the business NAME wordmark (header sits on the brand
            // color, so text inherits --theme-on-primary). NEVER the DriftHR mark.
            <span className="text-base font-semibold tracking-tight truncate">{name}</span>
          )}
        </Link>
        <span className="ml-auto text-xs/5 opacity-80 hidden sm:inline">
          Employee Self-Service
        </span>
      </div>
    </header>
  );
}
