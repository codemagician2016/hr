'use client';

// ECOMMERCE PaymentsPanel — payments table + seller payment-gateway setup.
//
// Onboarding model by region:
//   • India  → Razorpay BYO: the tenant connects their OWN Razorpay account
//     (Key ID + Key Secret + Webhook Secret). RBI rules mean a platform can't
//     route buyer funds on a merchant's behalf without a PA licence, so each
//     India tenant brings their own account (Shopify-India model). We also
//     surface the owner's Razorpay referral link so the tenant signs up under it.
//   • Rest of world → Stripe Connect (Stripe-hosted KYC).

import { useState, useEffect, useCallback } from 'react';
import { useEcommerceLocation } from '@/components/EcommerceLocationSwitcher';
import { useTenant } from '@/components/TenantProvider';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issueMessage = Array.isArray(body.issues)
      ? body.issues
        .map((issue) => {
          const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
          return [path, issue.message].filter(Boolean).join(': ');
        })
        .filter(Boolean)
        .join('; ')
      : '';
    const message = body.message && body.message !== 'Invalid'
      ? body.message
      : issueMessage || `${res.status}`;
    throw new Error(message);
  }
  return body;
}

const STATUS_TONES = {
  PAID: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PENDING: 'bg-amber-50 text-amber-700 border-amber-200',
  FAILED: 'bg-red-50 text-red-700 border-red-200',
  REFUNDED: 'bg-gray-100 text-gray-700 border-gray-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border-gray-200',
  PACKING: 'bg-blue-50 text-blue-700 border-blue-200',
  OUT_FOR_DELIVERY: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  READY_FOR_PICKUP: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DELIVERED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PICKED_UP: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

function fmt(minor, currency) {
  if (minor === null || minor === undefined) return '—';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: currency || 'GBP', maximumFractionDigits: 0,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)}`;
  }
}

export default function PaymentsPanel() {
  const { active: activeLocation } = useEcommerceLocation();
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (providerFilter !== 'all') params.set('paymentProvider', providerFilter);
      if (search.trim()) params.set('search', search.trim());
      if (activeLocation && activeLocation !== 'ALL') params.set('locationId', activeLocation);
      params.set('pageSize', '100');
      const [list, sum] = await Promise.all([
        api(`/api/ecom/payments?${params.toString()}`),
        api(`/api/ecom/payments/summary?${params.toString()}`),
      ]);
      setRows(list.rows || []);
      setSummary(sum);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeLocation, statusFilter, providerFilter, search]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="text-xl font-semibold text-gray-900">Payments</h2>
        <p className="text-sm text-gray-500 mt-1">
          {summary
            ? `${summary.paidTodayCount} paid today (${fmt(summary.paidTodayAmountMinor)}) · ${summary.pendingCount} pending`
            : 'Loading…'}
        </p>
      </div>

      <PaymentAccountsCard />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Paid today" value={summary ? fmt(summary.paidTodayAmountMinor) : null} hint={`${summary?.paidTodayCount || 0} orders`} />
        <KpiCard label="Paid 30d" value={summary ? fmt(summary.paid30dAmountMinor) : null} hint={`${summary?.paid30dCount || 0} orders`} />
        <KpiCard label="Pending" value={summary ? fmt(summary.pendingAmountMinor) : null} hint={`${summary?.pendingCount || 0} orders`} tone={summary?.pendingCount > 0 ? 'warning' : null} />
        <KpiCard label="Refunded 30d" value={summary ? fmt(summary.refunded30dAmountMinor) : null} hint={`${summary?.refunded30dCount || 0} orders`} />
      </div>

      {summary?.byProvider?.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <p className="text-xs font-mono uppercase tracking-wider text-gray-500 mb-3">By gateway · 30d</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {summary.byProvider.map((p) => (
              <div key={p.provider} className="border border-gray-200 rounded-lg p-3">
                <p className="text-xs font-mono text-gray-500">{p.provider}</p>
                <p className="text-lg font-bold text-gray-900 mt-1">{fmt(p.amountMinor)}</p>
                <p className="text-xs text-gray-500">{p.count} orders</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap items-center gap-2">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer or payment ref…"
          className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-gray-300 text-sm" />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm">
          <option value="all">All statuses</option>
          <option>PENDING</option><option>PAID</option><option>PACKING</option>
          <option>OUT_FOR_DELIVERY</option><option>DELIVERED</option>
          <option>CANCELLED</option><option>REFUNDED</option><option>FAILED</option>
        </select>
        <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)}
          className="px-3 py-2 rounded-lg border border-gray-300 text-sm">
          <option value="all">All gateways</option>
          <option>STRIPE</option><option>RAZORPAY</option><option>PADDLE</option><option>MANUAL</option>
        </select>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">{error}</div>}

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {loading && rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-semibold text-gray-900">No payments matching filters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-[10px] font-mono tracking-[0.18em] uppercase text-gray-500">
                  <th className="px-4 py-3">Order</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3">Gateway</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Placed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs">{r.id.slice(0, 8).toUpperCase()}</td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-900">{r.customerName}</p>
                      <p className="text-xs text-gray-500 font-mono">{r.customerEmail}</p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold">{fmt(r.totalMinor, r.currency)}</td>
                    <td className="px-4 py-3">
                      <p className="text-xs font-mono text-gray-700">{r.paymentProvider || '—'}</p>
                      {r.paymentRef && <p className="text-[10px] text-gray-400 font-mono truncate max-w-[120px]">{r.paymentRef}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-mono tracking-wider border ${STATUS_TONES[r.status] || STATUS_TONES.PENDING}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{new Date(r.placedAt).toLocaleDateString('en-GB')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({ label, value, hint, tone }) {
  const cls = tone === 'warning' ? 'text-amber-700' : 'text-gray-900';
  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-5">
      <p className="text-[11px] font-mono tracking-[0.18em] uppercase text-gray-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${cls}`}>{value === null || value === undefined ? '—' : value}</p>
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// PaymentAccountsCard — seller payment-gateway onboarding.
//   India  → Razorpay BYO (tenant's own account/keys) + referral link.
//   Global → Stripe Connect (hosted).

function PaymentAccountsCard() {
  const { tenant } = useTenant();
  const business = tenant?.business || {};
  const [accounts, setAccounts] = useState([]);
  const [route, setRoute] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [showRzpForm, setShowRzpForm] = useState(false);
  const [rzpForm, setRzpForm] = useState({ keyId: '', keySecret: '', webhookSecret: '' });
  const [showStripeForm, setShowStripeForm] = useState(false);
  const [stripeForm, setStripeForm] = useState({ publishableKey: '', secretKey: '', webhookSecret: '' });

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await api('/api/payments/accounts');
      setAccounts(data.accounts || []);
      setRoute(data.route || null);
      setReadiness(data.readiness || null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (route?.provider !== 'RAZORPAY') setShowRzpForm(false);
  }, [route?.provider]);

  const patchRzpForm = (key, value) => {
    setNotice(''); setError('');
    setRzpForm((current) => ({ ...current, [key]: value }));
  };

  async function connectRazorpay(e) {
    e.preventDefault();
    if (!rzpForm.keyId.trim() || !rzpForm.keySecret.trim()) {
      setError('Enter your Razorpay Key ID and Key Secret.');
      return;
    }
    setBusy('rzp'); setError(''); setNotice('');
    try {
      const result = await api('/api/payments/razorpay/connect-keys', {
        method: 'POST',
        body: JSON.stringify({
          keyId: rzpForm.keyId.trim(),
          keySecret: rzpForm.keySecret.trim(),
          ...(rzpForm.webhookSecret.trim() ? { webhookSecret: rzpForm.webhookSecret.trim() } : {}),
        }),
      });
      setShowRzpForm(false);
      setRzpForm({ keyId: '', keySecret: '', webhookSecret: '' });
      setNotice(result?.webhookConfigured
        ? 'Razorpay connected. Buyers now pay into your own Razorpay account.'
        : 'Razorpay connected. Add a webhook in your Razorpay dashboard (below) so payments confirm reliably.');
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const patchStripeForm = (key, value) => {
    setNotice(''); setError('');
    setStripeForm((current) => ({ ...current, [key]: value }));
  };

  async function connectStripe(e) {
    e.preventDefault();
    if (!stripeForm.publishableKey.trim() || !stripeForm.secretKey.trim() || !stripeForm.webhookSecret.trim()) {
      setError('Enter your Stripe publishable key, secret key, and webhook signing secret (required to confirm payments).');
      return;
    }
    setBusy('stripe-byo'); setError(''); setNotice('');
    try {
      const result = await api('/api/payments/stripe/connect-keys', {
        method: 'POST',
        body: JSON.stringify({
          publishableKey: stripeForm.publishableKey.trim(),
          secretKey: stripeForm.secretKey.trim(),
          ...(stripeForm.webhookSecret.trim() ? { webhookSecret: stripeForm.webhookSecret.trim() } : {}),
        }),
      });
      setShowStripeForm(false);
      setStripeForm({ publishableKey: '', secretKey: '', webhookSecret: '' });
      setNotice(result?.webhookConfigured
        ? 'Stripe connected. Buyers now pay into your own Stripe account.'
        : 'Stripe connected. Add a webhook in your Stripe dashboard (below) so payments confirm reliably.');
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function checkRazorpayStatus() {
    setBusy('rzp-status'); setError(''); setNotice('');
    try {
      const result = await api('/api/payments/razorpay/onboarding-status');
      setNotice(result?.connected
        ? `Razorpay status: ${result.status || 'PENDING'}${result.mode ? ` · ${result.mode} mode` : ''}${result.webhookConfigured ? ' · webhook set' : ' · webhook not set'}`
        : 'Razorpay is not connected yet. Connect your Razorpay account to accept online payments.');
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function startStripeOnboarding() {
    setBusy('stripe'); setError('');
    try {
      const data = await api('/api/payments/stripe/onboarding-link', { method: 'POST' });
      if (data?.url) {
        window.location.href = data.url; // off to Stripe-hosted onboarding
      } else {
        throw new Error('No onboarding link returned');
      }
    } catch (err) {
      setError(err.message);
      setBusy('');
    }
  }

  async function checkStripeStatus() {
    setBusy('stripe-status'); setError(''); setNotice('');
    try {
      const result = await api('/api/payments/stripe/onboarding-status');
      setNotice(result?.connected
        ? `Stripe status: ${result.status || 'PENDING'}`
        : 'Stripe Connect is not connected yet. Start onboarding to create the connected account.');
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function disconnect(id, provider) {
    if (!window.confirm(`Disconnect ${provider}? Buyers will not be able to pay until reconnected.`)) return;
    setBusy(`del-${id}`); setError('');
    try {
      await api(`/api/payments/accounts/${id}`, { method: 'DELETE' });
      await reload();
    } finally {
      setBusy('');
    }
  }

  const rzp = accounts.find((a) => a.provider === 'RAZORPAY');
  const stripeAcc = accounts.find((a) => a.provider === 'STRIPE');
  const requiredProvider = readiness?.provider || route?.provider || (String(business.country || '').toUpperCase() === 'IN' ? 'RAZORPAY' : 'STRIPE');
  const requiresRazorpay = requiredProvider === 'RAZORPAY';
  const requiresStripe = requiredProvider === 'STRIPE';
  const referralUrl = route?.razorpayReferralUrl || null;
  const webhookUrl = route?.razorpayWebhookUrl || '';
  // Integrated (Stripe Connect) is only offered where the owner's policy allows
  // it; otherwise this is a BYO-only country and we show just the BYO path.
  const integratedAllowed = route?.integratedAllowed !== false;
  const stripeWebhookUrl = route?.stripeWebhookUrl || `${(typeof window !== 'undefined' ? window.location.origin.replace('app.', 'api.') : 'https://api.sitepresso.com')}/api/payments/stripe/webhook`;

  const routeCopy = requiresRazorpay
    ? {
      title: 'India checkout uses your own Razorpay account',
      body: 'In India, buyers pay directly into your own Razorpay account — Razorpay handles your KYC and settles to your bank. Sitepresso never holds your money. Connect your account below.',
    }
    : {
      title: 'Global checkout uses Stripe Connect',
      body: 'Buyer payments for this store country go through Stripe Connect. Stripe handles identity and payouts.',
    };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Payment gateway setup</h3>
          <p className="text-sm text-gray-500 mt-1">
            Finish the required gateway before turning on online checkout. Until then the storefront stays cash-only so buyers never enter a broken payment flow.
          </p>
        </div>
        <a
          href="/dashboard?tab=store-setup"
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
        >
          Store setup
        </a>
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-gray-900">{routeCopy.title}</p>
            <p className="text-xs text-gray-500 mt-0.5">{routeCopy.body}</p>
          </div>
          <span className="inline-flex rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[10px] font-mono font-semibold tracking-wider text-gray-600">
            {route?.country || business.country || 'NO COUNTRY'} · {route?.providerLabel || requiredProvider}
          </span>
        </div>
        {route?.countryRequired && (
          <p className="mt-2 text-xs font-semibold text-amber-700">
            Set your store country in setup before connecting online payments.
          </p>
        )}
        {route?.expectedCurrency && route.currency && route.currency !== route.expectedCurrency && (
          <p className="mt-2 text-xs font-semibold text-amber-700">
            {route.providerLabel} requires {route.expectedCurrency}. Current store currency is {route.currency}.
          </p>
        )}
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-700">{notice}</div>}

      <ReadinessPanel readiness={readiness} loading={loading} />

      {loading ? (
        <div className="text-sm text-gray-400">Loading accounts…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Razorpay (India) — BYO */}
          <ProviderRow
            title="Razorpay (India)"
            sub="Connect your own Razorpay account. Razorpay collects your KYC; Sitepresso stores only encrypted API keys and is never in the money flow."
            account={rzp}
            statusOf={rzp?.status}
            activeRoute={requiresRazorpay}
            actions={
              rzp ? (
                <div className="flex flex-col items-end gap-1">
                  <button type="button" onClick={() => setShowRzpForm((v) => !v)}
                    disabled={!requiresRazorpay}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                    {showRzpForm ? 'Close' : 'Update keys'}
                  </button>
                  <button type="button" onClick={checkRazorpayStatus}
                    disabled={busy === 'rzp-status'}
                    className="text-xs font-semibold text-indigo-700 underline disabled:opacity-50">
                    {busy === 'rzp-status' ? 'Checking…' : 'Check status'}
                  </button>
                  <button type="button" onClick={() => disconnect(rzp.id, 'RAZORPAY')}
                    disabled={busy === `del-${rzp.id}`}
                    className="text-xs text-red-700 underline disabled:opacity-50">
                    {busy === `del-${rzp.id}` ? 'Removing…' : 'Disconnect'}
                  </button>
                </div>
              ) : (
                requiresRazorpay ? (
                  <button type="button" onClick={() => setShowRzpForm((v) => !v)}
                    disabled={route?.countryRequired}
                    className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                    {showRzpForm ? 'Cancel' : 'Connect Razorpay'}
                  </button>
                ) : (
                  <span className="text-xs font-semibold text-gray-400">Not used here</span>
                )
              )
            }
          />

          {/* Stripe (global) — BYO (your own account) and, where the owner allows
              it, integrated Stripe Connect. */}
          <ProviderRow
            title="Stripe (global)"
            sub={integratedAllowed
              ? 'Use your OWN Stripe account (recommended — you keep 100%, you’re the merchant), or onboard via Stripe Connect.'
              : 'Connect your OWN Stripe account — buyers pay you directly and you keep 100%.'}
            account={stripeAcc}
            statusOf={stripeAcc?.status}
            activeRoute={requiresStripe}
            actions={
              stripeAcc ? (
                <div className="flex flex-col items-end gap-1">
                  {stripeAcc.status !== 'ACTIVE' && integratedAllowed && (
                    <>
                      <button type="button" onClick={startStripeOnboarding}
                        disabled={busy === 'stripe'}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                        {busy === 'stripe' ? 'Redirecting…' : 'Continue onboarding'}
                      </button>
                      <button type="button" onClick={checkStripeStatus}
                        disabled={busy === 'stripe-status'}
                        className="text-xs font-semibold text-indigo-700 underline disabled:opacity-50">
                        {busy === 'stripe-status' ? 'Checking…' : 'Check status'}
                      </button>
                    </>
                  )}
                  <button type="button" onClick={() => disconnect(stripeAcc.id, 'STRIPE')}
                    disabled={busy === `del-${stripeAcc.id}`}
                    className="text-xs text-red-700 underline disabled:opacity-50">
                    {busy === `del-${stripeAcc.id}` ? 'Removing…' : 'Disconnect'}
                  </button>
                </div>
              ) : (
                requiresStripe ? (
                  <div className="flex flex-col items-end gap-1">
                    <button type="button" onClick={() => { setShowStripeForm((v) => !v); setShowRzpForm(false); }}
                      disabled={route?.countryRequired}
                      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                      {showStripeForm ? 'Cancel' : 'Connect your Stripe account'}
                    </button>
                    {integratedAllowed && (
                      <button type="button" onClick={startStripeOnboarding}
                        disabled={busy === 'stripe' || route?.countryRequired}
                        className="text-xs font-semibold text-indigo-700 underline disabled:opacity-50">
                        {busy === 'stripe' ? 'Redirecting…' : 'or onboard via Stripe Connect'}
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="text-xs font-semibold text-gray-400">Not used here</span>
                )
              )
            }
          />
        </div>
      )}

      {showRzpForm && requiresRazorpay && (
        <form onSubmit={connectRazorpay} noValidate className="border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-4">
          {/* Step 1 — create the account via the referral link */}
          <div className="rounded-lg bg-indigo-50 border border-indigo-200 p-3 text-xs text-indigo-900 leading-relaxed">
            <p className="font-semibold">Step 1 — Have a Razorpay account?</p>
            <p className="mt-1">
              If not, create one (it takes a few minutes — Razorpay verifies your business directly).
            </p>
            {referralUrl && (
              <a href={referralUrl} target="_blank" rel="noopener noreferrer"
                className="mt-2 inline-flex items-center justify-center rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700">
                Create your Razorpay account →
              </a>
            )}
          </div>

          {/* Step 2 — add a webhook on their Razorpay account */}
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-[11px] text-amber-900 leading-relaxed">
            <p className="font-semibold">Step 2 — Add a webhook in your Razorpay dashboard</p>
            <p className="mt-1">Account &amp; Settings → Webhooks → Add New Webhook:</p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5">
              <li>URL: <span className="font-mono break-all">{webhookUrl || 'https://api.<your-domain>/api/payments/razorpay/webhook'}</span></li>
              <li>Active event: <span className="font-mono">payment.captured</span></li>
              <li>Set a Secret of your choice, then paste the same secret below.</li>
            </ul>
          </div>

          {/* Step 3 — paste keys */}
          <div className="space-y-3">
            <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-gray-500">Step 3 — Paste your Razorpay keys</p>
            <div className="grid gap-3 md:grid-cols-2">
              <RzpField label="Key ID" value={rzpForm.keyId} onChange={(v) => patchRzpForm('keyId', v)} required autoComplete="off" placeholder="rzp_live_… or rzp_test_…" />
              <RzpField label="Key Secret" value={rzpForm.keySecret} onChange={(v) => patchRzpForm('keySecret', v)} required autoComplete="off" type="password" />
              <RzpField label="Webhook Secret" value={rzpForm.webhookSecret} onChange={(v) => patchRzpForm('webhookSecret', v)} autoComplete="off" type="password" />
            </div>
          </div>

          <p className="text-[11px] text-gray-500">
            Sitepresso stores these keys encrypted at rest and uses them only to create your buyers' orders on your own account. We never see your KYC details.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShowRzpForm(false)}
              className="px-3 py-1.5 text-xs text-gray-700">Cancel</button>
            <button type="submit" disabled={busy === 'rzp'}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white disabled:opacity-50">
              {busy === 'rzp' ? 'Connecting…' : rzp ? 'Update Razorpay keys' : 'Connect Razorpay'}
            </button>
          </div>
        </form>
      )}

      {showStripeForm && requiresStripe && (
        <form onSubmit={connectStripe} noValidate className="border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-4">
          <div className="rounded-lg bg-indigo-50 border border-indigo-200 p-3 text-xs text-indigo-900 leading-relaxed">
            <p className="font-semibold">Step 1 — Have a Stripe account?</p>
            <p className="mt-1">If not, create one at <a href="https://dashboard.stripe.com/register" target="_blank" rel="noopener noreferrer" className="font-semibold underline">stripe.com</a>. Buyers pay directly into your account — you keep 100% and you&apos;re the merchant of record.</p>
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-[11px] text-amber-900 leading-relaxed">
            <p className="font-semibold">Step 2 — Add a webhook in your Stripe dashboard</p>
            <p className="mt-1">Developers → Webhooks → Add endpoint:</p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5">
              <li>URL: <span className="font-mono break-all">{stripeWebhookUrl}</span></li>
              <li>Event: <span className="font-mono">payment_intent.succeeded</span></li>
              <li>Copy the Signing secret (whsec_…) and paste it below.</li>
            </ul>
          </div>
          <div className="space-y-3">
            <p className="text-[11px] font-mono uppercase tracking-[0.18em] text-gray-500">Step 3 — Paste your Stripe keys</p>
            <div className="grid gap-3 md:grid-cols-2">
              <RzpField label="Publishable key" value={stripeForm.publishableKey} onChange={(v) => patchStripeForm('publishableKey', v)} required autoComplete="off" placeholder="pk_live_… or pk_test_…" />
              <RzpField label="Secret key" value={stripeForm.secretKey} onChange={(v) => patchStripeForm('secretKey', v)} required autoComplete="off" type="password" placeholder="sk_live_… or sk_test_…" />
              <RzpField label="Webhook signing secret" value={stripeForm.webhookSecret} onChange={(v) => patchStripeForm('webhookSecret', v)} required autoComplete="off" type="password" placeholder="whsec_…" />
            </div>
          </div>
          <p className="text-[11px] text-gray-500">
            Sitepresso stores these keys encrypted at rest and uses them only to create your buyers&apos; payments on your own Stripe account. We never see your KYC details.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setShowStripeForm(false)} className="px-3 py-1.5 text-xs text-gray-700">Cancel</button>
            <button type="submit" disabled={busy === 'stripe-byo'}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white disabled:opacity-50">
              {busy === 'stripe-byo' ? 'Connecting…' : stripeAcc ? 'Update Stripe keys' : 'Connect Stripe'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ReadinessPanel({ readiness, loading }) {
  if (loading && !readiness) {
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">
        Checking online payment readiness…
      </div>
    );
  }
  if (!readiness) return null;
  const ready = !!readiness.canAcceptOnline;
  const tone = ready
    ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
    : readiness.setupState === 'PENDING'
      ? 'border-amber-200 bg-amber-50 text-amber-950'
      : 'border-indigo-200 bg-indigo-50 text-indigo-950';
  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold">{readiness.headline}</p>
          <p className="mt-1 text-xs opacity-80">{readiness.message}</p>
          <p className="mt-2 text-[11px] font-mono uppercase tracking-wider opacity-70">
            {readiness.country || 'country required'} · {readiness.currency || 'currency required'} · {readiness.modelLabel}
          </p>
        </div>
        {ready ? (
          <a
            href="/dashboard?tab=store-setup"
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
          >
            Turn on online payments
          </a>
        ) : (
          <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/70 px-3 py-1 text-[10px] font-mono font-semibold tracking-wider">
            {readiness.providerLabel} required
          </span>
        )}
      </div>
      {Array.isArray(readiness.steps) && readiness.steps.length > 0 && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-2">
          {readiness.steps.map((step) => (
            <div key={step.key} className="rounded-lg border border-white/70 bg-white/70 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold text-gray-900">{step.label}</p>
                <StatusDot status={step.status} />
              </div>
              <p className="mt-1 text-[10px] leading-snug text-gray-600">{step.detail}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }) {
  const cls = status === 'DONE'
    ? 'bg-emerald-600'
    : status === 'BLOCKED'
      ? 'bg-red-500'
      : 'bg-amber-500';
  return <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${cls}`} title={status} />;
}

function RzpField({ label, value, onChange, type = 'text', required = false, autoComplete, placeholder }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-700 mb-1">{label}{required && ' *'}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="w-full rounded-lg border px-3 py-2 text-sm border-gray-300 bg-white"
        required={required}
      />
    </label>
  );
}

function ProviderRow({ title, sub, account, statusOf, actions, activeRoute = false }) {
  const tone =
    statusOf === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
    statusOf === 'PENDING' ? 'bg-amber-50 text-amber-700 border-amber-200' :
    'bg-gray-100 text-gray-500 border-gray-200';
  return (
    <div className={`border rounded-lg p-4 flex flex-col gap-3 ${activeRoute ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200 bg-white'}`}>
      <div>
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-gray-900">{title}</p>
          {activeRoute && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-700">
              ACTIVE ROUTE
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-0.5">{sub}</p>
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto">
        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-mono tracking-wider border ${tone}`}>
          {account ? statusOf || 'CONNECTED' : 'NOT CONNECTED'}
        </span>
        {actions}
      </div>
      {account?.accountId && (
        <p className="text-[10px] font-mono text-gray-400 truncate">ID: {account.accountId}</p>
      )}
      {account?.metadata?.mode && (
        <p className="text-[10px] text-gray-500">Mode: {account.metadata.mode}</p>
      )}
    </div>
  );
}
