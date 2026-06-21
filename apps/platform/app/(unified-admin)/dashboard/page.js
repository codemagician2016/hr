'use client';

// Unified-admin entry — app.aapkatech.com/dashboard (or app.sitepresso.com/dashboard).
//
// Same shell as the path-based admin at <slug>/admin, but tenant context
// comes from the JWT (via the (unified-admin)/layout.js TenantProvider in
// self mode) instead of the URL.
//
// Hard-cutover plan: once DNS for app.aapkatech.com points at this app
// and nginx adds the server block, the path-based admin URL is dead per
// the user's "previous must not work" requirement. See SETUP-app-domain.md.

import { BusinessAdmin } from '@/components/admin-shell';

export default function Page() {
  return <BusinessAdmin />;
}
