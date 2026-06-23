'use client';

// Self-onboarding wizard (ESS) — Feature 4 §5.2, §6, slice 4b.
//
// A guided, country-aware new-hire wizard that works in TWO modes:
//   • Logged-in new hire  → wrapped in <AppShell> (session-guarded ESS chrome).
//   • Pre-join magic-link → ?token=… ; renders bare (BrandHeader only, no
//     session) so a candidate with no portal account yet can complete it.
//
// All reads/writes go to /api/hr/me/onboarding (subject is session/token-derived
// server-side — never a body id). When a token is present it is appended to
// every request as ?token= (the backend accepts it on the query).
//
// Steps: Welcome → Personal → Statutory (IN PAN/Aadhaar/UAN · NZ IRD/tax/KiwiSaver)
//        → Bank → Emergency → Documents → e-sign (placeholder, 4d) → Review/Submit.
// Inline statutory validation MIRRORS backend/src/hr/lifecycle/validators.js so
// the field-level feedback matches the server gate exactly.

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AppShell from '@/components/AppShell';
import BrandHeader from '@/components/BrandHeader';
import { ErrorBanner, Empty, Spinner, Centered, ESignPanel } from '@hr/ui';
import { apiGet, apiSend } from '@/lib/api';

// ─── client-side validator mirror (validators.js) ───────────────────────────
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const isPAN = (v) => PAN_RE.test(String(v || '').trim().toUpperCase());
const isIFSC = (v) => IFSC_RE.test(String(v || '').trim().toUpperCase());
const isUAN = (v) => /^\d{12}$/.test(String(v || '').replace(/\D/g, ''));

// Verhoeff (Aadhaar) — same tables as the server, for inline-only feedback.
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function isAadhaar(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 12 || d[0] === '0' || d[0] === '1') return false;
  let c = 0; const r = d.split('').reverse();
  for (let i = 0; i < r.length; i += 1) c = VD[c][VP[i % 8][Number(r[i])]];
  return c === 0;
}
// IRD mod-11 (last digit = check; base left-padded to 8).
const IRD_W1 = [3,2,7,6,5,4,3,2]; const IRD_W2 = [7,4,3,2,5,2,7,6];
function irdCd(base8, w) { let s = 0; for (let i = 0; i < 8; i += 1) s += Number(base8[i]) * w[i]; const m = s % 11; return m === 0 ? 0 : 11 - m; }
function isIRD(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 8 || d.length > 9) return false;
  const whole = Number(d); if (whole < 10000000 || whole > 150000000) return false;
  const provided = Number(d[d.length - 1]); const base8 = d.slice(0, -1).padStart(8, '0');
  let c = irdCd(base8, IRD_W1); if (c === 10) { c = irdCd(base8, IRD_W2); if (c === 10) return false; }
  return c === provided;
}
const NZ_TAX = new Set(['M','ME','SB','S','SH','ST','SA','M SL','ME SL','SB SL','S SL','SH SL','ST SL','SA SL','WT','ND','STC','CAE','EDW','NSW']);
function isTaxCode(v) { const s = String(v || '').trim().toUpperCase().replace(/\s+/g, ' ').replace(/^([A-Z]{1,2})SL$/, '$1 SL'); return NZ_TAX.has(s); }
const KIWI = new Set([3, 4, 6, 8, 10]);
const isKiwi = (v) => v == null || v === '' || KIWI.has(Number(String(v).replace('%', '').trim()));
function isNZBank(v) {
  const p = String(v || '').trim().split('-');
  return p.length === 4 && /^\d{2}$/.test(p[0]) && /^\d{4}$/.test(p[1]) && /^\d{6,8}$/.test(p[2]) && /^\d{2,4}$/.test(p[3]);
}

// ─── small field UI ──────────────────────────────────────────────────────────
function Field({ label, value, onChange, hint, error, type = 'text', placeholder, maxLength }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{label}</span>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none"
        style={{ borderColor: error ? '#DC2626' : 'var(--theme-border)', color: 'var(--theme-text)' }}
      />
      {error ? (
        <span className="mt-1 block text-xs" style={{ color: '#DC2626' }}>{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs" style={{ color: 'var(--theme-muted)' }}>{hint}</span>
      ) : null}
    </label>
  );
}

function Select({ label, value, onChange, options, hint, error }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{label}</span>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none"
        style={{ borderColor: error ? '#DC2626' : 'var(--theme-border)', color: 'var(--theme-text)' }}
      >
        <option value="">Select…</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {error ? <span className="mt-1 block text-xs" style={{ color: '#DC2626' }}>{error}</span>
        : hint ? <span className="mt-1 block text-xs" style={{ color: 'var(--theme-muted)' }}>{hint}</span> : null}
    </label>
  );
}

// Step order + friendly labels (e-sign is a placeholder pending slice 4d).
const STEPS = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'personal', label: 'About you' },
  { key: 'statutory', label: 'Statutory' },
  { key: 'bank', label: 'Bank' },
  { key: 'emergency', label: 'Emergency' },
  { key: 'documents', label: 'Documents' },
  { key: 'esign', label: 'Sign' },
  { key: 'review', label: 'Review' },
];

function ProgressBar({ index }) {
  const pct = Math.round((index / (STEPS.length - 1)) * 100);
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between text-xs" style={{ color: 'var(--theme-muted)' }}>
        <span>{STEPS[index].label}</span>
        <span>{index + 1} / {STEPS.length}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: 'var(--theme-border)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: 'var(--theme-primary)' }} />
      </div>
    </div>
  );
}

function Card({ title, children, subtitle }) {
  return (
    <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      {title && <h2 className="text-lg font-semibold" style={{ color: 'var(--theme-text)' }}>{title}</h2>}
      {subtitle && <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>{subtitle}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function NavButtons({ onBack, onNext, nextLabel = 'Continue', nextDisabled, busy, backDisabled }) {
  return (
    <div className="mt-5 flex items-center justify-between">
      <button
        onClick={onBack}
        disabled={backDisabled || busy}
        className="rounded-lg border px-4 py-2 text-sm font-medium transition disabled:opacity-40"
        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
      >
        Back
      </button>
      <button
        onClick={onNext}
        disabled={nextDisabled || busy}
        className="rounded-lg px-5 py-2 text-sm font-semibold transition disabled:opacity-50"
        style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
      >
        {busy ? '…' : nextLabel}
      </button>
    </div>
  );
}

function Wizard() {
  const params = useSearchParams();
  const token = params.get('token');
  const apiPath = (suffix) => `/api/hr/me/onboarding${suffix}${token ? `${suffix.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : ''}`;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [state, setState] = useState(null); // { journey, tasks, countryCode, selfService, completeness }
  const [stepIdx, setStepIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // local form buffers (seeded from the staged selfService bucket)
  const [personal, setPersonal] = useState({});
  const [statutory, setStatutory] = useState({});
  const [bank, setBank] = useState({});
  const [emergency, setEmergency] = useState({});
  const [submitted, setSubmitted] = useState(false);

  async function load() {
    setLoading(true); setLoadError(null);
    try {
      const data = await apiGet(apiPath(''));
      setState(data);
      const ss = data.selfService || {};
      setPersonal(ss.personal || {});
      setStatutory(ss.statutory || {});
      setBank(ss.bank || {});
      setEmergency(ss.emergency || {});
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  const countryCode = state?.countryCode || 'IN';
  const isIN = countryCode !== 'NZ';

  // ── per-step inline validation (mirrors the server) ──
  const personalErrors = useMemo(() => {
    const e = {};
    if (!personal.firstName && !personal.fullName) e.firstName = 'Name is required';
    if (personal.dateOfBirth && Number.isNaN(new Date(personal.dateOfBirth).getTime())) e.dateOfBirth = 'Enter a valid date';
    return e;
  }, [personal]);

  const statutoryErrors = useMemo(() => {
    const e = {};
    if (isIN) {
      if (!statutory.pan) e.pan = 'PAN is required';
      else if (!isPAN(statutory.pan)) e.pan = 'Enter a valid PAN (e.g. ABCDE1234F)';
      if (statutory.aadhaar && !isAadhaar(statutory.aadhaar)) e.aadhaar = 'Enter a valid 12-digit Aadhaar';
      if (statutory.uan && !isUAN(statutory.uan)) e.uan = 'UAN must be 12 digits';
    } else {
      if (!statutory.irdNumber) e.irdNumber = 'IRD number is required';
      else if (!isIRD(statutory.irdNumber)) e.irdNumber = 'Enter a valid IRD number';
      if (!statutory.taxCode) e.taxCode = 'Tax code is required';
      else if (!isTaxCode(statutory.taxCode)) e.taxCode = 'Enter a valid tax code (e.g. M, ME, S SL)';
      if (statutory.kiwiSaverRate && !isKiwi(statutory.kiwiSaverRate)) e.kiwiSaverRate = 'Rate must be 3, 4, 6, 8 or 10%';
    }
    return e;
  }, [statutory, isIN]);

  const bankErrors = useMemo(() => {
    const e = {};
    if (!bank.accountNumber) e.accountNumber = 'Account number is required';
    if (!bank.accountHolderName) e.accountHolderName = 'Account holder name is required';
    if (isIN) { if (!bank.ifsc) e.ifsc = 'IFSC is required'; else if (!isIFSC(bank.ifsc)) e.ifsc = 'Enter a valid IFSC code'; }
    else { if (!bank.nzBankAccount) e.nzBankAccount = 'Bank account is required'; else if (!isNZBank(bank.nzBankAccount)) e.nzBankAccount = 'Enter a valid NZ bank account'; }
    return e;
  }, [bank, isIN]);

  const emergencyErrors = useMemo(() => {
    const e = {};
    if (!emergency.name) e.name = 'Contact name is required';
    if (!emergency.phone) e.phone = 'Contact phone is required';
    return e;
  }, [emergency]);

  async function saveSection(suffix, payload, reseed) {
    setBusy(true); setSaveError(null);
    try {
      const out = await apiSend(apiPath(suffix), 'POST', payload);
      // Refresh completeness/state from the response without a full reload.
      setState((s) => (s ? { ...s, completeness: out.completeness || s.completeness, selfService: out.selfService || s.selfService } : s));
      if (reseed && out.selfService) reseed(out.selfService);
      return true;
    } catch (e) {
      setSaveError(e.message || 'Could not save. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function next() { setStepIdx((i) => Math.min(i + 1, STEPS.length - 1)); }
  function back() { setStepIdx((i) => Math.max(i - 1, 0)); }

  async function saveAndNext() {
    const step = STEPS[stepIdx].key;
    if (step === 'personal') { if (Object.keys(personalErrors).length) return; if (await saveSection('/personal', personal)) next(); return; }
    if (step === 'statutory') { if (Object.keys(statutoryErrors).length) return; if (await saveSection('/statutory', statutory)) next(); return; }
    if (step === 'bank') { if (Object.keys(bankErrors).length) return; if (await saveSection('/bank', bank)) next(); return; }
    if (step === 'emergency') { if (Object.keys(emergencyErrors).length) return; if (await saveSection('/emergency', emergency)) next(); return; }
    next();
  }

  // Document upload — read the file as a base64 data URL + SHA-256 hash client-side.
  async function uploadDoc(file, category) {
    setBusy(true); setSaveError(null);
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      let fileHash = null;
      try {
        const buf = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buf);
        fileHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch { /* hashing best-effort */ }
      const out = await apiSend(apiPath('/documents'), 'POST', { category, name: file.name, mimeType: file.type, sizeBytes: file.size, fileHash, fileBase64: dataUrl });
      setState((s) => (s ? { ...s, completeness: out.completeness || s.completeness } : s));
      return true;
    } catch (e) {
      setSaveError(e.message || 'Upload failed. Please try a smaller file.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitAll() {
    setBusy(true); setSaveError(null);
    try {
      const out = await apiSend(apiPath('/submit'), 'POST', {});
      setState((s) => (s ? { ...s, completeness: out.completeness || s.completeness, journey: { ...s.journey, currentStage: out.currentStage, status: out.status } } : s));
      setSubmitted(true);
    } catch (e) {
      // 422 carries `pending` (the unmet required steps).
      const pending = (e.errors && e.errors.length) ? '' : '';
      setSaveError(e.message + (pending || '') || 'Please complete all required steps first.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Centered><Spinner /></Centered>;
  if (loadError) {
    const msg = loadError.status === 401
      ? 'This onboarding link is invalid or has expired. Please ask HR for a fresh link.'
      : loadError.status === 404
      ? 'We could not find an onboarding in progress for you yet. Please check back soon.'
      : (loadError.message || 'Could not load your onboarding.');
    return <Empty text={msg} />;
  }

  const c = state.completeness || {};
  const step = STEPS[stepIdx].key;

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>Welcome aboard</h1>
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
          A few quick steps to get you ready for day one.
        </p>
      </div>

      <ProgressBar index={stepIdx} />
      {saveError && <div className="mb-4"><ErrorBanner message={saveError} /></div>}

      {step === 'welcome' && (
        <Card title="Let's get you set up" subtitle="This takes about 5 minutes. Your details are private and visible only to HR.">
          <ul className="space-y-2 text-sm" style={{ color: 'var(--theme-text)' }}>
            <li>• Personal & contact details</li>
            <li>• Statutory information ({isIN ? 'PAN, Aadhaar, UAN' : 'IRD, tax code, KiwiSaver'})</li>
            <li>• Bank account for salary</li>
            <li>• Emergency contact</li>
            <li>• A few documents to upload &amp; sign</li>
          </ul>
          <NavButtons onBack={back} backDisabled onNext={next} nextLabel="Start" busy={busy} />
        </Card>
      )}

      {step === 'personal' && (
        <Card title="About you">
          <Field label="First name" value={personal.firstName} onChange={(v) => setPersonal({ ...personal, firstName: v })} error={personalErrors.firstName} />
          <Field label="Last name" value={personal.lastName} onChange={(v) => setPersonal({ ...personal, lastName: v })} />
          <Field label="Date of birth" type="date" value={personal.dateOfBirth} onChange={(v) => setPersonal({ ...personal, dateOfBirth: v })} error={personalErrors.dateOfBirth} />
          <Field label="Personal email" type="email" value={personal.personalEmail} onChange={(v) => setPersonal({ ...personal, personalEmail: v })} />
          <Field label="Phone" value={personal.phone} onChange={(v) => setPersonal({ ...personal, phone: v })} />
          <Field label="Current address" value={personal.address} onChange={(v) => setPersonal({ ...personal, address: v })} />
          <NavButtons onBack={back} onNext={saveAndNext} busy={busy} nextDisabled={Object.keys(personalErrors).length > 0} />
        </Card>
      )}

      {step === 'statutory' && (
        <Card title="Statutory details" subtitle={isIN ? 'Required for tax (TDS) and provident fund.' : 'Required for PAYE and KiwiSaver.'}>
          {isIN ? (
            <>
              <Field label="PAN" value={statutory.pan} onChange={(v) => setStatutory({ ...statutory, pan: v.toUpperCase() })} error={statutoryErrors.pan} maxLength={10} hint="10 characters, e.g. ABCDE1234F" />
              <Field label="Aadhaar (optional)" value={statutory.aadhaar} onChange={(v) => setStatutory({ ...statutory, aadhaar: v })} error={statutoryErrors.aadhaar} maxLength={14} hint="12 digits" />
              <Field label="UAN (optional)" value={statutory.uan} onChange={(v) => setStatutory({ ...statutory, uan: v })} error={statutoryErrors.uan} maxLength={12} hint="Universal Account Number, if you have one" />
              <Select label="Tax regime" value={statutory.taxRegime} onChange={(v) => setStatutory({ ...statutory, taxRegime: v })} options={[['NEW', 'New regime (default)'], ['OLD', 'Old regime']]} />
            </>
          ) : (
            <>
              <Field label="IRD number" value={statutory.irdNumber} onChange={(v) => setStatutory({ ...statutory, irdNumber: v })} error={statutoryErrors.irdNumber} maxLength={11} hint="8 or 9 digits" />
              <Select label="Tax code" value={statutory.taxCode} onChange={(v) => setStatutory({ ...statutory, taxCode: v })} options={[['M', 'M'], ['ME', 'ME'], ['M SL', 'M SL'], ['S', 'S'], ['S SL', 'S SL'], ['SH', 'SH'], ['ST', 'ST'], ['SB', 'SB'], ['SA', 'SA']]} error={statutoryErrors.taxCode} />
              <Select label="KiwiSaver rate (optional)" value={statutory.kiwiSaverRate} onChange={(v) => setStatutory({ ...statutory, kiwiSaverRate: v })} options={[['3', '3%'], ['4', '4%'], ['6', '6%'], ['8', '8%'], ['10', '10%']]} error={statutoryErrors.kiwiSaverRate} />
            </>
          )}
          <NavButtons onBack={back} onNext={saveAndNext} busy={busy} nextDisabled={Object.keys(statutoryErrors).length > 0} />
        </Card>
      )}

      {step === 'bank' && (
        <Card title="Bank account" subtitle="Where we'll credit your salary.">
          <Field label="Account holder name" value={bank.accountHolderName} onChange={(v) => setBank({ ...bank, accountHolderName: v })} error={bankErrors.accountHolderName} />
          <Field label="Account number" value={bank.accountNumber} onChange={(v) => setBank({ ...bank, accountNumber: v })} error={bankErrors.accountNumber} />
          {isIN ? (
            <Field label="IFSC" value={bank.ifsc} onChange={(v) => setBank({ ...bank, ifsc: v.toUpperCase() })} error={bankErrors.ifsc} maxLength={11} hint="e.g. HDFC0001234" />
          ) : (
            <Field label="Bank account (BB-bbbb-account-suffix)" value={bank.nzBankAccount} onChange={(v) => setBank({ ...bank, nzBankAccount: v })} error={bankErrors.nzBankAccount} hint="e.g. 12-3456-1234567-00" />
          )}
          <NavButtons onBack={back} onNext={saveAndNext} busy={busy} nextDisabled={Object.keys(bankErrors).length > 0} />
        </Card>
      )}

      {step === 'emergency' && (
        <Card title="Emergency contact">
          <Field label="Contact name" value={emergency.name} onChange={(v) => setEmergency({ ...emergency, name: v })} error={emergencyErrors.name} />
          <Field label="Relationship" value={emergency.relationship} onChange={(v) => setEmergency({ ...emergency, relationship: v })} />
          <Field label="Phone" value={emergency.phone} onChange={(v) => setEmergency({ ...emergency, phone: v })} error={emergencyErrors.phone} />
          <NavButtons onBack={back} onNext={saveAndNext} busy={busy} nextDisabled={Object.keys(emergencyErrors).length > 0} />
        </Card>
      )}

      {step === 'documents' && (
        <Card title="Documents" subtitle="Upload your ID proof and any required documents (max 10 MB each).">
          <DocUpload label={isIN ? 'ID proof (PAN / Aadhaar)' : 'Passport / visa / work permit'} category={isIN ? 'AADHAAR' : 'WORK_PERMIT'} onUpload={uploadDoc} busy={busy} done={c.documents} />
          <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>
            {c.documents ? 'Documents received. You can re-upload if needed.' : 'A document upload is required before you can submit.'}
          </p>
          <NavButtons onBack={back} onNext={next} busy={busy} />
        </Card>
      )}

      {step === 'esign' && (
        <Card title="Sign your documents" subtitle="Review and sign your offer, contract and policies.">
          <EsignStep signToken={params.get('signToken')} />
          <NavButtons onBack={back} onNext={next} busy={busy} />
        </Card>
      )}

      {step === 'review' && (
        <Card title="Review &amp; submit" subtitle="Check the items below, then submit to finish your onboarding.">
          <ul className="space-y-2 text-sm">
            <ReviewRow label="Personal details" done={c.personal} />
            <ReviewRow label="Statutory details" done={c.statutory} />
            <ReviewRow label="Bank account" done={c.bank} />
            <ReviewRow label="Emergency contact" done={c.emergency} />
            <ReviewRow label="Documents uploaded" done={c.documents} />
          </ul>

          {submitted ? (
            <div className="rounded-xl border p-4 text-center" style={{ borderColor: 'var(--theme-primary)' }}>
              <p className="text-base font-semibold" style={{ color: 'var(--theme-primary)' }}>You&apos;re all set for Day 1 🎉</p>
              <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>HR will take it from here. Welcome to the team!</p>
            </div>
          ) : (
            <>
              {!c.submitReady && (
                <p className="text-xs" style={{ color: '#D97706' }}>
                  Complete all required steps above before submitting.
                </p>
              )}
              <div className="mt-2 flex items-center justify-between">
                <button onClick={back} disabled={busy} className="rounded-lg border px-4 py-2 text-sm font-medium transition disabled:opacity-40" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>Back</button>
                <button onClick={submitAll} disabled={busy || !c.submitReady} className="rounded-lg px-5 py-2 text-sm font-semibold transition disabled:opacity-50" style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}>
                  {busy ? '…' : 'Submit onboarding'}
                </button>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function ReviewRow({ label, done }) {
  return (
    <li className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: 'var(--theme-border)' }}>
      <span style={{ color: 'var(--theme-text)' }}>{label}</span>
      <span className="text-xs font-medium" style={{ color: done ? '#059669' : 'var(--theme-muted)' }}>{done ? 'Done' : 'Pending'}</span>
    </li>
  );
}

function DocUpload({ label, category, onUpload, busy, done }) {
  const [fileName, setFileName] = useState(null);
  return (
    <div>
      <span className="mb-1 block text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{label}</span>
      <label className="flex cursor-pointer items-center justify-center rounded-xl border border-dashed px-4 py-6 text-sm transition" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
        <input
          type="file"
          className="hidden"
          accept="image/*,application/pdf"
          onChange={async (e) => {
            const f = e.target.files && e.target.files[0];
            if (!f) return;
            const ok = await onUpload(f, category);
            if (ok) setFileName(f.name);
          }}
        />
        {busy ? 'Uploading…' : fileName ? `${fileName} ✓` : done ? 'Document received — click to replace' : 'Click to choose a file'}
      </label>
    </div>
  );
}

// E-sign step — loads the sign-page payload for a magic-link sign token (from
// ?signToken=, minted when HR sends an envelope) and renders <ESignPanel>. The
// token IS the auth (the public /api/hr/esign/sign/:token routes), so this works
// for a pre-join candidate with no portal session too. With no token it shows a
// gentle "nothing to sign yet" note rather than an error.
function EsignStep({ signToken }) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(!!signToken);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [signed, setSigned] = useState(false);

  async function load() {
    if (!signToken) return;
    setLoading(true); setError(null);
    try {
      const data = await apiGet(`/api/hr/esign/sign/${encodeURIComponent(signToken)}`);
      setPayload(data);
      setSigned(!!(data && (data.alreadySigned || (data.signer && data.signer.status === 'SIGNED'))));
    } catch (e) {
      setError(e.status === 401 ? 'This signing link is invalid or has expired.' : (e.message || 'Could not load the document.'));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [signToken]);

  async function onSubmit({ signatureImageDataUrl, consent }) {
    setBusy(true); setError(null);
    try {
      await apiSend(`/api/hr/esign/sign/${encodeURIComponent(signToken)}`, 'POST', { signatureImageDataUrl, consent });
      setSigned(true);
      await load();
    } catch (e) {
      setError(e.message || 'Could not record your signature. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!signToken) {
    return (
      <div className="rounded-xl border border-dashed p-5 text-center text-sm" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
        There is nothing for you to sign yet. If HR sends you a document to sign, open it from the link in your email.
      </div>
    );
  }
  if (loading) return <Centered><Spinner /></Centered>;
  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} />}
      {signed ? (
        <div className="rounded-xl border p-4 text-center" style={{ borderColor: '#059669' }}>
          <p className="text-base font-semibold" style={{ color: '#059669' }}>Signed ✓</p>
          <p className="mt-1 text-sm" style={{ color: 'var(--theme-muted)' }}>Thank you — your signature has been recorded.</p>
        </div>
      ) : (
        payload && <ESignPanel payload={payload} onSubmit={onSubmit} busy={busy} />
      )}
    </div>
  );
}

// Pre-join (token) renders bare so a candidate with no session is not bounced to
// /login; the logged-in flow uses the session-guarded AppShell chrome.
function BareShell({ children }) {
  return (
    <div className="flex min-h-screen flex-col">
      <BrandHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-5">{children}</main>
    </div>
  );
}

function OnboardingRouter() {
  const params = useSearchParams();
  const token = params.get('token');
  if (token) return <BareShell><Wizard /></BareShell>;
  return <AppShell><Wizard /></AppShell>;
}

export default function OnboardingPage() {
  return (
    <Suspense fallback={<Centered><Spinner /></Centered>}>
      <OnboardingRouter />
    </Suspense>
  );
}
