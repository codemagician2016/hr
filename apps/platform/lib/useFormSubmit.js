'use client';

// Cleanup #6 — collapse the CRUD form submit dance.
//
// Every form panel reimplements:
//
//    const [busy, setBusy] = useState(false);
//    const [error, setError] = useState('');
//    async function submit(e) {
//      e.preventDefault();
//      setBusy(true); setError('');
//      try {
//        await save(form);
//        onSuccess();
//      } catch (err) { setError(err.message); }
//      finally { setBusy(false); }
//    }
//
// Replace with:
//
//    const { submit, busy, error, setError } = useFormSubmit({
//      save: async () => api(...),
//      onSuccess: () => onSaved(),
//    });
//    return <form onSubmit={submit}>...</form>;
//
// Why this and not just <form onSubmit={async (e) => …}> directly?
//   1. Centralises the busy + error state so the disabled-button +
//      error-banner UI is consistent.
//   2. Catches the error from `save` and exposes it as a string so
//      the caller can pop it into <ErrorBanner /> without writing the
//      .message extraction every time.
//   3. The `onSuccess` callback fires only when save resolves, never
//      when it throws — easy to get wrong with manual try/catch.

import { useCallback, useState } from 'react';

export function useFormSubmit({ save, onSuccess, onError } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = useCallback(async (eventOrPayload) => {
    // Accept either a plain payload (when callers compute their own
    // form object before calling submit) OR a SubmitEvent (when the
    // hook is wired straight to <form onSubmit>). Detect by looking
    // for preventDefault.
    if (eventOrPayload && typeof eventOrPayload.preventDefault === 'function') {
      eventOrPayload.preventDefault();
    }
    setBusy(true);
    setError('');
    try {
      const result = await save?.(eventOrPayload);
      onSuccess?.(result);
      return { ok: true, result };
    } catch (err) {
      const message = err?.message || 'Save failed';
      setError(message);
      onError?.(err);
      return { ok: false, error: err };
    } finally {
      setBusy(false);
    }
  }, [save, onSuccess, onError]);

  return { submit, busy, error, setError };
}
