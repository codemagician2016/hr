// Shared Performance (Feature 8) UI primitives — used identically across hr-admin,
// ess, and any manager surface so "4 — Exceeds" renders the same everywhere. Pure
// presentation; driven by the cycle's ratingScaleJson / objective rollup data.
'use client';

// <RatingScale value editable scale onChange /> — a labelled segmented control
// driven by ratingScaleJson points ([{value,label}]). Read-only chip mode when
// !editable (renders just the selected point as a pill).
export function RatingScale({ value, editable = false, scale, onChange }) {
  const points = Array.isArray(scale)
    ? scale
    : (scale && Array.isArray(scale.points) ? scale.points : []);
  if (!editable) {
    const sel = points.find((p) => String(p.value) === String(value));
    if (value == null) return <span className="text-sm text-gray-400">—</span>;
    return (
      <span className="inline-flex items-center rounded-full bg-indigo-50 text-indigo-700 px-2.5 py-0.5 text-xs font-medium">
        {sel ? `${sel.value} — ${sel.label || ''}`.trim() : value}
      </span>
    );
  }
  return (
    <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden" role="radiogroup">
      {points.map((p) => {
        const active = String(p.value) === String(value);
        return (
          <button
            key={p.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange && onChange(p.value)}
            className={`px-3 py-1.5 text-xs font-medium border-r last:border-r-0 border-gray-200 ${active ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
            title={p.anchor || p.label || ''}
          >
            {p.value}{p.label ? ` · ${p.label}` : ''}
          </button>
        );
      })}
    </div>
  );
}

// <GoalCard goal /> — progress ring + status pill + due date. `goal` carries
// {title, progress (0-100), status, dueDate}.
export function GoalCard({ goal, onClick }) {
  if (!goal) return null;
  const progress = Math.max(0, Math.min(100, Number(goal.progress) || 0));
  const r = 18;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - progress / 100);
  const due = goal.dueDate ? new Date(goal.dueDate) : null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-3 shadow-sm hover:shadow"
    >
      <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden>
        <circle cx="24" cy="24" r={r} fill="none" stroke="#eee" strokeWidth="5" />
        <circle
          cx="24" cy="24" r={r} fill="none"
          stroke="var(--theme-primary, #4f46e5)" strokeWidth="5" strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={offset} transform="rotate(-90 24 24)"
        />
        <text x="24" y="28" textAnchor="middle" fontSize="11" fill="#374151">{Math.round(progress)}%</text>
      </svg>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-gray-900">{goal.title}</div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5">{goal.status || 'DRAFT'}</span>
          {due ? <span>Due {due.toLocaleDateString()}</span> : null}
        </div>
      </div>
    </button>
  );
}
