'use client';

// Reimbursements & Travel (Feature 11) — Employee Self-Service.
//
// SELF-SERVICE SURFACE: every call hits the customer-session /api/hr/me/expenses/*
// endpoints, which resolve the employee SERVER-SIDE from the session. The page NEVER
// sends an employeeId. Two flows:
//   • Reimbursement — raise a claim, add bill lines (each auto-validated against the
//     travel & expense policy with a LIVE verdict badge), submit → routed for approval.
//   • Travel / outdoor duty — apply for a trip → a TRV-#### travel id is minted → submit
//     for pre-trip approval → raise bills booked against that travel id.
//
// Every bill shows a live policy verdict (Within budget / Over by — will be flagged /
// Not allowed — hard cap). A hard-cap line blocks submit with a clear message.

import { useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { money, formatDate } from '@/lib/format';
import InfoTip, { FieldLabel } from '@/components/InfoTip';
import * as api from '@/lib/api';

const TRANSPORT_MODES = [
  { value: '', label: '— not transport —' },
  { value: 'PUBLIC_TRANSPORT', label: 'Public transport (bus/metro/auto)' },
  { value: 'TAXI_CAB', label: 'Taxi / cab' },
  { value: 'SELF_CAR', label: 'Own car (per-km)' },
  { value: 'TRAIN', label: 'Train' },
  { value: 'FLIGHT', label: 'Flight' },
];
const DURATION_BANDS = [
  { value: '', label: '— not per-diem —' },
  { value: 'FULL_24H', label: 'Full day (24h)' },
  { value: 'HALF_12H', label: 'Half (12h)' },
  { value: 'HALF_DAY', label: 'Half-day' },
];

function verdictBadge(v) {
  const map = {
    OK: { cls: 'bg-green-100 text-green-800', label: 'Within budget' },
    FLAGGED: { cls: 'bg-amber-100 text-amber-800', label: 'Over budget — will be flagged' },
    AUTO_REJECTED: { cls: 'bg-red-100 text-red-800', label: 'Not allowed — hard cap' },
    NO_POLICY: { cls: 'bg-gray-100 text-gray-600', label: 'No policy — advisory' },
  };
  const m = map[v] || map.NO_POLICY;
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}>{m.label}</span>;
}

function statusBadge(s) {
  const map = {
    DRAFT: 'bg-gray-100 text-gray-700', SUBMITTED: 'bg-blue-100 text-blue-800',
    APPROVED: 'bg-green-100 text-green-800', REJECTED: 'bg-red-100 text-red-800',
    REIMBURSED: 'bg-emerald-100 text-emerald-800', CANCELLED: 'bg-gray-100 text-gray-500',
    IN_PROGRESS: 'bg-indigo-100 text-indigo-800', COMPLETED: 'bg-teal-100 text-teal-800',
  };
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${map[s] || 'bg-gray-100 text-gray-700'}`}>{s}</span>;
}

export default function ReimbursementsPage() {
  return (
    <AppShell>
      <Inner />
    </AppShell>
  );
}

function Inner() {
  const [tab, setTab] = useState('claims');
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-semibold">Reimbursements & Travel</h1>
      <p className="mb-4 text-sm text-gray-500">Claim out-of-pocket expenses, apply for outdoor duty / travel, and submit bills against a trip. Each bill is checked against your company policy as you add it.</p>
      <div className="mb-6 flex gap-2 border-b">
        {[['claims', 'My claims'], ['trips', 'Travel / outdoor duty']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-4 py-2 text-sm font-medium ${tab === k ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500'}`}>{label}</button>
        ))}
      </div>
      {tab === 'claims' ? <ClaimsTab /> : <TripsTab />}
    </div>
  );
}

// ── Claims ────────────────────────────────────────────────────────────────────
function ClaimsTab() {
  const { data: ref } = useApi('/api/hr/me/expenses/reference', { select: (b) => b });
  const { data: claims, loading, error, reload } = useApi('/api/hr/me/expenses/claims', { select: (b) => b?.items || [] });
  const { data: trips } = useApi('/api/hr/me/expenses/trips', { select: (b) => b?.items || [] });
  const [openClaimId, setOpenClaimId] = useState(null);

  if (loading) return <Centered><Spinner /></Centered>;
  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error.message} />}
      <NewClaim ref_={ref} trips={trips || []} onCreated={(id) => { reload(); setOpenClaimId(id); }} />
      <div>
        <h2 className="mb-2 text-lg font-medium">Your claims</h2>
        {(!claims || !claims.length) ? <Empty text="No claims yet." /> : (
          <ul className="space-y-2">
            {claims.map((c) => (
              <li key={c.id} className="rounded-lg border bg-white">
                <button onClick={() => setOpenClaimId(openClaimId === c.id ? null : c.id)} className="flex w-full items-center justify-between p-3 text-left">
                  <span>
                    <span className="font-medium">{c.claimNumber || c.id.slice(0, 8)}</span>
                    {c.travelRequest ? <span className="ml-2 text-xs text-indigo-600">trip {c.travelRequest.travelNumber}</span> : null}
                    <span className="ml-2 text-sm text-gray-500">{c.category?.name || 'Reimbursement'} · {money(c.amount, c.currencyCode)}</span>
                  </span>
                  {statusBadge(c.status)}
                </button>
                {openClaimId === c.id && <ClaimDetail id={c.id} ref_={ref} onChanged={reload} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NewClaim({ ref_, trips, onCreated }) {
  const [categoryId, setCategoryId] = useState('');
  const [travelRequestId, setTravelRequestId] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const approvedTrips = (trips || []).filter((t) => t.status === 'APPROVED' || t.status === 'IN_PROGRESS');

  async function create() {
    setBusy(true); setErr(null);
    try {
      const claim = await api.createClaim({ categoryId: categoryId || undefined, travelRequestId: travelRequestId || undefined, description: description || undefined, currencyCode: ref_?.policy?.currencyCode || 'INR' });
      setDescription(''); setCategoryId(''); setTravelRequestId('');
      onCreated(claim.id);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border bg-gray-50 p-4">
      <h2 className="mb-3 text-lg font-medium">New reimbursement</h2>
      {err && <ErrorBanner message={err} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <FieldLabel tip="Pick what kind of expense this is. Categories and their limits are set by HR.">Category</FieldLabel>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full rounded border px-2 py-1.5">
            <option value="">— choose —</option>
            {(ref_?.categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <FieldLabel tip="Book this claim against an approved trip to bill it against that travel ID, or leave blank for a standalone reimbursement.">Trip (optional)</FieldLabel>
          <select value={travelRequestId} onChange={(e) => setTravelRequestId(e.target.value)} className="w-full rounded border px-2 py-1.5">
            <option value="">— standalone reimbursement —</option>
            {approvedTrips.map((t) => <option key={t.id} value={t.id}>{t.travelNumber} · {t.destCity || t.purpose}</option>)}
          </select>
        </label>
        <label className="block text-sm sm:col-span-2">
          <FieldLabel tip="A short note describing this claim.">Description</FieldLabel>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="w-full rounded border px-2 py-1.5" placeholder="e.g. Client meeting expenses" />
        </label>
      </div>
      <button onClick={create} disabled={busy} className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {busy ? 'Creating…' : 'Create draft'}
      </button>
    </div>
  );
}

function ClaimDetail({ id, ref_, onChanged }) {
  const { data: claim, loading, reload } = useApi(`/api/hr/me/expenses/claims/${id}`, { select: (b) => b });
  const [err, setErr] = useState(null);
  const [submitErr, setSubmitErr] = useState(null);

  if (loading || !claim) return <div className="p-3"><Spinner small /></div>;
  const isDraft = claim.status === 'DRAFT';

  async function submit() {
    setSubmitErr(null);
    try { await api.submitClaim(id); reload(); onChanged && onChanged(); }
    catch (e) { setSubmitErr(e.message + (e.errors?.length ? ` (${e.errors.length} blocked)` : '')); }
  }
  async function cancel() { try { await api.cancelClaim(id); reload(); onChanged && onChanged(); } catch (e) { setErr(e.message); } }
  async function removeLine(lineId) { try { await api.removeClaimLine(id, lineId); reload(); } catch (e) { setErr(e.message); } }

  return (
    <div className="border-t bg-white p-3">
      {err && <ErrorBanner message={err} />}
      {/* Status timeline */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-gray-500">Status:</span> {statusBadge(claim.status)}
        {claim.policyVerdict && claim.policyVerdict !== 'NO_POLICY' ? verdictBadge(claim.policyVerdict) : null}
        {claim.rejectReason ? <span className="text-red-600">— {claim.rejectReason}</span> : null}
      </div>

      {/* Bills */}
      <table className="w-full text-sm">
        <thead><tr className="text-left text-gray-500"><th className="py-1">Bill</th><th>Amount</th><th>Policy</th>{isDraft && <th></th>}</tr></thead>
        <tbody>
          {(claim.lines || []).map((l) => (
            <tr key={l.id} className="border-t">
              <td className="py-1">{l.description || l.category?.name || l.transportMode || (l.nights ? 'Hotel' : 'Bill')}</td>
              <td>{money(l.amount, claim.currencyCode)}</td>
              <td>{verdictBadge(l.policyStatus)}{l.policyReason ? <div className="text-xs text-gray-500">{l.policyReason}</div> : null}</td>
              {isDraft && <td><button onClick={() => removeLine(l.id)} className="text-xs text-red-600">Remove</button></td>}
            </tr>
          ))}
          {!(claim.lines || []).length && <tr><td colSpan={4} className="py-2 text-gray-400">No bills yet.</td></tr>}
        </tbody>
      </table>

      {isDraft && <AddBill claimId={id} ref_={ref_} travelRequestId={claim.travelRequestId} onAdded={reload} />}

      {isDraft && (
        <div className="mt-3 flex gap-2">
          <button onClick={submit} className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white">Submit for approval</button>
          <button onClick={cancel} className="rounded border px-4 py-2 text-sm">Cancel claim</button>
        </div>
      )}
      {!isDraft && claim.status === 'SUBMITTED' && (
        <button onClick={cancel} className="mt-3 rounded border px-4 py-2 text-sm">Withdraw</button>
      )}
      {submitErr && <div className="mt-2"><ErrorBanner message={submitErr} /></div>}
    </div>
  );
}

function AddBill({ claimId, ref_, travelRequestId, onAdded }) {
  const [form, setForm] = useState({ amount: '', categoryId: '', description: '', transportMode: '', distanceKm: '', nights: '', durationBand: '' });
  const [receipt, setReceipt] = useState(null); // { name, dataUrl }
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function onPickReceipt(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setReceipt({ name: file.name, dataUrl: reader.result });
    reader.onerror = () => setErr('Could not read that file. Please try another.');
    reader.readAsDataURL(file);
  }

  async function doPreview() {
    if (!form.amount) return;
    try {
      const p = await api.previewExpensePolicy({
        amount: Number(form.amount), categoryId: form.categoryId || undefined,
        transportMode: form.transportMode || undefined, distanceKm: form.distanceKm || undefined,
        nights: form.nights || undefined, durationBand: form.durationBand || undefined,
        travelRequestId: travelRequestId || undefined,
      });
      setPreview(p.verdict);
    } catch { setPreview(null); }
  }

  async function add() {
    setBusy(true); setErr(null);
    try {
      await api.addClaimLine(claimId, {
        amount: Number(form.amount), categoryId: form.categoryId || undefined, description: form.description || undefined,
        transportMode: form.transportMode || undefined, distanceKm: form.distanceKm || undefined,
        nights: form.nights || undefined, durationBand: form.durationBand || undefined,
        fileBase64: receipt?.dataUrl || undefined,
      });
      setForm({ amount: '', categoryId: '', description: '', transportMode: '', distanceKm: '', nights: '', durationBand: '' });
      setReceipt(null);
      setPreview(null);
      onAdded();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="mt-3 rounded border bg-gray-50 p-3">
      <h3 className="mb-2 flex items-center text-sm font-medium">Add a bill <InfoTip text="Enter the bill details. We check it against your company's travel & expense policy live, before you submit." /></h3>
      {err && <ErrorBanner message={err} />}
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="block text-xs"><FieldLabel tip="The bill amount.">Amount</FieldLabel>
          <input type="number" value={form.amount} onChange={set('amount')} onBlur={doPreview} className="w-full rounded border px-2 py-1" /></label>
        <label className="block text-xs"><FieldLabel tip="Category for per-category limits.">Category</FieldLabel>
          <select value={form.categoryId} onChange={set('categoryId')} className="w-full rounded border px-2 py-1"><option value="">—</option>{(ref_?.categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="block text-xs"><FieldLabel tip="A short label for this bill.">Description</FieldLabel>
          <input value={form.description} onChange={set('description')} className="w-full rounded border px-2 py-1" /></label>
        <label className="block text-xs"><FieldLabel tip="If this is travel, the mode used. Flight/train eligibility is set by policy.">Transport mode</FieldLabel>
          <select value={form.transportMode} onChange={(e) => { set('transportMode')(e); }} onBlur={doPreview} className="w-full rounded border px-2 py-1">{TRANSPORT_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
        {form.transportMode === 'SELF_CAR' && (
          <label className="block text-xs"><FieldLabel tip="Distance driven, for the per-km allowance.">Distance (km)</FieldLabel>
            <input type="number" value={form.distanceKm} onChange={set('distanceKm')} onBlur={doPreview} className="w-full rounded border px-2 py-1" /></label>
        )}
        <label className="block text-xs"><FieldLabel tip="For a hotel bill, the number of nights (checked against the nightly cap for your level + city tier).">Hotel nights</FieldLabel>
          <input type="number" value={form.nights} onChange={set('nights')} onBlur={doPreview} className="w-full rounded border px-2 py-1" /></label>
        <label className="block text-xs"><FieldLabel tip="For a daily allowance (food + incidentals), the trip-duration band.">Per-diem band</FieldLabel>
          <select value={form.durationBand} onChange={(e) => { set('durationBand')(e); }} onBlur={doPreview} className="w-full rounded border px-2 py-1">{DURATION_BANDS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
        <div className="block text-xs sm:col-span-3"><FieldLabel tip="Optionally attach the bill / receipt (image or PDF) so an approver can verify it. You can submit without one, but a claim may be returned if a receipt is required.">Receipt (optional)</FieldLabel>
          {receipt ? (
            <div className="flex items-center gap-2">
              <span className="truncate rounded border bg-white px-2 py-1 text-gray-700">{receipt.name}</span>
              <button type="button" onClick={() => setReceipt(null)} className="text-red-600">Clear</button>
            </div>
          ) : (
            <input type="file" accept="image/*,application/pdf" onChange={onPickReceipt} className="block w-full text-xs file:mr-2 file:rounded file:border-0 file:bg-blue-600 file:px-3 file:py-1 file:text-white" />
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button onClick={add} disabled={busy || !form.amount} className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Adding…' : 'Add bill'}</button>
        {preview && verdictBadge(preview.verdict)}
        {preview?.reason && <span className="text-xs text-gray-500">{preview.reason}</span>}
      </div>
    </div>
  );
}

// ── Trips ─────────────────────────────────────────────────────────────────────
function TripsTab() {
  const { data: trips, loading, error, reload } = useApi('/api/hr/me/expenses/trips', { select: (b) => b?.items || [] });
  if (loading) return <Centered><Spinner /></Centered>;
  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error.message} />}
      <NewTrip onCreated={reload} />
      <div>
        <h2 className="mb-2 text-lg font-medium">Your trips</h2>
        {(!trips || !trips.length) ? <Empty text="No trips yet." /> : (
          <ul className="space-y-2">
            {trips.map((t) => <TripRow key={t.id} trip={t} onChanged={reload} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function NewTrip({ onCreated }) {
  const [form, setForm] = useState({ purpose: '', destCity: '', originCity: '', startAt: '', endAt: '', isOutdoorDuty: false, advanceAmount: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [created, setCreated] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function create() {
    setBusy(true); setErr(null); setCreated(null);
    try {
      const trip = await api.createTrip({ ...form, advanceAmount: form.advanceAmount || undefined });
      setCreated(trip);
      setForm({ purpose: '', destCity: '', originCity: '', startAt: '', endAt: '', isOutdoorDuty: false, advanceAmount: '' });
      onCreated();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border bg-gray-50 p-4">
      <h2 className="mb-3 text-lg font-medium">Apply for outdoor duty / travel</h2>
      {err && <ErrorBanner message={err} />}
      {created && <div className="mb-3 rounded bg-green-50 p-2 text-sm text-green-800">Travel ID <b>{created.travelNumber}</b> created. Submit it from the list below for pre-trip approval, then book bills against it.</div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2"><FieldLabel tip="Why are you travelling? e.g. client visit, site inspection.">Purpose</FieldLabel>
          <input value={form.purpose} onChange={set('purpose')} className="w-full rounded border px-2 py-1.5" /></label>
        <label className="block text-sm"><FieldLabel tip="Where you're travelling from.">From city</FieldLabel>
          <input value={form.originCity} onChange={set('originCity')} className="w-full rounded border px-2 py-1.5" /></label>
        <label className="block text-sm"><FieldLabel tip="Destination — used to resolve the city tier for hotel + per-diem limits.">To city</FieldLabel>
          <input value={form.destCity} onChange={set('destCity')} className="w-full rounded border px-2 py-1.5" /></label>
        <label className="block text-sm"><FieldLabel tip="Trip start date & time.">Start</FieldLabel>
          <input type="datetime-local" value={form.startAt} onChange={set('startAt')} className="w-full rounded border px-2 py-1.5" /></label>
        <label className="block text-sm"><FieldLabel tip="Trip end date & time — duration drives the per-diem band.">End</FieldLabel>
          <input type="datetime-local" value={form.endAt} onChange={set('endAt')} className="w-full rounded border px-2 py-1.5" /></label>
        <label className="block text-sm"><FieldLabel tip="Optional cash advance requested for the trip, netted at settlement.">Advance (optional)</FieldLabel>
          <input type="number" value={form.advanceAmount} onChange={set('advanceAmount')} className="w-full rounded border px-2 py-1.5" /></label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isOutdoorDuty} onChange={set('isOutdoorDuty')} /> Local outdoor / official duty <InfoTip text="Tick for a local outdoor duty (not an out-station trip)." /></label>
      </div>
      <button onClick={create} disabled={busy || !form.purpose || !form.startAt || !form.endAt} className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Creating…' : 'Get travel ID'}</button>
    </div>
  );
}

function TripRow({ trip, onChanged }) {
  const [err, setErr] = useState(null);
  async function submit() { try { await api.submitTrip(trip.id); onChanged(); } catch (e) { setErr(e.message); } }
  async function cancel() { try { await api.cancelTrip(trip.id); onChanged(); } catch (e) { setErr(e.message); } }
  return (
    <li className="rounded-lg border bg-white p-3">
      <div className="flex items-center justify-between">
        <span>
          <span className="font-medium">{trip.travelNumber}</span>
          <span className="ml-2 text-sm text-gray-500">{trip.purpose} · {trip.destCity || '—'}{trip.destTier ? ` (${trip.destTier})` : ''}</span>
          <span className="ml-2 text-xs text-gray-400">{formatDate(trip.startAt)} → {formatDate(trip.endAt)}</span>
        </span>
        {statusBadge(trip.status)}
      </div>
      {err && <div className="mt-2"><ErrorBanner message={err} /></div>}
      <div className="mt-2 flex gap-2">
        {trip.status === 'DRAFT' && <button onClick={submit} className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white">Submit for approval</button>}
        {['DRAFT', 'SUBMITTED'].includes(trip.status) && <button onClick={cancel} className="rounded border px-3 py-1.5 text-sm">Cancel</button>}
        {trip._count?.claims ? <span className="self-center text-xs text-gray-500">{trip._count.claims} bill(s) booked</span> : null}
      </div>
    </li>
  );
}
