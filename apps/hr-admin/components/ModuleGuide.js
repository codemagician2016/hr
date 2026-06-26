'use client';

// ModuleGuide — a COLLAPSED-by-default, on-brand "how this works" bar rendered
// directly under a module page's title. Collapsed it is a single slim row, so
// the page's own content (forms, tables) stays above the fold — open it only
// when you want the walkthrough. Expanded, it lays out in two columns (steps |
// example + tips) so it stays short. Open/closed is remembered per `id`.
//
// Contract (kept deliberately small so every page uses it the same way):
//   <ModuleGuide
//     id="org"                                   // unique, stable key (route-ish)
//     title="Setting up your org structure"      // optional; defaults to "How this works"
//     what="Legal entities, departments…"        // one or two sentences
//     steps={["Add a legal entity", "…"]}        // ordered string[] (JSX allowed)
//     example={<>For <b>Acme India Pvt Ltd</b>…</>} // a concrete worked example
//     tips={["You can edit any of this later"]}   // string[] (JSX allowed)
//   />

import { useEffect, useState } from 'react';

export default function ModuleGuide({ id, title = 'How this works', what, steps = [], example, tips = [] }) {
  const storageKey = `drifthr.guide.${id || 'module'}`;
  // Collapsed by default — the page content comes first. We only auto-expand if
  // the user explicitly opened this guide before.
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(storageKey) === 'open') setOpen(true);
    } catch {
      /* private mode / SSR — stay collapsed */
    }
    setReady(true);
  }, [storageKey]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      try { window.localStorage.setItem(storageKey, next ? 'open' : 'closed'); } catch { /* ignore */ }
      return next;
    });
  }

  if (!ready) return null;

  return (
    <div className="mb-5 rounded-2xl border bg-white overflow-hidden" style={{ borderColor: 'var(--theme-border)' }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-gray-50"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
            style={{ backgroundColor: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}
          >
            i
          </span>
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--theme-text)' }}>{title}</span>
          {!open && (
            <span className="text-xs truncate hidden sm:inline" style={{ color: 'var(--theme-muted)' }}>
              — steps, an example &amp; tips
            </span>
          )}
        </span>
        <span className="flex items-center gap-1 text-xs font-medium shrink-0" style={{ color: 'var(--theme-primary)' }}>
          {open ? 'Hide' : 'Show guide'}
          <span aria-hidden style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>▾</span>
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 text-sm" style={{ color: 'var(--theme-text)' }}>
          {what && <p className="leading-relaxed mb-3" style={{ color: 'var(--theme-muted)' }}>{what}</p>}

          {/* Two columns on wider screens (steps | example + tips) to keep the
              panel short so it doesn't push page content down. */}
          <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
            {steps.length > 0 && (
              <ol className="space-y-2">
                {steps.map((s, i) => (
                  <li key={i} className="flex gap-3">
                    <span
                      className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ backgroundColor: 'var(--theme-primary)' }}
                    >
                      {i + 1}
                    </span>
                    <span className="leading-relaxed">{s}</span>
                  </li>
                ))}
              </ol>
            )}

            <div className="space-y-3">
              {example && (
                <div className="rounded-xl px-4 py-3" style={{ backgroundColor: 'var(--theme-primary-soft)' }}>
                  <p className="mb-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--theme-primary)' }}>Example</p>
                  <div className="leading-relaxed" style={{ color: 'var(--theme-text)' }}>{example}</div>
                </div>
              )}
              {tips.length > 0 && (
                <ul className="space-y-1.5">
                  {tips.map((t, i) => (
                    <li key={i} className="flex gap-2 leading-relaxed" style={{ color: 'var(--theme-muted)' }}>
                      <span style={{ color: 'var(--theme-primary)' }}>•</span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
