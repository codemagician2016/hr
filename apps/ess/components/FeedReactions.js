'use client';

// FeedReactions — the compact reaction bar in an AnnouncementCard footer. Shows the
// five product reactions (emoji + count) and the running total; the caller's own
// reaction is highlighted. The single-reaction model: clicking a reaction PUTs it
// (replacing any previous one), clicking the one you already picked toggles it off
// (DELETE). Updates are OPTIMISTIC — we recompute the summary locally, fire the write,
// and reconcile with the server's authoritative summary (reverting on error).
//
// Contract:
//   PUT    /api/hr/me/engagement/feed/:id/reaction { kind } → { ok, reactionSummary }
//   DELETE /api/hr/me/engagement/feed/:id/reaction         → { ok, reactionSummary }
//   reactionSummary = { counts: { KIND: n }, total, myReaction }

import { useState } from 'react';
import { setFeedReaction, removeFeedReaction } from '@/lib/api';

export const REACTIONS = [
  { kind: 'LIKE', emoji: '👍', label: 'Like' },
  { kind: 'CELEBRATE', emoji: '🎉', label: 'Celebrate' },
  { kind: 'SUPPORT', emoji: '🙌', label: 'Support' },
  { kind: 'INSIGHTFUL', emoji: '💡', label: 'Insightful' },
  { kind: 'LOVE', emoji: '❤️', label: 'Love' },
];

function normalize(s) {
  return {
    counts: (s && s.counts) || {},
    total: (s && typeof s.total === 'number') ? s.total : 0,
    myReaction: (s && s.myReaction) || null,
  };
}

// Recompute the summary as if the caller just set `kind` (or removed it when `off`).
function applyLocal(summary, kind, off) {
  const counts = { ...summary.counts };
  let total = summary.total;
  if (summary.myReaction) {
    counts[summary.myReaction] = Math.max(0, (counts[summary.myReaction] || 0) - 1);
    total = Math.max(0, total - 1);
    if (!counts[summary.myReaction]) delete counts[summary.myReaction];
  }
  if (off) return { counts, total, myReaction: null };
  counts[kind] = (counts[kind] || 0) + 1;
  return { counts, total: total + 1, myReaction: kind };
}

export default function FeedReactions({ announcementId, initial }) {
  const [summary, setSummary] = useState(() => normalize(initial));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function toggle(kind) {
    if (busy) return;
    setErr('');
    const off = summary.myReaction === kind;
    const prev = summary;
    setSummary(applyLocal(summary, kind, off)); // optimistic
    setBusy(true);
    try {
      const r = off ? await removeFeedReaction(announcementId) : await setFeedReaction(announcementId, kind);
      setSummary(normalize(r && r.reactionSummary));
    } catch (e) {
      setSummary(prev); // revert
      setErr(e.message || 'Could not save your reaction.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {REACTIONS.map((r) => {
          const count = summary.counts[r.kind] || 0;
          const mine = summary.myReaction === r.kind;
          return (
            <button
              key={r.kind}
              type="button"
              onClick={() => toggle(r.kind)}
              disabled={busy}
              aria-pressed={mine}
              title={r.label}
              className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition disabled:opacity-60"
              style={{
                borderColor: mine ? 'var(--theme-primary)' : 'var(--theme-border)',
                background: mine ? 'var(--theme-primary-soft)' : 'transparent',
                color: mine ? 'var(--theme-primary)' : 'var(--theme-text)',
                fontWeight: mine ? 600 : 400,
              }}
            >
              <span aria-hidden="true">{r.emoji}</span>
              {count > 0 && <span>{count}</span>}
            </button>
          );
        })}
        {summary.total > 0 && (
          <span className="ml-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
            {summary.total} {summary.total === 1 ? 'reaction' : 'reactions'}
          </span>
        )}
      </div>
      {err && <p className="mt-1 text-xs" style={{ color: '#dc2626' }} role="alert">{err}</p>}
    </div>
  );
}
