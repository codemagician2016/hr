'use client';

// Documents — the logged-in employee's own documents (contracts, ID proofs,
// letters, certificates). Cookie-authed against the employee session.
//
// Wired to GET /api/hr/me/documents (employee self-service view). The admin
// documents API is tenant+permission gated; the /me/ view returns only the
// caller's own rows. Until the /me/ route is deployed in a given environment a
// 404 degrades to a friendly empty state so the page stays branded/shippable.

import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { formatDate } from '@/lib/format';

const DOCS_PATH = '/api/hr/me/documents';

function expiryTone(doc) {
  const exp = doc.expiresAt || doc.expiryDate || doc.validTill;
  if (!exp) return null;
  const days = Math.ceil((new Date(exp) - Date.now()) / 86400000);
  if (Number.isNaN(days)) return null;
  if (days < 0) return { label: 'Expired', color: '#DC2626' };
  if (days <= 30) return { label: `Expires in ${days}d`, color: '#D97706' };
  return { label: `Valid till ${formatDate(exp)}`, color: 'var(--theme-muted)' };
}

function DocumentsInner() {
  const { data, loading, error } = useApi(DOCS_PATH, {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.documents || []),
  });
  const docs = data || [];

  if (loading) return <Centered><Spinner /></Centered>;
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load documents.'} />;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold" style={{ color: 'var(--theme-text)' }}>Documents</h1>

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
                  {(d.documentType || d.category) && (
                    <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {d.documentType || d.category}
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
