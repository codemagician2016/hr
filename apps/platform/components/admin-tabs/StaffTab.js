'use client';

// Staff list + invite + edit. APPOINTMENT-vertical (and shared admin-shell).
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useEffect, useMemo, useState } from 'react';
import { useConfirm } from '@/components/ConfirmDialog';
import ImageEditorModal from '@/components/ImageEditorModal';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, Modal, ModalActions, PrimaryButton, TextInput, TextArea } from '@/components/admin-ui';

const DEFAULT_STAFF_LABELS = {
  eyebrow: 'Team access',
  title: 'Doctors and front desk',
  description: 'Manage who receives bookings, who handles walk-ins and payments, and which provider identity is used on documents.',
  invite: '+ Invite staff',
  bookableStat: 'Bookable doctors',
  frontDeskStat: 'Front desk',
  identityStat: 'Rx identity ready',
  bookableFilter: 'Bookable',
  identityFilter: 'Rx ready',
  emptyTitle: 'Invite your first doctor',
  emptyBody: 'Add providers who can take bookings, appear on the website, and sign prescriptions.',
  emptyButton: 'Invite doctor',
  unnamed: 'Unnamed doctor',
  bookingsToggle: 'Bookings',
  identityCard: 'Rx identity',
  identitySection: 'Prescription identity',
  identityNote: 'Used only when this doctor writes an Rx. Clinic letterhead design stays controlled from Settings.',
  signatureLabel: 'Doctor signature',
  stampLabel: 'Doctor stamp / seal',
  profileEyebrow: 'Doctor profile',
  profileFallback: 'New doctor',
  titlePlaceholder: 'e.g. Senior Dentist, General Physician',
  aboutPlaceholder: 'Experience, qualifications, specialties, and patient-care focus.',
  inviteModalTitle: 'Invite staff member',
  inviteHelp: "We'll email them a link to set their password.",
  defaultRoleNames: ['Doctor'],
  documentIdentityEnabled: true,
};

function StaffTab({ onChange, labels = DEFAULT_STAFF_LABELS }) {
  const copy = { ...DEFAULT_STAFF_LABELS, ...labels };
  const [staff, setStaff] = useState([]);
  const [roles, setRoles] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editingAvatarFor, setEditingAvatarFor] = useState(null); // staff id while modal open
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null); // staff object or 'me' string
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');

  async function load() {
    setLoading(true);
    setError('');
    try {
      await api('/api/rbac/seed-system-roles', { method: 'POST' }).catch(() => null);
      const [staffRes, meRes, rolesRes] = await Promise.all([
        api('/api/business/staff'),
        api('/api/auth/me').catch(() => null),
        api('/api/rbac/roles').catch(() => ({ roles: [] })),
      ]);
      setStaff(staffRes.staff);
      setMe(meRes?.user || null);
      setRoles(Array.isArray(rolesRes?.roles) ? rolesRes.roles : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function remove(id) {
    if (!await confirm('Remove this staff member?', { confirmLabel: 'Remove', tone: 'danger' })) return;
    try {
      await api(`/api/business/staff/${id}`, { method: 'DELETE' });
      await load();
      onChange?.();
    } catch (err) {
      alert(err.message);
    }
  }

  async function updateAvatar(id, avatarUrl) {
    try {
      await api(`/api/business/staff/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ avatarUrl }),
      });
      await load();
      onChange?.();
    } catch (err) {
      alert(err.message);
    }
  }

  async function toggleShowOnWebsite(id, showOnWebsite) {
    try {
      await api(`/api/business/staff/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ showOnWebsite }),
      });
      await load();
      onChange?.();
    } catch (err) {
      alert(err.message);
    }
  }

  async function toggleServiceProvider(id, isServiceProvider) {
    try {
      await api(`/api/business/staff/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isServiceProvider }),
      });
      await load();
      onChange?.();
    } catch (err) {
      alert(err.message);
    }
  }

  // Avatar upload now drives ImageEditorModal so admins can crop / zoom
  // / rotate before saving (matches the rest of the admin's image UX).

  const summary = useMemo(() => {
    const doctors = staff.filter((s) => s.isServiceProvider !== false);
    const frontDesk = staff.filter((s) => String(s.businessRole?.name || '').toLowerCase().includes('front'));
    const rxReady = copy.documentIdentityEnabled ? staff.filter((s) => s.signatureUrl || s.stampUrl) : [];
    return {
      total: staff.length,
      doctors: doctors.length,
      frontDesk: frontDesk.length,
      rxReady: rxReady.length,
    };
  }, [staff, copy.documentIdentityEnabled]);
  const filteredStaff = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return staff.filter((s) => {
      const matchesQuery = !needle || [s.name, s.email, s.subtitle].some((v) => String(v || '').toLowerCase().includes(needle));
      const matchesFilter =
        filter === 'all' ||
        (filter === 'doctors' && s.isServiceProvider !== false) ||
        (filter === 'frontdesk' && String(s.businessRole?.name || '').toLowerCase().includes('front')) ||
        (filter === 'visible' && s.showOnWebsite !== false) ||
        (copy.documentIdentityEnabled && filter === 'rx' && (s.signatureUrl || s.stampUrl)) ||
        (filter === 'pending' && !s.isActive);
      return matchesQuery && matchesFilter;
    });
  }, [staff, query, filter, copy.documentIdentityEnabled]);

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 bg-gradient-to-br from-white via-white to-indigo-50/50 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-700">{copy.eyebrow}</p>
              <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-950">{copy.title}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
                {copy.description}
              </p>
            </div>
        <button
          onClick={() => setInviteOpen(true)}
              className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:opacity-90"
              style={{ backgroundColor: 'var(--theme-primary)' }}
        >
              {copy.invite}
        </button>
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <RosterStat label="Total members" value={summary.total} />
            <RosterStat label={copy.bookableStat} value={summary.doctors} tone="emerald" />
            <RosterStat label={copy.frontDeskStat} value={summary.frontDesk} tone="blue" />
            {copy.documentIdentityEnabled && <RosterStat label={copy.identityStat} value={summary.rxReady} tone="amber" />}
          </div>
        </div>

        <div className="border-b border-slate-100 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative lg:w-[360px]">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">S</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by staff, email, title..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-sm font-medium text-slate-800 outline-none transition focus:border-indigo-300 focus:bg-white"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                ['all', 'All'],
                ['doctors', copy.bookableFilter],
                ['frontdesk', copy.frontDeskStat],
                ['visible', 'On website'],
                ...(copy.documentIdentityEnabled ? [['rx', copy.identityFilter]] : []),
                ['pending', 'Pending'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${filter === key ? 'bg-slate-950 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {loading ? (
        <div className="rounded-2xl border border-slate-200 bg-white py-12 flex justify-center"><Spinner /></div>
      ) : staff.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-2xl font-black text-indigo-700">+</div>
          <h3 className="mt-5 text-lg font-bold text-slate-950">{copy.emptyTitle}</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{copy.emptyBody}</p>
          <button type="button" onClick={() => setInviteOpen(true)} className="mt-5 rounded-xl px-4 py-2.5 text-sm font-bold text-white" style={{ backgroundColor: 'var(--theme-primary)' }}>
            {copy.emptyButton}
          </button>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filteredStaff.length === 0 ? (
            <div className="xl:col-span-2 rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
              No matching team members.
            </div>
          ) : filteredStaff.map((s) => {
              const isOwner = s.role === 'BUSINESS_ADMIN';
              const isSelf = me && s.id === me.id;
              const otherVisibleCount = staff.filter((o) => o.id !== s.id && o.showOnWebsite !== false).length;
              const lockShownOn = isOwner && s.showOnWebsite !== false && otherVisibleCount === 0;
              const staffCount = staff.filter((o) => o.role === 'STAFF').length;
              const lockServiceProvider = isOwner && s.isServiceProvider !== false && staffCount === 0;
              return (
              <article key={s.id} className={`rounded-3xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${isOwner ? 'border-indigo-200 ring-1 ring-indigo-50' : 'border-slate-200'}`}>
                <div className="flex items-start gap-4">
                  <div className="group relative block h-16 w-16 shrink-0 overflow-hidden rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 transition-colors hover:border-indigo-400" style={s.avatarUrl ? { borderStyle: 'solid' } : {}}>
                      <button
                        type="button"
                        onClick={() => setEditingAvatarFor(s.id)}
                        title={s.avatarUrl ? 'Edit photo' : 'Add photo'}
                        className="block w-full h-full"
                      >
                        {s.avatarUrl ? (
                          <img src={s.avatarUrl} alt={s.name} className="w-full h-full object-cover" />
                        ) : (
                        <div className="flex h-full w-full items-center justify-center text-lg font-black text-slate-500">
                            {(s.name || 'S').charAt(0).toUpperCase()}
                          </div>
                        )}
                      </button>
                      {s.avatarUrl && (
                        <button type="button"
                          onClick={async (e) => { e.preventDefault(); if (await confirm('Remove photo?', { confirmLabel: 'Remove', tone: 'danger' })) updateAvatar(s.id, null); }}
                          className="absolute top-0 right-0 w-4 h-4 bg-red-500 text-white text-[9px] rounded-bl flex items-center justify-center opacity-0 group-hover:opacity-100">x</button>
                      )}
                    </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-extrabold text-slate-950">{s.name || copy.unnamed}</h3>
                      {isOwner && (
                        <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-700">Owner{isSelf ? ' · You' : ''}</span>
                      )}
                      {!isOwner && s.businessRole?.name && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">{s.businessRole.name}</span>
                      )}
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${s.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        {s.isActive ? 'Active' : 'Pending'}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm text-slate-500">{s.subtitle || 'No title set'}</p>
                    <p className="mt-1 truncate text-xs text-slate-400">{s.email}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button onClick={() => setEditing(s)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:border-indigo-300 hover:text-indigo-700">Edit</button>
                    {!isOwner && (
                      <button onClick={() => remove(s.id)} className="rounded-lg border border-red-100 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50">Remove</button>
                    )}
                  </div>
                </div>

                <div className="mt-5 grid gap-3 md:grid-cols-3">
                  <RosterToggle
                    label="Website"
                    enabled={s.showOnWebsite !== false}
                    disabled={lockShownOn}
                    onChange={(checked) => toggleShowOnWebsite(s.id, checked)}
                      title={lockShownOn
                        ? "You're the only team member visible on the website. Add another staff member first, or toggle one of them to Shown."
                        : "Toggle whether this person is shown on the public website's Team section"}
                  />
                  <RosterToggle
                    label={copy.bookingsToggle}
                    enabled={s.isServiceProvider !== false}
                    disabled={lockServiceProvider}
                    onChange={(checked) => toggleServiceProvider(s.id, checked)}
                      title={lockServiceProvider
                        ? "You're the only person who can take bookings. Add a staff member first before stepping back from service."
                        : "Toggle whether this person takes customer bookings. When off, they're hidden from the booking flow."}
                  />
                  {copy.documentIdentityEnabled && (
                    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400">{copy.identityCard}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <AssetPill ready={!!s.signatureUrl} label="Sign" />
                        <AssetPill ready={!!s.stampUrl} label="Stamp" />
                      </div>
                    </div>
                  )}
                </div>
              </article>
              );
            })}
        </div>
      )}

      {editing && (
        <StaffEditModal
          staff={editing}
          roles={roles}
          labels={copy}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); onChange?.(); }}
        />
      )}

      {inviteOpen && (
        <InviteStaffModal
          roles={roles}
          labels={copy}
          onClose={() => setInviteOpen(false)}
          onInvited={() => { setInviteOpen(false); load(); onChange?.(); }}
        />
      )}

      {editingAvatarFor && (
        <ImageEditorModal
          value={staff.find((s) => s.id === editingAvatarFor)?.avatarUrl || ''}
          scope="avatar"
          frameAspect={1}
          maxOutputWidth={400}
          title="Edit photo"
          onSave={(url) => updateAvatar(editingAvatarFor, url)}
          onClose={() => setEditingAvatarFor(null)}
        />
      )}
    </div>
  );
}

function RosterStat({ label, value, tone = 'slate' }) {
  const toneClass = tone === 'emerald'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
    : tone === 'blue'
      ? 'bg-blue-50 text-blue-700 border-blue-100'
      : tone === 'amber'
        ? 'bg-amber-50 text-amber-700 border-amber-100'
        : 'bg-slate-50 text-slate-700 border-slate-100';
  return (
    <div className={`rounded-2xl border px-4 py-3 ${toneClass}`}>
      <p className="text-2xl font-black leading-none">{value}</p>
      <p className="mt-1 text-xs font-bold uppercase tracking-wide opacity-75">{label}</p>
    </div>
  );
}

function RosterToggle({ label, enabled, disabled, onChange, title }) {
  return (
    <label
      className={`rounded-2xl border border-slate-100 bg-slate-50 p-3 select-none ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-white'}`}
      title={title}
    >
      <span className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-[10px] font-bold uppercase tracking-wide text-slate-400">{label}</span>
          <span className={`mt-1 block text-sm font-bold ${enabled ? 'text-emerald-700' : 'text-slate-500'}`}>{enabled ? 'Enabled' : 'Off'}</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-60"
        />
      </span>
    </label>
  );
}

function AssetPill({ ready, label }) {
  return (
    <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${ready ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
      {ready ? 'Ready' : 'Missing'} {label}
    </span>
  );
}

// Edit a staff member's (or own) profile — name, role subtitle, bio.
// Avatar upload stays on the StaffTab's inline avatar slot.
function StaffEditModal({ staff, roles = [], labels = DEFAULT_STAFF_LABELS, onClose, onSaved }) {
  const copy = { ...DEFAULT_STAFF_LABELS, ...labels };
  const roleOptions = assignableRoles(roles);
  const canAssignRole = staff.role !== 'BUSINESS_ADMIN';
  const [form, setForm] = useState({
    name:          staff.name || '',
    subtitle:      staff.subtitle || '',
    bio:           staff.bio || '',
    showOnWebsite: staff.showOnWebsite !== false,
    businessRoleId: staff.businessRoleId || (canAssignRole ? defaultRoleId(roles) : ''),
    signatureUrl:   staff.signatureUrl || '',
    stampUrl:       staff.stampUrl || '',
    // Clinical provider profile (doctor_clinic only) — auto-stamped onto every Rx.
    registrationNumber: staff.registrationNumber || '',
    qualification:      staff.qualification || '',
    speciality:         staff.speciality || '',
    specialtyId:        staff.specialtyId || '',
    languages:          staff.languages || '',
    experienceYears:    staff.experienceYears == null ? '' : String(staff.experienceYears),
    consultationFee:    staff.consultationFee == null ? '' : String(staff.consultationFee),
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editingAsset, setEditingAsset] = useState(null);
  // Doctor v2 — specialties for the assignment dropdown (doctor_clinic only).
  const [specialties, setSpecialties] = useState([]);
  useEffect(() => {
    if (!copy.documentIdentityEnabled) return undefined;
    let cancelled = false;
    api('/api/specialties').then((r) => { if (!cancelled) setSpecialties(r.specialties || []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [copy.documentIdentityEnabled]);

  async function submit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const payload = { ...form };
      if (!canAssignRole) delete payload.businessRoleId;
      // Clinical fields only belong to doctor_clinic; for everyone else strip
      // them so we never send empty strings to the API. Numbers get coerced
      // (blank → null so the value can be cleared).
      if (copy.documentIdentityEnabled) {
        payload.experienceYears = form.experienceYears === '' ? null : parseInt(form.experienceYears, 10);
        payload.consultationFee = form.consultationFee === '' ? null : Number(form.consultationFee);
      } else {
        delete payload.registrationNumber;
        delete payload.qualification;
        delete payload.speciality;
        delete payload.specialtyId;
        delete payload.languages;
        delete payload.experienceYears;
        delete payload.consultationFee;
      }
      await api(`/api/business/staff/${staff.id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      onSaved();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  const initials = (form.name || staff.email || 'S').split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();

  return (
    <Modal title={`Edit ${staff.name || 'profile'}`} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-5">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-lg font-black text-white shadow-sm">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-indigo-700">{copy.profileEyebrow}</p>
              <h4 className="mt-1 truncate text-xl font-extrabold text-slate-950">{form.name || copy.profileFallback}</h4>
              <p className="mt-1 text-sm text-slate-500">{staff.email}</p>
            </div>
          </div>
        </div>

        <section className="space-y-3">
          <StaffEditSectionTitle title="Profile details" note="Shown in admin, booking flows, and the public team section when enabled." />
          <div className="grid gap-4 md:grid-cols-2">
            <TextInput
              label="Name *"
              value={form.name}
              onChange={(v) => setForm({ ...form, name: v })}
              required
            />
            <TextInput
              label="Role / title"
              value={form.subtitle}
              onChange={(v) => setForm({ ...form, subtitle: v })}
              placeholder={copy.titlePlaceholder}
              hint="Short one-line title shown under the name."
            />
            {canAssignRole && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-700">Access role</span>
                <select
                  value={form.businessRoleId}
                  onChange={(e) => setForm({ ...form, businessRoleId: e.target.value })}
                  className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                >
                  {roleOptions.length === 0 && <option value="">Default staff</option>}
                  {roleOptions.map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <TextArea
            label="About"
            value={form.bio}
            onChange={(v) => setForm({ ...form, bio: v })}
            placeholder={copy.aboutPlaceholder}
            rows={4}
          />
          <p className="text-xs text-gray-500">Up to ~600 characters. Can be left blank.</p>
        </section>

        <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 cursor-pointer hover:border-indigo-200 hover:bg-indigo-50/30 transition-colors">
          <input
            type="checkbox"
            checked={form.showOnWebsite}
            onChange={(e) => setForm({ ...form, showOnWebsite: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          />
          <span>
            <span className="block text-sm font-semibold text-slate-950">Show on public website</span>
            <span className="block text-sm text-slate-500 mt-1">When off, this person remains in the staff list and can still take bookings, but is hidden from the public Team section.</span>
          </span>
        </label>

        {copy.documentIdentityEnabled && (
          <section className="rounded-2xl border border-teal-200 bg-teal-50/40 p-4 shadow-sm">
            <div>
              <h4 className="text-sm font-bold text-teal-900">Clinical profile</h4>
              <p className="mt-1 text-sm text-teal-800/70">
                Professional details for this provider. Auto-stamped onto every prescription they sign.
              </p>
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <TextInput
                label="Registration / licence no."
                value={form.registrationNumber}
                onChange={(v) => setForm({ ...form, registrationNumber: v })}
                placeholder="e.g. DMC/R/12345"
                hint="Medical council / licence number printed on the Rx."
              />
              <TextInput
                label="Qualification"
                value={form.qualification}
                onChange={(v) => setForm({ ...form, qualification: v })}
                placeholder="e.g. MBBS, MD"
              />
              <TextInput
                label="Speciality"
                value={form.speciality}
                onChange={(v) => setForm({ ...form, speciality: v })}
                placeholder="e.g. Cardiology, General Medicine"
              />
              {specialties.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Department / specialty (booking filter)</label>
                  <select
                    value={form.specialtyId}
                    onChange={(e) => setForm({ ...form, specialtyId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">— Not assigned —</option>
                    {specialties.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
                  </select>
                  <p className="text-[11px] text-gray-500 mt-1">Manage the list in the Specialties tab.</p>
                </div>
              )}
              <TextInput
                label="Languages"
                value={form.languages}
                onChange={(v) => setForm({ ...form, languages: v })}
                placeholder="e.g. English, Hindi"
                hint="Comma-separated."
              />
              <TextInput
                label="Years of experience"
                type="number"
                value={form.experienceYears}
                onChange={(v) => setForm({ ...form, experienceYears: v })}
                placeholder="e.g. 12"
              />
              <TextInput
                label="Consultation fee"
                type="number"
                value={form.consultationFee}
                onChange={(v) => setForm({ ...form, consultationFee: v })}
                placeholder="e.g. 500"
              />
            </div>
          </section>
        )}

        {copy.documentIdentityEnabled && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <StaffEditSectionTitle title={copy.identitySection} note={copy.identityNote} />
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <StaffDocumentAsset
                label={copy.signatureLabel}
                description="Best as a transparent PNG or clean white-background crop."
                value={form.signatureUrl}
                onEdit={() => setEditingAsset('signatureUrl')}
                onRemove={() => setForm({ ...form, signatureUrl: '' })}
              />
              <StaffDocumentAsset
                label={copy.stampLabel}
                description="Optional. Appears beside the signature on saved documents."
                value={form.stampUrl}
                onEdit={() => setEditingAsset('stampUrl')}
                onRemove={() => setForm({ ...form, stampUrl: '' })}
              />
            </div>
          </section>
        )}

        {error && <ErrorBanner message={error} />}
        <div className="sticky bottom-0 -mx-6 -mb-5 border-t border-slate-200 bg-white/95 px-6 py-4 backdrop-blur">
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          <PrimaryButton type="submit" loading={loading}>Save changes</PrimaryButton>
        </ModalActions>
        </div>
        {editingAsset && (
          <ImageEditorModal
            value={form[editingAsset] || ''}
            scope={editingAsset === 'signatureUrl' ? 'doctor-signature' : 'doctor-stamp'}
            frameAspect={editingAsset === 'signatureUrl' ? 3 : 1}
            maxOutputWidth={editingAsset === 'signatureUrl' ? 900 : 600}
            title={editingAsset === 'signatureUrl' ? 'Edit signature' : 'Edit stamp'}
            onSave={(url) => {
              setForm((prev) => ({ ...prev, [editingAsset]: url }));
              setEditingAsset(null);
            }}
            onClose={() => setEditingAsset(null)}
          />
        )}
      </form>
    </Modal>
  );
}

function StaffEditSectionTitle({ title, note }) {
  return (
    <div>
      <h4 className="text-sm font-bold text-slate-950">{title}</h4>
      {note && <p className="mt-1 text-sm text-slate-500">{note}</p>}
    </div>
  );
}

function StaffDocumentAsset({ label, description, value, onEdit, onRemove }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
      <div className="flex h-32 items-center justify-center border-b border-slate-200 bg-white p-4">
        {value ? (
          <img src={value} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-xs font-semibold text-slate-400">
            Not uploaded
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-950">{label}</p>
            {description && <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>}
          </div>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${value ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-500'}`}>
            {value ? 'Ready' : 'Missing'}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={onEdit} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:border-indigo-300 hover:text-indigo-700">
            {value ? 'Replace' : 'Upload'}
          </button>
          {value && (
            <button type="button" onClick={onRemove} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50">
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function assignableRoles(roles = []) {
  return roles.filter((role) => role.name !== 'Owner');
}

function defaultRoleId(roles = [], preferredNames = ['Doctor']) {
  const available = assignableRoles(roles);
  const preferred = available.find((role) => preferredNames.some((name) => role.name === name));
  return preferred?.id || available[0]?.id || '';
}

function InviteStaffModal({ roles = [], labels = DEFAULT_STAFF_LABELS, onClose, onInvited }) {
  const copy = { ...DEFAULT_STAFF_LABELS, ...labels };
  const roleOptions = assignableRoles(roles);
  const [form, setForm] = useState({ name: '', email: '', businessRoleId: defaultRoleId(roles, copy.defaultRoleNames) });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!form.businessRoleId && roleOptions.length > 0) {
      setForm((current) => ({ ...current, businessRoleId: defaultRoleId(roles, copy.defaultRoleNames) }));
    }
  }, [form.businessRoleId, roleOptions.length, roles, copy.defaultRoleNames]);
  async function submit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api('/api/business/staff', { method: 'POST', body: JSON.stringify(form) });
      onInvited();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }
  return (
    <Modal title={copy.inviteModalTitle} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <TextInput label="Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <TextInput label="Email *" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} required />
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-700">Access role *</span>
          <select
            value={form.businessRoleId}
            onChange={(e) => setForm({ ...form, businessRoleId: e.target.value })}
            required={roleOptions.length > 0}
            className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
          >
            {roleOptions.length === 0 && <option value="">Default staff</option>}
            {roleOptions.map((role) => (
              <option key={role.id} value={role.id}>{role.name}</option>
            ))}
          </select>
        </label>
        {error && <ErrorBanner message={error} />}
        <p className="text-xs text-gray-500">{copy.inviteHelp}</p>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          <PrimaryButton type="submit" loading={loading}>Send invite</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ============================================================================
// Services tab
// ============================================================================

export default StaffTab;
