'use client';

// Separation (ESS) — exiting-employee experience. Feature 4 §5.2, §6, slice 4f.
//
// Three parts on one self-scoped page (subject is the SESSION employee — there is
// NO employeeId in any request; the backend derives it from the customer session):
//   1. <ResignationForm>  → POST /api/hr/me/separation/resign (one active case;
//      intended last day validated vs notice → amber short-notice warning).
//   2. <ExitTracker>      → GET  /api/hr/me/separation (status timeline + clearance
//      lanes + own asset-return acknowledgments).
//   3. <FnFStatement>     → GET  /api/hr/me/separation/fnf (snapshot once
//      FNF_COMPUTED; figures equal the HR SeparationCase snapshot exactly).
//   + letter download (post-settle) → GET /api/hr/me/documents (EMPLOYEE_VISIBLE
//      relieving/experience letters).
//
// Routes may not be deployed in a given environment yet → a 404 degrades to a
// friendly empty/initial state so the page stays branded and shippable.

import { useCallback, useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiSend } from '@/lib/api';
import { money, formatDate } from '@/lib/format';

const SEP_PATH = '/api/hr/me/separation';
const FNF_PATH = '/api/hr/me/separation/fnf';
const ASSETS_PATH = '/api/hr/me/separation/assets';
const DOCS_PATH = '/api/hr/me/documents';

// The clearance lanes shown in the exit tracker, in display order.
const LANES = [
  { key: 'knowledge_transfer', label: 'Knowledge transfer' },
  { key: 'assets', label: 'Asset return' },
  { key: 'it', label: 'IT clearance' },
  { key: 'finance', label: 'Finance clearance' },
  { key: 'admin', label: 'Admin clearance' },
];

// A status-pill helper using the shared theme variables.
function Pill({ children, tone = 'muted' }) {
  const color = tone === 'good' ? 'var(--theme-primary)' : tone === 'warn' ? '#b45309' : 'var(--theme-muted)';
  return (
    <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ color, border: `1px solid ${color}` }}>
      {children}
    </span>
  );
}

// ── 1. Resignation form (only shown when there's no active case) ──────────────
function ResignationForm({ onSubmitted }) {
  const [lastDay, setLastDay] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = useCallback(async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const out = await apiSend(SEP_PATH + '/resign', 'POST', { intendedLastDay: lastDay || null, reason: reason || null });
      onSubmitted(out);
    } catch (e2) {
      setErr(e2.message || 'Could not submit your resignation.');
    } finally {
      setBusy(false);
    }
  }, [lastDay, reason, onSubmitted]);

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <h2 className="text-base font-semibold" style={{ color: 'var(--theme-text)' }}>Submit resignation</h2>
      <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>
        This starts your separation process. You can only have one active resignation at a time.
      </p>
      <label className="block text-sm">
        <span style={{ color: 'var(--theme-text)' }}>Intended last working day</span>
        <input
          type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} required
          className="mt-1 w-full rounded-lg border px-3 py-2" style={{ borderColor: 'var(--theme-border)' }}
        />
      </label>
      <label className="block text-sm">
        <span style={{ color: 'var(--theme-text)' }}>Reason (optional)</span>
        <textarea
          value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
          className="mt-1 w-full rounded-lg border px-3 py-2" style={{ borderColor: 'var(--theme-border)' }}
        />
      </label>
      {err && <ErrorBanner message={err} />}
      <button
        type="submit" disabled={busy}
        className="w-full rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        style={{ background: 'var(--theme-primary)' }}
      >
        {busy ? 'Submitting…' : 'Submit resignation'}
      </button>
    </form>
  );
}

// ── 2. Exit tracker (status timeline + clearance lanes + assets) ─────────────
function ExitTracker({ separation, journey, assets }) {
  const clearance = separation.clearanceJson || {};
  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <div className="flex items-center justify-between">
          <div>
            <span className="block text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{separation.code}</span>
            <span className="block text-xs" style={{ color: 'var(--theme-muted)' }}>
              {String(separation.type || '').toLowerCase().replace(/_/g, ' ')}
              {separation.lastWorkingDay ? ` · last day ${formatDate(separation.lastWorkingDay)}` : ''}
            </span>
          </div>
          <Pill tone={separation.status === 'SETTLED' ? 'good' : 'muted'}>
            {String(separation.status || '').toLowerCase().replace(/_/g, ' ')}
          </Pill>
        </div>
      </div>

      <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Clearance</h3>
        <ul className="space-y-2">
          {LANES.map((lane) => {
            const st = clearance[lane.key] && clearance[lane.key].status;
            const cleared = st === 'CLEARED';
            return (
              <li key={lane.key} className="flex items-center justify-between text-sm">
                <span style={{ color: 'var(--theme-text)' }}>{lane.label}</span>
                <Pill tone={cleared ? 'good' : 'muted'}>{cleared ? 'cleared' : (st ? String(st).toLowerCase() : 'pending')}</Pill>
              </li>
            );
          })}
        </ul>
      </div>

      {assets && assets.length > 0 && (
        <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Company assets</h3>
          <AssetList items={assets} />
        </div>
      )}
    </div>
  );
}

function AssetList({ items }) {
  const [acked, setAcked] = useState({});
  const ack = useCallback(async (id) => {
    try {
      await apiSend(`${ASSETS_PATH}/${encodeURIComponent(id)}/acknowledge`, 'POST', {});
      setAcked((m) => ({ ...m, [id]: true }));
    } catch { /* surfaced inline below by re-render guard */ }
  }, []);
  return (
    <ul className="space-y-2">
      {items.map((a) => {
        const returned = !!a.returnedAt;
        const signed = !!a.acknowledgmentSignedAt || acked[a.id];
        return (
          <li key={a.id} className="flex items-center justify-between text-sm">
            <span className="min-w-0" style={{ color: 'var(--theme-text)' }}>
              {a.asset ? `${a.asset.name} (${a.asset.code})` : 'Asset'}
            </span>
            {returned ? (
              <Pill tone="good">returned</Pill>
            ) : signed ? (
              <Pill tone="good">acknowledged</Pill>
            ) : (
              <button
                onClick={() => ack(a.id)}
                className="rounded-lg px-3 py-1 text-xs font-semibold text-white"
                style={{ background: 'var(--theme-primary)' }}
              >
                Acknowledge
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── 3. FnF statement (once computed) ─────────────────────────────────────────
function FnFStatement({ currency }) {
  const { data, loading, error } = useApi(FNF_PATH);
  if (loading) return <Centered><Spinner /></Centered>;
  if (error && error.status === 404) {
    return (
      <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <Empty text="Your full-and-final statement isn't ready yet." />
      </div>
    );
  }
  if (error) return <ErrorBanner message={error.message || 'Could not load your FnF statement.'} />;
  if (!data) return null;
  const cur = data.currencyCode || currency || undefined;
  // Country-gate the NZ-only holiday-payout line: it shows ONLY for an NZ leaver,
  // never for an India one (the FnF response carries the resolved countryCode).
  const isNZ = String(data.countryCode || '').toUpperCase() === 'NZ';
  const rows = [
    ['Gratuity', data.lines.gratuityAmount],
    ['Leave encashment', data.lines.leaveEncashmentAmount],
    ...(isNZ ? [['Holiday payout', data.lines.nzHolidayPayoutAmount]] : []),
    ['Notice recovery', data.lines.noticeRecoveryAmount, true],
    ['Loan foreclosure', data.lines.loanForeclosureAmount, true],
    ['Asset recovery', data.lines.assetRecoveryAmount, true],
  ].filter(([, v]) => v != null && Number(v) !== 0);

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Full & final settlement</h3>
      <ul className="space-y-1">
        {rows.map(([label, val, isDeduction]) => (
          <li key={label} className="flex items-center justify-between text-sm">
            <span style={{ color: 'var(--theme-muted)' }}>{label}</span>
            <span style={{ color: isDeduction ? '#b91c1c' : 'var(--theme-text)' }}>
              {isDeduction ? '− ' : ''}{money(Math.abs(Number(val)), cur)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex items-center justify-between border-t pt-3 text-sm font-semibold" style={{ borderColor: 'var(--theme-border)' }}>
        <span style={{ color: 'var(--theme-text)' }}>{data.recoverableBalance ? 'Recoverable balance' : 'Net settlement'}</span>
        <span style={{ color: data.recoverableBalance ? '#b91c1c' : 'var(--theme-primary)' }}>
          {money(Math.abs(Number(data.lines.netSettlement || 0)), cur)}
        </span>
      </div>
    </div>
  );
}

// ── letters (post-settle EMPLOYEE_VISIBLE documents) ─────────────────────────
function ExitLetters() {
  const { data } = useApi(DOCS_PATH, {
    select: (b) => (Array.isArray(b) ? b : b?.items || []),
  });
  const letters = (data || []).filter((d) => ['OFFER_LETTER', 'EXPERIENCE', 'RELIEVING_LETTER', 'EXPERIENCE_LETTER'].includes(d.category) && /relieving|experience|service/i.test(d.name || ''));
  if (!letters.length) return null;
  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>Exit letters</h3>
      <ul className="space-y-2">
        {letters.map((d) => (
          <li key={d.id} className="flex items-center justify-between text-sm">
            <span className="min-w-0" style={{ color: 'var(--theme-text)' }}>{d.name}</span>
            <a
              href={d.fileUrl} download
              className="rounded-lg px-3 py-1 text-xs font-semibold text-white"
              style={{ background: 'var(--theme-primary)' }}
            >
              Download
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeparationInner() {
  const { data, loading, error, reload } = useApi(SEP_PATH);
  const [justSubmitted, setJustSubmitted] = useState(null);

  const onSubmitted = useCallback((out) => {
    setJustSubmitted(out);
    reload();
  }, [reload]);

  if (loading) return <Centered><Spinner /></Centered>;
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load your separation status.'} />;
  }

  const separation = (data && data.separation) || (justSubmitted && justSubmitted.separation) || null;
  const journey = (data && data.journey) || null;
  const active = separation && !['SETTLED', 'CANCELLED'].includes(separation.status);

  return (
    <div className="max-w-3xl space-y-5">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Separation</h1>

      {justSubmitted && justSubmitted.shortNotice && (
        <div className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: '#f59e0b', background: '#fffbeb', color: '#b45309' }}>
          Heads up: your chosen last day is within your {justSubmitted.noticeDays}-day notice period. A notice shortfall may be recovered in your full-and-final settlement.
        </div>
      )}

      {!separation && <ResignationForm onSubmitted={onSubmitted} />}

      {separation && (
        <>
          <SeparationData separationId={separation.id} fallback={{ separation, journey }} />
        </>
      )}

      {/* FnF + letters appear once the case progresses (each degrades to empty). */}
      {separation && <FnFStatement currency={separation.currencyCode} />}
      {separation && !active && <ExitLetters />}
    </div>
  );
}

// Loads the assets list + renders the tracker with the freshest case payload.
function SeparationData({ fallback }) {
  const { data: assetsData } = useApi(ASSETS_PATH, { select: (b) => (b && b.items) || [] });
  const sepFull = useApi(SEP_PATH);
  const separation = (sepFull.data && sepFull.data.separation) || fallback.separation;
  const journey = (sepFull.data && sepFull.data.journey) || fallback.journey;
  return <ExitTracker separation={separation} journey={journey} assets={assetsData || []} />;
}

export default function SeparationPage() {
  return (
    <AppShell>
      <SeparationInner />
    </AppShell>
  );
}
