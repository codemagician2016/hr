'use client';

// Feature 17 — CTC Policies workspace. The friendly, layman two-pane builder:
//   LEFT  = rule rows (pick a component, choose "% of …" / "Fixed ₹/month" /
//           "Auto-balance" / "Statutory", reorder).
//   RIGHT = sticky live CTC statement (the shared <CtcStatement>) at a sample CTC,
//           with the green/red "Basic ≥ 50% of CTC" chip. Save is disabled while red.
//
// Backs onto /api/hr/ctc-policies/* (reads need canViewCompensation, writes
// canManageCompensation — enforced backend-side). countryCode/currency are the
// tenant's (read-only here, server-stamped on save). No NZ surface for an IN tenant.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { TextInput, PrimaryButton, ErrorBanner } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { InfoTip } from '@/lib/widgets';
import CtcStatement from './CtcStatement';

const SAMPLE_CTC = 1200000; // ₹12,00,000 default sample

const METHODS = [
  { key: 'PERCENT_OF', label: '% of …', tip: 'A percentage of the CTC, the gross, or another component (e.g. HRA = 50% of Basic).' },
  { key: 'FLAT', label: 'Fixed ₹/month', tip: 'A fixed monthly amount, the same every month (e.g. Conveyance ₹1,600).' },
  { key: 'BALANCING', label: 'Auto-balance', tip: 'Soaks up whatever is left so the components add up to the CTC. Only one allowed.' },
  { key: 'STATUTORY', label: 'Statutory (auto by law)', tip: 'Calculated by Indian law (PF / ESI / Gratuity). You do not set this.' },
];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

// One editable rule row.
function RuleRow({ row, components, onChange, onRemove, onMove }) {
  const comp = components.find((c) => c.id === row.componentId);
  const isBalancing = row.calcMethod === 'BALANCING';
  const isStatutory = row.calcMethod === 'STATUTORY';
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex flex-col gap-0.5">
          <button type="button" aria-label="Move up" onClick={() => onMove(-1)} className="text-gray-300 hover:text-gray-600 text-xs leading-none">▲</button>
          <button type="button" aria-label="Move down" onClick={() => onMove(1)} className="text-gray-300 hover:text-gray-600 text-xs leading-none">▼</button>
        </div>
        <select
          value={row.componentId}
          onChange={(e) => onChange({ ...row, componentId: e.target.value })}
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
        >
          <option value="">Pick a pay component…</option>
          {components.map((c) => (
            <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
          ))}
        </select>
        <button type="button" onClick={onRemove} className="text-gray-400 hover:text-red-600 px-2" aria-label="Remove row">✕</button>
      </div>

      <div className="flex items-center gap-2 flex-wrap pl-6">
        <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
          {METHODS.map((m) => (
            <button
              key={m.key}
              type="button"
              title={m.tip}
              onClick={() => onChange({ ...row, calcMethod: m.key })}
              className={`px-2.5 py-1.5 text-xs font-medium ${row.calcMethod === m.key ? 'bg-[color:var(--theme-primary)] text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <InfoTip text={(METHODS.find((m) => m.key === row.calcMethod) || {}).tip || ''} />
      </div>

      {row.calcMethod === 'PERCENT_OF' && (
        <div className="flex items-center gap-2 pl-6">
          <input
            type="range" min="0" max="100" step="1" value={num(row.pct)}
            onChange={(e) => onChange({ ...row, pct: e.target.value })}
            className="flex-1 accent-[color:var(--theme-primary)]"
          />
          <input
            type="number" min="0" max="100" value={row.pct ?? ''}
            onChange={(e) => onChange({ ...row, pct: e.target.value })}
            className="w-20 px-2 py-1.5 border border-gray-300 rounded-lg text-sm text-right"
          />
          <span className="text-sm text-gray-500">% of</span>
          <select
            value={row.baseCode || 'CTC'}
            onChange={(e) => onChange({ ...row, baseCode: e.target.value })}
            className="px-2 py-1.5 border border-gray-300 rounded-lg text-sm bg-white"
          >
            <option value="CTC">CTC</option>
            <option value="GROSS">Gross</option>
            {components.filter((c) => c.id !== row.componentId).map((c) => (
              <option key={c.id} value={c.code}>{c.code}</option>
            ))}
          </select>
        </div>
      )}
      {row.calcMethod === 'FLAT' && (
        <div className="flex items-center gap-2 pl-6">
          <span className="text-sm text-gray-500">₹</span>
          <input
            type="number" min="0" value={row.flatMonthly ?? ''}
            onChange={(e) => onChange({ ...row, flatMonthly: e.target.value })}
            className="w-36 px-2 py-1.5 border border-gray-300 rounded-lg text-sm text-right"
            placeholder="per month"
          />
          <span className="text-sm text-gray-500">/ month</span>
        </div>
      )}
      {isBalancing && (
        <p className="pl-6 text-xs text-gray-500">This component soaks up whatever's left so the total equals the CTC.</p>
      )}
      {isStatutory && (
        <p className="pl-6 text-xs text-gray-500">Calculated automatically by Indian law — you don't set this.</p>
      )}
      {comp && <p className="pl-6 text-[11px] text-gray-400">Kind: {comp.kind} · {comp.category}</p>}
    </div>
  );
}

function blankRow() { return { componentId: '', calcMethod: 'PERCENT_OF', pct: 0, baseCode: 'CTC', flatMonthly: '' }; }

function Builder({ initial, components, country, currency, onSaved, onCancel }) {
  const [name, setName] = useState(initial?.name || '');
  const [code, setCode] = useState(initial?.code || '');
  const [rows, setRows] = useState(() => (initial?.lines?.length
    ? initial.lines.map((l) => ({ componentId: l.componentId, calcMethod: l.calcMethod, pct: l.pct != null ? l.pct : 0, baseCode: l.baseCode || 'CTC', flatMonthly: l.flatMonthly != null ? l.flatMonthly : '' }))
    : [blankRow()]));
  const [sampleCtc, setSampleCtc] = useState(SAMPLE_CTC);
  const [verdictOk, setVerdictOk] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const isEdit = !!initial?.id;

  // The preview body — an ad-hoc draft of the current rows (lines only). The right
  // pane debounces this to /ctc-policies/preview.
  const lines = rows
    .filter((r) => r.componentId)
    .map((r, i) => ({
      componentId: r.componentId,
      calcMethod: r.calcMethod,
      pct: r.calcMethod === 'PERCENT_OF' ? num(r.pct) : undefined,
      flatMonthly: r.calcMethod === 'FLAT' ? num(r.flatMonthly) : undefined,
      baseCode: r.calcMethod === 'PERCENT_OF' ? r.baseCode : undefined,
      sortOrder: i,
    }));
  const previewBody = lines.length ? { lines, ctcAnnual: sampleCtc } : null;

  function setRow(idx, next) { setRows((rs) => rs.map((r, i) => (i === idx ? next : r))); }
  function removeRow(idx) { setRows((rs) => rs.filter((_, i) => i !== idx)); }
  function moveRow(idx, dir) {
    setRows((rs) => {
      const j = idx + dir;
      if (j < 0 || j >= rs.length) return rs;
      const copy = rs.slice();
      [copy[idx], copy[j]] = [copy[j], copy[idx]];
      return copy;
    });
  }

  async function save() {
    setError(''); setSaving(true);
    try {
      const payload = { name, code, lines };
      const saved = isEdit
        ? await patch(`/api/hr/ctc-policies/${initial.id}`, payload)
        : await post('/api/hr/ctc-policies', payload);
      onSaved(saved);
    } catch (e) {
      setError(e.data?.errors ? e.data.errors.join(' ') : (e.data?.message || e.message || 'Could not save the policy.'));
    } finally { setSaving(false); }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <TextInput label={<>Policy name <InfoTip text="A friendly label, e.g. 'Staff CTC 2026'." /></>} value={name} onChange={setName} required />
          <TextInput label={<>Code <InfoTip text="A short unique id for this policy, e.g. STAFF-2026." /></>} value={code} onChange={setCode} required />
        </div>
        <p className="text-xs text-gray-500">
          Country <span className="font-medium text-gray-700">{country}</span> · currency <span className="font-medium text-gray-700">{currency}</span>
          <InfoTip text="Your company is registered in India; all pay follows Indian rules. This can't be changed here." />
        </p>

        <div className="space-y-2">
          {rows.map((r, i) => (
            <RuleRow
              key={i}
              row={r}
              components={components}
              onChange={(next) => setRow(i, next)}
              onRemove={() => removeRow(i)}
              onMove={(dir) => moveRow(i, dir)}
            />
          ))}
          <button type="button" onClick={() => setRows((rs) => [...rs, blankRow()])} className="text-sm font-medium text-[color:var(--theme-primary)] hover:underline">+ Add a component rule</button>
        </div>

        {error && <ErrorBanner message={error} />}
        <div className="flex gap-2">
          <PrimaryButton onClick={save} loading={saving} disabled={verdictOk === false || !name || !code || !lines.length}>
            {isEdit ? 'Save changes' : 'Create policy'}
          </PrimaryButton>
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
        </div>
        {verdictOk === false && <p className="text-xs text-red-600">Save is blocked while Basic is below 50% of CTC.</p>}
      </div>

      <div className="space-y-3 lg:sticky lg:top-4 self-start">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Preview at sample CTC</span>
          <input type="range" min="300000" max="5000000" step="100000" value={sampleCtc} onChange={(e) => setSampleCtc(num(e.target.value))} className="flex-1 accent-[color:var(--theme-primary)]" />
          <span className="text-sm font-medium text-gray-700 tabular-nums">₹{sampleCtc.toLocaleString('en-IN')}</span>
        </div>
        <CtcStatement
          previewPath="/api/hr/ctc-policies/preview"
          previewBody={previewBody}
          currency={currency}
          onVerdict={(v) => setVerdictOk(v ? v.ok : null)}
        />
        {isEdit && (
          <button
            type="button"
            onClick={async () => {
              try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/hr/ctc-policies/${initial.id}/statement.pdf`, {
                  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ctcAnnual: sampleCtc }),
                });
                if (!res.ok) throw new Error('Could not download the statement.');
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = `ctc-policy-${initial.code}-sample.pdf`;
                document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
              } catch (e) { setError(e.message); }
            }}
            className="text-sm font-medium text-[color:var(--theme-primary)] hover:underline"
          >
            Download sample statement (PDF)
          </button>
        )}
      </div>
    </div>
  );
}

export default function CtcPoliciesPage() {
  const [policies, setPolicies] = useState([]);
  const [components, setComponents] = useState([]);
  const [country, setCountry] = useState('IN');
  const [currency, setCurrency] = useState('INR');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | {} (new) | policy (edit)

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [pol, comps, ctx] = await Promise.all([
        get('/api/hr/ctc-policies').catch(() => ({ items: [] })),
        get('/api/hr/compensation/components', { pageSize: 100 }).catch(() => ({ items: [] })),
        get('/api/hr/country-context').catch(() => null),
      ]);
      setPolicies(asList(pol));
      setComponents(asList(comps));
      if (ctx) { setCountry(ctx.country || ctx.countryCode || 'IN'); setCurrency(ctx.currency || ctx.currencyCode || 'INR'); }
    } catch (e) {
      setError(e.data?.message || e.message || 'Could not load CTC policies.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function startFromTemplate() {
    try {
      const draft = await get('/api/hr/ctc-policies/defaults');
      setEditing({ name: draft.name, code: draft.code, lines: draft.lines });
    } catch (e) { setError(e.data?.message || 'Could not load the India starter template.'); }
  }

  async function remove(id) {
    if (!confirm('Delete this CTC policy? Existing hires are unaffected.')) return;
    try { await del(`/api/hr/ctc-policies/${id}`); load(); } catch (e) { setError(e.data?.message || e.message); }
  }

  if (editing) {
    return (
      <div className="max-w-5xl">
        <button onClick={() => setEditing(null)} className="text-sm text-gray-500 hover:underline">← Back to CTC policies</button>
        <h1 className="text-2xl font-semibold text-gray-900 mt-2 mb-6">{editing.id ? 'Edit CTC policy' : 'New CTC policy'}</h1>
        <Builder
          initial={editing}
          components={components}
          country={country}
          currency={currency}
          onSaved={() => { setEditing(null); load(); }}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">CTC policies</h1>
          <p className="text-sm text-gray-500 mt-1">Reusable salary templates. Build once, then onboard people by picking a policy + a target CTC.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={startFromTemplate} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Start from India template</button>
          <PrimaryButton onClick={() => setEditing({})}>New policy</PrimaryButton>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : policies.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 p-10 text-center">
          <p className="text-gray-600 font-medium">Create your first CTC policy</p>
          <p className="text-sm text-gray-400 mt-1 mb-4">A policy describes how to split a CTC into Basic, HRA, allowances and statutory costs.</p>
          <button onClick={startFromTemplate} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Start from India template</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {policies.map((p) => (
            <div key={p.id} className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900">{p.name}</h3>
                  <p className="text-xs text-gray-400 font-mono">{p.code} · {p.countryCode}/{p.currencyCode}</p>
                </div>
                <span className={`text-xs rounded-full px-2 py-0.5 ${p.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{p.isActive ? 'Active' : 'Inactive'}</span>
              </div>
              <p className="text-xs text-gray-500 mt-2">
                {(p.lines || []).slice(0, 4).map((l) => `${l.component?.code || l.componentId}: ${l.calcMethod === 'PERCENT_OF' ? `${l.pct}% of ${l.baseCode}` : l.calcMethod === 'FLAT' ? `₹${l.flatMonthly}` : l.calcMethod === 'BALANCING' ? 'balancing' : 'statutory'}`).join(' · ')}
              </p>
              <div className="flex gap-3 mt-3 text-sm">
                <button onClick={() => setEditing(p)} className="text-[color:var(--theme-primary)] font-medium hover:underline">Edit</button>
                <Link href={`/people/onboard?policyId=${p.id}`} className="text-[color:var(--theme-primary)] font-medium hover:underline">Onboard with this</Link>
                <button onClick={() => remove(p.id)} className="text-red-600 hover:underline">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
