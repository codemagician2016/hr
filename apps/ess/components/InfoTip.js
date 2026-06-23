'use client';

// InfoTip — a small accessible "ⓘ" hint shown next to a form field label. Mirrors the
// hr-admin widgets InfoTip so the ESS forms get the same plain-language tooltips the
// owner asked for ("ⓘ tooltips on every field"). Click/hover/focus reveals the bubble.

import { useId, useState } from 'react';

export default function InfoTip({ text, label = 'More info' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!text) return null;
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold text-gray-500 hover:bg-gray-50"
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-1/2 top-6 z-30 w-60 -translate-x-1/2 rounded-lg border bg-white px-3 py-2 text-xs font-normal text-gray-600 shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}

// A label row with an optional tip.
export function FieldLabel({ children, tip }) {
  return (
    <span className="mb-1 flex items-center font-medium">
      {children}
      {tip ? <InfoTip text={tip} /> : null}
    </span>
  );
}
