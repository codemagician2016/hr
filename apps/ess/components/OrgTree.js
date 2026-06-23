'use client';

// OrgTree — the "Organization Relationship" view (Feature 13 §6.3). A clean
// Photo | Name | Position card tree with expand/collapse and drill-down (re-root).
// Pure presentational: it receives the node forest from the API (each node carries
// { id, code, name, photoUrl, designation, departmentName, reportsCount, children }).
// Virtualized-friendly: children render lazily (only expanded branches mount), so a
// 100+ employee org stays responsive.

import { useState } from 'react';

function initials(name) {
  const p = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

function NodeCard({ node, depth, onDrill, defaultOpen }) {
  const [open, setOpen] = useState(depth < 1 || !!defaultOpen);
  const hasKids = node.children && node.children.length > 0;
  return (
    <li className="relative">
      <div className="flex items-center gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        {hasKids ? (
          <button onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}
                  className="flex h-6 w-6 items-center justify-center rounded text-xs" style={{ color: 'var(--theme-muted)' }}>
            {open ? '▾' : '▸'}
          </button>
        ) : <span className="inline-block h-6 w-6" />}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold"
             style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}>
          {node.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={node.photoUrl} alt="" className="h-full w-full object-cover" />
          ) : initials(node.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{node.name}</div>
          <div className="truncate text-xs" style={{ color: 'var(--theme-muted)' }}>
            {node.designation || '—'}{node.departmentName ? ` · ${node.departmentName}` : ''}
          </div>
        </div>
        {node.reportsCount > 0 && (
          <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}>
            {node.reportsCount} {node.reportsCount === 1 ? 'report' : 'reports'}
          </span>
        )}
        {onDrill && hasKids && (
          <button onClick={() => onDrill(node)} className="text-xs underline" style={{ color: 'var(--theme-primary)' }} title="Focus on this person's team">Focus</button>
        )}
      </div>
      {hasKids && open && (
        <ul className="ml-6 mt-2 space-y-2 border-l pl-4" style={{ borderColor: 'var(--theme-border)' }}>
          {node.children.map((c) => <NodeCard key={c.id} node={c} depth={depth + 1} onDrill={onDrill} />)}
        </ul>
      )}
    </li>
  );
}

export default function OrgTree({ nodes, onDrill, breadcrumb, onUp }) {
  if (!nodes || nodes.length === 0) {
    return <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>No reporting relationships to show.</p>;
  }
  return (
    <div className="space-y-3">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="Org breadcrumb" style={{ color: 'var(--theme-muted)' }}>
          {breadcrumb.map((b, i) => (
            <span key={b.id} className="flex items-center gap-1">
              <button onClick={() => onUp && onUp(i)} className="underline" style={{ color: 'var(--theme-primary)' }}>{b.name}</button>
              <span aria-hidden>›</span>
            </span>
          ))}
        </nav>
      )}
      <ul className="space-y-2">
        {nodes.map((n) => <NodeCard key={n.id} node={n} depth={0} onDrill={onDrill} defaultOpen />)}
      </ul>
    </div>
  );
}
