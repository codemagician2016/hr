'use client';

// ECOMMERCE Path B Phase 6b (2026-05-01) — TaxPanel
// Polish pass 2026-05-08: jurisdiction hero card + ecom-ui primitives
// + cleaner rates editor.
// Backend: /api/ecom/tax/* (Phase 6a).

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  KpiCard, KpiGrid,
  PageHeader, ErrorBanner, PrimaryButton, SecondaryButton,
  fmtNumber,
} from '@/components/ecom-ui';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `${res.status}`);
  return body;
}

const JURISDICTIONS = [
  {
    key: 'NONE', label: 'No tax', shortLabel: 'NONE', icon: '⊘',
    accent: 'gray', headline: 'Tax handled externally',
    helper: 'Use this if a 3rd-party POS or accounting system computes tax outside Sitepresso.',
  },
  {
    key: 'UK_VAT', label: 'United Kingdom — VAT', shortLabel: 'UK VAT', icon: '🇬🇧',
    accent: 'blue', headline: 'VAT-registered, UK',
    helper: 'Standard rate 20%. Reduced 5% for energy, kids car seats, etc. Zero-rated for most groceries.',
  },
  {
    key: 'IN_GST', label: 'India — GST', shortLabel: 'IN GST', icon: '🇮🇳',
    accent: 'amber', headline: 'GST-registered, India',
    helper: 'Slabs: 0% (essentials), 5% (necessities), 12% (standard), 18% (most), 28% (luxury).',
  },
  {
    key: 'EU_VAT', label: 'European Union — VAT', shortLabel: 'EU VAT', icon: '🇪🇺',
    accent: 'indigo', headline: 'VAT-registered, EU',
    helper: 'Rates vary per member state (17–27%). OSS scheme applies for cross-border B2C.',
  },
];
const ACCENT_BG = {
  gray:   'from-gray-50 to-gray-100 border-gray-200 text-gray-700',
  blue:   'from-blue-50 to-indigo-50 border-blue-200 text-blue-900',
  amber:  'from-amber-50 to-orange-50 border-amber-200 text-amber-900',
  indigo: 'from-indigo-50 to-purple-50 border-indigo-200 text-indigo-900',
};

function fmt(minor) {
  if (minor === null || minor === undefined) return '—';
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100); }
  catch { return `${(minor / 100).toFixed(2)}`; }
}

function genId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const INPUT_CLS = 'w-full px-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-indigo-500';
function L({ children, hint }) {
  return (
    <label className="block text-xs font-medium text-gray-700 mb-1">
      {children}{hint && <span className="ml-1.5 text-[10px] font-normal text-gray-400">{hint}</span>}
    </label>
  );
}

export default function TaxPanel() {
  const [config, setConfig] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [c, s] = await Promise.all([
        api('/api/ecom/tax/config'),
        api('/api/ecom/tax/summary'),
      ]);
      setConfig(c); setSummary(s); setDirty(false);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  function update(field, value) { setConfig((c) => ({ ...c, [field]: value })); setDirty(true); }
  function addRate() { update('rates', [...(config.rates || []), { id: genId(), label: 'New rate', percent: 0, isDefault: false }]); }
  function updateRate(idx, patch) {
    const next = [...config.rates]; next[idx] = { ...next[idx], ...patch }; update('rates', next);
  }
  function removeRate(idx) { update('rates', config.rates.filter((_, i) => i !== idx)); }

  async function save() {
    setBusy(true); setError('');
    try { await api('/api/ecom/tax/config', { method: 'PUT', body: JSON.stringify(config) }); await reload(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  // Jurisdiction metadata for the hero card
  const jurisdictionMeta = useMemo(
    () => JURISDICTIONS.find((j) => j.key === config?.jurisdiction) || JURISDICTIONS[0],
    [config?.jurisdiction],
  );
  const defaultRate = useMemo(
    () => config?.rates?.find((r) => r.isDefault)?.percent ?? config?.defaultRate ?? null,
    [config?.rates, config?.defaultRate],
  );

  if (loading && !config) {
    return <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center text-sm text-gray-500">Loading…</div>;
  }
  if (!config) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tax configuration"
        subtitle={
          <>
            Jurisdiction: <strong>{jurisdictionMeta.label}</strong> · {config.rates?.length || 0} rate{config.rates?.length === 1 ? '' : 's'} defined
            {dirty && <span className="ml-3 text-amber-700 font-semibold">UNSAVED CHANGES</span>}
          </>
        }
        actions={dirty ? <PrimaryButton onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</PrimaryButton> : null}
      />

      {/* Hero card — instantly answers "what tax am I set up for?" */}
      <div className={`rounded-2xl border bg-gradient-to-br p-6 ${ACCENT_BG[jurisdictionMeta.accent]}`}>
        <div className="flex items-start gap-4">
          <span className="text-5xl leading-none">{jurisdictionMeta.icon}</span>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-mono uppercase tracking-[0.22em] opacity-70">Active tax setup</p>
            <h3 className="text-2xl font-bold mt-0.5">{jurisdictionMeta.headline}</h3>
            <p className="text-sm opacity-80 mt-1">{jurisdictionMeta.helper}</p>
          </div>
          {defaultRate !== null && (
            <div className="text-right shrink-0">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] opacity-70">Default rate</p>
              <p className="text-4xl font-black mt-0.5 tabular-nums">{defaultRate}%</p>
            </div>
          )}
        </div>
      </div>

      <KpiGrid cols={4}>
        <KpiCard label="Tax this quarter" value={summary ? fmt(summary.taxCollectedQuarterMinor) : '—'} hint="From paid orders" />
        <KpiCard label="Tax · 30 days" value={summary ? fmt(summary.taxCollected30dMinor) : '—'} />
        <KpiCard label="Default rate" value={defaultRate != null ? `${defaultRate}%` : '—'} />
        <KpiCard label="Rates defined" value={fmtNumber(summary?.ratesCount ?? config.rates?.length)} />
      </KpiGrid>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {/* Jurisdiction picker — visual cards */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">Switch jurisdiction</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          {JURISDICTIONS.map((j) => {
            const isActive = j.key === config.jurisdiction;
            return (
              <button key={j.key} type="button" onClick={() => update('jurisdiction', j.key)}
                className={`text-left p-3 rounded-xl border-2 transition-all ${
                  isActive ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:border-indigo-300'
                }`}>
                <div className="flex items-start gap-2">
                  <span className="text-2xl leading-none">{j.icon}</span>
                  <div className="min-w-0">
                    <p className={`text-xs font-bold ${isActive ? 'text-indigo-900' : 'text-gray-900'}`}>{j.shortLabel}</p>
                    <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-2 leading-tight">{j.headline}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
        <div>
          <L hint="Used when a product has no tax category override">Default rate (%)</L>
          <input type="number" step="0.01" min="0" max="100"
            value={config.defaultRate ?? 0}
            onChange={(e) => update('defaultRate', Number(e.target.value))}
            className={`${INPUT_CLS} font-mono w-32`} />
        </div>
      </div>

      {/* Rates editor */}
      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Tax rates</h3>
            <p className="text-xs text-gray-500 mt-0.5">Map per-product tax categories in Catalogue → product detail.</p>
          </div>
          <SecondaryButton onClick={addRate}>+ Add rate</SecondaryButton>
        </div>
        {(config.rates || []).length === 0 ? (
          <p className="p-6 text-xs text-gray-500">No rates defined. Click <strong>+ Add rate</strong> to add UK VAT 20%, GST slabs, etc.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {config.rates.map((r, i) => (
              <div key={r.id} className="p-4 flex items-center gap-3 flex-wrap">
                <input type="text" value={r.label} onChange={(e) => updateRate(i, { label: e.target.value })}
                  className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg border border-gray-300 text-sm" />
                <div className="flex items-center gap-1 bg-gray-50 rounded-lg border border-gray-300 pr-2 pl-3">
                  <input type="number" step="0.01" min="0" max="100" value={r.percent}
                    onChange={(e) => updateRate(i, { percent: Number(e.target.value) })}
                    className="w-16 py-1.5 text-sm font-mono bg-transparent focus:outline-none" />
                  <span className="text-xs text-gray-500 font-mono">%</span>
                </div>
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={!!r.isDefault} onChange={(e) => updateRate(i, { isDefault: e.target.checked })} />
                  Default
                </label>
                <button type="button" onClick={() => removeRate(i)}
                  className="text-xs font-semibold text-red-700 hover:underline ml-auto">Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Invoice settings */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900">Invoice settings</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <L hint="Prepended to invoice numbers">Invoice prefix</L>
            <input type="text" value={config.invoicePrefix || ''} onChange={(e) => update('invoicePrefix', e.target.value)} maxLength={20}
              placeholder="INV"
              className={`${INPUT_CLS} font-mono`} />
          </div>
        </div>
        <div>
          <L hint="Legal text printed at the bottom of every invoice (GST/VAT lines, T&Cs)">Invoice footer</L>
          <textarea value={config.invoiceFooter || ''} onChange={(e) => update('invoiceFooter', e.target.value)} rows={3} maxLength={2000}
            className={INPUT_CLS} />
        </div>
      </div>
    </div>
  );
}
