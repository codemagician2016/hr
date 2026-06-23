'use client';

// Profile — the employee's rich Personal Information (Feature 13). Sectioned like the
// owner's Figma: Personal · Contact · Address · Family · Bank · Education · Professional
// · Nomination · Photo ID. Every field carries a GOVERNANCE policy from the server
// (GET /api/hr/me/profile/full): self-edit (green pencil, commits immediately),
// hr-approval (amber lock — "needs HR approval", files a change request + shows a
// pending chip), or read-only (grey, no pencil). The client never guesses policy.
//
// SELF-SERVICE SURFACE: every call is to the customer-session /api/hr/me/profile/*
// endpoints, which resolve the employee SERVER-SIDE. The page NEVER sends an employeeId.
//   Read   : GET   /api/hr/me/profile/full
//   Self   : PATCH /api/hr/me/profile/personal | /contact
//   Address: PUT   /api/hr/me/profile/addresses/:type   (with "same as" toggle)
//   Lists  : POST/PATCH/DELETE /api/hr/me/profile/emergency|education|family
//   Gated  : POST  /api/hr/me/profile/change-requests   { changes:[{field,newValue}] }
//   Photo  : POST  /api/hr/me/profile/photo
//
// Two shortcut tiles deep-link the already-built flows: Request Bonafide Letter
// (/letters) and Raise Separation Request (/separation).

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import AppShell from '@/components/AppShell';
import { Spinner, Centered, ErrorBanner, Empty } from '@hr/ui';
import { apiPost, apiSend } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { formatDate } from '@/lib/format';

// ── tooltip ⓘ — every field gets one (premium + layman-friendly) ──────────────
function Info({ text }) {
  if (!text) return null;
  return (
    <span className="relative ml-1 inline-flex group align-middle">
      <span tabIndex={0} aria-label={text} role="img"
            className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border text-[10px] font-bold"
            style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>i</span>
      <span className="pointer-events-none absolute left-1/2 top-6 z-20 hidden w-56 -translate-x-1/2 rounded-lg p-2 text-xs shadow-lg group-hover:block group-focus-within:block"
            style={{ background: 'var(--theme-text)', color: 'white' }}>{text}</span>
    </span>
  );
}

const POLICY_BADGE = {
  'self-edit': { label: 'You can edit', color: '#16a34a', icon: '✎' },
  'hr-approval': { label: 'Needs HR approval', color: '#d97706', icon: '🔒' },
  'read-only': { label: 'Managed by HR', color: '#6b7280', icon: '•' },
};

// A single governed field row: label, current value, an affordance per policy, and a
// "pending HR approval" chip when a change request is open for it.
function FieldRow({ fieldKey, label, field, hint, options, pending, onSave }) {
  const policy = field?.policy || 'read-only';
  const optional = field?.optional;
  const sensitive = field?.sensitive;
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(field?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const badge = POLICY_BADGE[policy];
  const isPending = !!pending;

  async function save() {
    setBusy(true); setErr(null);
    try { await onSave(fieldKey, val, policy); setEditing(false); }
    catch (e) { setErr(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex items-start justify-between gap-3 border-b py-3 text-sm last:border-b-0" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center" style={{ color: 'var(--theme-muted)' }}>
          <span>{label}</span>
          <Info text={hint} />
          {optional && <span className="ml-2 rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-muted)' }}>Optional — you may leave this blank</span>}
          {sensitive && <span className="ml-1 text-[10px]" style={{ color: 'var(--theme-muted)' }} title="Sensitive — only you and HR can see this">·private</span>}
        </div>
        {!editing && (
          <div className="mt-0.5 font-medium" style={{ color: (field?.value == null || field?.value === '') ? 'var(--theme-muted)' : 'var(--theme-text)' }}>
            {field?.value == null || field?.value === '' ? '—' : (options ? (options.find((o) => o.value === field.value)?.label || field.value) : String(field.value))}
          </div>
        )}
        {editing && (
          <div className="mt-1 space-y-1">
            {options ? (
              <select value={val ?? ''} onChange={(e) => setVal(e.target.value)} className="w-full rounded border px-2 py-1" style={{ borderColor: 'var(--theme-border)' }}>
                <option value="">—</option>
                {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input value={val ?? ''} onChange={(e) => setVal(e.target.value)} className="w-full rounded border px-2 py-1" style={{ borderColor: 'var(--theme-border)' }} />
            )}
            {policy === 'hr-approval' && (
              <p className="text-xs" style={{ color: '#d97706' }}>This change needs HR approval. We&apos;ll send a request — the new value applies once HR approves.</p>
            )}
            {err && <p className="text-xs text-red-600">{err}</p>}
            <div className="flex gap-2">
              <button onClick={save} disabled={busy} className="rounded px-3 py-1 text-xs font-semibold text-white" style={{ background: 'var(--theme-primary)' }}>{busy ? 'Saving…' : (policy === 'hr-approval' ? 'Send request' : 'Save')}</button>
              <button onClick={() => { setEditing(false); setVal(field?.value ?? ''); setErr(null); }} className="rounded border px-3 py-1 text-xs" style={{ borderColor: 'var(--theme-border)' }}>Cancel</button>
            </div>
          </div>
        )}
        {isPending && !editing && (
          <span className="mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: '#fef3c7', color: '#92400e' }}>
            Pending HR approval{pending.newValue ? ` → ${pending.newValue}` : ''}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        <span className="hidden text-[11px] sm:inline" style={{ color: badge.color }} title={badge.label}>{badge.label}</span>
        {policy !== 'read-only' && !editing && !isPending && (
          <button onClick={() => setEditing(true)} className="rounded p-1 text-xs" title={policy === 'hr-approval' ? 'Request change' : 'Edit'} style={{ color: badge.color }} aria-label={`Edit ${label}`}>{badge.icon}</button>
        )}
      </div>
    </div>
  );
}

function Section({ title, hint, children, action }) {
  return (
    <section className="rounded-2xl border bg-white p-5 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center text-base font-semibold" style={{ color: 'var(--theme-text)' }}>{title}{hint && <Info text={hint} />}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const SECTIONS = [
  { key: 'personal', label: 'Personal' },
  { key: 'contact', label: 'Contact' },
  { key: 'address', label: 'Address' },
  { key: 'family', label: 'Family' },
  { key: 'bank', label: 'Bank' },
  { key: 'education', label: 'Education' },
  { key: 'professional', label: 'Professional' },
  { key: 'nomination', label: 'Nomination' },
  { key: 'photo', label: 'Photo ID' },
];

const GENDER_OPTS = [
  { value: 'MALE', label: 'Male' }, { value: 'FEMALE', label: 'Female' },
  { value: 'NON_BINARY', label: 'Non-binary' }, { value: 'UNDISCLOSED', label: 'Prefer not to say' }, { value: 'OTHER', label: 'Other' },
];
const MARITAL_OPTS = [
  { value: 'SINGLE', label: 'Single' }, { value: 'MARRIED', label: 'Married' }, { value: 'DIVORCED', label: 'Divorced' },
  { value: 'WIDOWED', label: 'Widowed' }, { value: 'SEPARATED', label: 'Separated' }, { value: 'CIVIL_UNION', label: 'Civil union' }, { value: 'UNDISCLOSED', label: 'Prefer not to say' },
];

function ProfileInner() {
  const router = useRouter();
  const { data, loading, error, reload } = useApi('/api/hr/me/profile/full');
  const [active, setActive] = useState('personal');
  const [toast, setToast] = useState(null);

  const sections = data?.sections;
  const pending = data?.pendingChangeRequests || {};
  const readOnly = data?.readOnly;

  function flash(msg) { setToast(msg); setTimeout(() => setToast(null), 2500); }

  // Save one field. Self-edit → PATCH personal/contact; hr-approval → change-requests.
  async function saveField(fieldKey, value, policy) {
    if (policy === 'hr-approval') {
      await apiPost('/api/hr/me/profile/change-requests', { changes: [{ field: fieldKey, newValue: value }] });
      flash('Change request sent to HR');
    } else {
      const contactFields = new Set(['phone', 'homePhone', 'officePhone', 'personalEmail']);
      const path = contactFields.has(fieldKey) ? 'contact' : 'personal';
      await apiSend(`/api/hr/me/profile/${path}`, 'PATCH', { [fieldKey]: value });
      flash('Saved');
    }
    await reload();
  }

  if (loading) return <Centered><Spinner /></Centered>;
  if (error) return <ErrorBanner message={error.message || 'Could not load your profile'} />;
  if (!sections) return <Empty text="No employee record is linked to your account yet." />;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Personal Information</h1>

      {readOnly && (
        <div className="rounded-xl border px-4 py-3 text-sm" style={{ borderColor: '#fbbf24', background: '#fffbeb', color: '#92400e' }}>
          Your account is no longer active, so your profile is read-only.
        </div>
      )}

      {/* Shortcut tiles — deep-link the already-built flows */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button onClick={() => router.push('/letters')} className="flex items-center justify-between rounded-2xl border bg-white p-4 text-left shadow-sm hover:shadow" style={{ borderColor: 'var(--theme-border)' }}>
          <div><div className="font-semibold" style={{ color: 'var(--theme-text)' }}>Request Bonafide Letter</div><div className="text-xs" style={{ color: 'var(--theme-muted)' }}>Ask HR for an employment / salary certificate</div></div>
          <span aria-hidden style={{ color: 'var(--theme-primary)' }}>→</span>
        </button>
        <button onClick={() => router.push('/separation')} className="flex items-center justify-between rounded-2xl border bg-white p-4 text-left shadow-sm hover:shadow" style={{ borderColor: 'var(--theme-border)' }}>
          <div><div className="font-semibold" style={{ color: 'var(--theme-text)' }}>Raise Separation Request</div><div className="text-xs" style={{ color: 'var(--theme-muted)' }}>Begin your resignation / exit</div></div>
          <span aria-hidden style={{ color: 'var(--theme-primary)' }}>→</span>
        </button>
      </div>

      {toast && <div className="rounded-lg px-4 py-2 text-sm text-white" style={{ background: 'var(--theme-primary)' }}>{toast}</div>}

      {/* Section rail + content */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-[180px_1fr]">
        <nav className="md:sticky md:top-4 md:self-start" aria-label="Profile sections">
          <ul className="flex gap-2 overflow-x-auto md:flex-col md:gap-1">
            {SECTIONS.map((s) => (
              <li key={s.key}>
                <button onClick={() => setActive(s.key)} aria-current={active === s.key ? 'true' : undefined}
                        className="w-full whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium"
                        style={active === s.key ? { background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' } : { color: 'var(--theme-text)' }}>
                  {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="space-y-5">
          {active === 'personal' && (
            <Section title="Personal" hint="Your identity details. Some (name, date of birth) need HR approval to change.">
              <FieldRow fieldKey="firstName" label="First name" hint="Your legal first name." field={sections.personal.firstName} pending={pending.firstName} onSave={saveField} />
              <FieldRow fieldKey="lastName" label="Last name" hint="Your legal last name." field={sections.personal.lastName} pending={pending.lastName} onSave={saveField} />
              <FieldRow fieldKey="dateOfBirth" label="Date of birth" hint="Used for statutory records; changing it needs HR approval." field={sections.personal.dateOfBirth} pending={pending.dateOfBirth} onSave={saveField} />
              <FieldRow fieldKey="gender" label="Gender" hint="As you identify; changing it needs HR approval." field={sections.personal.gender} options={GENDER_OPTS} pending={pending.gender} onSave={saveField} />
              <FieldRow fieldKey="maritalStatus" label="Marital status" hint="Your current marital status." field={sections.personal.maritalStatus} options={MARITAL_OPTS} pending={pending.maritalStatus} onSave={saveField} />
              <FieldRow fieldKey="bloodGroup" label="Blood group" hint="Optional — useful in emergencies." field={sections.personal.bloodGroup} pending={pending.bloodGroup} onSave={saveField} />
              <FieldRow fieldKey="religion" label="Religion" hint="Optional and private." field={sections.personal.religion} pending={pending.religion} onSave={saveField} />
              <FieldRow fieldKey="community" label="Community" hint="Optional and private." field={sections.personal.community} pending={pending.community} onSave={saveField} />
              <FieldRow fieldKey="motherTongue" label="Mother tongue" hint="Your first language." field={sections.personal.motherTongue} pending={pending.motherTongue} onSave={saveField} />
              <FieldRow fieldKey="nationality" label="Nationality" hint="Your nationality." field={sections.personal.nationality} pending={pending.nationality} onSave={saveField} />
              <FieldRow fieldKey="placeOfBirth" label="Place of birth" hint="Optional." field={sections.personal.placeOfBirth} pending={pending.placeOfBirth} onSave={saveField} />
              <FieldRow fieldKey="stateOfBirthCode" label="State of birth" hint="2-letter state code, optional." field={sections.personal.stateOfBirthCode} pending={pending.stateOfBirthCode} onSave={saveField} />
              <FieldRow fieldKey="identificationMark" label="Identification mark" hint="Optional — a distinguishing mark (for ID records)." field={sections.personal.identificationMark} pending={pending.identificationMark} onSave={saveField} />
              <FieldRow fieldKey="heightCm" label="Height (cm)" hint="Optional." field={sections.personal.heightCm} pending={pending.heightCm} onSave={saveField} />
              <FieldRow fieldKey="weightKg" label="Weight (kg)" hint="Optional." field={sections.personal.weightKg} pending={pending.weightKg} onSave={saveField} />
              <FieldRow fieldKey="fatherName" label="Father's name" hint="Optional." field={sections.personal.fatherName} pending={pending.fatherName} onSave={saveField} />
              <FieldRow fieldKey="fatherOccupation" label="Father's occupation" hint="Optional." field={sections.personal.fatherOccupation} pending={pending.fatherOccupation} onSave={saveField} />
              <FieldRow fieldKey="motherName" label="Mother's name" hint="Optional." field={sections.personal.motherName} pending={pending.motherName} onSave={saveField} />
              <FieldRow fieldKey="motherOccupation" label="Mother's occupation" hint="Optional." field={sections.personal.motherOccupation} pending={pending.motherOccupation} onSave={saveField} />
            </Section>
          )}

          {active === 'contact' && (
            <Section title="Contact" hint="How we reach you. Your official email is your login and is managed by HR.">
              <FieldRow fieldKey="personalEmail" label="Personal email" hint="Your personal email — you can change this freely." field={sections.contact.personalEmail} pending={pending.personalEmail} onSave={saveField} />
              <FieldRow fieldKey="workEmail" label="Official email" hint="Your work email is your login identity and is managed by HR." field={sections.contact.workEmail} onSave={saveField} />
              <FieldRow fieldKey="phone" label="Mobile" hint="Your personal mobile number." field={sections.contact.phone} pending={pending.phone} onSave={saveField} />
              <FieldRow fieldKey="homePhone" label="Home phone" hint="Your home landline (optional)." field={sections.contact.homePhone} pending={pending.homePhone} onSave={saveField} />
              <FieldRow fieldKey="officePhone" label="Office phone" hint="Your office landline / extension (optional)." field={sections.contact.officePhone} pending={pending.officePhone} onSave={saveField} />
            </Section>
          )}

          {active === 'address' && <AddressSection addresses={sections.addresses} reload={reload} flash={flash} readOnly={readOnly} />}
          {active === 'family' && <FamilySection family={sections.family} emergency={sections.emergencyContacts} reload={reload} flash={flash} readOnly={readOnly} />}
          {active === 'bank' && (
            <Section title="Bank" hint="Your salary account. Changes need HR approval (it's where your pay lands).">
              {sections.bank ? (
                <>
                  <FieldRow fieldKey="bank.accountName" label="Account holder name" hint="Name on the bank account." field={sections.bank.accountName} pending={pending['bank.accountName']} onSave={saveField} />
                  <FieldRow fieldKey="bank.accountNumber" label="Account number" hint="Your salary account number — change needs HR approval." field={sections.bank.accountNumber} pending={pending['bank.accountNumber']} onSave={saveField} />
                  <FieldRow fieldKey="bank.ifsc" label="IFSC (India)" hint="11-character IFSC of your branch — change needs HR approval." field={sections.bank.ifsc} pending={pending['bank.ifsc']} onSave={saveField} />
                  <FieldRow fieldKey="bank.nzBankAccount" label="Bank account (NZ)" hint="NZ bank account BB-bbbb-AAAAAAA-SS — change needs HR approval." field={sections.bank.nzBankAccount} pending={pending['bank.nzBankAccount']} onSave={saveField} />
                  <FieldRow fieldKey="bank.bankName" label="Bank name" hint="Your bank's name." field={sections.bank.bankName} pending={pending['bank.bankName']} onSave={saveField} />
                </>
              ) : <Empty text="No bank account on file yet. Contact HR to add one." />}
            </Section>
          )}
          {active === 'education' && <EducationSection education={sections.education} reload={reload} flash={flash} readOnly={readOnly} />}
          {active === 'professional' && (
            <Section title="Professional" hint="Your role and reporting details — managed by HR / your manager.">
              {[
                ['Employee code', sections.professional.employeeCode],
                ['Designation', sections.professional.designation],
                ['Department', sections.professional.department],
                ['Location', sections.professional.location],
                ['Date of joining', { value: sections.professional.dateOfJoining?.value ? formatDate(sections.professional.dateOfJoining.value) : null, policy: 'read-only' }],
                ['Manager', sections.professional.manager],
                ['Status', sections.professional.status],
              ].map(([label, f]) => <FieldRow key={label} fieldKey={label} label={label} hint="Managed by HR / your manager." field={f} onSave={saveField} />)}
            </Section>
          )}
          {active === 'nomination' && (
            <Section title="Nomination" hint="Who receives your PF / gratuity benefits. Add nominees in the Family section.">
              {sections.nomination?.length ? (
                <ul className="divide-y" style={{ borderColor: 'var(--theme-border)' }}>
                  {sections.nomination.map((n) => (
                    <li key={n.id} className="flex items-center justify-between py-2 text-sm">
                      <span style={{ color: 'var(--theme-text)' }}>{n.name} <span style={{ color: 'var(--theme-muted)' }}>({n.relationship})</span></span>
                      <span className="font-medium" style={{ color: 'var(--theme-primary)' }}>{n.nomineePercent ?? 0}%</span>
                    </li>
                  ))}
                </ul>
              ) : <Empty text="No nominees yet. Add a family member and mark them as a nominee." />}
            </Section>
          )}
          {active === 'photo' && <PhotoSection url={sections.photo?.photoUrl} reload={reload} flash={flash} readOnly={readOnly} />}
        </div>
      </div>
    </div>
  );
}

// ── Address section (typed + "same as") ──────────────────────────────────────
function AddressSection({ addresses, reload, flash, readOnly }) {
  const types = [['CORRESPONDENCE', 'Correspondence address'], ['PERMANENT', 'Permanent address'], ['OFFICE', 'Office address']];
  return (
    <Section title="Address" hint="Where you live and work. You can edit these freely.">
      {types.map(([type, label]) => <AddressBlock key={type} type={type} label={label} addr={addresses?.[type]} reload={reload} flash={flash} readOnly={readOnly} />)}
    </Section>
  );
}
function AddressBlock({ type, label, addr, reload, flash, readOnly }) {
  const [form, setForm] = useState(() => ({ line1: addr?.line1 || '', line2: addr?.line2 || '', city: addr?.city || '', stateCode: addr?.stateCode || '', postalCode: addr?.postalCode || '', countryCode: addr?.countryCode || '' }));
  const [sameAs, setSameAs] = useState(addr?.sameAsType || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const body = sameAs ? { sameAsType: sameAs } : form;
      await apiSend(`/api/hr/me/profile/addresses/${type}`, 'PUT', body);
      flash('Address saved'); await reload();
    } finally { setBusy(false); }
  }
  return (
    <div className="border-b py-3 last:border-b-0" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="mb-1 flex items-center text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{label}<Info text="You can edit this address freely." /></div>
      {type === 'PERMANENT' && (
        <label className="mb-2 flex items-center gap-2 text-xs" style={{ color: 'var(--theme-muted)' }}>
          <input type="checkbox" checked={sameAs === 'CORRESPONDENCE'} disabled={readOnly} onChange={(e) => setSameAs(e.target.checked ? 'CORRESPONDENCE' : '')} />
          Same as correspondence address
        </label>
      )}
      {sameAs ? (
        <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>Mirrors your correspondence address.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {[['line1', 'Address line 1'], ['line2', 'Address line 2'], ['city', 'City'], ['stateCode', 'State'], ['postalCode', 'PIN / Postcode'], ['countryCode', 'Country (2-letter)']].map(([k, ph]) => (
            <input key={k} placeholder={ph} disabled={readOnly} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} className="rounded border px-2 py-1 text-sm" style={{ borderColor: 'var(--theme-border)' }} />
          ))}
        </div>
      )}
      {!readOnly && <button onClick={save} disabled={busy} className="mt-2 rounded px-3 py-1 text-xs font-semibold text-white" style={{ background: 'var(--theme-primary)' }}>{busy ? 'Saving…' : 'Save'}</button>}
    </div>
  );
}

// ── Family + emergency ───────────────────────────────────────────────────────
function FamilySection({ family, emergency, reload, flash, readOnly }) {
  return (
    <>
      <Section title="Family" hint="Your dependants. Mark a person as a nominee (and a %) for PF / gratuity.">
        <ListEditor items={family} readOnly={readOnly} flash={flash} reload={reload} base="/api/hr/me/profile/family"
          columns={[['name', 'Name', 'text'], ['relationship', 'Relationship', 'select-rel'], ['nomineePercent', 'Nominee %', 'number']]}
          render={(d) => `${d.name} · ${d.relationship}${d.isNominee ? ` · nominee ${d.nomineePercent || 0}%` : ''}`}
          newItem={{ name: '', relationship: 'SPOUSE', isNominee: false, nomineePercent: '' }} />
      </Section>
      <Section title="Emergency contacts" hint="Up to two people we can reach in an emergency.">
        <ListEditor items={emergency} readOnly={readOnly} flash={flash} reload={reload} base="/api/hr/me/profile/emergency" max={2}
          columns={[['name', 'Name', 'text'], ['relationship', 'Relationship', 'text'], ['phone', 'Phone', 'text']]}
          render={(c) => `${c.name} · ${c.relationship} · ${c.phone}`}
          newItem={{ name: '', relationship: '', phone: '' }} />
      </Section>
    </>
  );
}

// ── Education ────────────────────────────────────────────────────────────────
function EducationSection({ education, reload, flash, readOnly }) {
  return (
    <Section title="Education" hint="Your qualifications. You can add, edit and remove these freely.">
      <ListEditor items={education} readOnly={readOnly} flash={flash} reload={reload} base="/api/hr/me/profile/education"
        columns={[['level', 'Level', 'select-edu'], ['institution', 'Institution', 'text'], ['fieldOfStudy', 'Field of study', 'text'], ['endYear', 'Year', 'number'], ['grade', 'Grade', 'text']]}
        render={(e) => `${e.level} · ${e.institution}${e.fieldOfStudy ? ` · ${e.fieldOfStudy}` : ''}${e.endYear ? ` (${e.endYear})` : ''}`}
        newItem={{ level: 'BACHELORS', institution: '', fieldOfStudy: '', endYear: '', grade: '' }} />
    </Section>
  );
}

const REL_OPTS = [['SPOUSE', 'Spouse'], ['CHILD', 'Child'], ['PARENT', 'Parent'], ['SIBLING', 'Sibling'], ['OTHER', 'Other']];
const EDU_OPTS = [['SCHOOL', 'School'], ['DIPLOMA', 'Diploma'], ['BACHELORS', "Bachelor's"], ['MASTERS', "Master's"], ['DOCTORATE', 'Doctorate'], ['CERTIFICATION', 'Certification'], ['OTHER', 'Other']];

// A tiny add/edit/delete list editor for the self-service collections.
function ListEditor({ items, columns, render, newItem, base, max, readOnly, reload, flash }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const atMax = max && (items?.length || 0) >= max;

  async function submit() {
    setBusy(true);
    try {
      const payload = { ...draft };
      if (payload.isNominee === undefined && Object.prototype.hasOwnProperty.call(payload, 'nomineePercent')) payload.isNominee = !!payload.nomineePercent;
      if (draft.id) await apiSend(`${base}/${draft.id}`, 'PATCH', payload);
      else await apiPost(base, payload);
      flash('Saved'); setDraft(null); await reload();
    } catch (e) { alert(e.message || 'Could not save'); }
    finally { setBusy(false); }
  }
  async function remove(id) {
    if (!confirm('Remove this entry?')) return;
    await apiSend(`${base}/${id}`, 'DELETE'); await reload(); flash('Removed');
  }
  function field([k, label, kind]) {
    if (kind === 'select-rel') return <select key={k} value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} className="rounded border px-2 py-1 text-sm" style={{ borderColor: 'var(--theme-border)' }}>{REL_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
    if (kind === 'select-edu') return <select key={k} value={draft[k]} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} className="rounded border px-2 py-1 text-sm" style={{ borderColor: 'var(--theme-border)' }}>{EDU_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
    return <input key={k} placeholder={label} type={kind === 'number' ? 'number' : 'text'} value={draft[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} className="rounded border px-2 py-1 text-sm" style={{ borderColor: 'var(--theme-border)' }} />;
  }
  return (
    <div className="space-y-2">
      {(items || []).length === 0 && <p className="text-sm" style={{ color: 'var(--theme-muted)' }}>None yet.</p>}
      <ul className="space-y-1">
        {(items || []).map((it) => (
          <li key={it.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm" style={{ borderColor: 'var(--theme-border)' }}>
            <span style={{ color: 'var(--theme-text)' }}>{render(it)}</span>
            {!readOnly && (
              <span className="flex gap-2">
                <button onClick={() => setDraft({ ...newItem, ...it })} className="text-xs" style={{ color: 'var(--theme-primary)' }}>Edit</button>
                <button onClick={() => remove(it.id)} className="text-xs text-red-600">Remove</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && draft && (
        <div className="rounded-lg border p-3" style={{ borderColor: 'var(--theme-border)' }}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{columns.map(field)}</div>
          {Object.prototype.hasOwnProperty.call(newItem, 'isNominee') && (
            <label className="mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--theme-muted)' }}>
              <input type="checkbox" checked={!!draft.isNominee} onChange={(e) => setDraft((d) => ({ ...d, isNominee: e.target.checked }))} /> Mark as nominee (PF / gratuity)
            </label>
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={submit} disabled={busy} className="rounded px-3 py-1 text-xs font-semibold text-white" style={{ background: 'var(--theme-primary)' }}>{busy ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setDraft(null)} className="rounded border px-3 py-1 text-xs" style={{ borderColor: 'var(--theme-border)' }}>Cancel</button>
          </div>
        </div>
      )}
      {!readOnly && !draft && !atMax && (
        <button onClick={() => setDraft({ ...newItem })} className="rounded border px-3 py-1 text-xs font-medium" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-primary)' }}>+ Add</button>
      )}
      {atMax && <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>You&apos;ve reached the maximum of {max}.</p>}
    </div>
  );
}

// ── Photo ID ─────────────────────────────────────────────────────────────────
function PhotoSection({ url, reload, flash, readOnly }) {
  const [val, setVal] = useState(url || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await apiPost('/api/hr/me/profile/photo', { photoUrl: val }); flash('Photo updated'); await reload(); }
    finally { setBusy(false); }
  }
  return (
    <Section title="Photo ID" hint="Your profile photo. Paste a hosted image URL (uploads use the documents area).">
      <div className="flex items-center gap-4">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border" style={{ borderColor: 'var(--theme-border)' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {url ? <img src={url} alt="Profile" className="h-full w-full object-cover" /> : <span style={{ color: 'var(--theme-muted)' }}>No photo</span>}
        </div>
        {!readOnly && (
          <div className="flex-1 space-y-2">
            <input value={val} onChange={(e) => setVal(e.target.value)} placeholder="https://…/photo.jpg" className="w-full rounded border px-2 py-1 text-sm" style={{ borderColor: 'var(--theme-border)' }} />
            <button onClick={save} disabled={busy} className="rounded px-3 py-1 text-xs font-semibold text-white" style={{ background: 'var(--theme-primary)' }}>{busy ? 'Saving…' : 'Save photo'}</button>
          </div>
        )}
      </div>
    </Section>
  );
}

export default function ProfilePage() {
  return <AppShell><ProfileInner /></AppShell>;
}
