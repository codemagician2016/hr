'use client';

// Org chart (Feature 19 — scalable redesign).
//
// Renders the reporting hierarchy via the LAZY per-node API so it stays fast at
// 1000+ / 10+ levels: first paint fetches only the roots (/org/tree/roots);
// expanding a node lazily loads that node's direct reports (/nodes/:id/children,
// paginated); search hits the server (/org/tree/search) and returns each match's
// ancestor path so the tree expands EXACTLY the branches to reveal it; the
// breadcrumb-to-top comes from /nodes/:id/ancestors. An admin can re-root the
// viewport at any in-scope node (?root=<id>); a manager is scope-clamped to their
// own sub-tree server-side. The whole thing is virtualized by the shared OrgTree
// component (DOM ≪ tenant size). Re-parenting (org editing) lives in the F10
// org editor — linked, never duplicated here.

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/lib/ui';
import { InfoTip } from '@/lib/widgets';
import OrgTree from '@/components/OrgTree';
import { get } from '@/lib/api';

function OrgChartInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rootId = searchParams.get('root') || null; // ?root=<id> re-roots the viewport

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [breadcrumb, setBreadcrumb] = useState([]);

  // Scoped API clients injected into the shared tree. Stable identities so the tree
  // only reloads roots when the re-root target (rootId) actually changes.
  const loadRoots = useCallback(
    (cursor) => get('/api/hr/org/tree/roots', { root: rootId || undefined, cursor: cursor || undefined, limit: 50 }),
    [rootId],
  );
  const loadChildren = useCallback(
    (id, cursor) => get(`/api/hr/org/tree/nodes/${id}/children`, { cursor: cursor || undefined, limit: 50 }),
    [],
  );
  const loadAncestors = useCallback(
    (id) => get(`/api/hr/org/tree/nodes/${id}/ancestors`),
    [],
  );

  // Re-root → push ?root=<id>; the page reloads roots at that node + draws the
  // breadcrumb path-to-top.
  const focusNode = useCallback((node) => {
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    sp.set('root', node.id);
    router.push(`/org/chart?${sp.toString()}`);
  }, [router, searchParams]);

  const clearRoot = useCallback(() => {
    const sp = new URLSearchParams(Array.from(searchParams.entries()));
    sp.delete('root');
    router.push(sp.toString() ? `/org/chart?${sp.toString()}` : '/org/chart');
  }, [router, searchParams]);

  // Breadcrumb: when re-rooted, fetch the focused node's path-to-top.
  useEffect(() => {
    let alive = true;
    if (!rootId) { setBreadcrumb([]); return undefined; }
    loadAncestors(rootId)
      .then((res) => { if (alive) setBreadcrumb(res.path || []); })
      .catch(() => { if (alive) setBreadcrumb([]); });
    return () => { alive = false; };
  }, [rootId, loadAncestors]);

  // Server search (debounced). Picking a result expands its path inside the tree.
  const debounceRef = useRef(null);
  useEffect(() => {
    const q = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q) { setSearchResults(null); setSearching(false); return undefined; }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      get('/api/hr/org/tree/search', { q, limit: 20 })
        .then((res) => setSearchResults(res.results || []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // Breadcrumb click → re-root upward at that ancestor.
  const onBreadcrumb = useCallback((node) => focusNode(node), [focusNode]);

  return (
    <div>
      <PageHeader
        title="Org chart"
        subtitle="The reporting hierarchy — opens at the top and loads each branch only when you expand it, so it stays fast at thousands of people."
        actions={
          <div className="flex items-center gap-2">
            {rootId && (
              <button type="button" onClick={clearRoot} className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
                Back to full org
              </button>
            )}
            <Link href="/approvals/org" className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center">
              Edit reporting lines
            </Link>
            <Link href="/org" className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center">
              Org structure
            </Link>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label htmlFor="org-search" className="sr-only">Search the org chart by name, code, designation, or department</label>
        <div className="relative">
          <input
            id="org-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a person to jump to them…"
            className="w-80 rounded-lg border border-gray-300 px-4 py-2.5 text-sm"
          />
          {searching && <span className="absolute right-3 top-3 text-xs text-gray-400">…</span>}
        </div>
        <span className="inline-flex items-center text-xs text-gray-500">
          Lazy &amp; virtualized
          <InfoTip text="The chart never downloads the whole company. It loads the top, then each branch only when you open it, and searches on the server — so it stays fast even with thousands of employees across many levels." />
        </span>
        {searchResults && (
          <span className="text-sm text-gray-500">
            {searchResults.length} {searchResults.length === 1 ? 'match' : 'matches'}
          </span>
        )}
      </div>

      <OrgTree
        key={rootId || 'root'}
        loadRoots={loadRoots}
        loadChildren={loadChildren}
        loadAncestors={loadAncestors}
        searchResults={searchResults}
        onFocus={focusNode}
        breadcrumb={breadcrumb}
        onBreadcrumb={onBreadcrumb}
        showStatus
        emptyText="You don't manage anyone yet — ask HR to set your team's reporting lines, or assign managers from the People screen."
      />
    </div>
  );
}

export default function OrgChartPage() {
  return (
    <Suspense fallback={<p className="text-sm text-gray-500">Loading the org chart…</p>}>
      <OrgChartInner />
    </Suspense>
  );
}
