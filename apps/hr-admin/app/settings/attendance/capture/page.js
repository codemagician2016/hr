'use client';

/**
 * Attendance Capture (hr-admin) — Feature 2 multi-mode capture policy console.
 *
 * Settings → Attendance → Attendance capture (canManageAttendance-gated server-side;
 * this page is UX only). Three tabs:
 *   • Policies     — per-tenant / per-scope (entity / location / department) choice of
 *                    required punch methods (GEO_FENCE / IP_RESTRICTED / FACE), each
 *                    with a WARN-vs-ENFORCE lever, plus the FACE match threshold.
 *   • Office IPs    — the allowed office CIDR allow-list per LOCATION (IP_RESTRICTED).
 *   • Review queue  — flagged punches (off-network / low face score / needs-review)
 *                    a human CLEARS or REJECTS. Shows the stored selfie + the geo/IP
 *                    /face evidence for each.
 *
 * GEO_FENCE reuses the existing per-Location geofence (geoLat/geoLng/geofenceM set on
 * the Location); this page only flips the policy require/enforce levers on top.
 */

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, Spinner, formatAdminDateTime } from '@hr/ui';
import { get, post, del } from '@/lib/api';
import { PageHeader, Tabs, DataTable, StatusBadge, ActionButton } from '@/lib/ui';
import { SectionTitle, InfoTip } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';

const SCOPES = [
  { value: 'TENANT', label: 'Whole company (default)' },
  { value: 'ENTITY', label: 'Entity / legal unit' },
  { value: 'LOCATION', label: 'Location / site' },
  { value: 'EMPLOYEE_GROUP', label: 'Department (employee group)' },
];

export default function AttendanceCapturePage() {
  const [tab, setTab] = useState('policies');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 3000); };

  return (
    <div className="p-6 sm:p-8 space-y-5">
      <PageHeader
        title="Attendance capture"
        subtitle="Choose how employees prove an on-site punch — geo-fence, office network (IP), and/or face match — per company, entity, location or department."
      />
      <ModuleGuide
        id="settings-attendance-capture"
        title="Decide how staff prove an on-site punch"
        what="Set the rules that an employee's clock-in must satisfy — being inside a location's geo-fence, on an approved office network (IP), and/or passing a selfie face match. Rules can be company-wide or narrowed to an entity, location or department, and each method can simply flag a bad punch or hard-reject it."
        steps={[
          "On Policies, pick who it applies to (whole company, or a specific entity / location / department) and the target.",
          "For each method — Geo-fence, Office network (IP), Face match — tick Required, then tick Enforce only if a failing punch should be rejected (leave Enforce off to merely flag for review).",
          "For Face match, set the Match threshold (e.g. 0.70); selfies scoring below it land in the Review queue.",
          "Add your office ranges under Office IPs (per location) before enforcing IP, e.g. 203.0.113.0/24 labelled 'HQ wifi'.",
          "Save the policy, then clear or reject flagged punches under Review queue using the stored selfie and geo/IP/face evidence.",
        ]}
        example={<>Acme India Pvt Ltd sets a <b>Location</b> policy for its Pune office: <b>Geo-fence Required + Enforce</b> and <b>Face match Required</b> at threshold <b>0.70</b> (flag only). When <b>Aarav Sharma</b> punches in at 9:32 IST from 120 m outside the fence, the punch is rejected; a face score of 0.61 instead routes to the Review queue for an HR admin to clear or reject.</>}
        tips={[
          "Most specific policy wins: Department → Location → Entity → Company, so a department rule overrides the company default.",
          "Enforce IP only after adding the location's CIDR ranges — otherwise every on-site punch from that office looks off-network and gets blocked.",
        ]}
      />
      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div> : null}
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'policies', label: 'Policies' },
          { key: 'ips', label: 'Office IPs' },
          { key: 'review', label: 'Review queue' },
        ]}
      />
      {tab === 'policies' ? <PoliciesTab setError={setError} flash={flash} /> : null}
      {tab === 'ips' ? <OfficeIpsTab setError={setError} flash={flash} /> : null}
      {tab === 'review' ? <ReviewTab setError={setError} flash={flash} /> : null}
    </div>
  );
}

/* ── Policies ──────────────────────────────────────────────────────────────── */
function PoliciesTab({ setError, flash }) {
  const [items, setItems] = useState(null);
  const [entities, setEntities] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState(blankPolicy());
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    get('/api/hr/attendance/capture/policies')
      .then((r) => setItems(r.items || []))
      .catch((e) => setError(e.message));
  }, [setError]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    get('/api/hr/org/entities').then((r) => setEntities(r.items || r || [])).catch(() => {});
    get('/api/hr/org/locations').then((r) => setLocations(r.items || r || [])).catch(() => {});
    get('/api/hr/org/departments').then((r) => setDepartments(r.items || r || [])).catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setError('');
    try {
      await post('/api/hr/attendance/capture/policies', form);
      flash('Policy saved.');
      setForm(blankPolicy());
      load();
    } catch (e) { setError(e.data?.message || e.message); } finally { setSaving(false); }
  }

  async function remove(id) {
    if (!window.confirm('Delete this capture policy?')) return;
    try { await del(`/api/hr/attendance/capture/policies/${id}`); flash('Policy deleted.'); load(); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  const scopeOptions = form.scope === 'ENTITY' ? entities
    : form.scope === 'LOCATION' ? locations
      : form.scope === 'EMPLOYEE_GROUP' ? departments : [];

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
        <SectionTitle tip="The most specific matching policy wins: Department → Location → Entity → Company.">
          Add / update a policy
        </SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="text-sm">
            <span className="block font-medium text-gray-700 mb-1">Applies to</span>
            <select
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              value={form.scope}
              onChange={(e) => setForm({ ...form, scope: e.target.value, scopeId: '' })}
            >
              {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          {form.scope !== 'TENANT' ? (
            <label className="text-sm">
              <span className="block font-medium text-gray-700 mb-1">Target</span>
              <select
                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                value={form.scopeId}
                onChange={(e) => setForm({ ...form, scopeId: e.target.value })}
              >
                <option value="">Select…</option>
                {scopeOptions.map((o) => <option key={o.id} value={o.id}>{o.code ? `${o.code} — ${o.name}` : o.name}</option>)}
              </select>
            </label>
          ) : <div />}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <ModeCard
            title="Geo-fence"
            tip="Punch must fall inside the location's geofence radius (set on the location). Enforce = reject an off-site punch; otherwise flag it."
            required={form.requireGeo}
            enforce={form.geoEnforce}
            onRequired={(v) => setForm({ ...form, requireGeo: v })}
            onEnforce={(v) => setForm({ ...form, geoEnforce: v })}
          />
          <ModeCard
            title="Office network (IP)"
            tip="Punch must come from an approved office IP range (set under the Office IPs tab). Enforce = reject an off-network punch; otherwise flag it."
            required={form.requireIp}
            enforce={form.ipEnforce}
            onRequired={(v) => setForm({ ...form, requireIp: v })}
            onEnforce={(v) => setForm({ ...form, ipEnforce: v })}
          />
          <ModeCard
            title="Face match"
            tip="Employee captures a selfie at punch; it is stored and matched against their enrolled reference. The default matcher defers low-confidence matches to this review queue."
            required={form.requireFace}
            enforce={form.faceEnforce}
            onRequired={(v) => setForm({ ...form, requireFace: v })}
            onEnforce={(v) => setForm({ ...form, faceEnforce: v })}
          >
            <label className="block text-xs text-gray-600 mt-2">
              Match threshold
              <input
                type="number" min="0" max="1" step="0.05"
                className="ml-2 w-20 px-2 py-1 border border-gray-300 rounded"
                value={form.faceThreshold}
                onChange={(e) => setForm({ ...form, faceThreshold: e.target.value })}
              />
            </label>
          </ModeCard>
        </div>
        <PrimaryButton onClick={save} loading={saving} disabled={form.scope !== 'TENANT' && !form.scopeId}>
          Save policy
        </PrimaryButton>
      </div>

      <DataTable
        loading={items === null}
        emptyText="No capture policies yet — the company default behaves as before (geofence only flags, IP/face off)."
        rowKey={(r) => r.id}
        columns={[
          { key: 'scope', header: 'Scope', render: (r) => <span>{r.scope}{r.scopeId ? ` · ${r.scopeId.slice(0, 8)}…` : ''}</span> },
          { key: 'geo', header: 'Geo', render: (r) => modeCell(r.requireGeo, r.geoEnforce) },
          { key: 'ip', header: 'IP', render: (r) => modeCell(r.requireIp, r.ipEnforce) },
          { key: 'face', header: 'Face', render: (r) => modeCell(r.requireFace, r.faceEnforce) },
          { key: 'threshold', header: 'Face ≥', render: (r) => (r.requireFace ? r.faceThreshold : '—') },
          { key: 'actions', header: '', render: (r) => <ActionButton tone="danger" onClick={() => remove(r.id)}>Delete</ActionButton> },
        ]}
        rows={items || []}
      />
    </div>
  );
}

function modeCell(required, enforce) {
  if (!required) return <span className="text-gray-400">off</span>;
  return <StatusBadge status={enforce ? 'ENFORCE' : 'WARN'} />;
}

function ModeCard({ title, tip, required, enforce, onRequired, onEnforce, children }) {
  return (
    <div className="rounded-xl border border-gray-200 p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm text-gray-800">{title}</span>
        <InfoTip text={tip} />
      </div>
      <label className="flex items-center gap-2 mt-2 text-sm">
        <input type="checkbox" checked={required} onChange={(e) => onRequired(e.target.checked)} /> Required
      </label>
      <label className={`flex items-center gap-2 mt-1 text-sm ${required ? '' : 'opacity-40'}`}>
        <input type="checkbox" checked={enforce} disabled={!required} onChange={(e) => onEnforce(e.target.checked)} /> Enforce (reject)
      </label>
      {children}
    </div>
  );
}

function blankPolicy() {
  return {
    scope: 'TENANT', scopeId: '',
    requireGeo: false, requireIp: false, requireFace: false,
    geoEnforce: false, ipEnforce: false, faceEnforce: false,
    faceThreshold: 0.7, isActive: true,
  };
}

/* ── Office IPs ────────────────────────────────────────────────────────────── */
function OfficeIpsTab({ setError, flash }) {
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [ips, setIps] = useState(null);
  const [cidr, setCidr] = useState('');
  const [label, setLabel] = useState('');

  useEffect(() => {
    get('/api/hr/org/locations').then((r) => setLocations(r.items || r || [])).catch((e) => setError(e.message));
  }, [setError]);

  const load = useCallback((id) => {
    if (!id) { setIps(null); return; }
    get(`/api/hr/attendance/capture/locations/${id}/ips`).then((r) => setIps(r.items || [])).catch((e) => setError(e.message));
  }, [setError]);

  useEffect(() => { load(locationId); }, [locationId, load]);

  async function add() {
    if (!cidr.trim()) return;
    setError('');
    try {
      await post(`/api/hr/attendance/capture/locations/${locationId}/ips`, { cidr: cidr.trim(), label: label.trim() || null });
      flash('CIDR added.'); setCidr(''); setLabel(''); load(locationId);
    } catch (e) { setError(e.data?.message || e.message); }
  }
  async function remove(id) {
    try { await del(`/api/hr/attendance/capture/locations/${locationId}/ips/${id}`); flash('CIDR removed.'); load(locationId); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  return (
    <div className="space-y-5">
      <label className="text-sm block max-w-md">
        <span className="block font-medium text-gray-700 mb-1">Location</span>
        <select className="w-full px-3 py-2 border border-gray-300 rounded-lg" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
          <option value="">Select a location…</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.code ? `${l.code} — ${l.name}` : l.name}</option>)}
        </select>
      </label>

      {locationId ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">
              <span className="block font-medium text-gray-700 mb-1">CIDR or IP</span>
              <input className="px-3 py-2 border border-gray-300 rounded-lg w-56" placeholder="203.0.113.0/24" value={cidr} onChange={(e) => setCidr(e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="block font-medium text-gray-700 mb-1">Label (optional)</span>
              <input className="px-3 py-2 border border-gray-300 rounded-lg w-48" placeholder="HQ wifi" value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <PrimaryButton onClick={add} disabled={!cidr.trim()}>Add</PrimaryButton>
          </div>
          <DataTable
            loading={ips === null}
            emptyText="No office IP ranges for this location yet."
            rowKey={(r) => r.id}
            columns={[
              { key: 'cidr', header: 'CIDR', render: (r) => <code className="text-xs">{r.cidr}</code> },
              { key: 'label', header: 'Label', render: (r) => r.label || '—' },
              { key: 'actions', header: '', render: (r) => <ActionButton tone="danger" onClick={() => remove(r.id)}>Remove</ActionButton> },
            ]}
            rows={ips || []}
          />
        </>
      ) : null}
    </div>
  );
}

/* ── Review queue ─────────────────────────────────────────────────────────── */
function ReviewTab({ setError, flash }) {
  const [status, setStatus] = useState('PENDING');
  const [data, setData] = useState(null);

  const load = useCallback(() => {
    setData(null);
    get(`/api/hr/attendance/capture/review?status=${status}`).then(setData).catch((e) => setError(e.message));
  }, [status, setError]);
  useEffect(() => { load(); }, [load]);

  async function act(id, decision) {
    try { await post(`/api/hr/attendance/capture/review/${id}`, { decision }); flash(decision === 'CLEAR' ? 'Cleared.' : 'Rejected.'); load(); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        {['PENDING', 'CLEARED', 'REJECTED'].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`px-3 py-1 rounded-full border ${status === s ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-600'}`}
          >{s}</button>
        ))}
      </div>
      {data === null ? <Spinner /> : (
        <DataTable
          emptyText="No flagged punches in this state."
          rowKey={(r) => r.id}
          columns={[
            { key: 'emp', header: 'Employee', render: (r) => (r.employee ? `${r.employee.firstName || ''} ${r.employee.lastName || ''} (${r.employee.code || ''})` : r.employeeId.slice(0, 8)) },
            { key: 'when', header: 'When', render: (r) => formatAdminDateTime(r.punchAt) },
            { key: 'type', header: 'Type', render: (r) => r.punchType },
            { key: 'reasons', header: 'Flags', render: (r) => (r.captureFlagReasons || []).join(', ') || '—' },
            { key: 'geo', header: 'Geo', render: (r) => (r.outOfGeofence ? `OUT ${r.geoDistanceM ?? ''}m` : r.outOfGeofence === false ? 'in' : '—') },
            { key: 'ip', header: 'IP', render: (r) => (r.ipAllowed === false ? `off-net (${r.ipAddress || '?'})` : r.ipAllowed === true ? 'on-net' : (r.ipAddress || '—')) },
            { key: 'face', header: 'Face', render: (r) => r.faceMatchStatus || '—' },
            { key: 'selfie', header: 'Selfie', render: (r) => (r.selfieUrl ? <a className="text-blue-600 underline text-xs" href={r.selfieUrl} target="_blank" rel="noreferrer">view</a> : '—') },
            { key: 'actions', header: '', render: (r) => (status === 'PENDING' ? (
              <span className="flex gap-2">
                <ActionButton tone="positive" onClick={() => act(r.id, 'CLEAR')}>Clear</ActionButton>
                <ActionButton tone="danger" onClick={() => act(r.id, 'REJECT')}>Reject</ActionButton>
              </span>
            ) : (r.reviewStatus || '')) },
          ]}
          rows={data.items || []}
        />
      )}
    </div>
  );
}
