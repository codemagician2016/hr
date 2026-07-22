'use client';

// Decides whether to wrap a page in the authenticated AdminShell.
// Public routes (login, password flows) render bare; everything else
// gets the sidebar + session/auth gate. Kept as a tiny client wrapper so
// the root layout itself stays a server component.

import { usePathname } from 'next/navigation';
import AdminShell from '@/components/AdminShell';

// /careers/* is the UNAUTHENTICATED public careers board + apply page (Feature 12)
// — it must render bare (no admin sidebar / session gate) so a candidate with no
// account can view a job and apply directly.
// /sso/complete is the SSO return leg — the operator is NOT signed in yet (the
// page itself performs the code→cookie exchange), so it must render bare too.
const PUBLIC_PREFIXES = ['/login', '/forgot-password', '/reset-password', '/careers', '/sso/complete'];

function isPublic(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default function ShellGate({ children }) {
  const pathname = usePathname() || '/';
  if (isPublic(pathname)) return <>{children}</>;
  return <AdminShell>{children}</AdminShell>;
}
