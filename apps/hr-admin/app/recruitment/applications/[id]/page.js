'use client';

// Candidate / application profile (Feature 12). Shows the application score
// breakdown (screening lines with per-line points, knockout status), the
// interviews + scorecard progress ("2 of 3 cards in"), and the action rail:
// shortlist/reject (stage moves), schedule an interview (panel + scorecard
// template + slot → send invitation), and make/accept an offer (the India 50%
// wage check runs server-side; accept seeds onboarding). Every field has an ⓘ
// tooltip. Server is the RBAC boundary.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorBanner, PrimaryButton, TextInput, Modal, ModalActions, Spinner } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, StatusBadge, ActionButton, PageHeader } from '@/lib/ui';
import { Info, FieldLabel, ScoreBadge, NumberInput, ChannelChips, renderMergePreview } from '../../_components';

export default function ApplicationPage() {
  const { id } = useParams();
  const [app, setApp] = useState(null);
  const [stages, setStages] = useState([]);
  const [interviews, setInterviews] = useState([]);
  const [error, setError] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [showOffer, setShowOffer] = useState(false);
  const [showMessage, setShowMessage] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const a = await get(`/api/hr/recruitment/applications/${id}`);
      setApp(a);
      const [st, iv] = await Promise.all([
        get(`/api/hr/recruitment/jobs/${a.jobId}/stages`).catch(() => ({ items: [] })),
        get('/api/hr/recruitment/interviews', { applicationId: id }).catch(() => ({ items: [] })),
      ]);
      setStages(asList(st)); setInterviews(asList(iv));
    } catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function move(stageId) {
    try { await post(`/api/hr/recruitment/applications/${id}/move`, { stageId }); load(); }
    catch (e) { setError(e.message); }
  }
  async function recompute() {
    try { await post(`/api/hr/recruitment/applications/${id}/recompute-score`, {}); load(); }
    catch (e) { setError(e.message); }
  }

  if (!app) return <div className="p-6">{error ? <ErrorBanner message={error} /> : <Spinner />}</div>;
  const cand = app.candidate || {};
  const snap = app.scoreSnapshot || {};
  const rejectStage = stages.find((s) => s.kind === 'REJECTED');
  const shortlistStage = stages.find((s) => s.kind === 'INTERVIEW') || stages.find((s) => s.kind === 'ASSESSMENT');

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link href={`/recruitment/jobs/${app.jobId}`} className="text-xs text-gray-500 hover:underline">← Back to job</Link>
      <PageHeader
        title={cand.firstName ? `${cand.firstName} ${cand.lastName}` : 'Candidate'}
        subtitle={cand.email}
        actions={<div className="flex items-center gap-2"><StatusBadge status={app.status} /><ScoreBadge score={app.screeningScore} max={app.screeningMaxScore} knockedOut={app.knockedOut} /></div>}
      />
      {error && <ErrorBanner message={error} />}

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-5">
          {/* Score breakdown */}
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900">Score breakdown
                <Info text="The exact, auditable maths behind this candidate's merit. Nothing is a black box." />
              </h2>
              <ActionButton onClick={recompute}>Recompute</ActionButton>
            </div>
            {!snap.screening && <p className="text-sm text-gray-400">No screening answers captured yet.</p>}
            {snap.screening && (
              <div className="mb-4">
                <div className="text-xs font-semibold text-gray-700 mb-1">Application — {snap.screening.score}/{snap.screening.max} ({snap.screening.pct}%)</div>
                <ul className="text-xs text-gray-600 space-y-0.5">
                  {(snap.screening.lines || []).map((l, i) => (
                    <li key={i} className="flex justify-between">
                      <span>{l.q}{l.label ? ` — ${l.label}` : ''}{l.isKnockout ? (l.knockoutFailed ? ' · KNOCKOUT FAILED' : ' · knockout passed') : ''}</span>
                      <span className="tabular-nums">+{l.awarded}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {snap.interview && (
              <div className="mb-4">
                <div className="text-xs font-semibold text-gray-700 mb-1">Interview — {snap.interview.score ?? 'pending'} ({snap.interview.aggregation}, {snap.interview.interviewers} interviewer{snap.interview.interviewers === 1 ? '' : 's'})</div>
                <ul className="text-xs text-gray-600 space-y-0.5">
                  {(snap.interview.perInterviewer || []).map((p, i) => (
                    <li key={i} className="flex justify-between"><span>{p.who}</span><span className="tabular-nums">{p.total}</span></li>
                  ))}
                </ul>
              </div>
            )}
            <div className="border-t pt-2 flex justify-between text-sm font-semibold">
              <span>Merit (weighted)</span>
              <span style={{ color: 'var(--theme-primary)' }}>{app.meritScore != null ? Number(app.meritScore) : '—'}</span>
            </div>
          </section>

          {/* Interviews */}
          <section className="rounded-2xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900">Interviews</h2>
              <PrimaryButton onClick={() => setShowSchedule(true)}>Schedule interview</PrimaryButton>
            </div>
            {interviews.length === 0 && <p className="text-sm text-gray-400">No interviews scheduled.</p>}
            <div className="space-y-2">
              {interviews.map((iv) => <InterviewRow key={iv.id} iv={iv} onChanged={load} />)}
            </div>
          </section>
        </div>

        {/* Action rail */}
        <div className="space-y-4">
          <section className="rounded-2xl border border-gray-200 bg-white p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">Actions</h3>
            <div className="space-y-2">
              {shortlistStage && <button onClick={() => move(shortlistStage.id)} className="w-full text-sm px-3 py-2 rounded-lg border border-emerald-300 text-emerald-700 hover:bg-emerald-50">Shortlist → {shortlistStage.name}</button>}
              {rejectStage && <button onClick={() => move(rejectStage.id)} className="w-full text-sm px-3 py-2 rounded-lg border border-red-300 text-red-700 hover:bg-red-50">Reject</button>}
              <button onClick={() => setShowMessage(true)} className="w-full text-sm px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">Message candidate</button>
              <button onClick={() => setShowOffer(true)} className="w-full text-sm px-3 py-2 rounded-lg border" style={{ borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }}>Make offer</button>
            </div>
          </section>

          {/* Offers — drives DRAFT → SENT → ACCEPTED (accept seeds onboarding). */}
          <OffersSection offers={asList(app.offers)} onChanged={load} />

          <section className="rounded-2xl border border-gray-200 bg-white p-4 text-xs text-gray-500 space-y-1">
            <div><b>Source:</b> {app.appliedSource || 'MANUAL'}</div>
            {cand.phone && <div><b>Phone:</b> {cand.phone}</div>}
            {cand.linkedinUrl && <div><a href={cand.linkedinUrl} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: 'var(--theme-primary)' }}>LinkedIn ↗</a></div>}
            {cand.resumeUrl && <div><a href={cand.resumeUrl} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: 'var(--theme-primary)' }}>View resume ↗</a></div>}
          </section>

          {/* Feature 38 — candidate portal profile (education / experience / skills). */}
          {(cand.headline || (cand.educations || []).length || (cand.experiences || []).length || (cand.skills || []).length) ? (
            <section className="rounded-2xl border border-gray-200 bg-white p-4 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900">Candidate profile</h3>
              {cand.headline && <p className="text-sm text-gray-700">{cand.headline}{cand.location ? ` · ${cand.location}` : ''}</p>}
              {(cand.experiences || []).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Experience</p>
                  <ul className="space-y-1">{cand.experiences.map((e) => <li key={e.id} className="text-sm text-gray-700">{e.title} @ {e.company}{e.isCurrent ? ' · current' : ''}{e.location ? ` · ${e.location}` : ''}</li>)}</ul>
                </div>
              )}
              {(cand.educations || []).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Education</p>
                  <ul className="space-y-1">{cand.educations.map((e) => <li key={e.id} className="text-sm text-gray-700">{e.level} · {e.institution}{e.fieldOfStudy ? ` · ${e.fieldOfStudy}` : ''}{e.grade ? ` · ${e.grade}` : ''}</li>)}</ul>
                </div>
              )}
              {(cand.skills || []).length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Skills</p>
                  <div className="flex flex-wrap gap-1">{cand.skills.map((s) => <span key={s.id} className="text-xs rounded-full bg-gray-100 text-gray-700 px-2 py-0.5">{s.name}{s.level ? ` · ${s.level}` : ''}</span>)}</div>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>

      {showSchedule && <ScheduleModal applicationId={id} jobId={app.jobId} onClose={() => setShowSchedule(false)} onScheduled={() => { setShowSchedule(false); load(); }} />}
      {showOffer && <OfferModal applicationId={id} countryCode={(snap && snap.countryCode)} onClose={() => setShowOffer(false)} onDone={() => { setShowOffer(false); load(); }} />}
      {showMessage && (
        <MessageDrawer
          applicationId={id} jobId={app.jobId}
          candidateName={cand.firstName ? `${cand.firstName} ${cand.lastName}` : (cand.email || 'the candidate')}
          role={app.jobTitle}
          onClose={() => setShowMessage(false)}
        />
      )}
    </div>
  );
}

// ── Offers (Feature 12) — the missing DRAFT → SENT → ACCEPTED rail. ───────────
// getApplication includes app.offers; this renders each with its status + the
// terms, and wires the existing offer endpoints:
//   • DRAFT/APPROVED/PENDING_APPROVAL → Send  (→ SENT)
//   • SENT                            → Accept (→ ACCEPTED, seeds onboarding) /
//                                       Decline (→ DECLINED)
//   • ACCEPTED                        → surfaces that onboarding was seeded
// All controls call POST /api/hr/recruitment/offers/:id/<action>; the server
// enforces the offer-approval SoD (maker ≠ checker) + F1 read-scope, so a 403
// here means "a different approver is required", which we surface verbatim.
function OffersSection({ offers, onChanged }) {
  const sorted = [...offers].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-3">
        Offers
        <Info text="An offer must be drafted, then Sent to the candidate, then marked Accepted. Accepting seeds the onboarding journey — that is what turns a candidate into a hire." />
      </h3>
      {sorted.length === 0 && <p className="text-sm text-gray-400">No offer yet. Use “Make offer” to draft one.</p>}
      <div className="space-y-2">
        {sorted.map((o) => <OfferRow key={o.id} offer={o} onChanged={onChanged} />)}
      </div>
    </section>
  );
}

function OfferRow({ offer, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canSend = ['DRAFT', 'APPROVED', 'PENDING_APPROVAL'].includes(offer.status);
  const canRespond = offer.status === 'SENT';
  async function act(action) {
    setBusy(true); setError('');
    try { await post(`/api/hr/recruitment/offers/${offer.id}/${action}`, {}); onChanged(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const amount = offer.grossMonthly != null
    ? `${offer.currencyCode} ${Number(offer.grossMonthly).toLocaleString()}/mo`
    : (offer.ctcAnnual != null ? `${offer.currencyCode} ${Number(offer.ctcAnnual).toLocaleString()} CTC` : offer.currencyCode);
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-900">{amount}</div>
        <StatusBadge status={offer.status} />
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5 space-y-0.5">
        {offer.joiningDate && <div>Joins {new Date(offer.joiningDate).toLocaleDateString()}</div>}
        {offer.sentAt && <div>Sent {new Date(offer.sentAt).toLocaleDateString()}</div>}
        {offer.status === 'ACCEPTED' && <div className="text-emerald-600">Accepted — onboarding journey seeded.</div>}
        {offer.status === 'DECLINED' && <div className="text-red-600">Declined by candidate.</div>}
      </div>
      {(canSend || canRespond) && (
        <div className="flex items-center justify-end gap-2 mt-2">
          {canSend && <ActionButton tone="positive" onClick={() => act('send')} disabled={busy}>Send offer</ActionButton>}
          {canRespond && <ActionButton tone="danger" onClick={() => act('decline')} disabled={busy}>Decline</ActionButton>}
          {canRespond && <ActionButton tone="positive" onClick={() => act('accept')} disabled={busy}>Accept</ActionButton>}
        </div>
      )}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  );
}

function InterviewRow({ iv, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPropose, setShowPropose] = useState(false);
  // The interview list endpoint does not return slot proposals, so "Awaiting
  // candidate" is tracked in-session after a successful propose (the candidate
  // confirms on their public link, which stamps scheduledAt → the row reflects it
  // on the next reload).
  const [proposal, setProposal] = useState(null);
  const submitted = (iv.scorecards || []).filter((c) => c.status === 'SUBMITTED').length;
  const total = (iv.scorecards || []).length;
  async function invite() {
    setBusy(true); setError('');
    try { await post(`/api/hr/recruitment/interviews/${iv.id}/invite`, {}); onChanged(); }
    catch (e) { setError(e.data?.message || e.message); }
    finally { setBusy(false); }
  }
  async function withdraw() {
    setBusy(true); setError('');
    try {
      await post(`/api/hr/recruitment/interviews/${iv.id}/withdraw-slots`, proposal ? { proposalId: proposal.id } : {});
      setProposal(null);
    } catch (e) { setError(e.data?.message || e.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-900">Round {iv.round} · {iv.mode}{iv.scheduledAt ? ` · ${new Date(iv.scheduledAt).toLocaleString()}` : ''}</div>
        <StatusBadge status={iv.status} />
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-xs text-gray-500">{submitted} of {total || '—'} scorecards in</span>
        <div className="flex flex-wrap items-center gap-2">
          {!iv.candidateInviteSentAt && <ActionButton onClick={invite} disabled={busy}>Send invitation</ActionButton>}
          {iv.candidateInviteSentAt && <span className="text-[11px] text-emerald-600">Invited</span>}
          {!proposal && !iv.scheduledAt && <ActionButton onClick={() => setShowPropose(true)} disabled={busy}>Propose slots</ActionButton>}
        </div>
      </div>
      {proposal && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] text-amber-700">
            <b>Awaiting candidate</b> — {proposal.slots.length} time option{proposal.slots.length === 1 ? '' : 's'} sent. They pick one on their link.
          </span>
          <button type="button" onClick={withdraw} disabled={busy} className="text-[11px] font-medium text-amber-800 underline hover:no-underline disabled:opacity-50">
            Withdraw / re-propose
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      {showPropose && (
        <ProposeSlotsModal
          interview={iv}
          onClose={() => setShowPropose(false)}
          onProposed={(p) => { setShowPropose(false); setProposal(p); }}
        />
      )}
    </div>
  );
}

// Propose 1..N interview time options → the candidate picks one on their public
// link (POST /interviews/:id/propose-slots fires candidate.slot_request). The
// backend takes { slots:[{startAt,endAt}], expiresAt? }; mode/location/video are
// already set on the interview at schedule time and shown here for context.
function ProposeSlotsModal({ interview, onClose, onProposed }) {
  const [options, setOptions] = useState(['']); // datetime-local strings
  const [durationMins, setDurationMins] = useState(interview.durationMins || 45);
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setOption = (i, v) => setOptions((arr) => arr.map((o, j) => (j === i ? v : o)));
  const addOption = () => setOptions((arr) => (arr.length >= 20 ? arr : [...arr, '']));
  const removeOption = (i) => setOptions((arr) => arr.filter((_, j) => j !== i));

  async function save(e) {
    e.preventDefault();
    const picked = options.map((s) => s.trim()).filter(Boolean);
    if (!picked.length) { setError('Add at least one date & time option.'); return; }
    const dur = Number(durationMins) > 0 ? Number(durationMins) : 45;
    const slots = picked.map((s) => {
      const start = new Date(s);
      const end = new Date(start.getTime() + dur * 60000);
      return { startAt: start.toISOString(), endAt: end.toISOString() };
    });
    setSaving(true); setError('');
    try {
      const p = await post(`/api/hr/recruitment/interviews/${interview.id}/propose-slots`, {
        slots, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      onProposed(p);
    } catch (err) { setError(err.data?.message || err.message || 'Could not send the slot options.'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Propose interview times" onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4">
        <p className="text-xs text-gray-500">
          Round {interview.round} · {interview.mode}{interview.locationText ? ` · ${interview.locationText}` : ''}{interview.videoUrl ? ' · video link set' : ''}.
          The candidate picks one of these on a no-login link; confirming sends the calendar invite to them and the panel.
        </p>
        <div>
          <FieldLabel hint="Offer 1–20 date & time options. The candidate confirms exactly one.">Time options</FieldLabel>
          <div className="space-y-2">
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="datetime-local" value={o} onChange={(e) => setOption(i, e.target.value)} className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                <button type="button" onClick={() => removeOption(i)} disabled={options.length === 1} className="text-xs text-red-600 hover:underline disabled:opacity-40">Remove</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={addOption} disabled={options.length >= 20} className="text-sm mt-2 hover:underline disabled:opacity-40" style={{ color: 'var(--theme-primary)' }}>+ Add another time</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel hint="Length of each slot in minutes — sets the calendar-invite end time.">Duration (mins)</FieldLabel>
            <NumberInput value={durationMins} onChange={setDurationMins} min={15} step={15} />
          </div>
          <div>
            <FieldLabel hint="Optional — after this the options expire and the candidate can no longer confirm. Defaults to 7 days.">Expires (optional)</FieldLabel>
            <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={saving}>{saving ? 'Sending…' : 'Send to candidate'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// Candidate message drawer — pick a candidate-facing template, preview the merged
// copy, and send it to this one candidate. There is no single-send endpoint, so
// we reuse POST /applications/bulk-message with ids:[applicationId] (the server
// resolves + scopes it exactly like a bulk send). The template's channels are
// fixed by the platform (the router decides delivery per country/budget/STOP).
const CAND_MESSAGE_KEYS = new Set([
  'HR_CAND_APPLIED', 'HR_CAND_SHORTLISTED', 'HR_CAND_INTERVIEW_INVITE',
  'HR_CAND_SLOT_REQUEST', 'HR_CAND_REJECTED', 'HR_CAND_OFFER',
]);

function MessageDrawer({ applicationId, jobId, candidateName, role, onClose }) {
  const [templates, setTemplates] = useState([]);
  const [bizName, setBizName] = useState('');
  const [selKey, setSelKey] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    get('/api/hr/recruitment/comms-templates')
      .then((r) => {
        const items = (r?.items || []).filter((t) => CAND_MESSAGE_KEYS.has(t.key));
        setTemplates(items);
        if (items[0]) setSelKey(items[0].key);
      })
      .catch((e) => setError(e.data?.message || e.message || 'Could not load message templates.'));
    // BIZ for the preview — best-effort; the real value is merged server-side.
    get('/api/tenant/resolve').then((r) => setBizName(r?.business?.name || '')).catch(() => {});
  }, []);

  const tpl = templates.find((t) => t.key === selKey) || null;
  const body = tpl ? (tpl.overrideBody || tpl.defaultBody || '') : '';
  const preview = renderMergePreview(body, {
    NAME: candidateName, ROLE: role || 'the role', BIZ: bizName || 'your company',
  });

  async function send() {
    if (!tpl) return;
    setSending(true); setError(''); setResult(null);
    try {
      const res = await post('/api/hr/recruitment/applications/bulk-message', {
        filter: { jobId }, ids: [applicationId], templateKey: tpl.key,
      });
      setResult(res);
    } catch (e) { setError(e.data?.message || e.message || 'Could not send the message.'); }
    finally { setSending(false); }
  }

  return (
    <Modal title={`Message ${candidateName}`} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      {result ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
            {result.sent ? 'Message sent.' : 'Nothing was sent.'} {result.sent} sent · {result.skipped} skipped · {result.total} targeted.
            {result.sent === 0 && result.skipped > 0 && (
              <p className="text-xs text-emerald-700 mt-1">Skipped usually means no contact on file, an already-sent duplicate, or the candidate opted out.</p>
            )}
          </div>
          <ModalActions>
            <PrimaryButton type="button" onClick={onClose}>Done</PrimaryButton>
          </ModalActions>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <FieldLabel hint="The candidate-facing message to send. Edit the copy under Settings → Candidate messages.">Template</FieldLabel>
            <select value={selKey} onChange={(e) => setSelKey(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {templates.length === 0 && <option value="">Loading…</option>}
              {templates.map((t) => <option key={t.key} value={t.key}>{t.displayName}{t.overridden ? ' (customised)' : ''}</option>)}
            </select>
          </div>

          {tpl && (
            <>
              <div className="flex items-center gap-2 text-xs text-gray-500">
                <span>Sends via:</span><ChannelChips channels={tpl.channels} />
              </div>
              <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-indigo-50/60 to-white p-3 text-sm text-gray-700">
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Preview <span className="normal-case font-normal">— [TOKENS] are filled in at send time</span></p>
                <p className="whitespace-pre-wrap">{preview}</p>
              </div>
              <p className="text-[11px] text-gray-400">A personal “track your application” link is added automatically for this candidate.</p>
            </>
          )}

          <ModalActions>
            <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
            <PrimaryButton type="button" onClick={send} disabled={sending || !tpl}>{sending ? 'Sending…' : 'Send message'}</PrimaryButton>
          </ModalActions>
        </div>
      )}
    </Modal>
  );
}

function ScheduleModal({ applicationId, jobId, onClose, onScheduled }) {
  const [round, setRound] = useState(1);
  const [mode, setMode] = useState('VIDEO');
  const [scheduledAt, setScheduledAt] = useState('');
  const [durationMins, setDurationMins] = useState(45);
  const [locationText, setLocationText] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [panel, setPanel] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/recruitment/scorecard-templates').then((r) => setTemplates(asList(r))).catch(() => {});
    get('/api/hr/employees', { pageSize: 200 }).then((r) => setEmployees(asList(r))).catch(() => {});
    get(`/api/hr/recruitment/jobs/${jobId}`).then((j) => { if (j.scorecardTemplateId) setTemplateId(j.scorecardTemplateId); }).catch(() => {});
  }, [jobId]);

  async function save(e) {
    e.preventDefault();
    if (!panel.trim()) { setError('Add at least one interviewer to the panel.'); return; }
    setSaving(true); setError('');
    try {
      await post('/api/hr/recruitment/interviews', {
        applicationId, round: Number(round), mode, scheduledAt: scheduledAt || undefined,
        durationMins: Number(durationMins), locationText: locationText || undefined, videoUrl: videoUrl || undefined,
        interviewerIds: panel, scorecardTemplateId: templateId || undefined,
      });
      onScheduled();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Schedule interview" onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel hint="Which interview round this is (1, 2, …).">Round</FieldLabel>
            <NumberInput value={round} onChange={setRound} min={1} />
          </div>
          <div>
            <FieldLabel hint="How the interview happens.">Mode</FieldLabel>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {['VIDEO', 'ONSITE', 'PHONE'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel hint="When the interview is scheduled. The candidate's invitation email + calendar invite (ICS) use this slot.">Date &amp; time</FieldLabel>
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <FieldLabel hint="Planned length in minutes (drives the calendar invite end time).">Duration (mins)</FieldLabel>
            <NumberInput value={durationMins} onChange={setDurationMins} min={15} step={15} />
          </div>
        </div>
        {mode === 'ONSITE' && (
          <div><FieldLabel hint="Room / address shown to the candidate.">Location</FieldLabel><TextInput value={locationText} onChange={(e) => setLocationText(e.target.value)} /></div>
        )}
        {mode === 'VIDEO' && (
          <div><FieldLabel hint="The meeting link emailed to the candidate.">Video link</FieldLabel><TextInput value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="https://…" /></div>
        )}
        <div>
          <FieldLabel hint="The employees on the interview panel. Each gets their own blank scorecard to fill in their portal — one card per interviewer.">Panel (interviewers)</FieldLabel>
          <select multiple value={panel.split(',').filter(Boolean)} onChange={(e) => setPanel(Array.from(e.target.selectedOptions).map((o) => o.value).join(','))} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm h-28">
            {employees.map((emp) => <option key={emp.id} value={emp.id}>{emp.firstName} {emp.lastName} {emp.code ? `(${emp.code})` : ''}</option>)}
          </select>
          <p className="text-[11px] text-gray-400 mt-1">Cmd/Ctrl-click to select multiple interviewers.</p>
        </div>
        <div>
          <FieldLabel hint="The scorecard (skill set rated 1–10) interviewers use for this round. Defaults to the job's scorecard.">Scorecard template</FieldLabel>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">— None —</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({(t.skills || []).length} skills)</option>)}
          </select>
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={saving}>{saving ? 'Scheduling…' : 'Schedule'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function OfferModal({ applicationId, onClose, onDone }) {
  const [d, setD] = useState({ currencyCode: 'INR', grossMonthly: '', basicMonthly: '', ctcAnnual: '', joiningDate: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (v) => setD((s) => ({ ...s, [k]: v }));
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await post('/api/hr/recruitment/offers', {
        applicationId, currencyCode: d.currencyCode,
        grossMonthly: d.grossMonthly ? Number(d.grossMonthly) : undefined,
        basicMonthly: d.basicMonthly ? Number(d.basicMonthly) : undefined,
        ctcAnnual: d.ctcAnnual ? Number(d.ctcAnnual) : undefined,
        joiningDate: d.joiningDate || undefined,
      });
      onDone();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  return (
    <Modal title="Make offer" onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <form onSubmit={save} className="space-y-4">
        <p className="text-xs text-gray-500">For an INR offer the India Code-on-Wages 50% check runs before save — Basic+DA must be ≥ 50% of gross.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel hint="Currency of the offer. INR triggers the India 50% wage pre-flight.">Currency</FieldLabel>
            <select value={d.currencyCode} onChange={(e) => set('currencyCode')(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {['INR', 'USD'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <FieldLabel hint="The candidate's first day. Drives the wage-rule effective date and the onboarding join anchor.">Joining date</FieldLabel>
            <input type="date" value={d.joiningDate} onChange={(e) => set('joiningDate')(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <FieldLabel hint="Monthly gross salary. Used by the 50% wage check.">Gross monthly</FieldLabel>
            <NumberInput value={d.grossMonthly} onChange={set('grossMonthly')} min={0} />
          </div>
          <div>
            <FieldLabel hint="Monthly Basic + DA. Must be ≥ 50% of gross for an INR offer.">Basic monthly</FieldLabel>
            <NumberInput value={d.basicMonthly} onChange={set('basicMonthly')} min={0} />
          </div>
          <div>
            <FieldLabel hint="Annual CTC (cost to company), for the offer letter.">CTC annual</FieldLabel>
            <NumberInput value={d.ctcAnnual} onChange={set('ctcAnnual')} min={0} />
          </div>
        </div>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-3 py-2 text-sm text-gray-600">Cancel</button>
          <PrimaryButton type="submit" disabled={saving}>{saving ? 'Creating…' : 'Create offer'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}
