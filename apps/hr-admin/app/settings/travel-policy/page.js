'use client';

// Travel & Expense Policy builder (Feature 11) — the centerpiece. A non-technical
// admin configures, in four plain tables, the rules the policy engine auto-validates
// every bill against:
//   1. Per-diem — daily food + incidentals caps by trip-duration band.
//   2. Hotel    — a grid of nightly caps by employee LEVEL (Grade.rank) × city TIER.
//   3. Transport — a card per mode with allowed?, per-km, fare cap, class, min hours.
//   4. City tiers — assign cities to Tier 1/2/3 + the default tier.
// Plus an Enforcement switch (Flag vs Hard) and a live "what would this trip cost vs
// policy" preview that runs the real engine server-side.
//
// All gated by canManageExpensePolicy. CRUD → /api/hr/expenses/policies(/:id),
// grid saves → PUT /policies/:id/{perdiem,hotel,transport}, tiers → /city-tiers.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@hr/ui';
import { get, post, patch, put, del } from '@/lib/apiExt';
import { PageHeader, Tabs } from '@/lib/ui';
import { InfoTip, FieldLabel, SectionTitle } from '@/lib/widgets';
import { useTenantCountries } from '@/lib/useTenantCountries';

const TIERS = ['TIER_1', 'TIER_2', 'TIER_3'];
const BANDS = [['FULL_24H', 'Full day (24h)'], ['HALF_12H', 'Half (12h)'], ['HALF_DAY', 'Half-day']];
const MODES = [['PUBLIC_TRANSPORT', 'Public transport'], ['TAXI_CAB', 'Taxi / cab'], ['SELF_CAR', 'Own car (per-km)'], ['TRAIN', 'Train'], ['FLIGHT', 'Flight']];

// India-first country options for the policy/city pickers. Constrain to the
// tenant's operating countries; when unknown, default to India alone (the NZ
// engine stays intact — it just isn't surfaced to an India-only tenant).
const COUNTRY_META = { IN: { label: 'India (INR)', short: 'IN' }, NZ: { label: 'New Zealand (NZD)', short: 'NZ' } };
function countryChoices(countries) {
  const list = Array.isArray(countries) && countries.length ? countries : ['IN'];
  // Keep a stable India-first order.
  return ['IN', 'NZ'].filter((c) => list.includes(c)).map((c) => ({ value: c, ...COUNTRY_META[c] }));
}

export default function TravelPolicyPage() {
  const [policies, setPolicies] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [grades, setGrades] = useState([]);
  const [tab, setTab] = useState('perdiem');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const { countries } = useTenantCountries();
  const choices = countryChoices(countries);
  const multiCountry = choices.length > 1;

  const loadPolicies = useCallback(() => {
    get('/api/hr/expenses/policies', { pageSize: 50 })
      .then((d) => { setPolicies(d.items || []); if (!activeId && d.items?.length) setActiveId(d.items[0].id); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [activeId]);

  useEffect(() => { loadPolicies(); get('/api/hr/org/grades').then((d) => setGrades((d.items || d || []))).catch(() => {}); }, [loadPolicies]);
  useEffect(() => { if (activeId) get(`/api/hr/expenses/policies/${activeId}`).then(setPolicy).catch((e) => setError(e.message)); }, [activeId]);

  async function createPolicy() {
    setError('');
    try {
      // Default to the tenant's first operating country (India-first when single).
      const cc = choices[0]?.value || 'IN';
      const currencyCode = cc === 'NZ' ? 'NZD' : 'INR';
      const p = await post('/api/hr/expenses/policies', { name: 'New travel policy', countryCode: cc, currencyCode, effectiveFrom: new Date().toISOString().slice(0, 10) });
      setActiveId(p.id); loadPolicies();
    } catch (e) { setError(e.data?.message || e.message); }
  }
  async function savePolicy(patchBody) {
    try { const p = await patch(`/api/hr/expenses/policies/${activeId}`, patchBody); setPolicy(p); loadPolicies(); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  if (loading) return <div className="p-8 text-gray-500">Loading…</div>;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Travel & Expense policy" subtitle="Set the allowances and rules — every submitted bill is checked against them automatically." />
      {error && <ErrorBanner message={error} />}

      <div className="mb-5 flex items-center gap-3">
        <select value={activeId || ''} onChange={(e) => setActiveId(e.target.value)} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm">
          {policies.length === 0 && <option value="">— no policy yet —</option>}
          {policies.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.countryCode})</option>)}
        </select>
        <button onClick={createPolicy} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm hover:bg-gray-50">+ New policy</button>
      </div>

      {!policy ? <p className="text-gray-500">Create a policy to start.{multiCountry ? ' India + New Zealand are supported.' : ''}</p> : (
        <>
          <PolicyHeader policy={policy} onSave={savePolicy} choices={choices} />
          <Tabs
            active={tab} onChange={setTab}
            tabs={[
              { key: 'perdiem', label: 'Per-diem' },
              { key: 'hotel', label: 'Hotel budget' },
              { key: 'transport', label: 'Transport' },
              { key: 'cities', label: 'City tiers' },
              { key: 'preview', label: 'Preview' },
            ]}
          />
          {tab === 'perdiem' && <PerDiemTab policy={policy} onSaved={() => setActiveId(activeId)} reload={() => get(`/api/hr/expenses/policies/${activeId}`).then(setPolicy)} />}
          {tab === 'hotel' && <HotelTab policy={policy} grades={grades} reload={() => get(`/api/hr/expenses/policies/${activeId}`).then(setPolicy)} />}
          {tab === 'transport' && <TransportTab policy={policy} grades={grades} reload={() => get(`/api/hr/expenses/policies/${activeId}`).then(setPolicy)} />}
          {tab === 'cities' && <CityTiersTab choices={choices} />}
          {tab === 'preview' && <PreviewTab policy={policy} grades={grades} />}
        </>
      )}
    </div>
  );
}

function PolicyHeader({ policy, onSave, choices = [{ value: 'IN', label: 'India (INR)' }] }) {
  // Always include the policy's own country so an existing NZ policy still renders
  // its value even on a tenant whose operating set has since narrowed.
  const opts = choices.some((c) => c.value === policy.countryCode)
    ? choices
    : [...choices, { value: policy.countryCode, label: COUNTRY_META[policy.countryCode]?.label || policy.countryCode }];
  return (
    <div className="mb-5 grid gap-3 rounded-xl border bg-gray-50 p-4 sm:grid-cols-4">
      <label className="block text-sm"><FieldLabel tip="A name for this policy set.">Name</FieldLabel>
        <input defaultValue={policy.name} onBlur={(e) => e.target.value !== policy.name && onSave({ name: e.target.value })} className="w-full rounded border px-2 py-1.5" /></label>
      <label className="block text-sm"><FieldLabel tip="The country this policy applies to. Drives the currency and sensible defaults.">Country</FieldLabel>
        <select defaultValue={policy.countryCode} onChange={(e) => onSave({ countryCode: e.target.value, currencyCode: e.target.value === 'NZ' ? 'NZD' : 'INR' })} className="w-full rounded border px-2 py-1.5">{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label className="block text-sm"><FieldLabel tip="The tier used when a city isn't listed in the city-tier map.">Default tier</FieldLabel>
        <select defaultValue={policy.defaultTier} onChange={(e) => onSave({ defaultTier: e.target.value })} className="w-full rounded border px-2 py-1.5">{TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
      <label className="block text-sm">
        <FieldLabel tip="Flag over-budget bills for the approver to decide (soft), or automatically reject bills over the hard cap (the employee can't even submit them).">Enforcement</FieldLabel>
        <select defaultValue={policy.enforcement} onChange={(e) => onSave({ enforcement: e.target.value })} className="w-full rounded border px-2 py-1.5">
          <option value="FLAG">Flag for approver (soft)</option>
          <option value="HARD">Auto-reject over hard cap</option>
        </select>
      </label>
    </div>
  );
}

function PerDiemTab({ policy, reload }) {
  const [rows, setRows] = useState(() => BANDS.map(([b]) => {
    const r = (policy.perDiemRules || []).find((x) => x.durationBand === b && x.gradeRank == null && x.cityTier == null);
    return { durationBand: b, foodCap: r?.foodCap ?? '', incidentalCap: r?.incidentalCap ?? '' };
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setBusy(true); setErr('');
    try {
      const rules = rows.filter((r) => r.foodCap !== '' || r.incidentalCap !== '').map((r) => ({ durationBand: r.durationBand, foodCap: r.foodCap || 0, incidentalCap: r.incidentalCap || 0 }));
      await put(`/api/hr/expenses/policies/${policy.id}/perdiem`, { rules });
      await reload();
    } catch (e) { setErr(e.data?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <SectionTitle tip="These are the daily allowances for meals and small expenses while travelling.">Daily allowances (per-diem)</SectionTitle>
      {err && <ErrorBanner message={err} />}
      <table className="mt-3 w-full max-w-lg text-sm">
        <thead><tr className="text-left text-gray-500"><th className="py-1">Trip length</th><th>Food cap</th><th>Incidentals cap</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.durationBand} className="border-t">
              <td className="py-1">{BANDS.find(([b]) => b === r.durationBand)[1]}</td>
              <td><input type="number" value={r.foodCap} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, foodCap: e.target.value } : x))} className="w-28 rounded border px-2 py-1" /></td>
              <td><input type="number" value={r.incidentalCap} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, incidentalCap: e.target.value } : x))} className="w-28 rounded border px-2 py-1" /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={save} disabled={busy} className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save per-diem'}</button>
    </div>
  );
}

function HotelTab({ policy, grades, reload }) {
  const levels = (grades || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const initial = {};
  for (const r of policy.hotelRules || []) initial[`${r.gradeRank}|${r.cityTier}`] = r.nightlyCap;
  const [cells, setCells] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setBusy(true); setErr('');
    try {
      const rules = [];
      for (const lvl of levels) for (const tier of TIERS) {
        const v = cells[`${lvl.rank}|${tier}`];
        if (v !== undefined && v !== '') rules.push({ gradeRank: lvl.rank, cityTier: tier, nightlyCap: v });
      }
      await put(`/api/hr/expenses/policies/${policy.id}/hotel`, { rules });
      await reload();
    } catch (e) { setErr(e.data?.message || e.message); } finally { setBusy(false); }
  }

  if (!levels.length) return <p className="text-gray-500">No grades/levels defined yet. Add Grades under People & Org first — the hotel budget is set per level.</p>;
  return (
    <div>
      <SectionTitle tip="How much per night each employee level can spend in each kind of city.">Hotel budget (per night) by level × city tier</SectionTitle>
      {err && <ErrorBanner message={err} />}
      <div className="mt-3 overflow-x-auto">
        <table className="text-sm">
          <thead><tr className="text-left text-gray-500"><th className="py-1 pr-4">Level</th>{TIERS.map((t) => <th key={t} className="px-2">{t}</th>)}</tr></thead>
          <tbody>
            {levels.map((lvl) => (
              <tr key={lvl.id} className="border-t">
                <td className="py-1 pr-4 font-medium">{lvl.name} <span className="text-xs text-gray-400">L{lvl.rank}</span></td>
                {TIERS.map((tier) => (
                  <td key={tier} className="px-2">
                    <input type="number" value={cells[`${lvl.rank}|${tier}`] ?? ''} onChange={(e) => setCells((c) => ({ ...c, [`${lvl.rank}|${tier}`]: e.target.value }))} className="w-24 rounded border px-2 py-1" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={save} disabled={busy} className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save hotel matrix'}</button>
    </div>
  );
}

function TransportTab({ policy, grades, reload }) {
  const [rows, setRows] = useState(() => MODES.map(([m]) => {
    const r = (policy.transportRules || []).find((x) => x.mode === m && x.gradeRank == null);
    return { mode: m, allowed: r ? r.allowed : true, perKmRate: r?.perKmRate ?? '', fareCap: r?.fareCap ?? '', travelClass: r?.travelClass ?? '', minJourneyHrs: r?.minJourneyHrs ?? '' };
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const upd = (i, k, v) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, [k]: v } : x));

  async function save() {
    setBusy(true); setErr('');
    try {
      const rules = rows.map((r) => ({ mode: r.mode, allowed: r.allowed, perKmRate: r.perKmRate || undefined, fareCap: r.fareCap || undefined, travelClass: r.travelClass || undefined, minJourneyHrs: r.minJourneyHrs || undefined }));
      await put(`/api/hr/expenses/policies/${policy.id}/transport`, { rules });
      await reload();
    } catch (e) { setErr(e.data?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div>
      <SectionTitle tip="Which travel modes are allowed and the fare rules for each.">Transport modes & fare rules</SectionTitle>
      {err && <ErrorBanner message={err} />}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {rows.map((r, i) => (
          <div key={r.mode} className="rounded-xl border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-medium">{MODES.find(([m]) => m === r.mode)[1]}</span>
              <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={r.allowed} onChange={(e) => upd(i, 'allowed', e.target.checked)} /> Allowed</label>
            </div>
            {r.allowed && (
              <div className="grid grid-cols-2 gap-2 text-xs">
                {r.mode === 'SELF_CAR' && <label>Per-km rate<input type="number" value={r.perKmRate} onChange={(e) => upd(i, 'perKmRate', e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1" /></label>}
                <label>Fare cap<input type="number" value={r.fareCap} onChange={(e) => upd(i, 'fareCap', e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1" /></label>
                {(r.mode === 'TRAIN' || r.mode === 'FLIGHT') && <label>Class<input value={r.travelClass} onChange={(e) => upd(i, 'travelClass', e.target.value)} placeholder={r.mode === 'TRAIN' ? 'AC_3T' : 'ECONOMY'} className="mt-0.5 w-full rounded border px-2 py-1" /></label>}
                {r.mode === 'FLIGHT' && <label className="flex flex-col">Min journey hrs <span className="inline"><InfoTip text="Flight is allowed only when the journey is at least this many hours." /></span><input type="number" value={r.minJourneyHrs} onChange={(e) => upd(i, 'minJourneyHrs', e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1" /></label>}
              </div>
            )}
          </div>
        ))}
      </div>
      <button onClick={save} disabled={busy} className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save transport rules'}</button>
    </div>
  );
}

function CityTiersTab({ choices = [{ value: 'IN', short: 'IN' }] }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ city: '', tier: 'TIER_1', countryCode: choices[0]?.value || 'IN' });
  const [err, setErr] = useState('');
  const reload = useCallback(() => get('/api/hr/expenses/city-tiers', { pageSize: 100 }).then((d) => setRows(d.items || [])).catch((e) => setErr(e.message)), []);
  useEffect(() => { reload(); }, [reload]);

  async function add() {
    setErr('');
    try { await post('/api/hr/expenses/city-tiers', form); setForm({ ...form, city: '' }); reload(); }
    catch (e) { setErr(e.data?.message || e.message); }
  }
  async function remove(id) { try { await del(`/api/hr/expenses/city-tiers/${id}`); reload(); } catch (e) { setErr(e.message); } }

  return (
    <div>
      <SectionTitle tip="Assign cities to a tier. Metros are usually Tier 1, large cities Tier 2, the rest Tier 3. Hotel + per-diem caps key off this.">City tiers</SectionTitle>
      {err && <ErrorBanner message={err} />}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-sm">City<input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="mt-0.5 block rounded border px-2 py-1" /></label>
        <label className="text-sm">Tier<select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })} className="mt-0.5 block rounded border px-2 py-1">{TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
        <label className="text-sm">Country<select value={form.countryCode} onChange={(e) => setForm({ ...form, countryCode: e.target.value })} className="mt-0.5 block rounded border px-2 py-1">{choices.map((o) => <option key={o.value} value={o.value}>{o.short || o.value}</option>)}</select></label>
        <button onClick={add} disabled={!form.city} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">Add</button>
      </div>
      <table className="mt-4 w-full max-w-lg text-sm">
        <thead><tr className="text-left text-gray-500"><th className="py-1">City</th><th>Tier</th><th>Country</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t"><td className="py-1 capitalize">{r.city}</td><td>{r.tier}</td><td>{r.countryCode}</td><td><button onClick={() => remove(r.id)} className="text-xs text-red-600">Remove</button></td></tr>
          ))}
          {!rows.length && <tr><td colSpan={4} className="py-2 text-gray-400">No cities mapped — unlisted cities use the default tier.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function PreviewTab({ policy, grades }) {
  const levels = (grades || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const [form, setForm] = useState({ gradeRank: levels[0]?.rank ?? '', destCity: '', journeyHours: '', hotel: '', hotelNights: '1', flight: '' });
  const [result, setResult] = useState(null);
  const [err, setErr] = useState('');

  async function run() {
    setErr('');
    const lines = [];
    if (form.hotel) lines.push({ amount: Number(form.hotel), nights: Number(form.hotelNights || 1) });
    if (form.flight) lines.push({ amount: Number(form.flight), transportMode: 'FLIGHT' });
    try {
      const r = await post('/api/hr/expenses/policies/preview', { policyId: policy.id, gradeRank: form.gradeRank, destCity: form.destCity, countryCode: policy.countryCode, journeyHours: form.journeyHours || undefined, lines });
      setResult(r);
    } catch (e) { setErr(e.data?.message || e.message); }
  }

  return (
    <div>
      <SectionTitle tip="See what a sample trip would cost vs this policy before you save — exactly the verdicts an employee's bills will get.">What would this trip cost vs policy?</SectionTitle>
      {err && <ErrorBanner message={err} />}
      <div className="mt-3 grid max-w-2xl gap-2 sm:grid-cols-3">
        <label className="text-xs">Level<select value={form.gradeRank} onChange={(e) => setForm({ ...form, gradeRank: e.target.value })} className="mt-0.5 block w-full rounded border px-2 py-1">{levels.map((l) => <option key={l.id} value={l.rank}>{l.name} (L{l.rank})</option>)}</select></label>
        <label className="text-xs">Destination city<input value={form.destCity} onChange={(e) => setForm({ ...form, destCity: e.target.value })} className="mt-0.5 block w-full rounded border px-2 py-1" /></label>
        <label className="text-xs">Journey hours<input type="number" value={form.journeyHours} onChange={(e) => setForm({ ...form, journeyHours: e.target.value })} className="mt-0.5 block w-full rounded border px-2 py-1" /></label>
        <label className="text-xs">Hotel bill<input type="number" value={form.hotel} onChange={(e) => setForm({ ...form, hotel: e.target.value })} className="mt-0.5 block w-full rounded border px-2 py-1" /></label>
        <label className="text-xs">Nights<input type="number" value={form.hotelNights} onChange={(e) => setForm({ ...form, hotelNights: e.target.value })} className="mt-0.5 block w-full rounded border px-2 py-1" /></label>
        <label className="text-xs">Flight bill<input type="number" value={form.flight} onChange={(e) => setForm({ ...form, flight: e.target.value })} className="mt-0.5 block w-full rounded border px-2 py-1" /></label>
      </div>
      <button onClick={run} className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white">Run preview</button>
      {result && (
        <div className="mt-4 rounded-xl border p-3 text-sm">
          <div className="mb-2 text-gray-500">Resolved tier: <b>{result.cityTier}</b> · Level L{result.gradeRank} · {result.currencyCode}</div>
          <ul className="space-y-1">
            {result.lines.map((l, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${l.verdict === 'OK' ? 'bg-green-100 text-green-800' : l.verdict === 'FLAGGED' ? 'bg-amber-100 text-amber-800' : l.verdict === 'AUTO_REJECTED' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}`}>{l.verdict}</span>
                <span className="text-gray-600">{l.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
