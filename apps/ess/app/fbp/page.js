'use client';

// Feature 25 — ESS Flexi Benefits (FBP). The hero is a single budget bar ("Your FBP
// allowance ₹X/year"); below it a row per head with a ₹ input capped at the head's
// statutory cap, a live "remaining to allocate ₹Y", and a live "Tax you save ₹Z/year"
// panel (the computeFbpSplit + tax-with/without preview). Each head shows its
// exemption in plain English. Submit is gated to the OPEN window. Under NEW regime the
// basket shows as pay with a quiet "exemption is OLD-regime only" banner. India-only
// (country-gated client-side + the backend 422s a non-IN request).

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import InfoTip from '@/components/InfoTip';
import { Spinner, ErrorBanner, Empty } from '@hr/ui';
import { apiGet, apiPost } from '@/lib/api';
import { money } from '@/lib/format';
import { useCountry } from '@/lib/useCountry';

const FBP_PATH = '/api/hr/me/fbp';

export default function FbpPage() {
  const { country, loading: countryLoading } = useCountry();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [alloc, setAlloc] = useState({}); // headId → annual ₹
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiGet(FBP_PATH)
      .then((res) => {
        setData(res);
        const init = {};
        for (const h of res.heads || []) init[h.headId] = h.allocated || 0;
        setAlloc(init);
      })
      .catch((e) => setError(e.message || 'Could not load your flexi benefits.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (countryLoading) return;
    if (country !== 'IN') { setLoading(false); return; }
    load();
  }, [country, countryLoading, load]);

  const envelope = data ? data.envelopeAnnual : 0;
  const allocatedTotal = useMemo(() => Object.values(alloc).reduce((s, v) => s + (Number(v) || 0), 0), [alloc]);
  const remaining = envelope - allocatedTotal;
  const overAllocated = remaining < 0;

  // Debounced live preview (tax you save).
  useEffect(() => {
    if (!data || !data.plan) return undefined;
    const lines = Object.entries(alloc).map(([headId, annual]) => ({ headId, annual: Number(annual) || 0 }));
    const t = setTimeout(() => {
      apiPost(`${FBP_PATH}/preview`, { lines })
        .then(setPreview)
        .catch(() => {});
    }, 350);
    return () => clearTimeout(t);
  }, [alloc, data]);

  const setHeadAlloc = (headId, value, cap) => {
    let v = Math.max(0, Number(value) || 0);
    if (cap != null && v > cap) v = cap;
    setAlloc((prev) => ({ ...prev, [headId]: v }));
  };

  const submit = useCallback(async () => {
    if (overAllocated) { setError('Reduce your allocation — it exceeds your FBP allowance.'); return; }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const lines = Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([headId, annual]) => ({ headId, annual: Number(annual) }));
      await apiPost(FBP_PATH, { lines, status: 'SUBMITTED' });
      setNotice('Your flexi benefits allocation has been submitted.');
      load();
    } catch (e) {
      setError(e.message || 'Could not submit your allocation.');
    } finally {
      setSaving(false);
    }
  }, [alloc, overAllocated, load]);

  const windowOpen = data && data.window && data.window.status === 'OPEN';
  const canSubmit = data && (!data.window || windowOpen);

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <header>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Flexi Benefits (FBP)</h1>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
            Allocate your flexi allowance across tax-advantaged heads and see the tax you save — live.
          </p>
        </header>

        {(countryLoading || loading) && <Spinner />}
        {!countryLoading && country !== 'IN' && <Empty text="Flexi Benefits are available for India only." />}
        {error && <ErrorBanner message={error} />}
        {notice && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}

        {!loading && data && country === 'IN' && !data.plan && (
          <Empty text="No Flexi Benefit plan is configured for this year yet." />
        )}

        {!loading && data && country === 'IN' && data.plan && (
          <>
            {!data.isOldRegime && (
              <div className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
                These benefits still pay you, but the tax exemption applies only under the OLD regime — switch in your Tax Declaration to optimise.
              </div>
            )}

            {/* Hero budget bar */}
            <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>Your FBP allowance</span>
                <span className="text-lg font-bold" style={{ color: 'var(--theme-text)' }}>{money(envelope, 'INR')}/year</span>
              </div>
              <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-gray-100">
                <div className="h-full" style={{ width: `${envelope > 0 ? Math.min(100, (allocatedTotal / envelope) * 100) : 0}%`, background: overAllocated ? '#dc2626' : 'var(--theme-primary)' }} />
              </div>
              <div className="mt-1 flex items-center justify-between text-xs" style={{ color: overAllocated ? '#dc2626' : 'var(--theme-muted)' }}>
                <span>Allocated {money(allocatedTotal, 'INR')}</span>
                <span>{overAllocated ? `Over by ${money(-remaining, 'INR')}` : `Remaining to allocate ${money(remaining, 'INR')}`}</span>
              </div>
            </section>

            {/* Per-head allocation rows */}
            <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
              <div className="space-y-3">
                {(data.heads || []).map((h) => {
                  const cap = h.annualCap != null ? h.annualCap : (h.monthlyCap != null ? h.monthlyCap * 12 : null);
                  return (
                    <div key={h.headId} className="border-b border-gray-100 pb-3 last:border-0">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                          {h.label}
                          {h.taxSection ? <span className="ml-1 text-xs" style={{ color: 'var(--theme-muted)' }}>§{h.taxSection}</span> : null}
                        </div>
                        <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                          {cap != null ? `cap ${money(cap, 'INR')}/yr` : 'against bills'}
                          {h.payCadence === 'ON_CLAIM' ? ' · pays on claim' : ''}
                        </div>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="number"
                          min={0}
                          max={cap == null ? undefined : cap}
                          value={alloc[h.headId] ?? 0}
                          onChange={(e) => setHeadAlloc(h.headId, e.target.value, cap)}
                          className="w-32 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                        />
                        <span className="text-xs" style={{ color: 'var(--theme-muted)' }}>₹/year</span>
                        {data.isOldRegime && <span className="text-xs text-emerald-600">exempt {money(h.exempt || 0, 'INR')}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Live tax you save */}
            {data.isOldRegime && preview && (
              <section className="rounded-2xl border p-4" style={{ borderColor: 'var(--theme-primary)', background: 'var(--theme-primary-soft, #f0fdfa)' }}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Tax you save</span>
                  <span className="text-xl font-bold" style={{ color: 'var(--theme-primary)' }}>{money(preview.taxSaved || 0, 'INR')}/year</span>
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
                  Exempt this allocation: {money(preview.exempt || 0, 'INR')} · tax without FBP {money(preview.taxWithout || 0, 'INR')} → with FBP {money(preview.taxWith || 0, 'INR')}
                </div>
              </section>
            )}

            {/* Window + submit */}
            <div className="flex items-center justify-between">
              <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                {data.window
                  ? `Window ${data.window.status}${data.window.proofDeadline ? ` · upload bills by ${String(data.window.proofDeadline).slice(0, 10)}` : ''}`
                  : 'No allocation window set — your declaration is provisional.'}
              </div>
              <button
                onClick={submit}
                disabled={saving || overAllocated || !canSubmit}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: 'var(--theme-primary)' }}
              >
                {saving ? 'Submitting…' : 'Submit allocation'}
              </button>
            </div>

            <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
              Upload your bills (LTA, fuel, telephone, books…) on the{' '}
              <a href="/tax/proofs" className="underline">Investment proofs</a> page — the FBP heads appear alongside 80C/HRA.
              {' '}After the deadline only verified bills stay tax-free.
            </p>
          </>
        )}
      </div>
    </AppShell>
  );
}
