'use client';

// Customer list + per-customer history drawer.
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, Empty, formatAdminDate, formatAdminDateTime, formatMoneyMinor } from '@/components/admin-ui';
import EmailDeliveryHistoryPanel from '@/components/EmailDeliveryHistoryPanel';
import EmailUpdatesTab from './EmailUpdatesTab';
import { formatCurrencyMinor, getDefaultCurrency } from '@/lib/currency';

function CustomersTab({ initialSubTab = 'people', vertical, business }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isEcommerce = String(vertical || business?.vertical || '').toUpperCase() === 'ECOMMERCE';
  const requestedSection = initialSubTab === 'emails' ? 'emails' : (searchParams.get('section') || 'people');
  const subTab = requestedSection === 'emails' ? 'emails' : 'people';
  const setSubTab = useCallback((nextSubTab) => {
    const safeSubTab = nextSubTab === 'emails' ? 'emails' : 'people';
    const params = new URLSearchParams(searchParams.toString());
    if (safeSubTab === 'people') params.delete('section');
    else params.set('section', safeSubTab);
    params.delete('customer');
    params.delete('segment');
    params.delete('q');
    if (params.get('tab') === 'emails') params.set('tab', 'customers');
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    if (initialSubTab === 'emails' && searchParams.get('tab') === 'emails') {
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', 'customers');
      params.set('section', 'emails');
      router.replace(`?${params.toString()}`, { scroll: false });
    }
  }, [initialSubTab, router, searchParams]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 p-1 bg-gray-100 rounded-xl w-fit">
        <SubTabBtn active={subTab === 'people'} onClick={() => setSubTab('people')}>People</SubTabBtn>
        <SubTabBtn active={subTab === 'emails'} onClick={() => setSubTab('emails')}>Emails</SubTabBtn>
      </div>
      {subTab === 'people' && (isEcommerce ? <EcommerceCustomersList business={business} /> : <CustomersList />)}
      {subTab === 'emails' && <EmailUpdatesTab />}
    </div>
  );
}

function SubTabBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
        active ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
      }`}
    >
      {children}
    </button>
  );
}

// Segment a customer based on their visit + spend stats. Simple
// model that works for BOTH booking + ecommerce verticals (visits =
// orders or appointments). Tuned for early-stage tenants where
// 5+ visits is a real loyalty signal.
function segmentFor(customer, vipThreshold) {
  const visits = customer.stats?.visits || 0;
  const spend  = customer.stats?.totalSpend || 0;
  const lastVisit = customer.stats?.lastVisit ? new Date(customer.stats.lastVisit).getTime() : null;
  const daysSince = lastVisit ? (Date.now() - lastVisit) / 86400000 : null;

  if (vipThreshold > 0 && spend >= vipThreshold) return 'VIP';
  if (visits === 0) return 'NEW';
  if (daysSince !== null && daysSince > 90) return 'DORMANT';
  if (visits === 1) return 'NEW';
  if (visits >= 5) return 'LOYAL';
  return 'RETURNING';
}

const SEGMENT_META = {
  NEW:       { label: 'New',       cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  RETURNING: { label: 'Returning', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  LOYAL:     { label: 'Loyal',     cls: 'bg-purple-50 text-purple-700 border-purple-200' },
  VIP:       { label: 'VIP',       cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  DORMANT:   { label: 'Dormant',   cls: 'bg-gray-50 text-gray-500 border-gray-200' },
};

function customerKey(order) {
  return (order.customerEmail || order.customerPhone || order.customerId || order.customerName || 'guest').toLowerCase();
}

function orderRevenue(order) {
  if (['CANCELLED', 'FAILED', 'REFUNDED'].includes(order.status)) return 0;
  return Number(order.totalMinor || 0);
}

function ecommerceSegment(customer, vipThreshold) {
  const daysSince = customer.lastOrderAt ? (Date.now() - new Date(customer.lastOrderAt).getTime()) / 86400000 : null;
  if (customer.revenueMinor >= vipThreshold && customer.orders >= 2) return 'VIP';
  if (customer.orders === 0) return 'NEW';
  if (customer.orders === 1) return 'NEW';
  if (daysSince !== null && daysSince > 60) return 'DORMANT';
  if (customer.orders >= 4) return 'LOYAL';
  return 'RETURNING';
}

function EcommerceCustomersList({ business }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [orders, setOrders] = useState(null);
  const [customerAccounts, setCustomerAccounts] = useState([]);
  const [error, setError] = useState('');
  const search = searchParams.get('q') || '';
  const rawSegment = searchParams.get('segment') || 'ALL';
  const segmentFilter = rawSegment === 'ALL' || SEGMENT_META[rawSegment] ? rawSegment : 'ALL';
  const selectedId = searchParams.get('customer') || '';
  const currency = getDefaultCurrency({ business });

  const replaceQuery = useCallback((mutator) => {
    const params = new URLSearchParams(searchParams.toString());
    mutator(params);
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ordersData, customersData] = await Promise.all([
          api('/api/ecom/orders?perPage=200'),
          api('/api/ecom/customers?perPage=500').catch(() => ({ customers: [] })),
        ]);
        if (!cancelled) {
          setOrders(ordersData.orders || []);
          setCustomerAccounts(customersData.customers || []);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load ecommerce customers');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const customers = useMemo(() => {
    const map = new Map();
    for (const order of orders || []) {
      const key = customerKey(order);
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          name: order.customerName || 'Customer',
          email: order.customerEmail || '',
          phone: order.customerPhone || '',
          orders: 0,
          revenueMinor: 0,
          items: 0,
          codOrders: 0,
          pickupOrders: 0,
          deliveryOrders: 0,
          cancelledOrders: 0,
          firstOrderAt: order.placedAt || order.createdAt,
          lastOrderAt: order.placedAt || order.createdAt,
          recentOrders: [],
        });
      }
      const row = map.get(key);
      row.name = row.name || order.customerName || 'Customer';
      row.email = row.email || order.customerEmail || '';
      row.phone = row.phone || order.customerPhone || '';
      row.orders += 1;
      row.revenueMinor += orderRevenue(order);
      row.items += (order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      if (order.paymentMethod === 'cod') row.codOrders += 1;
      if (order.fulfillmentType === 'PICKUP') row.pickupOrders += 1;
      if (order.fulfillmentType === 'DELIVERY') row.deliveryOrders += 1;
      if (['CANCELLED', 'FAILED', 'REFUNDED'].includes(order.status)) row.cancelledOrders += 1;
      const placed = order.placedAt || order.createdAt;
      if (placed && (!row.firstOrderAt || new Date(placed) < new Date(row.firstOrderAt))) row.firstOrderAt = placed;
      if (placed && (!row.lastOrderAt || new Date(placed) > new Date(row.lastOrderAt))) row.lastOrderAt = placed;
      row.recentOrders.push(order);
    }
    for (const customer of customerAccounts || []) {
      const key = customerKey({
        customerId: customer.id,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        customerName: customer.name,
      });
      if (!map.has(key)) {
        map.set(key, {
          id: key,
          customerId: customer.id,
          name: customer.name || 'Customer',
          email: customer.email || '',
          phone: customer.phone || '',
          orders: 0,
          revenueMinor: 0,
          items: 0,
          codOrders: 0,
          pickupOrders: 0,
          deliveryOrders: 0,
          cancelledOrders: 0,
          firstOrderAt: null,
          lastOrderAt: null,
          registeredAt: customer.createdAt,
          recentOrders: [],
        });
      } else {
        const row = map.get(key);
        row.customerId = customer.id;
        row.name = row.name || customer.name || 'Customer';
        row.email = row.email || customer.email || '';
        row.phone = row.phone || customer.phone || '';
        row.registeredAt = customer.createdAt;
      }
    }
    return Array.from(map.values()).map((customer) => ({
      ...customer,
      avgOrderMinor: customer.orders ? Math.round(customer.revenueMinor / customer.orders) : 0,
      recentOrders: customer.recentOrders.sort((a, b) => new Date(b.placedAt || b.createdAt) - new Date(a.placedAt || a.createdAt)).slice(0, 8),
    })).sort((a, b) => (b.revenueMinor - a.revenueMinor) || new Date(b.lastOrderAt || b.registeredAt || 0) - new Date(a.lastOrderAt || a.registeredAt || 0));
  }, [orders, customerAccounts]);

  const vipThreshold = useMemo(() => {
    if (customers.length === 0) return 0;
    const spends = customers.map((c) => c.revenueMinor).sort((a, b) => a - b);
    return Math.max(5000, spends[Math.floor(spends.length * 0.9)] || 0);
  }, [customers]);

  const annotated = useMemo(() => customers.map((c) => ({ ...c, _segment: ecommerceSegment(c, vipThreshold) })), [customers, vipThreshold]);
  const segmentCounts = useMemo(() => {
    const c = { ALL: annotated.length, NEW: 0, RETURNING: 0, LOYAL: 0, VIP: 0, DORMANT: 0 };
    annotated.forEach((row) => { c[row._segment] = (c[row._segment] || 0) + 1; });
    return c;
  }, [annotated]);

  const summary = useMemo(() => {
    const revenueMinor = annotated.reduce((sum, c) => sum + c.revenueMinor, 0);
    const totalOrders = annotated.reduce((sum, c) => sum + c.orders, 0);
    const repeatCustomers = annotated.filter((c) => c.orders > 1).length;
    const now = Date.now();
    const new30 = annotated.filter((c) => c.firstOrderAt && now - new Date(c.firstOrderAt).getTime() <= 30 * 86400000).length;
    const atRisk = annotated.filter((c) => c._segment === 'DORMANT').length;
    return {
      customers: annotated.length,
      revenueMinor,
      totalOrders,
      repeatRate: annotated.length ? Math.round((repeatCustomers / annotated.length) * 100) : 0,
      avgOrderMinor: totalOrders ? Math.round(revenueMinor / totalOrders) : 0,
      new30,
      atRisk,
    };
  }, [annotated]);

  const filtered = useMemo(() => {
    let list = annotated;
    if (segmentFilter !== 'ALL') list = list.filter((r) => r._segment === segmentFilter);
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => [r.name, r.email, r.phone].filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [annotated, search, segmentFilter]);
  const selected = useMemo(() => annotated.find((customer) => customer.id === selectedId) || null, [annotated, selectedId]);
  const setSearch = useCallback((value) => {
    replaceQuery((params) => {
      const next = String(value || '').trim();
      if (next) params.set('q', next);
      else params.delete('q');
    });
  }, [replaceQuery]);
  const setSegmentFilter = useCallback((value) => {
    replaceQuery((params) => {
      if (!value || value === 'ALL') params.delete('segment');
      else params.set('segment', value);
      params.delete('customer');
    });
  }, [replaceQuery]);
  const setSelected = useCallback((customer) => {
    replaceQuery((params) => {
      if (customer?.id) params.set('customer', customer.id);
      else params.delete('customer');
    });
  }, [replaceQuery]);

  if (error) return <ErrorBanner message={error} />;
  if (orders === null) return <div className="py-8 flex justify-center"><Spinner /></div>;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-emerald-700">Grocery customer analytics</p>
        <h2 className="mt-1 text-2xl font-black text-gray-950">Customers, retention, and basket value</h2>
        <p className="mt-1 text-sm text-gray-500">Ecommerce view based on shop orders plus registered shoppers who have not ordered yet. Booking appointments are excluded.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <SummaryStat label="Customers" value={summary.customers} />
        <SummaryStat label="Revenue" value={formatCurrencyMinor(summary.revenueMinor, currency)} />
        <SummaryStat label="Orders" value={summary.totalOrders} />
        <SummaryStat label="Avg basket" value={formatCurrencyMinor(summary.avgOrderMinor, currency)} />
        <SummaryStat label="Repeat rate" value={`${summary.repeatRate}%`} tint="emerald" />
        <SummaryStat label="At risk" value={summary.atRisk} tint={summary.atRisk ? 'rose' : 'emerald'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-black text-gray-950">Segments</h3>
              <p className="mt-1 text-sm text-gray-500">Use these to plan offers, win-back messages, and VIP care.</p>
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email, phone"
              className="min-w-[260px] rounded-xl border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <SegmentChip label="All" count={segmentCounts.ALL} active={segmentFilter === 'ALL'} onClick={() => setSegmentFilter('ALL')} />
            {['NEW', 'RETURNING', 'LOYAL', 'VIP', 'DORMANT'].map((s) => (
              <SegmentChip key={s} label={SEGMENT_META[s].label} count={segmentCounts[s] || 0}
                active={segmentFilter === s} onClick={() => setSegmentFilter(s)} cls={SEGMENT_META[s].cls} />
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <h3 className="text-base font-black text-gray-950">Best next actions</h3>
          <div className="mt-3 space-y-2 text-sm text-gray-700">
            <p><strong>{segmentCounts.VIP || 0}</strong> VIPs: protect with priority delivery or early deals.</p>
            <p><strong>{segmentCounts.DORMANT || 0}</strong> dormant: send win-back coupons.</p>
            <p><strong>{summary.new30}</strong> new in 30d: trigger second-order offer.</p>
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white py-12 text-center text-sm text-gray-500">No ecommerce customers match this view.</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 font-semibold text-gray-700">Customer</th>
                <th className="hidden px-4 py-3 font-semibold text-gray-700 sm:table-cell">Orders</th>
                <th className="hidden px-4 py-3 font-semibold text-gray-700 md:table-cell">Revenue</th>
                <th className="hidden px-4 py-3 font-semibold text-gray-700 lg:table-cell">AOV</th>
                <th className="hidden px-4 py-3 font-semibold text-gray-700 lg:table-cell">Fulfillment</th>
                <th className="px-4 py-3 font-semibold text-gray-700">Last order</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} onClick={() => setSelected(c)} className="cursor-pointer border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-gray-950">{c.name}</p>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${SEGMENT_META[c._segment]?.cls || ''}`}>{SEGMENT_META[c._segment]?.label || c._segment}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-gray-500">{[c.email, c.phone].filter(Boolean).join(' · ') || 'Guest customer'}</p>
                  </td>
                  <td className="hidden px-4 py-3 font-black text-gray-950 sm:table-cell">{c.orders}</td>
                  <td className="hidden px-4 py-3 font-semibold text-gray-900 md:table-cell">{formatCurrencyMinor(c.revenueMinor, currency)}</td>
                  <td className="hidden px-4 py-3 text-gray-700 lg:table-cell">{formatCurrencyMinor(c.avgOrderMinor, currency)}</td>
                  <td className="hidden px-4 py-3 text-xs text-gray-600 lg:table-cell">{c.deliveryOrders} delivery · {c.pickupOrders} pickup</td>
                  <td className="px-4 py-3 text-xs text-gray-600">{c.lastOrderAt ? new Date(c.lastOrderAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <EcommerceCustomerDrawer customer={selected} currency={currency} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function EcommerceCustomerDrawer({ customer, currency, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-start justify-between border-b border-gray-100 bg-white px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-lg font-black text-gray-950">{customer.name}</h3>
            <p className="truncate text-xs text-gray-500">{[customer.email, customer.phone].filter(Boolean).join(' · ') || 'Guest customer'}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-gray-400 hover:text-gray-700" aria-label="Close">x</button>
        </div>
        <div className="grid grid-cols-4 gap-2 border-b border-gray-100 p-5">
          <StatMini label="Orders" value={customer.orders} />
          <StatMini label="Spent" value={formatCurrencyMinor(customer.revenueMinor, currency)} />
          <StatMini label="Avg" value={formatCurrencyMinor(customer.avgOrderMinor, currency)} />
          <StatMini label="Items" value={customer.items} />
        </div>
        <div className="p-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">Recent shop orders</p>
          <ul className="space-y-2">
            {customer.recentOrders.map((order) => (
              <li key={order.id} className="rounded-xl border border-gray-100 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-xs font-black text-gray-950">#{String(order.id).slice(0, 8)}</p>
                    <p className="mt-1 text-xs text-gray-500">{order.fulfillmentType} · {order.status} · {order.paymentMethod}</p>
                  </div>
                  <p className="font-black text-gray-950">{formatCurrencyMinor(order.totalMinor, order.currency || currency)}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function CustomersList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const search = searchParams.get('q') || '';
  const rawSegment = searchParams.get('segment') || 'ALL';
  const segmentFilter = rawSegment === 'ALL' || SEGMENT_META[rawSegment] ? rawSegment : 'ALL';
  const historyCustomerId = searchParams.get('customer') || '';

  const replaceQuery = useCallback((mutator) => {
    const params = new URLSearchParams(searchParams.toString());
    mutator(params);
    router.replace(params.toString() ? `?${params.toString()}` : '?', { scroll: false });
  }, [router, searchParams]);

  const setSearch = useCallback((value) => {
    replaceQuery((params) => {
      const next = String(value || '').trim();
      if (next) params.set('q', next);
      else params.delete('q');
    });
  }, [replaceQuery]);

  const setSegmentFilter = useCallback((value) => {
    replaceQuery((params) => {
      if (!value || value === 'ALL') params.delete('segment');
      else params.set('segment', value);
      params.delete('customer');
    });
  }, [replaceQuery]);

  const setHistoryCustomerId = useCallback((customerId) => {
    replaceQuery((params) => {
      if (customerId) params.set('customer', customerId);
      else params.delete('customer');
    });
  }, [replaceQuery]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api('/api/business/customers');
        if (!cancelled) setRows(data.customers || []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load customers');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // VIP threshold = 90th percentile of total spend across all customers,
  // floor at 1000 so quiet tenants don't flag everyone as VIP.
  const vipThreshold = useMemo(() => {
    if (!rows || rows.length === 0) return 1000;
    const spends = rows.map((r) => r.stats?.totalSpend || 0).sort((a, b) => a - b);
    const idx = Math.floor(spends.length * 0.9);
    return Math.max(1000, spends[idx] || 0);
  }, [rows]);

  // Annotate rows with segment + count by segment for the filter chips
  const annotated = useMemo(() => (rows || []).map((r) => ({ ...r, _segment: segmentFor(r, vipThreshold) })), [rows, vipThreshold]);
  const segmentCounts = useMemo(() => {
    const c = { ALL: annotated.length, NEW: 0, RETURNING: 0, LOYAL: 0, VIP: 0, DORMANT: 0 };
    for (const r of annotated) c[r._segment] = (c[r._segment] || 0) + 1;
    return c;
  }, [annotated]);

  const filtered = useMemo(() => {
    let list = annotated;
    if (segmentFilter !== 'ALL') list = list.filter((r) => r._segment === segmentFilter);
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => {
      const hay = [r.name, r.email, r.phone].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [annotated, segmentFilter, search]);

  // Summary stats across the whole list — useful for the "is my business
  // growing" glance at the top of the tab.
  const summary = useMemo(() => {
    if (!rows) return { total: 0, totalVisits: 0, totalSpend: 0, withUpcoming: 0 };
    let totalVisits = 0, totalSpend = 0, withUpcoming = 0;
    for (const r of rows) {
      totalVisits += r.stats?.visits || 0;
      totalSpend += r.stats?.totalSpend || 0;
      if (r.stats?.nextUpcoming) withUpcoming += 1;
    }
    return { total: rows.length, totalVisits, totalSpend, withUpcoming };
  }, [rows]);

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (rows === null) return <div className="py-8 flex justify-center"><Spinner /></div>;

  return (
    <div className="space-y-4">
      {/* Summary stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryStat label="Customers" value={summary.total} />
        <SummaryStat label="Lifetime visits" value={summary.totalVisits} />
        <SummaryStat label="Lifetime spend" value={formatSummaryMoney(summary.totalSpend)} />
        <SummaryStat label="Booked next" value={summary.withUpcoming} tint="emerald" />
      </div>

      {/* Search + segment filter */}
      {rows.length > 0 && (
        <div className="space-y-3">
          <div className="relative">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or phone…"
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-white border border-gray-200 rounded-xl focus:outline-none focus:border-gray-400"
            />
          </div>
          {/* Segment filter chips */}
          <div className="flex flex-wrap gap-1.5">
            <SegmentChip label="All" count={segmentCounts.ALL} active={segmentFilter === 'ALL'} onClick={() => setSegmentFilter('ALL')} />
            {['NEW', 'RETURNING', 'LOYAL', 'VIP', 'DORMANT'].map((s) => (
              segmentCounts[s] > 0 && (
                <SegmentChip key={s} label={SEGMENT_META[s].label} count={segmentCounts[s]}
                  active={segmentFilter === s} onClick={() => setSegmentFilter(s)} cls={SEGMENT_META[s].cls} />
              )
            ))}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="border border-dashed border-gray-200 rounded-xl py-10 text-center text-sm text-gray-500">
          No customers yet. Customers appear here once they book an appointment.
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-gray-500">No customers match that search.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 text-left">
              <tr>
                <th className="px-4 py-3 font-semibold text-gray-700">Customer</th>
                <th className="px-4 py-3 font-semibold text-gray-700 hidden sm:table-cell">Visits</th>
                <th className="px-4 py-3 font-semibold text-gray-700 hidden sm:table-cell">Spend</th>
                <th className="px-4 py-3 font-semibold text-gray-700 hidden md:table-cell">No-shows</th>
                <th className="px-4 py-3 font-semibold text-gray-700 hidden lg:table-cell">Last visit</th>
                <th className="px-4 py-3 font-semibold text-gray-700">Next</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const s = c.stats || {};
                return (
                  <tr key={c.id} className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer" onClick={() => setHistoryCustomerId(c.id)}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-gray-900">{c.name || 'Customer'}</p>
                        {c._segment && SEGMENT_META[c._segment] && (
                          <span className={`text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border ${SEGMENT_META[c._segment].cls}`}>
                            {SEGMENT_META[c._segment].label}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-xs text-gray-500 mt-0.5">
                        {c.email && <span className="truncate">{c.email}</span>}
                        {c.phone && <span>{c.phone}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-semibold text-gray-900 hidden sm:table-cell">{s.visits || 0}</td>
                    <td className="px-4 py-3 text-gray-800 hidden sm:table-cell">{s.totalSpend ? formatSummaryMoney(s.totalSpend) : '—'}</td>
                    <td className={`px-4 py-3 hidden md:table-cell ${s.noShows > 0 ? 'text-rose-700 font-semibold' : 'text-gray-500'}`}>{s.noShows || 0}</td>
                    <td className="px-4 py-3 text-gray-600 text-xs hidden lg:table-cell">{s.lastVisit ? new Date(s.lastVisit).toISOString().slice(0, 10) : '—'}</td>
                    <td className="px-4 py-3 text-xs">
                      {s.nextUpcoming ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium">
                          {new Date(s.nextUpcoming.date).toISOString().slice(5, 10)} · {s.nextUpcoming.startTime}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {historyCustomerId && (
        <InlineHistoryDrawer customerId={historyCustomerId} onClose={() => setHistoryCustomerId(null)} />
      )}
    </div>
  );
}

function InlineHistoryDrawer({ customerId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await api(`/api/business/customers/${customerId}/history`);
        if (!cancelled) setData(body);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load customer history');
      }
    })();
    return () => { cancelled = true; };
  }, [customerId]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div className="bg-white w-full max-w-md h-full overflow-y-auto shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-start justify-between">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-gray-900 truncate">{data?.customer?.name || 'Customer'}</h3>
            {data?.customer?.email && <p className="text-xs text-gray-500 truncate">{data.customer.email}</p>}
            {data?.customer?.phone && <p className="text-xs text-gray-500">{data.customer.phone}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none" aria-label="Close">×</button>
        </div>
        {!data && !error && <div className="py-10 flex justify-center"><Spinner /></div>}
        {error && <p className="p-5 text-sm text-red-600">{error}</p>}
        {data && (
          <>
            <div className="grid grid-cols-4 gap-2 p-5 border-b border-gray-100">
              <StatMini label="Visits"   value={data.stats.totalVisits} />
              <StatMini label="Spent"    value={formatSummaryMoney(data.stats.totalSpend)} />
              <StatMini label="Avg"      value={formatSummaryMoney(data.stats.avgSpend)} />
              <StatMini label="No-shows" value={data.stats.noShows} tone={data.stats.noShows > 0 ? 'rose' : 'gray'} />
            </div>
            <div className="p-5">
              <p className="text-xs uppercase tracking-wider font-semibold text-gray-500 mb-3">Last 30 appointments</p>
              {data.appointments.length === 0 ? (
                <p className="text-sm text-gray-500">No appointments on record.</p>
              ) : (
                <ul className="space-y-2">
                  {data.appointments.map((a) => (
                    <li key={a.id} className="border border-gray-100 rounded-lg px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-gray-900 truncate">{a.service?.name || 'Appointment'}</p>
                          <p className="text-xs text-gray-500">
                            {new Date(a.date).toISOString().slice(0, 10)} · {a.startTime}–{a.endTime} · with {a.staff?.name || '—'}
                          </p>
                        </div>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap bg-gray-100 text-gray-700 border-gray-200">
                          {a.status}
                        </span>
                      </div>
                      {a.notes && <p className="text-xs text-gray-600 italic mt-1">&ldquo;{a.notes}&rdquo;</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SegmentChip({ label, count, active, onClick, cls }) {
  return (
    <button type="button" onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
        active
          ? cls || 'bg-gray-900 text-white border-gray-900'
          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
      }`}>
      {label}
      <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${active ? 'bg-white/20' : 'bg-gray-100 text-gray-500'}`}>
        {count}
      </span>
    </button>
  );
}

function SummaryStat({ label, value, tint }) {
  const tints = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    rose: 'bg-rose-50 text-rose-700 border-rose-200',
  };
  const cls = tints[tint] || 'bg-white text-gray-900 border-gray-200';
  return (
    <div className={`border rounded-xl px-3 py-2 ${cls}`}>
      <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-500">{label}</p>
      <p className="text-lg font-bold mt-0.5">{value}</p>
    </div>
  );
}

function StatMini({ label, value, tone = 'gray' }) {
  const tones = { gray: 'text-gray-900', rose: 'text-rose-700' };
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider font-semibold text-gray-500">{label}</p>
      <p className={`text-base font-semibold mt-0.5 ${tones[tone] || tones.gray}`}>{value}</p>
    </div>
  );
}

function formatSummaryMoney(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num) || num === 0) return '—';
  return `₹${num.toLocaleString('en-IN')}`;
}


export default CustomersTab;
