'use client';

// Reusable image upload dropzone for the admin. Replaces plain "image URL"
// text fields in ProductsPanel / CategoriesPanel / BannersPanel etc.
//
// Two modes:
//   • Single  — <ImageDropZone value={url} onChange={(url) => …} scope="…" />
//   • Multi   — <ImageDropZone values={urls} onChange={(urls) => …} max={20} scope="…" />
//
// Features:
//   • Click or drag/drop a file → instant preview tile (showing the local
//     data URL) → POST /api/upload/image → tile flips to the final S3 URL.
//   • Click an existing tile → opens the shared ImageEditorModal
//     (zoom / rotate / reposition) — same editor used by the blog cover
//     image and the website ContentEditor. Any vertical that imports this
//     component gets the same edit experience for free.
//   • URL paste-in stays available for power users.
//   • Falls back to embedding the base64 data URL inline when the backend
//     reports S3 not configured (uploadDataUrl throws).

import { useRef, useState, useCallback } from 'react';
import ImageEditorModal from '@/components/ImageEditorModal';

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = (e) => resolve(e.target?.result || '');
    reader.readAsDataURL(file);
  });
}

async function imageInfoFromDataUrl(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
}

async function uploadDataUrl(dataUrl, scope) {
  const res = await fetch('/api/upload/image', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, scope: scope || 'admin' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // S3 unconfigured? Embed the base64 inline so the feature still works
    // in dev / on tenants without a bucket. Backend logs the misconfig.
    if (res.status === 503 || /not configured/i.test(body.message || '')) return dataUrl;
    throw new Error(body.message || `Upload failed (${res.status})`);
  }
  return body.url || dataUrl;
}

function Spinner() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/30">
      <div className="w-5 h-5 rounded-full border-2 border-white border-t-transparent animate-spin" />
    </div>
  );
}

function Thumb({ url, onRemove, onClick, uploading }) {
  return (
    <div className="relative group w-20 h-20 rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
      <button type="button" onClick={onClick} disabled={uploading}
        className="absolute inset-0 w-full h-full disabled:cursor-default focus:outline-none focus:ring-2 focus:ring-indigo-400"
        aria-label={uploading ? 'Uploading' : 'Edit image'}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" className="w-full h-full object-cover"
          onError={(e) => { e.currentTarget.style.display = 'none'; }} />
      </button>
      {uploading && <Spinner />}
      {!uploading && (
        <span className="absolute bottom-1 left-1 text-[9px] font-mono uppercase tracking-wider text-white bg-black/50 rounded px-1 opacity-0 group-hover:opacity-100 transition-opacity">
          Edit
        </span>
      )}
      {onRemove && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-xs leading-none opacity-0 group-hover:opacity-100 transition-opacity z-10"
          aria-label="Remove image">×</button>
      )}
    </div>
  );
}

function DropTarget({ onPick, busy, hint, height = 'h-32' }) {
  const [drag, setDrag] = useState(false);
  return (
    <label className={`cursor-pointer flex flex-col items-center justify-center ${height} border-2 border-dashed rounded-lg transition-colors ${
      drag ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-indigo-400 hover:bg-indigo-50/50'
    }`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault(); setDrag(false);
        const f = e.dataTransfer.files?.[0]; if (f) onPick(f);
      }}>
      <svg className="w-7 h-7 text-gray-400 mb-1" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 7.5m0 0L7.5 12M12 7.5v9" />
      </svg>
      <span className="text-sm font-medium text-gray-600">{busy ? 'Uploading…' : 'Click to upload'}</span>
      <span className="text-[11px] text-gray-400 mt-0.5">{busy ? 'Please wait' : (hint || 'or drag & drop · PNG, JPG, WebP')}</span>
      <input type="file" accept="image/*" className="hidden" disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ''; }} />
    </label>
  );
}

export default function ImageDropZone({
  value, values, onChange,
  scope = 'admin', max = 1, allowUrlPaste = true, className = '',
  frameAspect = 1, // square by default; banners override to 16/9
  editorValue = '',
  openEditorOnUpload = false,
  onOriginalChange,
  editorTitle = 'Edit image',
  aspectOptions = [],
  aspectValue = '',
  onAspectChange,
  maxOutputWidth = 1600,
  outputType = 'image/jpeg',
  editorBackground = '#ffffff',
  editorFitMode = 'cover',
  onImageInfo,
}) {
  const multi = Array.isArray(values);
  const list = multi ? values : (value ? [value] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pasteRef = useRef(null);

  // Optimistic preview while the upload is in flight: shows the file's
  // local data URL so the user sees their picked image immediately, with
  // a spinner overlay until the S3 URL comes back. Cleared on success.
  const [pendingDataUrl, setPendingDataUrl] = useState('');

  // Click-to-edit state. When set, render <ImageEditorModal> with the
  // tile's current URL; on save, replace the URL at that index.
  const [editingIdx, setEditingIdx] = useState(null);
  const [draftEditorUrl, setDraftEditorUrl] = useState('');

  const apply = useCallback((next) => {
    if (multi) onChange(next);
    else onChange(next[0] || '');
  }, [multi, onChange]);

  async function handleFile(file) {
    if (list.length >= max) { setError(`Limit reached (${max} image${max === 1 ? '' : 's'})`); return; }
    setBusy(true); setError('');
    let dataUrl = '';
    try {
      dataUrl = await fileToDataUrl(file);
      if (onImageInfo) {
        const info = await imageInfoFromDataUrl(dataUrl);
        onImageInfo({ file, dataUrl, ...info });
      }
      setPendingDataUrl(dataUrl);
      const url = await uploadDataUrl(dataUrl, scope);
      if (openEditorOnUpload && !multi) {
        onOriginalChange?.(url);
        setDraftEditorUrl(url);
        setEditingIdx(0);
        return;
      }
      apply([...list, url]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      setPendingDataUrl('');
    }
  }

  function handlePaste() {
    const v = pasteRef.current?.value?.trim();
    if (!v) return;
    if (list.length >= max) { setError(`Limit reached (${max} image${max === 1 ? '' : 's'})`); return; }
    if (openEditorOnUpload && !multi) {
      onOriginalChange?.(v);
      setDraftEditorUrl(v);
      setEditingIdx(0);
      pasteRef.current.value = '';
      return;
    }
    apply([...list, v]);
    pasteRef.current.value = '';
  }

  function removeAt(i) {
    apply(list.filter((_, idx) => idx !== i));
    if (!multi) onOriginalChange?.('');
  }

  function handleEditSaved(newUrl) {
    if (editingIdx == null) return;
    const next = [...list];
    next[editingIdx] = newUrl;
    if (!multi && next.length === 0) next[0] = newUrl;
    apply(next);
    setEditingIdx(null);
    setDraftEditorUrl('');
  }

  function closeEditor() {
    setEditingIdx(null);
    setDraftEditorUrl('');
  }

  return (
    <div className={`space-y-2 ${className}`}>
      {(list.length > 0 || pendingDataUrl) && (
        <div className="flex flex-wrap gap-2">
          {list.map((url, i) => (
            <Thumb key={`${url}-${i}`} url={url}
              onRemove={() => removeAt(i)}
              onClick={() => setEditingIdx(i)} />
          ))}
          {pendingDataUrl && (
            <Thumb url={pendingDataUrl} uploading />
          )}
        </div>
      )}

      {list.length < max && !pendingDataUrl && (
        <DropTarget onPick={handleFile} busy={busy}
          hint={max > 1 ? `or drag & drop · ${list.length} of ${max} added` : 'or drag & drop · PNG, JPG, WebP'} />
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}

      {allowUrlPaste && list.length < max && !pendingDataUrl && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-gray-400 font-mono shrink-0">or paste URL</span>
          <input ref={pasteRef} type="url" placeholder="https://cdn.example.com/foo.jpg"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlePaste(); } }} />
          <button type="button" onClick={handlePaste}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 shrink-0">Add</button>
        </div>
      )}

      {editingIdx != null && list[editingIdx] && (
        <ImageEditorModal
          value={editorValue || list[editingIdx]}
          onSave={handleEditSaved}
          onClose={closeEditor}
          scope={scope}
          frameAspect={frameAspect}
          aspectOptions={aspectOptions}
          aspectValue={aspectValue}
          onAspectChange={onAspectChange}
          maxOutputWidth={maxOutputWidth}
          outputType={outputType}
          background={editorBackground}
          fitMode={editorFitMode}
          title={editorTitle}
        />
      )}
      {editingIdx != null && !list[editingIdx] && (draftEditorUrl || editorValue) && (
        <ImageEditorModal
          value={draftEditorUrl || editorValue}
          onSave={handleEditSaved}
          onClose={closeEditor}
          scope={scope}
          frameAspect={frameAspect}
          aspectOptions={aspectOptions}
          aspectValue={aspectValue}
          onAspectChange={onAspectChange}
          maxOutputWidth={maxOutputWidth}
          outputType={outputType}
          background={editorBackground}
          fitMode={editorFitMode}
          title={editorTitle}
        />
      )}
    </div>
  );
}
