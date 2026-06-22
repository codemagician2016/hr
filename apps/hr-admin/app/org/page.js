'use client';

// Org structure: legal entities + departments. Each section lists records
// from GET /api/hr/org/{entities,departments} and has an inline create form
// POSTing back to the same endpoint, then refreshing the list. Kept generic
// via OrgSection so adding more org types (designations, locations, grades,
// bands) later is a one-line addition.

import { useCallback, useEffect, useState } from 'react';
import { Spinner, ErrorBanner, Empty, PrimaryButton, TextInput } from '@hr/ui';
import { get, post } from '@/lib/api';

function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

function OrgSection({ title, resource, fields }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map((f) => [f.key, ''])));

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await get(`/api/hr/org/${resource}`);
      setRows(asList(res));
    } catch (err) {
      setError(err.message || `Failed to load ${title.toLowerCase()}.`);
      setRows([]);
    }
  }, [resource, title]);

  useEffect(() => {
    load();
  }, [load]);

  function setField(key, val) {
    setDraft((d) => ({ ...d, [key]: val }));
  }

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== ''));
      await post(`/api/hr/org/${resource}`, payload);
      setDraft(Object.fromEntries(fields.map((f) => [f.key, ''])));
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to create.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-4">{title}</h2>

      {error && <ErrorBanner message={error} />}

      <div className="mb-4">
        {rows === null ? (
          <Spinner small />
        ) : rows.length === 0 ? (
          <Empty text={`No ${title.toLowerCase()} yet.`} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r) => (
              <li key={r.id} className="py-2 flex items-center justify-between">
                <span className="text-sm text-gray-900">{r.name}</span>
                {r.code && <span className="text-xs text-gray-400">{r.code}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={onCreate} className="border-t border-gray-100 pt-4 space-y-3">
        {fields.map((f) => (
          <TextInput
            key={f.key}
            label={f.label}
            value={draft[f.key]}
            onChange={(v) => setField(f.key, v)}
            required={f.required}
          />
        ))}
        <PrimaryButton type="submit" loading={saving}>
          Add {title.replace(/s$/, '').toLowerCase()}
        </PrimaryButton>
      </form>
    </div>
  );
}

export default function OrgPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 mb-1">Org structure</h1>
      <p className="text-sm text-gray-500 mb-6">Legal entities and departments</p>

      <div className="grid md:grid-cols-2 gap-4">
        <OrgSection
          title="Entities"
          resource="entities"
          fields={[
            { key: 'name', label: 'Entity name', required: true },
            { key: 'code', label: 'Code' },
          ]}
        />
        <OrgSection
          title="Departments"
          resource="departments"
          fields={[
            { key: 'name', label: 'Department name', required: true },
            { key: 'code', label: 'Code' },
          ]}
        />
      </div>
    </div>
  );
}
