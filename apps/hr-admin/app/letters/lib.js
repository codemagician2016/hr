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

// POST a JSON body and return the PDF response as a Blob. On a non-2xx (e.g. a
// 422 missingRequired) the body is JSON, so we parse + throw with .status/.data
// so callers can surface the missing-field list.
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
  return res.blob();
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

export const LETTER_CATEGORIES = [
  'EXPERIENCE', 'BONAFIDE', 'EMPLOYMENT_PROOF', 'SALARY_PROOF', 'BANK', 'CONTRACT', 'CUSTOM',
];

export const LETTER_STATUSES = [
  'DRAFT', 'PENDING_SIGNATURE', 'ISSUED', 'DELIVERED', 'VOIDED',
];
