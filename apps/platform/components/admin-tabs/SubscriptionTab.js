'use client';

// Billing & Plan workspace.
// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// page split. Includes PlanChangeModal as a co-located dependency.
//
// Vertical-isolation rule: this tab is shared shell UI (every tenant has
// a subscription regardless of vertical), so admin-ui + admin-pickers
// imports are allowed.

import { useEffect, useState } from 'react';
import { useTenant } from '@/components/TenantProvider';
import { api } from '@/lib/adminApi';
import {
  Spinner, ErrorBanner, formatMoneyMinor, formatAdminDate, formatAdminDateTime,
  billingStatusClass, billingTransactionStatusClass,
} from '@/components/admin-ui';
import { CouponRedeemCard } from './SettingsTab';
import { resolveVertical } from '@/lib/vertical';
import { COUNTRIES } from '@/lib/countries';
import PricingPlanCards from '@/components/PricingPlanCards';
import { openRazorpaySubscriptionCheckout } from '@/lib/razorpayCheckout';
import CountryAddressFields from '@/components/CountryAddressFields';

function SubscriptionTab({ refreshTenant }) {
  const { tenant } = useTenant();
  const [subscription, setSubscription] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [pricing, setPricing] = useState(null); // PricingTier catalogue + regional prices
  const [billingCycle, setBillingCycle] = useState('MONTHLY');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [changeTarget, setChangeTarget] = useState(null);
  const [billing, setBilling] = useState({
    configured: false,
    overview: null,
    actions: { canOpenPortal: false },
    transactions: [],
    pagination: { nextAfter: null },
  });
  const [billingError, setBillingError] = useState('');
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingMoreLoading, setBillingMoreLoading] = useState(false);
  const [billingAction, setBillingAction] = useState('');
  const [billingProfile, setBillingProfile] = useState(null);
  const [planAction, setPlanAction] = useState(''); // 'cancel' | 'resume'
  const [cancelOpen, setCancelOpen] = useState(false);
  const [notice, setNotice] = useState(null); // { tone: 'success'|'info', text }

  async function refreshBilling({ after = null, append = false } = {}) {
    if (append) setBillingMoreLoading(true);
    else setBillingLoading(true);
    if (!append) setBillingError('');

    try {
      const query = after ? `?after=${encodeURIComponent(after)}` : '';
      const data = await api(`/api/subscription/billing${query}`);
      setBilling((prev) => {
        if (!append) return data;
        const seen = new Set((prev?.transactions || []).map((txn) => txn.id));
        const merged = [
          ...(prev?.transactions || []),
          ...(data.transactions || []).filter((txn) => !seen.has(txn.id)),
        ];
        return { ...data, transactions: merged };
      });
    } catch (err) {
      setBillingError(err.message || 'Could not load billing details.');
    } finally {
      if (append) setBillingMoreLoading(false);
      else setBillingLoading(false);
    }
  }

  async function openBillingPortal() {
    setBillingAction('portal');
    setBillingError('');
    try {
      const res = await api('/api/subscription/billing/portal', { method: 'POST', body: '{}' });
      if (res?.url) window.location.href = res.url;
    } catch (err) {
      setBillingError(err.message || 'Could not open the billing portal.');
    } finally {
      setBillingAction('');
    }
  }

  async function openBillingInvoice(transactionId) {
    setBillingAction(transactionId);
    setBillingError('');
    const previewWindow = typeof window !== 'undefined'
      ? window.open('', '_blank', 'noopener,noreferrer')
      : null;
    try {
      const res = await api(`/api/subscription/billing/invoices/${transactionId}`, { method: 'POST', body: '{}' });
      if (res?.url) {
        if (previewWindow) previewWindow.location.href = res.url;
        else window.location.href = res.url;
      } else if (previewWindow) {
        previewWindow.close();
      }
    } catch (err) {
      if (previewWindow) previewWindow.close();
      setBillingError(err.message || 'Could not open the invoice PDF.');
    } finally {
      setBillingAction('');
    }
  }

  async function reconcileBilling() {
    setBillingAction('reconcile');
    setBillingError('');
    try {
      const result = await api('/api/subscription/reconcile', { method: 'POST', body: '{}' });
      if (result?.workspace) setWorkspace(result.workspace);
      await Promise.all([
        load(),
        refreshBilling(),
        refreshTenant ? refreshTenant() : Promise.resolve(),
      ]);
    } catch (err) {
      setBillingError(err?.data?.message || err.message || 'Could not reconcile billing.');
    } finally {
      setBillingAction('');
    }
  }

  // Cancel the paid plan — schedules cancellation at the end of the current
  // billing period (keeps access until then; the customer can Resume any time
  // before it lapses). The confirm modal calls this.
  async function cancelPlan() {
    setPlanAction('cancel'); setBillingError(''); setNotice(null);
    try {
      await api('/api/subscription/cancel', { method: 'POST', body: '{}' });
      setCancelOpen(false);
      await Promise.all([load(), refreshBilling(), refreshTenant ? refreshTenant() : Promise.resolve()]);
      setNotice({ tone: 'info', text: 'Your plan will cancel at the end of this billing period. You can resume any time before then.' });
    } catch (err) {
      setBillingError(err?.data?.message || err.message || 'Could not cancel the plan. Please try again or contact support.');
    } finally { setPlanAction(''); }
  }

  // Resume a scheduled cancellation so the plan keeps renewing.
  async function resumePlan() {
    setPlanAction('resume'); setBillingError(''); setNotice(null);
    try {
      await api('/api/subscription/resume', { method: 'POST', body: '{}' });
      await Promise.all([load(), refreshBilling(), refreshTenant ? refreshTenant() : Promise.resolve()]);
      setNotice({ tone: 'success', text: 'Your plan is active again — it will keep renewing.' });
    } catch (err) {
      setBillingError(err?.data?.message || err.message || 'Could not resume the plan. Please try again or contact support.');
    } finally { setPlanAction(''); }
  }

  async function load() {
    setLoading(true); setError('');
    try {
      // Essentials — DB-only + fast (no payment-gateway calls). Render on these.
      const [subRes, geoRes, billingProfileRes] = await Promise.all([
        api('/api/subscription'),
        fetch('/geo').then((r) => r.json()).catch(() => ({ country: null })),
        api('/api/subscription/billing-profile').catch(() => null),
      ]);
      setSubscription(subRes.subscription);
      if (subRes.subscription?.billingCycle) setBillingCycle(subRes.subscription.billingCycle);
      const fallbackBusiness = tenant?.business || {};
      setBillingProfile(billingProfileRes?.billingProfile || {
        purchaserType: fallbackBusiness.billingPurchaserType || 'INDIVIDUAL',
        businessName: fallbackBusiness.billingBusinessName || '',
        contactName: fallbackBusiness.billingContactName || '',
        email: fallbackBusiness.billingEmail || '',
        taxId: fallbackBusiness.billingTaxId || '',
        addressLine1: fallbackBusiness.billingAddressLine1 || '',
        addressLine2: fallbackBusiness.billingAddressLine2 || '',
        city: fallbackBusiness.billingCity || '',
        state: fallbackBusiness.billingState || '',
        postalCode: fallbackBusiness.billingPostalCode || '',
        country: fallbackBusiness.billingCountry || fallbackBusiness.country || '',
      });
      const params = new URLSearchParams();
      if (geoRes?.country) params.set('country', geoRes.country);
      const pricingRes = await api(`/api/public/pricing${params.toString() ? `?${params.toString()}` : ''}`).catch(() => null);
      if (pricingRes?.pricing) setPricing(pricingRes.pricing);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }

    // Secondary — payment history + workspace can call the payment gateway
    // (Paddle), so load them in the BACKGROUND and never block the page on them.
    // The render is null-safe for both (history shows a placeholder, plan cards
    // fall back to /public/pricing) until they arrive.
    api('/api/subscription/billing')
      .then((billingRes) => { if (billingRes) { setBilling(billingRes); setBillingError(''); } })
      .catch((err) => setBillingError(err.message || 'Could not load billing details.'));
    api('/api/subscription/workspace')
      .then((workspaceRes) => { if (workspaceRes?.workspace) setWorkspace(workspaceRes.workspace); })
      .catch(() => {});
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Resume an abandoned checkout: re-run the plan change for the drafted tier,
  // which mints a fresh Paddle checkout URL (the old DRAFT is harmless).
  async function resumeCheckout(plan) {
    if (!plan?.slug) return;
    setChangeTarget({ tier: plan, direction: 'upgrade', sourceTier: subscription?.tier });
  }

  // Paddle return — when the checkout launcher sends the user back here with
  // ?billing=success, actively poll Paddle for the latest state. Webhooks may
  // not be configured yet or may lag a few seconds; this guarantees the tier
  // flips visibly before the owner wonders what happened.
  const [billingBanner, setBillingBanner] = useState(null); // 'syncing' | 'synced' | 'pending'
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('billing') !== 'success') return;
    const returnTransactionId = params.get('_ptxn') || params.get('transaction_id') || '';
    // Pick the matching sync endpoint per gateway: Stripe (NZ) returns
    // ?session_id=cs_…; Paddle returns ?_ptxn=txn_…; Razorpay (IN) returns
    // ?gateway=razorpay (it syncs from the stored subscription id, no session).
    const stripeSessionId = params.get('session_id') || '';
    const isStripeReturn = Boolean(stripeSessionId);
    const isRazorpayReturn = params.get('gateway') === 'razorpay';

    setBillingBanner('syncing');
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 6; // ~18s at 3s intervals

    async function attempt() {
      if (cancelled) return;
      attempts += 1;
      try {
        const syncUrl = isRazorpayReturn
          ? '/api/subscription/sync-from-razorpay'
          : isStripeReturn ? '/api/subscription/sync-from-stripe' : '/api/subscription/sync-from-paddle';
        const body = isRazorpayReturn
          ? '{}'
          : isStripeReturn
            ? JSON.stringify({ sessionId: stripeSessionId })
            : (returnTransactionId ? JSON.stringify({ transactionId: returnTransactionId }) : '{}');
        const res = await api(syncUrl, { method: 'POST', body });
        if (res?.synced) {
          await load();
          await refreshTenant?.();
          if (!cancelled) setBillingBanner('synced');
          return;
        }
      } catch { /* fall through */ }
      if (attempts >= MAX_ATTEMPTS) {
        if (!cancelled) setBillingBanner('pending');
        return;
      }
      setTimeout(attempt, 3000);
    }
    attempt();

    // Clean the query string so a refresh doesn't re-trigger the sync loop.
    params.delete('billing');
    params.delete('_ptxn');
    params.delete('transaction_id');
    params.delete('session_id');
    params.delete('gateway');
    const clean = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (clean ? `?${clean}` : ''));

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="py-10 flex justify-center"><Spinner /></div>;
  if (!subscription) return <ErrorBanner message={error || 'No subscription found'} />;

  const latestSettledPayment = (billing.transactions || []).find((txn) => ['COMPLETED', 'BILLED'].includes(txn.status));
  const currentVertical = resolveVertical(tenant?.business?.vertical);
  const currentWindow = workspace?.catalog?.verticalWindows?.find((window) => window.current)
    || workspace?.catalog?.verticalWindows?.find((window) => window.key === currentVertical)
    || null;
  const couponTiers = currentWindow?.plans || workspace?.catalog?.variants || pricing?.tiers || [];

  // Incomplete checkouts (Paddle "draft"/"ready") are not real charges — keep
  // them out of payment history and surface the latest one as a single
  // actionable notice in the header instead of a confusing "Balance due" row.
  const allTransactions = billing.transactions || [];
  const visibleTransactions = allTransactions.filter((txn) => !isIncompleteCheckout(txn));
  const rawDraftCheckout = allTransactions.find(isIncompleteCheckout) || null;
  const draftCheckout = hasConfirmedPaddleSubscription({ subscription, workspace }) ? null : rawDraftCheckout;

  const planStatus = derivePlanStatus({ subscription, workspace, draftCheckout });
  const billingCycleLower = billingCycle === 'YEARLY' ? 'yearly' : 'monthly';

  // Same endpoint the public landing page uses, via the authed admin client.
  const pricingFetcher = (country, vertical) => {
    const params = new URLSearchParams();
    if (country) params.set('country', country);
    if (vertical) params.set('vertical', vertical);
    return api(`/api/public/pricing?${params.toString()}`)
      .then((res) => res?.pricing || null)
      .catch(() => null);
  };

  return (
    <div className="space-y-4">
      {billingBanner && (
        <div
          className={
            billingBanner === 'synced'
              ? 'rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 px-4 py-3 text-sm flex items-start gap-2'
              : billingBanner === 'pending'
                ? 'rounded-xl border border-amber-200 bg-amber-50 text-amber-900 px-4 py-3 text-sm flex items-start gap-2'
                : 'rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-900 px-4 py-3 text-sm flex items-start gap-2'
          }
        >
          {billingBanner === 'syncing' && <><span>⟳</span><span>Confirming your payment…</span></>}
          {billingBanner === 'synced'  && <><span>✓</span><span>Payment confirmed — your new plan is active.</span></>}
          {billingBanner === 'pending' && (
            <><span>!</span><span>
              We couldn&rsquo;t find your new subscription yet. If payment succeeded, it usually appears within a few minutes — try refreshing. If it still doesn&rsquo;t show, contact support.
            </span></>
          )}
        </div>
      )}
      {billingError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {billingError}
        </div>
      )}
      {notice && (
        <div className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
          notice.tone === 'success'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-indigo-200 bg-indigo-50 text-indigo-900'
        }`}>
          <span className="flex items-start gap-2">
            <span aria-hidden>{notice.tone === 'success' ? '✓' : 'ℹ'}</span>
            <span>{notice.text}</span>
          </span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 opacity-60 hover:opacity-100">×</button>
        </div>
      )}
      {billing?.promo && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <span aria-hidden>🎟️</span>
          <span>
            <strong>Promotion applied — {billing.promo.label}.</strong>{' '}
            {billing.lifetime
              ? 'No renewal or payment needed while this promotion is active.'
              : (billing.currentPeriodEnd
                  ? `Free until ${billing.currentPeriodEnd} — no payment needed until then.`
                  : 'No payment needed while this promotion is active.')}
            <span className="block text-xs text-emerald-700/80 mt-0.5">Coupon code: {billing.promo.code}</span>
          </span>
        </div>
      )}
      <PlanStatusHeader
        planStatus={planStatus}
        subscription={subscription}
        workspace={workspace}
        billing={billing}
        latestSettledPayment={latestSettledPayment}
        billingAction={billingAction}
        planAction={planAction}
        onOpenPortal={openBillingPortal}
        onResumeCheckout={resumeCheckout}
        onCheckPaymentStatus={reconcileBilling}
        reconciling={billingAction === 'reconcile'}
        onCancelPlan={() => setCancelOpen(true)}
        onResumePlan={resumePlan}
        onChoosePlan={() => {
          if (typeof document !== 'undefined') {
            document.getElementById('plan-picker')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }}
      />

      <div id="plan-picker" className="bg-white rounded-2xl border border-gray-200 p-6 scroll-mt-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{planStatus.isFree ? 'Choose your plan' : 'Change plan'}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Plans match this account&apos;s business type. Your current plan is marked below — upgrades apply immediately, downgrades at your next renewal.
            </p>
          </div>
        </div>

        {!billing?.configured && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Paid upgrades are paused while the payment gateway is not configured.
          </div>
        )}

        <PricingPlanCards
          className="mt-6"
          fetcher={pricingFetcher}
          initialVertical={currentVertical}
          showVerticalTabs={false}
          verticals={[currentVertical]}
          countryOverride={billingProfile?.country || tenant?.business?.country || undefined}
          billing={billingCycleLower}
          onBillingChange={(next) => setBillingCycle(next === 'yearly' ? 'YEARLY' : 'MONTHLY')}
          toolbarLabels={{ monthlyLabel: 'Monthly', yearlyLabel: 'Yearly', discountLabel: '−17%' }}
          renderSkeleton={(i) => <AdminPlanCardSkeleton key={i} />}
          renderCard={(plan, ctx) => (
            <AdminPlanCard
              key={`${ctx.vertical}-${plan.slug}`}
              plan={plan}
              ctx={ctx}
              currentVertical={currentVertical}
              currentSlug={subscription?.tier?.slug}
              currentBillingCycle={subscription?.billingCycle}
              currentRank={subscription?.tier?.sortOrder ?? 0}
              billingConfigured={billing?.configured}
              onPickPlan={(p, direction) => setChangeTarget({ tier: p, direction, sourceTier: subscription?.tier })}
            />
          )}
        />
      </div>

      {/* Coupon redemption — works without a payment method for FREE_PERIOD
          and LIFETIME_FREE codes. Discount codes require paid checkout. */}
      <CouponRedeemCard
        onRedeemed={() => load()}
        tiers={couponTiers}
        currentTierSlug={subscription?.tier?.slug}
      />

      <BillingProfileCard
        business={tenant?.business}
        subscription={subscription}
        value={billingProfile}
        onChange={setBillingProfile}
        onSaved={async () => {
          await refreshTenant?.();
          await load();
        }}
      />

      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Payment history</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Live billing history, including renewals, upgrades, and payment issues.
            </p>
          </div>
        </div>

        {billingLoading && !visibleTransactions.length ? (
          <div className="py-8 flex justify-center"><Spinner /></div>
        ) : visibleTransactions.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-sm text-gray-500 text-center">
            {subscription.tier?.slug === 'free'
              ? 'No paid subscription is active yet. Checkout and renewal activity will appear here.'
              : 'No billing activity yet. Once checkout or renewal runs, it will appear here.'}
          </div>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                  <tr>
                    <th className="py-3 pr-4">Date</th>
                    <th className="py-3 pr-4">Plan</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4">Total</th>
                    <th className="py-3 pr-4">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTransactions.map((txn) => (
                    <tr key={txn.id} className="border-b border-gray-100 last:border-b-0">
                      <td className="py-3 pr-4 text-gray-700 whitespace-nowrap">
                        {formatAdminDateTime(txn.billedAt || txn.createdAt)}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="font-medium text-gray-900">{txn.plan?.name || subscription.tier?.name || 'Plan'}</div>
                        <div className="text-xs text-gray-500">{txn.invoiceNumber || txn.id}</div>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`inline-flex px-2 py-0.5 rounded-full border text-xs font-semibold ${billingTransactionStatusClass(txn.status)}`}>
                          {statusLabel(txn.status)}
                        </span>
                        {txn.balanceMinor > 0 && (
                          <div className="text-xs text-amber-700 mt-1">
                            Balance due: {formatMoneyMinor(txn.balanceMinor, txn.currencyCode)}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-medium text-gray-900 whitespace-nowrap">
                        {formatMoneyMinor(txn.totalMinor, txn.currencyCode)}
                      </td>
                      <td className="py-3 pr-4">
                        {txn.hasInvoice ? (
                          <button
                            type="button"
                            onClick={() => openBillingInvoice(txn.id)}
                            disabled={billingAction === txn.id}
                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50"
                          >
                            {billingAction === txn.id && <Spinner small />}
                            PDF invoice
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">Not ready yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {billing.pagination?.nextAfter && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => refreshBilling({ append: true, after: billing.pagination.nextAfter })}
                  disabled={billingMoreLoading}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-300 text-sm font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50"
                >
                  {billingMoreLoading && <Spinner small />}
                  Load more payments
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <VerticalWindowsStrip
        windows={workspace?.catalog?.verticalWindows || []}
        currentVertical={currentVertical}
      />

      {cancelOpen && (
        <CancelPlanModal
          tier={subscription?.tier}
          accessUntil={workspace?.paddle?.overview?.nextBilledAt || billing?.overview?.nextBilledAt || null}
          gateway={String(subscription?.gateway || '').toUpperCase()}
          loading={planAction === 'cancel'}
          onClose={() => setCancelOpen(false)}
          onConfirm={cancelPlan}
        />
      )}

      {changeTarget && (
        <PlanChangeModal
          sourceTier={changeTarget.sourceTier}
          targetTier={changeTarget.tier}
          direction={changeTarget.direction}
          billingCycle={billingCycle}
          requiresCheckout={!subscription?.paddleSubscriptionId && changeTarget.tier.slug !== 'free'}
          onClose={() => setChangeTarget(null)}
          onConfirm={async () => {
            const result = await api('/api/subscription/change', {
              method: 'POST',
              body: JSON.stringify({
                tierSlug: changeTarget.tier.slug,
                billingCycle,
              }),
            });

            // First-time paid upgrade: backend returns action=checkout.
            if (result?.action === 'checkout') {
              // Razorpay (India): open the embedded Checkout so the buyer comes
              // straight back here via the handler — the bare hosted short_url
              // strands them on Razorpay (and tempts repeat authorizations).
              // Returns to ?billing=success&gateway=razorpay, which the effect
              // above polls into an active plan. Falls back to the hosted URL if
              // Checkout.js can't load (e.g. blocked).
              if (result.gateway === 'RAZORPAY' && result.razorpaySubscriptionId && result.razorpayKeyId) {
                const returnUrl = `${window.location.pathname}?tab=subscription&billing=success&gateway=razorpay`;
                try {
                  await openRazorpaySubscriptionCheckout({
                    keyId: result.razorpayKeyId,
                    subscriptionId: result.razorpaySubscriptionId,
                    description: `Activate ${changeTarget.tier.name}`,
                    onSuccess: () => { window.location.href = returnUrl; },
                  });
                  return;
                } catch {
                  if (result.checkoutUrl) { window.location.href = result.checkoutUrl; return; }
                }
              }
              if (result.checkoutUrl) {
                window.location.href = result.checkoutUrl;
                return;
              }
            }

            // Both reloads need to finish before we unmount the modal and
            // hand control back to the admin — otherwise the owner flips
            // to Settings and still sees the pre-upgrade subscription
            // (so Custom domain reads as locked even after upgrading).
            await Promise.all([
              load(),
              refreshTenant ? refreshTenant() : Promise.resolve(),
            ]);
            // Confirm the change — without this an in-place upgrade/downgrade just
            // closed the modal silently (and a scheduled downgrade doesn't change
            // the plan name yet, so it looked like nothing happened).
            const name = changeTarget.tier.name;
            setNotice(result?.action === 'scheduled'
              ? { tone: 'info', text: `${name} is scheduled for your next renewal — you keep your current plan until then.` }
              : { tone: 'success', text: `You're now on ${name}.` });
            setChangeTarget(null);
          }}
        />
      )}

    </div>
  );
}

// Plain, owner-facing labels. Raw enum codes (ACTIVE, PAST_DUE…) and warning
// codes (PLAN_VERTICAL_MISMATCH…) are internal — never show them to a tenant.
const STATUS_LABELS = {
  ACTIVE: 'Active',
  TRIALING: 'Trial',
  TRIAL: 'Trial',
  PAST_DUE: 'Payment overdue',
  CANCEL_SCHEDULED: 'Cancels at period end',
  CANCELLED: 'Cancelled',
  CANCELED: 'Cancelled',
  EXPIRED: 'Expired',
  PAUSED: 'Paused',
  DRAFT: 'Incomplete',
  READY: 'Incomplete',
  BILLED: 'Billed',
  COMPLETED: 'Paid',
  PAID: 'Paid',
};

function statusLabel(status) {
  const key = String(status || '').toUpperCase();
  return STATUS_LABELS[key] || key.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

// Owner-facing rewrites for the backend warning codes. Falls back to the
// backend-supplied message, then a generic line — never the raw code.
const WARNING_LABELS = {
  PLAN_VERTICAL_MISMATCH: 'Your plan was set up for a different business type than this workspace. Contact support so we can migrate it cleanly.',
  NO_EQUIVALENT_PLAN_IN_CURRENT_VERTICAL: 'Your current plan doesn’t have a direct match for this business type yet — pick the closest plan below.',
};

function warningLabel(warning) {
  return WARNING_LABELS[warning?.code] || warning?.message || 'This needs a quick review.';
}

// Paddle "draft"/"ready" transactions are abandoned/incomplete checkouts, not
// real charges. Keep them out of payment history; surface them as one notice.
function isIncompleteCheckout(txn) {
  return ['DRAFT', 'READY'].includes(String(txn?.status || '').toUpperCase());
}

function hasConfirmedPaddleSubscription({ subscription, workspace }) {
  const status = String(workspace?.subscription?.status || subscription?.status || '').toUpperCase();
  const paddleSubscriptionId = subscription?.paddleSubscriptionId || workspace?.subscription?.paddle?.subscriptionId;
  return Boolean(paddleSubscriptionId && ['ACTIVE', 'TRIALING', 'TRIAL', 'CANCEL_SCHEDULED'].includes(status));
}

// Collapse the scattered, sometimes-contradictory billing signals into ONE
// coherent status the header can render with a single primary action.
// User-facing warning codes only. A pending plan change is NORMAL (shown in the
// Scheduled-change card), and internal diagnostics (failed webhooks, missing
// price ids, paddle-lookup failures) are ops concerns the reconcile cron handles
// — none of them are things the tenant can act on, so they must NOT raise the
// alarming "needs review" banner.
const NON_ACTIONABLE_WARNING_CODES = new Set(['PENDING_PLAN_CHANGE', 'PENDING_VERTICAL_CHANGE']);

function derivePlanStatus({ subscription, workspace, draftCheckout }) {
  const tier = workspace?.subscription?.tier || subscription?.tier || {};
  const status = workspace?.subscription?.status || subscription?.status || null;
  const statusKey = String(status || '').toUpperCase();
  const isFree = !tier.slug || String(tier.slug).toLowerCase() === 'free';
  const isPaidSub = Boolean(
    subscription?.paddleSubscriptionId || subscription?.stripeSubscriptionId || subscription?.razorpaySubscriptionId
    || workspace?.subscription?.paddle?.subscriptionId,
  );
  const hasConfirmedSub = hasConfirmedPaddleSubscription({ subscription, workspace });
  const supportStatus = workspace?.support?.status || 'healthy';
  // Keep only the warnings an OWNER can act on (e.g. a genuine plan/vertical
  // mismatch). Drop info-level + non-actionable codes so a routine scheduled
  // change never reads as a problem.
  const warnings = (workspace?.workspace?.warnings || [])
    .filter((w) => w?.severity !== 'info' && !NON_ACTIONABLE_WARNING_CODES.has(w?.code));
  const pendingChange = workspace?.subscription?.pendingChange || null;

  let tone = 'neutral';
  // The alarming banner fires ONLY for owner-actionable states — an unfinished
  // checkout or a genuine warning. Internal support diagnostics no longer drive
  // it (they're handled silently by reconcile), so a normal account stays calm.
  if (draftCheckout || warnings.length > 0) tone = 'attention';
  else if (hasConfirmedSub || ['ACTIVE', 'TRIALING', 'TRIAL', 'CANCEL_SCHEDULED'].includes(statusKey)) tone = 'good';

  return { tier, status, isFree, isPaidSub, supportStatus, warnings, pendingChange, draftCheckout, tone };
}

function VerticalWindowsStrip({ windows, currentVertical }) {
  const rows = Array.isArray(windows) ? windows : [];
  if (!rows.length) return null;
  const current = rows.find((row) => row.key === currentVertical || row.current);

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Business type</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            This account is set up for {current?.label || 'its selected business type'}. To change type, create a new account or delete this business and start again.
          </p>
        </div>
        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
          Locked
        </span>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        {rows.map((item) => {
          const active = item.key === currentVertical || item.current;
          const paidPlans = (item.plans || []).filter((plan) => String(plan.slug || '').toLowerCase() !== 'free');
          const recommendedPlan = paidPlans.find((plan) => plan.slug === item.recommendedPlanSlug)
            || paidPlans.find((plan) => !plan.isCustomPriced)
            || paidPlans[0]
            || null;
          return (
            <div key={item.key} className={`rounded-2xl border p-4 ${active ? 'border-indigo-300 bg-indigo-50/60' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">{item.label}</p>
                  <p className="mt-1 text-xs leading-5 text-gray-600">{item.summary}</p>
                </div>
                {active && <span className="shrink-0 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">Current</span>}
              </div>
              <div className="mt-3 rounded-xl bg-white/80 px-3 py-2 text-xs text-gray-600">
                <span className="font-semibold text-gray-900">{recommendedPlan?.name || 'Plan'}</span>
                {recommendedPlan?.familyLabel ? ` · ${recommendedPlan.familyLabel}` : ''}
              </div>
              {!active && <p className="mt-3 text-xs text-gray-500">Use a separate account for this business type.</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlanStatusHeader({
  planStatus,
  subscription,
  workspace,
  billing,
  latestSettledPayment,
  billingAction,
  planAction,
  onOpenPortal,
  onResumeCheckout,
  onCheckPaymentStatus,
  reconciling,
  onCancelPlan,
  onResumePlan,
  onChoosePlan,
}) {
  const { tier, status, isFree, isPaidSub, pendingChange, draftCheckout, tone } = planStatus;
  // Drop the old `|| currentPeriodEnd` fallback that surfaced the 100-year
  // FOREVER sentinel ("Apr 25, 2126"). Backend now null-safes these too.
  const nextBilledAt = workspace?.paddle?.overview?.nextBilledAt || billing?.overview?.nextBilledAt || null;
  const statusKey = String(status || '').toUpperCase();
  const cancelScheduled = statusKey === 'CANCEL_SCHEDULED' || pendingChange?.tierSlug === 'free';
  const pastDue = statusKey === 'PAST_DUE';
  const trialing = statusKey === 'TRIALING' || statusKey === 'TRIAL';
  const billingCycle = (workspace?.subscription?.billingCycle || subscription?.billingCycle || 'MONTHLY').toLowerCase();
  const canOpenPortal = Boolean(billing?.actions?.canOpenPortal);
  const showRenewal = Boolean(nextBilledAt) && !isFree;
  const hasPaidPlan = !isFree && (isPaidSub || statusKey === 'ACTIVE' || trialing || cancelScheduled);
  const canCancel = hasPaidPlan && !cancelScheduled && (statusKey === 'ACTIVE' || trialing);
  // Trial countdown — for a trial the first charge IS the trial-end date.
  const trialDaysLeft = trialing && nextBilledAt
    ? Math.max(0, Math.ceil((new Date(nextBilledAt).getTime() - Date.now()) / 86400000))
    : null;
  const renewalMetricLabel = cancelScheduled ? 'Access until' : pastDue ? 'Payment retry' : trialing ? 'First charge' : 'Next renewal';
  const renewalMetricNote = showRenewal
    ? cancelScheduled ? 'Plan ends — resume to keep it'
      : pastDue ? 'Update your payment method'
      : trialing ? 'When your free trial ends'
      : 'Renews automatically'
    : (isFree ? 'No paid plan active yet' : 'No upcoming charge');

  // Exactly one primary call-to-action, chosen by state.
  const primary = cancelScheduled
    ? { label: 'Resume plan', onClick: onResumePlan, busy: planAction === 'resume', tone: 'brand' }
    : pastDue && canOpenPortal
      ? { label: 'Update payment', onClick: onOpenPortal, busy: billingAction === 'portal', tone: 'danger' }
      : isFree
        ? { label: 'Choose a plan', onClick: onChoosePlan, busy: false, tone: 'brand' }
        : canOpenPortal
          ? { label: 'Manage billing', onClick: onOpenPortal, busy: billingAction === 'portal', tone: 'dark' }
          : null;
  const primaryClass = primary && (
    primary.tone === 'brand' ? 'bg-indigo-600 hover:bg-indigo-700'
      : primary.tone === 'danger' ? 'bg-red-600 hover:bg-red-700'
      : 'bg-gray-900 hover:bg-gray-800');

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      {/* ── Header ───────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Your plan</p>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <h2 className="text-2xl font-bold tracking-tight text-gray-900">{tier.name || 'Free'}</h2>
            <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${billingStatusClass(status)}`}>
              {statusLabel(status)}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-gray-500">
            {workspace?.business?.name || 'This workspace'}
            {isFree ? ' · on the free plan' : ` · billed ${billingCycle}`}
            {showRenewal && !cancelScheduled && !pastDue && (
              <> · {trialing ? `first charge ${formatAdminDate(nextBilledAt)}` : `renews ${formatAdminDate(nextBilledAt)}`}</>
            )}
          </p>
        </div>

        {primary && (
          <button
            type="button"
            onClick={primary.onClick}
            disabled={primary.busy}
            className={`inline-flex shrink-0 items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50 ${primaryClass}`}
          >
            {primary.busy && <Spinner small />}
            {primary.label}
          </button>
        )}
      </div>

      {/* ── Cancel scheduled — the "renew / continue" surface ─────── */}
      {cancelScheduled && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Your {tier.name || 'plan'} is scheduled to cancel{nextBilledAt ? ` on ${formatAdminDate(nextBilledAt)}` : ''}.
            </p>
            <p className="mt-0.5 text-xs text-amber-800">You keep full access until then — resume any time to stay subscribed.</p>
          </div>
          <button
            type="button"
            onClick={onResumePlan}
            disabled={planAction === 'resume'}
            className="mt-3 inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50 sm:mt-0"
          >
            {planAction === 'resume' && <Spinner small />}
            Resume plan
          </button>
        </div>
      )}

      {/* ── Past due ─────────────────────────────────────────────── */}
      {pastDue && !cancelScheduled && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-4">
          <p className="text-sm font-semibold text-red-900">Your last payment didn’t go through.</p>
          <p className="mt-0.5 text-xs text-red-800">Update your payment method to keep your plan from lapsing.</p>
        </div>
      )}

      {/* ── Trial countdown ──────────────────────────────────────── */}
      {trialing && !cancelScheduled && trialDaysLeft != null && (
        <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
          <p className="text-sm text-indigo-900">
            <span className="font-semibold">{trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left</span> in your free trial
            {nextBilledAt ? <> — first charge on {formatAdminDate(nextBilledAt)}</> : null}.
          </p>
        </div>
      )}

      {/* ── Unfinished checkout / needs review (kept) ────────────── */}
      {tone === 'attention' && (draftCheckout || planStatus.warnings.length > 0) && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-4">
          {draftCheckout ? (
            <>
              <p className="text-sm font-semibold text-amber-900">Your {draftCheckout.plan?.name || 'plan'} checkout didn’t finish.</p>
              <p className="mt-0.5 text-xs text-amber-800">No subscription is active yet. Complete payment to activate it — or check the status if you already paid.</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {draftCheckout.plan?.slug && (
                  <button type="button" onClick={() => onResumeCheckout(draftCheckout.plan)}
                    className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700">
                    Complete payment
                  </button>
                )}
                <button type="button" onClick={onCheckPaymentStatus} disabled={reconciling}
                  className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-800 hover:border-amber-400 disabled:opacity-50">
                  {reconciling && <Spinner small />}
                  Check payment status
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-amber-900">This account needs a quick review.</p>
              <p className="mt-0.5 text-xs text-amber-800">{warningLabel(planStatus.warnings[0])}</p>
              <div className="mt-3">
                <button type="button" onClick={onCheckPaymentStatus} disabled={reconciling}
                  className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-semibold text-amber-800 hover:border-amber-400 disabled:opacity-50">
                  {reconciling && <Spinner small />}
                  Check payment status
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Metrics ──────────────────────────────────────────────── */}
      <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard
          label={renewalMetricLabel}
          value={showRenewal ? formatAdminDate(nextBilledAt) : 'No renewal'}
          note={renewalMetricNote}
        />
        <MetricCard
          label="Latest payment"
          value={latestSettledPayment ? formatMoneyMinor(latestSettledPayment.totalMinor, latestSettledPayment.currencyCode) : 'No payment yet'}
          note={latestSettledPayment ? formatAdminDate(latestSettledPayment.paidAt || latestSettledPayment.billedAt || latestSettledPayment.createdAt) : 'Appears after checkout'}
        />
        {pendingChange && !cancelScheduled && (
          <MetricCard
            label="Scheduled change"
            value={pendingChange.tier?.name || pendingChange.tierSlug || 'Pending'}
            note={pendingChange.effectiveAt ? `Effective ${formatAdminDate(pendingChange.effectiveAt)}` : 'Effective soon'}
          />
        )}
      </div>

      {/* ── Quiet footer: cancel + refresh ───────────────────────── */}
      {!isFree && (
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-gray-100 pt-4 text-xs">
          {canCancel && (
            <button type="button" onClick={onCancelPlan} className="font-medium text-gray-500 transition-colors hover:text-red-600">
              Cancel plan
            </button>
          )}
          <button
            type="button"
            onClick={onCheckPaymentStatus}
            disabled={reconciling}
            className="inline-flex items-center gap-1.5 font-medium text-gray-400 transition-colors hover:text-gray-700 disabled:opacity-50"
          >
            {reconciling && <Spinner small />}
            Refresh status
          </button>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, note }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-gray-900">{value || '—'}</p>
      {note && <p className="mt-1 text-xs text-gray-500">{note}</p>}
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-600">
      <path fillRule="evenodd" d="M16.704 5.29a1 1 0 010 1.42l-7.5 7.5a1 1 0 01-1.42 0l-3.5-3.5a1 1 0 111.42-1.42l2.79 2.79 6.79-6.79a1 1 0 011.42 0z" clipRule="evenodd" />
    </svg>
  );
}

// Admin variant of the landing PlanCard (app/page.js PlanCard). Same currency
// path (ctx.symbol + plan.monthly/yearly = super-admin source of truth, which
// removes the old ₹/$ split), but swaps the signup link for upgrade/downgrade
// actions, a "Your plan" badge, and the cross-vertical switch entry point.
function AdminPlanCard({
  plan,
  ctx,
  currentVertical,
  currentSlug,
  currentBillingCycle,
  currentRank,
  billingConfigured,
  onPickPlan,
}) {
  const [showAll, setShowAll] = useState(false);
  const selectedBillingCycle = ctx.billing === 'yearly' ? 'YEARLY' : 'MONTHLY';
  const isCurrentPlan = ctx.vertical === currentVertical && plan.slug === currentSlug;
  const isCurrent = isCurrentPlan && selectedBillingCycle === String(currentBillingCycle || 'MONTHLY').toUpperCase();
  const price = ctx.billing === 'monthly' ? plan.monthly : Math.round((plan.yearly || 0) / 12);
  const paid = price > 0;
  const rank = plan.sortOrder ?? 0;
  const direction = isCurrentPlan && !isCurrent ? 'billing' : rank > currentRank ? 'upgrade' : 'downgrade';

  const features = Array.isArray(plan.features) ? plan.features : [];
  const FEATURE_LIMIT = 8;
  const visibleFeatures = showAll ? features : features.slice(0, FEATURE_LIMIT);

  let priceLabel;
  if (plan.isCustomPriced) priceLabel = "Let's talk";
  else if (!paid) priceLabel = 'Free';
  else priceLabel = `${ctx.symbol}${price.toLocaleString('en-IN')}`;

  let cta;
  if (isCurrent) {
    cta = (
      <button type="button" disabled className="mt-6 w-full rounded-xl border border-indigo-200 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700">
        Your plan
      </button>
    );
  } else if (plan.isCustomPriced) {
    cta = (
      <a
        href={plan.ctaHref || 'mailto:sales@sitepresso.com'}
        className="mt-6 block w-full rounded-xl bg-gray-900 px-4 py-2.5 text-center text-sm font-semibold text-white transition-colors hover:bg-gray-800"
      >
        {plan.cta || 'Contact sales'}
      </a>
    );
  } else if (direction === 'billing') {
    cta = (
      <button
        type="button"
        onClick={() => onPickPlan(plan, direction)}
        className="mt-6 w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
      >
        Switch to {ctx.billing === 'yearly' ? 'yearly' : 'monthly'} billing
      </button>
    );
  } else if (direction === 'upgrade' && paid && !billingConfigured) {
    cta = (
      <button type="button" disabled className="mt-6 w-full rounded-xl border border-gray-200 bg-gray-100 px-4 py-2.5 text-sm font-semibold text-gray-500">
        Paid upgrades paused
      </button>
    );
  } else {
    cta = (
      <button
        type="button"
        onClick={() => onPickPlan(plan, direction)}
        className={`mt-6 w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
          direction === 'upgrade'
            ? 'bg-emerald-600 text-white hover:bg-emerald-700'
            : 'border border-gray-300 bg-white text-gray-900 hover:border-gray-900'
        }`}
      >
        {direction === 'upgrade' ? `Upgrade to ${plan.name}` : `Downgrade to ${plan.name}`}
      </button>
    );
  }

  return (
    <div className={`relative flex flex-col rounded-3xl p-6 md:p-7 ${isCurrent ? 'border-2 border-indigo-500 bg-indigo-50/40' : 'border border-gray-200 bg-white'}`}>
      {isCurrent ? (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-white">
          Your plan
        </span>
      ) : plan.badge ? (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet-500 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-white">
          {plan.badge}
        </span>
      ) : null}

      <h4 className="text-lg font-semibold text-gray-900">{plan.name}</h4>
      {plan.tagline && <p className="mt-1 text-sm text-gray-500">{plan.tagline}</p>}

      <div className="mt-5 flex items-baseline gap-1">
        <span className="text-4xl font-bold tracking-tight text-gray-900">{priceLabel}</span>
        {!plan.isCustomPriced && paid && <span className="text-sm text-gray-500">/mo</span>}
      </div>
      {!plan.isCustomPriced && paid && ctx.billing === 'yearly' && plan.yearly > 0 && (
        <p className="mt-1 text-xs text-gray-500">
          Billed yearly at {ctx.symbol}{plan.yearly.toLocaleString('en-IN')}/yr
        </p>
      )}

      <ul className="mt-6 flex-1 space-y-2.5 text-sm text-gray-700">
        {visibleFeatures.map((f, i) => (
          <li key={i} className="flex items-start gap-2.5"><CheckIcon /><span>{f}</span></li>
        ))}
      </ul>
      {features.length > FEATURE_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 self-start text-xs font-semibold text-indigo-600 hover:text-indigo-700"
        >
          {showAll ? 'Show fewer features' : `See all ${features.length} features`}
        </button>
      )}

      {cta}
    </div>
  );
}

function AdminPlanCardSkeleton() {
  return (
    <div className="animate-pulse rounded-3xl border border-gray-200 bg-white p-6 md:p-7">
      <div className="h-5 w-24 rounded bg-gray-200" />
      <div className="mt-2 h-4 w-40 rounded bg-gray-100" />
      <div className="mt-5 h-9 w-28 rounded bg-gray-200" />
      <div className="mt-6 space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-3.5 w-full rounded bg-gray-100" />
        ))}
      </div>
      <div className="mt-6 h-10 w-full rounded-xl bg-gray-100" />
    </div>
  );
}


// Confirm modal for cancelling the paid plan. Frames cancellation as reversible
// (Paddle/Stripe resume) and tells Razorpay customers they'll re-subscribe.
function CancelPlanModal({ tier, accessUntil, gateway, loading, onClose, onConfirm }) {
  const isRazorpay = gateway === 'RAZORPAY';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-sm" onClick={loading ? undefined : onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-gray-900">Cancel your {tier?.name || 'plan'}?</h3>
            <p className="mt-1 text-sm text-gray-600">
              You&apos;ll keep full access{accessUntil ? <> until <span className="font-semibold text-gray-900">{formatAdminDate(accessUntil)}</span></> : ' until the end of your current billing period'}, then move to the free plan.
            </p>
          </div>
        </div>

        <ul className="mt-4 space-y-2 rounded-xl bg-gray-50 p-4 text-sm text-gray-600">
          <li className="flex gap-2"><span className="text-emerald-600">✓</span> No further charges after this period.</li>
          <li className="flex gap-2"><span className="text-emerald-600">✓</span> Your data and storefront stay intact on the free plan.</li>
          {isRazorpay
            ? <li className="flex gap-2"><span className="text-amber-600">!</span> You&apos;ll need to re-subscribe to come back — your plan can&apos;t auto-resume.</li>
            : <li className="flex gap-2"><span className="text-emerald-600">✓</span> Changed your mind? Resume any time before it ends.</li>}
        </ul>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={onClose} disabled={loading}
            className="inline-flex items-center justify-center rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-50">
            Keep my plan
          </button>
          <button type="button" onClick={onConfirm} disabled={loading}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
            {loading && <Spinner small />}
            Cancel plan
          </button>
        </div>
      </div>
    </div>
  );
}

const BILLING_INPUT = 'w-full px-3 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 bg-white';

function BillingField({ label, value, onChange, type = 'text', placeholder = '', children, disabled = false }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 mb-1">{label}</span>
      {children || (
        <input
          type={type}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={disabled ? `${BILLING_INPUT} bg-gray-50 text-gray-500 cursor-not-allowed` : BILLING_INPUT}
        />
      )}
    </label>
  );
}

function businessAddressDefaults(business) {
  return {
    addressLine1: business?.address || '',
    addressLine2: '',
    city: '',
    state: business?.state || '',
    postalCode: '',
    country: business?.country || '',
  };
}

function hasBillingAddress(profile) {
  return Boolean(
    profile?.addressLine1
    || profile?.addressLine2
    || profile?.city
    || profile?.state
    || profile?.postalCode
    || profile?.country
  );
}

function subscriptionGatewayForCountry(country) {
  const code = String(country || '').trim().toUpperCase();
  if (code === 'IN') return { key: 'RAZORPAY', label: 'Razorpay', model: 'India subscription billing' };
  if (code === 'NZ') return { key: 'STRIPE', label: 'Stripe', model: 'New Zealand subscription billing' };
  return { key: 'PADDLE', label: 'Paddle', model: 'Merchant of Record billing' };
}

function activeGatewayForSubscription(subscription) {
  if (subscription?.razorpaySubscriptionId) return 'RAZORPAY';
  if (subscription?.stripeSubscriptionId) return 'STRIPE';
  if (subscription?.paddleSubscriptionId) return 'PADDLE';
  return null;
}

function BillingProfileCard({ business, subscription, value, onChange, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  // Country is locked after signup (it drives the payment gateway). This panel
  // is the controlled escape hatch: instant change when there's no live plan,
  // a support-routed explainer when there is.
  const [showCountryChange, setShowCountryChange] = useState(false);
  const [pendingCountry, setPendingCountry] = useState('');
  const profile = value || {
    purchaserType: 'INDIVIDUAL',
    businessName: '',
    contactName: '',
    email: '',
    taxId: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
  };
  const isBusiness = profile.purchaserType === 'BUSINESS';
  const [useBusinessAddress, setUseBusinessAddress] = useState(false);
  const businessAddress = businessAddressDefaults(business);
  const effectiveBillingCountry = profile.country || business?.country || '';
  const billingCountryName = COUNTRIES.find((c) => c.code === effectiveBillingCountry)?.name || effectiveBillingCountry || '';
  const billingGateway = subscriptionGatewayForCountry(effectiveBillingCountry);
  const activeGateway = activeGatewayForSubscription(subscription);
  const gatewaySwitching = activeGateway && activeGateway !== billingGateway.key;

  useEffect(() => {
    if (!value || !business || hasBillingAddress(value)) return;
    if (hasBillingAddress(businessAddress)) setUseBusinessAddress(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.purchaserType, business?.address, business?.state, business?.country]);

  const setField = (key, next) => {
    setSaved(false);
    setError('');
    onChange?.({ ...profile, [key]: next });
  };
  const setBusinessPurchase = (checked) => {
    setSaved(false);
    setError('');
    onChange?.({
      ...profile,
      purchaserType: checked ? 'BUSINESS' : 'INDIVIDUAL',
      businessName: checked && !profile.businessName ? (business?.name || '') : profile.businessName,
    });
  };
  const setSameAsBusinessAddress = (checked) => {
    setUseBusinessAddress(checked);
    setSaved(false);
    setError('');
    if (checked) onChange?.({ ...profile, ...businessAddress });
  };

  async function save() {
    setSaving(true);
    setSaved(false);
    setError('');
    const payload = useBusinessAddress ? { ...profile, ...businessAddress } : profile;
    try {
      const res = await api('/api/subscription/billing-profile', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      onChange?.(res.billingProfile || payload);
      setSaved(true);
      await onSaved?.();
    } catch (err) {
      setError(err?.data?.message || err.message || 'Could not save billing details.');
    } finally {
      setSaving(false);
    }
  }

  async function saveCountry() {
    setSaving(true);
    setError('');
    try {
      const base = useBusinessAddress ? { ...profile, ...businessAddress } : profile;
      const payload = { ...base, country: pendingCountry };
      const res = await api('/api/subscription/billing-profile', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      onChange?.(res.billingProfile || payload);
      setShowCountryChange(false);
      setSaved(true);
      await onSaved?.();
    } catch (err) {
      // Backend gatewayMigrationBlock returns 409 when the new country would
      // cross gateways on a live plan — surface that message in the modal.
      setError(err?.data?.message || err.message || 'Could not change billing country.');
    } finally {
      setSaving(false);
    }
  }

  // Gateway the chosen new country would route to, and whether it would cross
  // gateways while a plan is live (the only case that needs support).
  const pendingGateway = subscriptionGatewayForCountry(pendingCountry);
  const wouldCrossGateway = Boolean(activeGateway) && pendingGateway.key !== activeGateway;
  const sameCountry = (pendingCountry || '') === (effectiveBillingCountry || '');

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Billing details</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Used for Sitepresso subscription purchases, secure checkout, and invoice support.
          </p>
        </div>
        {saved && <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1">Saved</span>}
      </div>

      {error && <div className="mt-4"><ErrorBanner message={error} /></div>}

      <div className={`mt-4 rounded-xl border px-4 py-3 ${gatewaySwitching ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
        <p className={`text-sm font-medium ${gatewaySwitching ? 'text-amber-900' : 'text-gray-800'}`}>
          {gatewaySwitching
            ? 'Changing your billing country'
            : `Billed in ${billingCountryName || 'your selected country'}`}
        </p>
        <p className={`mt-1 text-xs ${gatewaySwitching ? 'text-amber-700' : 'text-gray-500'}`}>
          {gatewaySwitching
            ? 'You already have an active subscription, so switching your billing country may need a hand from support to move it cleanly — reach out before saving a new country.'
            : 'Your country sets your currency, taxes, and invoices. Checkout is processed securely.'}
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={isBusiness}
            onChange={(e) => setBusinessPurchase(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>
            <span className="block text-sm font-semibold text-gray-900">This is a business purchase</span>
            <span className="block text-xs text-gray-500">
              Use this when the invoice should show a registered business name or tax ID.
            </span>
          </span>
        </label>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {isBusiness && (
          <BillingField
            label="Registered business name"
            value={profile.businessName}
            onChange={(v) => setField('businessName', v)}
            placeholder="Legal name for invoice"
          />
        )}
        <BillingField
          label={isBusiness ? 'Billing contact name' : 'Billing name'}
          value={profile.contactName}
          onChange={(v) => setField('contactName', v)}
        />
        <BillingField
          label="Billing email"
          type="email"
          value={profile.email}
          onChange={(v) => setField('email', v)}
          placeholder="accounts@example.com"
        />
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={useBusinessAddress}
            onChange={(e) => setSameAsBusinessAddress(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>
            <span className="block text-sm font-semibold text-gray-900">Billing address is same as business address</span>
            <span className="block text-xs text-gray-500">
              {hasBillingAddress(businessAddress)
                ? 'Shown below. Untick to enter a different billing address.'
                : 'No business address is saved yet. Untick this to enter a billing address.'}
            </span>
          </span>
        </label>
      </div>

      {/* Billing country — locked (drives the gateway), with a guided change link. */}
      <div className="mt-4">
        <span className="block text-sm font-medium text-gray-700 mb-1">Billing country</span>
        <div className={`${BILLING_INPUT} bg-gray-50 text-gray-700 flex items-center justify-between cursor-not-allowed`}>
          <span>{COUNTRIES.find((c) => c.code === effectiveBillingCountry)?.name || effectiveBillingCountry || 'Not set'}</span>
          <span aria-hidden className="text-gray-400">🔒</span>
        </div>
        <span className="mt-1 block text-xs text-gray-400">
          Set at signup — the country your subscription is billed in.{' '}
          <button
            type="button"
            onClick={() => { setPendingCountry(effectiveBillingCountry || ''); setShowCountryChange(true); }}
            className="font-semibold text-indigo-600 hover:underline"
          >
            Change country
          </button>
        </span>
      </div>

      {/* Country-aware address + tax-ID. When "same as business" is ticked the
          fields mirror the saved business address and are read-only. */}
      {(() => {
        const ro = useBusinessAddress;
        const src = ro ? businessAddress : profile;
        const addrValue = {
          line1: src.addressLine1, line2: src.addressLine2, city: src.city,
          state: src.state, postalCode: src.postalCode,
        };
        return (
          <div className="mt-4">
            <CountryAddressFields
              country={effectiveBillingCountry}
              value={addrValue}
              onChange={(next) => onChange?.({
                ...profile,
                addressLine1: next.line1, addressLine2: next.line2, city: next.city,
                state: next.state, postalCode: next.postalCode,
              })}
              taxId={profile.taxId}
              onTaxIdChange={(val) => setField('taxId', val)}
              purchaserType={profile.purchaserType}
              disabled={ro}
              inputClass={BILLING_INPUT}
            />
          </div>
        );
      })()}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
        >
          {saving && <Spinner small />}
          Save billing details
        </button>
        <p className="text-xs text-gray-500">
          The buyer may still need to confirm tax and address details during checkout.
        </p>
      </div>

      {showCountryChange && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 p-4" onClick={() => setShowCountryChange(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-900">Change billing country</h3>
            <p className="mt-1 text-xs text-gray-500">
              This is the country your subscription is billed in. Changing it may require re-entering your card.
            </p>

            <label className="mt-4 block">
              <span className="block text-sm font-medium text-gray-700 mb-1">New country</span>
              <select
                value={pendingCountry || ''}
                onChange={(e) => setPendingCountry(e.target.value)}
                className={BILLING_INPUT}
              >
                <option value="">Select country...</option>
                {COUNTRIES.map((country) => (
                  <option key={country.code} value={country.code}>{country.name}</option>
                ))}
              </select>
            </label>

            {error && <div className="mt-3 text-sm text-red-600">{error}</div>}

            {wouldCrossGateway && !sameCountry ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-semibold">Changing to this country needs a clean switch.</p>
                <p className="mt-1 text-xs">
                  A live plan can’t change its billing country automatically — your card has to be re-entered.
                  Support will cancel your current plan at the end of this billing period and set up the new one so there’s
                  no double charge or gap. Reach out and we’ll switch it cleanly.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-xs text-gray-500">
                No active plan affected — your next checkout uses the new country.
              </p>
            )}

            <div className="mt-5 flex items-center justify-end gap-3">
              <button type="button" onClick={() => setShowCountryChange(false)} className="px-4 py-2 text-sm font-semibold text-gray-600 hover:text-gray-900">
                Cancel
              </button>
              {wouldCrossGateway && !sameCountry ? (
                <a
                  href="mailto:support@sitepresso.com?subject=Change%20billing%20country"
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
                >
                  Contact support
                </a>
              ) : (
                <button
                  type="button"
                  onClick={saveCountry}
                  disabled={saving || !pendingCountry || sameCountry}
                  className="inline-flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
                >
                  {saving && <Spinner small />}
                  Update country
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Plan change confirmation:
// what you gain/lose, customer-facing impact, type-to-confirm for downgrades.
function PlanChangeModal({ sourceTier, targetTier, direction, billingCycle, requiresCheckout, onClose, onConfirm }) {
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const sourceFeatures = new Set(Array.isArray(sourceTier?.features) ? sourceTier.features : []);
  const targetFeatures = new Set(Array.isArray(targetTier?.features) ? targetTier.features : []);
  const gained = [...targetFeatures].filter((f) => !sourceFeatures.has(f));
  const lost   = [...sourceFeatures].filter((f) => !targetFeatures.has(f));

  const isUpgrade = direction === 'upgrade';
  const isBillingChange = direction === 'billing';
  const isFreeTarget = targetTier?.slug === 'free';
  const billingLabel = billingCycle === 'YEARLY' ? 'yearly' : 'monthly';
  const gatewayLabel = preview?.money?.gateway ? `${preview.money.gateway.charAt(0)}${preview.money.gateway.slice(1).toLowerCase()}` : 'Billing';
  const scheduledAtPeriodEnd = preview?.money?.changeTiming === 'period_end';

  // Downgrades require typing the target plan name to proceed.
  const CONFIRM_WORD = targetTier?.name?.toLowerCase() || 'confirm';
  const previewReady = Boolean(preview) && !previewLoading && !previewError;
  const previewBlocksCommit = !previewReady || preview?.safeToCommit === false;
  const confirmReady = !previewBlocksCommit && (isUpgrade || isBillingChange || confirmText.trim().toLowerCase() === CONFIRM_WORD);

  useEffect(() => {
    if (!targetTier?.slug) return;
    let cancelled = false;
    setPreview(null);
    setPreviewLoading(true);
    setPreviewError('');
    api('/api/subscription/change-preview', {
      method: 'POST',
      body: JSON.stringify({ tierSlug: targetTier.slug, billingCycle }),
    })
      .then((res) => {
        if (!cancelled) setPreview(res.preview || null);
      })
      .catch((e) => {
        if (!cancelled) setPreviewError(e?.data?.message || e.message || 'Could not load billing preview.');
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => { cancelled = true; };
  }, [targetTier?.slug, billingCycle]);

  async function handleConfirm() {
    if (!confirmReady) return;
    setSubmitting(true); setErr('');
    try {
      await onConfirm();
    } catch (e) {
      setErr(e?.data?.message || e.message || 'Could not change plan. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4 overflow-y-auto"
      style={{ backgroundColor: 'rgba(10,10,20,0.55)' }}
      onClick={() => !submitting && onClose()}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <span className={`w-9 h-9 rounded-full flex items-center justify-center text-base flex-shrink-0 ${
              isUpgrade || isBillingChange ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
            }`}>
              {isBillingChange ? '↔' : isUpgrade ? '↑' : '↓'}
            </span>
            <div>
              <h3 className="text-base font-semibold text-gray-900">
                {isBillingChange
                  ? `Switch to ${billingLabel} billing`
                  : isUpgrade ? `Upgrade to ${targetTier.name}` : `Downgrade to ${targetTier.name}`}
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {isBillingChange
                  ? `${targetTier.name} plan`
                  : <>{sourceTier?.name || 'current plan'} → {targetTier.name}</>}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={submitting} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        <div className="px-6 py-4 space-y-3 max-h-[65vh] overflow-y-auto">
          {/* What you gain */}
          {isBillingChange && (
            <p className="text-sm text-gray-500">
              Your plan and customer-facing features stay the same. Only the renewal cadence changes.
            </p>
          )}

          {isUpgrade && gained.length > 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800 mb-2">What becomes available</p>
              <ul className="space-y-1.5">
                {gained.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-emerald-900">
                    <span className="text-emerald-500 font-bold mt-0.5">+</span><span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* What you lose */}
          {!isUpgrade && lost.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800 mb-2">Features you&rsquo;ll lose</p>
              <ul className="space-y-1.5">
                {lost.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-amber-900">
                    <span className="text-amber-600 font-bold mt-0.5">−</span><span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isUpgrade && gained.length === 0 && (
            <p className="text-sm text-gray-500">Your current plan already covers every feature in this tier.</p>
          )}
          {!isUpgrade && lost.length === 0 && (
            <p className="text-sm text-gray-500">No features are lost — your access stays the same.</p>
          )}

          {/* Customer-facing impact */}
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1.5">Customer-facing impact</p>
            <p className="text-sm text-gray-700">
              {isBillingChange
                ? `Nothing changes for your customers. Billing updates in ${gatewayLabel} after confirmation.`
                : isUpgrade
                ? `New features on ${targetTier.name} activate as soon as payment is confirmed — your customers won't experience any interruption.`
                : isFreeTarget
                  ? 'Your paid features stay active until the end of your current billing period. After that, paid features are disabled until you renew or choose another paid plan.'
                  : `Your current features stay active until the end of this billing period. Then ${targetTier.name} limits apply. Your data (orders, customers, bookings) is kept — nothing is deleted.`}
            </p>
          </div>

          {/* Billing note */}
          <p className="text-xs text-gray-500">
            {requiresCheckout
              ? `You'll be taken to secure checkout to activate ${targetTier.name} on ${billingLabel} billing.`
              : isBillingChange
                ? `${gatewayLabel} updates this subscription to ${billingLabel} billing and applies any prorated adjustment it returns.`
              : isUpgrade
                ? 'The upgrade applies immediately after the gateway accepts the prorated difference.'
                : isFreeTarget
                  ? 'Paid access continues until the end of your billing period, then moves to the internal fallback state.'
                : 'No immediate credit or feature loss. The downgrade is scheduled for your next renewal.'}
          </p>

          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1.5">Billing preview</p>
            {previewLoading ? (
              <div className="flex items-center gap-2 text-sm text-gray-600"><Spinner small /> Loading preview</div>
            ) : previewError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {previewError}
              </div>
            ) : preview ? (
              <div className="space-y-1.5 text-sm text-gray-700">
                <p>
                  Target price:{' '}
                  <span className="font-semibold text-gray-900">
                    {preview.money?.expectedAmountMinor
                      ? formatMoneyMinor(preview.money.expectedAmountMinor, preview.money.currencyCode)
                      : preview.money?.targetIsFree ? 'Free' : 'Not configured'}
                  </span>
                </p>
                <p>
                  Payment action:{' '}
                  <span className="font-semibold text-gray-900">
                    {preview.money?.requiresCheckout
                      ? 'Secure checkout'
                      : preview.money?.willScheduleDowngrade
                        ? 'Schedule at renewal'
                      : preview.money?.willUpdateGatewaySubscription
                        ? 'Update current subscription'
                        : preview.money?.willScheduleFreeDowngrade
                          ? 'Schedule downgrade'
                          : 'No payment action'}
                  </span>
                </p>
                {preview.money?.prorationBillingMode && (
                  <p>Proration: <span className="font-semibold text-gray-900">{preview.money.prorationBillingMode.replace(/_/g, ' ')}</span></p>
                )}
                {preview.money?.changeTiming && (
                  <p>Timing: <span className="font-semibold text-gray-900">{scheduledAtPeriodEnd ? 'At renewal' : 'Immediate'}</span></p>
                )}
                <p className="text-xs text-gray-500">{preview.money?.finalAmountNote}</p>
                {preview.blocking?.length > 0 && (
                  <div className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    {preview.blocking.map((item) => (
                      <p key={item.code}>{item.message}</p>
                    ))}
                  </div>
                )}
                {preview.warnings?.length > 0 && (
                  <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    {preview.warnings.map((item) => (
                      <p key={item.code}>{item.message}</p>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                Billing preview is required before changing plans.
              </div>
            )}
          </div>

          {/* Type-to-confirm for downgrades */}
          {!isUpgrade && !isBillingChange && (
            <div>
              <p className="text-sm text-gray-700 mb-2">
                Type <span className="font-mono font-semibold text-gray-900">{CONFIRM_WORD}</span> to confirm
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoFocus
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 font-mono"
              />
            </div>
          )}

          {err && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-100">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || !confirmReady}
            className={`px-5 py-2 text-sm font-semibold rounded-lg text-white inline-flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isUpgrade || isBillingChange ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-gray-900 hover:bg-gray-800'
            }`}
          >
            {submitting
              ? 'Switching…'
              : previewLoading
                ? 'Preparing preview…'
                : isBillingChange
                  ? `Switch to ${billingLabel} billing →`
                  : isUpgrade ? `Upgrade to ${targetTier.name} →` : `Schedule downgrade to ${targetTier.name}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SubscriptionTab;
