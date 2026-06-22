'use client';

// Org chart (Feature 1, Phase D).
//
// Renders GET /api/hr/org/tree — the manager→reports hierarchy — as a
// collapsible, dependency-free tree (CSS/flex; no chart libraries). Each node is
// a card showing name, designation, department, and #reports. Branches
// expand/collapse; a search box focuses (auto-expands + highlights) matching
// nodes. The tree is server-built and already scope-filtered: a Manager sees
// their own sub-tree, an Owner/HR-Admin sees the whole forest.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Spinner, ErrorBanner, Empty } from '@hr/ui';
import { get } from '@/lib/api';
import { PageHeader } from '@/lib/ui';

function countNodes(nodes) {
  let n = 0;
  for (const node of nodes) n += 1 + countNodes(node.children || []);
  return n;
}

// Collect ids of nodes that match the query, plus the ids of every ancestor so
// the path to a match stays expanded.
function matchPaths(nodes, q, ancestors, outMatches, outExpand) {
  for (const node of nodes) {
    const hit =
      q &&
      [node.name, node.code, node.designation, node.departmentName]
        .filter(Boolean)
        .some((s) => s.toLowerCase().includes(q));
    if (hit) {
      outMatches.add(node.id);
      for (const a of ancestors) outExpand.add(a);
    }
    matchPaths(node.children || [], q, [...ancestors, node.id], outMatches, outExpand);
  }
}

function Node({ node, depth, expanded, toggle, matches, hasQuery }) {
  const kids = node.children || [];
  const hasKids = kids.length > 0;
  const isOpen = expanded.has(node.id);
  const isMatch = matches.has(node.id);

  return (
    <li className="relative">
      <div
        className={`inline-flex items-start gap-3 rounded-xl border bg-white px-4 py-3 mb-2 transition-shadow hover:shadow-sm ${
          isMatch ? 'border-[color:var(--theme-primary)] ring-1 ring-[color:var(--theme-primary)]' : 'border-gray-200'
        } ${hasQuery && !isMatch ? 'opacity-60' : ''}`}
      >
        {hasKids ? (
          <button
            type="button"
            onClick={() => toggle(node.id)}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            aria-expanded={isOpen}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border border-gray-300 text-xs leading-none text-gray-600 hover:bg-gray-50"
          >
            {isOpen ? '−' : '+'}
          </button>
        ) : (
          <span className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        )}
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white text-sm font-semibold"
          style={{ backgroundColor: 'var(--theme-primary)' }}
        >
          {(node.name || node.code || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-900">{node.name}</span>
          <span className="block text-xs text-gray-500">
            {[node.designation, node.departmentName].filter(Boolean).join(' · ') || node.code}
          </span>
          {node.reportsCount > 0 && (
            <span className="mt-1 inline-flex items-center rounded-full bg-gray-100 text-gray-600 px-2 py-0.5 text-[11px]">
              {node.reportsCount} {node.reportsCount === 1 ? 'report' : 'reports'}
            </span>
          )}
        </span>
      </div>

      {hasKids && isOpen && (
        <ul className="pl-7 border-l border-gray-200 ml-2.5">
          {kids.map((child) => (
            <Node
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              matches={matches}
              hasQuery={hasQuery}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function OrgChartPage() {
  const [tree, setTree] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    get('/api/hr/org/tree')
      .then((res) => {
        if (!alive) return;
        const items = Array.isArray(res?.items) ? res.items : [];
        setTree(items);
        // Default: expand the root level so the chart isn't a wall of collapsed cards.
        setExpanded(new Set(items.map((n) => n.id)));
      })
      .catch((err) => {
        if (alive) setError(err.data?.message || err.message || 'Failed to load org chart.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const { matches } = useMemo(() => {
    const m = new Set();
    const exp = new Set();
    if (q && tree) matchPaths(tree, q, [], m, exp);
    return { matches: m, expandForQuery: exp };
  }, [q, tree]);

  // When searching, auto-expand the path to every match.
  useEffect(() => {
    if (!q || !tree) return;
    const m = new Set();
    const exp = new Set();
    matchPaths(tree, q, [], m, exp);
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of exp) next.add(id);
      for (const id of m) next.add(id); // expand the matched node itself too
      return next;
    });
  }, [q, tree]);

  const toggle = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function expandAll() {
    if (!tree) return;
    const all = new Set();
    const walk = (nodes) => nodes.forEach((n) => { all.add(n.id); walk(n.children || []); });
    walk(tree);
    setExpanded(all);
  }
  function collapseAll() {
    setExpanded(new Set());
  }

  const total = tree ? countNodes(tree) : 0;

  return (
    <div>
      <PageHeader
        title="Org chart"
        subtitle={total ? `${total} ${total === 1 ? 'person' : 'people'} in the reporting tree` : 'Reporting hierarchy'}
        actions={
          <Link
            href="/org"
            className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center"
          >
            Org structure
          </Link>
        }
      />

      {loading && <Spinner />}
      {error && <ErrorBanner message={error} />}

      {!loading && !error && tree && tree.length === 0 && (
        // Spec §6.1: a Manager rooted at self with no reports gets a friendly,
        // non-error empty state — not a failure.
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="text-sm font-medium text-gray-900">You don&apos;t manage anyone yet.</p>
          <p className="text-sm text-gray-500 mt-1">
            Ask HR to set your team&apos;s reporting lines, or assign managers from the People screen.
          </p>
        </div>
      )}

      {!loading && !error && tree && tree.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-5">
            <label htmlFor="org-search" className="sr-only">
              Search the org chart by name, code, designation, or department
            </label>
            <input
              id="org-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, designation, department…"
              className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm w-80"
            />
            <button
              type="button"
              onClick={expandAll}
              className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Expand all
            </button>
            <button
              type="button"
              onClick={collapseAll}
              className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Collapse all
            </button>
            {q && (
              <span className="text-sm text-gray-500">
                {matches.size} {matches.size === 1 ? 'match' : 'matches'}
              </span>
            )}
          </div>

          {q && matches.size === 0 ? (
            <Empty text="No one matches your search." />
          ) : (
            <ul className="text-sm">
              {tree.map((node) => (
                <Node
                  key={node.id}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  toggle={toggle}
                  matches={matches}
                  hasQuery={!!q}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
