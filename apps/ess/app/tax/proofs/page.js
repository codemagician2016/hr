'use client';

// Investment proofs (Feature 20) — the year-end ESS upload surface. For each thing the
// employee declared (80C / 80D / 24b home-loan / HRA rent) they upload evidence; HR
// verifies it; after the proof deadline only verified amounts reduce TDS. Window-gated
// (uploads only while OPEN). India-only + OLD-regime-only (NEW skips proofs). A deadline
// countdown + a Form 12BB download once the window closes.

import { useCallback, useEffect, useRef, useState } from 'react';
import AppShell from '@/components/AppShell';
import { Spinner, ErrorBanner, Empty } from '@hr/ui';
import { apiGet, apiPost, apiSend } from '@/lib/api';
import { money } from '@/lib/format';
import { useCountry } from '@/lib/useCountry';

const BASE = '/api/hr/me/proofs';

function Card({ title, children, right }) {
  return (
    <section className="rounded-2xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      {title && (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-muted)' }}>{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).getTime();
  const now = Date.now();
  return Math.ceil((d - now) / 86400000);
}

// Read a File → base64 data URL (the documents-upload control pattern).
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

export default function InvestmentProofsPage() {
  const { country, loading: countryLoading } = useCountry();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    apiGet(`${BASE}`)
      .then(setData)
      .catch((e) => setError(e.message || 'Could not load your investment proofs.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (countryLoading) return;
    if (country !== 'IN') { setLoading(false); return; }
    load();
  }, [country, countryLoading, load]);

  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-4 p-4">
        <header>
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Investment proofs</h1>
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
            Upload evidence for your declared investments so they reduce your TDS. After the proof deadline, only verified investments count.
          </p>
        </header>

        {(countryLoading || loading) && <Spinner />}
        {!countryLoading && country !== 'IN' && <Empty text="Investment proofs are available for India only." />}
        {error && <ErrorBanner message={error} />}

        {!loading && data && country === 'IN' && (
          <ProofsBody data={data} onChanged={load} setError={setError} />
        )}
      </div>
    </AppShell>
  );
}

function ProofsBody({ data, onChanged, setError }) {
  const { regime, proofsApplicable, window: win, rollup, financialYear } = data;

  if (!proofsApplicable) {
    return (
      <Card title="Not applicable">
        <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
          You are on the <strong>{regime} tax regime</strong>. Under the new regime, Chapter VI-A deductions and the HRA exemption do not apply,
          so investment proofs are not required. Switch to the old regime on the Tax declaration page if you want to claim deductions.
        </p>
      </Card>
    );
  }

  const dleft = win ? daysUntil(win.proofDeadline) : null;
  const canUpload = !!(win && win.canUpload);
  const windowClosed = win && (win.status === 'CLOSED' || win.status === 'LOCKED');

  return (
    <>
      <Card title={`Window — FY ${financialYear}`}>
        {!win ? (
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>The declaration window for this year is not configured yet. Your declared figures stay provisional.</p>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${win.status === 'OPEN' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>{win.status}</span>
              <span style={{ color: 'var(--theme-muted)' }}>Proof deadline: {String(win.proofDeadline).slice(0, 10)}</span>
            </div>
            {win.status === 'OPEN' && dleft != null && (
              <p className="text-sm" style={{ color: dleft <= 3 ? '#b91c1c' : 'var(--theme-muted)' }}>
                {dleft > 0
                  ? `Submit proofs in ${dleft} day${dleft === 1 ? '' : 's'} — after the deadline, only verified investments reduce your TDS and your March salary may have higher tax.`
                  : 'The deadline is today.'}
              </p>
            )}
            {windowClosed && (
              <a href={`${BASE}/form12bb.pdf?fy=${financialYear}`} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-blue-600 hover:underline">Download Form 12BB</a>
            )}
          </div>
        )}
      </Card>

      <Card title="Your declared investments">
        {rollup.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>You have not declared any deductions for this year. Add them on the Tax declaration page first.</p>
        ) : (
          <div className="space-y-3">
            {rollup.map((row) => (
              <ClaimRow
                key={row.claimType}
                row={row}
                fy={financialYear}
                canUpload={canUpload}
                proofs={(data.proofs || []).filter((p) => p.claimType === row.claimType)}
                onChanged={onChanged}
                setError={setError}
              />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

function ClaimRow({ row, fy, canUpload, proofs, onChanged, setError }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [landlordName, setLandlordName] = useState('');
  const [landlordPan, setLandlordPan] = useState('');

  const isHra = row.claimType === 'HRA_RENT';
  const needsPan = isHra && row.declared > 100000;

  async function onPick(e) {
    const file = e.target.files?.[0];
    if (file) e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const dataUrl = await fileToDataUrl(file);
      const body = {
        claimType: row.claimType,
        declaredAmount: row.declared,
        financialYear: fy,
        fileBase64: dataUrl,
        originalName: file.name,
      };
      if (isHra) {
        body.landlordName = landlordName || undefined;
        body.landlordPan = landlordPan || undefined;
      }
      await apiPost(`${BASE}`, body);
      onChanged();
    } catch (err) {
      setError(err.message || 'Upload failed. Please try a smaller PDF/JPG/PNG.');
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id) {
    setBusy(true);
    setError('');
    try {
      await apiSend(`${BASE}/${id}`, 'DELETE');
      onChanged();
    } catch (err) {
      setError(err.message || 'Could not withdraw this proof.');
    } finally {
      setBusy(false);
    }
  }

  const statusPill = (p) => {
    const map = { PENDING: 'bg-amber-100 text-amber-800', ACCEPTED: 'bg-green-100 text-green-800', REJECTED: 'bg-red-100 text-red-800' };
    return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[p.status] || 'bg-gray-100 text-gray-700'}`}>{p.status}</span>;
  };

  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{row.label}</div>
          <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
            Declared {money(row.declared, 'INR')}
            {row.verified > 0 ? <> · Verified {money(row.verified, 'INR')}</> : null}
            {row.pendingAmount > 0 ? <> · Pending {money(row.pendingAmount, 'INR')}</> : null}
          </div>
        </div>
        {canUpload && (
          <div>
            <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg" className="hidden" onChange={onPick} />
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current && fileRef.current.click()}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              style={{ background: 'var(--theme-primary)' }}
            >{busy ? 'Uploading…' : 'Upload'}</button>
          </div>
        )}
      </div>

      {canUpload && needsPan && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input
            type="text" placeholder="Landlord name"
            value={landlordName} onChange={(e) => setLandlordName(e.target.value)}
            className="rounded-lg border px-2 py-1 text-sm" style={{ borderColor: 'var(--theme-border)' }}
          />
          <input
            type="text" placeholder="Landlord PAN (required > ₹1L rent)"
            value={landlordPan} onChange={(e) => setLandlordPan(e.target.value.toUpperCase())}
            maxLength={10}
            className="rounded-lg border px-2 py-1 text-sm" style={{ borderColor: 'var(--theme-border)' }}
          />
          <p className="col-span-2 text-xs" style={{ color: 'var(--theme-muted)' }}>Rule 26C: landlord PAN is required when annual rent exceeds ₹1,00,000.</p>
        </div>
      )}

      {proofs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {proofs.map((p) => (
            <li key={p.id} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2">
                {statusPill(p)}
                <span style={{ color: 'var(--theme-muted)' }}>{p.originalName || 'proof'} · {money(p.declaredAmount, 'INR')}</span>
                {p.status === 'REJECTED' && p.rejectReason ? <span className="text-red-600">— {p.rejectReason}</span> : null}
                {p.status === 'ACCEPTED' && p.verifiedAmount != null ? <span className="text-green-700">verified {money(p.verifiedAmount, 'INR')}</span> : null}
              </span>
              {canUpload && p.status === 'PENDING' && (
                <button type="button" disabled={busy} onClick={() => withdraw(p.id)} className="text-gray-500 hover:text-red-600">Withdraw</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
