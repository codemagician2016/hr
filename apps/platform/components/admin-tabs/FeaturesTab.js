'use client';

// FeaturesTab — admin Settings panel for per-tenant feature toggles.
//
// Backend layout:
//   GET   /api/business/feature-flags     → { vertical, tier, catalog, adminOverrides, effective }
//   PATCH /api/business/settings          → accepts featureFlags: { key: bool } | null
//
// Rules surfaced in the UI:
//   • A plan-gated feature (planRequired === 'PAID') on a free tier shows
//     a disabled switch with an "Upgrade to enable" badge. The backend
//     enforces this — admin cannot opt in past their plan.
//   • Default-OFF features show a subtle "Off by default — opt in" hint.
//   • Default-ON features show "On by default" — the toggle is the
//     admin's opt-out.
//   • Foundation / coming-soon items are not switches. They are roadmap
//     cards only, because a seller toggle must change a complete user flow.
//   • Saving is debounced + optimistic with a snackbar-style status line.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton } from '@/components/admin-ui';

// Group features by their catalog "category" for a cleaner panel.
function groupByCategory(catalog) {
  const order = ['checkout', 'discovery', 'fulfillment', 'payments', 'retention', 'trust', 'content'];
  const groups = {};
  const entries = Array.isArray(catalog)
    ? catalog.map((item) => [item.key, item])
    : Object.entries(catalog).map(([key, meta]) => [key, { key, ...meta }]);
  for (const [key, meta] of entries) {
    const cat = meta.category || 'other';
    (groups[cat] = groups[cat] || []).push({ key, ...meta });
  }
  // Stable order: known categories first, others appended.
  const seen = new Set(order);
  return [
    ...order.filter((c) => groups[c]).map((c) => [c, groups[c]]),
    ...Object.keys(groups).filter((c) => !seen.has(c)).map((c) => [c, groups[c]]),
  ];
}

const CATEGORY_LABELS = {
  checkout: 'Checkout',
  discovery: 'Discovery & merchandising',
  fulfillment: 'Fulfillment',
  payments: 'Payments & refunds',
  retention: 'Retention & loyalty',
  trust: 'Trust & support',
  content: 'Content',
  domains: 'Domains',
  other: 'Other',
};
const ROLLOUT_LABELS = {
  LIVE: 'Available now',
  FOUNDATION: 'Backend foundation',
  COMING_SOON: 'Coming soon',
};
const ROADMAP_COPY = {
  FOUNDATION: 'Backend pieces exist, but the seller/customer journey is not complete enough to expose as a working switch.',
  COMING_SOON: 'Planned for a future commerce release. It is not active on the storefront today.',
};

function rolloutClasses(status) {
  if (status === 'LIVE') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
  if (status === 'FOUNDATION') return 'bg-blue-50 text-blue-700 ring-blue-200';
  return 'bg-slate-100 text-slate-600 ring-slate-200';
}

function rolloutStatus(meta) {
  return meta.rolloutStatus || 'LIVE';
}

function Toggle({ checked, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${disabled ? 'opacity-40 cursor-not-allowed' : ''} ${checked ? 'bg-green-600' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

export default function FeaturesTab() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [pending, setPending] = useState({});  // { key: bool } in-flight overrides
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api('/api/business/feature-flags');
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState({ loading: false, error: err?.message || 'Could not load features', data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const tierIsPaid = useMemo(() => {
    const slug = (state.data?.tier?.slug || '').toLowerCase();
    return !!slug && slug !== 'free' && slug !== 'trial';
  }, [state.data]);

  const catalogItems = useMemo(() => (
    state.data?.catalog
      ? Object.entries(state.data.catalog).map(([key, meta]) => ({ key, ...meta }))
      : []
  ), [state.data]);
  const liveItems = useMemo(() => catalogItems.filter((item) => rolloutStatus(item) === 'LIVE'), [catalogItems]);
  const roadmapItems = useMemo(() => catalogItems.filter((item) => rolloutStatus(item) !== 'LIVE'), [catalogItems]);
  const liveKeys = useMemo(() => new Set(liveItems.map((item) => item.key)), [liveItems]);
  const groups = useMemo(() => groupByCategory(liveItems), [liveItems]);
  const roadmapGroups = useMemo(() => groupByCategory(roadmapItems), [roadmapItems]);

  const save = useCallback(async (key, value) => {
    setPending((p) => ({ ...p, [key]: true }));
    setStatus('Saving…');
    try {
      // Send a partial overrides map; backend merges it onto the existing
      // featureFlags JSON via setting the whole object. We compose the next
      // shape locally and PATCH.
      const baseOverrides = Object.fromEntries(
        Object.entries(state.data?.adminOverrides || {}).filter(([overrideKey]) => liveKeys.has(overrideKey)),
      );
      const next = { ...baseOverrides, [key]: value };
      await api('/api/business/settings', { method: 'PATCH', body: JSON.stringify({ featureFlags: next }) });
      // Optimistic reflect locally + reload for the resolved/effective truth.
      setState((s) => ({ ...s, data: { ...s.data, adminOverrides: next } }));
      await load();
      setStatus('Saved.');
      setTimeout(() => setStatus(''), 1500);
    } catch (err) {
      setStatus(err?.message || 'Save failed');
    } finally {
      setPending((p) => { const n = { ...p }; delete n[key]; return n; });
    }
  }, [state.data, liveKeys, load]);

  if (state.loading) return <div className="p-6"><Spinner /></div>;
  if (state.error) return <ErrorBanner message={state.error} onRetry={load} />;
  if (!state.data) return null;

  const { adminOverrides, effective } = state.data;

  return (
    <div className="space-y-6 p-6">
      <header className="rounded-2xl border border-emerald-100 bg-emerald-50/70 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Storefront features</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-emerald-950/75">
              Switches only appear for features that change a complete customer-facing grocery flow. Backend foundations and roadmap
              ideas are shown separately so nobody mistakes them for broken toggles.
            </p>
          </div>
          <div className="flex gap-2 text-xs font-semibold">
            <span className="rounded-full bg-white px-3 py-1 text-emerald-700 ring-1 ring-emerald-200">{liveItems.length} available</span>
            <span className="rounded-full bg-white px-3 py-1 text-slate-600 ring-1 ring-slate-200">{roadmapItems.length} not live</span>
          </div>
        </div>
        {status && <div className="text-xs text-gray-500">{status}</div>}
      </header>

      {groups.length > 0 && groups.map(([cat, items]) => (
        <section key={cat} className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{CATEGORY_LABELS[cat] || cat}</h3>
          <div className="rounded-xl border border-gray-200 bg-white divide-y divide-gray-100">
            {items.map((f) => {
              const planLocked = f.planRequired === 'PAID' && !tierIsPaid;
              const isOn = !!effective[f.key];
              const override = adminOverrides[f.key];
              const explicitlyOff = override === false;
              const disabled = planLocked || !!pending[f.key];
              return (
                <div key={f.key} className="flex items-start gap-4 p-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="font-semibold text-gray-900">{f.label}</div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${rolloutClasses('LIVE')}`}>
                        Available
                      </span>
                      {planLocked && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold uppercase tracking-wide">Upgrade to enable</span>
                      )}
                      {!f.defaultOn && !planLocked && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium">Off by default — opt in</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600 mt-1 leading-snug">{f.description}</p>
                    {explicitlyOff && !planLocked && (
                      <p className="text-xs text-gray-500 mt-1">You have turned this off for your storefront.</p>
                    )}
                  </div>
                  <Toggle checked={isOn} disabled={disabled} onChange={(v) => save(f.key, v)} />
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {roadmapGroups.length > 0 && (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Not switchable yet</h3>
            <p className="mt-1 text-xs text-gray-500">
              These are intentionally not interactive until the full storefront, admin workflow, billing, and QA path are complete.
            </p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {roadmapGroups.flatMap(([, items]) => items).map((f) => {
              const rollout = rolloutStatus(f);
              return (
                <article key={f.key} className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-semibold text-gray-900">{f.label}</h4>
                        {f.planRequired === 'PAID' && (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800 ring-1 ring-amber-200">
                            Paid plan
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-sm leading-snug text-gray-600">{f.description}</p>
                      <p className="mt-2 text-xs leading-5 text-gray-500">{ROADMAP_COPY[rollout] || ROADMAP_COPY.COMING_SOON}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ring-1 ${rolloutClasses(rollout)}`}>
                      {ROLLOUT_LABELS[rollout] || 'Coming soon'}
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <footer className="flex items-center justify-between pt-2 border-t border-gray-100">
        <p className="text-xs text-gray-500">
          Plan: <span className="font-medium">{state.data.tier?.name || 'Free'}</span>
          {' · '}
          Vertical: <span className="font-medium">{state.data.vertical || '—'}</span>
        </p>
        <PrimaryButton onClick={load} variant="secondary">Refresh</PrimaryButton>
      </footer>
    </div>
  );
}
