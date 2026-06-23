'use client';

// Issue-a-Letter wizard (Feature 9 §5.1, slice 9E). The flow:
//   1) pick a template (GET /api/hr/letters/templates — built by 9D; this page
//      degrades to a manual template-id field if that endpoint isn't live yet)
//   2) pick an employee (GET /api/hr/employees — F1-scoped server-side; out-of-
//      scope rows are simply not returned)
//   3) auto-merge → editable live preview via POST /api/hr/letters/preview
//      (streams a watermarked PDF; a 422 surfaces the missing-required list and
//      blocks Issue; masked salary shows a "hidden" notice)
//   4) issue date + optional custom paragraph
//   5) Issue now → POST /api/hr/letters/issue (mints the ref-no, renders the
//      flattened PDF, writes the vault doc + audit). CONTRACT templates return
//      PENDING_SIGNATURE (an e-sign envelope was opened).
//
// The server is the real enforcement boundary; this is the maker UX.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorBanner, PrimaryButton, TextInput, TextArea, DateField, Spinner } from '@hr/ui';
import { get, post } from '@/lib/api';
import { PageHeader, asList, employeeLabel } from '@/lib/ui';
import { postForPdf } from '../lib';

export default function IssueLetterPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState(null);
  const [templatesErr, setTemplatesErr] = useState('');
  const [templateId, setTemplateId] = useState('');

  const [empQuery, setEmpQuery] = useState('');
  const [employees, setEmployees] = useState([]);
  const [employeeId, setEmployeeId] = useState('');
  const [employeeLabelText, setEmployeeLabelText] = useState('');

  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [subject, setSubject] = useState('');
  const [customParagraph, setCustomParagraph] = useState('');

  const [previewUrl, setPreviewUrl] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [missingRequired, setMissingRequired] = useState([]);
  const [masked, setMasked] = useState([]);
  const [error, setError] = useState('');
  const [issuing, setIssuing] = useState(false);
  const [result, setResult] = useState(null);
  const previewObjUrl = useRef('');

  const selectedTemplate = useMemo(
    () => (templates || []).find((t) => t.id === templateId) || null,
    [templates, templateId]
  );

  // ── load templates (9D endpoint; graceful if absent) ───────────────────────
  useEffect(() => {
    get('/api/hr/letters/templates', { isActive: true, pageSize: 200 })
      .then((r) => setTemplates(asList(r)))
      .catch((e) => {
        // 404 (route not mounted yet) → fall back to a manual id entry.
        setTemplates([]);
        if (e.status && e.status !== 404) setTemplatesErr(e.message || 'Could not load templates.');
      });
  }, []);

  // ── employee search (debounced) ────────────────────────────────────────────
  useEffect(() => {
    const h = setTimeout(() => {
      get('/api/hr/employees', { q: empQuery.trim(), status: 'ACTIVE', page: 1, pageSize: 20 })
        .then((r) => setEmployees(asList(r)))
        .catch(() => setEmployees([]));
    }, 250);
    return () => clearTimeout(h);
  }, [empQuery]);

  const overrides = useMemo(() => {
    const o = { issueDate };
    if (subject.trim()) o.subject = subject.trim();
    if (customParagraph.trim()) o.customParagraph = customParagraph.trim();
    return o;
  }, [issueDate, subject, customParagraph]);

  // ── live preview (POST /preview → blob → object URL) ───────────────────────
  const runPreview = useCallback(async () => {
    if (!templateId) return;
    setPreviewing(true); setError(''); setMissingRequired([]);
    try {
      const blob = await postForPdf('/api/hr/letters/preview', {
        templateId, employeeId: employeeId || null, overrides,
      });
      if (previewObjUrl.current) URL.revokeObjectURL(previewObjUrl.current);
      const url = URL.createObjectURL(blob);
      previewObjUrl.current = url;
      setPreviewUrl(url);
      // The preview body is a PDF, so masked/missing come back via the issue path
      // only — but a preview that 422s tells us about missing-required up front.
      setMasked([]);
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
  }, [templateId, employeeId, overrides]);

  // auto-preview when template or employee changes (the "live" merge).
  useEffect(() => {
    if (templateId) runPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, employeeId]);

  useEffect(() => () => {
    if (previewObjUrl.current) URL.revokeObjectURL(previewObjUrl.current);
  }, []);

  const canIssue = templateId && missingRequired.length === 0 && !issuing;

  async function onIssue() {
    if (!templateId) return;
    setIssuing(true); setError(''); setResult(null);
    try {
      const out = await post('/api/hr/letters/issue', {
        templateId, employeeId: employeeId || null, overrides,
      });
      setResult(out);
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

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Issue a letter"
        subtitle="Pick a template and employee, review the live preview, then issue. A reference number is minted on issue."
        actions={<button type="button" onClick={() => router.push('/letters/register')} className="text-sm text-gray-500 hover:text-gray-700">View register →</button>}
      />

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
      {templatesErr && <div className="mb-4"><ErrorBanner message={templatesErr} /></div>}

      {result ? (
        <IssueResult result={result} onAnother={() => { setResult(null); setPreviewUrl(''); }} onRegister={() => router.push('/letters/register')} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── left: the form ── */}
          <div className="space-y-5">
            <Field label="Template">
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
                  placeholder="Template id (the template library lands in 9D)"
                />
              )}
              {selectedTemplate?.requiresSignature && (
                <p className="mt-1 text-xs text-amber-700">
                  This template requires a signature — issuing opens an e-sign envelope; the reference number is minted once signed.
                </p>
              )}
            </Field>

            <Field label="Employee (optional for company-wide letters)">
              <TextInput
                value={empQuery}
                onChange={(v) => setEmpQuery(v)}
                placeholder="Search by name or code…"
              />
              {employeeId && (
                <div className="mt-1 flex items-center gap-2 text-sm text-gray-700">
                  <span className="font-medium">{employeeLabelText}</span>
                  <button type="button" onClick={() => { setEmployeeId(''); setEmployeeLabelText(''); }} className="text-xs text-gray-400 hover:text-gray-600">clear</button>
                </div>
              )}
              {empQuery && employees.length > 0 && (
                <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-50">
                  {employees.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => { setEmployeeId(e.id); setEmployeeLabelText(employeeLabel(e)); setEmpQuery(''); }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                      >
                        {employeeLabel(e)} <span className="text-gray-400">{e.code}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>

            <DateField label="Issue date" value={issueDate} onChange={(v) => setIssueDate(v)} />

            <TextInput label="Subject override (optional)" value={subject} onChange={(v) => setSubject(v)} placeholder="Defaults to the template subject" />

            <TextArea label="Custom paragraph (optional)" value={customParagraph} onChange={(v) => setCustomParagraph(v)} rows={4} hint="Appended to the letter body." />

            {masked.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Salary figures are hidden (you lack canViewCompensation) — they render masked on the issued letter.
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
            <div className="px-4 py-2 border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
              Live preview (watermarked · not the final letter)
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
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
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
