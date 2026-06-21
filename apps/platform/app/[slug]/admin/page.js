'use client';

// Path-based admin entry — aapkatech.com/<slug>/admin
//
// The actual admin shell lives in @/components/admin-shell. Both this
// route and the unified-admin route at app.aapkatech.com/admin import
// the same shell, so behavior is identical regardless of URL.
//
// Tenant context comes from the [slug] layout's TenantProvider (URL slug).

import { BusinessAdmin } from '@/components/admin-shell';

export default function Page() {
  return <BusinessAdmin />;
}
