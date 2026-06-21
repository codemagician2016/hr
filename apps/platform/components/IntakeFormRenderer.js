'use client';

// Customer-facing intake form renderer. Loads a form from
// /api/intake-forms/public/:formId and renders fields with conditional
// show/hide. Submits to /api/intake-submissions on completion.
//
// Embeddable in the booking flow OR standalone (e.g. from a customer
// portal "Forms to fill" list).

import { useState, useEffect, useCallback, useRef } from 'react';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.errors = body.errors || [];
    throw err;
  }
  return body;
}

// Conditional show/hide — mirror of backend lib/intakeForms.js
function shouldShow(field, answers) {
  if (!field?.showIf) return true;
  const { fieldId, operator, value } = field.showIf;
  const a = answers?.[fieldId];
  switch (operator) {
    case 'equals':    return a === value;
    case 'notEquals': return a !== value;
    case 'contains':  return Array.isArray(a) ? a.includes(value) : String(a || '').includes(String(value));
    case 'notEmpty':  return a != null && a !== '' && (!Array.isArray(a) || a.length > 0);
    default:          return true;
  }
}

function SignatureCanvas({ value, onChange }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  // Restore prior signature on mount (e.g. customer navigates back)
  useEffect(() => {
    if (!value || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0);
    img.src = value;
  }, []);

  function getPos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const t = e.touches?.[0];
    const cx = t ? t.clientX : e.clientX;
    const cy = t ? t.clientY : e.clientY;
    return { x: cx - rect.left, y: cy - rect.top };
  }
  function start(e) {
    e.preventDefault();
    drawingRef.current = true;
    lastPosRef.current = getPos(e);
  }
  function draw(e) {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const cur = getPos(e);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    ctx.lineTo(cur.x, cur.y);
    ctx.stroke();
    lastPosRef.current = cur;
  }
  function end() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    onChange(canvasRef.current.toDataURL('image/png'));
  }
  function clear() {
    const ctx = canvasRef.current.getContext('2d');
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    onChange('');
  }
  return (
    <div className="border border-gray-300 rounded-lg overflow-hidden bg-white">
      <canvas
        ref={canvasRef}
        width={500}
        height={150}
        className="w-full block touch-none cursor-crosshair"
        onMouseDown={start}
        onMouseMove={draw}
        onMouseUp={end}
        onMouseLeave={end}
        onTouchStart={start}
        onTouchMove={draw}
        onTouchEnd={end}
      />
      <div className="flex justify-between items-center px-3 py-1.5 border-t border-gray-200 bg-gray-50">
        <p className="text-xs text-gray-500">Sign with your mouse or finger</p>
        <button type="button" onClick={clear} className="text-xs text-rose-600 hover:text-rose-800">
          Clear
        </button>
      </div>
    </div>
  );
}

function Field({ field, value, onChange }) {
  const id = `intake-${field.id}`;
  const labelEl = field.type !== 'markdown' ? (
    <label htmlFor={id} className="block text-sm font-medium text-gray-900 mb-1.5">
      {field.label}
      {field.required && <span className="text-rose-500 ml-0.5">*</span>}
    </label>
  ) : null;
  const helpEl = field.helpText ? <p className="text-xs text-gray-500 mt-1">{field.helpText}</p> : null;

  switch (field.type) {
    case 'text':
    case 'email':
    case 'phone':
      return (
        <div>
          {labelEl}
          <input
            id={id}
            type={field.type}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {helpEl}
        </div>
      );
    case 'textarea':
      return (
        <div>
          {labelEl}
          <textarea
            id={id}
            rows={4}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {helpEl}
        </div>
      );
    case 'number':
      return (
        <div>
          {labelEl}
          <input
            id={id}
            type="number"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {helpEl}
        </div>
      );
    case 'date':
      return (
        <div>
          {labelEl}
          <input
            id={id}
            type="date"
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          {helpEl}
        </div>
      );
    case 'select':
      return (
        <div>
          {labelEl}
          <select
            id={id}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
          >
            <option value="">— select —</option>
            {(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          {helpEl}
        </div>
      );
    case 'radio':
      return (
        <div>
          {labelEl}
          <div className="space-y-1.5">
            {(field.options || []).map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name={id}
                  value={o}
                  checked={value === o}
                  onChange={() => onChange(o)}
                  className="w-4 h-4 accent-indigo-600"
                />
                {o}
              </label>
            ))}
          </div>
          {helpEl}
        </div>
      );
    case 'checkbox': {
      const arr = Array.isArray(value) ? value : [];
      return (
        <div>
          {labelEl}
          <div className="space-y-1.5">
            {(field.options || []).map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={arr.includes(o)}
                  onChange={(e) => {
                    if (e.target.checked) onChange([...arr, o]);
                    else onChange(arr.filter((x) => x !== o));
                  }}
                  className="w-4 h-4 rounded accent-indigo-600"
                />
                {o}
              </label>
            ))}
          </div>
          {helpEl}
        </div>
      );
    }
    case 'file':
      return (
        <div>
          {labelEl}
          <input
            id={id}
            type="file"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const fd = new FormData();
              fd.append('file', file);
              try {
                const res = await fetch('/api/upload/image', { method: 'POST', credentials: 'include', body: fd });
                const data = await res.json();
                if (data.url) onChange(data.url);
              } catch {
                /* upload failure left to backend submission validation */
              }
            }}
            className="w-full text-sm"
          />
          {value && <p className="text-xs text-emerald-600 mt-1">Uploaded ✓</p>}
          {helpEl}
        </div>
      );
    case 'signature':
      return (
        <div>
          {labelEl}
          <SignatureCanvas value={value} onChange={onChange} />
          {helpEl}
        </div>
      );
    case 'markdown':
      return (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p className="text-sm text-gray-700 whitespace-pre-wrap">{field.label}</p>
        </div>
      );
    default:
      return null;
  }
}

export default function IntakeFormRenderer({ formId, onSubmitted, prefilledAnswers, appointmentId, customerEmail, customerName }) {
  const [form, setForm] = useState(null);
  const [answers, setAnswers] = useState(prefilledAnswers || {});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const d = await api(`/api/intake-forms/public/${formId}`);
      setForm(d);
    } catch (err) {
      setError(err.message);
    } finally { setLoading(false); }
  }, [formId]);

  useEffect(() => { if (formId) load(); }, [formId, load]);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true); setError(''); setFieldErrors({});
    try {
      await api('/api/intake-submissions', {
        method: 'POST',
        body: JSON.stringify({
          formId,
          appointmentId,
          customerEmail,
          customerName,
          answers,
        }),
      });
      setSubmitted(true);
      onSubmitted?.();
    } catch (err) {
      if (Array.isArray(err.errors) && err.errors.length) {
        const map = {};
        for (const e of err.errors) map[e.fieldId] = e.message;
        setFieldErrors(map);
      } else {
        setError(err.message);
      }
    } finally { setSubmitting(false); }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading form…</p>;
  if (!form) return <p className="text-sm text-rose-600">{error || 'Form not available'}</p>;
  if (submitted) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-5 text-center">
        <p className="text-emerald-900 font-semibold">Thanks — we got your form ✓</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">{form.name}</h2>
        {form.description && <p className="text-sm text-gray-500 mt-1">{form.description}</p>}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}

      {(form.fields || []).map((f) => {
        if (!shouldShow(f, answers)) return null;
        return (
          <div key={f.id}>
            <Field
              field={f}
              value={answers[f.id]}
              onChange={(v) => setAnswers((a) => ({ ...a, [f.id]: v }))}
            />
            {fieldErrors[f.id] && (
              <p className="text-xs text-rose-600 mt-1">{fieldErrors[f.id]}</p>
            )}
          </div>
        );
      })}

      <button
        type="submit"
        disabled={submitting}
        className="px-5 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Submit'}
      </button>
    </form>
  );
}
