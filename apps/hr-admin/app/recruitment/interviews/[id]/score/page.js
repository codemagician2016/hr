'use client';

// Interviewer scoring screen (Feature 12). An interviewer on the panel rates each
// skill 1–10 with optional notes + an overall recommendation, then submits. Uses
// the scope-bound /me/* endpoints so the caller only ever touches THEIR OWN card
// for an interview they're assigned to (the server enforces SoD — a non-panellist
// or another interviewer's card 404s). Save keeps a draft; Submit locks the card
// and feeds the candidate's interview score + merit.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorBanner, PrimaryButton, TextArea, Spinner } from '@hr/ui';
import { get, patch, post } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { Info, FieldLabel, SkillSlider } from '../../../_components';

const RECS = ['STRONG_YES', 'YES', 'NEUTRAL', 'NO', 'STRONG_NO'];

export default function ScoreInterviewPage() {
  const { id } = useParams(); // interviewId
  const [data, setData] = useState(null);     // { card, skills, interview }
  const [ratings, setRatings] = useState({}); // skillId → { score, comment }
  const [notes, setNotes] = useState('');
  const [recommendation, setRecommendation] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await get(`/api/hr/recruitment/me/scorecards/${id}`);
      setData(d);
      setNotes(d.card.notes || '');
      setRecommendation(d.card.recommendation || '');
      const r = {};
      for (const rt of (d.card.ratings || [])) r[rt.skillId] = { score: rt.score, comment: rt.comment || '' };
      setRatings(r);
    } catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!data) return <div className="p-6">{error ? <ErrorBanner message={error} /> : <Spinner />}</div>;
  const locked = data.card.status === 'SUBMITTED';
  const skills = data.skills || [];
  const cand = data.interview && data.interview.candidate;

  function setScore(skillId, score) { setRatings((r) => ({ ...r, [skillId]: { ...(r[skillId] || {}), score } })); }
  function setComment(skillId, comment) { setRatings((r) => ({ ...r, [skillId]: { ...(r[skillId] || {}), comment } })); }

  function ratingPayload() {
    return skills.map((s) => ({ skillId: s.id, score: ratings[s.id]?.score ?? s.scaleMin, comment: ratings[s.id]?.comment || '' }));
  }

  async function save() {
    setBusy(true); setError(''); setMsg('');
    try {
      const updated = await patch(`/api/hr/recruitment/me/scorecards/${data.card.id}`, { ratings: ratingPayload(), notes, recommendation: recommendation || undefined, version: data.card.version });
      setData((d) => ({ ...d, card: { ...d.card, version: updated.version } }));
      setMsg('Draft saved.');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true); setError(''); setMsg('');
    try {
      // persist latest ratings first, then submit
      await patch(`/api/hr/recruitment/me/scorecards/${data.card.id}`, { ratings: ratingPayload(), notes, recommendation: recommendation || undefined, version: data.card.version });
      await post(`/api/hr/recruitment/me/scorecards/${data.card.id}/submit`, {});
      setMsg('Scorecard submitted. Thank you.');
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <Link href="/recruitment" className="text-xs text-gray-500 hover:underline">← Recruitment</Link>
      <PageHeader
        title="Score this interview"
        subtitle={`${data.interview?.jobTitle || ''}${cand ? ` · ${cand.firstName} ${cand.lastName}` : ''}`}
      />
      {error && <ErrorBanner message={error} />}
      {msg && <div className="mb-3 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{msg}</div>}

      {locked && <div className="mb-4 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">This scorecard is submitted and locked. Ask HR to reopen it if you need to change a rating.</div>}

      {skills.length === 0 && <p className="text-sm text-gray-500">No scorecard template is attached to this interview round.</p>}

      <div className={`space-y-3 ${locked ? 'opacity-60 pointer-events-none' : ''}`}>
        {skills.map((s) => (
          <SkillSlider key={s.id} skill={s} value={ratings[s.id]?.score} comment={ratings[s.id]?.comment}
            onScore={(v) => setScore(s.id, v)} onComment={(v) => setComment(s.id, v)} />
        ))}
      </div>

      <div className={`mt-5 space-y-4 ${locked ? 'opacity-60 pointer-events-none' : ''}`}>
        <div>
          <FieldLabel hint="Your overall hire/no-hire recommendation for this candidate.">Recommendation</FieldLabel>
          <select value={recommendation} onChange={(e) => setRecommendation(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">— Select —</option>
            {RECS.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel hint="Free-text notes so a busy HR can remember exactly how this interview went.">Notes</FieldLabel>
          <TextArea value={notes} onChange={(v) => setNotes(v)} rows={3} />
        </div>
      </div>

      {!locked && (
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={save} disabled={busy} className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40">Save draft</button>
          <PrimaryButton onClick={submit} disabled={busy}>{busy ? 'Submitting…' : 'Submit scorecard'}</PrimaryButton>
          <Info text="Submitting locks your card and adds your weighted score to the candidate's interview total. You can't edit it afterward without HR reopening it." />
        </div>
      )}
    </div>
  );
}
