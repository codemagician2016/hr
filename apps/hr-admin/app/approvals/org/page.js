'use client';

// Feature 10 slice 10e — Org-Chart editor (visual reporting-tree editing).
//
// Renders GET /api/hr/rbac/org-tree (a flat list of { id, managerEmployeeId,
// depth, name, code, status }) as a collapsible reporting tree. The admin can:
//   • search a person (auto-expands the path, highlights matches),
//   • DRAG a person onto a new manager → PATCH /rbac/employees/:id
//     { managerEmployeeId } (server cycle-guards: nobody can become their own
//     ancestor), with a confirm toast ("Asha now reports to Ravi — this changes
//     who approves Asha's requests."),
//   • drop onto "Top level (no manager)" to detach.
// A flat-mode banner appears when no managers are set, pointing the admin at the
// builder's "A specific person / A role" steps instead.
//
// Gated on canManageHierarchy (server enforces; this also hides the nav item).

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Spinner, ErrorBanner, Empty } from '@hr/ui';
import { get, request } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip } from '@/lib/widgets';

// Build a parent→children tree from the flat node list.
function buildTree(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, { ...n, children: [] }]));
  const roots = [];
  for (const n of byId.values()) {
    if (n.managerEmployeeId && byId.has(n.managerEmployeeId)) {
      byId.get(n.managerEmployeeId).children.push(n);
    } else {
      roots.push(n);
    }
  }
  return { roots, byId };
}

// Would moving `dragId` under `dropId` create a cycle? (client-side guard so we
// never even send an obviously-bad PATCH; the server is the real guard.)
function wouldCycle(byId, dragId, dropId) {
  if (!dropId) return false;
  if (dragId === dropId) return true;
  let cur = byId.get(dropId);
  const seen = new Set();
  while (cur && cur.managerEmployeeId && !seen.has(cur.id)) {
    if (cur.managerEmployeeId === dragId) return true;
    seen.add(cur.id);
    cur = byId.get(cur.managerEmployeeId);
  }
  return false;
}

function collectMatches(nodes, q, ancestors, matches, expand) {
  for (const n of nodes) {
    const hit = q && [n.name, n.code].filter(Boolean).some((s) => s.toLowerCase().includes(q));
    if (hit) { matches.add(n.id); for (const a of ancestors) expand.add(a); }
    collectMatches(n.children || [], q, [...ancestors, n.id], matches, expand);
  }
}

function Node({ node, depth, expanded, toggle, matches, hasQuery, drag, canEdit }) {
  const kids = node.children || [];
  const hasKids = kids.length > 0;
  const isOpen = expanded.has(node.id);
  const isMatch = matches.has(node.id);
  const isDragging = drag.dragId === node.id;
  const isDropTarget = drag.overId === node.id;

  return (
    <li className="relative">
      <div
        draggable={canEdit}
        onDragStart={(e) => { if (canEdit) { e.dataTransfer.effectAllowed = 'move'; drag.onDragStart(node.id); } }}
        onDragEnd={drag.onDragEnd}
        onDragOver={(e) => { if (canEdit && drag.dragId && drag.dragId !== node.id) { e.preventDefault(); drag.onDragOver(node.id); } }}
        onDragLeave={() => drag.onDragLeave(node.id)}
        onDrop={(e) => { e.preventDefault(); if (canEdit) drag.onDrop(node.id); }}
        className={`mb-2 inline-flex items-start gap-3 rounded-xl border bg-white px-4 py-3 transition-shadow hover:shadow-sm ${
          isMatch ? 'border-[color:var(--theme-primary)] ring-1 ring-[color:var(--theme-primary)]' : 'border-gray-200'
        } ${hasQuery && !isMatch ? 'opacity-60' : ''} ${isDragging ? 'opacity-40' : ''} ${
          isDropTarget ? 'ring-2 ring-emerald-400 border-emerald-400' : ''
        } ${canEdit ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        {hasKids ? (
          <button type="button" onClick={() => toggle(node.id)} aria-label={isOpen ? 'Collapse' : 'Expand'} aria-expanded={isOpen}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border border-gray-300 text-xs leading-none text-gray-600 hover:bg-gray-50">
            {isOpen ? '−' : '+'}
          </button>
        ) : (
          <span className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        )}
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ backgroundColor: 'var(--theme-primary)' }}>
          {(node.name || node.code || '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-900">{node.name}</span>
          <span className="block text-xs text-gray-500">{node.code || '—'}</span>
          {kids.length > 0 && (
            <span className="mt-1 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
              {kids.length} report{kids.length === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </div>

      {hasKids && isOpen && (
        <ul className="ml-2.5 border-l border-gray-200 pl-7">
          {kids.map((c) => (
            <Node key={c.id} node={c} depth={depth + 1} expanded={expanded} toggle={toggle} matches={matches} hasQuery={hasQuery} drag={drag} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function OrgEditorPage() {
  const [data, setData] = useState(null); // { nodes, orphans, flatMode }
  const [error, setError] = useState('');
  const [canEdit, setCanEdit] = useState(true);
  const [expanded, setExpanded] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState({ dragId: null, overId: null });
  const [toast, setToast] = useState('');
  const [pendingError, setPendingError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [tree, me] = await Promise.all([
        get('/api/hr/rbac/org-tree'),
        get('/api/auth/me').catch(() => null),
      ]);
      const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
      const orphans = Array.isArray(tree?.orphans) ? tree.orphans : [];
      setData({ nodes, orphans, flatMode: !!tree?.flatMode });
      setExpanded(new Set(nodes.filter((n) => !n.managerEmployeeId).map((n) => n.id)));
      const session = me?.user || me;
      if (session) setCanEdit(hasPermission(permissionsFromSession(session), 'canManageHierarchy'));
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to load the reporting tree.');
      setData({ nodes: [], orphans: [], flatMode: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const allNodes = useMemo(() => {
    if (!data) return [];
    // Treat orphans (no row in the CTE) as additional top-level people so they're
    // visible + reparentable.
    const orphanNodes = (data.orphans || []).map((o) => ({ ...o, managerEmployeeId: null }));
    const seen = new Set(data.nodes.map((n) => n.id));
    return [...data.nodes, ...orphanNodes.filter((o) => !seen.has(o.id))];
  }, [data]);

  const { roots, byId } = useMemo(() => buildTree(allNodes), [allNodes]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    const m = new Set(); const exp = new Set();
    if (q) collectMatches(roots, q, [], m, exp);
    return m;
  }, [q, roots]);

  useEffect(() => {
    if (!q) return;
    const m = new Set(); const exp = new Set();
    collectMatches(roots, q, [], m, exp);
    setExpanded((prev) => { const next = new Set(prev); for (const id of exp) next.add(id); for (const id of m) next.add(id); return next; });
  }, [q, roots]);

  const toggle = useCallback((id) => {
    setExpanded((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }, []);

  async function reparent(dragId, newManagerId) {
    const person = byId.get(dragId);
    const manager = newManagerId ? byId.get(newManagerId) : null;
    if (!person) return;
    if (person.managerEmployeeId === (newManagerId || null)) return; // no-op
    if (wouldCycle(byId, dragId, newManagerId)) {
      setPendingError(`${person.name} can’t report to ${manager?.name || 'that person'} — it would create a reporting loop.`);
      return;
    }
    setPendingError('');
    try {
      await request(`/api/hr/rbac/employees/${dragId}`, {
        method: 'PATCH',
        body: JSON.stringify({ managerEmployeeId: newManagerId || null }),
      });
      setToast(
        manager
          ? `${person.name} now reports to ${manager.name}. This changes who approves ${person.name.split(' ')[0]}’s requests.`
          : `${person.name} is now at the top level (no manager).`
      );
      setTimeout(() => setToast(''), 6000);
      await load();
    } catch (err) {
      setPendingError(err.data?.message || err.message || 'Could not change the reporting line.');
    }
  }

  const dragApi = {
    dragId: drag.dragId,
    overId: drag.overId,
    onDragStart: (id) => setDrag({ dragId: id, overId: null }),
    onDragEnd: () => setDrag({ dragId: null, overId: null }),
    onDragOver: (id) => setDrag((d) => (d.overId === id ? d : { ...d, overId: id })),
    onDragLeave: (id) => setDrag((d) => (d.overId === id ? { ...d, overId: null } : d)),
    onDrop: (id) => { const dragId = drag.dragId; setDrag({ dragId: null, overId: null }); if (dragId) reparent(dragId, id); },
  };

  if (data === null) return <Spinner />;

  const total = allNodes.length;

  return (
    <div>
      <PageHeader
        title={<span className="inline-flex items-center">Reporting tree<InfoTip text="This is your org chart: who reports to whom. Drag a person onto their new manager to change it. The approval engine routes ‘my manager’ steps along these exact lines." /></span>}
        subtitle={total ? `${total} ${total === 1 ? 'person' : 'people'} — drag a person onto a new manager to re-assign` : 'Set up who reports to whom'}
        actions={<Link href="/approvals" className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50">← Approvals</Link>}
      />

      {error && <ErrorBanner message={error} />}
      {pendingError && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{pendingError}</p>
      )}
      {toast && (
        <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{toast}</p>
      )}

      {data.flatMode && (
        <div className="mb-5 rounded-2xl border border-blue-200 bg-blue-50 p-4">
          <div className="flex items-start gap-2">
            <span className="text-lg" aria-hidden="true">💡</span>
            <div>
              <p className="text-sm font-medium text-blue-900">You haven’t set up a reporting structure — that’s fine.</p>
              <p className="mt-0.5 text-sm text-blue-800">
                Your approval chains can point to a specific person or a role instead of “my manager”.
                Drag people together below to build a tree, or leave it flat and use{' '}
                <Link href="/approvals" className="font-medium underline">named approvers</Link> in the builder.
              </p>
            </div>
          </div>
        </div>
      )}

      {!canEdit && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-700">
          You can view the reporting tree but not change it — that needs the “Edit the reporting tree” permission.
        </p>
      )}

      {total === 0 ? (
        <Empty text="No people in the reporting tree yet." />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search a person…"
              className="w-72 rounded-lg border border-gray-300 px-4 py-2.5 text-sm"
            />
            {q && <span className="text-sm text-gray-500">{matches.size} {matches.size === 1 ? 'match' : 'matches'}</span>}
            {canEdit && (
              <span
                onDragOver={(e) => { if (drag.dragId) { e.preventDefault(); dragApi.onDragOver('__TOP__'); } }}
                onDragLeave={() => dragApi.onDragLeave('__TOP__')}
                onDrop={(e) => { e.preventDefault(); const d = drag.dragId; setDrag({ dragId: null, overId: null }); if (d) reparent(d, null); }}
                className={`ml-auto inline-flex items-center rounded-lg border border-dashed px-3 py-2 text-xs font-medium ${
                  drag.overId === '__TOP__' ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-gray-300 text-gray-500'
                }`}
              >
                ⤴ Drop here to make someone top-level (no manager)
              </span>
            )}
          </div>

          {q && matches.size === 0 ? (
            <Empty text="No one matches your search." />
          ) : (
            <div className="overflow-x-auto rounded-2xl border border-gray-100 bg-gray-50/40 p-4">
              <ul className="text-sm">
                {roots.map((node) => (
                  <Node key={node.id} node={node} depth={0} expanded={expanded} toggle={toggle} matches={matches} hasQuery={!!q} drag={dragApi} canEdit={canEdit} />
                ))}
              </ul>
            </div>
          )}

          {canEdit && (
            <p className="mt-4 flex items-center text-xs text-gray-400">
              Tip: drag a card onto another person to make them the manager. We block anything that would create a loop.
              <InfoTip text="Changes here are instant and affect every module: any approval chain that uses ‘my manager’ now routes along the new line." />
            </p>
          )}
        </>
      )}
    </div>
  );
}
