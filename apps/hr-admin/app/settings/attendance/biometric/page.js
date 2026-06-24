'use client';

/**
 * Biometric devices (hr-admin) — Feature 28 operator console.
 *
 * Settings → Attendance → Biometric Devices (canManageAttendance-gated server-side;
 * this page is UX only). Four tabs:
 *   • Devices — register / edit a device, a health dot, today's punch count, and the
 *     "Connect this device" panel (push URL + Generate secret, shown once).
 *   • Mapping — device-code → employee table + inline add + a banner of unmapped
 *     codes seen in the last 7 days with one-click map.
 *   • Activity — raw-event log (received/materialised/duplicate/unmapped/locked).
 *   • Triage — parked rows (UNMAPPED / LOCKED / ERROR) with reprocess + per-event
 *     correct (re-map / flip IN-OUT / discard).
 *
 * The file-import door is the existing /settings/import center (kind=BIOMETRIC); the
 * push/poll doors are device-secret/cron, not operator UI.
 *
 * API (all under /api/hr/biometric):
 *   GET  /meta                          vendors / adapters / direction modes
 *   GET|POST /devices, GET|PATCH|DELETE /devices/:id, POST /devices/:id/rotate-secret
 *   GET  /devices/:id/events            raw events for a device
 *   GET  /events, GET /events/unmapped, POST /events/reprocess, POST /events/:id/correct
 *   GET|POST /maps, POST /maps/bulk, DELETE /maps/:id
 */

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, TextInput, Spinner } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { PageHeader, Tabs, DataTable, StatusBadge, ActionButton } from '@/lib/ui';
import { SectionTitle, InfoTip } from '@/lib/widgets';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';

const HEALTH_DOT = { green: 'bg-green-500', amber: 'bg-amber-500', red: 'bg-red-500' };
const HEALTH_TIP = {
  green: 'Punched in the last hour — healthy.',
  amber: 'Quiet, but within the expected silence window (or never seen yet).',
  red: 'Silent past the expected-silence threshold — check the terminal.',
};
const RAW_STATUS = ['RECEIVED', 'MAPPED', 'MATERIALISED', 'UNMAPPED', 'UNKNOWN_DEVICE', 'LOCKED', 'DUPLICATE', 'ERROR', 'IGNORED'];

function Dot({ health }) {
  return (
    <span className="inline-flex items-center gap-1" title={HEALTH_TIP[health] || ''}>
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${HEALTH_DOT[health] || 'bg-gray-300'}`} />
    </span>
  );
}

export default function BiometricDevicesPage() {
  const [tab, setTab] = useState('devices');
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { get('/api/hr/biometric/meta').then(setMeta).catch((e) => setError(e.message)); }, []);

  return (
    <div className="space-y-5">
      <PageHeader title="Biometric devices" subtitle="Register your eSSL / ZKTeco / Matrix terminals, map enroll numbers to people, and watch punches flow into attendance." />
      {error ? <ErrorBanner message={error} /> : null}
      {notice ? <div className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div> : null}
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'devices', label: 'Devices' },
          { key: 'mapping', label: 'Employee mapping' },
          { key: 'activity', label: 'Ingest activity' },
          { key: 'triage', label: 'Triage' },
        ]}
      />
      {tab === 'devices' ? <DevicesTab meta={meta} setError={setError} setNotice={setNotice} /> : null}
      {tab === 'mapping' ? <MappingTab setError={setError} setNotice={setNotice} /> : null}
      {tab === 'activity' ? <ActivityTab setError={setError} /> : null}
      {tab === 'triage' ? <TriageTab setError={setError} setNotice={setNotice} /> : null}
    </div>
  );
}

// ── Devices ────────────────────────────────────────────────────────────────────
function DevicesTab({ meta, setError, setNotice }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // device or {} for new
  const [secret, setSecret] = useState(null); // { secret, device } shown once

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/biometric/devices?pageSize=100')
      .then((r) => setItems(r.items || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [setError]);
  useEffect(() => { load(); }, [load]);

  const rotate = async (d) => {
    try { const r = await post(`/api/hr/biometric/devices/${d.id}/rotate-secret`, {}); setSecret({ secret: r.secret, device: d }); load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <PrimaryButton onClick={() => setEditing({})}>Add device</PrimaryButton>
      </div>
      <DataTable
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No devices yet. Add your first terminal to start ingesting punches."
        columns={[
          { key: 'health', header: '', render: (r) => <Dot health={r.health} /> },
          { key: 'name', header: 'Name', render: (r) => <span className="font-medium">{r.name}</span> },
          { key: 'vendor', header: 'Vendor' },
          { key: 'serialNumber', header: 'Serial' },
          { key: 'directionMode', header: 'Direction' },
          { key: 'todayCount', header: 'Punches (24h)' },
          { key: 'lastSeenAt', header: 'Last seen', render: (r) => (r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : '—') },
          {
            key: 'actions', header: '', render: (r) => (
              <div className="flex gap-2">
                <ActionButton onClick={() => setEditing(r)}>Edit</ActionButton>
                <ActionButton onClick={() => rotate(r)}>{r.hasIngestSecret ? 'Rotate secret' : 'Generate secret'}</ActionButton>
              </div>
            ),
          },
        ]}
        rows={items}
      />
      {editing ? <DeviceModal meta={meta} device={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice('Device saved.'); load(); }} setError={setError} /> : null}
      {secret ? <SecretModal secret={secret} onClose={() => setSecret(null)} /> : null}
    </div>
  );
}

function DeviceModal({ meta, device, onClose, onSaved, setError }) {
  const isNew = !device.id;
  const [form, setForm] = useState({
    name: device.name || '', vendor: device.vendor || 'ESSL', adapterKey: device.adapterKey || '',
    serialNumber: device.serialNumber || '', directionMode: device.directionMode || 'DERIVE',
    entityId: device.entityId || '', locationId: device.locationId || '',
    expectedSilenceMin: device.expectedSilenceMin ?? '', dedupWindowSec: device.dedupWindowSec ?? 60,
    timezone: device.timezone || '', isActive: device.isActive !== false, pollKind: device.pollKind || '',
  });
  const [entities, setEntities] = useState([]);
  const [locations, setLocations] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { get('/api/hr/org/entities').then((r) => setEntities(r.items || r || [])).catch(() => {}); }, []);
  useEffect(() => {
    if (!form.entityId) { setLocations([]); return; }
    get(`/api/hr/org/locations?entityId=${form.entityId}`).then((r) => setLocations(r.items || r || [])).catch(() => {});
  }, [form.entityId]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const vendorAdapter = meta && meta.vendorDefaultAdapter && meta.vendorDefaultAdapter[form.vendor];

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form, adapterKey: form.adapterKey || vendorAdapter, expectedSilenceMin: form.expectedSilenceMin === '' ? null : Number(form.expectedSilenceMin), dedupWindowSec: Number(form.dedupWindowSec) || 60, locationId: form.locationId || null, pollKind: form.pollKind || null };
      if (isNew) await post('/api/hr/biometric/devices', body);
      else await patch(`/api/hr/biometric/devices/${device.id}`, body);
      onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title={isNew ? 'Add device' : 'Edit device'} onClose={onClose} size="md">
      <div className="space-y-3">
        <TextInput label="Name" value={form.name} onChange={(v) => set('name', v)} required placeholder="Plant-A Main Gate" />
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">Vendor</span>
            <select className="w-full rounded border px-2 py-1.5" value={form.vendor} onChange={(e) => set('vendor', e.target.value)}>
              {(meta ? meta.vendors : ['ESSL']).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">Adapter <InfoTip text="Auto-suggested from the vendor; override only for an unusual export format." /></span>
            <select className="w-full rounded border px-2 py-1.5" value={form.adapterKey || vendorAdapter || ''} onChange={(e) => set('adapterKey', e.target.value)}>
              {(meta ? meta.adapters : []).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">Entity (site)</span>
            <select className="w-full rounded border px-2 py-1.5" value={form.entityId} onChange={(e) => { set('entityId', e.target.value); set('locationId', ''); }}>
              <option value="">Select…</option>
              {entities.map((en) => <option key={en.id} value={en.id}>{en.code || en.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-gray-600">Location (optional)</span>
            <select className="w-full rounded border px-2 py-1.5" value={form.locationId} onChange={(e) => set('locationId', e.target.value)}>
              <option value="">None</option>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.code || l.name}</option>)}
            </select>
          </label>
        </div>
        <TextInput label="Serial number (push/SFTP join key)" value={form.serialNumber} onChange={(v) => set('serialNumber', v)} placeholder="e.g. the ZK terminal SN" />
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Direction handling</span>
          <select className="w-full rounded border px-2 py-1.5" value={form.directionMode} onChange={(e) => set('directionMode', e.target.value)}>
            <option value="DERIVE">Derive from punch order (recommended)</option>
            <option value="TRUST_DEVICE">Trust the device's IN/OUT</option>
            <option value="ALL_IN">Single reader — every punch is an IN</option>
          </select>
          <span className="mt-1 block text-xs text-gray-500">Most factory devices don&apos;t record IN vs OUT reliably — leave this on <em>Derive from punch order</em> unless your device is configured for direction.</span>
        </label>
        <div className="grid grid-cols-3 gap-3">
          <TextInput label="Expected silence (min)" value={form.expectedSilenceMin} onChange={(v) => set('expectedSilenceMin', v)} type="number" hint="Alert if quiet this long." />
          <TextInput label="De-bounce (sec)" value={form.dedupWindowSec} onChange={(v) => set('dedupWindowSec', v)} type="number" hint="Collapse double-taps." />
          <TextInput label="Timezone override" value={form.timezone} onChange={(v) => set('timezone', v)} placeholder="Asia/Kolkata" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} /> Active
        </label>
      </div>
      <ModalActions>
        <button className="rounded border px-3 py-1.5 text-sm" onClick={onClose}>Cancel</button>
        <PrimaryButton onClick={save} loading={busy} disabled={!form.name || !form.entityId}>Save</PrimaryButton>
      </ModalActions>
    </Modal>
  );
}

function SecretModal({ secret, onClose }) {
  const url = typeof window !== 'undefined' ? `${window.location.origin.replace(/:\d+$/, '')}` : '';
  const pushUrl = `/api/hr/biometric/ingest/${secret.device.serialNumber || '<serial>'}`;
  return (
    <Modal title="Device secret — copy it now" onClose={onClose} size="md">
      <div className="space-y-3 text-sm">
        <p className="text-amber-700">This secret is shown <strong>once</strong>. Store it on the device / agent now — we only keep a hash.</p>
        <div>
          <SectionTitle>Shared secret</SectionTitle>
          <code className="block break-all rounded bg-gray-100 px-2 py-1.5">{secret.secret}</code>
        </div>
        <div>
          <SectionTitle>Push URL (ADMS / REST)</SectionTitle>
          <code className="block break-all rounded bg-gray-100 px-2 py-1.5">POST {pushUrl}</code>
          <p className="mt-1 text-xs text-gray-500">Send the device&apos;s native body (ZK tab-separated ATTLOG / Cams-Matrix JSON) with header <code>X-Device-Secret: &lt;the secret&gt;</code>. The device must have a serial number set.</p>
        </div>
      </div>
      <ModalActions><PrimaryButton onClick={onClose}>Done</PrimaryButton></ModalActions>
    </Modal>
  );
}

// ── Mapping ────────────────────────────────────────────────────────────────────
function MappingTab({ setError, setNotice }) {
  const [maps, setMaps] = useState([]);
  const [unmapped, setUnmapped] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ deviceCode: '', employeeCode: '' });

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([get('/api/hr/biometric/maps?pageSize=200'), get('/api/hr/biometric/events/unmapped?days=7')])
      .then(([m, u]) => { setMaps(m.items || []); setUnmapped(u.items || []); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [setError]);
  useEffect(() => { load(); }, [load]);

  const add = async (deviceCode, employeeCode) => {
    try { await post('/api/hr/biometric/maps', { deviceCode, employeeCode }); setForm({ deviceCode: '', employeeCode: '' }); setNotice('Mapping added.'); load(); }
    catch (e) { setError(e.message); }
  };
  const remove = async (id) => { try { await del(`/api/hr/biometric/maps/${id}`); load(); } catch (e) { setError(e.message); } };

  return (
    <div className="space-y-4">
      {unmapped.length ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
          <strong>{unmapped.length}</strong> unmapped device code(s) seen in the last 7 days.
          <div className="mt-2 flex flex-wrap gap-2">
            {unmapped.slice(0, 12).map((u) => (
              <button key={u.deviceCode} className="rounded border bg-white px-2 py-1 text-xs hover:bg-amber-100" onClick={() => setForm((f) => ({ ...f, deviceCode: u.deviceCode }))}>
                {u.deviceCode} <span className="text-gray-400">×{u.count}</span> → map
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <TextInput label="Device code (enroll-no / PIN)" value={form.deviceCode} onChange={(v) => setForm((f) => ({ ...f, deviceCode: v }))} />
        <TextInput label="Employee code" value={form.employeeCode} onChange={(v) => setForm((f) => ({ ...f, employeeCode: v }))} />
        <PrimaryButton onClick={() => add(form.deviceCode, form.employeeCode)} disabled={!form.deviceCode || !form.employeeCode}>Add mapping</PrimaryButton>
      </div>
      <DataTable
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No mappings yet. Add one above, or bulk-upload via the Import / Migrate center."
        columns={[
          { key: 'deviceCode', header: 'Device code' },
          { key: 'employee', header: 'Employee', render: (r) => (r.employee ? `${r.employee.firstName || ''} ${r.employee.lastName || ''} (${r.employee.code})` : '—') },
          { key: 'scope', header: 'Scope', render: (r) => (r.deviceId ? 'This device' : 'Tenant-wide') },
          { key: 'actions', header: '', render: (r) => <ActionButton tone="danger" onClick={() => remove(r.id)}>Remove</ActionButton> },
        ]}
        rows={maps}
      />
    </div>
  );
}

// ── Ingest activity (raw event log) ─────────────────────────────────────────────
function ActivityTab({ setError }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    get(`/api/hr/biometric/events?pageSize=100${status ? `&status=${status}` : ''}`)
      .then((r) => setEvents(r.items || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [setError, status]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <label className="block text-sm">
        <span className="mr-2 text-gray-600">Filter status</span>
        <select className="rounded border px-2 py-1" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {RAW_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <DataTable
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No punch events yet."
        columns={[
          { key: 'deviceCode', header: 'Device code' },
          { key: 'localTimeRaw', header: 'Device time' },
          { key: 'punchAt', header: 'Resolved (UTC)', render: (r) => new Date(r.punchAt).toISOString() },
          { key: 'resolvedType', header: 'Type', render: (r) => r.resolvedType || '—' },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
          { key: 'reason', header: 'Reason', render: (r) => r.reason || '' },
        ]}
        rows={events}
      />
    </div>
  );
}

// ── Triage (parked rows + correction) ───────────────────────────────────────────
function TriageTab({ setError, setNotice }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('UNMAPPED');
  const [remapping, setRemapping] = useState(null); // the parked row being mapped to an employee

  const load = useCallback(() => {
    setLoading(true);
    get(`/api/hr/biometric/events?status=${status}&pageSize=100`)
      .then((r) => setEvents(r.items || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [setError, status]);
  useEffect(() => { load(); }, [load]);

  const reprocess = async () => {
    try { const r = await post('/api/hr/biometric/events/reprocess', { statuses: [status] }); setNotice(`Reprocessed: ${r.remapped} remapped, ${r.materialised} materialised, ${r.stillParked} still parked.`); load(); }
    catch (e) { setError(e.message); }
  };
  const correct = async (id, action, employeeId) => {
    try { await post(`/api/hr/biometric/events/${id}/correct`, { action, employeeId }); setNotice('Correction applied.'); load(); return true; }
    catch (e) { setError(e.message); return false; }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="block text-sm">
          <span className="mr-2 text-gray-600">Parked status</span>
          <select className="rounded border px-2 py-1" value={status} onChange={(e) => setStatus(e.target.value)}>
            {['UNMAPPED', 'LOCKED', 'ERROR'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <PrimaryButton onClick={reprocess}>Reprocess parked rows</PrimaryButton>
      </div>
      {status === 'LOCKED' ? <div className="rounded bg-gray-50 px-3 py-2 text-xs text-gray-600">These days are in a closed period. Raise a regularisation instead of back-dating the punch.</div> : null}
      <DataTable
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="Nothing parked here. 🎉"
        columns={[
          { key: 'deviceCode', header: 'Device code' },
          { key: 'localTimeRaw', header: 'Device time' },
          { key: 'reason', header: 'Reason' },
          {
            key: 'actions', header: '', render: (r) => (
              <div className="flex gap-2">
                {status === 'UNMAPPED' ? <ActionButton onClick={() => setRemapping(r)}>Map to employee</ActionButton> : null}
                {r.resolvedType ? <ActionButton onClick={() => correct(r.id, 'flip')}>Flip IN/OUT</ActionButton> : null}
                <ActionButton tone="danger" onClick={() => correct(r.id, 'discard')}>Discard</ActionButton>
              </div>
            ),
          },
        ]}
        rows={events}
      />
      {remapping ? <RemapModal event={remapping} onClose={() => setRemapping(null)} onRemap={async (emp) => { const ok = await correct(remapping.id, 'remap', emp.id); if (ok) setRemapping(null); }} /> : null}
    </div>
  );
}

// Map a parked UNMAPPED event to an employee → backend remap (set employeeId +
// re-materialise the day). One-off fix for a single event; for a recurring code
// add a Mapping (Mapping tab) so future punches resolve automatically.
function RemapModal({ event, onClose, onRemap }) {
  const [emp, setEmp] = useState(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Map punch to employee" onClose={onClose} size="md">
      <div className="space-y-3 text-sm">
        <p className="text-gray-600">Device code <code className="rounded bg-gray-100 px-1">{event.deviceCode}</code> at {event.localTimeRaw || '—'} has no employee mapping. Pick the person this punch belongs to.</p>
        <EmployeeSearchSelect
          label="Employee"
          value={emp?.id || ''}
          selectedLabel={emp ? `${emp.firstName || ''} ${emp.lastName || ''} (${emp.code || ''})`.trim() : ''}
          onSelect={(e) => setEmp(e || null)}
          placeholder="Search by name, code or email…"
        />
        <p className="text-xs text-gray-500">This maps only this event. To resolve this code for all future punches, add a mapping on the <strong>Employee mapping</strong> tab, then <strong>Reprocess parked rows</strong>.</p>
      </div>
      <ModalActions>
        <button className="rounded border px-3 py-1.5 text-sm" onClick={onClose}>Cancel</button>
        <PrimaryButton onClick={async () => { setBusy(true); await onRemap(emp); setBusy(false); }} loading={busy} disabled={!emp}>Map &amp; materialise</PrimaryButton>
      </ModalActions>
    </Modal>
  );
}
