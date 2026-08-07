'use client';

// Shared presentational helpers for the Recruitment / ATS console (Feature 12).
// Pure presentation — no data fetching. Built on the @hr/ui kit + lib/ui.js.

import { useState } from 'react';

// ── ⓘ tooltip — a layman-friendly hint shown on every field (spec requirement) ──
// Hover/focus reveals the explanation; keyboard-accessible and unobtrusive.
export function Info({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <span className="relative inline-flex align-middle ml-1">
      <button
        type="button"
        aria-label="More information"
        className="h-4 w-4 inline-flex items-center justify-center rounded-full border border-gray-300 text-[10px] leading-none text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-offset-1"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute z-20 left-1/2 -translate-x-1/2 top-6 w-60 rounded-lg bg-gray-900 text-white text-xs leading-snug px-3 py-2 shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}

// ── why the merit number is what it is ──────────────────────────────────────
// Merit blends the application % and the interview score using the job's weights,
// but it RENORMALISES over the components that exist yet. So before any interview
// is scored, merit collapses to exactly the application % — and the screen looked
// like it had ignored the configured weight. Worse, a 3/20 application is 15%, so
// "(15%)" and a merit of 15 are two unrelated quantities that print the same.
// Showing the weights actually applied is what makes the number checkable by hand.
export function MeritExplainer({ snap }) {
  if (!snap) return null;
  const cfgApp = snap.applicationWeightPct;
  const cfgIv = snap.interviewWeightPct;
  const effApp = snap.effectiveApplicationWeightPct;
  const effIv = snap.effectiveInterviewWeightPct;
  if (effApp == null || effIv == null) return null;

  const renormalised = (cfgApp != null && cfgIv != null)
    && (Math.round(effApp) !== Math.round(cfgApp) || Math.round(effIv) !== Math.round(cfgIv));
  const pending = snap.interview && snap.interview.pending;
  const appPct = snap.screening ? snap.screening.pct : null;

  return (
    <p className="mt-1 text-[11px] leading-snug text-gray-500">
      {snap.screening && snap.screening.knockedOut ? (
        <>Merit is <strong>0</strong> because a knockout question failed — weights are not applied.</>
      ) : (
        <>
          {effApp > 0 && appPct != null && (
            <>{`${round1(effApp)}% × ${appPct}% (application)`}</>
          )}
          {effIv > 0 && snap.interview && snap.interview.score != null && (
            <>{` + ${round1(effIv)}% × ${snap.interview.score} (interview)`}</>
          )}
          {renormalised && (
            <>
              {' — '}
              {pending
                ? `the interview is not scored yet, so the application carries the full weight (configured ${round1(cfgApp)}/${round1(cfgIv)})`
                : `weights renormalised from ${round1(cfgApp)}/${round1(cfgIv)} over the components present`}
            </>
          )}
        </>
      )}
    </p>
  );
}

function round1(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return Math.round(v * 10) / 10;
}

// A field label with an inline ⓘ hint.
export function FieldLabel({ children, hint }) {
  return (
    <label className="block text-xs font-medium text-gray-600 mb-1">
      {children}
      <Info text={hint} />
    </label>
  );
}

// Score badge — "38/50" with a coarse colour by ratio; a red KO chip variant.
export function ScoreBadge({ score, max, knockedOut }) {
  if (knockedOut) {
    return <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 text-red-700 px-2 py-0.5 text-xs font-semibold">KO</span>;
  }
  if (score == null) return <span className="text-xs text-gray-400">—</span>;
  const pct = max ? Number(score) / Number(max) : null;
  let cls = 'bg-gray-100 text-gray-600 border-gray-200';
  if (pct != null) {
    if (pct >= 0.66) cls = 'bg-emerald-50 text-emerald-700 border-emerald-200';
    else if (pct >= 0.33) cls = 'bg-amber-50 text-amber-700 border-amber-200';
    else cls = 'bg-red-50 text-red-700 border-red-200';
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {Number(score)}{max != null ? `/${Number(max)}` : ''}
    </span>
  );
}

// Pager — every list is paginated (candidate lists can be large).
export function Pager({ page, totalPages, total, onPage }) {
  if (!totalPages || totalPages <= 1) {
    return <div className="text-xs text-gray-400 mt-3">{total != null ? `${total} item${total === 1 ? '' : 's'}` : ''}</div>;
  }
  return (
    <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
      <span>{total != null ? `${total} item${total === 1 ? '' : 's'}` : ''}</span>
      <div className="flex items-center gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="px-2 py-1 border rounded-md disabled:opacity-40">Prev</button>
        <span>Page {page} of {totalPages}</span>
        <button type="button" disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="px-2 py-1 border rounded-md disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}

// Number input bound to a numeric state (keeps empty string usable).
export function NumberInput({ value, onChange, min, max, step = 1, className = '' }) {
  return (
    <input
      type="number" value={value ?? ''} min={min} max={max} step={step}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      className={`w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 ${className}`}
    />
  );
}

// ── Status pill — a clean coloured chip for ApplicationStatus / JobStatus ──────
const PILL_TONES = {
  APPLIED: 'bg-blue-50 text-blue-700 border-blue-200',
  SCREENING: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  ASSESSMENT: 'bg-violet-50 text-violet-700 border-violet-200',
  INTERVIEWING: 'bg-amber-50 text-amber-700 border-amber-200',
  OFFERED: 'bg-teal-50 text-teal-700 border-teal-200',
  HIRED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  REJECTED: 'bg-red-50 text-red-700 border-red-200',
  WITHDRAWN: 'bg-gray-100 text-gray-500 border-gray-200',
  ON_HOLD: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  // job statuses
  DRAFT: 'bg-gray-100 text-gray-600 border-gray-200',
  OPEN: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CLOSED: 'bg-gray-100 text-gray-500 border-gray-200',
  FILLED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CANCELLED: 'bg-red-50 text-red-600 border-red-200',
};
export function StatusPill({ status }) {
  if (!status) return null;
  const tone = PILL_TONES[status] || 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${tone}`}>
      {String(status).replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

// ── Copy-to-clipboard field — the shareable public link surface ───────────────
// Renders a read-only URL with a one-click Copy button (clipboard API with a
// select-text fallback) and an "Open ↗" affordance. Shows a transient "Copied!".
export function CopyField({ value, label, hint, openHref }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(value);
      else {
        const ta = document.createElement('textarea');
        ta.value = value; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
      }
      setCopied(true); setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the field is still selectable */ }
  }
  return (
    <div>
      {label && <FieldLabel hint={hint}>{label}</FieldLabel>}
      <div className="flex items-stretch gap-2">
        <input
          readOnly value={value || ''} onClick={(e) => e.target.select()}
          className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-700 focus:outline-none focus:ring-2 truncate"
        />
        <button
          type="button" onClick={copy}
          className="shrink-0 inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-white shadow-sm transition"
          style={{ background: copied ? '#059669' : 'var(--theme-primary)' }}
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
        {openHref && (
          <a
            href={openHref} target="_blank" rel="noreferrer"
            className="shrink-0 inline-flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Open ↗
          </a>
        )}
      </div>
    </div>
  );
}

// ── Accessible checkbox used by the bulk-select pipeline rows ─────────────────
export function Check({ checked, indeterminate, onChange, label, className = '' }) {
  return (
    <input
      type="checkbox"
      checked={!!checked}
      ref={(el) => { if (el) el.indeterminate = !!indeterminate && !checked; }}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
      className={`h-4 w-4 rounded border-gray-300 cursor-pointer ${className}`}
      style={{ accentColor: 'var(--theme-primary)' }}
    />
  );
}

// ── Stat card — a big number with a label, for the funnel summary header ───────
export function StatCard({ label, value, sub, tone = 'default', hint }) {
  const tones = {
    default: 'text-gray-900', good: 'text-emerald-600', warn: 'text-amber-600', bad: 'text-red-600',
    accent: '', // uses theme primary
  };
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">{label}{hint && <Info text={hint} />}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tones[tone] || tones.default}`} style={tone === 'accent' ? { color: 'var(--theme-primary)' } : undefined}>
        {value}
      </div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Funnel chart — horizontal bars (applied → … → accepted), width ∝ count ─────
// `steps` = [{ key, label, count }]; bars scale to the first (largest) step.
export function FunnelChart({ steps }) {
  const top = Math.max(1, ...(steps || []).map((s) => s.count || 0));
  const palette = ['#6366f1', '#4f46e5', '#7c3aed', '#d97706', '#0d9488', '#059669'];
  return (
    <div className="space-y-2">
      {(steps || []).map((s, i) => {
        const pct = Math.round(((s.count || 0) / top) * 100);
        const conv = i > 0 && steps[i - 1].count ? Math.round((s.count / steps[i - 1].count) * 100) : null;
        return (
          <div key={s.key} className="flex items-center gap-3">
            <div className="w-24 shrink-0 text-right text-xs font-medium text-gray-600">{s.label}</div>
            <div className="flex-1 h-8 rounded-lg bg-gray-100 overflow-hidden relative">
              <div
                className="h-full rounded-lg flex items-center justify-end pr-2 transition-all"
                style={{ width: `${Math.max(pct, s.count ? 8 : 0)}%`, background: palette[i % palette.length] }}
              >
                {s.count > 0 && <span className="text-xs font-semibold text-white tabular-nums">{s.count}</span>}
              </div>
              {s.count === 0 && <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">0</span>}
            </div>
            <div className="w-14 shrink-0 text-[11px] text-gray-400 tabular-nums">{conv != null ? `${conv}%` : ''}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── Candidate-message channel chips (Feature 36) ──────────────────────────────
// Shows which channels a candidate-message template attempts (email/WhatsApp/SMS).
// The router decides actual delivery per country/budget/STOP-list; these are the
// channels the template is enabled for, not a per-send override.
const CAND_CHANNEL_META = [
  ['email', 'Email', 'bg-sky-50 text-sky-700 border-sky-200'],
  ['whatsapp', 'WhatsApp', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
  ['sms', 'SMS', 'bg-violet-50 text-violet-700 border-violet-200'],
];
export function ChannelChips({ channels }) {
  const active = CAND_CHANNEL_META.filter(([k]) => channels?.[k]);
  if (!active.length) return <span className="text-xs text-gray-400">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {active.map(([k, label, cls]) => (
        <span key={k} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>
      ))}
    </span>
  );
}

// ── Merge-field preview (Feature 36) ──────────────────────────────────────────
// Render a template body with {TOKEN} placeholders filled from `sampleVars`.
// A token with a provided value shows the value; anything else shows [TOKEN] so
// the operator can see exactly what the candidate will receive (the real merge +
// per-candidate LINK are produced server-side at send time).
const MERGE_TOKEN_RE = /\{([A-Za-z0-9_]+)\}/g;
export function renderMergePreview(body, sampleVars = {}) {
  return String(body || '').replace(MERGE_TOKEN_RE, (m, t) => (
    sampleVars[t] != null && sampleVars[t] !== '' ? String(sampleVars[t]) : `[${t}]`
  ));
}

// 1–10 skill slider used on the interviewer scoring screen.
export function SkillSlider({ skill, value, comment, onScore, onComment }) {
  const min = skill.scaleMin ?? 1;
  const max = skill.scaleMax ?? 10;
  return (
    <div className="rounded-xl border border-gray-200 p-4 bg-white">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-medium text-gray-900">{skill.name}{skill.weight != null && Number(skill.weight) !== 1 ? <span className="ml-2 text-xs text-gray-400">weight ×{Number(skill.weight)}</span> : null}</div>
          {skill.description && <div className="text-xs text-gray-500">{skill.description}</div>}
        </div>
        <div className="text-lg font-semibold tabular-nums" style={{ color: 'var(--theme-primary)' }}>{value ?? min}<span className="text-xs text-gray-400">/{max}</span></div>
      </div>
      <input type="range" min={min} max={max} step={1} value={value ?? min} onChange={(e) => onScore(Number(e.target.value))} className="w-full accent-current" style={{ accentColor: 'var(--theme-primary)' }} />
      <input
        type="text" value={comment ?? ''} placeholder="Optional note for this skill"
        onChange={(e) => onComment(e.target.value)}
        className="w-full mt-2 rounded-lg border border-gray-200 px-3 py-1.5 text-xs focus:outline-none focus:ring-2"
      />
    </div>
  );
}
