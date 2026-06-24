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

// ── Feature 34 — 9-box + competency UI primitives ─────────────────────────────
// All pure presentation; the board drag uses native HTML5 DnD (no new dependency).

// The classic 9-box labels (performance →, potential ↑). Mirrors backend nineBox.js.
export const BOX_LABELS = {
  1: 'Risk', 2: 'Inconsistent Player', 3: 'Workhorse',
  4: 'Average Performer', 5: 'Core Player', 6: 'High Performer',
  7: 'Diamond in the Rough', 8: 'High Potential', 9: 'Star',
};

// <NineBoxGrid cells onDropChip renderChip target /> — a 3×3 CSS grid. X = Performance
// (Low→High), Y = Potential (Low→High). `cells` is {1..9: [chip]}. `onDropChip(box)`
// fires on a native drop; `renderChip(chip)` renders each draggable chip. `target` is
// an optional {box: count} concentration map driving a heat tint when over target.
export function NineBoxGrid({ cells = {}, onDropChip, renderChip, warningByBox = {} }) {
  // Render top row (potential 3) first so the grid reads high-potential at the top.
  const rows = [
    [7, 8, 9], // potential 3 (High)
    [4, 5, 6], // potential 2 (Med)
    [1, 2, 3], // potential 1 (Low)
  ];
  return (
    <div className="overflow-x-auto">
      <div className="flex">
        <div className="flex flex-col justify-between pr-2 py-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wide" style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
          <span>Potential →</span>
        </div>
        <div className="grid grid-cols-3 gap-2 flex-1 min-w-[480px]">
          {rows.flat().map((box) => {
            const chips = cells[box] || [];
            const over = warningByBox[box];
            return (
              <div
                key={box}
                onDragOver={(e) => { if (onDropChip) e.preventDefault(); }}
                onDrop={(e) => { if (onDropChip) { e.preventDefault(); onDropChip(box, e); } }}
                className={`rounded-xl border p-2 min-h-[96px] ${over ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-semibold text-gray-500">{box} · {BOX_LABELS[box]}</span>
                  <span className={`text-[11px] font-medium ${over ? 'text-amber-700' : 'text-gray-400'}`}>{chips.length}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {chips.map((c) => (renderChip ? renderChip(c) : null))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="text-center text-[10px] font-semibold text-gray-400 uppercase tracking-wide mt-1 ml-6">Performance →</div>
    </div>
  );
}

// <GapBar expected actual max /> — expected-vs-actual proficiency bar. The grey track
// is the scale; the filled bar is the actual; a notch marks the expected bar.
export function GapBar({ expected, actual, max = 5 }) {
  const a = actual == null ? null : Math.max(0, Math.min(max, Number(actual)));
  const e = expected == null ? null : Math.max(0, Math.min(max, Number(expected)));
  const pct = (v) => `${(v / max) * 100}%`;
  const below = a != null && e != null && a < e;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2.5 flex-1 rounded-full bg-gray-100 overflow-hidden">
        {a != null && (
          <div className={`absolute inset-y-0 left-0 rounded-full ${below ? 'bg-rose-400' : 'bg-emerald-400'}`} style={{ width: pct(a) }} />
        )}
        {e != null && (
          <div className="absolute inset-y-0 w-0.5 bg-gray-700" style={{ left: pct(e) }} title={`Expected ${e}`} />
        )}
      </div>
      <span className="text-xs text-gray-500 tabular-nums w-16 text-right">
        {a == null ? '—' : a} / {e == null ? '—' : e}
      </span>
    </div>
  );
}

// <ReadinessBadge value /> — successor readiness chip.
export function ReadinessBadge({ value }) {
  if (!value) return null;
  const map = {
    READY_NOW: ['Ready now', 'bg-emerald-50 text-emerald-700'],
    READY_1_2_YR: ['1–2 yr', 'bg-amber-50 text-amber-700'],
    READY_3_PLUS_YR: ['3+ yr', 'bg-gray-100 text-gray-600'],
  };
  const [label, cls] = map[value] || [value, 'bg-gray-100 text-gray-600'];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>;
}

// <TalentTagChip kind note /> — a talent-pool tag pill (HIPO / FLIGHT_RISK / …).
export function TalentTagChip({ kind, onRemove }) {
  const map = {
    HIPO: ['HIPO', 'bg-indigo-50 text-indigo-700'],
    FLIGHT_RISK: ['Flight risk', 'bg-rose-50 text-rose-700'],
    PROMOTION_READY: ['Promotion-ready', 'bg-emerald-50 text-emerald-700'],
    SUCCESSOR: ['Successor', 'bg-sky-50 text-sky-700'],
    KEY_PERSON: ['Key person', 'bg-amber-50 text-amber-700'],
  };
  const [label, cls] = map[kind] || [kind, 'bg-gray-100 text-gray-600'];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
      {onRemove && <button type="button" onClick={onRemove} className="ml-0.5 text-current opacity-60 hover:opacity-100" aria-label={`Remove ${label}`}>×</button>}
    </span>
  );
}
