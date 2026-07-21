'use client';

// Settings → Attendance → Work policies (Program P1.5).
//
// Two consoles over the attendance policy rules, both entity/location scoped
// (blank scope = whole company; the MOST-SPECIFIC active rule wins —
// location beats entity beats company):
//   • Overtime rules       — GET/POST/PATCH/DELETE /api/hr/attendance/overtime-rules
//     OT minutes beyond the daily threshold accrue at the weekday / weekly-off /
//     holiday multipliers, optionally capped per day, rounded to roundingMin.
//   • Late-coming penalties — GET/POST/PATCH/DELETE /api/hr/attendance/late-rules
//     The India-common "first N lates free, then every M further lates deducts a
//     fraction of a day" rule. Applied automatically at attendance recompute;
//     the deduction shows in the muster's LOP.
//
// Reads are canViewEmployees; writes are canManageAttendance (server-gated —
// this page just hides the editors for read-only operators). Scope is fixed at
// creation (the server ignores scope changes on PATCH).

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, TextInput } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { DataTable, PageHeader, ActionButton } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

const PENALTY_FRACTIONS = [
  { value: 0.25, label: '0.25 — quarter day' },
  { value: 0.5, label: '0.5 — half day' },
  { value: 1, label: '1 — full day' },
];

function fractionLabel(v) {
  const n = Number(v);
  if (n === 0.25) return 'a quarter (0.25)';
  if (n === 0.5) return 'half (0.5)';
  if (n === 1) return 'a full (1)';
  return String(n);
}

function scopeLabel(row, entities, locations) {
  const ent = row.entityId ? entities.find((e) => e.id === row.entityId) : null;
  const loc = row.locationId ? locations.find((l) => l.id === row.locationId) : null;
  if (!row.entityId && !row.locationId) return 'Whole company';
  const parts = [];
  if (row.entityId) parts.push(ent ? (ent.code || ent.legalName) : 'Entity');
  if (row.locationId) parts.push(loc ? (loc.name || loc.code) : 'Location');
  return parts.join(' · ');
}

function ActiveChip({ isActive }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-500 border-gray-200'}`}>
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );
}

// Shared optional entity + location scope selects. Scope is fixed after
// creation (the server ignores scope on PATCH), so both disable when editing.
function ScopeFields({ entities, locations, entityId, locationId, onEntity, onLocation, editing }) {
  const locs = entityId ? locations.filter((l) => l.entityId === entityId) : locations;
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="block text-sm">
        <span className="flex items-center text-gray-700 font-medium">Entity (optional)<InfoTip text="Narrow the rule to one legal entity. Blank = whole company. The most specific active rule wins: location beats entity beats company." /></span>
        <select
          value={entityId}
          onChange={(e) => { onEntity(e.target.value); onLocation(''); }}
          disabled={editing}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
        >
          <option value="">Whole company</option>
          {entities.map((en) => <option key={en.id} value={en.id}>{en.code} — {en.legalName}</option>)}
        </select>
      </label>
      <label className="block text-sm">
        <span className="flex items-center text-gray-700 font-medium">Location (optional)<InfoTip text="Narrow the rule to one location/site — e.g. a factory with different OT terms. Blank = all locations." /></span>
        <select
          value={locationId}
          onChange={(e) => onLocation(e.target.value)}
          disabled={editing}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
        >
          <option value="">All locations</option>
          {locs.map((l) => <option key={l.id} value={l.id}>{l.name || l.code}</option>)}
        </select>
      </label>
      {editing && <p className="col-span-2 text-xs text-gray-400 -mt-1">Scope is fixed after creation — delete and recreate the rule to change it.</p>}
    </div>
  );
}

/* ── Overtime rules ───────────────────────────────────────────────────────── */

function OtRuleModal({ entities, locations, rule, onClose, onSaved }) {
  const editing = !!rule?.id;
  const [entityId, setEntityId] = useState(rule?.entityId || '');
  const [locationId, setLocationId] = useState(rule?.locationId || '');
  const [threshold, setThreshold] = useState(rule?.dailyThresholdMin ?? 480);
  const [weekday, setWeekday] = useState(rule ? Number(rule.weekdayMultiplier) : 1);
  const [weeklyOff, setWeeklyOff] = useState(rule ? Number(rule.weeklyOffMultiplier) : 2);
  const [holiday, setHoliday] = useState(rule ? Number(rule.holidayMultiplier) : 2);
  const [dailyCap, setDailyCap] = useState(rule?.dailyCapMin ?? '');
  const [rounding, setRounding] = useState(rule?.roundingMin ?? 15);
  const [isActive, setIsActive] = useState(rule?.isActive !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const body = {
      dailyThresholdMin: Number(threshold),
      weekdayMultiplier: Number(weekday),
      weeklyOffMultiplier: Number(weeklyOff),
      holidayMultiplier: Number(holiday),
      dailyCapMin: dailyCap === '' || dailyCap == null ? null : Number(dailyCap),
      roundingMin: Number(rounding),
    };
    try {
      if (editing) {
        await patch(`/api/hr/attendance/overtime-rules/${rule.id}`, { ...body, isActive });
      } else {
        await post('/api/hr/attendance/overtime-rules', { ...body, entityId: entityId || null, locationId: locationId || null });
      }
      onSaved();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save the overtime rule.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={editing ? 'Edit overtime rule' : 'New overtime rule'} size="lg" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <p className="text-xs text-gray-500">
          OT minutes beyond the daily threshold accrue at these multipliers; blank scope = whole company.
        </p>
        <ScopeFields
          entities={entities} locations={locations}
          entityId={entityId} locationId={locationId}
          onEntity={setEntityId} onLocation={setLocationId}
          editing={editing}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Daily threshold (minutes)" type="number" min={0} max={1440} value={threshold} onChange={setThreshold} required
            hint="Worked minutes beyond this count as overtime — 480 = an 8-hour day."
          />
          <TextInput
            label="Rounding (minutes)" type="number" min={0} max={1440} value={rounding} onChange={setRounding} required
            hint="OT rounds DOWN to this block — 15 means 29 extra minutes pays 15."
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <TextInput label="Weekday ×" type="number" min={0} max={10} step="0.25" value={weekday} onChange={setWeekday} required hint="Multiplier on a normal working day." />
          <TextInput label="Weekly-off ×" type="number" min={0} max={10} step="0.25" value={weeklyOff} onChange={setWeeklyOff} required hint="Multiplier on the employee's weekly off." />
          <TextInput label="Holiday ×" type="number" min={0} max={10} step="0.25" value={holiday} onChange={setHoliday} required hint="Multiplier on a declared holiday (2 = double pay, the Factories Act norm)." />
        </div>
        <TextInput
          label="Daily cap (minutes, optional)" type="number" min={0} max={1440} value={dailyCap} onChange={setDailyCap}
          hint="At most this many OT minutes count per day. Blank = no cap."
        />
        {editing && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
            <InfoTip text="Inactive rules are ignored at recompute but kept for history." />
          </label>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{editing ? 'Save rule' : 'Create rule'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function OvertimeRulesSection({ entities, locations, canManage, flash }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | rule row

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/attendance/overtime-rules')
      .then((res) => setItems(res?.items || []))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load overtime rules.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(row) {
    if (!window.confirm('Delete this overtime rule? Future recomputes fall back to the next-most-specific rule.')) return;
    setError('');
    try {
      await del(`/api/hr/attendance/overtime-rules/${row.id}`);
      flash('Overtime rule deleted.');
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete the overtime rule.');
    }
  }

  const columns = [
    { key: 'scope', header: 'Applies to', render: (r) => <span className="font-medium text-gray-900">{scopeLabel(r, entities, locations)}</span> },
    { key: 'threshold', header: 'Daily threshold', render: (r) => `${r.dailyThresholdMin} min` },
    { key: 'weekday', header: 'Weekday', render: (r) => `× ${Number(r.weekdayMultiplier)}` },
    { key: 'weeklyOff', header: 'Weekly off', render: (r) => `× ${Number(r.weeklyOffMultiplier)}` },
    { key: 'holiday', header: 'Holiday', render: (r) => `× ${Number(r.holidayMultiplier)}` },
    { key: 'cap', header: 'Daily cap', render: (r) => (r.dailyCapMin == null ? 'No cap' : `${r.dailyCapMin} min`) },
    { key: 'rounding', header: 'Rounding', render: (r) => `${r.roundingMin} min` },
    { key: 'active', header: 'Status', render: (r) => <ActiveChip isActive={r.isActive} /> },
    ...(canManage ? [{
      key: 'actions', header: '',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
          <ActionButton tone="danger" onClick={() => remove(r)}>Delete</ActionButton>
        </span>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionTitle tip="OT minutes beyond the daily threshold accrue at these multipliers; blank scope = whole company. The most specific active rule wins: location beats entity beats company.">
            Overtime rules
          </SectionTitle>
          <p className="text-xs text-gray-500 mt-0.5">
            Minutes worked beyond the daily threshold accrue as OT at the weekday / weekly-off / holiday multipliers.
          </p>
        </div>
        {canManage && <PrimaryButton onClick={() => setEditing('new')}>New OT rule</PrimaryButton>}
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={columns}
        rows={items || []}
        loading={loading}
        emptyText="No overtime rules yet — add one to start accruing OT beyond the daily threshold."
      />
      {editing && (
        <OtRuleModal
          entities={entities} locations={locations}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); flash('Overtime rule saved.'); load(); }}
        />
      )}
    </div>
  );
}

/* ── Late-coming penalties ────────────────────────────────────────────────── */

function LateRuleModal({ entities, locations, rule, onClose, onSaved }) {
  const editing = !!rule?.id;
  const [entityId, setEntityId] = useState(rule?.entityId || '');
  const [locationId, setLocationId] = useState(rule?.locationId || '');
  const [allowed, setAllowed] = useState(rule?.allowedLatesPerMonth ?? 3);
  const [perLates, setPerLates] = useState(rule?.perLates ?? 1);
  const [fraction, setFraction] = useState(rule ? Number(rule.penaltyDayFraction) : 0.5);
  const [isActive, setIsActive] = useState(rule?.isActive !== false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    const body = {
      allowedLatesPerMonth: Number(allowed),
      perLates: Number(perLates),
      penaltyDayFraction: Number(fraction),
    };
    try {
      if (editing) {
        await patch(`/api/hr/attendance/late-rules/${rule.id}`, { ...body, isActive });
      } else {
        await post('/api/hr/attendance/late-rules', { ...body, entityId: entityId || null, locationId: locationId || null });
      }
      onSaved();
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save the late-coming rule.');
    } finally {
      setSaving(false);
    }
  }

  const nAllowed = Number(allowed);
  const nPer = Number(perLates);
  const preview = Number.isFinite(nAllowed) && Number.isFinite(nPer) && nPer >= 1;

  return (
    <Modal title={editing ? 'Edit late-coming penalty' : 'New late-coming penalty'} size="lg" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <ScopeFields
          entities={entities} locations={locations}
          entityId={entityId} locationId={locationId}
          onEntity={setEntityId} onLocation={setLocationId}
          editing={editing}
        />
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Allowed lates per month (0–31)" type="number" min={0} max={31} value={allowed} onChange={setAllowed} required
            hint="Grace count — this many late arrivals each month carry no penalty."
          />
          <TextInput
            label="Every N further lates (1–31)" type="number" min={1} max={31} value={perLates} onChange={setPerLates} required
            hint="After the grace count, every N-th further late triggers one penalty."
          />
        </div>
        <label className="block text-sm">
          <span className="flex items-center text-gray-700 font-medium">Penalty per trigger<InfoTip text="How much pay is deducted each time the rule triggers — a quarter, half, or full day's salary." /></span>
          <select
            value={String(fraction)}
            onChange={(e) => setFraction(Number(e.target.value))}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            {PENALTY_FRACTIONS.map((f) => <option key={f.value} value={String(f.value)}>{f.label}</option>)}
          </select>
        </label>
        {preview && (
          <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-indigo-50/60 to-white p-3 text-sm text-gray-700">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-1">In plain words</p>
            First <b>{nAllowed}</b> late{nAllowed === 1 ? '' : 's'} each month {nAllowed === 1 ? 'is' : 'are'} free;
            after that, every <b>{nPer}</b> late{nPer === 1 ? '' : 's'} deducts <b>{fractionLabel(fraction)}</b> day
            on the offending day. Applied automatically at attendance recompute; visible in the muster&apos;s LOP.
          </div>
        )}
        {editing && (
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Active
            <InfoTip text="Inactive rules are ignored at recompute but kept for history." />
          </label>
        )}
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>{editing ? 'Save rule' : 'Create rule'}</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

function LateRulesSection({ entities, locations, canManage, flash }) {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // null | 'new' | rule row

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/attendance/late-rules')
      .then((res) => setItems(res?.items || []))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load late-coming rules.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(row) {
    if (!window.confirm('Delete this late-coming rule? Future recomputes stop penalising lates under this scope.')) return;
    setError('');
    try {
      await del(`/api/hr/attendance/late-rules/${row.id}`);
      flash('Late-coming rule deleted.');
      load();
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to delete the late-coming rule.');
    }
  }

  const columns = [
    { key: 'scope', header: 'Applies to', render: (r) => <span className="font-medium text-gray-900">{scopeLabel(r, entities, locations)}</span> },
    { key: 'allowed', header: 'Free lates / month', render: (r) => r.allowedLatesPerMonth },
    { key: 'per', header: 'Then every', render: (r) => `${r.perLates} late${Number(r.perLates) === 1 ? '' : 's'}` },
    { key: 'penalty', header: 'Deducts', render: (r) => `${Number(r.penaltyDayFraction)} day` },
    {
      key: 'sentence', header: 'In plain words',
      render: (r) => (
        <span className="text-xs text-gray-500">
          First {r.allowedLatesPerMonth} free, then every {r.perLates} late{Number(r.perLates) === 1 ? '' : 's'} costs {fractionLabel(r.penaltyDayFraction)} day.
        </span>
      ),
    },
    { key: 'active', header: 'Status', render: (r) => <ActiveChip isActive={r.isActive} /> },
    ...(canManage ? [{
      key: 'actions', header: '',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
          <ActionButton tone="danger" onClick={() => remove(r)}>Delete</ActionButton>
        </span>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <SectionTitle tip="First {allowed} lates each month are free; after that, every {N} late(s) deducts {fraction} day on the offending day. Applied automatically at attendance recompute; visible in the muster's LOP.">
            Late-coming penalties
          </SectionTitle>
          <p className="text-xs text-gray-500 mt-0.5">
            Grace lates each month, then an automatic part-day deduction for every further N lates.
          </p>
        </div>
        {canManage && <PrimaryButton onClick={() => setEditing('new')}>New late rule</PrimaryButton>}
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={columns}
        rows={items || []}
        loading={loading}
        emptyText="No late-coming rules yet — lates carry no automatic penalty until you add one."
      />
      {editing && (
        <LateRuleModal
          entities={entities} locations={locations}
          rule={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); flash('Late-coming rule saved.'); load(); }}
        />
      )}
    </div>
  );
}

/* ── Restricted holidays (P1.7) ───────────────────────────────────────────── */
// GET/PATCH /api/hr/attendance/rh-settings → { allowance }: how many restricted
// (optional) holidays each employee may elect per calendar year. PATCH is
// canManageAttendance-gated server-side; this section just disables the editor.

function RestrictedHolidaySettingsSection({ canManage, flash }) {
  const [allowance, setAllowance] = useState(null); // null = loading
  const [savedAllowance, setSavedAllowance] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/attendance/rh-settings')
      .then((res) => {
        const a = res?.allowance ?? 2;
        setAllowance(a);
        setSavedAllowance(a);
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load the restricted-holiday setting.'));
  }, []);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const res = await patch('/api/hr/attendance/rh-settings', { allowance: Number(allowance) });
      const a = res?.allowance ?? Number(allowance);
      setAllowance(a);
      setSavedAllowance(a);
      flash('Restricted-holiday allowance saved.');
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to save the restricted-holiday allowance.');
    } finally {
      setSaving(false);
    }
  }

  const dirty = allowance !== null && String(allowance) !== String(savedAllowance);

  return (
    <div className="space-y-3">
      <div>
        <SectionTitle tip="Restricted (optional) holidays are published on the holiday calendar but only apply to employees who elect them. This allowance caps how many each employee may pick per calendar year.">
          Restricted holidays
        </SectionTitle>
        <p className="text-xs text-gray-500 mt-0.5">
          How many restricted/optional holidays each employee may elect per calendar year.
        </p>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 max-w-md">
        {allowance === null && !error ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <div className="flex items-end gap-3">
            <label className="block text-sm w-44">
              <span className="flex items-center text-gray-700 font-medium">Allowance per year (0–30)</span>
              <input
                type="number"
                min={0}
                max={30}
                value={allowance ?? ''}
                onChange={(e) => setAllowance(e.target.value)}
                disabled={!canManage}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
              />
            </label>
            {canManage && (
              <PrimaryButton loading={saving} onClick={save} disabled={!dirty || allowance === ''}>
                Save
              </PrimaryButton>
            )}
          </div>
        )}
        <p className="text-xs text-gray-500 mt-2">
          How many restricted/optional holidays each employee may elect per calendar year (default 2).
        </p>
      </div>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function WorkPoliciesPage() {
  const [entities, setEntities] = useState([]);
  const [locations, setLocations] = useState([]);
  const [canManage, setCanManage] = useState(true);
  const [notice, setNotice] = useState('');

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  useEffect(() => {
    get('/api/hr/org/entities').then((r) => setEntities(r?.items || r || [])).catch(() => {});
    get('/api/hr/org/locations').then((r) => setLocations(r?.items || r || [])).catch(() => {});
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasPermission(permissionsFromSession(session), 'canManageAttendance'));
      })
      .catch(() => {});
  }, []);

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Work policies
            <InfoTip text="Overtime and late-coming rules applied automatically when attendance is recomputed. Entity/location scoped — the most specific active rule wins." />
          </span>
        )}
        subtitle="Overtime accrual and late-coming penalties — applied automatically at attendance recompute."
      />

      <ModuleGuide
        id="settings-attendance-work-policies"
        title="Set overtime pay and late-coming penalties"
        what="Two automatic attendance policies. Overtime: minutes worked beyond a daily threshold accrue as OT at weekday / weekly-off / holiday multipliers (optionally capped and rounded). Late-coming: the first N lates each month are free, then every M further lates deducts a quarter, half, or full day. Rules can cover the whole company or be narrowed to one entity or location — the most specific active rule wins."
        steps={[
          'Add an Overtime rule: set the daily threshold (480 min = 8h), the three multipliers, an optional daily cap, and the rounding block.',
          'Add a Late-coming penalty: choose the free lates per month, the "every N further lates" trigger, and the deduction (¼ / ½ / 1 day).',
          'Leave the scope blank to cover the whole company, or pick an entity/location for site-specific terms (a location rule beats an entity rule).',
          'Recompute attendance (or wait for the nightly sweep) — OT and late deductions land on each day automatically and flow into payroll.',
        ]}
        example={<>A factory location rule: threshold <b>480 min</b>, weekday <b>×1</b>, weekly-off <b>×2</b>, holiday <b>×2</b>, rounding <b>15</b>. A worker doing 9h 20m on a Sunday accrues 560 − 480 = 80 → <b>75 OT minutes at ×2</b>. Late rule <b>3 free, every 2 lates, ½ day</b>: the 5th late in a month deducts half a day's pay.</>}
        tips={[
          'Blank scope = whole company; the most specific active rule wins (location beats entity beats company).',
          "Late deductions are applied on the offending day at attendance recompute and show up in the muster's LOP column.",
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Changing work policies requires the manage-attendance permission.
        </p>
      )}

      <OvertimeRulesSection entities={entities} locations={locations} canManage={canManage} flash={flash} />
      <LateRulesSection entities={entities} locations={locations} canManage={canManage} flash={flash} />
      {/* P1.7 — the yearly restricted/optional-holiday election allowance. */}
      <RestrictedHolidaySettingsSection canManage={canManage} flash={flash} />
    </div>
  );
}
