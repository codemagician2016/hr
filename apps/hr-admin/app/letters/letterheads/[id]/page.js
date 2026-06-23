'use client';

// Visual position-picker (Feature 9 slice 9C) — /letters/letterheads/:id.
//
// Rasterizes page 1 of the uploaded letterhead PDF CLIENT-SIDE (PdfCanvas →
// pdfjs-dist) and overlays draggable + resizable boxes for the 5 zones (writing
// area, date, ref-no, authority name, signature image). The operator drags/sizes
// each box over the real stationery; on save we convert canvas px → NORMALIZED
// [0,1] TOP-LEFT rects and PUT /:id/layout. "What you place is what you get" —
// the same A4 page is the server render underlay, so the overlay is WYSIWYG.
//
// Coordinate model: the hook owns the canonical normalized rects; this page maps
// normalized ↔ px against the rendered canvas size (cssWidth/cssHeight). Zoom only
// changes the render scale (px size); the normalized model is zoom-invariant, so
// what we save never depends on the current zoom.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ErrorBanner, PrimaryButton } from '@hr/ui';
import { get } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import PdfCanvas from '../PdfCanvas';
import { ZONES, useLetterheadLayout } from '../useLetterheadLayout';

const ZOOMS = [0.75, 1, 1.25, 1.5];
const HANDLE = 10; // px resize-handle hit size

export default function LetterheadPickerPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id;

  const [letterhead, setLetterhead] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [scale, setScale] = useState(1);
  const [showGuides, setShowGuides] = useState(true);
  const [activeZone, setActiveZone] = useState('writingArea');
  const [canvasSize, setCanvasSize] = useState({ cssWidth: 595, cssHeight: 842 });

  const layout = useLetterheadLayout();
  const { rects, extras, saving, hydrate, updateRect, setExtra, save } = layout;

  const overlayRef = useRef(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    get(`/api/hr/letters/letterheads/${id}`)
      .then((row) => { setLetterhead(row); hydrate(row.layoutJson); })
      .catch((e) => setError(e.message || 'Failed to load the letterhead.'))
      .finally(() => setLoading(false));
  }, [id, hydrate]);

  const onSize = useCallback((s) => { setCanvasSize(s); }, []);

  // ── drag / resize on the overlay ───────────────────────────────────────────
  // We track a pointer gesture in px against the overlay box, converting to
  // normalized deltas on the fly. `mode` is 'move' | 'resize'.
  const dragRef = useRef(null);

  const onPointerDown = useCallback((e, zoneKey, mode) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveZone(zoneKey);
    const overlay = overlayRef.current;
    if (!overlay) return;
    const box = overlay.getBoundingClientRect();
    dragRef.current = {
      zoneKey,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      boxW: box.width,
      boxH: box.height,
      start: { ...rects[zoneKey] },
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }, [rects]);

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current;
    if (!d) return;
    const dxN = (e.clientX - d.startX) / d.boxW;
    const dyN = (e.clientY - d.startY) / d.boxH;
    if (d.mode === 'move') {
      updateRect(d.zoneKey, {
        x: d.start.x + dxN,
        y: d.start.y + dyN,
        w: d.start.w,
        h: d.start.h,
      });
    } else {
      // resize from the bottom-right handle: grow w/h, floor to a small min.
      updateRect(d.zoneKey, {
        x: d.start.x,
        y: d.start.y,
        w: Math.max(0.02, d.start.w + dxN),
        h: Math.max(0.01, d.start.h + dyN),
      });
    }
  }, [updateRect]);

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove, onPointerUp]);

  const onSave = useCallback(async () => {
    setError('');
    setSaved(false);
    try {
      await save(id);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e.message || 'Save failed.');
    }
  }, [id, save]);

  // The PDF source for rasterizing: the stored fileUrl (S3 URL or inline data-URL).
  const src = letterhead && letterhead.fileUrl ? letterhead.fileUrl : null;

  const { cssWidth, cssHeight } = canvasSize;

  // Margin guides at 10% / 90% of each axis.
  const guides = useMemo(() => ({
    left: 0.1 * cssWidth, right: 0.9 * cssWidth, top: 0.1 * cssHeight, bottom: 0.9 * cssHeight,
  }), [cssWidth, cssHeight]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title={letterhead ? `Position picker — ${letterhead.name}` : 'Position picker'}
        subtitle="Drag and resize the five zones over the real stationery. Boxes are stored normalized (0–1, top-left), so what you place is what the issued letter gets."
        actions={(
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => router.push('/letters/letterheads')}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50">
              Back
            </button>
            <PrimaryButton onClick={onSave} loading={saving}>Save layout</PrimaryButton>
          </div>
        )}
      />

      {error && <ErrorBanner message={error} />}
      {saved && (
        <p className="mb-3 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-700">
          Layout saved.
        </p>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !src ? (
        <ErrorBanner message="This letterhead has no PDF to preview." />
      ) : (
        <div className="flex flex-col lg:flex-row gap-6">
          {/* Toolbar + zone legend */}
          <div className="lg:w-64 shrink-0 space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-xs font-semibold text-gray-700 mb-2">Zoom</h3>
              <div className="flex gap-1">
                {ZOOMS.map((z) => (
                  <button key={z} type="button" onClick={() => setScale(z)}
                    className={`px-2 py-1 text-xs rounded-md border ${scale === z ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-300 text-gray-600'}`}>
                    {Math.round(z * 100)}%
                  </button>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
                Margin guides
              </label>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-xs font-semibold text-gray-700 mb-2">Zones</h3>
              <ul className="space-y-1.5">
                {ZONES.map((z) => (
                  <li key={z.key}>
                    <button type="button" onClick={() => setActiveZone(z.key)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs ${activeZone === z.key ? 'bg-gray-100 font-medium' : 'hover:bg-gray-50'}`}>
                      <span className="inline-block h-3 w-3 rounded-sm" style={{ background: z.color }} />
                      {z.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-2">
              <h3 className="text-xs font-semibold text-gray-700">Overflow</h3>
              <select value={extras.overflowPolicy} onChange={(e) => setExtra('overflowPolicy', e.target.value)}
                className="w-full text-xs border border-gray-300 rounded-md px-2 py-1 bg-white">
                <option value="repeat-letterhead">Repeat letterhead</option>
                <option value="blank-continuation">Blank continuation</option>
              </select>
              <label className="flex items-center gap-2 text-xs text-gray-600">
                <input type="checkbox" checked={!!extras.signatureOnLastPage}
                  onChange={(e) => setExtra('signatureOnLastPage', e.target.checked)} />
                Signature on last page
              </label>
            </div>
          </div>

          {/* Canvas + overlay */}
          <div className="overflow-auto">
            <div ref={overlayRef} className="relative inline-block" style={{ width: cssWidth, height: cssHeight }}>
              <PdfCanvas src={src} scale={scale} onSize={onSize} />

              {/* Margin guides */}
              {showGuides && (
                <svg className="pointer-events-none absolute inset-0" width={cssWidth} height={cssHeight}>
                  {[guides.left, guides.right].map((x, i) => (
                    <line key={`v${i}`} x1={x} y1={0} x2={x} y2={cssHeight} stroke="#94a3b8" strokeDasharray="4 4" strokeWidth="1" opacity="0.5" />
                  ))}
                  {[guides.top, guides.bottom].map((y, i) => (
                    <line key={`h${i}`} x1={0} y1={y} x2={cssWidth} y2={y} stroke="#94a3b8" strokeDasharray="4 4" strokeWidth="1" opacity="0.5" />
                  ))}
                </svg>
              )}

              {/* Zone boxes */}
              {ZONES.map((z) => {
                const r = rects[z.key];
                if (!r) return null;
                const left = r.x * cssWidth;
                const top = r.y * cssHeight;
                const w = r.w * cssWidth;
                const h = r.h * cssHeight;
                const isActive = activeZone === z.key;
                return (
                  <div
                    key={z.key}
                    onPointerDown={(e) => onPointerDown(e, z.key, 'move')}
                    className="absolute cursor-move select-none"
                    style={{
                      left, top, width: w, height: h,
                      border: `2px solid ${z.color}`,
                      background: `${z.color}1a`,
                      boxShadow: isActive ? `0 0 0 2px ${z.color}55` : 'none',
                      zIndex: isActive ? 20 : 10,
                    }}
                  >
                    <span className="absolute -top-5 left-0 whitespace-nowrap rounded px-1 text-[10px] font-medium text-white"
                      style={{ background: z.color }}>
                      {z.label}
                    </span>
                    {/* resize handle (bottom-right) */}
                    <span
                      onPointerDown={(e) => onPointerDown(e, z.key, 'resize')}
                      className="absolute cursor-nwse-resize"
                      style={{
                        right: -HANDLE / 2, bottom: -HANDLE / 2, width: HANDLE, height: HANDLE,
                        background: z.color, borderRadius: 2,
                      }}
                    />
                  </div>
                );
              })}
            </div>

            <p className="mt-2 text-xs text-gray-400">
              Page {Math.round(canvasSize.pageWidthPt || 0)}×{Math.round(canvasSize.pageHeightPt || 0)}pt · drag a box to move, drag the corner to resize.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
