'use client';

// Feature 25 — FBP / Flexi Basket plan builder. Author the basket: pick the ENVELOPE
// component (the CTC line that funds FBP), then add HEADS from the friendly list
// (LTA, Meal Card, Fuel & Car, Telephone & Internet, Books, Prof. Dev, Uniform) with
// per-head caps + a proof toggle + a pay cadence. "Start from India template" seeds
// the standard seven heads with default caps. Save is country-stamped + validated
// server-side (reads canViewCompensation, writes canManageCompensation).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PrimaryButton, ErrorBanner, TextInput } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';

const FY_DEFAULT = '2026-27';

function fmtCap(rupees) {
  if (rupees == null) return '—';
  return `₹${Number(rupees).toLocaleString('en-IN')}`;
}

export default function FbpPlansPage() {
  const [plans, setPlans] = useState([]);
  const [components, setComponents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // the draft plan being edited

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [planRes, compRes] = await Promise.all([
        get('/api/hr/fbp/plans'),
        get('/api/hr/compensation/components').catch(() => ({ items: [] })),
      ]);
      setPlans(planRes.items || []);
      setComponents(compRes.items || compRes.components || []);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load FBP plans.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startNew = useCallback(async () => {
    setError('');
    try {
      const tpl = await get('/api/hr/fbp/plans/template');
      setEditing({
        id: null,
        code: `FBP-${FY_DEFAULT}`,
        name: `Flexi Benefit Plan ${FY_DEFAULT}`,
        financialYear: FY_DEFAULT,
        envelopeComponentId: '',
        heads: (tpl.heads || []).map((h) => ({ ...h, componentId: '' })),
      });
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load the India template.');
    }
  }, []);

  const editPlan = useCallback((plan) => {
    setEditing({
      id: plan.id,
      code: plan.code,
      name: plan.name,
      financialYear: plan.financialYear,
      envelopeComponentId: plan.envelopeComponentId,
      heads: (plan.heads || []).map((h) => ({
        headType: h.headType, componentId: h.componentId, label: h.label,
        taxSection: h.taxSection, annualCapRupees: h.annualCapRupees, monthlyCapRupees: h.monthlyCapRupees,
        proofRequired: h.proofRequired, payCadence: h.payCadence, claimType: h.claimType, sortOrder: h.sortOrder,
      })),
    });
  }, []);

  const savePlan = useCallback(async () => {
    if (!editing) return;
    setError('');
    try {
      const payload = {
        code: editing.code, name: editing.name, financialYear: editing.financialYear,
        envelopeComponentId: editing.envelopeComponentId,
        heads: editing.heads.map((h, i) => ({
          headType: h.headType, componentId: h.componentId, label: h.label, taxSection: h.taxSection,
          annualCapRupees: h.annualCapRupees != null && h.annualCapRupees !== '' ? Number(h.annualCapRupees) : null,
          monthlyCapRupees: h.monthlyCapRupees != null && h.monthlyCapRupees !== '' ? Number(h.monthlyCapRupees) : null,
          proofRequired: h.proofRequired !== false, payCadence: h.payCadence || 'MONTHLY',
          claimType: h.claimType || null, sortOrder: i,
        })),
      };
      if (editing.id) await patch(`/api/hr/fbp/plans/${editing.id}`, payload);
      else await post('/api/hr/fbp/plans', payload);
      setEditing(null);
      await load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to save the plan.');
    }
  }, [editing, load]);

  const removePlan = useCallback(async (id) => {
    setError('');
    try { await del(`/api/hr/fbp/plans/${id}`); await load(); }
    catch (e) { setError(e.data?.message || e.message || 'Failed to delete the plan.'); }
  }, [load]);

  const setHead = (idx, patchObj) => {
    setEditing((prev) => ({ ...prev, heads: prev.heads.map((h, i) => (i === idx ? { ...h, ...patchObj } : h)) }));
  };

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="FBP plans"
        subtitle="Author the Flexi Benefit basket — the envelope component + the tax-advantaged heads with their statutory caps."
        actions={<PrimaryButton onClick={startNew}>Start from India template</PrimaryButton>}
      />
      {error && <ErrorBanner message={error} />}

      {!editing && (
        <div className="mt-4 space-y-3">
          {loading && <p className="text-sm text-gray-500">Loading…</p>}
          {!loading && plans.length === 0 && (
            <p className="text-sm text-gray-500">No FBP plans yet. Click “Start from India template” to create one.</p>
          )}
          {plans.map((p) => (
            <div key={p.id} className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{p.name}</div>
                  <div className="text-xs text-gray-500">{p.code} · FY {p.financialYear} · envelope: {p.envelopeComponent?.name || p.envelopeComponentId} · {p.heads?.length || 0} heads</div>
                </div>
                <div className="flex gap-2">
                  <button className="text-sm text-[var(--theme-primary)]" onClick={() => editPlan(p)}>Edit</button>
                  <button className="text-sm text-red-600" onClick={() => removePlan(p.id)}>Delete</button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {(p.heads || []).map((h) => (
                  <span key={h.id} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs">
                    {h.label} {h.monthlyCapRupees ? `· ${fmtCap(h.monthlyCapRupees)}/mo` : (h.annualCapRupees ? `· ${fmtCap(h.annualCapRupees)}/yr` : '')}{h.proofRequired ? '' : ' · no proof'}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <TextInput label="Code" value={editing.code} onChange={(v) => setEditing({ ...editing, code: v })} />
            <TextInput label="Name" value={editing.name} onChange={(v) => setEditing({ ...editing, name: v })} />
            <TextInput label="Financial year" value={editing.financialYear} onChange={(v) => setEditing({ ...editing, financialYear: v })} />
          </div>
          <div className="mt-3">
            <label className="block text-sm font-medium text-gray-700">
              Envelope component <InfoTip text="The single CTC earning line that funds the whole FBP basket. The heads allocate within its resolved monthly amount." />
            </label>
            <select
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={editing.envelopeComponentId}
              onChange={(e) => setEditing({ ...editing, envelopeComponentId: e.target.value })}
            >
              <option value="">— pick the FBP envelope component —</option>
              {components.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
            </select>
          </div>

          <h3 className="mt-5 text-sm font-semibold uppercase tracking-wide text-gray-500">Basket heads</h3>
          <div className="mt-2 space-y-3">
            {editing.heads.map((h, idx) => (
              <div key={`${h.headType}-${idx}`} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{h.label}{h.tooltip ? <InfoTip text={h.tooltip} /> : null}</div>
                  <span className="text-xs text-gray-400">{h.taxSection ? `§${h.taxSection}` : ''} · {h.payCadence}</span>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-4">
                  <div>
                    <label className="block text-xs text-gray-500">Pay component</label>
                    <select className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm" value={h.componentId || ''} onChange={(e) => setHead(idx, { componentId: e.target.value })}>
                      <option value="">— pick —</option>
                      {components.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <TextInput label="Monthly cap ₹" type="number" value={h.monthlyCapRupees ?? ''} onChange={(v) => setHead(idx, { monthlyCapRupees: v })} />
                  <TextInput label="Annual cap ₹" type="number" value={h.annualCapRupees ?? ''} onChange={(v) => setHead(idx, { annualCapRupees: v })} />
                  <label className="mt-5 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={h.proofRequired !== false} onChange={(e) => setHead(idx, { proofRequired: e.target.checked, claimType: e.target.checked ? h.claimType : null })} />
                    Proof required
                  </label>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex gap-2">
            <PrimaryButton onClick={savePlan}>Save plan</PrimaryButton>
            <button className="text-sm text-gray-500" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      <p className="mt-6 text-xs text-gray-400">
        See also the <Link href="/compensation/fbp/allocations" className="underline">FBP allocation console</Link>.
      </p>
    </div>
  );
}
