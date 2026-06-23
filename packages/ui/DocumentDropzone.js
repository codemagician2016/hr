'use client';

// DocumentDropzone — shared drag/drop file → base64 data-URL uploader with
// CLIENT-SIDE size + type validation and a SHA-256 integrity hash computed in the
// browser (Feature 4 §5.1, slice 4d). Used by the hr-admin documents view and the
// ESS onboarding e-sign/upload steps.
//
// The component is transport-agnostic: it does NOT call the API itself. It hands
// the caller a normalized payload via `onFile`:
//   { category, name, mimeType, sizeBytes, fileHash, fileBase64 }
// so the page wires it to /api/hr/.../documents (or /me/onboarding/documents). The
// server re-validates + re-hashes (never trusts these), but the client checks keep
// the UX tight and reject an oversize/wrong-type file before any upload.

import { useCallback, useRef, useState } from 'react';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — mirrors the server cap.
const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);

function readAsDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function sha256Hex(file) {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null; // hashing is best-effort; the server recomputes authoritatively.
  }
}

export function DocumentDropzone({
  category = 'OTHER',
  label = 'Upload a document',
  hint = 'PDF, PNG or JPG up to 10 MB',
  busy = false,
  done = false,
  onFile,
  accept = 'application/pdf,image/png,image/jpeg',
}) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');

  const handleFile = useCallback(async (file) => {
    setError('');
    if (!file) return;
    const mime = (file.type || '').toLowerCase();
    if (!ALLOWED_MIME.has(mime)) {
      setError('Unsupported file type. Please choose a PDF, PNG or JPG.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File is too large. The limit is 10 MB.');
      return;
    }
    const [fileBase64, fileHash] = await Promise.all([readAsDataUrl(file), sha256Hex(file)]);
    setFileName(file.name);
    if (onFile) {
      await onFile({
        category,
        name: file.name,
        mimeType: mime,
        sizeBytes: file.size,
        fileHash,
        fileBase64,
      });
    }
  }, [category, onFile]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div>
      {label && <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>}
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current && inputRef.current.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-6 text-center text-sm transition ${dragOver ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300'}`}
        style={{ borderColor: dragOver ? 'var(--theme-primary, #6366f1)' : undefined }}
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept={accept}
          onChange={(e) => { const f = e.target.files && e.target.files[0]; if (f) handleFile(f); e.target.value = ''; }}
        />
        <span className="text-gray-600">
          {busy ? 'Uploading…'
            : fileName ? `${fileName} ✓`
            : done ? 'Uploaded — click or drop to replace'
            : 'Click to choose, or drag & drop a file here'}
        </span>
        {hint && <span className="mt-1 text-xs text-gray-400">{hint}</span>}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

// Mask a document/identity number for display: keep the last 4, dot the rest.
export function maskDocumentNumber(value) {
  const v = String(value || '');
  if (v.length <= 4) return v;
  return `${'•'.repeat(Math.max(0, v.length - 4))}${v.slice(-4)}`;
}

export default DocumentDropzone;
