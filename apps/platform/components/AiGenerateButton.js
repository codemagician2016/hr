'use client';

// Reusable "Generate with AI" action. Renders nothing unless `available` is
// true (gate it with useAiStatus() in the parent so a panel only probes the
// status once). On click it POSTs to /api/ai/generate-content and hands the
// parsed result object to onResult; the caller decides which fields to apply.
//
// Props:
//   available      — from useAiStatus(); the button is hidden when false
//   type           — 'product_description' | 'seo_meta' | 'blog_outline'
//   getInput       — () => ({...})  per-request input, read fresh on click
//   onResult       — (result) => void  the generated object (already parsed)
//   label          — button text (default 'Generate with AI')
//   locale         — optional language/locale hint passed to the model
//   disabledReason — non-empty disables the button and shows the reason on hover

import { useState } from 'react';
import { api } from '@/lib/adminApi';

export default function AiGenerateButton({
  available,
  type,
  getInput,
  onResult,
  label = 'Generate with AI',
  locale,
  disabledReason = '',
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!available) return null;

  async function run() {
    if (busy || disabledReason) return;
    setBusy(true);
    setError('');
    try {
      const body = { type, input: (getInput && getInput()) || {} };
      if (locale) body.locale = locale;
      const res = await api('/api/ai/generate-content', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      onResult?.(res.result);
    } catch (err) {
      setError(err?.data?.message || err.message || 'Generation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy || !!disabledReason}
        title={disabledReason || undefined}
        className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 transition-colors hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span aria-hidden>{busy ? '✦' : '✨'}</span>
        {busy ? 'Generating…' : label}
      </button>
      {error && <span className="text-[11px] font-medium text-red-600">{error}</span>}
    </span>
  );
}
