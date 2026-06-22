'use client';

// Compensation console against /api/hr/compensation/* (reads need
// canViewCompensation, writes canManageCompensation — enforced backend-side).
//  - Components: GET/POST /components (pay heads: earnings/deductions).
//  - Structures: GET/POST /structures (salary templates).
//  - Revisions:  GET/POST /employees/:employeeId/revisions — effective-dated
//    salary revisions, scoped to one employee entered by id.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, TextInput, DateField, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, moneyish } from '@/lib/ui';

const TABS = [
  { key: 'components', label: 'Pay components' },
  { key: 'structures', label: 'Salary structures' },
  { key: 'revisions', label: 'Employee revisions' },
];

function ConfigTab({ resource, title, fields, columns }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map((f) => [f.key, ''])));

  const load = useCallback(() => {
    setError('');
    get(`/api/hr/compensation/${resource}`, { page: 1, pageSize: 100 })
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.message || `Failed to load ${title.toLowerCase()}.`);
        setRows([]);
      });
  }, [resource, title]);

  useEffect(() => {
    load();
  }, [load]);

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      await post(`/api/hr/compensation/${resource}`, payload);
      setDraft(Object.fromEntries(fields.map((f) => [f.key, ''])));
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to create.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        {error && <ErrorBanner message={error} />}
        <DataTable columns={columns} rows={rows} loading={rows === null} emptyText={`No ${title.toLowerCase()} yet.`} />
      </div>
      <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
        <h2 className="text-sm font-semibold text-gray-900">Add {title.replace(/s$/, '').toLowerCase()}</h2>
        {fields.map((f) => (
          <TextInput
            key={f.key}
            label={f.label}
            value={draft[f.key]}
            onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
            required={f.required}
            placeholder={f.placeholder}
          />
        ))}
        <PrimaryButton type="submit" loading={saving}>
          Save
        </PrimaryButton>
      </form>
    </div>
  );
}

function RevisionsTab() {
  const [employeeId, setEmployeeId] = useState('');
  const [active, setActive] = useState('');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({ effectiveFrom: '', ctcAnnual: '', structureId: '', reason: '' });

  const load = useCallback((id) => {
    if (!id) return;
    setLoading(true);
    setError('');
    get(`/api/hr/compensation/employees/${id}/revisions`)
      .then((r) => setRows(asList(r)))
      .catch((e) => {
        setError(e.message || 'Failed to load revisions.');
        setRows([]);
      })
      .finally(() => setLoading(false));
  }, []);

  function onLookup(e) {
    e.preventDefault();
    const id = employeeId.trim();
    setActive(id);
    setRows(null);
    load(id);
  }

  async function onCreate(e) {
    e.preventDefault();
    if (!active) return;
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      await post(`/api/hr/compensation/employees/${active}/revisions`, payload);
      setDraft({ effectiveFrom: '', ctcAnnual: '', structureId: '', reason: '' });
      load(active);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to create revision.');
    } finally {
      setSaving(false);
    }
  }

  const columns = [
    { key: 'effectiveFrom', header: 'Effective from', render: (r) => formatAdminDate(r.effectiveFrom || r.effectiveDate) },
    { key: 'ctc', header: 'CTC (annual)', render: (r) => moneyish(r.ctcAnnual ?? r.ctc ?? r.annualCtc, r.currencyCode) },
    { key: 'structure', header: 'Structure', render: (r) => r.structure?.name || r.structureName || r.structureId || '—' },
    { key: 'reason', header: 'Reason', render: (r) => r.reason || '—' },
  ];

  return (
    <div>
      <form onSubmit={onLookup} className="flex gap-2 mb-4">
        <input
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          placeholder="Employee ID"
          className="px-4 py-2.5 border border-gray-300 rounded-lg text-sm w-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)]"
        />
        <button type="submit" className="px-4 py-2.5 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">
          Load revisions
        </button>
      </form>

      {error && <ErrorBanner message={error} />}

      {!active ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white py-12 text-center text-sm text-gray-500">
          Enter an employee ID to view and add salary revisions.
        </div>
      ) : (
        <div className="grid lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <DataTable columns={columns} rows={rows} loading={loading} emptyText="No revisions for this employee." />
          </div>
          <form onSubmit={onCreate} className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3 h-fit">
            <h2 className="text-sm font-semibold text-gray-900">New revision</h2>
            <DateField label="Effective from" value={draft.effectiveFrom} onChange={(v) => setDraft((d) => ({ ...d, effectiveFrom: v }))} required />
            <TextInput label="CTC (annual)" type="number" value={draft.ctcAnnual} onChange={(v) => setDraft((d) => ({ ...d, ctcAnnual: v }))} />
            <TextInput label="Structure ID" value={draft.structureId} onChange={(v) => setDraft((d) => ({ ...d, structureId: v }))} />
            <TextInput label="Reason" value={draft.reason} onChange={(v) => setDraft((d) => ({ ...d, reason: v }))} />
            <PrimaryButton type="submit" loading={saving}>
              Save revision
            </PrimaryButton>
          </form>
        </div>
      )}
    </div>
  );
}

export default function CompensationPage() {
  const [tab, setTab] = useState('components');
  return (
    <div>
      <PageHeader title="Compensation" subtitle="Pay components, salary structures and revisions" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'components' && (
        <ConfigTab
          resource="components"
          title="Pay components"
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'code', label: 'Code' },
            { key: 'type', label: 'Type', placeholder: 'EARNING / DEDUCTION' },
          ]}
          columns={[
            { key: 'name', header: 'Component', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
            { key: 'code', header: 'Code', render: (r) => r.code || '—' },
            { key: 'type', header: 'Type', render: (r) => <StatusBadge status={r.type || r.componentType} /> },
            { key: 'taxable', header: 'Taxable', render: (r) => (r.taxable === false ? 'No' : 'Yes') },
          ]}
        />
      )}
      {tab === 'structures' && (
        <ConfigTab
          resource="structures"
          title="Salary structures"
          fields={[
            { key: 'name', label: 'Name', required: true },
            { key: 'code', label: 'Code' },
          ]}
          columns={[
            { key: 'name', header: 'Structure', render: (r) => <span className="font-medium text-gray-900">{r.name}</span> },
            { key: 'code', header: 'Code', render: (r) => r.code || '—' },
            { key: 'lines', header: 'Components', render: (r) => (Array.isArray(r.lines) ? r.lines.length : r.componentCount ?? '—') },
          ]}
        />
      )}
      {tab === 'revisions' && <RevisionsTab />}
    </div>
  );
}
