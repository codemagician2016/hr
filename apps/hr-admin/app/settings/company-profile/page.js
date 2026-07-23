'use client';

// Settings → Company profile.
//
// Two sections, both gated on canManageCompanyProfile (server is the real
// boundary; this page hides the edit controls when the operator lacks the key):
//   1. Business profile — India-first legal/registration fields (legal name,
//      trade name, CIN, GSTIN, PAN, registered address, contact). Optional.
//   2. Business documents — an OPTIONAL company document vault (licences, income-
//      tax reports, financial statements, registration/GST certificates). Upload
//      validates type + 10 MB; list is paginated; download/delete are scoped.
//
// Every field carries an ⓘ tooltip (FieldLabel `tip` / InfoTip) — layman-friendly.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorBanner, PrimaryButton, Spinner } from '@hr/ui';
import { get, patch, post, del, downloadFile } from '@/lib/api';
import { PageHeader, Tabs } from '@/lib/ui';
import { FieldLabel, SectionTitle, InfoTip } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
// Feature 14 — the locked, single-country setup/badge for this tenant.
import CountrySetupCard from '@/components/CountrySetupCard';
import ModuleGuide from '@/components/ModuleGuide';
import { BUSINESS_TYPES, specForBusinessType } from '@/lib/businessTypes';
// Feature 14 — the tenant's authoritative HR country drives which registration
// identifiers we show (India CIN/GSTIN/PAN/TAN vs New Zealand NZBN/IRD).
import { useTenantCountries } from '@/lib/useTenantCountries';

// India-first document categories (mirrors the backend BusinessDocumentCategory enum).
const DOC_CATEGORIES = [
  { key: 'BUSINESS_LICENSE', label: 'Business licence', hint: 'A trade licence, shop & establishment registration, or any operating licence.' },
  { key: 'INCOME_TAX_REPORT', label: 'Income-tax report', hint: 'Filed income-tax return (ITR) or assessment order.' },
  { key: 'FINANCIAL_STATEMENT', label: 'Financial statement', hint: 'Balance sheet, profit & loss, or audited accounts.' },
  { key: 'REGISTRATION_CERTIFICATE', label: 'Registration certificate', hint: 'Certificate of incorporation / registration (e.g. from the MCA).' },
  { key: 'GST_CERTIFICATE', label: 'GST certificate', hint: 'Your GST registration certificate (GSTIN proof).' },
  { key: 'OTHER', label: 'Other', hint: 'Any other company document you want to keep on file.' },
];
const CAT_LABEL = Object.fromEntries(DOC_CATEGORIES.map((c) => [c.key, c.label]));

const ALLOWED_DOC_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg'];
const MAX_DOC_BYTES = 10 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function bytesLabel(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// One labelled text field with an ⓘ tooltip. Mirrors the admin TextInput look.
function ProfileField({ label, tip, value, onChange, placeholder, disabled, type = 'text' }) {
  return (
    <div>
      <FieldLabel tip={tip}>{label}</FieldLabel>
      <input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm disabled:bg-gray-50 disabled:text-gray-500"
      />
    </div>
  );
}

function ProfileTab({ canEdit }) {
  // Tenant HR country (Feature 14). Drives which legal-identifier fields show.
  // Null/unresolved (or IN) → the India view, so an IN tenant sees no change.
  const { country } = useTenantCountries();
  const isNZ = String(country || '').toUpperCase() === 'NZ';
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    get('/api/hr/company-profile')
      .then((res) => setProfile(res.profile || {}))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load company profile.'))
      .finally(() => setLoading(false));
  }, []);

  function set(field, v) {
    setSaved(false);
    setProfile((p) => ({ ...(p || {}), [field]: v }));
  }

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await patch('/api/hr/company-profile', profile || {});
      setProfile(res.profile || {});
      setSaved(true);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to save company profile.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;
  const ro = !canEdit;

  return (
    <div className="max-w-3xl space-y-8">
      {ro && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Editing the company profile requires the company-profile permission.
        </p>
      )}
      {error && <ErrorBanner message={error} />}
      {saved && (
        <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
          Company profile saved.
        </p>
      )}

      {(() => {
        // Pick the business type first; the rest of this section adapts to it
        // (a proprietorship has no CIN, an LLP shows an LLPIN, etc.).
        const spec = specForBusinessType(profile?.businessType);
        return (
          <section className="space-y-4">
            <SectionTitle tip={isNZ ? "Your organisation's legal identity — its registered name and New Zealand identifiers (NZBN, IRD). Everything is optional; fill in what you have." : "Your organisation's legal identity. Pick your business type first — the right registration fields then appear. Everything is optional; fill in what you have."}>
              Legal &amp; registration
            </SectionTitle>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {isNZ ? (
                <>
                  <ProfileField label="Legal name" tip="The registered legal name as it appears on the New Zealand Companies Register." value={profile?.legalName} onChange={(v) => set('legalName', v)} disabled={ro} placeholder="Acme NZ Limited" />
                  <ProfileField label="Trade name" tip="The brand / trading name you operate under, if different from the legal name." value={profile?.tradeName} onChange={(v) => set('tradeName', v)} disabled={ro} placeholder="Acme" />
                  <ProfileField label="NZBN" tip="Your 13-digit New Zealand Business Number." value={profile?.nzbn} onChange={(v) => set('nzbn', v)} disabled={ro} placeholder="9429000000000" />
                  <ProfileField label="IRD number" tip="Your employer IRD (Inland Revenue) number — required to run PAYE payroll." value={profile?.irdEntityNumber} onChange={(v) => set('irdEntityNumber', v)} disabled={ro} placeholder="012-345-678" />
                </>
              ) : (
                <>
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  <span className="inline-flex items-center">Business type<InfoTip text="The legal structure of your organisation. This decides which registration numbers apply — e.g. a sole proprietorship has no CIN, an LLP has an LLPIN, a partnership firm has a Registrar-of-Firms number." /></span>
                </label>
                <select
                  value={profile?.businessType || ''}
                  onChange={(e) => set('businessType', e.target.value)}
                  disabled={ro}
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm bg-white disabled:bg-gray-50 disabled:text-gray-500"
                >
                  <option value="">Select your business type…</option>
                  {BUSINESS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              <ProfileField label={spec.legalNameLabel} tip="The registered legal name as it appears on your incorporation / registration certificate." value={profile?.legalName} onChange={(v) => set('legalName', v)} disabled={ro} placeholder={spec.legalNamePlaceholder} />
              <ProfileField label="Trade name" tip="The brand / trading name you operate under, if different from the legal name." value={profile?.tradeName} onChange={(v) => set('tradeName', v)} disabled={ro} placeholder="Acme" />

              {spec.proprietor && (
                <ProfileField label="Proprietor's name" tip="The individual who owns the sole proprietorship." value={profile?.proprietorName} onChange={(v) => set('proprietorName', v)} disabled={ro} placeholder="Anil Sharma" />
              )}

              {spec.primaryId.show && (
                <ProfileField label={spec.primaryId.label} tip={spec.primaryId.hint} value={profile?.registrationNo} onChange={(v) => set('registrationNo', v)} disabled={ro} placeholder={spec.primaryId.placeholder} />
              )}

              <ProfileField label={spec.pan.label} tip={spec.pan.hint} value={profile?.pan} onChange={(v) => set('pan', v)} disabled={ro} placeholder={spec.pan.placeholder} />
              <ProfileField label="GSTIN" tip="15-character Goods & Services Tax Identification Number, if you're registered for GST." value={profile?.gstin} onChange={(v) => set('gstin', v)} disabled={ro} placeholder="27AABCU9603R1ZM" />
              <ProfileField label="TAN" tip="Tax Deduction & Collection Account Number — required to deduct TDS and run payroll." value={profile?.tan} onChange={(v) => set('tan', v)} disabled={ro} placeholder="MUMC12345D" />

              {spec.incorporation.show && (
                <ProfileField label={spec.incorporation.label} tip="When the organisation was registered / formed." type="date" value={profile?.incorporationDate} onChange={(v) => set('incorporationDate', v)} disabled={ro} />
              )}
                </>
              )}
            </div>
            {!isNZ && !profile?.businessType && (
              <p className="text-xs text-gray-400">Tip: choose your business type above to see the exact registration fields for your structure.</p>
            )}
          </section>
        );
      })()}

      <section className="space-y-4">
        <SectionTitle tip="The company's official registered address — used on letters and statutory documents.">
          Registered address
        </SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <ProfileField label="Address line 1" tip="Building / street of the registered office." value={profile?.registeredAddressLine1} onChange={(v) => set('registeredAddressLine1', v)} disabled={ro} />
          </div>
          <div className="sm:col-span-2">
            <ProfileField label="Address line 2" tip="Area / landmark (optional)." value={profile?.registeredAddressLine2} onChange={(v) => set('registeredAddressLine2', v)} disabled={ro} />
          </div>
          <ProfileField label="City" tip="City / town of the registered office." value={profile?.registeredCity} onChange={(v) => set('registeredCity', v)} disabled={ro} />
          <ProfileField label="State" tip="State / union territory." value={profile?.registeredState} onChange={(v) => set('registeredState', v)} disabled={ro} />
          <ProfileField label="PIN code" tip="6-digit postal index number." value={profile?.registeredPostalCode} onChange={(v) => set('registeredPostalCode', v)} disabled={ro} placeholder="560001" />
          <ProfileField label="Country" tip={`ISO country code (e.g. ${country || 'IN'}).`} value={profile?.registeredCountry} onChange={(v) => set('registeredCountry', v)} disabled={ro} placeholder={country || 'IN'} />
        </div>
      </section>

      <section className="space-y-4">
        <SectionTitle tip="A point of contact for official / statutory correspondence.">
          Primary contact
        </SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ProfileField label="Contact name" tip="Name of the authorised signatory or main point of contact." value={profile?.contactName} onChange={(v) => set('contactName', v)} disabled={ro} />
          <ProfileField label="Contact email" tip="Official email for company correspondence." type="email" value={profile?.contactEmail} onChange={(v) => set('contactEmail', v)} disabled={ro} />
          <ProfileField label="Contact phone" tip="Official phone number." value={profile?.contactPhone} onChange={(v) => set('contactPhone', v)} disabled={ro} />
        </div>
      </section>

      {!ro && (
        <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
          <PrimaryButton loading={saving} onClick={save}>Save company profile</PrimaryButton>
        </div>
      )}
    </div>
  );
}

function DocumentsTab({ canEdit }) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState('BUSINESS_LICENSE');
  const [name, setName] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await get('/api/hr/company-profile/documents', { page, pageSize });
      setItems(res.items || []);
      setTotal(res.total || 0);
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to load documents.');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => { load(); }, [load]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setUploadError('');
    if (!ALLOWED_DOC_TYPES.includes(file.type)) {
      setUploadError('Use a PDF, PNG or JPG file.');
      return;
    }
    if (file.size > MAX_DOC_BYTES) {
      setUploadError('That file is over 10 MB. Please use a smaller file.');
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      await post('/api/hr/company-profile/documents', {
        category,
        name: name.trim() || file.name,
        fileBase64: dataUrl,
        expiresAt: expiresAt || null,
      });
      setName('');
      setExpiresAt('');
      setPage(1);
      await load();
    } catch (err) {
      setUploadError(err.data?.message || err.message || 'Could not upload that document.');
    } finally {
      setUploading(false);
    }
  }

  async function onDownload(doc) {
    try {
      const res = await get(`/api/hr/company-profile/documents/${doc.id}/download`);
      // Open the stored URL (S3) or inline data URL in a new tab.
      if (res.url) window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not open that document.');
    }
  }

  async function onDelete(doc) {
    if (!window.confirm(`Delete "${doc.name}"? This cannot be undone.`)) return;
    try {
      await del(`/api/hr/company-profile/documents/${doc.id}`);
      await load();
    } catch (err) {
      setError(err.data?.message || err.message || 'Could not delete that document.');
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const ro = !canEdit;

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-gray-600">
        Optionally keep your company documents on file — business licences, income-tax reports, financial
        statements, registration and GST certificates. This is entirely optional.
      </p>

      {error && <ErrorBanner message={error} />}

      {!ro && (
        <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 space-y-4">
          <SectionTitle tip="Upload a company document. We accept PDF, PNG or JPG up to 10 MB.">
            Upload a document
          </SectionTitle>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel tip="What kind of document this is — helps you find it later.">Category</FieldLabel>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm bg-white"
              >
                {DOC_CATEGORIES.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">{DOC_CATEGORIES.find((c) => c.key === category)?.hint}</p>
            </div>
            <div>
              <FieldLabel tip="A friendly name for this document. Leave blank to use the file name.">Name (optional)</FieldLabel>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. GST certificate 2026"
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm"
              />
            </div>
            <div>
              <FieldLabel tip="When this document expires, if it does. We'll badge it when it's close to expiry.">Expiry date (optional)</FieldLabel>
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:outline-none text-sm"
              />
            </div>
            <div>
              <FieldLabel tip="Pick a PDF, PNG or JPG file (max 10 MB).">File</FieldLabel>
              <input
                ref={fileRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                onChange={onFile}
                disabled={uploading}
                className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-50 disabled:opacity-50"
              />
              {uploading && (
                <p className="text-xs text-gray-500 mt-1 inline-flex items-center gap-1"><Spinner small /> Uploading…</p>
              )}
            </div>
          </div>
          {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
        </div>
      )}

      <div>
        <SectionTitle tip="Documents you've saved. Click to open or remove.">Saved documents</SectionTitle>
        {loading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-500 py-6">No documents yet. {canEdit ? 'Upload one above to get started.' : ''}</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Category</th>
                  <th className="px-4 py-2.5">Size</th>
                  <th className="px-4 py-2.5">Expiry</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2.5 font-medium text-gray-900">{d.name}</td>
                    <td className="px-4 py-2.5 text-gray-600">{CAT_LABEL[d.category] || d.category}</td>
                    <td className="px-4 py-2.5 text-gray-600">{bytesLabel(d.sizeBytes)}</td>
                    <td className="px-4 py-2.5 text-gray-600">
                      {d.expiresAt ? new Date(d.expiresAt).toISOString().slice(0, 10) : '—'}
                      {d.expired && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">Expired</span>}
                      {!d.expired && d.expiringSoon && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">Expiring soon</span>}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button type="button" onClick={() => onDownload(d)} className="text-sm font-medium text-indigo-600 hover:text-indigo-800">Open</button>
                      {!ro && (
                        <button type="button" onClick={() => onDelete(d)} className="ml-3 text-sm font-medium text-red-600 hover:text-red-800">Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > pageSize && (
          <div className="flex items-center justify-between gap-3 px-1 py-3 text-sm text-gray-600">
            <span>{total} documents</span>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPage((p) => Math.max(p - 1, 1))} disabled={page <= 1} className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">← Prev</button>
              <span className="text-xs text-gray-500">Page {page} of {pageCount}</span>
              <button type="button" onClick={() => setPage((p) => Math.min(p + 1, pageCount))} disabled={page >= pageCount} className="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">Next →</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CompanyProfilePage() {
  const [tab, setTab] = useState('profile');
  const [canEdit, setCanEdit] = useState(true);

  useEffect(() => {
    get('/api/auth/me')
      .then((me) => {
        const session = me?.user || me;
        setCanEdit(hasPermission(permissionsFromSession(session), 'canManageCompanyProfile'));
      })
      .catch(() => setCanEdit(true));
  }, []);

  return (
    <div className="p-6 sm:p-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Company profile
            <InfoTip text="Your company's legal identity and an optional vault for company documents. Used across letters and statutory paperwork." />
          </span>
        )}
        subtitle="Your business's legal details and an optional document vault."
      />
      <ModuleGuide
        id="settings-company-profile"
        title="Set up your company's legal identity and document vault"
        what="This is your tenant's single source of truth for legal/registration details (legal name, CIN, GSTIN, PAN, TAN, registered address) and an optional vault for company documents. These details flow into payslips, Form 16/24Q filings, offer letters and other statutory paperwork, so getting them right here saves rework everywhere else."
        steps={[
          "On the Profile tab, fill in Legal & registration — legal name, trade name, CIN, GSTIN, PAN, TAN and date of incorporation. Every field is optional, so add what you have.",
          "Add your registered office address (line 1/2, city, state, PIN, country) and a primary contact for statutory correspondence.",
          "Click Save company profile.",
          "Open the Country tab to confirm the locked India setup (₹ INR, Asia/Kolkata) that drives EPF/ESI/PT/TDS behaviour.",
          "On the Documents tab, pick a category, optionally name it and set an expiry, then upload a PDF/PNG/JPG (max 10 MB).",
        ]}
        example={<>For <b>Acme India Pvt Ltd</b>, enter Legal name <b>Acme Technologies Private Limited</b>, CIN <b>U72900KA2020PTC123456</b>, GSTIN <b>29ABCDE1234F1Z5</b>, PAN <b>ABCDE1234F</b> and TAN <b>BLRA12345C</b>, with a registered office in <b>Bengaluru 560001</b> and authorised signatory <b>Aarav Sharma</b>. Then upload the <b>GST certificate 2026</b> under "GST certificate" with an expiry of <b>31 Mar 2027</b>.</>}
        tips={[
          "TAN is mandatory before you can deduct and deposit TDS or file 24Q — fill it in early.",
          "If your Save button is missing, you have read-only access; ask for the canManageCompanyProfile permission.",
          "Set expiry dates on licences and certificates so the vault badges them 'Expiring soon' before they lapse.",
        ]}
      />
      <div className="mt-4">
        <Tabs
          tabs={[
            { key: 'profile', label: 'Profile' },
            { key: 'country', label: 'Country' },
            { key: 'documents', label: 'Documents' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>
      <div className="mt-6">
        {tab === 'profile' && <ProfileTab canEdit={canEdit} />}
        {tab === 'country' && <CountrySetupCard canEdit={canEdit} />}
        {tab === 'documents' && <DocumentsTab canEdit={canEdit} />}
      </div>
    </div>
  );
}
