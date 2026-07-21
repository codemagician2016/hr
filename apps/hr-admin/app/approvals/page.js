'use client';

// Feature 10 slice 10d — Workflow Builder — extended by Program Phase 2 with
// SCOPED definitions (multiple chains per process).
//
// Three levels:
//   1. Landing — a grid of Process cards (Leave, Reimbursement, Travel, Salary
//      change, Loan, Profile edit, Attendance fix, Exit). Each shows its live
//      chain in one plain-language line and a status pill.
//   2. Definition list — clicking a card shows EVERY chain for that process:
//      the company-wide default plus any scoped chains (by department / grade /
//      location), each with a Live/Draft badge, priority and actions (edit the
//      canvas, edit details, publish, delete). "New chain" opens a modal that
//      creates a draft (POST /workflows) and drops straight into the canvas.
//   3. Canvas — ChainBuilder edits ONE specific definition's steps.
//
// Resolution at request time (workflowResolver): among PUBLISHED chains whose
// scope matches the requester, the lowest priority number wins (ties → most
// specific). The scope-less published chain is the company-wide fallback.
//
// The page is gated on canManageApprovalWorkflows (server is the real boundary;
// this also hides the nav item).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, Modal, ModalActions, PrimaryButton, TextInput, TextArea } from '@hr/ui';
import { Icon } from '@/components/NavIcons';
import { get, post, put, del } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip, PROCESSES, moduleLabel } from '@/lib/widgets';
import ChainBuilder from './ChainBuilder';
import { describeChain, describeScope } from './describe';
import ModuleGuide from '@/components/ModuleGuide';

function StatusPill({ status }) {
  const map = {
    Custom: 'bg-violet-50 text-violet-700 border-violet-200',
    Default: 'bg-blue-50 text-blue-700 border-blue-200',
    Off: 'bg-gray-100 text-gray-500 border-gray-200',
    Draft: 'bg-amber-50 text-amber-700 border-amber-200',
    Live: 'bg-blue-50 text-blue-700 border-blue-200',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${map[status] || map.Off}`}>
      {status}
    </span>
  );
}

// Resolve a module's "headline" definition + status from the loaded list.
// Live (published) custom/default wins; else a draft; else "Off" (built-in default).
function summarise(defs) {
  const live = defs.filter((d) => d.isPublished);
  const drafts = defs.filter((d) => !d.isPublished);
  if (live.length > 0) {
    // Prefer the module-default (no scope/entity) for the headline line.
    const head = live.find((d) => d.isLiveDefault) || live[0];
    const status = head.isLiveDefault && live.length === 1 ? 'Default' : 'Custom';
    return { head, status, count: defs.length, liveCount: live.length };
  }
  if (drafts.length > 0) return { head: drafts[0], status: 'Draft', count: defs.length, liveCount: 0 };
  return { head: null, status: 'Off', count: 0, liveCount: 0 };
}

function ProcessCard({ process, summary, onOpen }) {
  const line = summary.head
    ? describeChain(summary.head.steps || [])
    : 'No custom chain yet — uses the built-in default.';
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full flex-col rounded-2xl border border-gray-200 bg-white p-5 text-left transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2"
      style={{ '--tw-ring-color': 'var(--theme-primary)' }}
    >
      <div className="mb-3 flex items-center justify-between">
        <span
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-white"
          style={{ backgroundColor: 'var(--theme-primary)' }}
        >
          <Icon name={process.icon} size={18} />
        </span>
        <StatusPill status={summary.status} />
      </div>
      <div className="flex items-center text-sm font-semibold text-gray-900">
        {process.label}
        <InfoTip text={process.hint} />
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-gray-500">{line}</p>
      {summary.count > 1 && (
        <p className="mt-1 text-[11px] font-medium text-gray-400">
          {summary.count} chains · {summary.liveCount} live
        </p>
      )}
      <span className="mt-3 text-xs font-medium text-[color:var(--theme-primary)] opacity-0 transition-opacity group-hover:opacity-100">
        Manage chains →
      </span>
    </button>
  );
}

// ─── scope picker (checkbox chips per group) ─────────────────────────────────
function ScopeGroup({ label, tip, items, selected, onToggle }) {
  return (
    <div>
      <div className="mb-1 flex items-center text-sm font-medium text-gray-700">
        {label}
        <InfoTip text={tip} />
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-gray-400">None defined yet — set these up under Organisation first.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it) => {
            const on = selected.includes(it.id);
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => onToggle(it.id)}
                aria-pressed={on}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  on
                    ? 'border-violet-200 bg-violet-50 text-violet-700'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                {on ? '✓ ' : ''}{it.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Build the resolver's scopeJson from the three picked arrays — only non-empty
// groups are included; everything empty → null (company-wide).
function buildScopeJson({ departmentIds, employeeLevels, locationIds }) {
  const scope = {};
  if (departmentIds.length > 0) scope.departmentIds = departmentIds;
  if (employeeLevels.length > 0) scope.employeeLevels = employeeLevels;
  if (locationIds.length > 0) scope.locationIds = locationIds;
  return Object.keys(scope).length > 0 ? scope : null;
}

// ─── new / edit-details modal ────────────────────────────────────────────────
// def == null → create a draft (POST). def set → edit name/description/priority/
// scope (PUT — scopeJson null clears it). Steps are NOT touched here.
function DefFormModal({ module, def, lookups, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    name: def?.name || '',
    description: def?.description || '',
    priority: def?.priority ?? 100,
    departmentIds: def?.scopeJson?.departmentIds || [],
    employeeLevels: def?.scopeJson?.employeeLevels || [],
    locationIds: def?.scopeJson?.locationIds || [],
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggle = (key) => (id) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id],
    }));

  const scope = buildScopeJson(form);

  async function save() {
    if (!form.name.trim()) { setError('Give this chain a name.'); return; }
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        priority: Number(form.priority) || 100,
        scopeJson: scope,
      };
      const saved = def
        ? await put(`/api/hr/approvals/workflows/${def.id}`, payload)
        : await post('/api/hr/approvals/workflows', { ...payload, module });
      onSaved(saved, def ? 'edited' : 'created');
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save.');
      setSaving(false);
    }
  }

  return (
    <Modal title={def ? `Edit details — ${def.name}` : 'New chain'} onClose={onClose} size="lg">
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <TextInput
          label="Name"
          value={form.name}
          onChange={(v) => setForm((f) => ({ ...f, name: v }))}
          placeholder={`e.g. ${moduleLabel(module)} — Engineering`}
        />
        <TextArea
          label="Description (optional)"
          value={form.description}
          onChange={(v) => setForm((f) => ({ ...f, description: v }))}
          rows={2}
          hint="A note for other admins about when this chain applies."
        />
        <TextInput
          label="Priority"
          type="number"
          min={1}
          value={form.priority}
          onChange={(v) => setForm((f) => ({ ...f, priority: v }))}
          hint="Lower runs first when several chains match a request. Default 100."
        />

        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div className="mb-3 flex items-center text-sm font-semibold text-gray-900">
            Who is this chain for?
            <InfoTip text="Tick departments, grades or locations to limit this chain to matching employees. A request must match EVERY group you tick (e.g. Engineering AND Pune). Leave everything unticked for a company-wide chain." />
          </div>
          <div className="space-y-3">
            <ScopeGroup
              label="Departments"
              tip="Only requests from employees in these departments use this chain."
              items={lookups.departments}
              selected={form.departmentIds}
              onToggle={toggle('departmentIds')}
            />
            <ScopeGroup
              label="Grades"
              tip="Only employees at these grades use this chain."
              items={lookups.grades}
              selected={form.employeeLevels}
              onToggle={toggle('employeeLevels')}
            />
            <ScopeGroup
              label="Locations"
              tip="Only employees at these work locations use this chain."
              items={lookups.locations}
              selected={form.locationIds}
              onToggle={toggle('locationIds')}
            />
          </div>
          <p className="mt-3 text-xs text-gray-500">
            {scope
              ? <>Applies to: <span className="font-medium">{describeScope(scope, lookups)}</span></>
              : 'Nothing ticked — this is a company-wide chain (the fallback when no scoped chain matches).'}
          </p>
        </div>

        <ModalActions>
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <PrimaryButton onClick={save} loading={saving}>
            {def ? 'Save details' : 'Create & build the chain'}
          </PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ─── one definition row in the module list ───────────────────────────────────
function DefinitionRow({ d, lookups, busy, onEditChain, onEditDetails, onPublish, onDelete }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">{d.name}</span>
            <StatusPill status={d.isPublished ? 'Live' : 'Draft'} />
            {d.isLiveDefault && (
              <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                Default
                <InfoTip text="The company-wide fallback — it handles every request that no scoped chain matches." />
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            <span className="font-medium text-gray-600">{describeScope(d.scopeJson, lookups)}</span>
            <span className="mx-1.5 text-gray-300">·</span>
            Priority {d.priority}
          </p>
          <p className="mt-1 line-clamp-1 text-xs text-gray-400">{describeChain(d.steps || [])}</p>
          {d.description && <p className="mt-1 line-clamp-1 text-[11px] text-gray-400">{d.description}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onEditChain}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white"
            style={{ backgroundColor: 'var(--theme-primary)' }}
          >
            Edit chain
          </button>
          <button type="button" onClick={onEditDetails} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            Edit details
          </button>
          {!d.isPublished && (
            <button
              type="button"
              onClick={onPublish}
              disabled={busy}
              className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            >
              Publish
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── the per-module definition list ──────────────────────────────────────────
function ModuleDefList({ module, defs, lookups, onBack, onOpenCanvas, onNewChain, onEditDetails, onChanged, setPageError }) {
  const [busyId, setBusyId] = useState(null);
  const liveCount = defs.filter((d) => d.isPublished).length;

  async function publish(d) {
    const ok = window.confirm(
      `Publish “${d.name}”?\n\nFrom the moment you publish, new ${moduleLabel(module)} requests that match this chain's scope will start routing through it. Requests already in flight keep their old chain.`,
    );
    if (!ok) return;
    setBusyId(d.id);
    setPageError('');
    try {
      await post(`/api/hr/approvals/workflows/${d.id}/publish`, {});
      await onChanged();
    } catch (err) {
      setPageError(err.data?.message || err.message || 'Failed to publish.');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(d) {
    const isOnlyPublishedDefault = d.isLiveDefault && liveCount === 1;
    const msg = isOnlyPublishedDefault
      ? `Delete “${d.name}”?\n\nWARNING: this is the only live company-wide chain for ${moduleLabel(module)}. Without it, requests that match no scoped chain fall back to DriftHR's built-in default (the manager approves).`
      : `Delete “${d.name}”? New requests will no longer use this chain. Requests already in flight are unaffected.`;
    if (!window.confirm(msg)) return;
    setBusyId(d.id);
    setPageError('');
    try {
      await del(`/api/hr/approvals/workflows/${d.id}`);
      await onChanged();
    } catch (err) {
      setPageError(err.data?.message || err.message || 'Failed to delete.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <button type="button" onClick={onBack} className="mb-2 text-sm text-gray-500 hover:text-gray-700">← All processes</button>
          <h1 className="flex items-center text-2xl font-semibold text-gray-900">
            {moduleLabel(module)} approval chains
            <InfoTip text="A process can have several chains — one for the whole company plus scoped ones for specific departments, grades or locations. Each request picks exactly one chain." />
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {defs.length === 0
              ? 'No chains yet — requests use the built-in default (the manager approves).'
              : `${defs.length} chain${defs.length > 1 ? 's' : ''} · ${liveCount} live`}
          </p>
        </div>
        <div className="shrink-0">
          <PrimaryButton onClick={onNewChain}>+ New chain</PrimaryButton>
        </div>
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-800">
        <span className="mt-0.5 font-semibold">How the right chain is picked:</span>
        <span>
          When an employee files a request, the highest-priority published chain whose scope matches
          them (lowest number first) handles it; the company-wide chain is the fallback. Drafts never
          route requests until you publish them.
        </span>
      </div>

      {defs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center">
          <p className="text-sm text-gray-500">
            No chains for {moduleLabel(module)} yet. Create the first one — leave the scope empty to
            make it the company-wide default, or tick departments / grades / locations for a scoped chain.
          </p>
          <div className="mt-4 inline-flex">
            <PrimaryButton onClick={onNewChain}>Create the first chain</PrimaryButton>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {defs.map((d) => (
            <DefinitionRow
              key={d.id}
              d={d}
              lookups={lookups}
              busy={busyId === d.id}
              onEditChain={() => onOpenCanvas(d)}
              onEditDetails={() => onEditDetails(d)}
              onPublish={() => publish(d)}
              onDelete={() => remove(d)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  const [defs, setDefs] = useState(null);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [openModule, setOpenModule] = useState(null);
  const [canvasDef, setCanvasDef] = useState(null); // the definition open in ChainBuilder
  const [modal, setModal] = useState(null); // { def: null } = new chain; { def } = edit details
  const [lookups, setLookups] = useState({ departments: [], grades: [], locations: [] });

  const load = useCallback(async () => {
    setError('');
    try {
      const [res, me] = await Promise.all([
        get('/api/hr/approvals/workflows'),
        get('/api/auth/me').catch(() => null),
      ]);
      setDefs(Array.isArray(res?.items) ? res.items : []);
      const session = me?.user || me;
      if (session) setCanManage(hasPermission(permissionsFromSession(session), 'canManageApprovalWorkflows'));
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to load approval workflows.');
      setDefs([]);
    }
  }, []);

  useEffect(() => {
    load();
    // Scope-picker masters ({ items } lists) — names for scope summaries + the pickers.
    Promise.all([
      get('/api/hr/org/departments').catch(() => ({ items: [] })),
      get('/api/hr/org/grades').catch(() => ({ items: [] })),
      get('/api/hr/org/locations').catch(() => ({ items: [] })),
    ]).then(([d, g, l]) => {
      setLookups({
        departments: Array.isArray(d?.items) ? d.items : [],
        grades: Array.isArray(g?.items) ? g.items : [],
        locations: Array.isArray(l?.items) ? l.items : [],
      });
    });
  }, [load]);

  const byModule = useMemo(() => {
    const m = {};
    for (const p of PROCESSES) m[p.module] = [];
    for (const d of defs || []) {
      if (!m[d.module]) m[d.module] = [];
      m[d.module].push(d);
    }
    return m;
  }, [defs]);

  if (defs === null) return <Spinner />;

  if (!canManage) {
    return (
      <div>
        <PageHeader title="Approvals" subtitle="Build approval chains for every process" />
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          You don’t have permission to manage approval workflows. Ask an Owner or HR-Admin to grant you
          <span className="font-medium"> “Build approval chains.”</span>
        </p>
      </div>
    );
  }

  // Level 3 — the canvas, editing one specific definition.
  if (openModule && canvasDef) {
    return (
      <ChainBuilder
        module={openModule}
        def={canvasDef}
        scopeLabel={describeScope(canvasDef.scopeJson, lookups)}
        onClose={() => setCanvasDef(null)}
        onChanged={load}
      />
    );
  }

  // Level 2 — the definition list for one process.
  if (openModule) {
    return (
      <div>
        {error && <ErrorBanner message={error} />}
        <ModuleDefList
          module={openModule}
          defs={byModule[openModule] || []}
          lookups={lookups}
          onBack={() => { setModal(null); setOpenModule(null); }}
          onOpenCanvas={(d) => setCanvasDef(d)}
          onNewChain={() => setModal({ def: null })}
          onEditDetails={(d) => setModal({ def: d })}
          onChanged={load}
          setPageError={setError}
        />
        {modal && (
          <DefFormModal
            module={openModule}
            def={modal.def}
            lookups={lookups}
            onClose={() => setModal(null)}
            onSaved={async (saved, kind) => {
              setModal(null);
              await load();
              // A freshly created draft drops straight into the canvas to build steps.
              if (kind === 'created') setCanvasDef(saved);
            }}
          />
        )}
      </div>
    );
  }

  // Level 1 — the process grid.
  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center">
            Approvals
            <InfoTip text="An approval chain decides who says yes to each kind of request — and in what order. Pick a process below to set it up. No jargon, just steps." />
          </span>
        }
        subtitle="Pick a process to choose who approves it, in what order, and what happens if nobody acts."
      />

      <ModuleGuide
        id="approvals"
        title="Build the approval chain for each request type"
        what="Each tile below is a process — Leave, Reimbursement, Travel, Salary change, Loan, Profile edit, Attendance fix, Exit. A process can have SEVERAL chains: one company-wide default plus scoped chains for specific departments, grades or locations. The chain decides who must say yes, in what order, before that request takes effect. ‘Off’ means DriftHR’s built-in default applies (usually the employee’s manager approves)."
        steps={[
          'Find the process you want to control (e.g. Reimbursement) and click its card to see its chains.',
          'Open the company-wide chain (or create one) and add approval steps in order — the first approver acts before the request reaches the next.',
          'Need different approvers for a team? “+ New chain”, tick the departments / grades / locations it covers, and build its steps.',
          'Add a condition where it matters, e.g. send to Finance only when the amount is above ₹50,000, and set what happens if nobody acts.',
          'Publish each chain — when a request is filed, the highest-priority live chain whose scope matches the employee handles it; the company-wide chain is the fallback.',
        ]}
        example={<>For <b>Reimbursement</b> at <b>Acme India Pvt Ltd</b>: the company-wide chain is <b>Reporting Manager</b> → <b>Finance over ₹50,000</b>, and a scoped chain for <b>Dept: Sales</b> adds the <b>Sales head</b>. When <b>Aarav Sharma</b> (Engineering) files a claim it uses the company-wide chain; his colleague in <b>Sales</b> gets the Sales chain instead.</>}
        tips={[
          'Only Leave and Reimbursement (Expense) run live through the engine today — other chains are saved but not yet enforced.',
          'You need the “Build approval chains” permission; without it the page is read-only, so ask an Owner or HR-Admin to grant it.',
        ]}
      />

      {error && <ErrorBanner message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {PROCESSES.map((p) => (
          <ProcessCard
            key={p.module}
            process={p}
            summary={summarise(byModule[p.module] || [])}
            onOpen={() => setOpenModule(p.module)}
          />
        ))}
      </div>

      <p className="mt-6 text-xs text-gray-400">
        “Off” means the process uses DriftHR’s sensible built-in default (usually: the manager approves).
        Set up a chain to customise it. {moduleLabel('LEAVE')} and {moduleLabel('EXPENSE')} run live through the engine today.
      </p>
    </div>
  );
}
