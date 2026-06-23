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
