'use client';

/**
 * OrgTree — Feature 19 controlled, lazy, virtualized org-chart tree.
 *
 * Redesigned from the F13 "render a fully-nested forest" component into a LAZY
 * controlled tree that scales to 1000+ / 10+ levels because the client never holds
 * more than the visible + expanded nodes:
 *   - First paint shows only the roots (or the self-node) — nothing below is fetched.
 *   - Expanding a node lazily loads ONLY that node's direct reports (paginated:
 *     "Show N more reports" for wide sibling sets — a 200-report manager shows 50 +
 *     a load-more, never 200 cards).
 *   - The visible rows are VIRTUALIZED (a windowed slice of the flattened
 *     visible-node list mounts), so the DOM stays at hundreds of nodes regardless of
 *     tenant size.
 *   - A breadcrumb shows the path-to-top; search-to-locate expands exactly a hit's
 *     ancestor path (never the whole tree).
 *
 * It is DATA-AGNOSTIC: the parent injects scoped API callbacks
 *   loadRoots()                  -> { nodes, nextCursor }
 *   loadChildren(id, cursor)     -> { nodes, nextCursor }
 *   loadAncestors(id)            -> { path }     // root → … → node
 * so hr-admin (operator) and ESS (customer) share ONE component with their own
 * scoped clients. `nodes` may carry `expandable` (ESS policy) — when present and
 * false, the chevron is disabled (card-only). `isSelf` badges the viewer's node.
 *
 * The presentational card (photo | name | designation · department | reports pill |
 * Focus) is preserved from the F13 design.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ROW_HEIGHT = 64;      // px per node row (card + gap) — virtualization unit
const OVERSCAN = 8;         // rows rendered above/below the viewport
const VIEWPORT_MAX = 640;   // px — the scroll window height

function initials(name) {
  const p = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

// A node is "expandable" if it has reports AND policy permits drilling. ESS passes
// node.expandable=false for card-only (lateral/ancestor) nodes; admin omits it.
function canExpand(node) {
  if (node.expandable === false) return false;
  return (node.reportsCount || 0) > 0;
}

const INACTIVE = new Set(['TERMINATED', 'PRE_HIRE', 'RETIRED', 'SUSPENDED']);

export default function OrgTree({
  loadRoots,
  loadChildren,
  searchResults,        // [{ node, ancestorIds }] | null — provided by the page's search box
  onFocus,              // (node) => void — re-root the viewport (admin) / focus (ess)
  breadcrumb,           // [{ id, name, expandable }] root → … → focused (path-to-top)
  onBreadcrumb,         // (node, index) => void — re-root upward
  emptyText = 'No reporting relationships to show.',
  showStatus = false,   // admin dims inactive; ESS hides them server-side
}) {
  // childrenById: Map<id, { nodes, nextCursor, loading }> — a node's loaded pages.
  const [childrenById, setChildrenById] = useState(() => new Map());
  const [roots, setRoots] = useState(null); // { nodes, nextCursor } | null
  const [expanded, setExpanded] = useState(() => new Set());
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [error, setError] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(VIEWPORT_MAX);
  const scrollRef = useRef(null);

  // ── load roots on mount / when loadRoots identity changes (re-root) ──────────
  useEffect(() => {
    let alive = true;
    setLoadingRoots(true);
    setError('');
    setChildrenById(new Map());
    setExpanded(new Set());
    Promise.resolve(loadRoots())
      .then((res) => { if (alive) setRoots({ nodes: res.nodes || [], nextCursor: res.nextCursor || null }); })
      .catch((e) => { if (alive) setError(e?.message || 'Failed to load the org chart.'); })
      .finally(() => { if (alive) setLoadingRoots(false); });
    return () => { alive = false; };
  }, [loadRoots]);

  // ── lazy child loading ───────────────────────────────────────────────────────
  const fetchChildren = useCallback(async (id, cursor) => {
    setChildrenById((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) || { nodes: [], nextCursor: null };
      next.set(id, { ...cur, loading: true });
      return next;
    });
    try {
      const res = await loadChildren(id, cursor);
      setChildrenById((prev) => {
        const next = new Map(prev);
        const cur = next.get(id) || { nodes: [], nextCursor: null };
        const merged = cursor ? [...cur.nodes, ...(res.nodes || [])] : (res.nodes || []);
        next.set(id, { nodes: merged, nextCursor: res.nextCursor || null, loading: false });
        return next;
      });
    } catch (e) {
      setChildrenById((prev) => {
        const next = new Map(prev);
        const cur = next.get(id) || { nodes: [], nextCursor: null };
        next.set(id, { ...cur, loading: false, error: e?.message || 'Failed to load reports.' });
        return next;
      });
    }
  }, [loadChildren]);

  const toggle = useCallback(async (node) => {
    const id = node.id;
    const isOpen = expanded.has(id);
    if (isOpen) {
      setExpanded((prev) => { const n = new Set(prev); n.delete(id); return n; });
      return;
    }
    setExpanded((prev) => { const n = new Set(prev); n.add(id); return n; });
    if (!childrenById.has(id)) await fetchChildren(id, null);
  }, [expanded, childrenById, fetchChildren]);

  // ── search-to-locate: expand exactly a hit's ancestor path ───────────────────
  const expandPath = useCallback(async (ancestorIds, targetId) => {
    // Expand each ancestor top-down, loading children pages along the way until the
    // target appears — never the whole tree.
    const path = [...(ancestorIds || [])];
    setExpanded((prev) => { const n = new Set(prev); path.forEach((a) => n.add(a)); n.add(targetId); return n; });
    for (const aid of path) {
      // Ensure that ancestor's children are loaded (so the next segment renders).
      // eslint-disable-next-line no-await-in-loop
      if (!childrenById.has(aid)) await fetchChildren(aid, null);
    }
  }, [childrenById, fetchChildren]);

  // ── flatten the visible tree into a windowable row list ──────────────────────
  // A node is "visible" only if all its ancestors are expanded. We walk roots →
  // expanded children, producing { node, depth, parentId, kind } rows. "load-more"
  // rows for paginated sibling groups are flattened too (kind:'more').
  const rows = useMemo(() => {
    const out = [];
    if (!roots) return out;
    const walk = (nodes, depth, parentKey) => {
      for (const node of nodes) {
        out.push({ kind: 'node', node, depth, key: node.id });
        if (expanded.has(node.id)) {
          const page = childrenById.get(node.id);
          if (page) {
            if (page.loading && page.nodes.length === 0) {
              out.push({ kind: 'loading', depth: depth + 1, key: `${node.id}:loading` });
            } else {
              walk(page.nodes, depth + 1, node.id);
              if (page.nextCursor) {
                out.push({ kind: 'more', parentId: node.id, cursor: page.nextCursor, depth: depth + 1, loading: page.loading, key: `${node.id}:more` });
              }
              if (page.error) out.push({ kind: 'error', text: page.error, depth: depth + 1, key: `${node.id}:err` });
            }
          }
        }
      }
    };
    walk(roots.nodes, 0, null);
    if (roots.nextCursor) out.push({ kind: 'more-roots', cursor: roots.nextCursor, depth: 0, key: 'roots:more' });
    return out;
  }, [roots, expanded, childrenById]);

  // ── virtualization window ────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => setScrollTop(el.scrollTop);
    const measure = () => setViewportH(Math.min(el.clientHeight || VIEWPORT_MAX, VIEWPORT_MAX));
    el.addEventListener('scroll', onScroll, { passive: true });
    measure();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const total = rows.length;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportH / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(total, startIdx + visibleCount);
  const windowRows = rows.slice(startIdx, endIdx);
  const padTop = startIdx * ROW_HEIGHT;
  const padBottom = (total - endIdx) * ROW_HEIGHT;

  const loadMoreRoots = useCallback(async (cursor) => {
    try {
      const res = await loadRoots(cursor);
      setRoots((prev) => ({ nodes: [...(prev?.nodes || []), ...(res.nodes || [])], nextCursor: res.nextCursor || null }));
    } catch (e) { setError(e?.message || 'Failed to load more.'); }
  }, [loadRoots]);

  // Search-result clicks expand a hit's exact ancestor path (see the results strip).
  const matchIds = useMemo(() => new Set((searchResults || []).map((r) => r.node.id)), [searchResults]);

  if (loadingRoots) {
    return <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>Loading the org chart…</p>;
  }
  if (error) {
    return <p className="text-sm" style={{ color: '#dc2626' }}>{error}</p>;
  }
  if (!roots || roots.nodes.length === 0) {
    return <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>{emptyText}</p>;
  }

  return (
    <div className="space-y-3">
      {/* Breadcrumb path-to-top */}
      {breadcrumb && breadcrumb.length > 0 && (
        <nav className="flex flex-wrap items-center gap-1 text-xs" aria-label="Path to the top of the org" style={{ color: 'var(--theme-muted)' }}>
          {breadcrumb.map((b, i) => (
            <span key={b.id} className="flex items-center gap-1">
              <button type="button" onClick={() => onBreadcrumb && onBreadcrumb(b, i)} className="underline" style={{ color: 'var(--theme-primary)' }}>{b.name}</button>
              {i < breadcrumb.length - 1 && <span aria-hidden>›</span>}
            </span>
          ))}
        </nav>
      )}

      {/* Search results strip — clicking a hit expands its exact path */}
      {searchResults && searchResults.length > 0 && (
        <div className="rounded-xl border bg-white p-2 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
          <div className="mb-1 px-1 text-[11px] font-medium" style={{ color: 'var(--theme-muted)' }}>
            {searchResults.length} {searchResults.length === 1 ? 'match' : 'matches'} — pick one to reveal it
          </div>
          <ul className="max-h-48 space-y-1 overflow-auto">
            {searchResults.map((r) => (
              <li key={r.node.id}>
                <button
                  type="button"
                  onClick={() => expandPath(r.ancestorIds, r.node.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-gray-50"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full text-[10px] font-bold"
                        style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}>
                    {r.node.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.node.photoUrl} alt="" className="h-full w-full object-cover" />
                    ) : initials(r.node.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" style={{ color: 'var(--theme-text)' }}>{r.node.name}</span>
                    <span className="block truncate text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {r.node.designation || r.node.code}{r.node.departmentName ? ` · ${r.node.departmentName}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Virtualized scroll window */}
      <div ref={scrollRef} className="overflow-auto rounded-xl border" style={{ maxHeight: VIEWPORT_MAX, borderColor: 'var(--theme-border)' }}>
        <div style={{ height: padTop }} aria-hidden />
        <ul role="tree">
          {windowRows.map((row) => {
            if (row.kind === 'loading') {
              return <li key={row.key} style={{ height: ROW_HEIGHT, paddingLeft: 16 + row.depth * 20 }} className="flex items-center text-xs" >
                <span style={{ color: 'var(--theme-muted)' }}>Loading reports…</span>
              </li>;
            }
            if (row.kind === 'error') {
              return <li key={row.key} style={{ height: ROW_HEIGHT, paddingLeft: 16 + row.depth * 20 }} className="flex items-center text-xs" >
                <span style={{ color: '#dc2626' }}>{row.text}</span>
              </li>;
            }
            if (row.kind === 'more') {
              return <li key={row.key} style={{ height: ROW_HEIGHT, paddingLeft: 16 + row.depth * 20 }} className="flex items-center">
                <button type="button" disabled={row.loading} onClick={() => fetchChildren(row.parentId, row.cursor)}
                        className="rounded-lg border px-3 py-1 text-xs font-medium hover:bg-gray-50"
                        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-primary)' }}>
                  {row.loading ? 'Loading…' : 'Show 50 more reports'}
                </button>
              </li>;
            }
            if (row.kind === 'more-roots') {
              return <li key={row.key} style={{ height: ROW_HEIGHT, paddingLeft: 16 }} className="flex items-center">
                <button type="button" onClick={() => loadMoreRoots(row.cursor)}
                        className="rounded-lg border px-3 py-1 text-xs font-medium hover:bg-gray-50"
                        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-primary)' }}>
                  Show more top-level
                </button>
              </li>;
            }
            const { node, depth } = row;
            const open = expanded.has(node.id);
            const expandable = canExpand(node);
            const isMatch = matchIds.has(node.id);
            const dimmed = showStatus && INACTIVE.has(node.status);
            return (
              <li key={row.key} role="treeitem" aria-expanded={expandable ? open : undefined}
                  style={{ height: ROW_HEIGHT, paddingLeft: 8 + depth * 20 }} className="flex items-center pr-2">
                <div className={`flex w-full items-center gap-3 rounded-xl border bg-white px-3 py-2 shadow-sm ${isMatch ? 'ring-2' : ''}`}
                     style={{ borderColor: isMatch ? 'var(--theme-primary)' : 'var(--theme-border)', opacity: dimmed ? 0.55 : 1, ...(isMatch ? { '--tw-ring-color': 'var(--theme-primary)' } : {}) }}>
                  {expandable ? (
                    <button type="button" onClick={() => toggle(node)} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {open ? '▾' : '▸'}
                    </button>
                  ) : <span className="inline-block h-6 w-6 shrink-0" aria-hidden />}
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-bold"
                        style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}>
                    {node.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={node.photoUrl} alt="" className="h-full w-full object-cover" />
                    ) : initials(node.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>{node.name}</span>
                      {node.isSelf && <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: 'var(--theme-primary)', color: '#fff' }}>You</span>}
                      {dimmed && <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">{node.status}</span>}
                    </span>
                    <span className="block truncate text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {node.designation || '—'}{node.departmentName ? ` · ${node.departmentName}` : ''}
                    </span>
                  </span>
                  {node.reportsCount > 0 && (
                    <span className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}>
                      {node.reportsCount} {node.reportsCount === 1 ? 'report' : 'reports'}
                    </span>
                  )}
                  {onFocus && expandable && (
                    <button type="button" onClick={() => onFocus(node)} className="shrink-0 text-xs underline" style={{ color: 'var(--theme-primary)' }} title="Focus on this person's team">Focus</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <div style={{ height: padBottom }} aria-hidden />
      </div>

      <p className="text-[11px]" style={{ color: 'var(--theme-muted)' }}>
        Showing {Math.min(total, endIdx) - startIdx} of {total} visible rows · only expanded branches are loaded.
      </p>
    </div>
  );
}
