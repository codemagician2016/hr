'use client';

// Employee detail: GET /api/hr/employees/:id. Shows the resolved profile +
// current-employment context (Department / Designation / Location / Grade / Band
// joined server-side) and offers in-place editing:
//   • Edit profile  — PATCH name / email / phone (mapped to workEmail server-side)
//   • Edit employment — PATCH department / designation / location (appends a new
//     effective-dated EmploymentRecord segment server-side)
//   • Reporting     — PATCH managerEmployeeId (backend rejects self/circular loops)
//   • Terminate     — POST /:id/terminate (guarded confirm; demoted directory exit)

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Spinner,
  ErrorBanner,
  PrimaryButton,
  TextInput,
  Modal,
  ModalActions,
  DateField,
  formatAdminDate,
} from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import ManagerPicker from '@/components/ManagerPicker';

function asList(res) {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.items)) return res.items;
  return [];
}

function statusBadgeClass(status) {
  switch (String(status || '').toUpperCase()) {
    case 'ACTIVE':
      return 'bg-green-50 text-green-700 border-green-200';
    case 'PROBATION':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'ON_LEAVE':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'NOTICE_PERIOD':
      return 'bg-orange-50 text-orange-700 border-orange-200';
    case 'SUSPENDED':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'TERMINATED':
    case 'RETIRED':
      return 'bg-gray-100 text-gray-600 border-gray-200';
    default:
      return 'bg-gray-50 text-gray-600 border-gray-200';
  }
}

function statusLabel(status) {
  if (!status) return 'Unknown';
  const s = String(status).replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-sm text-gray-900 mt-0.5">{value ?? <span className="text-gray-400">—</span>}</dd>
    </div>
  );
}

function Section({ title, action, children }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        {action}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">{children}</dl>
    </div>
  );
}

// ── Feature 13: the rich, sectioned profile for this employee (scoped read of
// GET /api/hr/profile/employees/:id/full). Lazy-loaded + collapsible so the detail
// page stays light; shows the extra Figma sections HR cares about (extended personal,
// bank, education, family, addresses, statutory IDs).
function RichProfileSection({ employeeId }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || data) return undefined;
    let aborted = false;
    setLoading(true);
    get(`/api/hr/profile/employees/${employeeId}/full`)
      .then((res) => { if (!aborted) { setData(res); setLoading(false); } })
      .catch((e) => { if (!aborted) { setError(e); setLoading(false); } });
    return () => { aborted = true; };
  }, [open, data, employeeId]);

  const e = data?.employee;
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Full profile (rich)</h2>
        <span className="text-sm text-[color:var(--theme-primary)]">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        loading ? <div className="mt-4"><Spinner /></div> : error ? <div className="mt-4"><ErrorBanner message={error.message || 'Could not load'} /></div> : data ? (
          <div className="mt-4 space-y-5">
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Father's name" value={e.fatherName} />
              <Field label="Mother's name" value={e.motherName} />
              <Field label="Date of birth" value={e.dateOfBirth} />
              <Field label="Gender" value={e.gender} />
              <Field label="Marital status" value={e.maritalStatus} />
              <Field label="Blood group" value={e.bloodGroup} />
              <Field label="Religion" value={e.religion} />
              <Field label="Mother tongue" value={e.motherTongue} />
              <Field label="Personal email" value={e.personalEmail} />
              <Field label="Home phone" value={e.homePhone} />
              <Field label="Office phone" value={e.officePhone} />
              <Field label="Place of birth" value={e.placeOfBirth} />
            </dl>

            {data.bank && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Bank</h3>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field label="Account name" value={data.bank.accountName} />
                  <Field label="Account number" value={data.bank.accountNumber} />
                  <Field label="IFSC" value={data.bank.ifsc} />
                  <Field label="NZ account" value={data.bank.nzBankAccount} />
                  <Field label="Bank" value={data.bank.bankName} />
                </dl>
              </div>
            )}

            {data.statutory && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Statutory ({data.statutory.countryCode})</h3>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <Field label="PAN" value={data.statutory.pan} />
                  <Field label="UAN" value={data.statutory.uan} />
                  <Field label="IRD number" value={data.statutory.irdNumber} />
                  <Field label="Aadhaar verified" value={data.statutory.aadhaarVerified ? 'Yes' : 'No'} />
                </dl>
              </div>
            )}

            {data.education?.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Education</h3>
                <ul className="space-y-1 text-sm text-gray-900">
                  {data.education.map((ed) => <li key={ed.id}>{ed.level} · {ed.institution}{ed.fieldOfStudy ? ` · ${ed.fieldOfStudy}` : ''}{ed.endYear ? ` (${ed.endYear})` : ''}</li>)}
                </ul>
              </div>
            )}

            {data.family?.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Family / nominees</h3>
                <ul className="space-y-1 text-sm text-gray-900">
                  {data.family.map((d) => <li key={d.id}>{d.name} · {d.relationship}{d.isNominee ? ` · nominee ${d.nomineePercent || 0}%` : ''}</li>)}
                </ul>
              </div>
            )}

            {data.addresses?.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Addresses</h3>
                <ul className="space-y-1 text-sm text-gray-900">
                  {data.addresses.map((a) => <li key={a.id}>{a.type}: {a.sameAsType ? `same as ${a.sameAsType}` : [a.line1, a.city, a.stateCode, a.postalCode].filter(Boolean).join(', ') || '—'}</li>)}
                </ul>
              </div>
            )}
          </div>
        ) : null
      )}
    </div>
  );
}

function SelectField({ label, value, onChange, options, placeholder = 'Unassigned' }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--theme-primary)] text-sm bg-white"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name || o.title}
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Edit Profile modal: PATCH name / email / phone. ───────────────────────────
function EditProfileModal({ employee, onClose, onSaved }) {
  const [form, setForm] = useState({
    firstName: employee.firstName || '',
    lastName: employee.lastName || '',
    email: employee.workEmail || '',
    phone: employee.phone || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await patch(`/api/hr/employees/${employee.id}`, {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
      });
      onSaved(updated?.employee || updated);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save changes.');
      setSaving(false);
    }
  }

  return (
    <Modal title="Edit profile" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <TextInput label="First name" value={form.firstName} onChange={(v) => set('firstName', v)} required />
          <TextInput label="Last name" value={form.lastName} onChange={(v) => set('lastName', v)} required />
        </div>
        <TextInput label="Work email" type="email" value={form.email} onChange={(v) => set('email', v)} />
        <TextInput label="Phone" value={form.phone} onChange={(v) => set('phone', v)} />
        {error && <ErrorBanner message={error} />}
        <ModalActions>
          <button
            type="button"
            onClick={onClose}
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
  );
}

// ── Edit Employment modal: PATCH department / designation / location. ─────────
function EditEmploymentModal({ employee, onClose, onSaved }) {
  const emp = employee.employment || {};
  const [form, setForm] = useState({
    departmentId: emp.department?.id || '',
    designationId: emp.designation?.id || '',
    locationId: emp.location?.id || '',
  });
  const [orgs, setOrgs] = useState({ departments: [], designations: [], locations: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    let alive = true;
    Promise.all([
      get('/api/hr/org/departments').catch(() => []),
      get('/api/hr/org/designations').catch(() => []),
      get('/api/hr/org/locations').catch(() => []),
    ]).then(([departments, designations, locations]) => {
      if (!alive) return;
      setOrgs({
        departments: asList(departments),
        designations: asList(designations),
        locations: asList(locations),
      });
    });
    return () => {
      alive = false;
    };
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const updated = await patch(`/api/hr/employees/${employee.id}`, {
        departmentId: form.departmentId || null,
        designationId: form.designationId || null,
        locationId: form.locationId || null,
      });
      onSaved(updated?.employee || updated);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save employment.');
      setSaving(false);
    }
  }

  return (
    <Modal title="Edit employment" onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <p className="text-xs text-gray-500">
          Changes are recorded as a new effective-dated employment segment from today.
        </p>
        <SelectField
          label="Department"
          value={form.departmentId}
          onChange={(v) => set('departmentId', v)}
          options={orgs.departments}
        />
        <SelectField
          label="Designation"
          value={form.designationId}
          onChange={(v) => set('designationId', v)}
          options={orgs.designations}
        />
        <SelectField
          label="Location"
          value={form.locationId}
          onChange={(v) => set('locationId', v)}
          options={orgs.locations}
        />
        {error && <ErrorBanner message={error} />}
        <ModalActions>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <PrimaryButton type="submit" loading={saving}>
            Save employment
          </PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Terminate modal: guarded directory exit (POST /:id/terminate). ────────────
function TerminateModal({ employee, onClose, onDone }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [confirmCode, setConfirmCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fullName = [employee.firstName, employee.lastName].filter(Boolean).join(' ') || employee.code;

  async function run() {
    setSaving(true);
    setError('');
    try {
      const updated = await post(`/api/hr/employees/${employee.id}/terminate`, { terminationDate: date });
      onDone(updated?.employee || updated);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to terminate.');
      setSaving(false);
    }
  }

  return (
    <Modal title="Terminate employee" onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          This ends <span className="font-semibold">{fullName}</span>&rsquo;s active employment and closes their
          current employment segment. For a full exit (notice, final settlement, asset return) use the separations
          flow instead.
        </div>
        <DateField label="Termination date" value={date} onChange={setDate} required />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Type the employee code <span className="font-mono text-gray-900">{employee.code}</span> to confirm
          </label>
          <input
            value={confirmCode}
            onChange={(e) => setConfirmCode(e.target.value)}
            placeholder={employee.code}
            className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm"
          />
        </div>
        {error && <ErrorBanner message={error} />}
        <ModalActions>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={run}
            disabled={saving || confirmCode.trim() !== employee.code}
            className="px-4 py-2 text-white text-sm font-semibold rounded-lg inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Spinner small />}
            Terminate
          </button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// Editable "reports to" section. PATCHes managerEmployeeId via the update
// endpoint. The backend cycle-guard 400 ("reporting loop") surfaces here.
function ManagerSection({ employee, onSaved }) {
  const [managerId, setManagerId] = useState(employee.managerEmployeeId || '');
  const [managerLabel, setManagerLabel] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    if (employee.managerEmployeeId) {
      get(`/api/hr/employees/${employee.managerEmployeeId}`)
        .then((m) => {
          if (!alive) return;
          const mm = m?.employee || m;
          setManagerLabel([mm.firstName, mm.lastName].filter(Boolean).join(' ') || mm.code || '');
        })
        .catch(() => {});
    } else {
      setManagerLabel('');
    }
    return () => {
      alive = false;
    };
  }, [employee.managerEmployeeId]);

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const updated = await patch(`/api/hr/employees/${employee.id}`, { managerEmployeeId: managerId || null });
      setSaved(true);
      setDirty(false);
      if (onSaved) onSaved(updated?.employee || updated);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to update manager.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-4">Reporting</h2>
      <div className="max-w-md space-y-3">
        <ManagerPicker
          value={managerId}
          selectedLabel={managerLabel}
          excludeId={employee.id}
          onChange={(v) => {
            setManagerId(v);
            setDirty(true);
            setSaved(false);
          }}
          hint="Who this employee reports to. Leave empty for the top of the chain."
        />
        {error && <ErrorBanner message={error} />}
        {saved && <p className="text-sm text-emerald-700">Manager updated.</p>}
        {dirty && (
          <PrimaryButton loading={saving} onClick={save}>
            Save manager
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

export default function EmployeeDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [emp, setEmp] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // 'profile' | 'employment' | 'terminate'

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    get(`/api/hr/employees/${id}`)
      .then((res) => {
        if (alive) setEmp(res?.employee || res);
      })
      .catch((err) => {
        if (alive) setError(err.message || 'Failed to load employee.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => load(), [load]);

  // Merge a server PATCH/terminate result over the loaded employee. The update
  // endpoints return the bare Employee (no joined `employment` block), so we
  // refetch to re-resolve department/designation when employment changed.
  function applyUpdate(updated, { refetch = false } = {}) {
    if (refetch) {
      load();
    } else if (updated) {
      setEmp((prev) => ({ ...prev, ...updated, employment: prev?.employment }));
    }
    setModal(null);
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorBanner message={error} />;
  if (!emp) return null;

  const fullName = [emp.firstName, emp.lastName].filter(Boolean).join(' ') || emp.code;
  const employment = emp.employment || {};
  const isTerminated = ['TERMINATED', 'RETIRED'].includes(String(emp.status || '').toUpperCase());

  return (
    <div className="space-y-4">
      <div>
        <Link href="/people" className="text-sm text-gray-500 hover:underline">
          ← Back to People
        </Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div className="flex items-center gap-3">
            <span
              className="inline-flex h-12 w-12 items-center justify-center rounded-full text-white text-lg font-semibold"
              style={{ backgroundColor: 'var(--theme-primary)' }}
            >
              {(emp.firstName || emp.code || '?').slice(0, 1).toUpperCase()}
            </span>
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">{fullName}</h1>
              <p className="text-sm text-gray-500 flex items-center gap-2">
                <span>{emp.code}</span>
                <span>·</span>
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(
                    emp.status
                  )}`}
                >
                  {statusLabel(emp.status)}
                </span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setModal('profile')}
              className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Edit profile
            </button>
            {!isTerminated && (
              <button
                type="button"
                onClick={() => setModal('terminate')}
                className="px-3 py-2 text-sm font-medium border border-red-200 text-red-700 rounded-lg hover:bg-red-50"
              >
                Terminate
              </button>
            )}
          </div>
        </div>
      </div>

      <Section title="Profile">
        <Field label="First name" value={emp.firstName} />
        <Field label="Last name" value={emp.lastName} />
        <Field label="Employee code" value={emp.code} />
        <Field
          label="Work email"
          value={
            emp.workEmail ? (
              <a href={`mailto:${emp.workEmail}`} className="text-[color:var(--theme-primary)] hover:underline">
                {emp.workEmail}
              </a>
            ) : null
          }
        />
        <Field label="Phone" value={emp.phone} />
        <Field label="Status" value={statusLabel(emp.status)} />
      </Section>

      <Section
        title="Employment"
        action={
          <button
            type="button"
            onClick={() => setModal('employment')}
            className="text-sm font-medium text-[color:var(--theme-primary)] hover:underline"
          >
            Edit
          </button>
        }
      >
        <Field label="Department" value={employment.department?.name} />
        <Field label="Designation" value={employment.designation?.name} />
        <Field label="Location" value={employment.location?.name} />
        <Field label="Grade" value={employment.grade?.name} />
        <Field label="Band" value={employment.band?.name} />
        <Field label="Date of joining" value={emp.hireDate ? formatAdminDate(emp.hireDate) : null} />
      </Section>

      <ManagerSection employee={emp} onSaved={(u) => applyUpdate(u)} />

      {/* Feature 13 — the rich, sectioned profile (lazy + scoped). */}
      <RichProfileSection employeeId={emp.id} />

      {modal === 'profile' && (
        <EditProfileModal employee={emp} onClose={() => setModal(null)} onSaved={(u) => applyUpdate(u)} />
      )}
      {modal === 'employment' && (
        <EditEmploymentModal
          employee={emp}
          onClose={() => setModal(null)}
          onSaved={() => applyUpdate(null, { refetch: true })}
        />
      )}
      {modal === 'terminate' && (
        <TerminateModal
          employee={emp}
          onClose={() => setModal(null)}
          onDone={() => applyUpdate(null, { refetch: true })}
        />
      )}
    </div>
  );
}
