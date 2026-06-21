'use client';

// Cleanup #2 — branded confirm dialog. Replaces native browser confirm()
// across the admin (~26 call sites). Same Promise-return shape so callers
// just swap `if (!confirm(msg)) return` → `if (!await confirm(msg)) return`.
//
// Usage:
//   1. Wrap the admin shell in <ConfirmDialogProvider>.
//   2. In any component:
//        const confirm = useConfirm();
//        const ok = await confirm('Delete "Foo"?', { confirmLabel: 'Delete', tone: 'danger' });
//        if (!ok) return;
//
// Options:
//   - title          (string)  — defaults to "Are you sure?"
//   - confirmLabel   (string)  — defaults to "Confirm"
//   - cancelLabel    (string)  — defaults to "Cancel"
//   - tone           ('danger' | 'primary')  — danger paints the confirm
//                                              button red. Default 'primary'.
//
// Accessibility: focuses the cancel button on open, traps Escape (cancels),
// Enter (confirms). Backdrop click cancels.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const ConfirmContext = createContext(null);

export function ConfirmDialogProvider({ children }) {
  // pending = the in-flight prompt; null when no dialog is showing.
  // Stored as { message, options, resolve } so the provider can resolve
  // the Promise the caller is awaiting.
  const [pending, setPending] = useState(null);

  const confirm = useCallback((message, options = {}) => {
    return new Promise((resolve) => {
      setPending({ message, options, resolve });
    });
  }, []);

  function close(value) {
    if (pending) pending.resolve(value);
    setPending(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmModal
          message={pending.message}
          options={pending.options}
          onConfirm={() => close(true)}
          onCancel={() => close(false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    // Safety net: if the provider isn't mounted (stray component, tests),
    // fall back to the native confirm so callers never crash. Logs once
    // so we notice in dev.
    if (typeof window !== 'undefined' && !window.__sp_confirm_fallback_warned) {
      // eslint-disable-next-line no-console
      console.warn('[useConfirm] ConfirmDialogProvider not mounted; falling back to window.confirm.');
      window.__sp_confirm_fallback_warned = true;
    }
    return (msg) => Promise.resolve(typeof window === 'undefined' ? false : window.confirm(msg));
  }
  return ctx;
}

function ConfirmModal({ message, options, onConfirm, onCancel }) {
  const {
    title = 'Are you sure?',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    tone = 'primary',
  } = options;

  const cancelBtnRef = useRef(null);
  useEffect(() => {
    cancelBtnRef.current?.focus();
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      if (e.key === 'Enter')  { e.preventDefault(); onConfirm(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  const confirmClasses = tone === 'danger'
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-indigo-600 hover:bg-indigo-700';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sp-confirm-title"
    >
      <div
        className="w-full max-w-md rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-gray-200 px-5 py-3">
          <h3 id="sp-confirm-title" className="text-base font-semibold text-gray-900">{title}</h3>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm leading-relaxed text-gray-700 whitespace-pre-line">{message}</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium text-white ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
