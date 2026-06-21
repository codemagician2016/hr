import TenantProvider from '@/components/TenantProvider';

// Wraps the unified-admin route group in a tenant context resolved from
// the caller's JWT — used on app.aapkatech.com / app.sitepresso.com where
// the URL has no slug segment.
//
// The same admin shell renders here as on the path-based admin (the
// `[slug]/admin` route); the only difference is how TenantProvider
// resolves the tenant — `mode="self"` makes it call /api/tenant/me
// instead of /api/tenant/resolve?slug=.
export default function UnifiedAdminLayout({ children }) {
  return <TenantProvider mode="self">{children}</TenantProvider>;
}
