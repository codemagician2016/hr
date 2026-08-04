'use client';

// Zone 4: the quiet footer. Two things live here and nothing else — the steps
// this tenant said they don't need (always restorable, never silently deleted)
// and one honest explanation of why the denominator is what it is.
//
// No card, no border, no colour. Anything with a box around it reads as work.

import { useId, useState } from 'react';

export default function HiddenSteps({ steps, onRestore }) {
  const list = Array.isArray(steps) ? steps : [];
  const [openPanel, setOpenPanel] = useState(null); // 'hidden' | 'score' | null
  const hiddenId = useId();
  const scoreId = useId();

  const toggle = (panel) => setOpenPanel((current) => (current === panel ? null : panel));

  return (
    <footer className="mt-12 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-gray-600">
        {list.length > 0 && (
          <button
            type="button"
            aria-expanded={openPanel === 'hidden'}
            aria-controls={hiddenId}
            onClick={() => toggle('hidden')}
            className="font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-900"
          >
            Hidden steps ({list.length})
          </button>
        )}
        <button
          type="button"
          aria-expanded={openPanel === 'score'}
          aria-controls={scoreId}
          onClick={() => toggle('score')}
          className="font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-900"
        >
          How this score works
        </button>
      </div>

      <ul id={hiddenId} hidden={openPanel !== 'hidden'} className="mt-3 space-y-2">
        {list.map((s) => (
          <li key={s.key} className="flex items-start justify-between gap-3">
            <span className="min-w-0">
              <span className="block text-gray-700">{s.label}</span>
              <span className="block text-xs text-gray-600">{s.description}</span>
            </span>
            <button
              type="button"
              onClick={() => onRestore(s.key)}
              className="shrink-0 font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 hover:text-gray-900"
            >
              Bring it back
            </button>
          </li>
        ))}
      </ul>

      <div id={scoreId} hidden={openPanel !== 'score'} className="mt-3 max-w-2xl space-y-2 text-gray-600">
        <p>
          Your percentage counts only the steps that apply to you. Anything that isn’t on your plan,
          anything for another country, and anything you’ve hidden is left out of both sides of the
          sum — so 100% is always reachable.
        </p>
        <p>
          Steps that need a permission you don’t have are left out of your number too, which is why
          a colleague may see a different percentage for the same company.
        </p>
        <p>
          Nothing here blocks anything. You can run payroll, approve leave and issue letters with the
          list half finished — this page only tells you what’s still worth doing.
        </p>
      </div>
    </footer>
  );
}
