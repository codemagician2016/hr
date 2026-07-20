'use client';

/**
 * Attendance Capture (hr-admin) — Feature 2 multi-mode capture policy console,
 * extended by Feature 39 (face & geo attendance controls). Five tabs:
 *   • Policies       — per-tenant / per-scope (entity / location / department /
 *                      individual employee) choice of required punch methods
 *                      (GEO_FENCE / IP_RESTRICTED / FACE), each with a
 *                      WARN-vs-ENFORCE lever, plus the FACE match threshold.
 *   • Office IPs     — the allowed office CIDR allow-list per LOCATION (IP_RESTRICTED).
 *   • Geofences      — F39 map-drawn polygon zones (Leaflet/OSM editor) attachable to
 *                      office locations or to ONE employee (individual restriction),
 *                      plus an effective-zones inspector per employee.
 *   • Face approvals — F39 face-enrolment register: PENDING queue (approve /
 *                      reject-with-reason), ACTIVE roster (revoke), HR enrol-on-behalf.
 *   • Review queue   — flagged punches (off-network / low face score / needs-review)
 *                      a human CLEARS or REJECTS. Shows the stored selfie + the geo/IP
 *                      /face evidence for each.
 *
 * GEO_FENCE zone resolution (server-side): employee-scoped fences beat the office's
 * location fences, which beat the legacy per-Location radius (geoLat/geoLng/geofenceM).
 */

import 'leaflet/dist/leaflet.css';

import { useCallback, useEffect, useState } from 'react';
import { Empty, ErrorBanner, Modal, ModalActions, PrimaryButton, Spinner, TextArea, TextInput, formatAdminDateTime } from '@hr/ui';
import { get, post, del } from '@/lib/api';
import { PageHeader, Tabs, DataTable, StatusBadge, ActionButton, ServerPagination, employeeLabel } from '@/lib/ui';
import { SectionTitle, InfoTip } from '@/lib/widgets';
import ModuleGuide from '@/components/ModuleGuide';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';
import GeoFenceMapEditor, { ZonesMap } from '@/components/GeoFenceMapEditor';

const SCOPES = [
  { value: 'TENANT', label: 'Whole company (default)' },
  { value: 'ENTITY', label: 'Entity / legal unit' },
  { value: 'LOCATION', label: 'Location / site' },
  { value: 'EMPLOYEE_GROUP', label: 'Department (employee group)' },
  { value: 'EMPLOYEE', label: 'Individual employee' },
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
        subtitle="Choose how employees prove an on-site punch — geo-fence, office network (IP), and/or face match — per company, entity, location, department or individual employee."
      />
      <ModuleGuide
        id="settings-attendance-capture"
        title="Decide how staff prove an on-site punch"
        what="Set the rules that an employee's clock-in must satisfy — being inside a location's geo-fence, on an approved office network (IP), and/or passing a selfie face match. Rules can be company-wide or narrowed to an entity, location or department, and each method can simply flag a bad punch or hard-reject it."
        steps={[
          "On Policies, pick who it applies to (whole company, or a specific entity / location / department / one employee) and the target.",
          "For each method — Geo-fence, Office network (IP), Face match — tick Required, then tick Enforce only if a failing punch should be rejected (leave Enforce off to merely flag for review).",
          "For Face match, set the Match threshold (e.g. 0.70); selfies scoring below it land in the Review queue.",
          "Add your office ranges under Office IPs (per location) before enforcing IP, e.g. 203.0.113.0/24 labelled 'HQ wifi'.",
          "Under Geofences, draw polygon zones on the map (click to add corners, drag to adjust) and attach each fence to a location — or to one employee to restrict where that person may punch.",
          "Under Face approvals, eyeball each pending selfie and Approve or Reject (with a reason the employee sees); only an approved face can face-punch. Use 'Enrol on behalf' at the onboarding desk.",
          "Save the policy, then clear or reject flagged punches under Review queue using the stored selfie and geo/IP/face evidence.",
        ]}
        example={<>Acme India Pvt Ltd sets a <b>Location</b> policy for its Pune office: <b>Geo-fence Required + Enforce</b> and <b>Face match Required</b> at threshold <b>0.70</b> (flag only). When <b>Aarav Sharma</b> punches in at 9:32 IST from 120 m outside the fence, the punch is rejected; a face score of 0.61 instead routes to the Review queue for an HR admin to clear or reject.</>}
        tips={[
          "Most specific policy wins: Employee → Department → Location → Entity → Company, so a per-person rule overrides everything else.",
          "Enforce IP only after adding the location's CIDR ranges — otherwise every on-site punch from that office looks off-network and gets blocked.",
          "A fence attached to an employee overrides their office zones — they may then punch only inside their personal zones.",
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
          { key: 'geofences', label: 'Geofences' },
          { key: 'faces', label: 'Face approvals' },
          { key: 'review', label: 'Review queue' },
        ]}
      />
      {tab === 'policies' ? <PoliciesTab setError={setError} flash={flash} /> : null}
      {tab === 'ips' ? <OfficeIpsTab setError={setError} flash={flash} /> : null}
      {tab === 'geofences' ? <GeofencesTab setError={setError} flash={flash} /> : null}
      {tab === 'faces' ? <FaceApprovalsTab setError={setError} flash={flash} /> : null}
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
        <SectionTitle tip="The most specific matching policy wins: Employee → Department → Location → Entity → Company.">
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
          {form.scope === 'EMPLOYEE' ? (
            <EmployeeSearchSelect
              label="Target"
              tip="This one person's policy — it beats every wider scope (department, location, entity, company)."
              value={form.scopeId}
              onSelect={(emp) => setForm({ ...form, scopeId: emp ? emp.id : '' })}
            />
          ) : form.scope !== 'TENANT' ? (
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

/* ── Geofences (Feature 39) ───────────────────────────────────────────────── */
function GeofencesTab({ setError, flash }) {
  const [items, setItems] = useState(null);
  const [locations, setLocations] = useState([]);
  const [editing, setEditing] = useState(null);   // null | {} (new) | fence row (edit)
  const [attaching, setAttaching] = useState(null); // fence row

  const load = useCallback(() => {
    get('/api/hr/attendance/capture/fences')
      .then((r) => setItems(r.items || []))
      .catch((e) => setError(e.message));
  }, [setError]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    get('/api/hr/org/locations').then((r) => setLocations(r.items || r || [])).catch(() => {});
  }, []);

  async function removeFence(id) {
    if (!window.confirm('Delete this geofence? Its links to locations/employees are removed too.')) return;
    try { await del(`/api/hr/attendance/capture/fences/${id}`); flash('Fence deleted.'); load(); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  async function removeLink(fenceId, linkId) {
    try { await del(`/api/hr/attendance/capture/fences/${fenceId}/links/${linkId}`); flash('Link removed.'); load(); }
    catch (e) { setError(e.data?.message || e.message); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle tip="Draw a zone on the map, then attach it to an office location (everyone at that office punches inside it) or to ONE employee (that person may only punch inside their personal zones — they override the office zones).">
          Polygon geofence zones
        </SectionTitle>
        <PrimaryButton onClick={() => setEditing({})}>New fence</PrimaryButton>
      </div>

      <DataTable
        loading={items === null}
        emptyText="No geofences yet — punches fall back to each location's radius geofence (set on the location)."
        rowKey={(r) => r.id}
        columns={[
          {
            key: 'name',
            header: 'Fence',
            render: (r) => (
              <span>
                <span className="font-medium text-gray-900">{r.name}</span>
                {r.description ? <span className="block text-xs text-gray-500">{r.description}</span> : null}
              </span>
            ),
          },
          { key: 'points', header: 'Points', render: (r) => (Array.isArray(r.polygonJson) ? r.polygonJson.length : '—') },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
          {
            key: 'links',
            header: 'Linked to',
            render: (r) => ((r.links || []).length === 0 ? (
              <span className="text-gray-400 text-xs">not attached</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {r.links.map((l) => (
                  <span key={l.id} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-700">
                    <span className="text-gray-400">{l.scopeKind === 'LOCATION' ? 'Loc' : 'Emp'}</span>
                    {l.label}
                    <button
                      type="button"
                      onClick={() => removeLink(r.id, l.id)}
                      className="text-gray-400 hover:text-red-600 leading-none"
                      aria-label={`Detach ${l.label}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </span>
            )),
          },
          {
            key: 'actions',
            header: '',
            render: (r) => (
              <span className="flex gap-2 justify-end">
                <ActionButton onClick={() => setAttaching(r)}>Attach</ActionButton>
                <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
                <ActionButton tone="danger" onClick={() => removeFence(r.id)}>Delete</ActionButton>
              </span>
            ),
          },
        ]}
        rows={items || []}
      />

      <ZoneInspector setError={setError} />

      {editing !== null ? (
        <FenceEditorModal
          fence={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); flash('Fence saved.'); load(); }}
        />
      ) : null}
      {attaching ? (
        <AttachFenceModal
          fence={attaching}
          locations={locations}
          onClose={() => setAttaching(null)}
          onSaved={() => { setAttaching(null); flash('Fence attached.'); load(); }}
        />
      ) : null}
    </div>
  );
}

// Full-width modal for the map editor — same look as @hr/ui Modal, wider body
// (the shared Modal caps at max-w-2xl, too narrow to draw a site comfortably).
function WideModal({ title, onClose, children }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/30 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-4xl max-h-[calc(100vh-2rem)] flex flex-col my-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-gray-100 flex-shrink-0">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-2xl leading-none" aria-label="Close">×</button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function FenceEditorModal({ fence, onClose, onSaved }) {
  const [name, setName] = useState(fence?.name || '');
  const [description, setDescription] = useState(fence?.description || '');
  // ring is GeoJSON [lng,lat] — the editor converts to/from Leaflet [lat,lng].
  const [ring, setRing] = useState(Array.isArray(fence?.polygonJson) ? fence.polygonJson : []);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setErr('');
    try {
      const body = { name: name.trim(), description: description.trim() || null, polygonJson: ring };
      if (fence?.id) body.id = fence.id;
      await post('/api/hr/attendance/capture/fences', body);
      onSaved();
    } catch (e) { setErr(e.data?.message || e.message); } finally { setSaving(false); }
  }

  return (
    <WideModal title={fence?.id ? 'Edit geofence' : 'New geofence'} onClose={onClose}>
      <div className="space-y-4">
        {err ? <ErrorBanner message={err} /> : null}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TextInput label="Name" value={name} onChange={setName} required placeholder="Pune office — building A" />
          <TextInput label="Description (optional)" value={description} onChange={setDescription} placeholder="Main campus incl. parking" />
        </div>
        <GeoFenceMapEditor initialRing={fence?.polygonJson} onChange={setRing} />
        <ModalActions>
          <ActionButton onClick={onClose}>Cancel</ActionButton>
          <PrimaryButton onClick={save} loading={saving} disabled={!name.trim() || ring.length < 3}>
            {fence?.id ? 'Save changes' : 'Create fence'}
          </PrimaryButton>
        </ModalActions>
      </div>
    </WideModal>
  );
}

function AttachFenceModal({ fence, locations, onClose, onSaved }) {
  const [scopeKind, setScopeKind] = useState('LOCATION');
  const [scopeId, setScopeId] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setErr('');
    try {
      await post(`/api/hr/attendance/capture/fences/${fence.id}/links`, { scopeKind, scopeId });
      onSaved();
    } catch (e) { setErr(e.data?.message || e.message); } finally { setSaving(false); }
  }

  return (
    <Modal title={`Attach "${fence.name}"`} onClose={onClose}>
      <div className="space-y-4">
        {err ? <ErrorBanner message={err} /> : null}
        <label className="text-sm block">
          <span className="block font-medium text-gray-700 mb-1">Attach to</span>
          <select
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            value={scopeKind}
            onChange={(e) => { setScopeKind(e.target.value); setScopeId(''); }}
          >
            <option value="LOCATION">Location / office</option>
            <option value="EMPLOYEE">A specific employee</option>
          </select>
        </label>
        {scopeKind === 'LOCATION' ? (
          <label className="text-sm block">
            <span className="block font-medium text-gray-700 mb-1">Location</span>
            <select
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
              value={scopeId}
              onChange={(e) => setScopeId(e.target.value)}
            >
              <option value="">Select…</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code ? `${l.code} — ${l.name}` : l.name}</option>)}
            </select>
          </label>
        ) : (
          <EmployeeSearchSelect
            label="Employee"
            tip="This person may then only punch inside the zones attached to them — their personal zones override the office zones."
            value={scopeId}
            onSelect={(emp) => setScopeId(emp ? emp.id : '')}
          />
        )}
        <ModalActions>
          <ActionButton onClick={onClose}>Cancel</ActionButton>
          <PrimaryButton onClick={save} loading={saving} disabled={!scopeId}>Attach</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// "Effective zones" inspector — pick an employee, see exactly which zones a punch
// by them is evaluated against right now, plus the capture policy that applies.
function ZoneInspector({ setError }) {
  const [employeeId, setEmployeeId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!employeeId) { setData(null); return; }
    setLoading(true);
    get(`/api/hr/attendance/capture/employees/${employeeId}/zones`)
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message))
      .finally(() => setLoading(false));
  }, [employeeId, setError]);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-4">
      <SectionTitle tip="Preview which zones a punch by this employee is checked against right now — personal fences beat office fences, which beat the location's legacy radius.">
        Effective zones inspector
      </SectionTitle>
      <div className="max-w-md">
        <EmployeeSearchSelect
          label="Employee"
          value={employeeId}
          onSelect={(emp) => setEmployeeId(emp ? emp.id : '')}
        />
      </div>
      {loading ? <Spinner /> : null}
      {!loading && data ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3 text-sm">
            <p className="text-gray-700">
              <span className="font-medium text-gray-900">{employeeLabel(data)}</span>
              {data.employee?.code ? <span className="text-gray-400"> · {data.employee.code}</span> : null}
              {data.locationName ? <span className="text-gray-500"> — {data.locationName}</span> : null}
            </p>
            <div>
              <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Zones</span>
              {(data.zones || []).length === 0 ? (
                <p className="text-gray-400 text-xs">No zones — geo cannot be evaluated for this employee (no fences attached and no location radius set).</p>
              ) : (
                <ul className="space-y-1">
                  {data.zones.map((z) => (
                    <li key={`${z.kind}-${z.id}`} className="text-gray-700">
                      {z.name || 'Zone'}{' '}
                      <span className="text-xs text-gray-400">
                        {z.kind === 'POLYGON' ? `polygon · ${Array.isArray(z.ring) ? z.ring.length : '?'} points` : `radius · ${z.radiusM ?? '?'} m`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {data.policy ? (
              <div>
                <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Resolved policy {data.policy.scope ? `(${data.policy.scope})` : '(default)'}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">Geo {modeCell(data.policy.requireGeo, data.policy.geoEnforce)}</span>
                  <span className="text-xs text-gray-500">IP {modeCell(data.policy.requireIp, data.policy.ipEnforce)}</span>
                  <span className="text-xs text-gray-500">Face {modeCell(data.policy.requireFace, data.policy.faceEnforce)}</span>
                </span>
              </div>
            ) : null}
          </div>
          <ZonesMap zones={data.zones || []} />
        </div>
      ) : null}
    </div>
  );
}

/* ── Face approvals (Feature 39) ──────────────────────────────────────────── */
const ENROLLMENT_STATUSES = ['PENDING', 'ACTIVE', 'REJECTED', 'REVOKED'];

// Matcher chip: which engine produced/consumes this reference. 'stub' means the
// server has no ONNX matcher — punches will land in the Review queue instead of
// auto-matching.
function MatcherChip({ matcher }) {
  if (!matcher) return <span className="text-gray-400 text-xs">—</span>;
  const stub = String(matcher).toLowerCase().includes('stub');
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${stub ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-blue-50 text-blue-700 border-blue-200'}`}
      title={stub
        ? 'Stub matcher — face punches will need manual review until the ONNX matcher is enabled on the server.'
        : 'ONNX matcher — face punches auto-match against this reference.'}
    >
      {matcher}{stub ? ' · manual review' : ' · auto-match'}
    </span>
  );
}

function FaceApprovalsTab({ setError, flash }) {
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [rejecting, setRejecting] = useState(null); // enrolment row
  const [enrolling, setEnrolling] = useState(false);

  const load = useCallback(() => {
    setData(null);
    get('/api/hr/attendance/capture/enrollments', { status, page, pageSize })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [status, page, pageSize, setError]);
  useEffect(() => { load(); }, [load]);

  function pick(s) { setStatus(s); setPage(1); }

  async function approve(id) {
    setError('');
    try {
      await post(`/api/hr/attendance/capture/enrollments/${id}/decide`, { decision: 'APPROVE' });
      flash('Enrolment approved — face punching is now live for this employee.');
      load();
    } catch (e) { setError(e.data?.message || e.message); }
  }

  async function revoke(id) {
    if (!window.confirm('Revoke this face reference? The employee cannot face-punch until a new enrolment is approved.')) return;
    setError('');
    try {
      await post(`/api/hr/attendance/capture/enrollments/${id}/revoke`, {});
      flash('Enrolment revoked.');
      load();
    } catch (e) { setError(e.data?.message || e.message); }
  }

  const items = data?.items || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {ENROLLMENT_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => pick(s)}
            className={`px-3 py-1 rounded-full border ${status === s ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-300 text-gray-600'}`}
          >{s}</button>
        ))}
        <span className="ml-auto">
          <PrimaryButton onClick={() => setEnrolling(true)}>Enrol on behalf</PrimaryButton>
        </span>
      </div>

      {data === null ? <Spinner /> : status === 'PENDING' ? (
        items.length === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
            <Empty text="No pending face enrolments — new employee submissions land here for approval." />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {items.map((r) => (
              <div key={r.id} className="rounded-2xl border border-gray-200 bg-white overflow-hidden shadow-sm">
                {/* Big enough to eyeball — imageUrl may be an S3 URL or an inline data URL. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.imageUrl}
                  alt={`Enrolment selfie of ${employeeLabel(r)}`}
                  className="w-full h-64 object-contain bg-gray-50"
                />
                <div className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium text-gray-900">
                      {employeeLabel(r)}
                      {r.employee?.code ? <span className="block text-xs font-normal text-gray-400">{r.employee.code}</span> : null}
                    </span>
                    <MatcherChip matcher={r.matcher} />
                  </div>
                  <p className="text-xs text-gray-500">
                    Submitted {formatAdminDateTime(r.enrolledAt)}
                    {r.detScore != null ? ` · detection ${Number(r.detScore).toFixed(2)}` : ''}
                  </p>
                  <div className="flex gap-2 pt-1">
                    <ActionButton tone="positive" onClick={() => approve(r.id)}>Approve</ActionButton>
                    <ActionButton tone="danger" onClick={() => setRejecting(r)}>Reject…</ActionButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <DataTable
          emptyText={`No ${status.toLowerCase()} face enrolments.`}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'selfie',
              header: 'Selfie',
              render: (r) => (r.imageUrl ? (
                <a href={r.imageUrl} target="_blank" rel="noreferrer" title="Open full size">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r.imageUrl} alt={`Selfie of ${employeeLabel(r)}`} className="h-12 w-12 rounded-lg object-cover border border-gray-200" />
                </a>
              ) : '—'),
            },
            {
              key: 'emp',
              header: 'Employee',
              render: (r) => (
                <span>
                  {employeeLabel(r)}
                  {r.employee?.code ? <span className="text-xs text-gray-400"> · {r.employee.code}</span> : null}
                </span>
              ),
            },
            { key: 'matcher', header: 'Matcher', render: (r) => <MatcherChip matcher={r.matcher} /> },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
            { key: 'enrolled', header: 'Enrolled', render: (r) => formatAdminDateTime(r.enrolledAt) },
            { key: 'decided', header: 'Decided', render: (r) => formatAdminDateTime(r.decidedAt) },
            { key: 'note', header: 'Note', render: (r) => r.decisionNote || '—' },
            {
              key: 'actions',
              header: '',
              render: (r) => (r.status === 'ACTIVE' ? (
                <ActionButton tone="danger" onClick={() => revoke(r.id)}>Revoke</ActionButton>
              ) : null),
            },
          ]}
          rows={items}
        />
      )}

      {data !== null ? (
        <ServerPagination
          page={data.page || page}
          pageSize={data.pageSize || pageSize}
          total={data.total || 0}
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          noun="enrolments"
        />
      ) : null}

      {rejecting ? (
        <RejectEnrollmentModal
          row={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => { setRejecting(null); flash('Enrolment rejected — the employee sees your reason and can retake.'); load(); }}
        />
      ) : null}
      {enrolling ? (
        <EnrollOnBehalfModal
          onClose={() => setEnrolling(false)}
          onDone={() => {
            setEnrolling(false);
            flash('Enrolled — face punching is active for this employee.');
            if (status !== 'ACTIVE') { setStatus('ACTIVE'); setPage(1); } else load();
          }}
        />
      ) : null}
    </div>
  );
}

function RejectEnrollmentModal({ row, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setErr('');
    try {
      await post(`/api/hr/attendance/capture/enrollments/${row.id}/decide`, { decision: 'REJECT', note: note.trim() });
      onDone();
    } catch (e) { setErr(e.data?.message || e.message); } finally { setSaving(false); }
  }

  return (
    <Modal title="Reject face enrolment" onClose={onClose}>
      <div className="space-y-4">
        {err ? <ErrorBanner message={err} /> : null}
        <p className="text-sm text-gray-600">
          Rejecting <span className="font-medium text-gray-900">{employeeLabel(row)}</span>&rsquo;s enrolment.
          The reason is shown to the employee so they can retake a better photo.
        </p>
        <TextArea label="Reason (required)" value={note} onChange={setNote} rows={3} maxLength={500} />
        <ModalActions>
          <ActionButton onClick={onClose}>Cancel</ActionButton>
          <PrimaryButton onClick={save} loading={saving} disabled={!note.trim()}>Reject enrolment</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
  );
}

// HR-mediated enrolment (onboarding desk / kiosk) — a file upload is fine here,
// unlike ESS self-enrolment which is live-camera only.
function EnrollOnBehalfModal({ onClose, onDone }) {
  const [employeeId, setEmployeeId] = useState('');
  const [dataUrl, setDataUrl] = useState('');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  function onFile(e) {
    setErr('');
    const file = e.target.files && e.target.files[0];
    if (!file) { setDataUrl(''); return; }
    const reader = new FileReader();
    reader.onload = () => setDataUrl(String(reader.result || ''));
    reader.onerror = () => setErr('Could not read that file — try another photo.');
    reader.readAsDataURL(file);
  }

  async function save() {
    setSaving(true);
    setErr('');
    try {
      await post('/api/hr/attendance/capture/enrollments', { employeeId, selfieDataUrl: dataUrl });
      onDone();
    } catch (e) {
      // 422 carries {message, reason: NO_FACE | FACE_TOO_SMALL | MULTIPLE_FACES} —
      // surface both so HR picks a better photo.
      const msg = e.data?.message || e.message;
      setErr(e.data?.reason ? `${msg} (${e.data.reason})` : msg);
    } finally { setSaving(false); }
  }

  return (
    <Modal title="Enrol a face on behalf" onClose={onClose}>
      <div className="space-y-4">
        {err ? <ErrorBanner message={err} /> : null}
        <p className="text-sm text-gray-600">
          Registers this photo as the employee&rsquo;s face reference. It is <span className="font-medium">active immediately</span> — you are the approver.
        </p>
        <EmployeeSearchSelect
          label="Employee"
          value={employeeId}
          onSelect={(emp) => setEmployeeId(emp ? emp.id : '')}
        />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Reference photo
            <InfoTip text="A clear, front-facing photo with exactly one face — no sunglasses, good light. Blurry or multi-face photos are rejected at upload." />
          </label>
          <input type="file" accept="image/*" onChange={onFile} className="block w-full text-sm text-gray-600" />
        </div>
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={dataUrl} alt="Selected reference preview" className="max-h-56 rounded-xl border border-gray-200 object-contain" />
        ) : null}
        <ModalActions>
          <ActionButton onClick={onClose}>Cancel</ActionButton>
          <PrimaryButton onClick={save} loading={saving} disabled={!employeeId || !dataUrl}>Enrol</PrimaryButton>
        </ModalActions>
      </div>
    </Modal>
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
