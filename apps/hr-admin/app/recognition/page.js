'use client';

// Rewards & Recognition admin — Feature 35 operator surface, wired to the REAL
// /api/hr/recognition contract (see recognitionAdmin.controller.js):
//   Program     GET|PATCH /config (pointsEnabled, inrPerPoint,
//               recognitionApprovalThreshold, pointsExpiryMonths,
//               redemptionRequiresApproval, peerGiveDailyCap, perGiveMaxPoints)
//               + values / badges CRUD (retire via PATCH isActive:false — never
//               delete history) + POST /seed-defaults
//   Budgets     GET|POST /budgets, PATCH /budgets/:id — scope GIVER/DEPARTMENT/
//               ENTITY/TENANT (scopeRefId required unless TENANT), periodType
//               MONTHLY/QUARTERLY/YEARLY; rows arrive with derived
//               consumedPoints/remainingPoints
//   Catalog     GET|POST /catalog, PATCH /catalog/:id — category, pointsCost,
//               inrValue, stock (null = unlimited), fulfilmentType, isTaxablePerk
//   Awards      GET|POST /award-cycles (+ /:id, PATCH, /close, /nominations/
//               /:nominationId/shortlist, /decide {nominationIds?}) — the decide
//               opens one F10 AWARD request per shortlisted nominee; the
//               committee decides from the normal approvals inbox
//   Redemptions GET /redemptions?status= (default APPROVED) + POST
//               /redemptions/:id/fulfil { fulfilmentRef } (canFulfilRedemptions;
//               the voucher code IS the fulfilmentRef) + the taxable-perks FY
//               report (GET /reports/taxable-perks)
//   Leaderboard GET /reports/leaderboard?board=earners|givers|values&period=
//               month|quarter|allTime&departmentId=
// All 4xx server messages are surfaced verbatim. Follows the surveys page idioms.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, ServerPagination, Tabs, employeeLabel } from '@/lib/ui';
import { InfoTip, LabelWithTip } from '../letters/lib';
import ModuleGuide from '@/components/ModuleGuide';
import EmployeeSearchSelect, { employeeName } from '@/components/EmployeeSearchSelect';

const API = '/api/hr/recognition';

const BUDGET_SCOPES = [
  { value: 'GIVER', label: 'One giver (per person)' },
  { value: 'DEPARTMENT', label: 'A department' },
  { value: 'ENTITY', label: 'An entity / legal company' },
  { value: 'TENANT', label: 'Whole company' },
];
const BUDGET_PERIODS = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'QUARTERLY', label: 'Quarterly' },
  { value: 'YEARLY', label: 'Yearly' },
];
const CATALOG_CATEGORIES = ['VOUCHER', 'PERK', 'SWAG', 'COMP_OFF', 'WFH', 'CHARITY', 'DONATION'];
const FULFILMENT_TYPES = [
  { value: 'MANUAL', label: 'Manual (HR confirms)' },
  { value: 'VOUCHER_CODE', label: 'Voucher code' },
  { value: 'COMP_OFF_GRANT', label: 'Comp-off credit (auto-grant)' },
];
const CYCLE_STATUSES = ['', 'OPEN', 'CLOSED', 'DECIDED', 'ARCHIVED'];
const REDEMPTION_STATUSES = ['APPROVED', 'PENDING', 'FULFILLED', 'REJECTED', 'CANCELLED'];
const PERIODS = [
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'allTime', label: 'All time' },
];
const BOARDS = [
  { value: 'earners', label: 'Top earners' },
  { value: 'givers', label: 'Top givers' },
  { value: 'values', label: 'Most-celebrated values' },
];

const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm';

function errMsg(e, fallback) {
  return e?.data?.message || e?.message || fallback;
}

function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function intOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

function Modal({ title, children, onClose, wide = false }) {
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className={`mt-16 mb-16 w-full ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-2xl bg-white p-6 shadow-xl`}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-xl leading-none text-gray-400 hover:text-gray-700">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function PrimaryButton({ onClick, disabled, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      style={{ background: 'var(--theme-primary)' }}
    >
      {children}
    </button>
  );
}

function CancelButton({ onClick, children = 'Cancel' }) {
  return (
    <button type="button" onClick={onClick} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
      {children}
    </button>
  );
}

function ValueChip({ value }) {
  if (!value) return <span className="text-gray-400">—</span>;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ background: `${value.colorHex || '#64748b'}1a`, color: value.colorHex || '#475569' }}
    >
      {value.icon ? `${value.icon} ` : ''}{value.name}
    </span>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Program tab — config switches + values + badges + seed defaults
// ═════════════════════════════════════════════════════════════════════════════
function ProgramTab() {
  const [config, setConfig] = useState(null);
  const [values, setValues] = useState([]);
  const [badges, setBadges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [valueModal, setValueModal] = useState(null); // null | {} (new) | value row
  const [badgeModal, setBadgeModal] = useState(null);
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    Promise.all([
      get(`${API}/config`),
      get(`${API}/values`, { includeInactive: 'true' }),
      get(`${API}/badges`, { includeInactive: 'true' }),
    ])
      .then(([c, v, b]) => {
        setConfig(c.config);
        setValues(v.items || []);
        setBadges(b.items || []);
      })
      .catch((e) => setError(errMsg(e, 'Failed to load the program settings.')))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const setC = (k, v) => setConfig((c) => ({ ...c, [k]: v }));

  async function saveConfig() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const payload = {
        pointsEnabled: !!config.pointsEnabled,
        inrPerPoint: Number(config.inrPerPoint) || 0,
        recognitionApprovalThreshold: intOrNull(config.recognitionApprovalThreshold),
        pointsExpiryMonths: intOrNull(config.pointsExpiryMonths),
        redemptionRequiresApproval: !!config.redemptionRequiresApproval,
        peerGiveDailyCap: Math.max(1, intOrNull(config.peerGiveDailyCap) || 10),
        perGiveMaxPoints: Math.max(1, intOrNull(config.perGiveMaxPoints) || 500),
      };
      const r = await patch(`${API}/config`, payload);
      setConfig(r.config);
      setNotice('Program settings saved.');
    } catch (e) {
      setError(errMsg(e, 'Failed to save the program settings.'));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(kind, row) {
    setBusyId(row.id);
    setError('');
    try {
      await patch(`${API}/${kind}/${row.id}`, { isActive: !row.isActive });
      load();
    } catch (e) {
      setError(errMsg(e, 'Failed to update.'));
    } finally {
      setBusyId('');
    }
  }

  async function seedDefaults() {
    setSeeding(true);
    setError('');
    setNotice('');
    try {
      await post(`${API}/seed-defaults`);
      setNotice('Defaults restored — the India-first starter values, badges and catalog items are in place (existing rows are kept).');
      load();
    } catch (e) {
      setError(errMsg(e, 'Failed to restore the defaults.'));
    } finally {
      setSeeding(false);
    }
  }

  if (loading) return <DataTable columns={[]} rows={[]} loading />;

  return (
    <div className="space-y-5">
      {error && <ErrorBanner message={error} />}
      {notice && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>
      )}

      {/* ── program switches ── */}
      {config && (
        <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Program switches</h2>
            <PrimaryButton onClick={saveConfig} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</PrimaryButton>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex items-start gap-3 rounded-xl border border-gray-100 bg-gray-50 p-3">
              <input type="checkbox" checked={!!config.pointsEnabled} onChange={(e) => setC('pointsEnabled', e.target.checked)} className="mt-1 h-4 w-4" />
              <span>
                <span className="block text-sm font-semibold text-gray-900">Enable points</span>
                <span className="mt-0.5 block text-xs text-gray-500">Off = pure social kudos: no wallets, no catalog, no redemptions.</span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-gray-100 bg-gray-50 p-3">
              <input type="checkbox" checked={!!config.redemptionRequiresApproval} onChange={(e) => setC('redemptionRequiresApproval', e.target.checked)} className="mt-1 h-4 w-4" />
              <span>
                <span className="block text-sm font-semibold text-gray-900">Redemptions need approval</span>
                <span className="mt-0.5 block text-xs text-gray-500">Route each redemption through the approval engine before points move.</span>
              </span>
            </label>
            <div>
              <LabelWithTip label="1 point = ₹" tip="The rupee shadow shown next to points ('1,240 points ≈ ₹1,240'). 0 hides the ₹ display entirely." htmlFor="rr-inr" />
              <input id="rr-inr" type="number" min={0} step="0.01" value={config.inrPerPoint ?? 0} onChange={(e) => setC('inrPerPoint', e.target.value)} className={inputCls} />
            </div>
            <div>
              <LabelWithTip label="Approval threshold (points)" tip="A single give whose TOTAL points exceed this routes to manager approval first. Blank or 0 = points post instantly." htmlFor="rr-threshold" />
              <input id="rr-threshold" type="number" min={0} value={config.recognitionApprovalThreshold ?? ''} onChange={(e) => setC('recognitionApprovalThreshold', e.target.value)} className={inputCls} placeholder="Never" />
            </div>
            <div>
              <LabelWithTip label="Points expire after (months)" tip="Earned points lapse after this many months (oldest first). Blank = points never expire." htmlFor="rr-expiry" />
              <input id="rr-expiry" type="number" min={0} value={config.pointsExpiryMonths ?? ''} onChange={(e) => setC('pointsExpiryMonths', e.target.value)} className={inputCls} placeholder="Never" />
            </div>
            <div>
              <LabelWithTip label="Daily give cap (per person)" tip="Anti-spam: the most recognitions one person can give per day." htmlFor="rr-cap" />
              <input id="rr-cap" type="number" min={1} value={config.peerGiveDailyCap ?? 10} onChange={(e) => setC('peerGiveDailyCap', e.target.value)} className={inputCls} />
            </div>
            <div>
              <LabelWithTip label="Max points per give" tip="The clamp on points-per-recipient for a single recognition." htmlFor="rr-max" />
              <input id="rr-max" type="number" min={1} value={config.perGiveMaxPoints ?? 500} onChange={(e) => setC('perGiveMaxPoints', e.target.value)} className={inputCls} />
            </div>
          </div>
        </section>
      )}

      {/* ── company values ── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Company values
            <InfoTip text="The values a recognition can celebrate ('Customer First', 'Ownership'…). Retire a value instead of deleting it — history stays intact." label="Values" />
          </h2>
          <div className="flex items-center gap-2">
            <ActionButton onClick={seedDefaults} disabled={seeding}>{seeding ? 'Restoring…' : 'Restore defaults'}</ActionButton>
            <PrimaryButton onClick={() => setValueModal({})}>+ Add value</PrimaryButton>
          </div>
        </div>
        <DataTable
          columns={[
            { key: 'name', header: 'Value', render: (r) => <ValueChip value={r} /> },
            { key: 'description', header: 'Description', render: (r) => <span className="text-gray-600">{r.description || '—'}</span> },
            { key: 'sortOrder', header: 'Order', render: (r) => r.sortOrder ?? 0 },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'RETIRED'} /> },
            {
              key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
              render: (r) => (
                <div className="inline-flex items-center justify-end gap-1.5">
                  <ActionButton onClick={() => setValueModal(r)} disabled={busyId === r.id}>Edit</ActionButton>
                  <ActionButton tone={r.isActive ? 'danger' : 'positive'} onClick={() => toggleActive('values', r)} disabled={busyId === r.id}>
                    {r.isActive ? 'Retire' : 'Reactivate'}
                  </ActionButton>
                </div>
              ),
            },
          ]}
          rows={values}
          rowKey={(r) => r.id}
          emptyText="No values yet — add one or restore the defaults."
        />
      </section>

      {/* ── badges ── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Badges
            <InfoTip text="Optional stickers a giver can attach ('Team Player', 'Innovator'). A badge can carry default points and link to a value." label="Badges" />
          </h2>
          <PrimaryButton onClick={() => setBadgeModal({})}>+ Add badge</PrimaryButton>
        </div>
        <DataTable
          columns={[
            { key: 'name', header: 'Badge', render: (r) => <span className="font-medium text-gray-900">{r.icon ? `${r.icon} ` : ''}{r.name}</span> },
            { key: 'defaultPoints', header: 'Default points', render: (r) => r.defaultPoints ?? 0 },
            { key: 'value', header: 'Linked value', render: (r) => (r.value ? r.value.name : '—') },
            { key: 'sortOrder', header: 'Order', render: (r) => r.sortOrder ?? 0 },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'RETIRED'} /> },
            {
              key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
              render: (r) => (
                <div className="inline-flex items-center justify-end gap-1.5">
                  <ActionButton onClick={() => setBadgeModal(r)} disabled={busyId === r.id}>Edit</ActionButton>
                  <ActionButton tone={r.isActive ? 'danger' : 'positive'} onClick={() => toggleActive('badges', r)} disabled={busyId === r.id}>
                    {r.isActive ? 'Retire' : 'Reactivate'}
                  </ActionButton>
                </div>
              ),
            },
          ]}
          rows={badges}
          rowKey={(r) => r.id}
          emptyText="No badges yet — add one or restore the defaults."
        />
      </section>

      {valueModal && (
        <ValueModal
          initial={valueModal}
          onClose={() => setValueModal(null)}
          onSaved={() => { setValueModal(null); load(); }}
        />
      )}
      {badgeModal && (
        <BadgeModal
          initial={badgeModal}
          values={values.filter((v) => v.isActive)}
          onClose={() => setBadgeModal(null)}
          onSaved={() => { setBadgeModal(null); load(); }}
        />
      )}
    </div>
  );
}

function ValueModal({ initial, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({
    name: initial.name || '',
    description: initial.description || '',
    icon: initial.icon || '',
    colorHex: initial.colorHex || '#6366f1',
    sortOrder: initial.sortOrder ?? 0,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        icon: form.icon.trim() || null,
        colorHex: form.colorHex || null,
        sortOrder: Math.round(Number(form.sortOrder)) || 0,
      };
      if (isNew) await post(`${API}/values`, payload);
      else await patch(`${API}/values/${initial.id}`, payload);
      onSaved();
    } catch (e) {
      setError(errMsg(e, 'Failed to save the value.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={isNew ? 'New company value' : `Edit “${initial.name}”`} onClose={onClose}>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <div className="space-y-3">
        <div>
          <LabelWithTip label="Name" tip="Shown on recognition cards and the wall." htmlFor="vm-name" />
          <input id="vm-name" value={form.name} onChange={(e) => set('name', e.target.value)} className={inputCls} placeholder="e.g. Customer First" />
        </div>
        <div>
          <LabelWithTip label="Description (optional)" tip="A one-line explanation employees see when picking a value." htmlFor="vm-desc" />
          <input id="vm-desc" value={form.description} onChange={(e) => set('description', e.target.value)} className={inputCls} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <LabelWithTip label="Icon / emoji" tip="An emoji shown before the name (e.g. 🤝)." htmlFor="vm-icon" />
            <input id="vm-icon" value={form.icon} onChange={(e) => set('icon', e.target.value)} className={inputCls} placeholder="🤝" />
          </div>
          <div>
            <LabelWithTip label="Colour" tip="The chip colour on the wall." htmlFor="vm-color" />
            <input id="vm-color" type="color" value={form.colorHex || '#6366f1'} onChange={(e) => set('colorHex', e.target.value)} className="h-9 w-full cursor-pointer rounded-lg border border-gray-300 p-0.5" />
          </div>
          <div>
            <LabelWithTip label="Order" tip="Lower numbers sort first in the picker." htmlFor="vm-order" />
            <input id="vm-order" type="number" value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <CancelButton onClick={onClose} />
        <PrimaryButton onClick={save} disabled={saving || !form.name.trim()}>{saving ? 'Saving…' : isNew ? 'Create value' : 'Save changes'}</PrimaryButton>
      </div>
    </Modal>
  );
}

function BadgeModal({ initial, values, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({
    name: initial.name || '',
    icon: initial.icon || '',
    defaultPoints: initial.defaultPoints ?? 0,
    valueId: initial.valueId || '',
    sortOrder: initial.sortOrder ?? 0,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        icon: form.icon.trim() || null,
        defaultPoints: Math.max(0, Math.round(Number(form.defaultPoints)) || 0),
        valueId: form.valueId || null,
        sortOrder: Math.round(Number(form.sortOrder)) || 0,
      };
      if (isNew) await post(`${API}/badges`, payload);
      else await patch(`${API}/badges/${initial.id}`, payload);
      onSaved();
    } catch (e) {
      setError(errMsg(e, 'Failed to save the badge.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={isNew ? 'New badge' : `Edit “${initial.name}”`} onClose={onClose}>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <div className="space-y-3">
        <div>
          <LabelWithTip label="Name" tip="e.g. Team Player, Innovator, Extra Mile." htmlFor="bm-name" />
          <input id="bm-name" value={form.name} onChange={(e) => set('name', e.target.value)} className={inputCls} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <LabelWithTip label="Icon / emoji" tip="Shown before the badge name." htmlFor="bm-icon" />
            <input id="bm-icon" value={form.icon} onChange={(e) => set('icon', e.target.value)} className={inputCls} placeholder="⭐" />
          </div>
          <div>
            <LabelWithTip label="Default points" tip="Pre-filled points when a giver picks this badge (they can still change it)." htmlFor="bm-points" />
            <input id="bm-points" type="number" min={0} value={form.defaultPoints} onChange={(e) => set('defaultPoints', e.target.value)} className={inputCls} />
          </div>
          <div>
            <LabelWithTip label="Order" tip="Lower numbers sort first." htmlFor="bm-order" />
            <input id="bm-order" type="number" value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <LabelWithTip label="Linked value (optional)" tip="Tie the badge to a company value so picking it pre-selects that value." htmlFor="bm-value" />
          <select id="bm-value" value={form.valueId} onChange={(e) => set('valueId', e.target.value)} className={inputCls}>
            <option value="">— none —</option>
            {values.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <CancelButton onClick={onClose} />
        <PrimaryButton onClick={save} disabled={saving || !form.name.trim()}>{saving ? 'Saving…' : isNew ? 'Create badge' : 'Save changes'}</PrimaryButton>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Budgets tab
// ═════════════════════════════════════════════════════════════════════════════
function UsageBar({ consumed, allocated }) {
  const pct = allocated > 0 ? Math.min(100, Math.round((consumed / allocated) * 100)) : 0;
  const color = pct >= 90 ? '#dc2626' : pct >= 70 ? '#d97706' : '#059669';
  return (
    <div className="min-w-[10rem]">
      <div className="h-2 overflow-hidden rounded-full bg-gray-100">
        <div className="h-2 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="mt-1 text-xs text-gray-500">{consumed.toLocaleString('en-IN')} / {allocated.toLocaleString('en-IN')} pts ({pct}%)</div>
    </div>
  );
}

function BudgetsTab() {
  const [items, setItems] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [giverLabels, setGiverLabels] = useState({}); // scopeRefId → display name (client cache)

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`${API}/budgets`)
      .then((r) => setItems(r.items || []))
      .catch((e) => setError(errMsg(e, 'Failed to load budgets.')))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    get('/api/hr/org/departments').then((r) => setDepartments(r.items || r || [])).catch(() => {});
    get('/api/hr/org/entities').then((r) => setEntities(r.items || r || [])).catch(() => {});
  }, []);

  const deptName = (id) => (departments.find((d) => d.id === id) || {}).name;
  const entityName = (id) => {
    const e = entities.find((x) => x.id === id) || {};
    return e.displayName || e.legalName || e.code;
  };
  function scopeTarget(r) {
    if (r.scope === 'TENANT') return 'Everyone';
    if (r.scope === 'DEPARTMENT') return deptName(r.scopeRefId) || r.scopeRefId;
    if (r.scope === 'ENTITY') return entityName(r.scopeRefId) || r.scopeRefId;
    return giverLabels[r.scopeRefId] || r.scopeRefId;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Point budgets cap what givers can hand out per period — an over-budget give routes to approval instead of failing.
          <InfoTip text="Scopes: per-giver, a department, an entity, or the whole company. The bar shows points consumed against the allocation for the current period. The most specific matching budget governs a give." label="How budgets work" />
        </p>
        <PrimaryButton onClick={() => setCreateOpen(true)}>+ New budget</PrimaryButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={[
          { key: 'scope', header: 'Scope', render: (r) => <span className="font-medium text-gray-900">{(BUDGET_SCOPES.find((s) => s.value === r.scope) || {}).label || r.scope}</span> },
          { key: 'target', header: 'Applies to', render: (r) => <span className="text-gray-700" title={r.scopeRefId || ''}>{scopeTarget(r)}</span> },
          { key: 'period', header: 'Period', render: (r) => (BUDGET_PERIODS.find((p) => p.value === r.periodType) || {}).label || r.periodType },
          { key: 'usage', header: 'Consumed vs allocated', render: (r) => <UsageBar consumed={r.consumedPoints || 0} allocated={r.allocatedPoints || 0} /> },
          { key: 'remaining', header: 'Remaining', render: (r) => <span className="font-medium text-gray-900">{(r.remainingPoints ?? Math.max(0, (r.allocatedPoints || 0) - (r.consumedPoints || 0))).toLocaleString('en-IN')}</span> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.isActive === false ? 'INACTIVE' : 'ACTIVE'} /> },
          {
            key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
            render: (r) => <ActionButton onClick={() => setEditRow(r)}>Edit</ActionButton>,
          },
        ]}
        rows={items}
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No budgets yet — without one, gives are only governed by the approval threshold."
      />

      {createOpen && (
        <BudgetCreateModal
          departments={departments}
          entities={entities}
          onClose={() => setCreateOpen(false)}
          onSaved={(giver) => {
            if (giver) setGiverLabels((m) => ({ ...m, [giver.id]: giver.label }));
            setCreateOpen(false);
            load();
          }}
        />
      )}
      {editRow && (
        <BudgetEditModal row={editRow} onClose={() => setEditRow(null)} onSaved={() => { setEditRow(null); load(); }} />
      )}
    </div>
  );
}

function BudgetCreateModal({ departments, entities, onClose, onSaved }) {
  const [form, setForm] = useState({ scope: 'TENANT', scopeRefId: '', periodType: 'MONTHLY', allocatedPoints: '' });
  const [giver, setGiver] = useState(null); // { id, label } for the GIVER scope
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        scope: form.scope,
        scopeRefId: form.scope === 'TENANT' ? undefined : (form.scope === 'GIVER' ? giver?.id : form.scopeRefId) || undefined,
        periodType: form.periodType,
        allocatedPoints: Math.max(0, Math.round(Number(form.allocatedPoints)) || 0),
      };
      await post(`${API}/budgets`, payload);
      onSaved(form.scope === 'GIVER' ? giver : null);
    } catch (e) {
      setError(errMsg(e, 'Failed to create the budget.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New point budget" onClose={onClose}>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <div className="space-y-3">
        <div>
          <LabelWithTip label="Scope" tip="Who this allocation covers. The most specific matching budget governs a give." htmlFor="bud-scope" />
          <select id="bud-scope" value={form.scope} onChange={(e) => { set('scope', e.target.value); set('scopeRefId', ''); setGiver(null); }} className={inputCls}>
            {BUDGET_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {form.scope === 'DEPARTMENT' && (
          <div>
            <LabelWithTip label="Department" tip="The department whose givers this budget covers." htmlFor="bud-dept" />
            <select id="bud-dept" value={form.scopeRefId} onChange={(e) => set('scopeRefId', e.target.value)} className={inputCls}>
              <option value="">— pick a department —</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name || d.code}</option>)}
            </select>
          </div>
        )}
        {form.scope === 'ENTITY' && (
          <div>
            <LabelWithTip label="Entity" tip="The legal entity whose givers this budget covers." htmlFor="bud-entity" />
            <select id="bud-entity" value={form.scopeRefId} onChange={(e) => set('scopeRefId', e.target.value)} className={inputCls}>
              <option value="">— pick an entity —</option>
              {entities.map((x) => <option key={x.id} value={x.id}>{x.displayName || x.legalName || x.code}</option>)}
            </select>
          </div>
        )}
        {form.scope === 'GIVER' && (
          <div>
            <LabelWithTip label="Giver" tip="The one employee this personal budget applies to." htmlFor="bud-giver" />
            {giver ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                {giver.label}
                <button type="button" onClick={() => setGiver(null)} className="text-gray-400 hover:text-gray-700" aria-label={`Remove ${giver.label}`}>✕</button>
              </span>
            ) : (
              <EmployeeSearchSelect
                id="bud-giver"
                status="ACTIVE"
                placeholder="Search by name, code or email…"
                onSelect={(emp) => { if (emp) setGiver({ id: emp.id, label: employeeName(emp) }); }}
              />
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <LabelWithTip label="Period" tip="The allocation resets each period." htmlFor="bud-period" />
            <select id="bud-period" value={form.periodType} onChange={(e) => set('periodType', e.target.value)} className={inputCls}>
              {BUDGET_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <LabelWithTip label="Allocated points" tip="The points pool for one period." htmlFor="bud-points" />
            <input id="bud-points" type="number" min={0} value={form.allocatedPoints} onChange={(e) => set('allocatedPoints', e.target.value)} className={inputCls} />
          </div>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <CancelButton onClick={onClose} />
        <PrimaryButton
          onClick={save}
          disabled={saving || form.allocatedPoints === '' || (form.scope === 'GIVER' && !giver) || ((form.scope === 'DEPARTMENT' || form.scope === 'ENTITY') && !form.scopeRefId)}
        >
          {saving ? 'Creating…' : 'Create budget'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

function BudgetEditModal({ row, onClose, onSaved }) {
  const [form, setForm] = useState({
    allocatedPoints: row.allocatedPoints ?? 0,
    periodType: row.periodType || 'MONTHLY',
    isActive: row.isActive !== false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    setError('');
    try {
      await patch(`${API}/budgets/${row.id}`, {
        allocatedPoints: Math.max(0, Math.round(Number(form.allocatedPoints)) || 0),
        periodType: form.periodType,
        isActive: !!form.isActive,
      });
      onSaved();
    } catch (e) {
      setError(errMsg(e, 'Failed to update the budget.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Edit budget" onClose={onClose}>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <p className="mb-3 text-xs text-gray-500">Scope cannot change after creation — retire this budget and create a new one to re-scope.</p>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <LabelWithTip label="Allocated points" tip="The points pool for one period." htmlFor="bue-points" />
            <input id="bue-points" type="number" min={0} value={form.allocatedPoints} onChange={(e) => set('allocatedPoints', e.target.value)} className={inputCls} />
          </div>
          <div>
            <LabelWithTip label="Period" tip="The allocation resets each period." htmlFor="bue-period" />
            <select id="bue-period" value={form.periodType} onChange={(e) => set('periodType', e.target.value)} className={inputCls}>
              {BUDGET_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} />
          Active
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <CancelButton onClick={onClose} />
        <PrimaryButton onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</PrimaryButton>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Catalog tab
// ═════════════════════════════════════════════════════════════════════════════
function CatalogTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [modal, setModal] = useState(null); // null | {} | item

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`${API}/catalog`, { includeInactive: 'true' })
      .then((r) => setItems(r.items || []))
      .catch((e) => setError(errMsg(e, 'Failed to load the catalog.')))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  async function toggleActive(row) {
    setBusyId(row.id);
    setError('');
    try {
      await patch(`${API}/catalog/${row.id}`, { isActive: !row.isActive });
      load();
    } catch (e) {
      setError(errMsg(e, 'Failed to update the item.'));
    } finally {
      setBusyId('');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          The rewards employees can spend points on. Retiring an item hides it from the store; past redemptions keep their history.
        </p>
        <PrimaryButton onClick={() => setModal({})}>+ New reward</PrimaryButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={[
          {
            key: 'name', header: 'Reward',
            render: (r) => (
              <div className="min-w-0">
                <span className="font-medium text-gray-900">{r.name}</span>
                {r.description && <div className="max-w-xs truncate text-xs text-gray-400" title={r.description}>{r.description}</div>}
              </div>
            ),
          },
          { key: 'category', header: 'Category', render: (r) => <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">{r.category}</span> },
          { key: 'pointsCost', header: 'Points', render: (r) => <span className="font-medium text-gray-900">{(r.pointsCost || 0).toLocaleString('en-IN')}</span> },
          {
            key: 'inrValue', header: '₹ value',
            render: (r) => (
              <span className="inline-flex items-center gap-1 text-gray-700">
                {r.inrValue != null ? `₹${Number(r.inrValue).toLocaleString('en-IN')}` : '—'}
                {r.isTaxablePerk && (
                  <InfoTip text="Taxable perk: this reward's ₹ value counts toward the ₹5,000/year gift-perquisite limit. Employees who cross it appear in the Finance export under Redemptions." label="Taxable perk" />
                )}
              </span>
            ),
          },
          { key: 'stock', header: 'Stock', render: (r) => (r.stock == null ? 'Unlimited' : r.stock) },
          { key: 'fulfilmentType', header: 'Fulfilment', render: (r) => (FULFILMENT_TYPES.find((f) => f.value === r.fulfilmentType) || {}).label || r.fulfilmentType },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'RETIRED'} /> },
          {
            key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
            render: (r) => (
              <div className="inline-flex items-center justify-end gap-1.5">
                <ActionButton onClick={() => setModal(r)} disabled={busyId === r.id}>Edit</ActionButton>
                <ActionButton tone={r.isActive ? 'danger' : 'positive'} onClick={() => toggleActive(r)} disabled={busyId === r.id}>
                  {r.isActive ? 'Retire' : 'Reactivate'}
                </ActionButton>
              </div>
            ),
          },
        ]}
        rows={items}
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No rewards yet — add one, or use Restore defaults on the Program tab."
      />
      {modal && (
        <CatalogModal initial={modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}

function CatalogModal({ initial, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({
    name: initial.name || '',
    description: initial.description || '',
    category: initial.category || 'VOUCHER',
    pointsCost: initial.pointsCost ?? '',
    inrValue: initial.inrValue ?? '',
    stock: initial.stock ?? '',
    fulfilmentType: initial.fulfilmentType || 'MANUAL',
    isTaxablePerk: !!initial.isTaxablePerk,
    imageUrl: initial.imageUrl || '',
    sortOrder: initial.sortOrder ?? 0,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        category: form.category,
        pointsCost: Math.round(Number(form.pointsCost)) || 0,
        inrValue: form.inrValue === '' ? null : Math.round(Number(form.inrValue)),
        stock: form.stock === '' ? null : Math.round(Number(form.stock)),
        fulfilmentType: form.fulfilmentType,
        isTaxablePerk: !!form.isTaxablePerk,
        imageUrl: form.imageUrl.trim() || null,
        sortOrder: Math.round(Number(form.sortOrder)) || 0,
      };
      if (isNew) await post(`${API}/catalog`, payload);
      else await patch(`${API}/catalog/${initial.id}`, payload);
      onSaved();
    } catch (e) {
      setError(errMsg(e, 'Failed to save the reward.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={isNew ? 'New reward' : `Edit “${initial.name}”`} onClose={onClose} wide>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <LabelWithTip label="Name" tip="Shown on the reward card in the employee store." htmlFor="cm-name" />
            <input id="cm-name" value={form.name} onChange={(e) => set('name', e.target.value)} className={inputCls} placeholder="e.g. ₹500 Amazon voucher" />
          </div>
          <div>
            <LabelWithTip label="Category" tip="Groups the store — vouchers, perks, swag, comp-off, WFH, charity." htmlFor="cm-cat" />
            <select id="cm-cat" value={form.category} onChange={(e) => set('category', e.target.value)} className={inputCls}>
              {CATALOG_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace('_', '-')}</option>)}
            </select>
          </div>
        </div>
        <div>
          <LabelWithTip label="Description (optional)" tip="A short line under the name." htmlFor="cm-desc" />
          <input id="cm-desc" value={form.description} onChange={(e) => set('description', e.target.value)} className={inputCls} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <LabelWithTip label="Points cost" tip="What the employee pays from their wallet." htmlFor="cm-points" />
            <input id="cm-points" type="number" min={1} value={form.pointsCost} onChange={(e) => set('pointsCost', e.target.value)} className={inputCls} />
          </div>
          <div>
            <LabelWithTip label="₹ value (optional)" tip="The monetary value — used by the ₹5,000/yr taxable-perquisite report. Blank = no ₹ value." htmlFor="cm-inr" />
            <input id="cm-inr" type="number" min={0} value={form.inrValue} onChange={(e) => set('inrValue', e.target.value)} className={inputCls} placeholder="—" />
          </div>
          <div>
            <LabelWithTip label="Stock (optional)" tip="How many can be redeemed in total. Blank = unlimited." htmlFor="cm-stock" />
            <input id="cm-stock" type="number" min={0} value={form.stock} onChange={(e) => set('stock', e.target.value)} className={inputCls} placeholder="Unlimited" />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <LabelWithTip label="Fulfilment" tip="Voucher code = HR pastes a code at fulfilment. Comp-off = fulfilling auto-mints a comp-off leave credit. Manual = HR confirms the perk was granted." htmlFor="cm-ful" />
            <select id="cm-ful" value={form.fulfilmentType} onChange={(e) => set('fulfilmentType', e.target.value)} className={inputCls}>
              {FULFILMENT_TYPES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div>
            <LabelWithTip label="Image URL (optional)" tip="A picture for the store card." htmlFor="cm-img" />
            <input id="cm-img" value={form.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} className={inputCls} placeholder="https://…" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-5">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.isTaxablePerk} onChange={(e) => set('isTaxablePerk', e.target.checked)} />
            Taxable perk
            <InfoTip text="Counts toward the ₹5,000/financial-year gift-perquisite limit (Section 17(2)). Employees who cross it show up in the Finance export." label="Taxable perk" />
          </label>
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            Order
            <input type="number" value={form.sortOrder} onChange={(e) => set('sortOrder', e.target.value)} className="w-20 rounded-lg border border-gray-300 px-2 py-1 text-sm" aria-label="Sort order" />
          </label>
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <CancelButton onClick={onClose} />
        <PrimaryButton onClick={save} disabled={saving || !form.name.trim() || !(Number(form.pointsCost) >= 1)}>
          {saving ? 'Saving…' : isNew ? 'Create reward' : 'Save changes'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Awards tab — cycles list + create + drill-in (nominations / shortlist / decide)
// ═════════════════════════════════════════════════════════════════════════════
function AwardsTab() {
  const [view, setView] = useState({ mode: 'list' }); // {mode:'list'} | {mode:'detail', id}
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`${API}/award-cycles`, { status, page, pageSize })
      .then(setData)
      .catch((e) => setError(errMsg(e, 'Failed to load award cycles.')))
      .finally(() => setLoading(false));
  }, [status, page, pageSize]);
  useEffect(() => { if (view.mode === 'list') load(); }, [load, view.mode]);

  async function closeCycle(row) {
    setBusyId(row.id);
    setError('');
    try {
      await post(`${API}/award-cycles/${row.id}/close`);
      load();
    } catch (e) {
      setError(errMsg(e, 'Failed to close the cycle.'));
    } finally {
      setBusyId('');
    }
  }

  if (view.mode === 'detail') {
    return <CycleDetail id={view.id} onBack={() => setView({ mode: 'list' })} />;
  }

  const items = data?.items || [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="text-sm text-gray-600">
          Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm">
            {CYCLE_STATUSES.map((s) => <option key={s} value={s}>{s || 'All'}</option>)}
          </select>
        </label>
        <PrimaryButton onClick={() => setCreateOpen(true)}>+ New award cycle</PrimaryButton>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={[
          {
            key: 'name', header: 'Award',
            render: (r) => (
              <div className="min-w-0">
                <span className="font-medium text-gray-900">{r.name}</span>
                <div className="text-xs text-gray-400">{r.awardType}{r.periodLabel ? ` · ${r.periodLabel}` : ''}</div>
              </div>
            ),
          },
          { key: 'window', header: 'Nomination window', render: (r) => <span className="text-gray-600">{formatAdminDate(r.nominateOpenAt)} → {formatAdminDate(r.nominateCloseAt)}</span> },
          { key: 'pointsToWinner', header: 'Prize', render: (r) => (r.pointsToWinner ? `${r.pointsToWinner.toLocaleString('en-IN')} pts` : '—') },
          { key: 'nominations', header: 'Nominations', render: (r) => r._count?.nominations ?? 0 },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          {
            key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
            render: (r) => (
              <div className="inline-flex items-center justify-end gap-1.5">
                <ActionButton onClick={() => setView({ mode: 'detail', id: r.id })} disabled={busyId === r.id}>Open</ActionButton>
                {r.status === 'OPEN' && (
                  <ActionButton onClick={() => closeCycle(r)} disabled={busyId === r.id}>Close nominations</ActionButton>
                )}
              </div>
            ),
          },
        ]}
        rows={items}
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No award cycles yet — create your first Employee of the Month."
      />
      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={data?.total ?? items.length}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={[25, 50, 100]}
        noun="cycles"
      />
      {createOpen && (
        <CycleModal onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); load(); }} />
      )}
    </div>
  );
}

function CycleModal({ initial = null, onClose, onSaved }) {
  const isNew = !initial;
  const [form, setForm] = useState({
    name: initial?.name || '',
    awardType: initial?.awardType || 'EMPLOYEE_OF_THE_MONTH',
    periodLabel: initial?.periodLabel || '',
    nominateOpenAt: toLocalInputValue(initial?.nominateOpenAt) || '',
    nominateCloseAt: toLocalInputValue(initial?.nominateCloseAt) || '',
    pointsToWinner: initial?.pointsToWinner ?? 0,
    maxWinners: initial?.maxWinners ?? 1,
    issueCertificate: initial ? initial.issueCertificate !== false : true,
    committeeUserIds: initial?.committeeUserIds || [],
  });
  const [users, setUsers] = useState([]);
  const [userQ, setUserQ] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Committee = tenant USER accounts (the approvals inbox is user-scoped). Loaded
  // best-effort from /api/business/users (the ChainBuilder precedent) — when the
  // caller can't list users the committee simply stays empty and the decide step
  // falls back to the built-in HR chain.
  useEffect(() => {
    get('/api/business/users')
      .then((u) => setUsers(Array.isArray(u?.users) ? u.users : (u?.items || [])))
      .catch(() => setUsers([]));
  }, []);

  const filteredUsers = useMemo(() => {
    const ql = userQ.trim().toLowerCase();
    return users.filter((u) => !ql || (u.name || '').toLowerCase().includes(ql) || (u.email || '').toLowerCase().includes(ql));
  }, [users, userQ]);
  const userLabel = (id) => {
    const u = users.find((x) => x.id === id);
    return u ? (u.name || u.email) : id;
  };
  const toggleCommittee = (id) => setForm((f) => ({
    ...f,
    committeeUserIds: f.committeeUserIds.includes(id)
      ? f.committeeUserIds.filter((x) => x !== id)
      : [...f.committeeUserIds, id],
  }));

  async function save() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name.trim(),
        awardType: form.awardType.trim(),
        periodLabel: form.periodLabel.trim() || null,
        nominateOpenAt: form.nominateOpenAt ? new Date(form.nominateOpenAt).toISOString() : null,
        nominateCloseAt: form.nominateCloseAt ? new Date(form.nominateCloseAt).toISOString() : null,
        pointsToWinner: Math.max(0, Math.round(Number(form.pointsToWinner)) || 0),
        maxWinners: Math.max(1, Math.round(Number(form.maxWinners)) || 1),
        issueCertificate: !!form.issueCertificate,
        committeeUserIds: form.committeeUserIds,
      };
      if (isNew) await post(`${API}/award-cycles`, payload);
      else await patch(`${API}/award-cycles/${initial.id}`, payload);
      onSaved();
    } catch (e) {
      setError(errMsg(e, 'Failed to save the award cycle.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={isNew ? 'New award cycle' : `Edit “${initial.name}”`} onClose={onClose} wide>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <LabelWithTip label="Name" tip="Shown to employees on the nomination form (e.g. 'Employee of the Month — July')." htmlFor="cy-name" />
            <input id="cy-name" value={form.name} onChange={(e) => set('name', e.target.value)} className={inputCls} placeholder="Employee of the Month — July" />
          </div>
          <div>
            <LabelWithTip label="Award type" tip="A short machine-ish label grouping recurring cycles (e.g. EMPLOYEE_OF_THE_MONTH, INNOVATION_AWARD)." htmlFor="cy-type" />
            <input id="cy-type" value={form.awardType} onChange={(e) => set('awardType', e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <LabelWithTip label="Period label (optional)" tip="A friendly period tag like 'July 2026' or 'Q2 FY27'." htmlFor="cy-period" />
            <input id="cy-period" value={form.periodLabel} onChange={(e) => set('periodLabel', e.target.value)} className={inputCls} />
          </div>
          <div>
            <LabelWithTip label="Nominations open" tip="When employees can start nominating." htmlFor="cy-open" />
            <input id="cy-open" type="datetime-local" value={form.nominateOpenAt} onChange={(e) => set('nominateOpenAt', e.target.value)} className={inputCls} />
          </div>
          <div>
            <LabelWithTip label="Nominations close" tip="After this, HR shortlists and sends to the committee." htmlFor="cy-close" />
            <input id="cy-close" type="datetime-local" value={form.nominateCloseAt} onChange={(e) => set('nominateCloseAt', e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <LabelWithTip label="Prize points" tip="Points credited to each winner's wallet on the committee's approval." htmlFor="cy-points" />
            <input id="cy-points" type="number" min={0} value={form.pointsToWinner} onChange={(e) => set('pointsToWinner', e.target.value)} className={inputCls} />
          </div>
          <div>
            <LabelWithTip label="Max winners" tip="How many winners this cycle can crown." htmlFor="cy-winners" />
            <input id="cy-winners" type="number" min={1} value={form.maxWinners} onChange={(e) => set('maxWinners', e.target.value)} className={inputCls} />
          </div>
          <label className="mt-6 inline-flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.issueCertificate} onChange={(e) => set('issueCertificate', e.target.checked)} />
            Issue certificate
            <InfoTip text="Winners get a PDF award certificate (the letters engine renders it) available under their documents." label="Certificate" />
          </label>
        </div>
        <div>
          <LabelWithTip
            label="Committee (optional)"
            tip="The people who approve the winners — every member must approve. Leave empty to use the standard HR approval chain instead. A committee member who is also the nominee is excluded automatically."
            htmlFor="cy-committee"
          />
          {form.committeeUserIds.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {form.committeeUserIds.map((id) => (
                <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                  {userLabel(id)}
                  <button type="button" onClick={() => toggleCommittee(id)} className="text-gray-400 hover:text-gray-700" aria-label={`Remove ${userLabel(id)}`}>✕</button>
                </span>
              ))}
            </div>
          )}
          {users.length === 0 ? (
            <p className="text-xs text-gray-400">User list unavailable — with no committee the decide step routes through the standard HR approval chain.</p>
          ) : (
            <>
              <input
                id="cy-committee"
                value={userQ}
                onChange={(e) => setUserQ(e.target.value)}
                className={inputCls}
                placeholder="Filter users by name or email…"
              />
              <div className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
                {filteredUsers.map((u) => {
                  const on = form.committeeUserIds.includes(u.id);
                  return (
                    <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-50">
                      <input type="checkbox" checked={on} onChange={() => toggleCommittee(u.id)} />
                      <span className="truncate">{u.name || u.email}</span>
                      {u.email && u.name && <span className="truncate text-xs text-gray-400">{u.email}</span>}
                    </label>
                  );
                })}
                {filteredUsers.length === 0 && <p className="px-2 py-1 text-xs text-gray-400">No matching users.</p>}
              </div>
            </>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <CancelButton onClick={onClose} />
        <PrimaryButton
          onClick={save}
          disabled={saving || !form.name.trim() || !form.awardType.trim() || !form.nominateOpenAt || !form.nominateCloseAt}
        >
          {saving ? 'Saving…' : isNew ? 'Create cycle' : 'Save changes'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// Nomination status chip — StatusBadge's sets don't know these values, so map
// the tone explicitly while keeping the real status text.
const NOMINATION_TONE = {
  SUBMITTED: 'bg-amber-50 text-amber-700 border-amber-200',
  SHORTLISTED: 'bg-blue-50 text-blue-700 border-blue-200',
  WON: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  NOT_SELECTED: 'bg-gray-100 text-gray-600 border-gray-200',
};

function NominationBadge({ status }) {
  const cls = NOMINATION_TONE[status] || 'bg-gray-100 text-gray-600 border-gray-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status === 'NOT_SELECTED' ? 'NOT SELECTED' : status}
    </span>
  );
}

function nominationName(n, who) {
  const e = n[who];
  if (!e) return '—';
  return [e.firstName, e.lastName].filter(Boolean).join(' ') || e.code || '—';
}

function CycleDetail({ id, onBack }) {
  const [cycle, setCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [selected, setSelected] = useState({}); // nominationId → true (for decide)
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`${API}/award-cycles/${id}`)
      .then((r) => setCycle(r.cycle))
      .catch((e) => setError(errMsg(e, 'Failed to load the cycle.')))
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(load, [load]);

  async function closeCycle() {
    setBusyId('close');
    setError('');
    try {
      await post(`${API}/award-cycles/${id}/close`);
      setNotice('Nominations closed. Shortlist below, then send the shortlist to the committee.');
      load();
    } catch (e) {
      setError(errMsg(e, 'Failed to close the cycle.'));
    } finally {
      setBusyId('');
    }
  }

  async function shortlist(nom, on) {
    setBusyId(nom.id);
    setError('');
    try {
      await post(`${API}/award-cycles/${id}/nominations/${nom.id}/shortlist`, { shortlisted: on });
      load();
    } catch (e) {
      setError(errMsg(e, 'Failed to update the shortlist.'));
    } finally {
      setBusyId('');
    }
  }

  async function decide() {
    setBusyId('decide');
    setError('');
    setNotice('');
    try {
      const ids = Object.keys(selected).filter((k) => selected[k]);
      const res = await post(`${API}/award-cycles/${id}/decide`, ids.length ? { nominationIds: ids } : {});
      const n = (res.opened || []).length;
      setNotice(`Sent ${n} nomination${n === 1 ? '' : 's'} to the committee — winners are decided from the Approvals inbox.`);
      setSelected({});
      load();
    } catch (e) {
      setError(errMsg(e, 'Failed to open the committee decision.'));
    } finally {
      setBusyId('');
    }
  }

  const noms = cycle?.nominations || [];
  const shortlistedUndecided = noms.filter((n) => n.status === 'SHORTLISTED' && !n.approvalRequestId);
  const canDecide = cycle?.status === 'CLOSED' && shortlistedUndecided.length > 0;
  const decidable = cycle && cycle.status !== 'DECIDED' && cycle.status !== 'ARCHIVED';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button type="button" onClick={onBack} className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          ← Back to cycles
        </button>
        {cycle && decidable && (
          <div className="flex items-center gap-2">
            <ActionButton onClick={() => setEditOpen(true)} disabled={!!busyId}>Edit cycle</ActionButton>
            {cycle.status === 'OPEN' && (
              <ActionButton onClick={closeCycle} disabled={busyId === 'close'}>Close nominations</ActionButton>
            )}
            {canDecide && (
              <PrimaryButton onClick={decide} disabled={busyId === 'decide'}>
                {busyId === 'decide' ? 'Sending…' : `Declare winner(s)${Object.values(selected).filter(Boolean).length ? ` (${Object.values(selected).filter(Boolean).length})` : ''}`}
              </PrimaryButton>
            )}
          </div>
        )}
      </div>

      {error && <ErrorBanner message={error} />}
      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</div>}

      {loading ? (
        <DataTable columns={[]} rows={[]} loading />
      ) : cycle ? (
        <>
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">{cycle.name}</h2>
                <p className="text-sm text-gray-500">
                  {cycle.awardType}{cycle.periodLabel ? ` · ${cycle.periodLabel}` : ''} · nominations {formatAdminDate(cycle.nominateOpenAt)} → {formatAdminDate(cycle.nominateCloseAt)}
                </p>
              </div>
              <StatusBadge status={cycle.status} />
            </div>
            <div className="mt-3 flex flex-wrap gap-5 text-sm text-gray-600">
              <span>Prize: <span className="font-medium text-gray-900">{cycle.pointsToWinner ? `${cycle.pointsToWinner.toLocaleString('en-IN')} pts` : 'none'}</span></span>
              <span>Max winners: <span className="font-medium text-gray-900">{cycle.maxWinners}</span></span>
              <span>Certificate: <span className="font-medium text-gray-900">{cycle.issueCertificate ? 'yes' : 'no'}</span></span>
              <span>
                Committee: <span className="font-medium text-gray-900">{(cycle.committeeUserIds || []).length || 'HR chain'}</span>
                <InfoTip text="Winner approval is a parallel all-of decision by the committee, taken from the normal Approvals inbox. With no committee, the standard HR chain decides." label="Who decides" />
              </span>
            </div>
          </section>

          <DataTable
            columns={[
              ...(canDecide ? [{
                key: 'pick', header: 'Decide',
                render: (n) => (n.status === 'SHORTLISTED' && !n.approvalRequestId ? (
                  <input
                    type="checkbox"
                    checked={!!selected[n.id]}
                    onChange={(e) => setSelected((s) => ({ ...s, [n.id]: e.target.checked }))}
                    aria-label={`Select ${nominationName(n, 'nominee')} for the committee`}
                  />
                ) : null),
              }] : []),
              { key: 'nominee', header: 'Nominee', render: (n) => <span className="font-medium text-gray-900">{nominationName(n, 'nominee')}</span> },
              { key: 'nominator', header: 'Nominated by', render: (n) => <span className="text-gray-600">{nominationName(n, 'nominator')}</span> },
              {
                key: 'citation', header: 'Citation',
                render: (n) => <span className="block max-w-md truncate text-gray-600" title={n.citation}>{n.citation || '—'}</span>,
              },
              { key: 'createdAt', header: 'Submitted', render: (n) => formatAdminDate(n.createdAt) },
              { key: 'status', header: 'Status', render: (n) => <NominationBadge status={n.status} /> },
              {
                key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
                render: (n) => (decidable && !n.approvalRequestId ? (
                  <>
                    {n.status === 'SUBMITTED' && (
                      <ActionButton tone="positive" onClick={() => shortlist(n, true)} disabled={busyId === n.id}>Shortlist</ActionButton>
                    )}
                    {n.status === 'SHORTLISTED' && (
                      <ActionButton onClick={() => shortlist(n, false)} disabled={busyId === n.id}>Un-shortlist</ActionButton>
                    )}
                  </>
                ) : (n.approvalRequestId && n.status === 'SHORTLISTED' ? <span className="text-xs text-gray-400">With committee</span> : null)),
              },
            ]}
            rows={noms}
            rowKey={(n) => n.id}
            emptyText="No nominations yet."
          />

          {cycle.status === 'CLOSED' && !canDecide && noms.some((n) => n.status === 'SHORTLISTED') && (
            <p className="text-xs text-gray-400">All shortlisted nominations are already with the committee — decisions land in the Approvals inbox.</p>
          )}
          {cycle.status === 'CLOSED' && shortlistedUndecided.length === 0 && !noms.some((n) => n.status === 'SHORTLISTED') && (
            <p className="text-xs text-gray-400">Shortlist at least one nomination to enable “Declare winner(s)”.</p>
          )}
        </>
      ) : null}

      {editOpen && cycle && (
        <CycleModal initial={cycle} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); load(); }} />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Redemptions tab — fulfilment queue + taxable-perks FY report
// ═════════════════════════════════════════════════════════════════════════════
function RedemptionsTab() {
  const [status, setStatus] = useState('APPROVED');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fulfilRow, setFulfilRow] = useState(null);
  const [perks, setPerks] = useState(null);
  const [perksError, setPerksError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`${API}/redemptions`, { status, page, pageSize })
      .then(setData)
      .catch((e) => setError(errMsg(e, 'Failed to load the redemption queue.')))
      .finally(() => setLoading(false));
  }, [status, page, pageSize]);
  useEffect(load, [load]);

  useEffect(() => {
    get(`${API}/reports/taxable-perks`)
      .then(setPerks)
      .catch((e) => setPerksError(errMsg(e, 'Taxable-perks report unavailable.')));
  }, []);

  const items = data?.items || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-600">
          Status
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm">
            {REDEMPTION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <span className="inline-flex items-center text-xs text-gray-400">
          Points were already debited on approval — fulfilling delivers the reward
          <InfoTip text="APPROVED rows are waiting on you: paste the voucher code or confirm the perk was granted. Comp-off rewards auto-mint the leave credit when you fulfil. PENDING rows are still in the approval chain." label="Queue" />
        </span>
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={[
          { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{employeeLabel(r)}</span> },
          {
            key: 'item', header: 'Reward',
            render: (r) => (
              <div className="min-w-0">
                <span className="text-gray-900">{r.catalogItem?.name || '—'}</span>
                <div className="text-xs text-gray-400">{r.catalogItem?.category}{r.catalogItem?.isTaxablePerk ? ' · taxable' : ''}</div>
              </div>
            ),
          },
          { key: 'points', header: 'Points', render: (r) => (r.pointsSpent || 0).toLocaleString('en-IN') },
          { key: 'inr', header: '₹ value', render: (r) => (r.catalogItem?.inrValue != null ? `₹${Number(r.catalogItem.inrValue).toLocaleString('en-IN')}` : '—') },
          { key: 'createdAt', header: 'Requested', render: (r) => formatAdminDate(r.createdAt) },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          {
            key: 'ref', header: 'Fulfilment ref',
            render: (r) => (r.fulfilmentRef ? <code className="rounded bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600">{r.fulfilmentRef}</code> : '—'),
          },
          {
            key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
            render: (r) => (r.status === 'APPROVED' ? (
              <ActionButton tone="positive" onClick={() => setFulfilRow(r)}>Fulfil</ActionButton>
            ) : null),
          },
        ]}
        rows={items}
        loading={loading}
        rowKey={(r) => r.id}
        emptyText={status === 'APPROVED' ? 'Nothing waiting for fulfilment. 🎉' : 'No redemptions with this status.'}
      />
      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={data?.total ?? items.length}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={[25, 50, 100]}
        noun="redemptions"
      />

      {/* ── taxable perks (Finance) ── */}
      <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Taxable perks — FY {perks?.financialYear || '…'}
          <InfoTip text={`Redeemed ₹ value per employee this financial year. Anyone above ₹${(perks?.limitInr || 5000).toLocaleString('en-IN')} crosses the Section 17(2) gift-perquisite line and should be flagged to payroll/Finance.`} label="Why this table" />
        </h2>
        <p className="mb-4 text-xs text-gray-400">Approved + fulfilled redemptions with a ₹ value, April → March.</p>
        {perksError && <ErrorBanner message={perksError} />}
        <DataTable
          columns={[
            { key: 'name', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{r.name || r.employeeId}{r.code ? <span className="ml-1 text-xs text-gray-400">({r.code})</span> : null}</span> },
            { key: 'totalInr', header: '₹ redeemed this FY', render: (r) => `₹${Number(r.totalInr || 0).toLocaleString('en-IN')}` },
            {
              key: 'crossesLimit', header: `Above ₹${(perks?.limitInr || 5000).toLocaleString('en-IN')}?`,
              render: (r) => (r.crossesLimit
                ? <span className="inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Yes — taxable</span>
                : <span className="text-xs text-gray-400">No</span>),
            },
          ]}
          rows={perks?.rows || []}
          loading={!perks && !perksError}
          rowKey={(r) => r.employeeId}
          emptyText="No ₹-valued redemptions this financial year."
        />
      </section>

      {fulfilRow && (
        <FulfilModal row={fulfilRow} onClose={() => setFulfilRow(null)} onDone={() => { setFulfilRow(null); load(); }} />
      )}
    </div>
  );
}

function FulfilModal({ row, onClose, onDone }) {
  const [ref, setRef] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const type = row.catalogItem?.fulfilmentType || 'MANUAL';
  const needsCode = type === 'VOUCHER_CODE';

  async function fulfil() {
    setSaving(true);
    setError('');
    try {
      await post(`${API}/redemptions/${row.id}/fulfil`, { fulfilmentRef: ref.trim() || null });
      onDone();
    } catch (e) {
      setError(errMsg(e, 'Failed to fulfil the redemption.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Fulfil “${row.catalogItem?.name || 'reward'}”`} onClose={onClose}>
      {error && <div className="mb-3"><ErrorBanner message={error} /></div>}
      <p className="text-sm text-gray-600">
        For <span className="font-medium text-gray-900">{employeeLabel(row)}</span> · {(row.pointsSpent || 0).toLocaleString('en-IN')} points
        {row.catalogItem?.inrValue != null ? ` · ₹${Number(row.catalogItem.inrValue).toLocaleString('en-IN')}` : ''}
      </p>
      {type === 'COMP_OFF_GRANT' ? (
        <p className="mt-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          Fulfilling mints one comp-off leave credit automatically — the reference below is optional.
        </p>
      ) : null}
      <div className="mt-4">
        <LabelWithTip
          label={needsCode ? 'Voucher code' : 'Fulfilment note / reference (optional)'}
          tip={needsCode
            ? 'The code the employee will see on their redemption ("revealed on fulfilment"). Required for voucher rewards.'
            : 'A note or reference stored on the redemption and shown to the employee (e.g. "handed over 21 Jul", courier AWB).'}
          htmlFor="ful-ref"
        />
        <input id="ful-ref" value={ref} onChange={(e) => setRef(e.target.value)} className={inputCls} placeholder={needsCode ? 'e.g. AMZN-XXXX-YYYY' : 'Optional'} />
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <CancelButton onClick={onClose} />
        <PrimaryButton onClick={fulfil} disabled={saving || (needsCode && !ref.trim())}>
          {saving ? 'Fulfilling…' : 'Mark fulfilled'}
        </PrimaryButton>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Leaderboard tab
// ═════════════════════════════════════════════════════════════════════════════
function LeaderboardTab() {
  const [board, setBoard] = useState('earners');
  const [period, setPeriod] = useState('month');
  const [departmentId, setDepartmentId] = useState('');
  const [departments, setDepartments] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/hr/org/departments').then((r) => setDepartments(r.items || r || [])).catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get(`${API}/reports/leaderboard`, { board, period, departmentId: board === 'values' ? '' : departmentId })
      .then(setData)
      .catch((e) => setError(errMsg(e, 'Failed to load the leaderboard.')))
      .finally(() => setLoading(false));
  }, [board, period, departmentId]);
  useEffect(load, [load]);

  const rows = data?.rows || [];
  const columns = board === 'values'
    ? [
      { key: 'rank', header: '#', render: (r) => <span className="font-semibold text-gray-900">{r.rank}</span> },
      { key: 'value', header: 'Value', render: (r) => <ValueChip value={r.value} /> },
      { key: 'count', header: 'Times celebrated', render: (r) => (r.count || 0).toLocaleString('en-IN') },
    ]
    : [
      { key: 'rank', header: '#', render: (r) => <span className="font-semibold text-gray-900">{r.rank}</span> },
      { key: 'name', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{r.name || r.employeeId}{r.code ? <span className="ml-1 text-xs text-gray-400">({r.code})</span> : null}</span> },
      board === 'earners'
        ? { key: 'points', header: 'Points earned', render: (r) => (r.points || 0).toLocaleString('en-IN') }
        : { key: 'count', header: 'Recognitions given', render: (r) => (r.count || 0).toLocaleString('en-IN') },
    ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-600">
          Board
          <select value={board} onChange={(e) => setBoard(e.target.value)} className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm">
            {BOARDS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </label>
        <label className="text-sm text-gray-600">
          Window
          <select value={period} onChange={(e) => setPeriod(e.target.value)} className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm">
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </label>
        {board !== 'values' && (
          <label className="text-sm text-gray-600">
            Team
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm">
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name || d.code}</option>)}
            </select>
          </label>
        )}
      </div>
      {error && <ErrorBanner message={error} />}
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        rowKey={(r) => r.employeeId || r.valueId}
        emptyText="Nothing on this board yet — recognitions will light it up."
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════
const TABS = [
  { key: 'program', label: 'Program' },
  { key: 'budgets', label: 'Budgets' },
  { key: 'catalog', label: 'Catalog' },
  { key: 'awards', label: 'Awards' },
  { key: 'redemptions', label: 'Redemptions' },
  { key: 'leaderboard', label: 'Leaderboard' },
];

export default function RecognitionPage() {
  const [tab, setTab] = useState('program');

  return (
    <div>
      <PageHeader
        title="Rewards & Recognition"
        subtitle="Peer kudos with points, reward redemptions, and nomination-based awards."
      />

      <ModuleGuide
        id="recognition"
        title="Run a points-powered recognition program"
        what="Employees give each other public shout-outs tied to company values, optionally with points. Points land in a wallet and are spent in a rewards catalog; nomination awards (Employee of the Month) run on cycles with a committee decision. Budgets and thresholds route big gives through approvals."
        steps={[
          'On Program, switch on points, set the ₹-per-point shadow and the approval threshold, then curate values and badges (or Restore defaults).',
          'Add point Budgets per giver / department / entity / company so generosity has a governed ceiling.',
          'Build the Catalog — vouchers, perks, swag, comp-off — with points cost, ₹ value and the taxable-perk flag.',
          'Create an Award cycle with a nomination window, prize points and a committee; employees nominate from their portal.',
          'After the window: open the cycle, shortlist, then “Declare winner(s)” — the committee approves from the Approvals inbox.',
          'Work the Redemptions queue: fulfil approved redemptions with a voucher code or perk confirmation.',
        ]}
        example={<>HR at <b>Acme India Pvt Ltd</b> enables points at <b>1 pt = ₹1</b> with a 500-point approval threshold. Asha recognises Ravi for <b>Customer First</b> (+100 pts); Ravi redeems a <b>₹500 voucher</b> which Finance fulfils with a code. In July the <b>Employee of the Month</b> cycle crowns a winner — 1,000 points + a PDF certificate.</>}
        tips={[
          'Retire values, badges and catalog items instead of deleting — history and past redemptions stay intact.',
          'Committee/budget/redemption approvals ride the normal Approvals inbox — there is no separate approval screen here.',
          'The Redemptions tab needs the fulfilment permission; the rest of the page needs the manage-recognition permission.',
        ]}
      />

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'program' && <ProgramTab />}
      {tab === 'budgets' && <BudgetsTab />}
      {tab === 'catalog' && <CatalogTab />}
      {tab === 'awards' && <AwardsTab />}
      {tab === 'redemptions' && <RedemptionsTab />}
      {tab === 'leaderboard' && <LeaderboardTab />}
    </div>
  );
}
