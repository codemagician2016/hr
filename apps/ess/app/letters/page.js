'use client';

// My Letters — the logged-in employee's own ISSUED, non-voided letters
// (relieving / experience / bonafide / salary-proof / employment-proof / ...),
// minted by HR through the shared Letters engine (Feature 09 §5.2, slice 9F).
//
//   List     : GET  /api/hr/me/letters            (own ISSUED, non-voided; fileHash badge)
//   Download : GET  /api/hr/me/letters/:id/download (self-only; out-of-band ⇒ 404)
//   Request  : POST /api/hr/me/letters/requests    (reuses DocumentRequest → HR queue)
//
// Each row carries a tamper/integrity badge derived from `fileHash` (the SHA-256 of
// the issued PDF) — a present hash means the letter is integrity-anchored. Voided
// letters are filtered server-side; if one ever arrives flagged, it renders
// struck-through (forward-compat with a "show voided" config).

import { useMemo, useState } from 'react';
import AppShell from '@/components/AppShell';
import { ErrorBanner, Empty, Spinner, Centered } from '@hr/ui';
import { useApi } from '@/lib/useApi';
import { apiPost } from '@/lib/api';
import { formatDate } from '@/lib/format';

const LETTERS_PATH = '/api/hr/me/letters';

// The letter types an employee can request (maps to DocumentRequest.templateKind).
const REQUEST_TYPES = [
  { value: 'SALARY_CERTIFICATE', label: 'Salary Certificate' },
  { value: 'EXPERIENCE_LETTER', label: 'Experience Certificate' },
  { value: 'RELIEVING_LETTER', label: 'Relieving Letter' },
  { value: 'APPOINTMENT_LETTER', label: 'Appointment Letter' },
  { value: 'CONFIRMATION_LETTER', label: 'Confirmation Letter' },
  { value: 'OTHER', label: 'Other' },
];

const CATEGORY_LABELS = {
  EXPERIENCE: 'Experience',
  BONAFIDE: 'Bonafide',
  EMPLOYMENT_PROOF: 'Employment Proof',
  SALARY_PROOF: 'Salary Proof',
  BANK: 'Bank',
  CONTRACT: 'Contract',
  CUSTOM: 'Letter',
};

function titleOf(l) {
  return l.subject || CATEGORY_LABELS[l.category] || 'Letter';
}

function MyLettersInner() {
  const { data, loading, error } = useApi(LETTERS_PATH, {
    select: (b) => (Array.isArray(b) ? b : b?.items || b?.letters || []),
  });
  const letters = useMemo(() => data || [], [data]);

  // Request-a-letter form state
  const [reqType, setReqType] = useState('SALARY_CERTIFICATE');
  const [purpose, setPurpose] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reqError, setReqError] = useState(null);
  const [reqSuccess, setReqSuccess] = useState(false);

  async function submitRequest(e) {
    e.preventDefault();
    setSubmitting(true);
    setReqError(null);
    setReqSuccess(false);
    try {
      await apiPost(`${LETTERS_PATH}/requests`, {
        templateKind: reqType,
        purpose: purpose.trim() || undefined,
      });
      setReqSuccess(true);
      setPurpose('');
    } catch (err) {
      setReqError(err.message || 'Could not submit your request.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <Centered><Spinner /></Centered>;
  // 404 (route not yet deployed in an env) degrades to an empty, branded state.
  if (error && error.status !== 404) {
    return <ErrorBanner message={error.message || 'Could not load your letters.'} />;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold" style={{ color: 'var(--theme-text)' }}>My Letters</h1>

      {/* Issued letters */}
      {letters.length === 0 ? (
        <Empty text="No letters have been issued to you yet." />
      ) : (
        <ul className="space-y-2">
          {letters.map((l) => {
            const voided = !!l.voided || l.status === 'VOIDED';
            const hasHash = !!l.fileHash;
            const title = titleOf(l);
            return (
              <li key={l.id}>
                <div
                  className="flex items-center justify-between rounded-xl border bg-white px-4 py-3 shadow-sm"
                  style={{ borderColor: 'var(--theme-border)', opacity: voided ? 0.6 : 1 }}
                >
                  <div className="min-w-0">
                    <div
                      className="truncate text-sm font-medium"
                      style={{ color: 'var(--theme-text)', textDecoration: voided ? 'line-through' : 'none' }}
                    >
                      {title}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {(CATEGORY_LABELS[l.category] || l.category || 'Letter')}
                      {l.referenceNo ? ` · ${l.referenceNo}` : ''}
                      {l.issuedAt ? ` · ${formatDate(l.issuedAt)}` : ''}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      {/* Tamper / integrity badge from fileHash */}
                      {hasHash ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: 'rgba(16,185,129,0.12)', color: '#059669' }}
                          title={`Integrity hash: ${l.fileHash}`}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                               strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                          Integrity verified
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: 'rgba(217,119,6,0.12)', color: '#D97706' }}
                          title="No integrity hash recorded for this letter"
                        >
                          Unverified
                        </span>
                      )}
                      {voided && (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                          style={{ background: 'rgba(220,38,38,0.12)', color: '#DC2626' }}
                        >
                          Voided
                        </span>
                      )}
                    </div>
                  </div>
                  {!voided && (
                    <a
                      href={`${LETTERS_PATH}/${encodeURIComponent(l.id)}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Download ${title} (opens in a new tab)`}
                      className="shrink-0 active:scale-[0.98]"
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--theme-primary)"
                           aria-hidden="true" focusable="false" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" />
                      </svg>
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Request a letter */}
      <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <h2 className="text-base font-semibold" style={{ color: 'var(--theme-text)' }}>Request a Letter</h2>
        <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
          Ask HR to issue a letter. Your request lands in the HR queue.
        </p>
        <form onSubmit={submitRequest} className="mt-3 space-y-3">
          <div>
            <label htmlFor="reqType" className="block text-xs font-medium" style={{ color: 'var(--theme-text)' }}>
              Letter type
            </label>
            <select
              id="reqType"
              value={reqType}
              onChange={(e) => setReqType(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
            >
              {REQUEST_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="purpose" className="block text-xs font-medium" style={{ color: 'var(--theme-text)' }}>
              Purpose <span style={{ color: 'var(--theme-muted)' }}>(optional)</span>
            </label>
            <textarea
              id="purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="e.g. for a visa application / bank loan"
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
            />
          </div>
          {reqError && <ErrorBanner message={reqError} />}
          {reqSuccess && (
            <div
              className="rounded-lg px-3 py-2 text-sm font-medium"
              style={{ background: 'var(--theme-primary-soft)', color: 'var(--theme-primary)' }}
              role="status"
            >
              Request submitted. HR will action it shortly.
            </div>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 active:scale-[0.99]"
            style={{ background: 'var(--theme-primary)' }}
          >
            {submitting ? 'Submitting…' : 'Submit request'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function MyLettersPage() {
  return (
    <AppShell>
      <MyLettersInner />
    </AppShell>
  );
}
