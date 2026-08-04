'use client';

// Org → Entity registrations. The EPFO / ESIC / professional-tax / TAN numbers a
// company files under, held per legal entity.
//
// This screen closes a real gap rather than adding a feature: StatutoryRegistration
// was already read by the compliance calendar (calendarRunner seeds every
// obligation FROM these rows) and by the statutory registers, and
// /payroll/compliance has been telling operators to "add your EPFO / ESIC / PT /
// TAN registrations under Entity → Registrations" — a screen that did not exist.
// Without a row here the filing calendar is permanently empty, which reads as a
// broken product rather than as missing input.
//
// CRUD against /api/hr/statutory-registrations (read: canViewPayrollReports OR
// canManageStatutory; write: canManageStatutory — the server is the real
// boundary, this page just hides the controls). Deactivate is SOFT: the row is
// the applicability record behind obligations that have already been generated.
//
// Deliberately NOT in the left nav — it is reached from the Registrations link on
// each entity row in /org and from the setup guide's deep link.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, Spinner, TextInput, DateField, formatAdminDate } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { asList, DataTable, PageHeader, ActionButton } from '@/lib/ui';
import { FieldLabel, InfoTip } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

// Mirrors RegistrationKind in the schema, split by the country it belongs to —
// the same split the controller enforces, so we never offer a type the server
// will 422. PT and LWF are state levies and carry a state code.
const KINDS = {
  IN: [
    { value: 'EPF', label: 'Provident Fund (EPFO)', hint: 'Your EPFO establishment code, e.g. KNBNG1234567. Drives the monthly ECR filing and PF registers.' },
    { value: 'ESI', label: 'ESI (ESIC)', hint: 'Your 17-digit ESIC employer code. Drives the monthly ESI contribution return.' },
    { value: 'PT_STATE', label: 'Professional tax', hint: 'Your PT registration for one state. Add one row per state you employ people in.' },
    { value: 'TAN', label: 'TAN (TDS)', hint: 'Your 10-character TAN. Required before you can deposit TDS or file Form 24Q.' },
    { value: 'LWF', label: 'Labour Welfare Fund', hint: 'Your LWF registration for one state, where the state operates a fund.' },
    { value: 'SHOPS_ESTABLISHMENT', label: 'Shops & Establishment', hint: 'Your S&E registration for the premises. Drives the combined labour register.' },
  ],
  NZ: [
    { value: 'IRD_PAYE', label: 'IRD (PAYE)', hint: 'Your employer IRD number, used on every payday filing.' },
    { value: 'ACC', label: 'ACC', hint: 'Your ACC levy account for this company.' },
  ],
};
const KIND_LABEL = Object.fromEntries(
  [...KINDS.IN, ...KINDS.NZ].map((k) => [k.value, k.label]),
);

// Kinds the server requires a state on (STATE_SCOPED_KINDS in the controller).
const STATE_SCOPED = new Set(['PT_STATE', 'LWF']);

// The types an India tenant is expected to hold. Shown as a "still missing"
// prompt, never as a block — a company with no ESI-eligible staff legitimately
// has no ESI code.
const EXPECTED = { IN: ['EPF', 'ESI', 'PT_STATE', 'TAN'], NZ: ['IRD_PAYE'] };

// State/UT codes as the payroll engine keys them (PT slabs, LWF, S&E registers).
const IN_STATES = [
  ['AP', 'Andhra Pradesh'], ['AR', 'Arunachal Pradesh'], ['AS', 'Assam'], ['BR', 'Bihar'],
  ['CG', 'Chhattisgarh'], ['GA', 'Goa'], ['GJ', 'Gujarat'], ['HR', 'Haryana'],
  ['HP', 'Himachal Pradesh'], ['JK', 'Jammu & Kashmir'], ['JH', 'Jharkhand'], ['KA', 'Karnataka'],
  ['KL', 'Kerala'], ['MP', 'Madhya Pradesh'], ['MH', 'Maharashtra'], ['MN', 'Manipur'],
  ['ML', 'Meghalaya'], ['MZ', 'Mizoram'], ['NL', 'Nagaland'], ['OR', 'Odisha'],
  ['PB', 'Punjab'], ['RJ', 'Rajasthan'], ['SK', 'Sikkim'], ['TN', 'Tamil Nadu'],
  ['TS', 'Telangana'], ['TR', 'Tripura'], ['UP', 'Uttar Pradesh'], ['UK', 'Uttarakhand'],
  ['WB', 'West Bengal'],
  ['AN', 'Andaman & Nicobar'], ['CH', 'Chandigarh'], ['DN', 'Dadra & Nagar Haveli and Daman & Diu'],
  ['DL', 'Delhi'], ['LA', 'Ladakh'], ['LD', 'Lakshadweep'], ['PY', 'Puducherry'],
];

const EMPTY = { kind: '', number: '', stateCode: '', effectiveFrom: '', effectiveTo: '' };

function Select({ label, tip, value, onChange, options, required, disabled, placeholder }) {
  return (
    <div>
      <FieldLabel tip={tip}>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm disabled:bg-gray-50 disabled:text-gray-500"
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function RegistrationForm({ draft, setDraft, kinds, isEdit }) {
  const set = (key, val) => setDraft((d) => ({ ...d, [key]: val }));
  const stateNeeded = STATE_SCOPED.has(draft.kind);
  const kindHint = kinds.find((k) => k.value === draft.kind)?.hint;

  return (
    <div className="space-y-3">
      <Select
        label="Registration type"
        tip="Which authority this number is issued by. The type cannot be changed later — retire the row and add the right one instead."
        value={draft.kind}
        onChange={(v) => set('kind', v)}
        options={kinds.map((k) => ({ value: k.value, label: k.label }))}
        placeholder="Choose a type…"
        required
        disabled={isEdit}
      />
      {kindHint && <p className="-mt-1 text-xs text-gray-600">{kindHint}</p>}

      <TextInput
        label="Registration number"
        value={draft.number}
        onChange={(v) => set('number', v)}
        required
        hint="Exactly as the authority issued it — it prints on filings and challans."
      />

      {stateNeeded && (
        <Select
          label="State"
          tip="Professional tax and Labour Welfare Fund are state levies, so reminders and slabs are matched on the state. Add one row per state you employ people in."
          value={draft.stateCode}
          onChange={(v) => set('stateCode', v)}
          options={IN_STATES.map(([value, name]) => ({ value, label: `${name} (${value})` }))}
          placeholder="Choose a state…"
          required
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <DateField
          label="Effective from"
          value={draft.effectiveFrom}
          onChange={(v) => set('effectiveFrom', v)}
          required
          hint="The date this registration started applying."
        />
        <DateField
          label="Effective to"
          value={draft.effectiveTo}
          onChange={(v) => set('effectiveTo', v)}
          hint="Leave blank while it is still current."
        />
      </div>
    </div>
  );
}

export default function EntityRegistrationsPage() {
  const [entities, setEntities] = useState(null);
  const [entityId, setEntityId] = useState('');
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // null = closed; { id?, ...draft } = open (id present → edit)
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState(EMPTY);

  useEffect(() => {
    get('/api/auth/me')
      .then((me) => setCanManage(hasPermission(permissionsFromSession(me?.user || me), 'canManageStatutory')))
      .catch(() => setCanManage(false));
  }, []);

  // Entities first — the whole screen is scoped to one company, and the setup
  // guide / the /org row link both arrive with ?entityId= already chosen.
  useEffect(() => {
    let alive = true;
    get('/api/hr/org/entities')
      .then((res) => {
        if (!alive) return;
        const list = asList(res);
        setEntities(list);
        const wanted = typeof window === 'undefined'
          ? null
          : new URLSearchParams(window.location.search).get('entityId');
        const initial = list.find((e) => e.id === wanted)?.id || list[0]?.id || '';
        setEntityId(initial);
      })
      .catch((err) => {
        if (!alive) return;
        setEntities([]);
        setError(err.message || 'Failed to load your companies.');
      });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    if (!entityId) { setRows([]); return; }
    setError('');
    try {
      setRows(asList(await get(`/api/hr/statutory-registrations?entityId=${encodeURIComponent(entityId)}`)));
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to load registrations.');
      setRows([]);
    }
  }, [entityId]);

  useEffect(() => { load(); }, [load]);

  const entity = useMemo(() => (entities || []).find((e) => e.id === entityId) || null, [entities, entityId]);
  const country = (entity?.countryCode || 'IN').toUpperCase();
  const kinds = KINDS[country] || KINDS.IN;

  // "What's still missing" — a prompt, not a gate. Only active rows count.
  const missing = useMemo(() => {
    const held = new Set((rows || []).filter((r) => r.isActive).map((r) => r.kind));
    return (EXPECTED[country] || []).filter((k) => !held.has(k));
  }, [rows, country]);

  function openCreate() {
    setDraft(EMPTY);
    setEditing({});
    setError('');
  }

  function openEdit(row) {
    setDraft({
      kind: row.kind,
      number: row.number || '',
      stateCode: row.stateCode || '',
      effectiveFrom: (row.effectiveFrom || '').slice(0, 10),
      effectiveTo: (row.effectiveTo || '').slice(0, 10),
    });
    setEditing({ id: row.id });
    setError('');
  }

  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {
        number: draft.number.trim(),
        // Always send stateCode (even blank) on edit so a stray value can be
        // cleared; the server drops it for entity-wide types.
        stateCode: STATE_SCOPED.has(draft.kind) ? draft.stateCode : '',
        effectiveFrom: draft.effectiveFrom,
        effectiveTo: draft.effectiveTo || null,
      };
      if (editing.id) {
        await patch(`/api/hr/statutory-registrations/${editing.id}`, payload);
      } else {
        await post('/api/hr/statutory-registrations', { ...payload, entityId, kind: draft.kind });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not save that registration.');
    } finally {
      setSaving(false);
    }
  }

  async function onDeactivate(row) {
    if (!confirm(`Stop using the ${KIND_LABEL[row.kind] || row.kind} registration ${row.number}?\n\nIt stays on file for the filings already made against it.`)) return;
    setBusyId(row.id);
    setError('');
    try {
      await del(`/api/hr/statutory-registrations/${row.id}`);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not deactivate that registration.');
    } finally {
      setBusyId(null);
    }
  }

  async function onReactivate(row) {
    setBusyId(row.id);
    setError('');
    try {
      await patch(`/api/hr/statutory-registrations/${row.id}`, { isActive: true });
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not reactivate that registration.');
    } finally {
      setBusyId(null);
    }
  }

  const columns = [
    {
      key: 'kind',
      header: 'Type',
      render: (r) => (
        <span className="font-medium text-gray-900">{KIND_LABEL[r.kind] || r.kind}</span>
      ),
    },
    { key: 'number', header: 'Number', render: (r) => <span className="font-mono text-xs">{r.number}</span> },
    { key: 'stateCode', header: 'State', render: (r) => r.stateCode || '—' },
    { key: 'effectiveFrom', header: 'From', render: (r) => formatAdminDate(r.effectiveFrom) },
    { key: 'effectiveTo', header: 'To', render: (r) => (r.effectiveTo ? formatAdminDate(r.effectiveTo) : 'Current') },
    {
      key: 'isActive',
      header: 'Status',
      render: (r) => (
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
          r.isActive ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-gray-200 bg-gray-50 text-gray-700'
        }`}>
          {r.isActive ? 'In use' : 'Retired'}
        </span>
      ),
    },
  ];

  if (canManage) {
    columns.push({
      key: 'actions',
      header: '',
      render: (r) => (
        <div className="flex items-center justify-end gap-2">
          <ActionButton onClick={() => openEdit(r)}>Edit</ActionButton>
          {r.isActive ? (
            <ActionButton tone="danger" disabled={busyId === r.id} onClick={() => onDeactivate(r)}>
              {busyId === r.id ? 'Working…' : 'Retire'}
            </ActionButton>
          ) : (
            <ActionButton tone="positive" disabled={busyId === r.id} onClick={() => onReactivate(r)}>
              {busyId === r.id ? 'Working…' : 'Reinstate'}
            </ActionButton>
          )}
        </div>
      ),
      className: 'text-right',
      cellClassName: 'text-right',
    });
  }

  return (
    <div className="max-w-5xl">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Entity registrations
            <InfoTip text="The numbers each of your companies is registered under — EPFO, ESIC, professional tax, TAN. Every filing reminder and statutory register is built from these." />
          </span>
        )}
        subtitle="EPFO, ESIC, professional tax and TAN numbers, held per company."
        actions={(
          <Link
            href="/org"
            className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium hover:bg-gray-50"
          >
            Back to Org
          </Link>
        )}
      />

      <ModuleGuide
        id="org-registrations"
        title="Record the numbers you file under"
        what="Each legal entity files under its own registration numbers. DriftHR uses them two ways: the Compliance Calendar decides WHICH reminders apply to you from what you have registered, and the Statutory Registers stamp the right number onto each register. Nothing here changes how pay is computed — it changes what you are reminded to file and what your registers say."
        steps={[
          'Pick the company at the top. Numbers are per company, so a second entity needs its own set.',
          'Add your EPFO code and ESIC code — these turn on the monthly PF (ECR) and ESI reminders.',
          'Add your TAN — required before you can deposit TDS or file Form 24Q.',
          'Add one Professional tax row per state you employ people in; PT is a state levy, so the state is what the reminder matches on.',
          'Then open Compliance Calendar → Schedule settings → Re-derive from registrations to populate your filing calendar.',
        ]}
        example={<>For <b>Acme India Pvt Ltd</b>: EPFO <b>KNBNG1234567</b> from 1 Apr 2024, ESIC <b>31000123450001001</b>, TAN <b>BLRA12345C</b>, and a Professional tax registration for <b>Karnataka (KA)</b>. The calendar then shows PF ECR by the 15th, ESI by the 15th, and Karnataka PT on its own annual cycle.</>}
        tips={[
          "Retire never deletes: the row stays on file because the filings already made against it point at it. Add the replacement as a new row.",
          "The type can't be changed after you save — if you picked the wrong one, retire the row and add the right one.",
        ]}
      />

      {error && <ErrorBanner message={error} />}

      {entities === null ? (
        <div className="py-12 flex justify-center"><Spinner /></div>
      ) : entities.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-600">
          <p className="font-medium text-gray-900">You don’t have a company yet.</p>
          <p className="mt-1">
            Registrations belong to a legal entity, so{' '}
            <Link href="/org#entities" className="font-medium underline decoration-gray-400 underline-offset-2">
              add your registered company
            </Link>{' '}
            first.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-[16rem]">
              <FieldLabel tip="Registrations are held per legal entity — each company files under its own numbers.">
                Company
              </FieldLabel>
              <select
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm"
              >
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>{e.tradeName || e.legalName}</option>
                ))}
              </select>
            </div>
            {canManage && (
              <PrimaryButton onClick={openCreate}>+ Add registration</PrimaryButton>
            )}
          </div>

          {!canManage && (
            <p className="mb-3 text-sm text-gray-600">
              You can see these numbers but not change them — editing needs permission to manage tax and
              statutory details.
            </p>
          )}

          {rows !== null && rows.length > 0 && missing.length > 0 && (
            <p className="mb-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-700">
              Still to add for this company: {missing.map((k) => KIND_LABEL[k] || k).join(', ')}. Add
              anything that applies — a company with no ESI-eligible staff genuinely has no ESI code.
            </p>
          )}

          <DataTable
            columns={columns}
            rows={rows}
            loading={rows === null}
            rowKey={(r) => r.id}
            caption={`Statutory registrations for ${entity?.tradeName || entity?.legalName || 'this company'}`}
            emptyText="No registrations recorded for this company yet."
          />

          {rows !== null && rows.length === 0 && (
            <p className="mt-3 text-sm text-gray-600">
              Until you add these, your Compliance Calendar has nothing to remind you about and your
              statutory registers have no registration number to stamp.
            </p>
          )}
        </>
      )}

      {editing && (
        <Modal
          title={editing.id ? 'Edit registration' : 'Add a registration'}
          onClose={() => { setEditing(null); setError(''); }}
        >
          <form onSubmit={onSubmit} className="space-y-3">
            {error && <ErrorBanner message={error} />}
            <RegistrationForm draft={draft} setDraft={setDraft} kinds={kinds} isEdit={!!editing.id} />
            <ModalActions>
              <button
                type="button"
                onClick={() => { setEditing(null); setError(''); }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50"
              >
                Cancel
              </button>
              <PrimaryButton type="submit" loading={saving}>
                {editing.id ? 'Save changes' : 'Add registration'}
              </PrimaryButton>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  );
}
