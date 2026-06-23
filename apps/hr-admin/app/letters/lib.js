'use client';

// Shared helpers for the Letters issue wizard + register. The api.request()
// wrapper parses every response as JSON, which breaks on the PDF streams that
// /preview and /:id/download return — so we POST/GET those directly here and
// read the body as a Blob. Same credentials:'include' cookie-auth contract.

const API_BASE = String(process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');

function resolveUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  const rel = path.startsWith('/') ? path : `/${path}`;
  return API_BASE ? `${API_BASE}${rel}` : rel;
}

// POST a JSON body and return the PDF response as { blob, masked }. The masked
// list (comp merge-field keys hidden because the caller lacks canViewCompensation)
// rides on the X-Letter-Masked response header — the body is a binary PDF, so it
// can't carry JSON. On a non-2xx (e.g. a 422 missingRequired) the body IS JSON, so
// we parse + throw with .status/.data so callers can surface the missing-field list.
export async function postForPdf(path, data) {
  const res = await fetch(resolveUrl(path), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data ?? {}),
  });
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch { /* non-JSON error */ }
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = body;
    throw err;
  }
  const maskedHeader = res.headers.get('X-Letter-Masked') || '';
  const masked = maskedHeader ? maskedHeader.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const blob = await res.blob();
  return { blob, masked };
}

// GET a stored letter PDF as a Blob (for the register download action).
export async function getPdf(path) {
  const res = await fetch(resolveUrl(path), { credentials: 'include' });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

// Trigger a browser download for a Blob.
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'letter.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── ⓘ InfoTip — a tiny accessible field-help affordance ──────────────────────
// A circled "i" that reveals help text on hover/focus (native `title` for hover,
// an aria-label for screen readers). Used on every field across the Letters
// surfaces (Issue / Templates / Letterheads / Register / Request) so a layman
// knows what each input does.
export function InfoTip({ text, label }) {
  if (!text) return null;
  return (
    <span
      className="ml-1 inline-flex h-4 w-4 cursor-help select-none items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold leading-none text-gray-500 align-middle hover:border-gray-400 hover:text-gray-700"
      title={text}
      tabIndex={0}
      role="img"
      aria-label={`${label ? `${label}: ` : 'Help: '}${text}`}
    >
      i
    </span>
  );
}

// A label row with an inline ⓘ tip — the canonical "field label + help" header.
export function LabelWithTip({ label, tip, htmlFor, className }) {
  return (
    <label htmlFor={htmlFor} className={className || 'block text-sm font-medium text-gray-700 mb-1'}>
      {label}
      <InfoTip text={tip} label={label} />
    </label>
  );
}

export const LETTER_CATEGORIES = [
  'EXPERIENCE', 'BONAFIDE', 'EMPLOYMENT_PROOF', 'SALARY_PROOF', 'BANK', 'CONTRACT', 'CUSTOM',
];

export const LETTER_STATUSES = [
  'DRAFT', 'PENDING_SIGNATURE', 'ISSUED', 'DELIVERED', 'VOIDED',
];
