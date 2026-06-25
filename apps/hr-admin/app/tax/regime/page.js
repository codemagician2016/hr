'use client';

/**
 * Tax → Regime election (Feature 15/25). HR sets the per-FY employer DEFAULT regime, the
 * election WINDOW (open / lock date), and a global lock; plus a per-employee VIEW of each
 * employee's elected/effective regime + lock status with single + bulk ("lock all for FY")
 * lock actions. The DEFAULT is what an UN-ELECTED employee is withheld under (the resolver
 * getEffectiveRegime); the lock freezes elections so the regime that drove the year's TDS
 * can't be retroactively flipped. Server-gated: read = canViewPayrollReports, write
 * (policy/lock) = canManageStatutory.
 */

import { useCallback, useEffect, useState } from 'react';
import { get, put, post } from '@/lib/api';
import { PageHeader, DataTable, StatusBadge, ActionButton, ServerPagination } from '@/lib/ui';
import { Spinner, ErrorBanner, PrimaryButton, DateField, formatAdminDate } from '@hr/ui';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';

// Default FY = the current India financial year (FY starts 1 April).
function currentFy() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const startYear = now.getUTCMonth() + 1 >= 4 ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// ⓘ tip (mirrors EmployeeSearchSelect's InfoTip).
function InfoTip({ text }) {
  if (!text) return null;
  return (
    <span
      className="ml-1 inline-flex h-4 w-4 cursor-help select-none items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-500 align-middle hover:border-gray-400 hover:text-gray-700"
      title={text} tabIndex={0} role="img" aria-label={`Help: ${text}`}
    >
      i
    </span>
  );
}

function dateInput(v) {
  if (!v) return '';
  try { return new Date(v).toISOString().slice(0, 10); } catch { return ''; }
}

export default function RegimePage() {
  const [fy] = useState(currentFy());
  const [policy, setPolicy] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [q, setQ] = useState('');           // server search term
  const [defaultRegime, setDefaultRegime] = useState('NEW');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const loadList = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/tax/regime', { fy, q, page, pageSize })
      .then((res) => {
        setRows(res.items || []);
        setTotal(Number(res.total) || 0);
        setPolicy(res.policy || null);
        if (res.policy && res.policy.defaultRegime) setDefaultRegime(res.policy.defaultRegime);
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load regime view.'))
      .finally(() => setLoading(false));
  }, [fy, q, page, pageSize]);

  useEffect(() => { loadList(); }, [loadList]);

  async function lockOne(employeeId, locked) {
    setBusyId(`${employeeId}:lock`);
    setError('');
    try {
      if (locked) await post('/api/hr/tax/regime/unlock', { employeeId });
      else await post('/api/hr/tax/regime/lock', { employeeId });
      loadList();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to update lock.');
    } finally {
      setBusyId('');
    }
  }

  async function lockAll() {
    if (!window.confirm(`Lock the regime election for EVERY India employee for FY ${fy}? They will no longer be able to change it.`)) return;
    setBusyId('all:lock');
    setError('');
    try {
      const r = await post('/api/hr/tax/regime/lock', { all: true });
      window.alert(`Locked ${r.locked} employee${r.locked === 1 ? '' : 's'}.`);
      loadList();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to lock all.');
    } finally {
      setBusyId('');
    }
  }

  const columns = [
    {
      key: 'name', header: 'Employee',
      render: (r) => (
        <span className="font-medium">
          {r.name}{r.code ? <span className="ml-2 text-xs text-gray-400">{r.code}</span> : null}
        </span>
      ),
    },
    {
      key: 'elected', header: 'Elected',
      render: (r) => r.elected
        ? <span className="font-medium">{r.elected === 'OLD' ? 'Old' : 'New'}</span>
        : <span className="text-xs text-gray-400">Not elected</span>,
    },
    {
      key: 'effective', header: 'Effective (withheld)',
      render: (r) => (
        <span className="inline-flex items-center gap-1">
          <span className="font-medium">{r.effectiveRegime === 'OLD' ? 'Old' : 'New'}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500">{r.effectiveSource}</span>
        </span>
      ),
    },
    {
      key: 'lock', header: 'Lock',
      render: (r) => r.locked
        ? <StatusBadge status="LOCKED" />
        : <span className="text-xs text-gray-400">Open</span>,
    },
    {
      key: 'actions', header: '',
      render: (r) => (
        <div className="flex items-center justify-end gap-2">
          <ActionButton
            tone={r.locked ? 'neutral' : 'danger'}
            disabled={busyId === `${r.employeeId}:lock`}
            onClick={() => lockOne(r.employeeId, r.locked)}
          >
            {r.locked ? 'Unlock' : 'Lock'}
          </ActionButton>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tax regime"
        subtitle="Set the employer default regime + election window, and see each employee's elected vs effective regime. Un-elected employees are withheld under the default. Locking freezes the election for the year."
        actions={
          <PrimaryButton onClick={lockAll} loading={busyId === 'all:lock'}>
            Lock all for FY {fy}
          </PrimaryButton>
        }
      />

      {error && <ErrorBanner message={error} />}

      <PolicyPanel fy={fy} policy={policy} defaultRegime={defaultRegime} onSaved={loadList} onError={setError} />

      <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-900">
            Per-employee regime <InfoTip text="Elected = the employee's own choice. Effective = what their TDS is actually computed under (elected, else the employer default). Source ELECTED/DEFAULT/STATUTORY tells you which." />
          </h2>
        </div>
        <div className="max-w-md">
          <EmployeeSearchSelect
            label="Find an employee"
            tip="Filter the table to one employee (name, code or email)."
            onSelect={(emp) => { setPage(1); setQ(emp ? (emp.code || emp.firstName || '') : ''); }}
            placeholder="Search by name, code or email…"
          />
        </div>
        {loading ? <Spinner /> : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.employeeId}
              emptyText="No India employees match."
            />
            <ServerPagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
              noun="employees"
            />
          </>
        )}
      </div>
    </div>
  );
}

// The per-FY policy: default regime + election window + global lock.
function PolicyPanel({ fy, policy, defaultRegime, onSaved, onError }) {
  const [dr, setDr] = useState(defaultRegime || 'NEW');
  const [openFrom, setOpenFrom] = useState(dateInput(policy?.electionOpenFrom));
  const [lockDate, setLockDate] = useState(dateInput(policy?.electionLockDate));
  const [lockedGlobally, setLockedGlobally] = useState(!!policy?.lockedGlobally);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    setDr(policy?.defaultRegime || defaultRegime || 'NEW');
    setOpenFrom(dateInput(policy?.electionOpenFrom));
    setLockDate(dateInput(policy?.electionLockDate));
    setLockedGlobally(!!policy?.lockedGlobally);
  }, [policy, defaultRegime]);

  async function save() {
    setSaving(true);
    setSavedOk(false);
    try {
      await put('/api/hr/tax/regime-policy', {
        fy,
        defaultRegime: dr,
        electionOpenFrom: openFrom || null,
        electionLockDate: lockDate || null,
        lockedGlobally,
      });
      setSavedOk(true);
      onSaved?.();
    } catch (e) {
      onError?.(e.data?.message || e.message || 'Failed to save policy.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">
          Employer policy — FY {fy} <InfoTip text="The default an un-elected employee is withheld under, plus the window in which employees may self-elect. Saving updates the resolver immediately." />
        </h2>
        {policy?.exists ? <span className="text-xs text-gray-400">Updated {formatAdminDate(policy.updatedAt)}</span> : <span className="text-xs text-gray-400">No policy yet — defaults to New</span>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Default regime <InfoTip text="What an employee who has NOT elected is withheld under. Statutory default is New." />
          </label>
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
            {['NEW', 'OLD'].map((r) => (
              <button
                key={r} type="button" onClick={() => setDr(r)}
                className={`px-4 py-2 text-sm font-medium ${dr === r ? 'bg-[color:var(--theme-primary)] text-white' : 'bg-white text-gray-700'}`}
              >
                {r === 'NEW' ? 'New' : 'Old'}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm pt-1">
          <input type="checkbox" checked={lockedGlobally} onChange={(e) => setLockedGlobally(e.target.checked)} className="mt-0.5" />
          <span>
            <span className="font-medium text-gray-700">Lock all elections (global)</span>
            <span className="block text-xs text-gray-400">Hard freeze: no employee may elect for FY {fy}.</span>
          </span>
        </label>

        <DateField label="Election opens" value={openFrom} onChange={setOpenFrom} hint="Employees may self-elect on/after this date (blank = always open)." />
        <DateField label="Election locks" value={lockDate} onChange={setLockDate} hint="Self-election is rejected on/after this date (blank = no deadline)." />
      </div>

      <div className="flex items-center gap-3">
        <PrimaryButton onClick={save} loading={saving}>Save policy</PrimaryButton>
        {savedOk && <span className="text-sm text-green-600">Saved.</span>}
      </div>
    </div>
  );
}
