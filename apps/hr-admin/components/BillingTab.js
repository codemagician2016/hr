'use client';

// Settings → Billing.
//
// Surfaces the existing subscription/billing backend in the HR-admin console:
//   • GET  /api/subscription/billing            → current plan, status, renewal,
//                                                   pending change, payment history
//   • GET  /api/subscription/workspace          → plan catalog (upgrade/downgrade)
//   • POST /api/subscription/change-preview      → proration/effect preview
//   • POST /api/subscription/change              → commit a plan change (returns a
//                                                   checkoutUrl when a card is needed)
//   • POST /api/subscription/cancel | /resume    → schedule / undo a cancellation
//   • GET/PUT /api/subscription/billing-profile  → who is billed (name/tax/address)
//   • POST /api/subscription/billing/portal      → hosted card/invoice portal
//   • POST /api/subscription/billing/invoices/:id → invoice download URL
//
// All write actions are gated on the canEditBilling permission; without it the
// page is read-only (current plan + history stay visible).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Spinner,
  ErrorBanner,
  Modal,
  ModalActions,
  PrimaryButton,
  TextInput,
  Empty,
  formatMoneyMinor,
  formatAdminDate,
  billingStatusClass,
  billingTransactionStatusClass,
  capitalizeSlug,
} from '@hr/ui';
import { get, post, request } from '@/lib/api';
import { permissionsFromSession, hasPermission } from '@/lib/nav';

const CYCLES = [
  { key: 'MONTHLY', label: 'Monthly' },
  { key: 'YEARLY', label: 'Yearly' },
];

function statusLabel(status) {
  return capitalizeSlug(String(status || '').toLowerCase()) || '—';
}

// ─── ReadOnlyBanner ──────────────────────────────────────────────────────────
function BillingReadOnlyBanner() {
  return (
    <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
      <span aria-hidden="true">🔒 </span>
      You have read-only access to billing. Changing the plan, payment method or billing details requires the
      <span className="font-medium"> canEditBilling</span> permission.
    </p>
  );
}

// ─── CurrentPlanCard ─────────────────────────────────────────────────────────
function CurrentPlanCard({ overview }) {
  const plan = overview?.currentPlan;
  const status = overview?.status;
  const renews = overview?.nextBilledAt || overview?.currentPeriodEnd;
  const lifetime = overview?.lifetime;
  const promo = overview?.promo;
  const pending = overview?.pendingTierSlug;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide text-gray-500">Current plan</p>
          <p className="mt-1 text-xl font-semibold text-gray-900">
            {plan?.name || 'Free'}
          </p>
          {overview?.billingCycle && plan?.slug !== 'free' ? (
            <p className="text-sm text-gray-500 mt-0.5">Billed {String(overview.billingCycle).toLowerCase()}</p>
          ) : null}
        </div>
        {status ? (
          <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${billingStatusClass(status)}`}>
            {statusLabel(status)}
          </span>
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <div>
          <dt className="text-gray-500">Next renewal</dt>
          <dd className="text-gray-900 font-medium">
            {lifetime ? 'No renewal — lifetime access' : renews ? formatAdminDate(renews) : 'No renewal'}
          </dd>
        </div>
        {promo ? (
          <div>
            <dt className="text-gray-500">Promotion</dt>
            <dd className="text-emerald-700 font-medium">
              {promo.label}{promo.code ? ` (${promo.code})` : ''}
            </dd>
          </div>
        ) : null}
      </dl>

      {pending ? (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          A change to <span className="font-medium">{capitalizeSlug(overview.pendingTierSlug)}</span>
          {overview.pendingBillingCycle ? ` (${String(overview.pendingBillingCycle).toLowerCase()})` : ''} is scheduled
          {overview.pendingChangeEffectiveAt ? ` for ${formatAdminDate(overview.pendingChangeEffectiveAt)}` : ''}.
        </div>
      ) : null}
    </section>
  );
}

// ─── PlanPicker ──────────────────────────────────────────────────────────────
// Lists the plan variants for the tenant's current vertical and lets the
// operator preview + confirm a change. Custom-priced plans route to support.
function PlanPicker({ workspace, currentSlug, cycle, onCycle, onPick, disabled }) {
  const variants = useMemo(() => {
    const all = workspace?.catalog?.variants || [];
    const vertical = workspace?.business?.vertical;
    const list = vertical ? all.filter((v) => v.vertical === vertical) : all;
    return list.slice().sort((a, b) => (a.familyRank || 0) - (b.familyRank || 0) || (a.sortOrder || 0) - (b.sortOrder || 0));
  }, [workspace]);

  if (!variants.length) return null;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold text-gray-900">Change plan</h2>
        <div className="inline-flex rounded-lg border border-gray-200 p-0.5" role="tablist" aria-label="Billing cycle">
          {CYCLES.map((c) => {
            const on = cycle === c.key;
            return (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onCycle(c.key)}
                disabled={disabled}
                className={`px-3 py-1 text-sm font-medium rounded-md transition-colors disabled:opacity-50 ${
                  on ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {variants.map((v) => {
          const isCurrent = v.slug === currentSlug;
          const amountMinor = cycle === 'YEARLY' ? v.price?.displayAnnualMinor : v.price?.displayMonthlyMinor;
          const cur = v.price?.currencyCode;
          return (
            <div
              key={v.slug}
              className={`rounded-xl border p-4 flex flex-col ${isCurrent ? 'border-transparent ring-2' : 'border-gray-200'}`}
              style={isCurrent ? { boxShadow: '0 0 0 2px var(--theme-primary)' } : undefined}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-gray-900">{v.name}</p>
                {v.badge ? (
                  <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-500">{v.badge}</span>
                ) : null}
              </div>
              {v.tagline ? <p className="text-xs text-gray-500 mt-0.5">{v.tagline}</p> : null}
              <p className="mt-3 text-lg font-semibold text-gray-900">
                {v.isCustomPriced
                  ? 'Custom'
                  : amountMinor != null && cur
                  ? `${formatMoneyMinor(amountMinor, cur)}`
                  : '—'}
                {!v.isCustomPriced && amountMinor != null ? (
                  <span className="text-xs font-normal text-gray-500"> /{cycle === 'YEARLY' ? 'yr' : 'mo'}</span>
                ) : null}
              </p>
              <div className="mt-auto pt-4">
                {isCurrent ? (
                  <span className="inline-flex w-full items-center justify-center rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-500">
                    Current plan
                  </span>
                ) : v.isCustomPriced ? (
                  <a
                    href="mailto:support@drifthr.com?subject=Custom%20plan%20enquiry"
                    className="inline-flex w-full items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Contact sales
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={() => onPick(v)}
                    disabled={disabled}
                    className="inline-flex w-full items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                    style={{ backgroundColor: 'var(--theme-primary)' }}
                  >
                    Choose {v.name}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── ChangePlanModal ─────────────────────────────────────────────────────────
function ChangePlanModal({ target, cycle, onClose, onChanged }) {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    post('/api/subscription/change-preview', { tierSlug: target.slug, billingCycle: cycle })
      .then((res) => {
        if (alive) setPreview(res?.preview || null);
      })
      .catch((err) => {
        if (alive) setError(err.data?.message || err.message || 'Could not preview this change.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target.slug, cycle]);

  async function commit() {
    setCommitting(true);
    setError('');
    try {
      const res = await post('/api/subscription/change', { tierSlug: target.slug, billingCycle: cycle });
      // A paid upgrade returns a checkout URL — send the operator to it.
      if (res?.checkoutUrl) {
        window.location.assign(res.checkoutUrl);
        return;
      }
      onChanged?.();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not change the plan.');
      setCommitting(false);
    }
  }

  const money = preview?.money;
  const requiresCheckout = money?.requiresCheckout;
  const targetIsFree = money?.targetIsFree;
  const amountMinor = money?.expectedAmountMinor;
  const blocked = preview && preview.safeToCommit === false;

  return (
    <Modal title={`Switch to ${target.name}`} onClose={() => (committing ? null : onClose())}>
      {loading ? (
        <div className="py-6 flex justify-center"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          {error && <ErrorBanner message={error} />}

          <p className="text-sm text-gray-600">
            You&apos;re moving to <span className="font-medium text-gray-900">{target.name}</span>, billed{' '}
            {String(cycle).toLowerCase()}.
          </p>

          {!targetIsFree && amountMinor != null && money?.currencyCode ? (
            <dl className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
              <div className="flex items-center justify-between px-3 py-2">
                <dt className="text-gray-500">Plan price</dt>
                <dd className="font-medium text-gray-900">
                  {formatMoneyMinor(amountMinor, money.currencyCode)}
                  <span className="text-xs font-normal text-gray-500"> /{cycle === 'YEARLY' ? 'yr' : 'mo'}</span>
                </dd>
              </div>
            </dl>
          ) : null}

          {money?.finalAmountNote ? (
            <p className="text-xs text-gray-500">{money.finalAmountNote}</p>
          ) : requiresCheckout ? (
            <p className="text-xs text-gray-500">
              You&apos;ll be taken to a secure checkout to confirm your payment method.
            </p>
          ) : (
            <p className="text-xs text-gray-500">
              No payment needed now — the change applies to your subscription right away.
            </p>
          )}

          {blocked ? (
            <p className="text-sm text-red-600">
              {preview?.blocking?.[0]?.message || 'This change can’t be made automatically. Please contact support.'}
            </p>
          ) : null}
        </div>
      )}

      <ModalActions>
        <button
          type="button"
          onClick={onClose}
          disabled={committing}
          className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <PrimaryButton loading={committing} onClick={commit} disabled={loading || blocked}>
          {requiresCheckout ? 'Continue to checkout' : `Switch to ${target.name}`}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  );
}

// ─── BillingProfileCard ──────────────────────────────────────────────────────
function BillingProfileCard({ profile, canEdit, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(profile || {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setForm(profile || {}), [profile]);

  function set(key) {
    return (v) => setForm((f) => ({ ...f, [key]: v }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const res = await request('/api/subscription/billing-profile', {
        method: 'PUT',
        body: JSON.stringify(form),
      });
      onSaved?.(res?.billingProfile || form);
      setOpen(false);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not save billing details.');
    } finally {
      setSaving(false);
    }
  }

  const lines = [
    profile?.businessName || profile?.contactName,
    profile?.email,
    [profile?.addressLine1, profile?.city, profile?.state, profile?.postalCode].filter(Boolean).join(', '),
    profile?.country,
  ].filter(Boolean);

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-900">Billing details</h2>
        {canEdit && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-sm font-medium"
            style={{ color: 'var(--theme-primary)' }}
          >
            Edit
          </button>
        )}
      </div>
      {lines.length ? (
        <div className="text-sm text-gray-700 space-y-0.5">
          {lines.map((l, i) => <p key={i}>{l}</p>)}
        </div>
      ) : (
        <p className="text-sm text-gray-500">
          No billing details yet.{canEdit ? ' Add them so your invoices show the right name and tax ID.' : ''}
        </p>
      )}

      {open && (
        <Modal title="Billing details" size="lg" onClose={() => (saving ? null : setOpen(false))}>
          <div className="space-y-3">
            {error && <ErrorBanner message={error} />}
            <div className="inline-flex rounded-lg border border-gray-200 p-0.5">
              {['INDIVIDUAL', 'BUSINESS'].map((t) => {
                const on = (form.purchaserType || 'INDIVIDUAL') === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => set('purchaserType')(t)}
                    className={`px-3 py-1 text-sm font-medium rounded-md ${on ? 'bg-gray-100 text-gray-900' : 'text-gray-500'}`}
                  >
                    {t === 'BUSINESS' ? 'Business' : 'Individual'}
                  </button>
                );
              })}
            </div>
            {(form.purchaserType || 'INDIVIDUAL') === 'BUSINESS' && (
              <TextInput label="Business name" value={form.businessName || ''} onChange={set('businessName')} />
            )}
            <TextInput label="Contact name" value={form.contactName || ''} onChange={set('contactName')} />
            <TextInput label="Billing email" type="email" value={form.email || ''} onChange={set('email')} />
            <TextInput label="Tax ID (optional)" value={form.taxId || ''} onChange={set('taxId')} />
            <TextInput label="Address" value={form.addressLine1 || ''} onChange={set('addressLine1')} />
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="City" value={form.city || ''} onChange={set('city')} />
              <TextInput label="State / region" value={form.state || ''} onChange={set('state')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="Postal code" value={form.postalCode || ''} onChange={set('postalCode')} />
              <TextInput label="Country (ISO-2)" value={form.country || ''} onChange={set('country')} maxLength={2} />
            </div>
          </div>
          <ModalActions>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <PrimaryButton loading={saving} onClick={save}>Save details</PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </section>
  );
}

// ─── InvoicesCard ────────────────────────────────────────────────────────────
function InvoicesCard({ transactions }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  async function openInvoice(tx) {
    setBusyId(tx.id);
    setError('');
    try {
      const res = await post(`/api/subscription/billing/invoices/${encodeURIComponent(tx.id)}`, {});
      if (res?.url) window.open(res.url, '_blank', 'noopener,noreferrer');
      else setError('That invoice isn’t ready to download yet.');
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not open that invoice.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Payment history</h2>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      {!transactions || transactions.length === 0 ? (
        <Empty text="No payments yet. Charges will appear here after your first paid renewal." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-100">
                <th scope="col" className="px-2 py-2 font-medium">Date</th>
                <th scope="col" className="px-2 py-2 font-medium">Amount</th>
                <th scope="col" className="px-2 py-2 font-medium">Status</th>
                <th scope="col" className="px-2 py-2 font-medium text-right">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id} className="border-b border-gray-50 last:border-0">
                  <td className="px-2 py-2 text-gray-700">{formatAdminDate(tx.billedAt || tx.paidAt || tx.createdAt)}</td>
                  <td className="px-2 py-2 text-gray-900 font-medium">
                    {tx.totalMinor != null ? formatMoneyMinor(tx.totalMinor, tx.currencyCode) : '—'}
                  </td>
                  <td className="px-2 py-2">
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${billingTransactionStatusClass(tx.status)}`}>
                      {statusLabel(tx.status)}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    {tx.hasInvoice ? (
                      <button
                        type="button"
                        onClick={() => openInvoice(tx)}
                        disabled={busyId === tx.id}
                        className="text-sm font-medium disabled:opacity-50"
                        style={{ color: 'var(--theme-primary)' }}
                      >
                        {busyId === tx.id ? 'Opening…' : 'Download'}
                      </button>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── BillingTab (default export) ─────────────────────────────────────────────
// ─── AddOnsCard ──────────────────────────────────────────────────────────────
// Sellable modules that stack on any plan (Talent Acquisition, …). "Add" hits
// the self-serve subscribe endpoint — a gateway checkout where an add-on price
// is configured, otherwise a time-boxed trial so the module works immediately.
function AddOnsCard({ canEdit }) {
  const [addOns, setAddOns] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try { const r = await get('/api/subscription/add-ons'); setAddOns(r?.addOns || []); }
    catch { setAddOns([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add(key) {
    setBusy(key); setErr(''); setMsg('');
    try {
      const r = await post(`/api/subscription/add-ons/${key}/subscribe`, {});
      if (r?.checkoutUrl) { window.location.assign(r.checkoutUrl); return; }
      setMsg(r?.status === 'trial_started' ? `Added — you’re on a ${r.trialDays}-day trial.` : 'Added to your plan.');
      await load();
    } catch (e) { setErr(e.data?.message || e.message || 'Could not add this module.'); }
    finally { setBusy(''); }
  }

  if (!addOns || addOns.length === 0) return null;
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <h3 className="text-sm font-semibold text-gray-900">Add-ons</h3>
      <p className="text-xs text-gray-500 mt-0.5">Extra modules you can add to any plan.</p>
      {msg && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mt-3">{msg}</p>}
      {err && <div className="mt-3"><ErrorBanner message={err} /></div>}
      <div className="mt-3 space-y-3">
        {addOns.map((a) => (
          <div key={a.key} className="flex items-start justify-between gap-3 border border-gray-100 rounded-xl p-3">
            <div>
              <div className="font-medium text-gray-900 text-sm">{a.name}</div>
              <div className="text-xs text-gray-500 mt-0.5 max-w-md">{a.blurb}</div>
              {a.price && <div className="text-[11px] text-gray-400 mt-1">{a.price.INR} · {a.price.NZD}</div>}
            </div>
            {a.enabled ? (
              <span className="shrink-0 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Included ✓</span>
            ) : (
              <button onClick={() => add(a.key)} disabled={!canEdit || busy === a.key}
                className="shrink-0 px-3 py-1.5 text-sm font-semibold rounded-lg text-white disabled:opacity-50"
                style={{ background: 'var(--theme-primary, #16B6A6)' }}>
                {busy === a.key ? '…' : 'Add'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BillingTab() {
  const [billing, setBilling] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canEdit, setCanEdit] = useState(true);

  const [cycle, setCycle] = useState('MONTHLY');
  const [picked, setPicked] = useState(null);     // plan chosen for the change modal
  const [actionBusy, setActionBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [billingRes, me] = await Promise.all([
        get('/api/subscription/billing'),
        get('/api/auth/me').catch(() => null),
      ]);
      setBilling(billingRes);
      const session = me?.user || me;
      setCanEdit(hasPermission(permissionsFromSession(session), 'canEditBilling'));
      // Workspace (plan catalog) + profile are best-effort — billing overview is
      // the must-have. A catalog failure shouldn't blank the whole page.
      const [ws, prof] = await Promise.all([
        get('/api/subscription/workspace').catch(() => null),
        get('/api/subscription/billing-profile').catch(() => null),
      ]);
      setWorkspace(ws?.workspace || null);
      setProfile(prof?.billingProfile || ws?.workspace?.billingProfile || null);
      if (billingRes?.overview?.billingCycle) setCycle(billingRes.overview.billingCycle);
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not load billing.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const overview = billing?.overview;
  const currentSlug = overview?.currentPlan?.slug || workspace?.subscription?.tier?.slug || 'free';
  const status = String(overview?.status || '').toUpperCase();
  const cancelScheduled = status === 'CANCEL_SCHEDULED' || overview?.pendingTierSlug === 'free';
  const hasPaidPlan = currentSlug && currentSlug !== 'free';
  const canOpenPortal = billing?.actions?.canOpenPortal;

  async function runAction(kind) {
    setActionBusy(kind);
    setActionError('');
    setNotice('');
    try {
      if (kind === 'portal') {
        const res = await post('/api/subscription/billing/portal', {});
        if (res?.url) window.open(res.url, '_blank', 'noopener,noreferrer');
        else setActionError('Could not open the billing portal just now.');
      } else if (kind === 'cancel') {
        const res = await post('/api/subscription/cancel', {});
        setNotice(
          res?.effectiveAt
            ? `Your plan stays active until ${formatAdminDate(res.effectiveAt)}, then switches to Free.`
            : 'Your cancellation has been scheduled.'
        );
        await load();
      } else if (kind === 'resume') {
        await post('/api/subscription/resume', {});
        setNotice('Your plan will keep renewing — the cancellation was undone.');
        await load();
      }
    } catch (err) {
      setActionError(err.data?.message || err.message || 'That didn’t work. Please try again.');
    } finally {
      setActionBusy('');
    }
  }

  if (loading) return <Spinner />;

  return (
    <div className="max-w-3xl space-y-6">
      {!canEdit && <BillingReadOnlyBanner />}
      {error && <ErrorBanner message={error} />}
      {actionError && <ErrorBanner message={actionError} />}
      {notice && (
        <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
          {notice}
        </p>
      )}

      <CurrentPlanCard overview={overview} />

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          {canOpenPortal && (
            <button
              type="button"
              onClick={() => runAction('portal')}
              disabled={actionBusy === 'portal'}
              className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {actionBusy === 'portal' ? 'Opening…' : 'Manage payment method'}
            </button>
          )}
          {hasPaidPlan && !cancelScheduled && (
            <button
              type="button"
              onClick={() => runAction('cancel')}
              disabled={actionBusy === 'cancel'}
              className="px-3 py-2 text-sm font-medium border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              {actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel plan'}
            </button>
          )}
          {cancelScheduled && (
            <button
              type="button"
              onClick={() => runAction('resume')}
              disabled={actionBusy === 'resume'}
              className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {actionBusy === 'resume' ? 'Resuming…' : 'Keep my plan'}
            </button>
          )}
        </div>
      )}

      {canEdit && workspace ? (
        <PlanPicker
          workspace={workspace}
          currentSlug={currentSlug}
          cycle={cycle}
          onCycle={setCycle}
          onPick={(v) => setPicked(v)}
          disabled={!!actionBusy}
        />
      ) : null}

      <AddOnsCard canEdit={canEdit} />

      <BillingProfileCard profile={profile} canEdit={canEdit} onSaved={setProfile} />

      <InvoicesCard transactions={billing?.transactions} />

      {picked && (
        <ChangePlanModal
          target={picked}
          cycle={cycle}
          onClose={() => setPicked(null)}
          onChanged={async () => {
            setPicked(null);
            setNotice('Your plan has been updated.');
            await load();
          }}
        />
      )}
    </div>
  );
}
