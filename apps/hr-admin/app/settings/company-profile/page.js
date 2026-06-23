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

      <section className="space-y-4">
        <SectionTitle tip="Your company's legal identity. Everything here is optional — fill in what you have.">
          Legal &amp; registration
        </SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ProfileField label="Legal name" tip="The registered legal name of the company (as on your incorporation certificate)." value={profile?.legalName} onChange={(v) => set('legalName', v)} disabled={ro} placeholder="Acme Technologies Private Limited" />
          <ProfileField label="Trade name" tip="The brand / trading name you operate under, if different from the legal name." value={profile?.tradeName} onChange={(v) => set('tradeName', v)} disabled={ro} placeholder="Acme" />
          <ProfileField label="Registration no. (CIN)" tip="Corporate Identity Number issued by the MCA on incorporation (21 characters, e.g. U72900KA2020PTC123456)." value={profile?.registrationNo} onChange={(v) => set('registrationNo', v)} disabled={ro} placeholder="U72900KA2020PTC123456" />
          <ProfileField label="GSTIN" tip="Your 15-character Goods & Services Tax Identification Number." value={profile?.gstin} onChange={(v) => set('gstin', v)} disabled={ro} placeholder="29ABCDE1234F1Z5" />
          <ProfileField label="PAN" tip="The company's 10-character Permanent Account Number." value={profile?.pan} onChange={(v) => set('pan', v)} disabled={ro} placeholder="ABCDE1234F" />
          <ProfileField label="TAN" tip="Tax Deduction & Collection Account Number — needed when you deduct TDS." value={profile?.tan} onChange={(v) => set('tan', v)} disabled={ro} placeholder="BLRA12345C" />
          <ProfileField label="Date of incorporation" tip="When the company was registered." type="date" value={profile?.incorporationDate} onChange={(v) => set('incorporationDate', v)} disabled={ro} />
        </div>
      </section>

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
          <ProfileField label="Country" tip="ISO country code (e.g. IN for India)." value={profile?.registeredCountry} onChange={(v) => set('registeredCountry', v)} disabled={ro} placeholder="IN" />
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
      <div className="mt-4">
        <Tabs
          tabs={[{ key: 'profile', label: 'Profile' }, { key: 'documents', label: 'Documents' }]}
          active={tab}
          onChange={setTab}
        />
      </div>
      <div className="mt-6">
        {tab === 'profile' ? <ProfileTab canEdit={canEdit} /> : <DocumentsTab canEdit={canEdit} />}
      </div>
    </div>
  );
}
