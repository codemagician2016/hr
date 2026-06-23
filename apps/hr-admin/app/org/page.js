'use client';

// Org structure: legal entities + departments. Each section lists records from
// GET /api/hr/org/{entities,departments} and offers an inline create form POSTing
// back to the same endpoint, then refreshing the list.
//
// Entities have a richer required shape than departments (legalName + country +
// pay currency + timezone — the controller's allow-list), so they get a dedicated
// EntitySection. Departments stay on the generic OrgSection (name + code).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Spinner, ErrorBanner, Empty, PrimaryButton, TextInput } from '@hr/ui';
import { get, post } from '@/lib/api';

function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

function SelectField({ label, value, onChange, options, required }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm bg-white"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// The two markets DriftHR ships for. Picking a country pre-fills a sensible pay
// currency + timezone so the operator rarely has to touch them.
const COUNTRIES = [
  { value: 'IN', label: 'India', payCurrency: 'INR', timezone: 'Asia/Kolkata' },
  { value: 'NZ', label: 'New Zealand', payCurrency: 'NZD', timezone: 'Pacific/Auckland' },
];
const CURRENCIES = [
  { value: 'INR', label: 'INR — Indian Rupee' },
  { value: 'NZD', label: 'NZD — New Zealand Dollar' },
];
const TIMEZONES = [
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland (NZST)' },
];

const EMPTY_ENTITY = { legalName: '', tradeName: '', code: '', countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata' };

function EntitySection() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_ENTITY);

  const load = useCallback(async () => {
    setError('');
    try {
      setRows(asList(await get('/api/hr/org/entities')));
    } catch (err) {
      setError(err.message || 'Failed to load entities.');
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function set(key, val) {
    setDraft((d) => {
      const next = { ...d, [key]: val };
      // Picking a country pre-fills currency + timezone (operator can override).
      if (key === 'countryCode') {
        const c = COUNTRIES.find((x) => x.value === val);
        if (c) {
          next.payCurrency = c.payCurrency;
          next.timezone = c.timezone;
        }
      }
      return next;
    });
  }

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // Send exactly the controller's allow-list (legalName/code/countryCode/
      // payCurrency/timezone + optional tradeName). Drop empty optionals.
      const payload = {
        legalName: draft.legalName.trim(),
        code: draft.code.trim(),
        countryCode: draft.countryCode,
        payCurrency: draft.payCurrency,
        timezone: draft.timezone,
      };
      if (draft.tradeName.trim()) payload.tradeName = draft.tradeName.trim();
      await post('/api/hr/org/entities', payload);
      setDraft(EMPTY_ENTITY);
      setOpen(false);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to create entity.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900">Legal entities</h2>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-sm font-medium text-[color:var(--theme-primary)] hover:underline"
          >
            + Add entity
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="mb-4">
        {rows === null ? (
          <div className="py-4">
            <Spinner small />
          </div>
        ) : rows.length === 0 ? (
          <Empty text="No legal entities yet. Add one to start hiring." />
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r) => (
              <li key={r.id} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm text-gray-900 truncate block">{r.legalName}</span>
                  {r.tradeName && r.tradeName !== r.legalName && (
                    <span className="text-xs text-gray-400">{r.tradeName}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0 text-xs">
                  <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-gray-600">
                    {r.countryCode} · {r.payCurrency}
                  </span>
                  {r.code && <span className="text-gray-400 font-mono">{r.code}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <form onSubmit={onCreate} className="border-t border-gray-100 pt-4 space-y-3">
          <TextInput
            label="Legal name"
            value={draft.legalName}
            onChange={(v) => set('legalName', v)}
            required
            hint="The registered legal name of the entity."
          />
          <div className="grid grid-cols-2 gap-3">
            <TextInput label="Trade name" value={draft.tradeName} onChange={(v) => set('tradeName', v)} hint="Optional" />
            <TextInput label="Code" value={draft.code} onChange={(v) => set('code', v)} required hint="e.g. IN-HQ" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <SelectField
              label="Country"
              value={draft.countryCode}
              onChange={(v) => set('countryCode', v)}
              options={COUNTRIES.map((c) => ({ value: c.value, label: c.label }))}
              required
            />
            <SelectField
              label="Pay currency"
              value={draft.payCurrency}
              onChange={(v) => set('payCurrency', v)}
              options={CURRENCIES}
              required
            />
            <SelectField
              label="Timezone"
              value={draft.timezone}
              onChange={(v) => set('timezone', v)}
              options={TIMEZONES}
              required
            />
          </div>
          <div className="flex gap-2 pt-1">
            <PrimaryButton type="submit" loading={saving}>
              Add entity
            </PrimaryButton>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setDraft(EMPTY_ENTITY);
                setError('');
              }}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function OrgSection({ title, resource, fields, displayKey = 'name' }) {
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
          <div className="py-4">
            <Spinner small />
          </div>
        ) : rows.length === 0 ? (
          <Empty text={`No ${title.toLowerCase()} yet.`} />
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r) => (
              <li key={r.id} className="py-2 flex items-center justify-between">
                <span className="text-sm text-gray-900">{r[displayKey]}</span>
                {r.code && <span className="text-xs text-gray-400 font-mono">{r.code}</span>}
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
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Org structure</h1>
          <p className="text-sm text-gray-500">Legal entities and departments</p>
        </div>
        <Link
          href="/org/chart"
          className="shrink-0 px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center"
        >
          View org chart
        </Link>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <EntitySection />
        <OrgSection
          title="Departments"
          resource="departments"
          fields={[
            { key: 'name', label: 'Department name', required: true },
            { key: 'code', label: 'Code', required: true },
          ]}
        />
      </div>
    </div>
  );
}
