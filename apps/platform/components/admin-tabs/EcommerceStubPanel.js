'use client';

// Shared scaffold for the 17 new ECOMMERCE admin panels introduced when the
// vertical jumped from "Phase 1 starter" to "full grocery operations console"
// (Path B, 2026-05-01). Each panel renders a header, optional KPI strip, and
// a roadmap section so the admin sees what's coming, while the real
// implementation is ported from `Grocery E-Commerce/<slug>.html` over time.
//
// New panels should pass:
//   - title, subtitle      (page header)
//   - kpis: [{ label, value, hint }]   optional
//   - sections: [{ title, items }]     optional roadmap groups
//   - prototypeFile        e.g. 'inventory.html' so user can preview design
//
// When a panel is implemented for real, replace the wrapper with the real
// React tree and delete the stub usage.

import Link from 'next/link';

export default function EcommerceStubPanel({
  title,
  subtitle,
  kpis = [],
  sections = [],
  prototypeFile,
  primaryAction,
}) {
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
            {subtitle && (
              <p className="text-sm text-gray-500 mt-1">{subtitle}</p>
            )}
          </div>
          <div className="flex gap-2">
            {prototypeFile && (
              <a
                href={`/Grocery E-Commerce/${prototypeFile}`}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-sm font-medium text-gray-700 hover:border-gray-400"
              >
                Preview prototype <span aria-hidden>↗</span>
              </a>
            )}
            {primaryAction}
          </div>
        </div>

        <div className="mt-4 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-[11px] font-mono tracking-wider text-amber-800">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          IN BUILD · ECOMMERCE PATH B
        </div>
      </div>

      {kpis.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {kpis.map((k) => (
            <div key={k.label} className="bg-white rounded-2xl border border-gray-200 p-5">
              <p className="text-[11px] font-mono tracking-[0.18em] uppercase text-gray-500">{k.label}</p>
              <p className="mt-2 text-2xl font-bold text-gray-900">{k.value}</p>
              {k.hint && <p className="text-xs text-gray-500 mt-1">{k.hint}</p>}
            </div>
          ))}
        </div>
      )}

      {sections.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {sections.map((s) => (
            <div key={s.title} className="bg-white rounded-2xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900">{s.title}</h3>
              <ul className="mt-3 space-y-2">
                {s.items.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-gray-600">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-gray-300 flex-shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
