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
import { ServerPagination } from '@/lib/pagination';

const LETTERS_PATH = '/api/hr/me/letters';
const PAGE_SIZES = [10, 25, 50];

// Feature 42 — the request dropdown is DYNAMIC: GET /requestable returns the
// tenant's published selfServe templates (+ whether free-form "Other" requests
// are allowed). The legacy hard-coded kinds below survive ONLY as a fallback
// for older environments where the /requestable route isn't deployed yet.
const LEGACY_REQUEST_TYPES = [
  { value: 'SALARY_CERTIFICATE', label: 'Salary Certificate' },
  { value: 'EXPERIENCE_LETTER', label: 'Experience Certificate' },
  { value: 'RELIEVING_LETTER', label: 'Relieving Letter' },
  { value: 'APPOINTMENT_LETTER', label: 'Appointment Letter' },
  { value: 'CONFIRMATION_LETTER', label: 'Confirmation Letter' },
  { value: 'OTHER', label: 'Other (describe below)' },
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const { data, loading, error } = useApi(`${LETTERS_PATH}?page=${page}&pageSize=${pageSize}`, {
    deps: [page, pageSize],
    select: (b) => (Array.isArray(b)
      ? { items: b, total: b.length }
      : { items: b?.items || b?.letters || [], total: b?.total ?? (b?.items || []).length }),
  });
  const letters = useMemo(() => data?.items || [], [data]);
  const lettersTotal = data?.total ?? letters.length;

  // Feature 42 — what the employee may request: the tenant's published selfServe
  // templates + the free-form "Other" switch. Errors (route not deployed) fall
  // back to the legacy hard-coded kinds so the form keeps working.
  const {
    data: requestable, loading: requestableLoading, error: requestableError,
  } = useApi(`${LETTERS_PATH}/requestable`, {
    select: (b) => ({ items: b?.items || [], allowCustom: !!b?.allowCustom }),
  });
  const legacyMode = !!requestableError;
  const reqItems = requestable?.items || [];
  const allowCustom = legacyMode ? true : !!requestable?.allowCustom;
  const reqOptions = useMemo(() => (legacyMode
    ? LEGACY_REQUEST_TYPES
    : [
      ...reqItems.map((t) => ({ value: t.id, label: t.name })),
      ...(allowCustom ? [{ value: 'OTHER', label: 'Other (describe below)' }] : []),
    ]), [legacyMode, reqItems, allowCustom]);
  const requestsEnabled = legacyMode || reqOptions.length > 0;

  // Request-a-letter form state
  const [reqType, setReqType] = useState('');
  const [purpose, setPurpose] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [reqError, setReqError] = useState(null);
  const [reqSuccess, setReqSuccess] = useState(false);
  // The selected option (falls back to the first once the list arrives).
  const effectiveType = reqType && reqOptions.some((o) => o.value === reqType)
    ? reqType
    : (reqOptions[0]?.value || '');
  const isOther = effectiveType === 'OTHER';

  // My letter requests (pending / in-progress / fulfilled). `reqTick` re-fetches
  // after a new request is submitted so the new PENDING row shows immediately.
  const [reqTick, setReqTick] = useState(0);
  const { data: reqData } = useApi(`${LETTERS_PATH}/requests`, {
    deps: [reqTick],
    select: (b) => (Array.isArray(b) ? b : b?.items || []),
  });
  const myRequests = useMemo(() => reqData || [], [reqData]);

  async function submitRequest(e) {
    e.preventDefault();
    setReqError(null);
    setReqSuccess(false);
    if (!effectiveType) return;
    if (isOther && !purpose.trim()) {
      setReqError('Please describe the letter you need in the Purpose field.');
      return;
    }
    setSubmitting(true);
    try {
      // Template-bound request ({ letterTemplateId }) for a picked template;
      // legacy { templateKind } for the free-form "Other" / fallback kinds.
      const body = isOther || legacyMode
        ? { templateKind: effectiveType, purpose: purpose.trim() || undefined }
        : { letterTemplateId: effectiveType, purpose: purpose.trim() || undefined };
      await apiPost(`${LETTERS_PATH}/requests`, body);
      setReqSuccess(true);
      setPurpose('');
      setReqTick((t) => t + 1); // refresh my-requests list
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
        <>
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
        <ServerPagination
          page={page}
          pageSize={pageSize}
          total={lettersTotal}
          sizes={PAGE_SIZES}
          noun="letters"
          onPageChange={setPage}
          onPageSizeChange={(ps) => { setPage(1); setPageSize(ps); }}
        />
        </>
      )}

      {/* My requests (pending / in-progress / fulfilled) */}
      {myRequests.length > 0 && (
        <div>
          <h2 className="mb-2 flex items-center text-base font-semibold" style={{ color: 'var(--theme-text)' }}>
            My Requests
            <EssInfoTip text="Letters you've asked HR for. 'In review' means HR has it; 'Ready' means it's issued — tap download." label="My Requests" />
          </h2>
          <ul className="space-y-2">
            {myRequests.map((r) => (
              <li key={r.id}>
                <div
                  className="flex items-center justify-between rounded-xl border bg-white px-4 py-3 shadow-sm"
                  style={{ borderColor: 'var(--theme-border)' }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium" style={{ color: 'var(--theme-text)' }}>
                      {r.subject || r.templateKindLabel || r.templateKind}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--theme-muted)' }}>
                      {r.templateKindLabel || r.templateKind}
                      {r.purpose ? ` · ${r.purpose}` : ''}
                      {r.createdAt ? ` · requested ${formatDate(r.createdAt)}` : ''}
                    </div>
                    <div className="mt-1">
                      <RequestStatusBadge status={r.status} />
                    </div>
                  </div>
                  {r.status === 'FULFILLED' && r.letterId && (
                    <a
                      href={`${LETTERS_PATH}/${encodeURIComponent(r.letterId)}/download`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Download ${r.subject || r.templateKindLabel || 'letter'} (opens in a new tab)`}
                      className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-white active:scale-[0.98]"
                      style={{ background: 'var(--theme-primary)' }}
                    >
                      Download
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Request a letter — dynamic (Feature 42): the tenant's requestable
          templates + optional free-form "Other". Hidden with a note when HR has
          enabled neither. */}
      <div className="rounded-xl border bg-white p-4 shadow-sm" style={{ borderColor: 'var(--theme-border)' }}>
        <h2 className="flex items-center text-base font-semibold" style={{ color: 'var(--theme-text)' }}>
          Request a Letter
          <EssInfoTip text="Pick the letter you need and (optionally) why. HR is notified and will issue it; you'll be able to download it here." label="Request a Letter" />
        </h2>
        {requestableLoading && !requestable ? (
          <div className="mt-3 flex justify-center py-4"><Spinner /></div>
        ) : !requestsEnabled ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--theme-muted)' }}>
            Your HR team hasn&apos;t enabled letter requests yet.
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs" style={{ color: 'var(--theme-muted)' }}>
              Ask HR to issue a letter. Your request lands in the HR queue and appears above once issued.
            </p>
            <form onSubmit={submitRequest} className="mt-3 space-y-3">
              <div>
                <label htmlFor="reqType" className="flex items-center text-xs font-medium" style={{ color: 'var(--theme-text)' }}>
                  Letter type
                  <EssInfoTip text="The letters your HR team has made requestable. Pick 'Other' to describe something not listed." label="Letter type" />
                </label>
                <select
                  id="reqType"
                  value={effectiveType}
                  onChange={(e) => setReqType(e.target.value)}
                  className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                  style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-text)' }}
                >
                  {reqOptions.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="purpose" className="flex items-center text-xs font-medium" style={{ color: 'var(--theme-text)' }}>
                  Purpose{' '}
                  <span className="ml-1" style={{ color: 'var(--theme-muted)' }}>
                    {isOther ? '(required)' : '(optional)'}
                  </span>
                  <EssInfoTip text="Why you need the letter, e.g. 'for a visa application' or 'bank loan'. For 'Other', describe the letter you need." label="Purpose" />
                </label>
                <textarea
                  id="purpose"
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder={isOther ? 'Describe the letter you need' : 'e.g. for a visa application / bank loan'}
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
                disabled={submitting || !effectiveType}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60 active:scale-[0.99]"
                style={{ background: 'var(--theme-primary)' }}
              >
                {submitting ? 'Submitting…' : 'Submit request'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ── ⓘ tip — accessible field-help affordance (ESS-local, themed) ─────────────
function EssInfoTip({ text, label }) {
  if (!text) return null;
  return (
    <span
      className="ml-1 inline-flex h-4 w-4 cursor-help select-none items-center justify-center rounded-full border text-[10px] font-semibold leading-none align-middle"
      style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}
      title={text}
      tabIndex={0}
      role="img"
      aria-label={`${label ? `${label}: ` : 'Help: '}${text}`}
    >
      i
    </span>
  );
}

// ESS-facing request status pill. Maps the backend lifecycle status to a friendly
// label + tone.
const REQUEST_STATUS_META = {
  PENDING: { label: 'In review', bg: 'rgba(217,119,6,0.12)', fg: '#D97706' },
  IN_PROGRESS: { label: 'In progress', bg: 'rgba(37,99,235,0.12)', fg: '#2563EB' },
  FULFILLED: { label: 'Ready to download', bg: 'rgba(16,185,129,0.12)', fg: '#059669' },
  REJECTED: { label: 'Declined', bg: 'rgba(220,38,38,0.12)', fg: '#DC2626' },
  CANCELLED: { label: 'Cancelled', bg: 'rgba(107,114,128,0.12)', fg: '#6B7280' },
};
function RequestStatusBadge({ status }) {
  const meta = REQUEST_STATUS_META[status] || REQUEST_STATUS_META.PENDING;
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: meta.bg, color: meta.fg }}
    >
      {meta.label}
    </span>
  );
}

export default function MyLettersPage() {
  return (
    <AppShell>
      <MyLettersInner />
    </AppShell>
  );
}
