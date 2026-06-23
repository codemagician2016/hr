'use client';

// PdfCanvas — rasterizes PAGE 1 of a letterhead PDF CLIENT-SIDE into a <canvas>
// via pdfjs-dist (slice 9C visual picker). The picker overlays draggable boxes on
// top of this canvas; "what you place is what you get" because the same A4 page is
// the render underlay on the server.
//
// pdfjs is imported dynamically (browser-only) so Next's server build never
// touches it. We disable the web-worker (workerPort = null + a no-worker fetch
// path) to avoid bundling/serving a separate worker asset — letterheads are a
// single small page, so main-thread parsing is fine and keeps the build simple.

import { useEffect, useRef, useState } from 'react';

// Cache the pdfjs module so we only import + configure it once per session.
let _pdfjsPromise = null;
function loadPdfjs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf').then((pdfjs) => {
      // Run worker-less: point workerSrc at an empty string and let pdfjs fall
      // back to the fake (main-thread) worker. This avoids shipping/serving a
      // separate pdf.worker asset through Next's static pipeline.
      try {
        if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = '';
      } catch (_e) { /* noop */ }
      return pdfjs;
    });
  }
  return _pdfjsPromise;
}

/**
 * @param {string}   src        a PDF source: a fileUrl (http(s)/proxy) or a
 *                              base64 data-URL (data:application/pdf;base64,...)
 * @param {number}   scale      render scale (zoom). 1 = 72dpi A4 ≈ 595px wide.
 * @param {Function} onSize     called with { cssWidth, cssHeight, pageWidthPt,
 *                              pageHeightPt } once the page renders.
 */
export default function PdfCanvas({ src, scale = 1, onSize }) {
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setError('');
    setLoading(true);

    async function render() {
      if (!src) { setLoading(false); return; }
      try {
        const pdfjs = await loadPdfjs();
        const docTask = pdfjs.getDocument(toSource(src));
        const pdf = await docTask.promise;
        if (cancelled) { pdf.destroy(); return; }
        const page = await pdf.getPage(1);
        if (cancelled) { pdf.destroy(); return; }

        // Page size at 72dpi (1.0) = points → we report it back for px↔pt math.
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) { pdf.destroy(); return; }
        const ctx = canvas.getContext('2d');

        // Account for device pixel ratio for crisp rendering, but keep the CSS
        // box at the logical viewport size so overlay px ↔ normalized is simple.
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch (_e) { /* */ } }
        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled) { pdf.destroy(); return; }

        if (onSize) {
          onSize({
            cssWidth: Math.floor(viewport.width),
            cssHeight: Math.floor(viewport.height),
            pageWidthPt: base.width,
            pageHeightPt: base.height,
          });
        }
        setLoading(false);
        pdf.cleanup();
      } catch (e) {
        if (!cancelled) {
          // pdfjs throws a RenderingCancelledException on cancel — ignore those.
          if (e && /cancel/i.test(e.name || e.message || '')) return;
          setError('Could not render the PDF preview.');
          setLoading(false);
        }
      }
    }

    render();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch (_e) { /* */ } }
    };
  }, [src, scale, onSize]);

  return (
    <div className="relative inline-block">
      <canvas ref={canvasRef} className="block shadow-sm border border-gray-200" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">
          Rendering preview…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-red-600 bg-red-50/80">
          {error}
        </div>
      )}
    </div>
  );
}

// pdfjs accepts a URL string, a Uint8Array, or { data }. For a base64 data-URL we
// decode to bytes so it works without a network fetch; otherwise pass the URL and
// let pdfjs fetch it (same-origin proxy / S3 public URL).
function toSource(src) {
  if (typeof src === 'string' && src.startsWith('data:')) {
    const comma = src.indexOf(',');
    const b64 = src.slice(comma + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { data: bytes };
  }
  return { url: src, withCredentials: true };
}
