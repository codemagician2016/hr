'use client';

// ModuleGuide — a dismissible, on-brand "how this works" panel rendered directly
// under a module page's title. It gives a first-time admin everything needed to
// USE the module without leaving the page: a one-line what-it-is, the ordered
// steps, a worked example, and a few practical tips. Collapsed state is
// remembered per `id` in localStorage, so power users can hide it for good.
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
  const [open, setOpen] = useState(true);
  const [ready, setReady] = useState(false);

  // Read the remembered state on mount. We render nothing until then so the
  // panel doesn't flash open before we know the user collapsed it.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(storageKey) === 'closed') setOpen(false);
    } catch {
      /* private mode / SSR — default open */
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
    <div className="mb-6 rounded-2xl border bg-white overflow-hidden" style={{ borderColor: 'var(--theme-border)' }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ backgroundColor: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}
          >
            i
          </span>
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--theme-text)' }}>{title}</span>
        </span>
        <span className="text-xs font-medium shrink-0" style={{ color: 'var(--theme-muted)' }}>{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 text-sm" style={{ color: 'var(--theme-text)' }}>
          {what && <p className="leading-relaxed" style={{ color: 'var(--theme-muted)' }}>{what}</p>}

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
      )}
    </div>
  );
}
