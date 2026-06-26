'use client';

// Documents — the logged-in employee's own documents (contracts, ID proofs,
// letters, certificates). Cookie-authed against the employee session.
//
// Wired to GET /api/hr/me/documents (employee self-service view). The admin
// documents API is tenant+permission gated; the /me/ view returns only the
// caller's own rows. Until the /me/ route is deployed in a given environment a
// 404 degrades to a friendly empty state so the page stays branded/shippable.

import { useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered, DocumentDropzone } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';
import { formatDate } from '@/lib/format';

const DOCS_PATH = '/api/hr/me/documents';

// Categories an employee may self-upload for HR to verify (a friendly subset of
// the DocumentCategory enum — the backend re-validates against the full enum).
const UPLOAD_CATEGORIES = [
  { value: 'ID_PROOF', label: 'ID proof' },
  { value: 'ADDRESS_PROOF', label: 'Address proof' },
  { value: 'PAN', label: 'PAN' },
  { value: 'AADHAAR', label: 'Aadhaar' },
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'EDUCATION', label: 'Education certificate' },
  { value: 'EXPERIENCE', label: 'Experience letter' },
  { value: 'BANK_PROOF', label: 'Bank proof' },
  { value: 'MEDICAL', label: 'Medical' },
  { value: 'OTHER', label: 'Other' },
];

// Friendly labels for the raw EmployeeDocument.category enum (Feature 24 adds the
// "Form 16 · Tax" label so the issued TDS certificate reads cleanly in the vault).
const CATEGORY_LABEL = {
  FORM16: 'Form 16 · Tax',
  TAX_DECLARATION: 'Tax declaration',
  PAYSLIP_COPY: 'Payslip',
  OFFER_LETTER: 'Offer letter',
  CONTRACT: 'Contract',
  EXPERIENCE: 'Experience letter',
  BANK_PROOF: 'Bank proof',
  ID_PROOF: 'ID proof',
  PAN: 'PAN', AADHAAR: 'Aadhaar', PASSPORT: 'Passport',
};
function categoryLabel(d) {
  if (d.documentType) return d.documentType;
  const c = d.category;
  return (c && CATEGORY_LABEL[c]) || c || null;
}

function expiryTone(doc) {
  const exp = doc.expiresAt || doc.expiryDate || doc.validTill;
  if (!exp) return null;
  const days = Math.ceil((new Date(exp) - Date.now()) / 86400000);
  if (Number.isNaN(days)) return null;
  if (days < 0) return { label: 'Expired', color: '#DC2626' };
  if (days <= 30) return { label: `Expires in ${days}d`, color: '#D97706' };
  return { label: `Valid till ${formatDate(exp)}`, color: 'var(--theme-muted)' };
}

// The upload card: pick a category, drop a file → POST /api/hr/me/documents
// (forced isEmployeeUploaded + unverified server-side), then refresh the list.
function UploadCard({ onUploaded }) {
  const [category, setCategory] = useState(UPLOAD_CATEGORIES[0].value);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function handleFile(payload) {
    setError('');
    setBusy(true);
    setDone(false);
    try {
      await apiPost(DOCS_PATH, {
        category,
        name: payload.name,
        mimeType: payload.mimeType,
        sizeBytes: payload.sizeBytes,
        fileHash: payload.fileHash,
        fileBase64: payload.fileBase64,
      });
      setDone(true);
      if (onUploaded) await onUploaded();
    } catch (e) {
      setError(e.message || 'Upload failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
      <div className="mb-3 text-sm font-medium" style={{ color: 'var(--theme-text)' }}>Upload a document</div>
      <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--theme-muted)' }}>Document type</label>
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        className="mb-3 w-full rounded-lg border px-3 py-2 text-sm"
        style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
      >
        {UPLOAD_CATEGORIES.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
      <DocumentDropzone
        category={category}
        label=""
        busy={busy}
        done={done}
        onFile={handleFile}
      />
      {done && !error && (
        <p className="mt-2 text-xs font-medium" style={{ color: 'var(--theme-primary)' }}>
          Uploaded — pending HR verification.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function DocumentsInner() {
  const { data, loading, error, reload } = useApi(DOCS_PATH, {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.documents || []),
  });
  const allDocs = data || [];
  const [filter, setFilter] = useState('ALL');

  if (loading) return <Centered><Spinner /></Centered>;
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load documents.'} />;
  }

  // Has the employee any tax/Form-16 documents? Surface a quick filter when so.
  const hasTax = allDocs.some((d) => d.category === 'FORM16' || d.category === 'TAX_DECLARATION');
  const docs = filter === 'TAX'
    ? allDocs.filter((d) => d.category === 'FORM16' || d.category === 'TAX_DECLARATION')
    : allDocs;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>Documents</h1>
        {hasTax && (
          <div className="flex gap-1 text-xs">
            {[{ k: 'ALL', l: 'All' }, { k: 'TAX', l: 'Form 16 / Tax' }].map((t) => (
              <button
                key={t.k}
                type="button"
                onClick={() => setFilter(t.k)}
                className="rounded-full border px-3 py-1 font-medium"
                style={filter === t.k
                  ? { borderColor: 'var(--theme-primary)', color: 'var(--theme-primary)' }
                  : { borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
              >
                {t.l}
              </button>
            ))}
          </div>
        )}
      </div>

      <UploadCard onUploaded={reload} />

      {docs.length === 0 ? (
        <Empty text="No documents available." />
      ) : (
        <ul className="space-y-2">
          {docs.map((d, i) => {
            const href = d.fileUrl || d.url || d.downloadUrl;
            const tone = expiryTone(d);
            const title = d.name || d.title || d.documentType || d.type || 'Document';
            const Inner = (
              <div
                className="flex items-center justify-between rounded-xl border bg-white px-4 py-3 shadow-sm"
                style={{ borderColor: 'var(--theme-border)' }}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium" style={{ color: 'var(--theme-text)' }}>{title}</div>
                  {categoryLabel(d) && (
                    <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {categoryLabel(d)}
                    </div>
                  )}
                  {tone && (
                    <div className="text-xs font-medium" style={{ color: tone.color }}>{tone.label}</div>
                  )}
                </div>
                {href && (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--theme-primary)" aria-hidden="true" focusable="false"
                       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
                  </svg>
                )}
              </div>
            );
            return (
              <li key={d.id || i}>
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${title} (opens in a new tab)`}
                    className="block active:scale-[0.99]"
                  >
                    {Inner}
                  </a>
                ) : Inner}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function DocumentsPage() {
  return (
    <AppShell>
      <DocumentsInner />
    </AppShell>
  );
}
