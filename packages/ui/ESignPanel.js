'use client';

// ESignPanel — the built-in e-sign signing surface (Feature 4 §5.1, §6, slice
// 4d). Renders the document to sign, lets the signer DRAW (canvas) or TYPE a
// signature, requires an explicit consent checkbox, and submits. After signing it
// shows a read-only "Signed on …" banner.
//
// Transport-agnostic: the page passes a loaded `payload` (from GET
// /api/hr/esign/sign/:token) and an `onSubmit({ signatureImageDataUrl, consent })`
// that POSTs to /sign/:token. The panel owns ONLY the capture + consent UX.

import { useEffect, useRef, useState } from 'react';

// Render a typed signature to a small canvas → PNG data URL (so typed + drawn
// both submit the same signatureImageDataUrl artifact the server stores).
function typedSignatureDataUrl(text) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 400; canvas.height = 120;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111827';
  ctx.font = 'italic 40px "Segoe Script", "Brush Script MT", cursive';
  ctx.textBaseline = 'middle';
  ctx.fillText(text || '', 16, 64);
  return canvas.toDataURL('image/png');
}

function DrawPad({ onChange }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#111827'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  }, []);

  function pos(e) {
    const canvas = ref.current;
    const rect = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - rect.left) * (canvas.width / rect.width), y: (t.clientY - rect.top) * (canvas.height / rect.height) };
  }
  function start(e) { e.preventDefault(); drawing.current = true; last.current = pos(e); }
  function move(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = ref.current.getContext('2d');
    const p = pos(e);
    ctx.beginPath(); ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last.current = p;
  }
  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    if (onChange) onChange(ref.current.toDataURL('image/png'));
  }
  function clear() {
    const ctx = ref.current.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, ref.current.width, ref.current.height);
    if (onChange) onChange(null);
  }

  return (
    <div>
      <canvas
        ref={ref}
        width={400}
        height={120}
        className="w-full rounded-lg border border-gray-300 bg-white touch-none"
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
      />
      <button type="button" onClick={clear} className="mt-1 text-xs text-gray-500 hover:text-gray-700">Clear</button>
    </div>
  );
}

function DocumentView({ document }) {
  if (!document) {
    return <div className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">Document preview unavailable.</div>;
  }
  if (document.isTemplate) {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800">
        <p className="mb-2 font-semibold">{document.name}</p>
        <pre className="whitespace-pre-wrap font-sans text-xs text-gray-700">{document.bodyMarkdown}</pre>
      </div>
    );
  }
  const isPdf = (document.mimeType || '').includes('pdf');
  if (isPdf) {
    return <iframe title={document.name || 'Document'} src={document.fileUrl} className="h-72 w-full rounded-lg border border-gray-200" />;
  }
  return <img src={document.fileUrl} alt={document.name || 'Document'} className="max-h-72 w-full rounded-lg border border-gray-200 object-contain" />;
}

export function ESignPanel({ payload, onSubmit, busy = false }) {
  const [mode, setMode] = useState('draw'); // 'draw' | 'type'
  const [typed, setTyped] = useState('');
  const [drawn, setDrawn] = useState(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');

  if (!payload) return null;
  const { envelope, signer, document, myTurn, alreadySigned } = payload;

  if (alreadySigned || (signer && signer.status === 'SIGNED')) {
    return (
      <div className="rounded-xl border p-4 text-center" style={{ borderColor: '#059669' }}>
        <p className="text-base font-semibold" style={{ color: '#059669' }}>Signed</p>
        <p className="mt-1 text-sm text-gray-500">
          {signer?.signedAt ? `Signed on ${new Date(signer.signedAt).toLocaleString()}` : 'This document has been signed.'}
        </p>
      </div>
    );
  }

  if (envelope && (envelope.status === 'VOIDED' || envelope.status === 'DECLINED' || envelope.status === 'EXPIRED')) {
    return <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">This document is {envelope.status.toLowerCase()} and can no longer be signed.</div>;
  }

  if (!myTurn) {
    return <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">It is not your turn to sign yet — we are waiting for an earlier signer.</div>;
  }

  async function submit() {
    setError('');
    const signatureImageDataUrl = mode === 'type' ? typedSignatureDataUrl(typed) : drawn;
    if (!signatureImageDataUrl || (mode === 'type' && !typed.trim())) {
      setError('Please draw or type your signature.');
      return;
    }
    if (!consent) { setError('You must agree to sign electronically.'); return; }
    if (onSubmit) await onSubmit({ signatureImageDataUrl, consent: true });
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{envelope?.subject || 'Please review and sign'}</h3>
        <DocumentView document={document} />
      </div>

      <div>
        <div className="mb-2 flex gap-2 text-xs">
          <button type="button" onClick={() => setMode('draw')} className={`rounded-md px-3 py-1 ${mode === 'draw' ? 'bg-gray-900 text-white' : 'border border-gray-300 text-gray-600'}`}>Draw</button>
          <button type="button" onClick={() => setMode('type')} className={`rounded-md px-3 py-1 ${mode === 'type' ? 'bg-gray-900 text-white' : 'border border-gray-300 text-gray-600'}`}>Type</button>
        </div>
        {mode === 'draw' ? (
          <DrawPad onChange={setDrawn} />
        ) : (
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type your full name"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-2xl italic"
            style={{ fontFamily: '"Segoe Script","Brush Script MT",cursive' }}
          />
        )}
      </div>

      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
        <span>I have read the document and agree to sign it electronically. I understand this electronic signature is legally binding.</span>
      </label>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={busy || !consent}
        className="w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition disabled:opacity-50"
        style={{ background: 'var(--theme-primary, #4f46e5)' }}
      >
        {busy ? 'Signing…' : 'Sign document'}
      </button>
    </div>
  );
}

export default ESignPanel;
