'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { getTenantStorefrontUrl } from '@/lib/platformDomain';
import EcommerceAdminShell from '@/components/EcommerceAdminShell';
import { EcommerceLocationProvider } from '@/components/EcommerceLocationSwitcher';
import { EcomAccessProvider } from '@/components/EcomAccessContext';
import EcommerceOverviewTab from '@/components/admin-tabs/EcommerceOverviewTab';
import OrdersPanel from '@/components/OrdersPanel';
import ProductsPanel from '@/components/ProductsPanel';
import CategoriesPanel from '@/components/CategoriesPanel';
import InventoryPanel from '@/components/admin-tabs/InventoryPanel';
import BrandsPanel from '@/components/admin-tabs/BrandsPanel';
import EcommerceCouponsPanel from '@/components/admin-tabs/EcommerceCouponsPanel';
import BannersPanel from '@/components/admin-tabs/BannersPanel';
import CmsPanel from '@/components/admin-tabs/CmsPanel';
import ReviewsPanel from '@/components/admin-tabs/ReviewsPanel';
import ReturnsPanel from '@/components/admin-tabs/ReturnsPanel';
import BulkOpsPanel from '@/components/admin-tabs/BulkOpsPanel';
import PaymentsPanel from '@/components/admin-tabs/PaymentsPanel';
import EcommerceReportsPanel from '@/components/admin-tabs/EcommerceReportsPanel';
import TaxPanel from '@/components/admin-tabs/TaxPanel';
import CitiesPanel from '@/components/admin-tabs/CitiesPanel';
import RolesPermissionsPanel from '@/components/admin-tabs/RolesPermissionsPanel';
import ActivityLogPanel from '@/components/admin-tabs/ActivityLogPanel';

function Icon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

const STAFF_NAV = [
  { key: 'overview', label: 'Overview', sub: 'Store operations dashboard', group: 'Main', permissions: ['finance.view'] },
  { key: 'orders', label: 'Fulfillment', sub: 'Orders, dispatch, and pickup', group: 'Main', permissions: ['orders.view'] },
  { key: 'products', label: 'Products', sub: 'Product catalogue', group: 'Main', permissions: ['catalogue.view'] },
  { key: 'categories', label: 'Categories', sub: 'Product groups', group: 'Main', permissions: ['catalogue.view'] },
  { key: 'brands', label: 'Brands', sub: 'Brand catalogue', group: 'Main', permissions: ['catalogue.view'] },
  { key: 'inventory', label: 'Inventory', sub: 'Stock, GRN, and transfers', group: 'Main', permissions: ['inventory.view'] },
  { key: 'returns', label: 'Returns', sub: 'Refunds and restock', group: 'Main', permissions: ['orders.view'] },
  { key: 'bulk', label: 'Bulk ops', sub: 'CSV imports and exports', group: 'Main', permissions: ['catalogue.edit', 'inventory.adjust'] },
  { key: 'ecom-coupons', label: 'Coupons', sub: 'Discount operations', group: 'Marketing', permissions: ['catalogue.view'] },
  { key: 'banners', label: 'Banners', sub: 'Storefront promos', group: 'Marketing', permissions: ['catalogue.view'] },
  { key: 'cms', label: 'CMS', sub: 'Content blocks', group: 'Marketing', permissions: ['catalogue.view'] },
  { key: 'reviews', label: 'Reviews', sub: 'Moderation queue', group: 'Marketing', permissions: ['customers.view'] },
  { key: 'payments', label: 'Payments', sub: 'Payment ledger', group: 'Finance', permissions: ['finance.view'] },
  { key: 'ecom-reports', label: 'Reports', sub: 'Sales analytics', group: 'Finance', permissions: ['finance.view'] },
  { key: 'tax', label: 'Tax', sub: 'Tax and invoicing', group: 'Finance', permissions: ['finance.view'] },
  { key: 'cities', label: 'Cities', sub: 'Delivery zones', group: 'System', permissions: ['system.settings'] },
  { key: 'roles', label: 'Roles', sub: 'RBAC matrix', group: 'System', permissions: ['system.roles'] },
  { key: 'activity', label: 'Activity log', sub: 'Audit trail', group: 'System', permissions: ['system.settings'] },
].map((item) => ({ ...item, icon: Icon }));

const STAFF_NAV_GROUPS = [
  { label: 'Main', keys: STAFF_NAV.filter((item) => item.group === 'Main').map((item) => item.key) },
  { label: 'Marketing', keys: STAFF_NAV.filter((item) => item.group === 'Marketing').map((item) => item.key) },
  { label: 'Finance', keys: STAFF_NAV.filter((item) => item.group === 'Finance').map((item) => item.key) },
  { label: 'System', keys: STAFF_NAV.filter((item) => item.group === 'System').map((item) => item.key) },
];

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function hasAnyPermission(item, permissionSet, isOwner) {
  if (isOwner) return true;
  return item.permissions.some((permission) => permissionSet.has(permission));
}

function isDeliveryOnlyRole(user, access) {
  const roleName = String(access?.role?.name || user?.businessRole?.name || '').toLowerCase();
  const permissions = Array.isArray(access?.permissions) ? access.permissions : [];
  return /rider|driver|delivery/.test(roleName) && permissions.length === 0;
}

function isPickerRole(user, access) {
  const roleName = String(access?.role?.name || user?.businessRole?.name || '').toLowerCase();
  return /picker|packer|warehouse/.test(roleName);
}

function Spinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f7f5]">
      <svg className="h-8 w-8 animate-spin text-emerald-600" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
      </svg>
    </div>
  );
}

function AccessState({ title, message }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f7f5] px-6">
      <div className="max-w-md rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <p className="text-lg font-semibold text-gray-900">{title}</p>
        <p className="mt-2 text-sm text-gray-500">{message}</p>
      </div>
    </div>
  );
}

function Panel({ activeKey, me }) {
  switch (activeKey) {
    case 'overview': return <EcommerceOverviewTab me={me} />;
    case 'orders': return <div className="rounded-2xl border border-gray-200 bg-white p-6"><OrdersPanel /></div>;
    case 'products': return <div className="rounded-2xl border border-gray-200 bg-white p-6"><ProductsPanel /></div>;
    case 'categories': return <div className="rounded-2xl border border-gray-200 bg-white p-6"><CategoriesPanel /></div>;
    case 'brands': return <BrandsPanel />;
    case 'inventory': return <InventoryPanel />;
    case 'ecom-coupons': return <EcommerceCouponsPanel />;
    case 'banners': return <BannersPanel />;
    case 'cms': return <CmsPanel />;
    case 'reviews': return <ReviewsPanel />;
    case 'returns': return <ReturnsPanel />;
    case 'bulk': return <BulkOpsPanel />;
    case 'payments': return <PaymentsPanel />;
    case 'ecom-reports': return <EcommerceReportsPanel />;
    case 'tax': return <TaxPanel />;
    case 'cities': return <CitiesPanel />;
    case 'roles': return <RolesPermissionsPanel />;
    case 'activity': return <ActivityLogPanel />;
    default: return null;
  }
}

export default function EcommerceStaffManagerPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const slug = params?.slug;
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [user, setUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [access, setAccess] = useState({ permissions: [], isOwner: false });

  useEffect(() => {
    async function load() {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const loginCode = urlParams.get('loginCode');
        if (loginCode) {
          await api('/api/auth/exchange-login-code', {
            method: 'POST',
            body: JSON.stringify({ code: loginCode }),
          }).catch(() => null);
          urlParams.delete('loginCode');
          const clean = urlParams.toString();
          window.history.replaceState({}, '', window.location.pathname + (clean ? `?${clean}` : ''));
        }

        const [{ user: currentUser }, tenantRes, accessRes] = await Promise.all([
          api('/api/auth/me'),
          api(`/api/tenant/resolve?slug=${encodeURIComponent(slug)}`),
          api('/api/ecom/access'),
        ]);

        if (!['STAFF', 'BUSINESS_ADMIN'].includes(currentUser?.role)) {
          setError('Store staff or business admin access required.');
          setStatus('forbidden');
          return;
        }
        if (tenantRes?.business?.id && currentUser.businessId && tenantRes.business.id !== currentUser.businessId) {
          setError('This staff account belongs to a different business.');
          setStatus('forbidden');
          return;
        }
        if (String(tenantRes?.business?.vertical || '').toUpperCase() !== 'ECOMMERCE') {
          window.location.replace(`/${slug}/staff${window.location.search || ''}`);
          return;
        }
        if (currentUser?.role === 'STAFF' && isDeliveryOnlyRole(currentUser, accessRes)) {
          window.location.replace(`/${slug}/staff/delivery${window.location.search || ''}`);
          return;
        }
        if (currentUser?.role === 'STAFF' && isPickerRole(currentUser, accessRes)) {
          window.location.replace(`/${slug}/staff/picker${window.location.search || ''}`);
          return;
        }

        setUser(currentUser);
        setTenant(tenantRes);
        setAccess(accessRes);
        setStatus('ready');
      } catch (err) {
        if (err.status === 401) {
          router.replace(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return;
        }
        setError(err.message || 'Unable to load staff portal.');
        setStatus('forbidden');
      }
    }
    if (slug) load();
  }, [router, slug]);

  const permissionSet = useMemo(() => new Set(access.permissions || []), [access.permissions]);
  const navItems = useMemo(
    () => STAFF_NAV.filter((item) => hasAnyPermission(item, permissionSet, access.isOwner)),
    [access.isOwner, permissionSet],
  );
  const navGroups = useMemo(
    () => STAFF_NAV_GROUPS.map((group) => ({
      ...group,
      keys: group.keys.filter((key) => navItems.some((item) => item.key === key)),
    })).filter((group) => group.keys.length > 0),
    [navItems],
  );

  const requestedTab = searchParams.get('tab') || 'overview';
  const activeKey = navItems.some((item) => item.key === requestedTab) ? requestedTab : navItems[0]?.key;

  function setTab(nextKey) {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('view');
    next.delete('id');
    next.delete('parent');
    next.set('tab', nextKey);
    router.replace(`?${next.toString()}`, { scroll: false });
  }

  if (status === 'loading') return <Spinner />;
  if (status === 'forbidden') return <AccessState title="Access denied" message={error} />;
  if (navItems.length === 0) {
    return <AccessState title="No operations assigned" message="Ask the business admin to assign an ecommerce role to this staff account." />;
  }

  return (
    <EcomAccessProvider access={access}>
      <EcommerceLocationProvider businessSlug={tenant?.business?.slug}>
        <EcommerceAdminShell
          tenant={tenant}
          business={tenant?.business}
          me={{ ...user, businessRole: access.role || user?.businessRole }}
          navItems={navItems}
          navGroups={navGroups}
          activeKey={activeKey}
          setTab={setTab}
          isLive={!!tenant?.bookingOpen}
          storefrontUrl={getTenantStorefrontUrl(tenant?.business?.slug) || '#'}
        >
          <Panel activeKey={activeKey} me={user} />
        </EcommerceAdminShell>
      </EcommerceLocationProvider>
    </EcomAccessProvider>
  );
}
