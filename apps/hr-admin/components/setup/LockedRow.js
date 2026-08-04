'use client';

// Steps the tenant's plan doesn't include. These inform, they never nag: the
// server has already removed them from BOTH sides of the percentage, so 100% is
// reachable on any plan and a locked row can never sit between an operator and
// a finished setup. We say what the feature does and where to see the plan —
// nothing more.
//
// One locked step renders inline; two or more collapse behind a single
// "Not on your plan (3)" disclosure so a small plan doesn't turn every stage
// into an advert.

import { useId, useState } from 'react';
import Link from 'next/link';

function LockGlyph() {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center text-sm text-gray-600" aria-hidden>
      🔒
    </span>
  );
}

function Body({ step }) {
  const reason = step.lockedReason || {};
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-gray-700">{step.label}</span>
        {reason.route && (
          <Link
            href={reason.route}
            className="shrink-0 whitespace-nowrap text-xs font-semibold text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-900"
          >
            See what’s included <span aria-hidden>→</span>
          </Link>
        )}
      </div>
      <p className="mt-0.5 text-sm leading-relaxed text-gray-600">{step.description}</p>
      <p className="mt-1 text-[11px] font-semibold text-gray-600">
        {reason.message || (reason.planLabel ? `Included in ${reason.planLabel}.` : 'Not on your plan.')}
        {' '}Doesn’t count towards 100%.
      </p>
    </div>
  );
}

export default function LockedRow({ steps }) {
  const list = Array.isArray(steps) ? steps : [steps].filter(Boolean);
  const [open, setOpen] = useState(false);
  const panelId = useId();

  if (list.length === 0) return null;

  if (list.length === 1) {
    return (
      <li className="scroll-mt-28 border-b border-gray-100 py-3.5 last:border-0">
        <div className="flex gap-3">
          <span className="mt-0.5 shrink-0"><LockGlyph /></span>
          <Body step={list[0]} />
        </div>
      </li>
    );
  }

  return (
    <li className="border-b border-gray-100 py-2 last:border-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-sm py-1.5 text-left"
      >
        <LockGlyph />
        <span className="text-sm font-medium text-gray-700">
          Not on your plan ({list.length})
        </span>
        <span aria-hidden className="ml-auto text-xs text-gray-600">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>
      <ul id={panelId} className="mt-1 space-y-3 pl-8" hidden={!open}>
        {list.map((s) => (
          <li key={s.key} className="flex gap-3">
            <Body step={s} />
          </li>
        ))}
      </ul>
    </li>
  );
}
