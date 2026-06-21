import TenantProvider from '@/components/TenantProvider';

// Wraps everything under /<slug>/* in a tenant context keyed by the URL
// slug segment. The ported admin + staff UIs read it via `useTenant()`.
//
// Next.js 14: `params` here is a plain object, not a Promise — do NOT
// wrap in React.use() or the route crashes with a client-side exception.
export default function TenantLayout({ params, children }) {
  const { slug } = params;
  return <TenantProvider slug={slug}>{children}</TenantProvider>;
}
