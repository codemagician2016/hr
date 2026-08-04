'use client';

// Org structure: legal entities, departments, designations, grades and locations.
// Each section lists records from GET /api/hr/org/{entities,departments,
// designations,grades,locations} and offers an inline create form POSTing back to
// the same endpoint, plus per-row edit (PATCH /api/hr/org/{resource}/{id}) and
// delete (DELETE /api/hr/org/{resource}/{id}), refreshing the list after.
//
// Every section carries a stable `id` so the setup guide (and the compliance
// screens) can deep-link to one of them — /org#grades lands on Grades rather
// than the top of the page. scroll-mt keeps the anchor clear of page chrome.
//
// Entities have a richer required shape than departments/designations
// (legalName + country + pay currency + timezone — the controller's allow-list),
// so they get a dedicated EntitySection. Departments and designations share the
// generic OrgSection (name/title + code). Locations need an entity picker plus
// country + timezone (the backend requires entityId/code/name/countryCode/
// timezone and country-locks to the tenant), so they get a dedicated
// LocationSection.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Spinner, ErrorBanner, Empty, PrimaryButton, TextInput, Modal, ModalActions } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import ModuleGuide from '@/components/ModuleGuide';

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

// Inline per-row actions (Edit / Delete) shared by every section. Delete runs a
// confirm() first; both call back into the section to refresh the list.
function RowActions({ onEdit, onDelete, deleting }) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        onClick={onEdit}
        className="text-xs font-medium text-[color:var(--theme-primary)] hover:underline"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
      >
        {deleting ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  );
}

// DriftHR ships single-country India (Feature 14): a tenant only ever creates IN
// entities/locations. Picking a country pre-fills a sensible pay currency +
// timezone so the operator rarely has to touch them.
const COUNTRIES = [
  { value: 'IN', label: 'India', payCurrency: 'INR', timezone: 'Asia/Kolkata' },
];
const CURRENCIES = [
  { value: 'INR', label: 'INR — Indian Rupee' },
];
const TIMEZONES = [
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata (IST)' },
];

const EMPTY_ENTITY = { legalName: '', tradeName: '', code: '', countryCode: 'IN', payCurrency: 'INR', timezone: 'Asia/Kolkata' };

// Hoisted to module scope. If this lived inside EntitySection it would be a NEW
// function identity on every render, so React would unmount/remount the inputs
// on each keystroke — the field would lose focus after one character.
function EntityFields({ value, onChange }) {
  return (
    <>
      <TextInput
        label="Legal name"
        value={value.legalName}
        onChange={(v) => onChange('legalName', v)}
        required
        hint="The registered legal name of the entity."
      />
      <div className="grid grid-cols-2 gap-3">
        <TextInput label="Trade name" value={value.tradeName} onChange={(v) => onChange('tradeName', v)} hint="Optional" />
        <TextInput label="Code" value={value.code} onChange={(v) => onChange('code', v)} required hint="e.g. IN-HQ" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <SelectField
          label="Country"
          value={value.countryCode}
          onChange={(v) => onChange('countryCode', v)}
          options={COUNTRIES.map((c) => ({ value: c.value, label: c.label }))}
          required
        />
        <SelectField
          label="Pay currency"
          value={value.payCurrency}
          onChange={(v) => onChange('payCurrency', v)}
          options={CURRENCIES}
          required
        />
        <SelectField
          label="Timezone"
          value={value.timezone}
          onChange={(v) => onChange('timezone', v)}
          options={TIMEZONES}
          required
        />
      </div>
    </>
  );
}

function EntitySection() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_ENTITY);
  // editId: row being edited (null = none); editDraft holds its working copy.
  const [editId, setEditId] = useState(null);
  const [editDraft, setEditDraft] = useState(EMPTY_ENTITY);
  const [deletingId, setDeletingId] = useState(null);

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

  // Country picker pre-fills currency + timezone for whichever draft is active.
  function applyCountry(next, key, val) {
    if (key === 'countryCode') {
      const c = COUNTRIES.find((x) => x.value === val);
      if (c) {
        next.payCurrency = c.payCurrency;
        next.timezone = c.timezone;
      }
    }
    return next;
  }

  function set(key, val) {
    setDraft((d) => applyCountry({ ...d, [key]: val }, key, val));
  }
  function setEdit(key, val) {
    setEditDraft((d) => applyCountry({ ...d, [key]: val }, key, val));
  }

  // Build exactly the controller's allow-list (legalName/code/countryCode/
  // payCurrency/timezone + optional tradeName). On edit, send tradeName even
  // when blank so a previously-set value can be cleared.
  function buildPayload(d) {
    const payload = {
      legalName: d.legalName.trim(),
      code: d.code.trim(),
      countryCode: d.countryCode,
      payCurrency: d.payCurrency,
      timezone: d.timezone,
      tradeName: (d.tradeName || '').trim(),
    };
    return payload;
  }

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = buildPayload(draft);
      if (!payload.tradeName) delete payload.tradeName; // drop empty optional on create
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

  function startEdit(r) {
    setEditId(r.id);
    setEditDraft({
      legalName: r.legalName || '',
      tradeName: r.tradeName || '',
      code: r.code || '',
      countryCode: r.countryCode || 'IN',
      payCurrency: r.payCurrency || 'INR',
      timezone: r.timezone || 'Asia/Kolkata',
    });
    setError('');
  }

  async function onSaveEdit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await patch(`/api/hr/org/entities/${editId}`, buildPayload(editDraft));
      setEditId(null);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to update entity.');
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(r) {
    if (!confirm(`Delete entity "${r.legalName}"? This cannot be undone.`)) return;
    setDeletingId(r.id);
    setError('');
    try {
      await del(`/api/hr/org/entities/${r.id}`);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to delete entity.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div id="entities" className="scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-5">
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
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-gray-600">
                    {r.countryCode} · {r.payCurrency}
                  </span>
                  {r.code && <span className="text-gray-400 font-mono">{r.code}</span>}
                  {/* EPFO / ESIC / PT / TAN numbers are held per entity — the
                      compliance calendar and every statutory register are seeded
                      from them, so the link belongs on the entity itself. */}
                  <Link
                    href={`/org/registrations?entityId=${encodeURIComponent(r.id)}`}
                    className="font-medium text-[color:var(--theme-primary-dark)] hover:underline"
                  >
                    Registrations
                  </Link>
                  <RowActions onEdit={() => startEdit(r)} onDelete={() => onDelete(r)} deleting={deletingId === r.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <form onSubmit={onCreate} className="border-t border-gray-100 pt-4 space-y-3">
          <EntityFields value={draft} onChange={set} />
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

      {editId && (
        <Modal title="Edit entity" onClose={() => { setEditId(null); setError(''); }}>
          <form onSubmit={onSaveEdit} className="space-y-3">
            {error && <ErrorBanner message={error} />}
            <EntityFields value={editDraft} onChange={setEdit} />
            <ModalActions>
              <button
                type="button"
                onClick={() => { setEditId(null); setError(''); }}
                className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <PrimaryButton type="submit" loading={saving}>
                Save changes
              </PrimaryButton>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  );
}

// Generic section for flat resources (departments, designations, grades) whose
// records are a set of scalar fields. displayKey is the primary label field
// (name/title). A field may declare `type: 'number'` (Grade.rank) — the org CRUD
// controller hands the body straight to Prisma, so an Int column has to receive
// a real number, never the "3" a text input would produce.
// Supports create + per-row edit + delete against /api/hr/org/{resource}[/:id].
function OrgSection({ id, title, resource, fields, displayKey = 'name', subtitle, secondary }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const emptyDraft = () => Object.fromEntries(fields.map((f) => [f.key, '']));
  const [draft, setDraft] = useState(emptyDraft);
  const [editId, setEditId] = useState(null);
  const [editDraft, setEditDraft] = useState(emptyDraft);
  const [deletingId, setDeletingId] = useState(null);

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
  function setEditField(key, val) {
    setEditDraft((d) => ({ ...d, [key]: val }));
  }

  const numericKeys = new Set(fields.filter((f) => f.type === 'number').map((f) => f.key));

  // On create drop empty fields so the backend applies its own defaults; on edit
  // keep empties so a previously-set optional can be cleared. A numeric field is
  // the exception both ways: it is coerced to a Number, and a blank one is always
  // dropped — you cannot clear a non-nullable Int by sending "".
  function buildPayload(d, { keepEmpty } = {}) {
    const out = {};
    for (const [k, raw] of Object.entries(d)) {
      const v = typeof raw === 'string' ? raw.trim() : raw;
      if (numericKeys.has(k)) {
        const n = Number(v);
        if (v !== '' && Number.isFinite(n)) out[k] = n;
        continue;
      }
      if (v !== '' || keepEmpty) out[k] = v;
    }
    return out;
  }

  async function onCreate(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await post(`/api/hr/org/${resource}`, buildPayload(draft));
      setDraft(emptyDraft());
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to create.');
    } finally {
      setSaving(false);
    }
  }

  function startEdit(r) {
    setEditId(r.id);
    setEditDraft(Object.fromEntries(fields.map((f) => [f.key, r[f.key] ?? ''])));
    setError('');
  }

  async function onSaveEdit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await patch(`/api/hr/org/${resource}/${editId}`, buildPayload(editDraft, { keepEmpty: true }));
      setEditId(null);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to update.');
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(r) {
    if (!confirm(`Delete "${r[displayKey]}"? This cannot be undone.`)) return;
    setDeletingId(r.id);
    setError('');
    try {
      await del(`/api/hr/org/${resource}/${r.id}`);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to delete.');
    } finally {
      setDeletingId(null);
    }
  }

  const singular = title.replace(/s$/, '').toLowerCase();

  return (
    <div id={id} className="scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-5">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
      </div>

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
              <li key={r.id} className="py-2 flex items-center justify-between gap-3">
                <span className="text-sm text-gray-900 truncate">{r[displayKey]}</span>
                <div className="flex items-center gap-3 shrink-0">
                  {secondary && secondary(r) && (
                    <span className="text-xs text-gray-500">{secondary(r)}</span>
                  )}
                  {r.code && <span className="text-xs text-gray-400 font-mono">{r.code}</span>}
                  <RowActions onEdit={() => startEdit(r)} onDelete={() => onDelete(r)} deleting={deletingId === r.id} />
                </div>
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
            type={f.type}
            min={f.min}
            hint={f.hint}
          />
        ))}
        <PrimaryButton type="submit" loading={saving}>
          Add {singular}
        </PrimaryButton>
      </form>

      {editId && (
        <Modal title={`Edit ${singular}`} onClose={() => { setEditId(null); setError(''); }}>
          <form onSubmit={onSaveEdit} className="space-y-3">
            {error && <ErrorBanner message={error} />}
            {fields.map((f) => (
              <TextInput
                key={f.key}
                label={f.label}
                value={editDraft[f.key]}
                onChange={(v) => setEditField(f.key, v)}
                required={f.required}
                type={f.type}
                min={f.min}
                hint={f.hint}
              />
            ))}
            <ModalActions>
              <button
                type="button"
                onClick={() => { setEditId(null); setError(''); }}
                className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <PrimaryButton type="submit" loading={saving}>
                Save changes
              </PrimaryButton>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  );
}

// Locations need an entity to attach to plus a country + timezone. The backend
// requires entityId/code/name/countryCode/timezone and country-locks the create
// to the tenant (Feature 14), so country/timezone are fixed to the single
// supported country here. The entity picker is populated from
// /api/hr/org/entities — a fresh tenant must create an entity first.
const EMPTY_LOCATION = { entityId: '', code: '', name: '', city: '', countryCode: 'IN', timezone: 'Asia/Kolkata' };

// Hoisted to module scope (see EntityFields note). entityOptions is passed in as
// a prop because it derives from LocationSection's own state.
function LocationFields({ value, onChange, entityOptions }) {
  return (
    <>
      <SelectField
        label="Legal entity"
        value={value.entityId}
        onChange={(v) => onChange('entityId', v)}
        options={entityOptions}
        required
      />
      <div className="grid grid-cols-2 gap-3">
        <TextInput label="Location name" value={value.name} onChange={(v) => onChange('name', v)} required hint="e.g. Bangalore HQ" />
        <TextInput label="Code" value={value.code} onChange={(v) => onChange('code', v)} required hint="e.g. BLR" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <TextInput label="City" value={value.city} onChange={(v) => onChange('city', v)} hint="Optional" />
        <SelectField
          label="Country"
          value={value.countryCode}
          onChange={(v) => onChange('countryCode', v)}
          options={COUNTRIES.map((c) => ({ value: c.value, label: c.label }))}
          required
        />
        <SelectField
          label="Timezone"
          value={value.timezone}
          onChange={(v) => onChange('timezone', v)}
          options={TIMEZONES}
          required
        />
      </div>
    </>
  );
}

function LocationSection() {
  const [rows, setRows] = useState(null);
  const [entities, setEntities] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_LOCATION);
  const [editId, setEditId] = useState(null);
  const [editDraft, setEditDraft] = useState(EMPTY_LOCATION);
  const [deletingId, setDeletingId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [locs, ents] = await Promise.all([
        get('/api/hr/org/locations'),
        get('/api/hr/org/entities').catch(() => ({ items: [] })),
      ]);
      setRows(asList(locs));
      setEntities(asList(ents));
    } catch (err) {
      setError(err.message || 'Failed to load locations.');
      setRows([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function set(key, val) {
    setDraft((d) => ({ ...d, [key]: val }));
  }
  function setEdit(key, val) {
    setEditDraft((d) => ({ ...d, [key]: val }));
  }

  // Send the backend's required shape (entityId/code/name/countryCode/timezone)
  // plus the optional city. On edit keep city (even when blank) so a stray value
  // can be cleared; drop it on create when empty.
  function buildPayload(d, { keepEmpty } = {}) {
    const payload = {
      entityId: d.entityId,
      code: (d.code || '').trim(),
      name: (d.name || '').trim(),
      countryCode: d.countryCode,
      timezone: d.timezone,
    };
    const city = (d.city || '').trim();
    if (city || keepEmpty) payload.city = city;
    return payload;
  }

  // entityId is required and has no sensible default — guard before posting so
  // the operator gets a clear message instead of a backend 400.
  function requireEntity(d) {
    if (!d.entityId) {
      setError('Pick a legal entity for this location first (create one above if none exist).');
      return false;
    }
    return true;
  }

  async function onCreate(e) {
    e.preventDefault();
    if (!requireEntity(draft)) return;
    setSaving(true);
    setError('');
    try {
      await post('/api/hr/org/locations', buildPayload(draft));
      setDraft(EMPTY_LOCATION);
      setOpen(false);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to create location.');
    } finally {
      setSaving(false);
    }
  }

  function startEdit(r) {
    setEditId(r.id);
    setEditDraft({
      entityId: r.entityId || '',
      code: r.code || '',
      name: r.name || '',
      city: r.city || '',
      countryCode: r.countryCode || 'IN',
      timezone: r.timezone || 'Asia/Kolkata',
    });
    setError('');
  }

  async function onSaveEdit(e) {
    e.preventDefault();
    if (!requireEntity(editDraft)) return;
    setSaving(true);
    setError('');
    try {
      await patch(`/api/hr/org/locations/${editId}`, buildPayload(editDraft, { keepEmpty: true }));
      setEditId(null);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to update location.');
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(r) {
    if (!confirm(`Delete location "${r.name}"? This cannot be undone.`)) return;
    setDeletingId(r.id);
    setError('');
    try {
      await del(`/api/hr/org/locations/${r.id}`);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to delete location.');
    } finally {
      setDeletingId(null);
    }
  }

  const entityName = (id) => {
    const e = entities.find((x) => x.id === id);
    return e ? (e.tradeName || e.legalName) : '';
  };

  const entityOptions = [
    { value: '', label: entities.length ? 'Select an entity…' : 'No entities — create one first' },
    ...entities.map((e) => ({ value: e.id, label: e.tradeName || e.legalName })),
  ];

  return (
    <div id="locations" className="scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900">Locations</h2>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-sm font-medium text-[color:var(--theme-primary)] hover:underline"
          >
            + Add location
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
          <Empty text="No locations yet." />
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r) => (
              <li key={r.id} className="py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm text-gray-900 truncate block">{r.name}</span>
                  {r.entityId && <span className="text-xs text-gray-400">{entityName(r.entityId)}</span>}
                </div>
                <div className="flex items-center gap-3 shrink-0 text-xs">
                  {r.code && <span className="text-gray-400 font-mono">{r.code}</span>}
                  <RowActions onEdit={() => startEdit(r)} onDelete={() => onDelete(r)} deleting={deletingId === r.id} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <form onSubmit={onCreate} className="border-t border-gray-100 pt-4 space-y-3">
          <LocationFields value={draft} onChange={set} entityOptions={entityOptions} />
          <div className="flex gap-2 pt-1">
            <PrimaryButton type="submit" loading={saving}>
              Add location
            </PrimaryButton>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setDraft(EMPTY_LOCATION);
                setError('');
              }}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {editId && (
        <Modal title="Edit location" onClose={() => { setEditId(null); setError(''); }}>
          <form onSubmit={onSaveEdit} className="space-y-3">
            {error && <ErrorBanner message={error} />}
            <LocationFields value={editDraft} onChange={setEdit} entityOptions={entityOptions} />
            <ModalActions>
              <button
                type="button"
                onClick={() => { setEditId(null); setError(''); }}
                className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <PrimaryButton type="submit" loading={saving}>
                Save changes
              </PrimaryButton>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  );
}

export default function OrgPage() {
  // The sections paint before their rows arrive, so the browser's own hash
  // scroll usually lands correctly — but a client-side <Link> carrying a hash
  // (the setup guide's /org#grades) doesn't always trigger it. Re-assert it once
  // on mount so a deep link never dumps the operator at the top of the page.
  useEffect(() => {
    const hash = typeof window === 'undefined' ? '' : window.location.hash.slice(1);
    if (!hash) return;
    const target = document.getElementById(hash);
    if (target) target.scrollIntoView({ block: 'start' });
  }, []);

  return (
    <div>
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-1">Org structure</h1>
          <p className="text-sm text-gray-500">Legal entities, departments, designations and locations</p>
        </div>
        <Link
          href="/org/chart"
          className="shrink-0 px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center"
        >
          View org chart
        </Link>
      </div>

      <ModuleGuide
        id="org"
        title="Set up your org structure"
        what="This is the backbone every other DriftHR module reads from: the legal entities you run payroll under, plus the departments, designations, pay grades and work locations you slot employees into. Get it right once and hiring, payroll, PF/ESI registers and the org chart all line up."
        steps={[
          "Add a legal entity first (legal name, code, country IN, pay currency INR, Asia/Kolkata) — nothing else can be created until one exists.",
          "Add departments (e.g. Engineering, Finance) and designations (e.g. Senior Engineer) with short codes for reuse across the org.",
          "Add grades (your pay levels) — the Level number is what per-grade expense caps and the travel hotel matrix compare on.",
          "Add locations, picking the legal entity each one belongs to plus its city and code.",
          "Open Registrations on an entity to record its EPFO / ESIC / PT / TAN numbers — the compliance calendar and statutory registers are built from them.",
          "Use Edit / Delete on any row to correct a record; open View org chart to see the reporting tree.",
        ]}
        example={<>Onboarding <b>Acme India Pvt Ltd</b>: create the entity (code <b>IN-HQ</b>, INR, Asia/Kolkata), add departments <b>Engineering</b> and <b>Finance</b>, the designation <b>Senior Engineer</b>, then a location <b>Bangalore HQ</b> (code <b>BLR</b>). Now <b>Aarav Sharma</b> on ₹18,00,000 CTC can be hired into Engineering at Bangalore HQ.</>}
        tips={[
          "Locations need an entity to attach to — if the picker says 'No entities', add a legal entity above first.",
          "Codes (IN-HQ, BLR) flow into payroll registers and Form 24Q output, so keep them stable once employees are mapped.",
        ]}
      />

      <div className="grid md:grid-cols-2 gap-4">
        <EntitySection />
        <OrgSection
          id="departments"
          title="Departments"
          resource="departments"
          fields={[
            { key: 'name', label: 'Department name', required: true },
            { key: 'code', label: 'Code', required: true },
          ]}
        />
        <OrgSection
          id="designations"
          title="Designations"
          resource="designations"
          displayKey="title"
          fields={[
            { key: 'title', label: 'Designation title', required: true },
            { key: 'code', label: 'Code', required: true },
          ]}
        />
        {/* Grades have had backend CRUD since Feature 5 but no screen, which left
            ExpenseGradeRule.gradeRank and TravelHotelRule.gradeRank impossible to
            configure end-to-end: per-level expense caps and the travel hotel matrix
            key off Grade.rank. Lowest rank = most junior. */}
        <OrgSection
          id="grades"
          title="Grades"
          subtitle="Your pay levels, from junior to senior. Expense and travel limits are set per level."
          resource="grades"
          secondary={(r) => (r.rank == null ? '' : `Level ${r.rank}`)}
          fields={[
            { key: 'name', label: 'Grade name', required: true, hint: 'e.g. L3 — Senior Engineer' },
            { key: 'code', label: 'Code', required: true, hint: 'e.g. L3' },
            { key: 'rank', label: 'Level', required: true, type: 'number', min: 1, hint: 'A whole number — 1 is the most junior. Expense and travel caps compare on this.' },
          ]}
        />
        <LocationSection />
      </div>
    </div>
  );
}
