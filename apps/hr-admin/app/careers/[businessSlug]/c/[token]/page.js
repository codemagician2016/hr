'use client';

// PUBLIC candidate status / timeline (Feature 36) — UNAUTHENTICATED, tokenised.
// A candidate opens the "track your application" link from any of our messages and
// sees, with NO login, where each of their applications stands (friendly labels
// only — never a score, an internal note, or another candidate). Reads:
//   GET /api/public/careers/:businessSlug/c/:token
//        → { business:{name,slug}, applications:[{ role, stageLabel, nextStep,
//            appliedAt, lastUpdateAt }] }
//
// When interview times have been proposed, the same page shows a slot picker.
// Because the timeline response does not carry the proposal id, the picker is
// reached via a `?slot=<proposalId>` query on the link:
//   GET  /api/public/careers/:businessSlug/c/:token/slots/:proposalId
//        → { proposalId, status, slots:[{id,startAt,endAt}], confirmedSlot, expiresAt, role }
//   POST .../slots/:proposalId/confirm { slotId }
//        → { ok, status:'CONFIRMED', confirmedSlot, ics }  (409 if already taken)
//
// Matches the public apply page styling (gradient page, rounded cards, theme
// primary, "Powered by DriftHR" footer). Mobile-first.

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { get, post } from '@/lib/api';

const STAGE_TONES = {
  'Application received': 'bg-blue-50 text-blue-700 border-blue-200',
  'Under review': 'bg-indigo-50 text-indigo-700 border-indigo-200',
  'Assessment stage': 'bg-violet-50 text-violet-700 border-violet-200',
  'Interview stage': 'bg-amber-50 text-amber-700 border-amber-200',
  'Offer extended': 'bg-teal-50 text-teal-700 border-teal-200',
  'Offer accepted': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  'Not selected this time': 'bg-gray-100 text-gray-500 border-gray-200',
};

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function Centered({ children }) {
  return <div className="min-h-screen bg-gray-50 flex items-center justify-center px-5">{children}</div>;
}

export default function CandidateStatusPage() {
  const { businessSlug, token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [proposalId, setProposalId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await get(`/api/public/careers/${businessSlug}/c/${token}`);
      setData(d);
      // The timeline now surfaces the active slot proposal directly (backend
      // attaches `activeSlotProposal` to any application awaiting a pick), so the
      // candidate reaches the picker from the bare status link with no ?slot=.
      const fromTimeline = (d.applications || [])
        .map((a) => a.activeSlotProposal && a.activeSlotProposal.proposalId)
        .find(Boolean);
      const fromQuery = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('slot')
        : null;
      setProposalId(fromTimeline || fromQuery || null);
    } catch (e) {
      setError(e.status === 404 ? 'This tracking link is no longer valid.' : (e.data?.message || e.message));
    }
  }, [businessSlug, token]);
  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <Centered>
        <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm max-w-md">
          <div className="text-lg font-semibold text-gray-900">{error}</div>
          <p className="text-sm text-gray-500 mt-2">If you applied recently, please check the most recent email or message we sent you for a fresh link.</p>
        </div>
      </Centered>
    );
  }
  if (!data) return <Centered><div className="text-sm text-gray-400">Loading…</div></Centered>;

  const { business, applications } = data;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="max-w-2xl mx-auto px-5 py-10">
        <header className="mb-6">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">{business?.name}</div>
          <h1 className="text-3xl font-semibold text-gray-900 mt-1">Your application status</h1>
          <p className="text-sm text-gray-500 mt-2">Here&apos;s where things stand. We&apos;ll keep this page up to date as you move through our hiring process.</p>
        </header>

        {proposalId && (
          <SlotPicker businessSlug={businessSlug} token={token} proposalId={proposalId} />
        )}

        {(!applications || applications.length === 0) ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
            <p className="text-sm text-gray-500">We don&apos;t have any active applications on this link right now.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {applications.map((a, i) => {
              const tone = STAGE_TONES[a.stageLabel] || 'bg-gray-100 text-gray-600 border-gray-200';
              return (
                <section key={i} className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-base font-semibold text-gray-900">{a.role}</h2>
                    <span className={`shrink-0 inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}>{a.stageLabel}</span>
                  </div>
                  {a.nextStep && <p className="text-sm text-gray-600 mt-2">{a.nextStep}</p>}
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-gray-400">
                    {a.appliedAt && <span>Applied {fmtDate(a.appliedAt)}</span>}
                    {a.lastUpdateAt && <span>Last update {fmtDate(a.lastUpdateAt)}</span>}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        <footer className="mt-10 text-center text-[11px] text-gray-400">Powered by DriftHR</footer>
      </div>
    </div>
  );
}

// ── Slot picker ───────────────────────────────────────────────────────────────
// Shown when the link carries ?slot=<proposalId>. The candidate picks one of the
// proposed times; confirming stamps the interview + returns an ICS to add to their
// calendar. Handles the double-confirm race (409 → shows the confirmed time).
function SlotPicker({ businessSlug, token, proposalId }) {
  const [proposal, setProposal] = useState(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(null); // { confirmedSlot, ics }

  const load = useCallback(async () => {
    setError('');
    try {
      const p = await get(`/api/public/careers/${businessSlug}/c/${token}/slots/${proposalId}`);
      setProposal(p);
      if (p.status === 'CONFIRMED' && p.confirmedSlot) setConfirmed({ confirmedSlot: p.confirmedSlot, ics: null });
    } catch (e) {
      setError(e.status === 404 ? 'This scheduling link is no longer valid.' : (e.data?.message || e.message));
    }
  }, [businessSlug, token, proposalId]);
  useEffect(() => { load(); }, [load]);

  async function confirm() {
    if (!chosen) { setError('Please choose a time first.'); return; }
    setConfirming(true); setError('');
    try {
      const res = await post(`/api/public/careers/${businessSlug}/c/${token}/slots/${proposalId}/confirm`, { slotId: chosen });
      setConfirmed({ confirmedSlot: res.confirmedSlot, ics: res.ics || null });
    } catch (e) {
      // 409 = the slot was just taken / already confirmed → surface the winning time.
      if (e.status === 409 && e.data?.confirmedSlot) {
        setConfirmed({ confirmedSlot: e.data.confirmedSlot, ics: null });
      }
      setError(e.data?.message || e.message || 'Could not confirm that time. Please try again.');
    } finally { setConfirming(false); }
  }

  if (error && !proposal && !confirmed) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm mb-4 text-sm text-amber-800">{error}</div>
    );
  }
  if (!proposal && !confirmed) {
    return <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm mb-4 text-sm text-gray-400">Loading interview times…</div>;
  }

  const role = proposal?.role || 'your interview';
  const expired = proposal && proposal.status === 'PROPOSED' && proposal.expiresAt && new Date(proposal.expiresAt).getTime() < Date.now();

  return (
    <section className="rounded-2xl border-2 bg-white p-5 shadow-sm mb-6" style={{ borderColor: confirmed ? '#10b981' : 'var(--theme-primary, #4f46e5)' }}>
      {confirmed ? (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 text-base">✓</span>
            <h2 className="text-base font-semibold text-gray-900">Interview confirmed</h2>
          </div>
          <p className="text-sm text-gray-600">You&apos;re booked for <b>{fmtDateTime(confirmed.confirmedSlot?.startAt)}</b>{confirmed.confirmedSlot?.endAt ? ` – ${new Date(confirmed.confirmedSlot.endAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}. We&apos;ve emailed you the details.</p>
          {confirmed.ics && (
            <a
              href={`data:text/calendar;charset=utf-8,${encodeURIComponent(confirmed.ics)}`}
              download="interview.ics"
              className="mt-4 inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm"
              style={{ background: 'var(--theme-primary, #4f46e5)' }}
            >
              Add to calendar
            </a>
          )}
        </div>
      ) : (
        <div>
          <h2 className="text-base font-semibold text-gray-900">Pick a time that works for you</h2>
          <p className="text-sm text-gray-500 mt-0.5">Choose one of the proposed times for {role}.</p>
          {expired ? (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">These times have expired. Please contact us to reschedule.</div>
          ) : proposal.status !== 'PROPOSED' ? (
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">This scheduling request is no longer open.</div>
          ) : (
            <>
              <div className="mt-3 space-y-2">
                {(proposal.slots || []).map((s) => (
                  <label key={s.id} className={`flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors ${chosen === s.id ? 'border-transparent ring-2' : 'border-gray-200 hover:border-gray-300'}`} style={chosen === s.id ? { boxShadow: '0 0 0 2px var(--theme-primary, #4f46e5)' } : undefined}>
                    <input type="radio" name="slot" checked={chosen === s.id} onChange={() => setChosen(s.id)} className="h-4 w-4" style={{ accentColor: 'var(--theme-primary, #4f46e5)' }} />
                    <span className="text-sm text-gray-800">
                      {fmtDateTime(s.startAt)}
                      {s.endAt && <span className="text-gray-400"> – {new Date(s.endAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>}
                    </span>
                  </label>
                ))}
              </div>
              {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
              <button
                type="button" onClick={confirm} disabled={confirming || !chosen}
                className="mt-4 w-full rounded-xl py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-60"
                style={{ background: 'var(--theme-primary, #4f46e5)' }}
              >
                {confirming ? 'Confirming…' : 'Confirm this time'}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
