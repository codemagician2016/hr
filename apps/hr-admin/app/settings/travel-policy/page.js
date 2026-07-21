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
//
// Feature 45 adds two STANDALONE tabs (they do not need a travel policy):
//   6. Categories & limits — expense-category CRUD + per-category flat limits
//      (PUT /categories/:id/policy) + a per-JOB-LEVEL cap override grid
//      (PUT /categories/:id/policy/grade-rules, replace-all).
//   7. Approval & payout — the HR escalation threshold (GET/PATCH /expenses/settings)
//      and each entity's default reimbursement payout channel (PATCH /org/entities/:id).

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '@hr/ui';
import { get, post, patch, put, del } from '@/lib/apiExt';
import { PageHeader, Tabs } from '@/lib/ui';
import { InfoTip, FieldLabel, SectionTitle } from '@/lib/widgets';
import { useTenantCountries } from '@/lib/useTenantCountries';
import ModuleGuide from '@/components/ModuleGuide';

const TIERS = ['TIER_1', 'TIER_2', 'TIER_3'];
// The five original tabs need a travel policy selected; the Feature 45 tabs are standalone.
const TRAVEL_TABS = ['perdiem', 'hotel', 'transport', 'cities', 'preview'];
const BANDS = [['FULL_24H', 'Full day (24h)'], ['HALF_12H', 'Half (12h)'], ['HALF_DAY', 'Half-day']];
const MODES = [['PUBLIC_TRANSPORT', 'Public transport'], ['TAXI_CAB', 'Taxi / cab'], ['SELF_CAR', 'Own car (per-km)'], ['TRAIN', 'Train'], ['FLIGHT', 'Flight']];

// India-only country options for the policy/city pickers. The product is
// single-country India (Feature 14); when unknown, default to India alone.
const COUNTRY_META = { IN: { label: 'India (INR)', short: 'IN' } };
function countryChoices(countries) {
  const list = Array.isArray(countries) && countries.length ? countries : ['IN'];
  // Only India is registrable, so the choices collapse to India.
  return ['IN'].filter((c) => list.includes(c)).map((c) => ({ value: c, ...COUNTRY_META[c] }));
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
      // Default to the tenant's operating country (India).
      const cc = choices[0]?.value || 'IN';
      const currencyCode = 'INR';
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
      <ModuleGuide
        id="settings-travel-policy"
        title="Build the travel policy your expense engine enforces"
        what="This is where you define, in plain tables, the allowances for business travel — daily meal/incidental caps, nightly hotel budgets, transport fare rules and city tiers. Every reimbursement bill an employee submits is auto-checked against these caps, so you stop policing receipts by hand."
        steps={[
          'Click + New policy (or pick an existing one) — it defaults to India / INR.',
          'In the header, set the Default tier (for unlisted cities) and Enforcement: Flag for approver (soft) or Auto-reject over hard cap.',
          'Per-diem tab: set Food and Incidentals caps for each trip length (Full 24h, Half 12h, Half-day).',
          'Hotel budget tab: fill the nightly cap grid for each employee level (Grade) × city tier — add Grades under People & Org first if the grid is empty.',
          'Transport tab: toggle which modes are Allowed and set fare caps, per-km rate (own car), class (train/flight) and the min journey hours for flights.',
          'City tiers tab: map metros to Tier 1, large cities to Tier 2, the rest Tier 3.',
          'Preview tab: run a sample trip to see the exact OK / FLAGGED / AUTO_REJECTED verdicts before you rely on it.',
          'Categories & limits tab: create the everyday reimbursement categories (fuel, food, internet) with per-claim / per-day / per-month caps — plus optional per-job-level overrides.',
          'Approval & payout tab: set the claim amount above which HR is added after the manager, and each entity’s default payout channel (separately vs via payroll).',
        ]}
        example={<>For <b>Acme India Pvt Ltd</b>, you tag <b>Mumbai</b> and <b>Bengaluru</b> as Tier 1 and set the L3 manager hotel cap there to <b>₹6,500/night</b>. Aarav Sharma (L3) books a <b>₹7,200/night</b> hotel in Mumbai for 2 nights — with Enforcement on <b>Flag</b>, the bill is auto-FLAGGED at ₹700/night over and routed to his approver instead of silently passing.</>}
        tips={[
          'Hard enforcement blocks the employee from even submitting an over-cap bill; Flag still lets the approver decide — start with Flag.',
          'A city with no tier mapping falls back to the policy Default tier, so set that deliberately (Tier 3 is the safe, lowest-cap default).',
        ]}
      />
      {error && <ErrorBanner message={error} />}

      <Tabs
        active={tab} onChange={setTab}
        tabs={[
          { key: 'perdiem', label: 'Per-diem' },
          { key: 'hotel', label: 'Hotel budget' },
          { key: 'transport', label: 'Transport' },
          { key: 'cities', label: 'City tiers' },
          { key: 'preview', label: 'Preview' },
          { key: 'categories', label: 'Categories & limits' },
          { key: 'payout', label: 'Approval & payout' },
        ]}
      />

      {TRAVEL_TABS.includes(tab) && (
        <>
          <div className="mb-5 flex items-center gap-3">
            <select value={activeId || ''} onChange={(e) => setActiveId(e.target.value)} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm">
              {policies.length === 0 && <option value="">— no policy yet —</option>}
              {policies.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.countryCode})</option>)}
            </select>
            <button onClick={createPolicy} className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm hover:bg-gray-50">+ New policy</button>
          </div>

          {!policy ? <p className="text-gray-500">Create a policy to start.</p> : (
            <>
              <PolicyHeader policy={policy} onSave={savePolicy} choices={choices} />
              {tab === 'perdiem' && <PerDiemTab policy={policy} onSaved={() => setActiveId(activeId)} reload={() => get(`/api/hr/expenses/policies/${activeId}`).then(setPolicy)} />}
              {tab === 'hotel' && <HotelTab policy={policy} grades={grades} reload={() => get(`/api/hr/expenses/policies/${activeId}`).then(setPolicy)} />}
              {tab === 'transport' && <TransportTab policy={policy} grades={grades} reload={() => get(`/api/hr/expenses/policies/${activeId}`).then(setPolicy)} />}
              {tab === 'cities' && <CityTiersTab choices={choices} />}
              {tab === 'preview' && <PreviewTab policy={policy} grades={grades} />}
            </>
          )}
        </>
      )}

      {tab === 'categories' && <CategoriesTab grades={grades} />}
      {tab === 'payout' && <ApprovalPayoutTab />}
    </div>
  );
}

function PolicyHeader({ policy, onSave, choices = [{ value: 'IN', label: 'India (INR)' }] }) {
  // Always include the policy's own country so an existing policy still renders
  // its value even on a tenant whose operating set has since narrowed.
  const opts = choices.some((c) => c.value === policy.countryCode)
    ? choices
    : [...choices, { value: policy.countryCode, label: COUNTRY_META[policy.countryCode]?.label || policy.countryCode }];
  return (
    <div className="mb-5 grid gap-3 rounded-xl border bg-gray-50 p-4 sm:grid-cols-4">
      <label className="block text-sm"><FieldLabel tip="A name for this policy set.">Name</FieldLabel>
        <input defaultValue={policy.name} onBlur={(e) => e.target.value !== policy.name && onSave({ name: e.target.value })} className="w-full rounded border px-2 py-1.5" /></label>
      <label className="block text-sm"><FieldLabel tip="The country this policy applies to. Drives the currency and sensible defaults.">Country</FieldLabel>
        <select defaultValue={policy.countryCode} onChange={(e) => onSave({ countryCode: e.target.value, currencyCode: 'INR' })} className="w-full rounded border px-2 py-1.5">{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
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

// ═══ Feature 45 — Categories & limits (standalone reimbursement config) ═══════════

function CategoriesTab({ grades }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [form, setForm] = useState({ code: '', name: '', glCode: '' });
  const [creating, setCreating] = useState(false);

  const reload = useCallback(() => (
    get('/api/hr/expenses/categories')
      .then((d) => setItems(d.items || []))
      .catch((e) => setErr(e.data?.message || e.message))
      .finally(() => setLoading(false))
  ), []);
  useEffect(() => { reload(); }, [reload]);

  async function create() {
    setCreating(true); setErr('');
    try {
      await post('/api/hr/expenses/categories', { code: form.code.trim().toUpperCase(), name: form.name.trim(), glCode: form.glCode.trim() || undefined });
      setForm({ code: '', name: '', glCode: '' });
      reload();
    } catch (e) { setErr(e.data?.message || e.message); } finally { setCreating(false); }
  }

  return (
    <div>
      <SectionTitle tip="Everyday reimbursement categories (fuel, food, internet, …) with their own spending limits — separate from the travel tables. Employees pick a category when raising a claim and every bill is auto-checked against these caps.">Expense categories & limits</SectionTitle>
      {err && <ErrorBanner message={err} />}

      <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border bg-gray-50 p-3">
        <label className="block text-sm"><FieldLabel tip="A short unique code for this category (e.g. FUEL).">Code</FieldLabel>
          <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="FUEL" className="block w-28 rounded border px-2 py-1" /></label>
        <label className="block text-sm"><FieldLabel tip="The name employees see when picking a category.">Name</FieldLabel>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Fuel & mileage" className="block w-48 rounded border px-2 py-1" /></label>
        <label className="block text-sm"><FieldLabel tip="Optional general-ledger account code for accounting exports.">GL code</FieldLabel>
          <input value={form.glCode} onChange={(e) => setForm({ ...form, glCode: e.target.value })} className="block w-28 rounded border px-2 py-1" /></label>
        <button onClick={create} disabled={creating || !form.code.trim() || !form.name.trim()} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{creating ? 'Adding…' : '+ Add category'}</button>
      </div>

      {loading ? <p className="mt-4 text-gray-500">Loading…</p> : !items.length ? (
        <p className="mt-4 text-gray-400">No categories yet — add one above.</p>
      ) : (
        <div className="mt-4 space-y-4">
          {items.map((c) => <CategoryCard key={c.id} category={c} grades={grades} onChanged={reload} onError={setErr} />)}
        </div>
      )}
    </div>
  );
}

function CategoryCard({ category, grades, onChanged, onError }) {
  // The category's flat policy (one per category server-side; newest first).
  const policy = (category.policies || []).find((p) => p.isActive) || (category.policies || [])[0] || null;

  async function saveField(body) {
    try { await patch(`/api/hr/expenses/categories/${category.id}`, body); onChanged(); }
    catch (e) { onError(e.data?.message || e.message); }
  }
  async function remove() {
    if (!confirm(`Delete category "${category.name}"? Employees can no longer pick it; past claims keep their history.`)) return;
    try { await del(`/api/hr/expenses/categories/${category.id}`); onChanged(); }
    catch (e) { onError(e.data?.message || e.message); }
  }

  return (
    <div className="rounded-xl border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs text-gray-500">Code
          <input defaultValue={category.code} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== category.code) saveField({ code: v }); }} className="mt-0.5 block w-24 rounded border px-2 py-1 text-sm text-gray-900" /></label>
        <label className="block text-xs text-gray-500">Name
          <input defaultValue={category.name} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== category.name) saveField({ name: v }); }} className="mt-0.5 block w-44 rounded border px-2 py-1 text-sm text-gray-900" /></label>
        <label className="block text-xs text-gray-500">GL code
          <input defaultValue={category.glCode || ''} onBlur={(e) => { const v = e.target.value.trim(); if (v !== (category.glCode || '')) saveField({ glCode: v || null }); }} className="mt-0.5 block w-24 rounded border px-2 py-1 text-sm text-gray-900" /></label>
        <label className="flex items-center gap-1 pb-1.5 text-xs text-gray-700">
          <input type="checkbox" checked={category.isActive !== false} onChange={(e) => saveField({ isActive: e.target.checked })} /> Active
          <InfoTip text="Inactive categories are hidden from employees but keep their history." />
        </label>
        <div className="grow" />
        <button onClick={remove} className="pb-1.5 text-xs text-red-600 hover:underline">Delete</button>
      </div>

      <LimitsEditor category={category} policy={policy} onSaved={onChanged} />
      <GradeRulesGrid category={category} policy={policy} grades={grades} />
    </div>
  );
}

function LimitsEditor({ category, policy, onSaved }) {
  const [form, setForm] = useState({
    maxPerClaim: policy?.maxPerClaim ?? '',
    dailyCap: policy?.dailyCap ?? '',
    maxPerMonth: policy?.maxPerMonth ?? '',
    requireReceipt: policy ? !!policy.requireReceipt : true,
    enforcement: policy?.enforcement || 'FLAG',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const num = (v) => (v === '' || v == null ? null : Number(v));

  async function save() {
    setBusy(true); setErr('');
    try {
      await put(`/api/hr/expenses/categories/${category.id}/policy`, {
        maxPerClaim: num(form.maxPerClaim),
        dailyCap: num(form.dailyCap),
        maxPerMonth: num(form.maxPerMonth),
        requireReceipt: form.requireReceipt,
        enforcement: form.enforcement,
      });
      onSaved();
    } catch (e) { setErr(e.data?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="mt-4 rounded-lg bg-gray-50 p-3">
      <SectionTitle tip="The flat spending limits for this category. Leave a cap blank for no limit. Per-level overrides below refine these.">Limits</SectionTitle>
      {err && <ErrorBanner message={err} />}
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="block text-xs"><FieldLabel tip="The most a single bill in this category may be.">Per-claim cap</FieldLabel>
          <input type="number" value={form.maxPerClaim} onChange={(e) => setForm({ ...form, maxPerClaim: e.target.value })} className="block w-28 rounded border px-2 py-1" /></label>
        <label className="block text-xs"><FieldLabel tip="The most an employee may claim in this category per day.">Per-day cap</FieldLabel>
          <input type="number" value={form.dailyCap} onChange={(e) => setForm({ ...form, dailyCap: e.target.value })} className="block w-28 rounded border px-2 py-1" /></label>
        <label className="block text-xs"><FieldLabel tip="The most an employee may claim in this category per calendar month.">Per-month cap</FieldLabel>
          <input type="number" value={form.maxPerMonth} onChange={(e) => setForm({ ...form, maxPerMonth: e.target.value })} className="block w-28 rounded border px-2 py-1" /></label>
        <label className="flex items-center gap-1 pb-1.5 text-xs text-gray-700">
          <input type="checkbox" checked={form.requireReceipt} onChange={(e) => setForm({ ...form, requireReceipt: e.target.checked })} /> Receipt required
          <InfoTip text="When on, a bill without an attached receipt is flagged for the approver." />
        </label>
        <label className="block text-xs"><FieldLabel tip="FLAG records an over-cap bill and flags it for the approver to review. HARD blocks the employee from even submitting it.">Enforcement</FieldLabel>
          <select value={form.enforcement} onChange={(e) => setForm({ ...form, enforcement: e.target.value })} className="block rounded border px-2 py-1">
            <option value="FLAG">Flag for review (soft)</option>
            <option value="HARD">Block submission (hard)</option>
          </select></label>
        <button onClick={save} disabled={busy} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : policy ? 'Save limits' : 'Set limits'}</button>
      </div>
      {!policy && <p className="mt-2 text-xs text-amber-700">No limits set yet — set the flat limits first to enable the per-level grid below.</p>}
    </div>
  );
}

// Per-JOB-LEVEL cap override grid (replace-all PUT). Rows = "All levels" + each grade
// (by rank); a blank cell falls back to the flat limit; a fully-blank row is omitted.
// NOTE: the list endpoint does not echo saved gradeRules, so the grid seeds from the
// PUT response within the session; re-save the full grid rather than a partial edit.
function GradeRulesGrid({ category, policy, grades }) {
  const levels = (grades || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
  const rows = [{ rank: null, label: 'All levels' }, ...levels.map((l) => ({ rank: l.rank, label: `${l.name} (L${l.rank})` }))];
  const keyOf = (rank) => (rank == null ? '*' : String(rank));
  const seed = (rules) => {
    const next = {};
    for (const r of rules || []) {
      next[keyOf(r.gradeRank)] = { maxPerClaim: r.maxPerClaim ?? '', dailyCap: r.dailyCap ?? '', maxPerMonth: r.maxPerMonth ?? '' };
    }
    return next;
  };
  const [cells, setCells] = useState(() => seed(policy?.gradeRules));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const FIELDS = [['maxPerClaim', 'Per-claim cap'], ['dailyCap', 'Per-day cap'], ['maxPerMonth', 'Per-month cap']];

  const cell = (rank, f) => cells[keyOf(rank)]?.[f] ?? '';
  const setCell = (rank, f, v) => {
    setSaved(false);
    setCells((c) => ({ ...c, [keyOf(rank)]: { ...(c[keyOf(rank)] || {}), [f]: v } }));
  };

  async function save() {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const num = (v) => (v === '' || v == null ? null : Number(v));
      const rules = [];
      for (const r of rows) {
        const v = cells[keyOf(r.rank)] || {};
        // A fully-blank row is simply omitted from the replace-all PUT.
        if (FIELDS.every(([f]) => v[f] === '' || v[f] == null)) continue;
        rules.push({ gradeRank: r.rank, maxPerClaim: num(v.maxPerClaim), dailyCap: num(v.dailyCap), maxPerMonth: num(v.maxPerMonth) });
      }
      const res = await put(`/api/hr/expenses/categories/${category.id}/policy/grade-rules`, { rules });
      setCells(seed(res.items)); // reflect the server's saved truth
      setSaved(true);
    } catch (e) { setErr(e.data?.message || e.message); } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 rounded-lg bg-gray-50 p-3">
      <SectionTitle tip="Give higher job levels higher caps for this category. Caps are per level: an exact-level row overrides 'All levels', which overrides the flat limits. A blank cell falls back to the flat limit.">Per-level overrides</SectionTitle>
      {err && <ErrorBanner message={err} />}
      <div className="mt-2 overflow-x-auto">
        <table className="text-sm">
          <thead><tr className="text-left text-xs text-gray-500"><th className="py-1 pr-4">Level</th>{FIELDS.map(([f, label]) => <th key={f} className="px-2 font-medium">{label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={keyOf(r.rank)} className="border-t">
                <td className="py-1 pr-4 font-medium">{r.label}</td>
                {FIELDS.map(([f]) => (
                  <td key={f} className="px-2">
                    <input type="number" value={cell(r.rank, f)} onChange={(e) => setCell(r.rank, f, e.target.value)} disabled={!policy} className="w-24 rounded border px-2 py-1 disabled:bg-gray-100" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!levels.length && <p className="mt-2 text-xs text-gray-500">Only the "All levels" row is available — add Grades under People &amp; Org to set per-level rows.</p>}
      <p className="mt-2 text-xs text-gray-500">Caps are per level: an exact-level row overrides &lsquo;All levels&rsquo;, which overrides the flat limits.</p>
      <div className="mt-2 flex items-center gap-3">
        <button onClick={save} disabled={busy || !policy} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save level overrides'}</button>
        {saved && <span className="text-xs text-green-700">Saved.</span>}
        {!policy && <span className="text-xs text-gray-500">Set the flat limits above first.</span>}
      </div>
    </div>
  );
}

// ═══ Feature 45 — Approval & payout ═══════════════════════════════════════════════

const CHANNEL_OPTIONS = [
  ['PAY_SEPARATELY', 'Pay separately (bank transfer / petty cash)'],
  ['PAY_VIA_PAYROLL', 'Pay via payroll (next pay run)'],
];

function ApprovalPayoutTab() {
  const [settings, setSettings] = useState(null);
  const [threshold, setThreshold] = useState('');
  const [entities, setEntities] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyEntity, setBusyEntity] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  const reload = useCallback(() => {
    get('/api/hr/expenses/settings')
      .then((d) => { setSettings(d); setThreshold(d.hrThresholdRupees ?? ''); })
      .catch((e) => setErr(e.data?.message || e.message));
    get('/api/hr/org/entities')
      .then((d) => setEntities(Array.isArray(d) ? d : (d.items || [])))
      .catch((e) => setErr(e.data?.message || e.message));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  // value = a positive number, or null to reset to the built-in default.
  async function saveThreshold(value) {
    setBusy(true); setErr(''); setSavedMsg('');
    try {
      await patch('/api/hr/expenses/settings', { hrThresholdRupees: value });
      const d = await get('/api/hr/expenses/settings');
      setSettings(d); setThreshold(d.hrThresholdRupees ?? '');
      setSavedMsg(value == null ? 'Reset to the default.' : 'Saved.');
    } catch (e) { setErr(e.data?.message || e.message); } finally { setBusy(false); }
  }

  async function setChannel(id, channel) {
    setBusyEntity(id); setErr('');
    try {
      await patch(`/api/hr/org/entities/${id}`, { reimbursementDefaultChannel: channel });
      setEntities((list) => list.map((x) => (x.id === id ? { ...x, reimbursementDefaultChannel: channel } : x)));
    } catch (e) { setErr(e.data?.message || e.message); } finally { setBusyEntity(''); }
  }

  return (
    <div className="space-y-6">
      {err && <ErrorBanner message={err} />}

      <div>
        <SectionTitle tip="Claims above this amount route to HR after the manager (the built-in chain). Publish a custom EXPENSE workflow for advanced chains — level/department-scoped workflows now route correctly.">HR escalation threshold</SectionTitle>
        <p className="mt-1 text-xs text-gray-500">Claims above this route to HR after the manager (the built-in chain). Publish a custom EXPENSE workflow for advanced chains — level/department-scoped workflows now route correctly.</p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block text-xs"><FieldLabel tip="Amount in rupees. Claims above it add an HR step after the manager approves.">Threshold (₹)</FieldLabel>
            <input type="number" value={threshold} onChange={(e) => { setThreshold(e.target.value); setSavedMsg(''); }} className="block w-36 rounded border px-2 py-1" /></label>
          <button onClick={() => saveThreshold(Number(threshold))} disabled={busy || threshold === '' || Number(threshold) <= 0} className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
          <button onClick={() => saveThreshold(null)} disabled={busy} className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            Reset to default{settings ? ` (₹${Number(settings.defaultHrThresholdRupees).toLocaleString('en-IN')})` : ''}
          </button>
          {savedMsg && <span className="pb-1 text-xs text-green-700">{savedMsg}</span>}
        </div>
      </div>

      <div>
        <SectionTitle tip="The default payout channel stamped on newly approved claims for each entity's employees. Finance can still flip an individual claim from the Reimbursements queue.">Default payout channel</SectionTitle>
        <p className="mt-1 text-xs text-gray-500">Pay via payroll adds approved claims to the next pay run&rsquo;s net (tax-exempt reimbursement line).</p>
        <table className="mt-2 w-full max-w-2xl text-sm">
          <thead><tr className="text-left text-xs text-gray-500"><th className="py-1">Entity</th><th>Payout channel</th></tr></thead>
          <tbody>
            {entities.map((en) => (
              <tr key={en.id} className="border-t">
                <td className="py-2 pr-4"><span className="font-medium">{en.legalName || en.tradeName || en.code}</span> <span className="text-xs text-gray-400">{en.code}</span></td>
                <td>
                  <select
                    value={en.reimbursementDefaultChannel || 'PAY_SEPARATELY'}
                    disabled={busyEntity === en.id}
                    onChange={(e) => setChannel(en.id, e.target.value)}
                    className="rounded border px-2 py-1 text-sm disabled:opacity-50"
                  >
                    {CHANNEL_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </td>
              </tr>
            ))}
            {!entities.length && <tr><td colSpan={2} className="py-2 text-gray-400">No entities found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
