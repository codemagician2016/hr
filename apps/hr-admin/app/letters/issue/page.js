'use client';

// Issue-a-Letter wizard (Feature 9 §5.1, slice 9E) + the Letters overhaul:
//   - Issue tab: pick a template (India-first — the server filters templates to
//     the tenant's country) and EITHER an employee OR an external recipient
//     (bank / vendor / authority — name + address + purpose, no employee linked),
//     review a live preview (with a Full-screen action), then issue.
//   - Requests tab: the PENDING ESS letter requests (employee, type, purpose,
//     date). "Issue this" pre-fills the Issue form for that employee/type and, on
//     issue, FULFILS the request so the employee can download it.
//   - ⓘ tooltips on every field.
//
// The server is the real enforcement boundary; this is the maker UX.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ErrorBanner, PrimaryButton, TextInput, TextArea, DateField, Spinner } from '@hr/ui';
import { get, post } from '@/lib/api';
import { PageHeader, asList, employeeLabel, Tabs } from '@/lib/ui';
import { postForPdf, InfoTip } from '../lib';
import EmployeeSearchSelect from '@/components/EmployeeSearchSelect';
import ModuleGuide from '@/components/ModuleGuide';

// Map an ESS request templateKind → a hint for matching a template by category.
const REQUEST_KIND_CATEGORY = {
  EXPERIENCE_LETTER: 'EXPERIENCE',
  RELIEVING_LETTER: 'EXPERIENCE',
  SALARY_CERTIFICATE: 'SALARY_PROOF',
  APPOINTMENT_LETTER: 'CONTRACT',
  CONFIRMATION_LETTER: 'EMPLOYMENT_PROOF',
  OFFER_LETTER: 'CONTRACT',
  PROMOTION_LETTER: 'EMPLOYMENT_PROOF',
  WARNING_LETTER: 'CUSTOM',
};

function IssueLetterPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Deep-link target from the Documents → Requests tab: /letters/issue?tab=requests&requestId=<id>.
  // We open the Requests tab and, once the queue is loaded, pre-fill the Issue
  // form for that request (same path as clicking "Issue this").
  const targetRequestId = searchParams.get('requestId') || '';
  const wantRequestsTab = searchParams.get('tab') === 'requests' || Boolean(targetRequestId);
  const [tab, setTab] = useState(wantRequestsTab ? 'requests' : 'issue');

  const [templates, setTemplates] = useState(null);
  const [templatesErr, setTemplatesErr] = useState('');
  const [templateId, setTemplateId] = useState('');

  // recipient mode: 'employee' (link an employee) | 'external' (free addressee)
  const [recipientMode, setRecipientMode] = useState('employee');

  const [employeeId, setEmployeeId] = useState('');
  const [employeeLabelText, setEmployeeLabelText] = useState('');

  // external recipient fields (surface the free letter.addressee + purpose merge fields)
  const [extName, setExtName] = useState('');
  const [extAddress, setExtAddress] = useState('');
  const [extPurpose, setExtPurpose] = useState('');

  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [subject, setSubject] = useState('');
  const [customParagraph, setCustomParagraph] = useState('');

  const [previewUrl, setPreviewUrl] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);
  const [missingRequired, setMissingRequired] = useState([]);
  const [masked, setMasked] = useState([]);
  const [error, setError] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [result, setResult] = useState(null);
  const previewObjUrl = useRef('');
  // Guard so the deep-link pre-fill (?requestId=) only fires once per landing.
  const deepLinkHandled = useRef(false);

  // the ESS request being fulfilled by this issue (set by "Issue this")
  const [documentRequestId, setDocumentRequestId] = useState(null);

  // pending-request queue + count (Requests tab + badge)
  const [requests, setRequests] = useState(null);
  const [requestsErr, setRequestsErr] = useState('');
  const [pendingCount, setPendingCount] = useState(0);

  const selectedTemplate = useMemo(
    () => (templates || []).find((t) => t.id === templateId) || null,
    [templates, templateId]
  );

  // ── load templates (server filters to the tenant's country — India-first) ──
  useEffect(() => {
    get('/api/hr/letters/templates', { isActive: true, pageSize: 200 })
      .then((r) => setTemplates(asList(r)))
      .catch((e) => {
        setTemplates([]);
        if (e.status && e.status !== 404) setTemplatesErr(e.message || 'Could not load templates.');
      });
  }, []);

  // ── load the pending request queue + count (Requests tab + badge) ───────────
  const loadRequests = useCallback(() => {
    get('/api/hr/letters/requests')
      .then((r) => {
        const items = asList(r);
        setRequests(items);
        setPendingCount(items.length);
        setRequestsErr('');
      })
      .catch((e) => {
        setRequests([]);
        if (e.status && e.status !== 404) setRequestsErr(e.message || 'Could not load requests.');
      });
  }, []);
  useEffect(() => { loadRequests(); }, [loadRequests]);

  const overrides = useMemo(() => {
    const o = { issueDate };
    if (subject.trim()) o.subject = subject.trim();
    if (customParagraph.trim()) o.customParagraph = customParagraph.trim();
    if (recipientMode === 'external') {
      // External recipient: surface the free letter.addressee + letter.purpose
      // merge fields. The addressee block is name + address (employee stays unset).
      const addressee = [extName.trim(), extAddress.trim()].filter(Boolean).join('\n');
      if (addressee) o.addressee = addressee;
      if (extPurpose.trim()) o.purpose = extPurpose.trim();
    }
    return o;
  }, [issueDate, subject, customParagraph, recipientMode, extName, extAddress, extPurpose]);

  // The subject employee is only sent in employee mode.
  const effectiveEmployeeId = recipientMode === 'employee' ? (employeeId || null) : null;

  // ── live preview (POST /preview → blob → object URL) ───────────────────────
  const runPreview = useCallback(async () => {
    if (!templateId) return;
    setPreviewing(true); setError(''); setMissingRequired([]);
    try {
      const { blob, masked: maskedKeys } = await postForPdf('/api/hr/letters/preview', {
        templateId, employeeId: effectiveEmployeeId, overrides,
      });
      if (previewObjUrl.current) URL.revokeObjectURL(previewObjUrl.current);
      const url = URL.createObjectURL(blob);
      previewObjUrl.current = url;
      setPreviewUrl(url);
      setMasked(maskedKeys || []);
    } catch (e) {
      setPreviewUrl('');
      if (e.status === 422 && Array.isArray(e.data?.missingRequired)) {
        setMissingRequired(e.data.missingRequired);
        setError('This letter is missing required fields — fill them in before issuing.');
      } else {
        setError(e.data?.message || e.message || 'Preview failed.');
      }
    } finally {
      setPreviewing(false);
    }
  }, [templateId, effectiveEmployeeId, overrides]);

  // auto-preview when template / employee / recipient mode changes (the "live" merge).
  useEffect(() => {
    if (templateId) runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, effectiveEmployeeId, recipientMode]);

  useEffect(() => () => {
    if (previewObjUrl.current) URL.revokeObjectURL(previewObjUrl.current);
  }, []);

  const canIssue = templateId && missingRequired.length === 0 && !issuing
    && (recipientMode === 'employee' || extName.trim().length > 0);

  async function onIssue() {
    if (!templateId) return;
    setIssuing(true); setError(''); setResult(null);
    try {
      const out = await post('/api/hr/letters/issue', {
        templateId,
        employeeId: effectiveEmployeeId,
        overrides,
        documentRequestId: documentRequestId || null,
      });
      setResult(out);
      // a fulfilled request leaves the queue → refresh the badge/queue.
      if (documentRequestId) { setDocumentRequestId(null); loadRequests(); }
    } catch (e) {
      if (e.status === 422 && Array.isArray(e.data?.missingRequired)) {
        setMissingRequired(e.data.missingRequired);
        setError('Cannot issue — required fields are missing.');
      } else {
        setError(e.data?.message || e.message || 'Issue failed.');
      }
    } finally {
      setIssuing(false);
    }
  }

  function resetForm() {
    setResult(null); setPreviewUrl(''); setDocumentRequestId(null);
    setMissingRequired([]); setMasked([]); setError('');
  }

  // "Issue this" from the Requests tab → pre-fill the Issue form for that
  // employee + type, link the request for fulfilment on issue.
  function issueFromRequest(reqRow) {
    resetForm();
    setRecipientMode('employee');
    setDocumentRequestId(reqRow.id);
    if (reqRow.employee) {
      setEmployeeId(reqRow.employee.id);
      setEmployeeLabelText([reqRow.employee.name, reqRow.employee.code].filter(Boolean).join(' · '));
    }
    // best-effort: pre-select a template whose category matches the requested kind.
    const wantCat = REQUEST_KIND_CATEGORY[reqRow.templateKind];
    if (wantCat && Array.isArray(templates)) {
      const match = templates.find((t) => t.category === wantCat);
      if (match) setTemplateId(match.id);
    }
    if (reqRow.purpose) setExtPurpose(''); // purpose only applies to external mode
    setTab('issue');
  }

  // Deep-link from Documents → Requests: when we arrive with ?requestId=<id>,
  // wait for the queue (and templates, so the kind→template match can land) and
  // then pre-fill the Issue form exactly as "Issue this" would. If the id isn't
  // in the (scope-constrained, open-only) queue, we stay on the Requests tab so
  // HR can see why (already fulfilled / out of scope) rather than guessing.
  useEffect(() => {
    if (deepLinkHandled.current) return;
    if (!targetRequestId) return;
    if (requests === null || templates === null) return; // wait for both loads
    deepLinkHandled.current = true;
    const match = (requests || []).find((r) => r.id === targetRequestId);
    if (match) issueFromRequest(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRequestId, requests, templates]);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Issue a letter"
        subtitle="Pick a template and a recipient (an employee or an external party), review the live preview, then issue. A reference number is minted on issue."
        actions={<button type="button" onClick={() => router.push('/letters/register')} className="text-sm text-gray-500 hover:text-gray-700">View register →</button>}
      />

      <ModuleGuide
        id="letters-issue"
        title="Issue a letter and mint its reference number"
        what="Generate an official HR letter — offer, appointment, confirmation, experience, relieving or salary certificate — by merging a template with an employee or external recipient. On issue, a reference number is minted and the letter is logged to the register; employee-linked letters also appear in the worker's My Letters portal."
        steps={[
          'On the Issue tab, pick a Template (only your country’s active templates are shown, e.g. India salary certificate).',
          'Choose who the letter is for — An employee (links it to their record + My Letters), or an External party such as a bank or authority (type the recipient name + address).',
          'Set the Issue date (defaults to today) and optionally override the subject or append a custom paragraph.',
          'Check the live watermarked preview on the right — open Full screen to read it before committing.',
          'Click Issue now to mint the reference number, or for a signature template route it to an e-sign envelope.',
          'Use the Requests tab to clear pending ESS letter requests — "Issue this" pre-fills the form and marks the request fulfilled on issue.',
        ]}
        example={<>HR raises a salary certificate for <b>Aarav Sharma</b> (code EMP1042) at <b>Acme India Pvt Ltd</b>, stating a CTC of <b>₹12,00,000</b>, addressed to <b>The Manager, HDFC Bank</b> for a home-loan verification, dated <b>26 June 2026</b>. On issue it gets reference <b>ACME/LTR/2026/0087</b> and lands in the register.</>}
        tips={[
          'If you can’t view compensation, salary figures render masked (••••) on both preview and the issued letter — it can still be issued.',
          'A 422 "missing required fields" means the template needs data the employee record lacks (e.g. date of joining or designation) — fill those in before issuing.',
        ]}
      />

      <Tabs
        tabs={[
          { key: 'issue', label: 'Issue' },
          {
            key: 'requests',
            label: (
              <span className="inline-flex items-center gap-1.5">
                Requests
                {pendingCount > 0 && (
                  <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-700">
                    {pendingCount}
                  </span>
                )}
              </span>
            ),
          },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
      {templatesErr && <div className="mb-4"><ErrorBanner message={templatesErr} /></div>}

      {tab === 'requests' ? (
        <RequestsTab
          requests={requests}
          error={requestsErr}
          onIssue={issueFromRequest}
          onRefresh={loadRequests}
        />
      ) : result ? (
        <IssueResult result={result} onAnother={resetForm} onRegister={() => router.push('/letters/register')} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── left: the form ── */}
          <div className="space-y-5">
            {documentRequestId && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 flex items-center justify-between">
                <span>Fulfilling an employee letter request — issuing will mark it fulfilled so they can download it.</span>
                <button type="button" onClick={() => setDocumentRequestId(null)} className="text-sky-500 hover:text-sky-700">unlink</button>
              </div>
            )}

            <Field label="Template" tip="The letter content. Only your country's templates are shown. New templates are built under Letters → Templates.">
              {templates === null ? (
                <Spinner />
              ) : templates.length ? (
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">Select a template…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} {t.category ? `· ${t.category}` : ''} {t.countryCode ? `(${t.countryCode})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <TextInput
                  value={templateId}
                  onChange={(v) => setTemplateId(v)}
                  placeholder="Template id (no templates found — create one under Templates)"
                />
              )}
              {selectedTemplate?.requiresSignature && (
                <p className="mt-1 text-xs text-amber-700">
                  This template requires a signature — issuing opens an e-sign envelope; the reference number is minted once signed.
                </p>
              )}
            </Field>

            {/* recipient mode toggle */}
            <Field label="Who is this letter for?" tip="An employee (links the letter to their record + the My Letters portal), or an external party such as a bank, vendor or authority (no employee — you type the name + address).">
              <div className="inline-flex rounded-lg border border-gray-300 p-0.5 text-sm">
                <button
                  type="button"
                  onClick={() => setRecipientMode('employee')}
                  className={`px-3 py-1.5 rounded-md ${recipientMode === 'employee' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  An employee
                </button>
                <button
                  type="button"
                  onClick={() => setRecipientMode('external')}
                  className={`px-3 py-1.5 rounded-md ${recipientMode === 'external' ? 'bg-gray-900 text-white' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  External party
                </button>
              </div>
            </Field>

            {recipientMode === 'employee' ? (
              <EmployeeSearchSelect
                label="Employee (optional for company-wide letters)"
                tip="Click to see the directory, then filter by name, code or email. Leave empty for a company-wide letter with no specific employee."
                status="ACTIVE"
                value={employeeId}
                selectedLabel={employeeLabelText}
                onSelect={(emp) => {
                  if (emp) {
                    setEmployeeId(emp.id);
                    setEmployeeLabelText(employeeLabel(emp));
                  } else {
                    setEmployeeId('');
                    setEmployeeLabelText('');
                  }
                }}
                placeholder="Search by name, code or email…"
              />
            ) : (
              <div className="space-y-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
                <TextInput
                  label={<>Recipient name <InfoTip text="The person or organisation the letter is addressed to, e.g. 'The Manager, HDFC Bank'." label="Recipient name" /></>}
                  value={extName}
                  onChange={(v) => setExtName(v)}
                  placeholder="e.g. The Manager, HDFC Bank"
                  required
                />
                <TextArea
                  label={<>Recipient address <InfoTip text="The recipient's postal address. Appears in the addressee block of the letter." label="Recipient address" /></>}
                  value={extAddress}
                  onChange={(v) => setExtAddress(v)}
                  rows={3}
                  hint="Optional. Rendered under the recipient name (if your template uses the addressee field)."
                />
                <TextArea
                  label={<>Purpose / addressee note <InfoTip text="A short purpose line, e.g. 'For the purpose of a vendor empanelment / loan verification'. Maps to the letter.purpose merge field." label="Purpose" /></>}
                  value={extPurpose}
                  onChange={(v) => setExtPurpose(v)}
                  rows={2}
                  hint="Optional. Available to templates as {{letter.purpose}}."
                />
              </div>
            )}

            <DateFieldWithTip
              label="Issue date"
              tip="The date printed on the letter. Defaults to today."
              value={issueDate}
              onChange={(v) => setIssueDate(v)}
            />

            <TextInput
              label={<>Subject override (optional) <InfoTip text="Replaces the template's subject line for this one letter. Leave blank to keep the template subject." label="Subject override" /></>}
              value={subject}
              onChange={(v) => setSubject(v)}
              placeholder="Defaults to the template subject"
            />

            <TextArea
              label={<>Custom paragraph (optional) <InfoTip text="An extra paragraph appended to the end of the letter body, for one-off wording." label="Custom paragraph" /></>}
              value={customParagraph}
              onChange={(v) => setCustomParagraph(v)}
              rows={4}
              hint="Appended to the letter body."
            />

            {masked.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span className="font-medium">Salary figures are hidden.</span>{' '}
                You don’t have permission to view compensation, so {masked.length === 1 ? 'this field renders' : `${masked.length} fields render`} masked (••••) on both the preview and the issued letter. The letter can still be issued.
              </div>
            )}
            {missingRequired.length > 0 && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                Missing required fields: {missingRequired.join(', ')}
              </div>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={runPreview}
                disabled={!templateId || previewing}
                className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-40"
              >
                {previewing ? 'Rendering…' : 'Refresh preview'}
              </button>
              <PrimaryButton onClick={onIssue} disabled={!canIssue}>
                {issuing ? 'Issuing…' : 'Issue now'}
              </PrimaryButton>
            </div>
          </div>

          {/* ── right: the live preview ── */}
          <div className="rounded-2xl border border-gray-200 bg-gray-50 min-h-[600px] flex flex-col">
            <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-gray-500">
                Live preview (watermarked · not the final letter)
              </span>
              <button
                type="button"
                onClick={() => setFullScreen(true)}
                disabled={!previewUrl}
                className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900 disabled:opacity-40"
                title="Open the preview full screen"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" />
                </svg>
                Full screen
              </button>
            </div>
            <div className="flex-1 flex items-center justify-center">
              {previewing ? (
                <Spinner />
              ) : previewUrl ? (
                <iframe title="Letter preview" src={previewUrl} className="w-full h-[580px] rounded-b-2xl" />
              ) : (
                <p className="text-sm text-gray-400 px-6 text-center">Select a template to see a live, merged preview.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── full-screen preview overlay (near A4-large, readable before issuing) ── */}
      {fullScreen && previewUrl && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/70 p-4 sm:p-8"
          onClick={() => setFullScreen(false)}
        >
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-hidden rounded-xl bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
              <span className="text-sm font-medium text-gray-700">Letter preview (watermarked · not the final letter)</span>
              <button type="button" onClick={() => setFullScreen(false)} className="text-2xl leading-none text-gray-400 hover:text-gray-700" aria-label="Close full screen">×</button>
            </div>
            <iframe title="Letter preview full screen" src={previewUrl} className="w-full flex-1" />
          </div>
        </div>
      )}
    </div>
  );
}

// useSearchParams requires a Suspense boundary in the app router.
export default function IssueLetterPage() {
  return (
    <Suspense fallback={<div className="max-w-6xl text-sm text-gray-400">Loading…</div>}>
      <IssueLetterPageInner />
    </Suspense>
  );
}

function Field({ label, tip, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        <InfoTip text={tip} label={typeof label === 'string' ? label : undefined} />
      </label>
      {children}
    </div>
  );
}

// DateField from @hr/ui doesn't take a label node; wrap it so we can add a tip.
function DateFieldWithTip({ label, tip, value, onChange }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        <InfoTip text={tip} label={label} />
      </label>
      <DateField value={value} onChange={onChange} />
    </div>
  );
}

function RequestsTab({ requests, error, onIssue, onRefresh }) {
  if (error) return <ErrorBanner message={error} />;
  if (requests === null) return <div className="py-12 flex justify-center"><Spinner /></div>;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Letter requests raised by employees. Issuing one fulfils the request so the employee can download it.
        </p>
        <button type="button" onClick={onRefresh} className="text-sm text-gray-500 hover:text-gray-700">Refresh</button>
      </div>
      {requests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 text-center text-sm text-gray-400">
          No pending letter requests.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Employee</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Purpose</th>
                <th className="px-4 py-2 font-medium">Requested</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {requests.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{r.employee?.name || '—'}</div>
                    {r.employee?.code && <div className="text-xs text-gray-400">{r.employee.code}</div>}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{r.templateKindLabel || r.templateKind}</td>
                  <td className="px-4 py-3 text-gray-500 max-w-[18rem] truncate" title={r.purpose || ''}>{r.purpose || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => onIssue(r)}
                      className="rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800"
                    >
                      Issue this
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function IssueResult({ result, onAnother, onRegister }) {
  const pending = result.status === 'PENDING_SIGNATURE';
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-8 max-w-xl">
      <div className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${pending ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
        {pending ? 'Routed for signature' : 'Letter issued'}
      </div>
      <dl className="mt-4 space-y-2 text-sm">
        {result.referenceNo && (
          <div className="flex justify-between"><dt className="text-gray-500">Reference no</dt><dd className="font-mono font-medium">{result.referenceNo}</dd></div>
        )}
        <div className="flex justify-between"><dt className="text-gray-500">Status</dt><dd>{result.status}</dd></div>
        {pending && <p className="text-xs text-gray-500 pt-1">The reference number is minted once the e-sign envelope is completed.</p>}
      </dl>
      <div className="mt-6 flex items-center gap-3">
        <PrimaryButton onClick={onRegister}>Open register</PrimaryButton>
        <button type="button" onClick={onAnother} className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50">Issue another</button>
      </div>
    </div>
  );
}
