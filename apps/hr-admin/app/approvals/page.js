'use client';

// Feature 10 slice 10d — Workflow Builder (the single highest-value owner UI).
//
// Landing: a grid of Process cards (Leave, Reimbursement, Travel, Salary change,
// Loan, Profile edit, Attendance fix, Exit). Each shows its current chain in one
// plain-language line ("Manager → Finance if > ₹50k") and a status pill
// (Default / Custom / Off). Clicking a card opens the Chain canvas (ChainBuilder)
// where a non-technical admin assembles steps with zero jargon.
//
// The page is gated on canManageApprovalWorkflows (server is the real boundary;
// this also hides the nav item). It reads /api/hr/approvals/workflows once and
// groups definitions by module so each card knows its live chain.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner } from '@hr/ui';
import { Icon } from '@/components/NavIcons';
import { get } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { InfoTip, PROCESSES, moduleLabel } from '@/lib/widgets';
import ChainBuilder from './ChainBuilder';
import { describeChain } from './describe';

function StatusPill({ status }) {
  const map = {
    Custom: 'bg-violet-50 text-violet-700 border-violet-200',
    Default: 'bg-blue-50 text-blue-700 border-blue-200',
    Off: 'bg-gray-100 text-gray-500 border-gray-200',
    Draft: 'bg-amber-50 text-amber-700 border-amber-200',
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
    return { head, status, count: defs.length };
  }
  if (drafts.length > 0) return { head: drafts[0], status: 'Draft', count: defs.length };
  return { head: null, status: 'Off', count: 0 };
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
      <span className="mt-3 text-xs font-medium text-[color:var(--theme-primary)] opacity-0 transition-opacity group-hover:opacity-100">
        Edit chain →
      </span>
    </button>
  );
}

export default function ApprovalsPage() {
  const [defs, setDefs] = useState(null);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [openModule, setOpenModule] = useState(null);

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

  if (openModule) {
    return (
      <ChainBuilder
        module={openModule}
        defs={byModule[openModule] || []}
        onClose={() => setOpenModule(null)}
        onChanged={load}
      />
    );
  }

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
