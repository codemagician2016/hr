'use client';

// Sprint 3.3e — shared image editor modal. Used by:
//   - Block editor's Image+Text field (PagesPanel)
//   - Blog cover image (BlogPanel) [follow-up commit]
//   - Hero banner / logo / gallery (ContentEditor) [follow-up commit]
//
// API:
//   <ImageEditorModal
//     value={existingUrl}             // optional — preloads on open
//     onSave={(finalUrl) => ...}      // called after upload
//     onClose={() => ...}
//     scope="block-image"             // backend hint for filename
//     frameAspect={16/9}              // canvas aspect (default 16:9)
//     maxOutputWidth={1600}           // resize cap on save
//   />
//
// Controls:
//   - File picker (button) + drag-drop on the preview pane
//   - Paste from URL (small input)
//   - Zoom slider (1.0 → 3.0)
//   - Rotate left/right (±90°)
//   - Drag the image inside the frame to reposition
//   - Reset (clear all transforms)
//   - Replace image (clears + opens file picker)
//   - Save (commits the edited image; uploads + calls onSave)

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  loadImage,
  renderEditedToCanvas,
  canvasToDataUrl,
  uploadDataUrl,
} from '@/lib/imageProcessing';

// Visual canvas caps. Bound BOTH width and height so a square (1:1) frame
// doesn't push the controls + Save button below the viewport on standard
// laptop screens. Whichever cap is binding wins, then the other dimension
// is recomputed to preserve frameAspect. Output is still rendered at
// maxOutputWidth — these constants only affect the preview pane.
const MAX_FRAME_W = 520;
const MAX_FRAME_H = 360;

export default function ImageEditorModal({
  value = '',
  onSave,
  onClose,
  scope = 'image',
  frameAspect = 16 / 9,
  aspectOptions = [],
  aspectValue = '',
  onAspectChange,
  maxOutputWidth = 1600,
  outputType = 'image/jpeg',
  background = '#ffffff',
  fitMode = 'cover',
  title = 'Edit image',
}) {
  const [image, setImage] = useState(null);          // HTMLImageElement
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [busy, setBusy] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const previewCanvasRef = useRef(null);
  const fileInputRef = useRef(null);

  // Frame canvas dimensions (preview). Width-bound by default; if the
  // resulting height exceeds MAX_FRAME_H (square + portrait aspects),
  // re-derive width from the height cap so we never overflow vertically.
  const selectedAspect = aspectOptions.find((option) => option.value === aspectValue) || aspectOptions[0];
  const activeFrameAspect = selectedAspect?.aspect || frameAspect;
  let frameW = MAX_FRAME_W;
  let frameH = Math.round(frameW / activeFrameAspect);
  if (frameH > MAX_FRAME_H) {
    frameH = MAX_FRAME_H;
    frameW = Math.round(frameH * activeFrameAspect);
  }

  // Preload `value` (an existing URL) when the modal opens.
  useEffect(() => {
    let cancelled = false;
    async function preload() {
      if (!value) return;
      setLoading(true);
      setError('');
      try {
        const img = await loadImage(value);
        if (!cancelled) setImage(img);
      } catch (e) {
        if (!cancelled) setError(e.message || 'Could not load existing image');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    preload();
    return () => { cancelled = true; };
  }, [value]);

  // Render preview whenever image or transforms change.
  const drawPreview = useCallback(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    canvas.width = frameW;
    canvas.height = frameH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, frameW, frameH);
    if (!image) return;
    const isQuarterTurn = rotation % 180 !== 0;
    const naturalW = isQuarterTurn ? image.naturalHeight : image.naturalWidth;
    const naturalH = isQuarterTurn ? image.naturalWidth : image.naturalHeight;
    const fitScale = fitMode === 'contain'
      ? Math.min(frameW / naturalW, frameH / naturalH)
      : Math.max(frameW / naturalW, frameH / naturalH);
    const drawScale = fitScale * zoom;
    ctx.save();
    ctx.translate(frameW / 2 + offsetX, frameH / 2 + offsetY);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(
      image,
      -image.naturalWidth * drawScale / 2,
      -image.naturalHeight * drawScale / 2,
      image.naturalWidth * drawScale,
      image.naturalHeight * drawScale,
    );
    ctx.restore();
  }, [image, zoom, rotation, offsetX, offsetY, frameW, frameH]);

  useEffect(() => { drawPreview(); }, [drawPreview]);

  function reset() {
    setZoom(1);
    setRotation(0);
    setOffsetX(0);
    setOffsetY(0);
  }

  async function handleFile(file) {
    if (!file) return;
    if (!file.type?.startsWith('image/')) { setError('Please pick an image file.'); return; }
    if (file.size > 12 * 1024 * 1024) { setError('Image is over 12 MB — try a smaller one.'); return; }
    setError('');
    setLoading(true);
    try {
      const img = await loadImage(file);
      setImage(img);
      reset();
    } catch (e) {
      setError(e.message || 'Could not load image');
    } finally {
      setLoading(false);
    }
  }

  async function loadFromUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setError('');
    setLoading(true);
    try {
      const img = await loadImage(url);
      setImage(img);
      reset();
      setUrlInput('');
    } catch (e) {
      setError('Could not load that URL — CORS or 404 likely.');
    } finally {
      setLoading(false);
    }
  }

  // Drag to reposition.
  const dragRef = useRef(null);
  function onPointerDown(e) {
    if (!image) return;
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offsetX, oy: offsetY };
  }
  function onPointerMove(e) {
    if (!dragRef.current) return;
    const { x, y, ox, oy } = dragRef.current;
    setOffsetX(ox + (e.clientX - x));
    setOffsetY(oy + (e.clientY - y));
  }
  function onPointerUp(e) {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    dragRef.current = null;
  }

  // Drag-drop a file directly onto the preview.
  function onDragOver(e) { e.preventDefault(); }
  function onDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  }

  async function save() {
    if (!image) { setError('Pick an image first'); return; }
    setBusy(true);
    setError('');
    try {
      const canvas = renderEditedToCanvas({
        image, rotation, zoom, offsetX: offsetX * (maxOutputWidth / frameW),
        offsetY: offsetY * (maxOutputWidth / frameW),
        frameAspect: activeFrameAspect, maxOutputWidth, background, fitMode,
      });
      let dataUrl;
      try {
        dataUrl = canvasToDataUrl(canvas, 0.92, outputType);
      } catch (canvasErr) {
        // SecurityError when canvas is tainted (image was loaded
        // without CORS because both the host and our /proxy refused).
        // Tell the user clearly instead of swallowing it.
        if (canvasErr.name === 'SecurityError' || /tainted/i.test(canvasErr.message)) {
          setError("This image's host blocks editing across sites. Upload a fresh copy from your computer instead.");
          return;
        }
        throw canvasErr;
      }
      const finalUrl = await uploadDataUrl(dataUrl, scope);
      onSave(finalUrl);
      onClose();
    } catch (e) {
      setError(e.message || 'Could not save image');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {aspectOptions.length > 0 && (
            <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">Frame</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {aspectOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onAspectChange?.(option.value);
                      reset();
                    }}
                    className={[
                      'rounded-lg border px-3 py-2 text-left transition',
                      option.value === selectedAspect?.value
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-900'
                        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300',
                    ].join(' ')}
                  >
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className="mt-0.5 block text-xs text-gray-500">{option.size}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Preview */}
          <div
            className="mx-auto overflow-hidden rounded-lg border-2 border-dashed border-gray-300 bg-gray-50"
            style={{ width: frameW, maxWidth: '100%' }}
            onDragOver={onDragOver}
            onDrop={onDrop}
          >
            <canvas
              ref={previewCanvasRef}
              className="block touch-none cursor-grab active:cursor-grabbing"
              style={{ width: '100%', height: 'auto', userSelect: 'none' }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
          {!image && !loading && (
            <p className="mt-2 text-center text-xs text-gray-500">
              Drag an image here, click <strong>Upload</strong>, or paste a URL below.
            </p>
          )}
          {loading && <p className="mt-2 text-center text-xs text-gray-500">Loading…</p>}
          {error && <p className="mt-2 text-center text-xs text-red-600">{error}</p>}

          {/* Source row — file picker + URL paste */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                handleFile(f);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              📤 {image ? 'Replace' : 'Upload'}
            </button>
            <div className="flex flex-1 items-center gap-2">
              <input
                type="url"
                placeholder="…or paste an image URL"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); loadFromUrl(); } }}
                className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
              />
              <button
                type="button"
                onClick={loadFromUrl}
                disabled={!urlInput.trim()}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Load
              </button>
            </div>
          </div>

          {/* Edit controls */}
          {image && (
            <div className="mt-5 space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div>
                <label className="mb-1 flex items-center justify-between text-xs font-medium text-gray-600">
                  <span>Zoom</span>
                  <span className="font-mono text-gray-500">{zoom.toFixed(2)}×</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="3"
                  step="0.05"
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setRotation((r) => (r - 90 + 360) % 360)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  ↺ Rotate left
                </button>
                <button
                  type="button"
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  ↻ Rotate right
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                  Reset
                </button>
                <span className="ml-auto text-xs text-gray-500">Tip: drag to reposition</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={busy || !image}
            className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
