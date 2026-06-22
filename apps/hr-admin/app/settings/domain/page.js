'use client';

// Settings → Domain (Feature 3 — Self-service Domain & Branding).
//
// Owner-gated console for a tenant's web address. Two ways an employee can
// reach the portal:
//  (1) Subdomain  — {slug}{suffix} on DriftHR (e.g. acme-staging.drifthr.com).
//      We own the zone, so this is self-service: pick a slug, we provision it.
//  (2) Custom domain — bring-your-own (e.g. hr.acme.com). Needs DNS records the
//      admin adds at their registrar; gated on GET /api/business/domain-config
//      (customDomainEnabled) — until the platform flips that flag we show a
//      "coming soon" teaser instead of the connect form.
//
// Server is the enforcement boundary. This screen hides destructive actions and
// shows a read-only banner when the operator lacks `canEditDomain`; the backend
// still rejects the writes (403). Mirrors settings/roles/page.js conventions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Spinner,
  ErrorBanner,
  Modal,
  ModalActions,
  PrimaryButton,
  TextInput,
} from '@hr/ui';
import { get, request } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';

// ─── Small local hooks / helpers (none exist app-wide yet) ───────────────────

// Mirror the backend slugify: lowercase, spaces/underscores→hyphens, strip
// anything that isn't [a-z0-9-], collapse repeats. We DON'T trim leading/
// trailing hyphens on every keystroke (that would fight the user mid-type);
// the live preview shows the normalized value and the server re-normalizes.
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-');
}

// Debounce a value by `delay` ms. Used to throttle slug availability checks.
function useDebouncedValue(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Copy-to-clipboard button with a transient "Copied" confirmation. Keyboard-
// reachable; announces state via aria-live.
function CopyButton({ value, label = 'Copy', className = '' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(String(value || ''));
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API blocked (insecure context) — no-op; value is visible.
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 ${className}`}
      aria-label={copied ? `${label}: copied` : label}
    >
      <span aria-hidden="true">{copied ? '✓' : '⧉'}</span>
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </button>
  );
}

// Poll the custom-domain status until it settles (ACTIVE/FAILED). Pauses while
// the tab is hidden (Page Visibility), re-checks on focus, aborts in-flight
// requests on unmount, and stops once the domain is live or has failed.
function useDomainStatus({ enabled, intervalMs = 20000 }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const abortRef = useRef(null);
  const timerRef = useRef(null);
  const tickRef = useRef(null);

  const settled = (s) => s === 'ACTIVE' || s === 'FAILED' || s === 'NONE';

  const fetchOnce = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const res = await request('/api/subscription/custom-domain/status', {
        method: 'GET',
        signal: ctrl.signal,
      });
      setStatus(res);
      setError('');
      return res;
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      setError(err.data?.message || err.message || 'Could not reach the status service.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Keep the latest fetchOnce in a ref so the interval closure never goes stale.
  tickRef.current = fetchOnce;

  useEffect(() => {
    if (!enabled) return undefined;
    let stopped = false;

    const schedule = () => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(run, intervalMs);
    };
    const run = async () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) {
        schedule(); // paused — re-arm and try again next tick
        return;
      }
      const res = await tickRef.current?.();
      if (stopped) return;
      const s = res?.customDomainStatus;
      if (settled(s)) return; // terminal — stop polling
      schedule();
    };

    const onVisible = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        const s = status?.customDomainStatus;
        if (!settled(s)) run();
      }
    };

    run();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    if (typeof window !== 'undefined') window.addEventListener('focus', onVisible);

    return () => {
      stopped = true;
      clearTimeout(timerRef.current);
      abortRef.current?.abort();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs]);

  return { status, setStatus, error, loading, refresh: fetchOnce };
}

// One-line, non-technical glosses surfaced at first use (tooltips on a help "?").
const GLOSSES = {
  subdomain: 'A web address under DriftHR, like acme.drifthr.com — we set it up instantly, no DNS needed.',
  customDomain: 'Your own address, like hr.acme.com. You add two records at your domain registrar and we verify them.',
  dns: 'DNS is your domain\'s address book. You add records at whoever you bought the domain from (e.g. GoDaddy, Cloudflare).',
  cname: 'A CNAME record points your address at ours, so visitors land on DriftHR.',
  txt: 'A TXT record is a short proof you control the domain — it lets us verify ownership before going live.',
  ssl: 'SSL is the padlock in the browser. We set up the certificate automatically once the records are in place.',
};

function HelpHint({ term }) {
  const text = GLOSSES[term];
  if (!text) return null;
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold text-gray-500 hover:bg-gray-100"
        aria-label={text}
      >
        ?
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-20 w-64 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-xs leading-snug text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

function ReadOnlyBanner() {
  return (
    <p className="mb-5 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
      <span aria-hidden="true">🔒 </span>
      You have read-only access to the web address. Changing the subdomain or connecting a custom domain requires the
      <span className="font-medium"> canEditDomain</span> permission.
    </p>
  );
}

function ExternalLink({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
      style={{ color: 'var(--theme-primary)' }}
    >
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

// ─── AddressCard ─────────────────────────────────────────────────────────────
// Row 1: the live subdomain (always). Row 2: the custom domain, only when it's
// ACTIVE — but we reserve the row's height either way to avoid layout shift.
function AddressCard({ subdomainHost, customDomain, customDomainActive }) {
  const subUrl = `https://${subdomainHost}`;
  const customUrl = customDomain ? `https://${customDomain}` : '';
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5" aria-label="Your portal addresses">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Your portal address</h2>

      {/* Row 1 — live subdomain */}
      <div className="flex flex-wrap items-center gap-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
          Live
        </span>
        <code className="text-sm font-medium text-gray-900 break-all">{subdomainHost}</code>
        <CopyButton value={subdomainHost} />
        <ExternalLink href={subUrl}>Open</ExternalLink>
      </div>

      {/* Row 2 — custom domain (reserve height to avoid layout shift) */}
      <div className="min-h-[2.75rem] flex flex-wrap items-center gap-3 py-2 border-t border-gray-50">
        {customDomainActive && customDomain ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs font-medium text-emerald-700">
              Primary
            </span>
            <code className="text-sm font-medium text-gray-900 break-all">{customDomain}</code>
            <CopyButton value={customDomain} />
            <ExternalLink href={customUrl}>Open</ExternalLink>
          </>
        ) : (
          <span className="text-xs text-gray-400">No custom domain connected yet.</span>
        )}
      </div>
    </section>
  );
}

// ─── SubdomainSection ────────────────────────────────────────────────────────
function SubdomainSection({ currentSlug, suffix, readOnly, onChanged }) {
  const [raw, setRaw] = useState(currentSlug || '');
  const normalized = useMemo(() => slugify(raw), [raw]);
  const debounced = useDebouncedValue(normalized, 400);

  const [check, setCheck] = useState(null); // { available, reason, url, suggestions? }
  const [checking, setChecking] = useState(false);
  const abortRef = useRef(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const isSame = !debounced || debounced === currentSlug;

  // Keep the input in sync if the current slug changes after a successful save.
  useEffect(() => {
    setRaw(currentSlug || '');
    setCheck(null);
  }, [currentSlug]);

  // Debounced, abortable availability check. Stale responses are discarded by
  // tagging each request with the query it was made for.
  useEffect(() => {
    if (readOnly) return undefined;
    if (!debounced || debounced === currentSlug) {
      setCheck(null);
      setChecking(false);
      return undefined;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const forQuery = debounced;
    setChecking(true);
    (async () => {
      try {
        const res = await request(`/api/business/check-slug?slug=${encodeURIComponent(forQuery)}`, {
          method: 'GET',
          signal: ctrl.signal,
        });
        // Guard against a stale resolve overwriting a newer query.
        if (forQuery === slugify(raw)) {
          setCheck(res);
          setChecking(false);
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        if (forQuery === slugify(raw)) {
          setCheck({ available: false, reason: 'invalid' });
          setChecking(false);
        }
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, currentSlug, readOnly]);

  const verdict = useMemo(() => {
    if (isSame) return null;
    if (checking || !check) return null;
    if (check.available) return { tone: 'ok', text: 'Available — this address is free.' };
    if (check.reason === 'reserved')
      return { tone: 'warn', text: 'Reserved — that word is held back. Try one of the suggestions below.' };
    if (check.reason === 'taken') return { tone: 'bad', text: 'Taken — another business already uses this address.' };
    return { tone: 'bad', text: 'Not a valid address — use letters, numbers and hyphens.' };
  }, [check, checking, isSame]);

  const canSubmit = !readOnly && !isSame && check?.available && !submitting;

  async function submit() {
    setSubmitting(true);
    setSubmitError('');
    try {
      const res = await request('/api/business/slug', {
        method: 'PATCH',
        body: JSON.stringify({ slug: normalized }),
      });
      setConfirmOpen(false);
      setSubmitting(false);
      onChanged?.(res?.slug || normalized);
    } catch (err) {
      setSubmitting(false);
      const data = err.data || {};
      if (err.status === 409) {
        setSubmitError('Just taken — someone grabbed that address a moment ago. Pick another.');
      } else if (err.status === 429) {
        const next = data.nextAvailableAt ? new Date(data.nextAvailableAt) : null;
        const days = next ? Math.max(1, Math.ceil((next.getTime() - Date.now()) / 86400000)) : null;
        setSubmitError(
          days
            ? `You can change your address once every 30 days. Next change available in ${days} day${days === 1 ? '' : 's'}.`
            : 'You can change your address once every 30 days. Please try again later.'
        );
      } else {
        setSubmitError(data.message || err.message || 'Could not change the address. Please try again.');
      }
    }
  }

  const toneClass =
    verdict?.tone === 'ok'
      ? 'text-emerald-700'
      : verdict?.tone === 'warn'
      ? 'text-amber-700'
      : verdict?.tone === 'bad'
      ? 'text-red-600'
      : 'text-gray-500';

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-1 inline-flex items-center">
        DriftHR subdomain
        <HelpHint term="subdomain" />
      </h2>
      <p className="text-sm text-gray-500 mb-4">
        Your portal lives here by default. Changing it is instant — no DNS to configure.
      </p>

      <label htmlFor="slug-input" className="block text-sm font-medium text-gray-700 mb-1">
        Address
      </label>
      <div className="flex items-stretch max-w-md">
        <input
          id="slug-input"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          disabled={readOnly}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="slug-preview slug-verdict"
          className="min-w-0 flex-1 rounded-l-lg border border-r-0 border-gray-300 px-4 py-2.5 text-sm focus:outline-none disabled:bg-gray-50 disabled:text-gray-500"
          placeholder="your-company"
        />
        <span className="inline-flex items-center rounded-r-lg border border-l-0 border-gray-300 bg-gray-50 px-3 text-sm text-gray-500">
          {suffix}
        </span>
      </div>

      <p id="slug-preview" className="text-sm text-gray-600 mt-2">
        Your portal will be{' '}
        <span className="font-semibold text-gray-900">
          {normalized || '…'}
          {suffix}
        </span>
      </p>

      <p id="slug-verdict" className={`text-sm mt-1 min-h-[1.25rem] ${toneClass}`} aria-live="polite">
        {readOnly ? '' : checking && !isSame ? 'Checking availability…' : verdict?.text || ''}
      </p>

      {!readOnly && verdict?.tone === 'warn' && Array.isArray(check?.suggestions) && check.suggestions.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Try:</span>
          {check.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setRaw(s)}
              className="rounded-md border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="mt-4">
          <PrimaryButton onClick={() => setConfirmOpen(true)} disabled={!canSubmit}>
            Change address
          </PrimaryButton>
        </div>
      )}

      {confirmOpen && (
        <Modal title="Change your portal address?" onClose={() => (submitting ? null : setConfirmOpen(false))}>
          {submitError && (
            <div className="mb-3">
              <ErrorBanner message={submitError} />
            </div>
          )}
          <p className="text-sm text-gray-600 mb-2">
            Your portal will move to{' '}
            <span className="font-semibold text-gray-900">
              {normalized}
              {suffix}
            </span>
            .
          </p>
          <p className="mb-5 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            Your old address stops working immediately. Anyone with the old link, and any saved bookmarks, will need the
            new one. You can only change this once every 30 days.
          </p>
          <ModalActions>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <PrimaryButton loading={submitting} onClick={submit}>
              Move to {normalized}
              {suffix}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </section>
  );
}

// ─── Custom domain — friendly state copy ─────────────────────────────────────
const STATUS_STEPS = [
  { key: 'PENDING_DNS', label: 'Add records' },
  { key: 'PENDING_SSL', label: 'Secure it' },
  { key: 'ACTIVE', label: 'Live' },
];

function friendlyStatus(status) {
  switch (status) {
    case 'PENDING_DNS':
      return { tone: 'wait', text: 'We don\'t see the records yet — that\'s normal. They can take a little while to spread.' };
    case 'PENDING_SSL':
      return { tone: 'wait', text: 'Records found. We\'re setting up the secure padlock now — this is automatic.' };
    case 'ACTIVE':
      return { tone: 'ok', text: 'Connected and secured.' };
    case 'FAILED':
      return { tone: 'bad', text: 'We couldn\'t finish connecting this domain. Double-check the records, then try again.' };
    default:
      return { tone: 'wait', text: 'Getting started…' };
  }
}

// CNAME + TXT records the admin pastes at their registrar, each copyable.
function DnsRecordsPanel({ dns, instructions }) {
  const records = Array.isArray(dns) ? dns : dns ? [dns] : [];
  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
      <h4 className="text-sm font-semibold text-gray-900 mb-1">Add these at your domain registrar</h4>
      <p className="text-xs text-gray-500 mb-3">
        Open your DNS settings
        <HelpHint term="dns" /> (wherever you bought the domain) and add each record exactly as shown.
      </p>
      {instructions && <p className="text-xs text-gray-600 mb-3">{instructions}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
              <th scope="col" className="px-2 py-2 font-medium">Type</th>
              <th scope="col" className="px-2 py-2 font-medium">Name / Host</th>
              <th scope="col" className="px-2 py-2 font-medium">Value</th>
              <th scope="col" className="px-2 py-2 font-medium sr-only">Copy</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => {
              const type = r.type || r.recordType || 'CNAME';
              const name = r.name || r.host || '@';
              const value = r.value || r.content || r.target || '';
              return (
                <tr key={`${type}-${name}-${i}`} className="border-b border-gray-100 last:border-0 align-top">
                  <td className="px-2 py-2">
                    <span className="inline-flex items-center font-mono text-xs font-semibold text-gray-800">
                      {type}
                      <HelpHint term={String(type).toUpperCase() === 'TXT' ? 'txt' : 'cname'} />
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-gray-700 break-all">{name}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-start gap-2">
                      <code className="font-mono text-xs text-gray-700 break-all">{value}</code>
                      <CopyButton value={value} className="shrink-0" />
                    </div>
                  </td>
                  <td className="px-2 py-2" />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// 3-step PENDING_DNS → PENDING_SSL → ACTIVE timeline. The server's `message`
// is rendered verbatim; our friendly copy is the fallback per step.
function DomainStatusTimeline({ status, domain, message }) {
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  const failed = status === 'FAILED';
  const f = friendlyStatus(status);
  return (
    <div className="mt-4">
      <ol className="flex items-center" aria-label="Connection progress">
        {STATUS_STEPS.map((step, i) => {
          const done = !failed && idx > i;
          const current = !failed && idx === i;
          const state = done ? 'done' : current ? 'current' : 'todo';
          return (
            <li key={step.key} className="flex flex-1 items-center" aria-current={current ? 'step' : undefined}>
              <div className="flex flex-col items-center">
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                    done
                      ? 'bg-emerald-500 text-white'
                      : current
                      ? 'text-white'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                  style={current ? { backgroundColor: 'var(--theme-primary)' } : undefined}
                  aria-hidden="true"
                >
                  {done ? '✓' : i + 1}
                </span>
                <span
                  className={`mt-1 text-[11px] font-medium ${
                    done || current ? 'text-gray-900' : 'text-gray-400'
                  }`}
                >
                  {step.label}
                </span>
                <span className="sr-only">{`${step.label}: ${state}`}</span>
              </div>
              {i < STATUS_STEPS.length - 1 && (
                <span
                  className={`mx-1 h-0.5 flex-1 ${idx > i ? 'bg-emerald-400' : 'bg-gray-200'}`}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-4" aria-live="polite">
        {status === 'ACTIVE' ? (
          <p className="text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            <span aria-hidden="true">🎉 </span>
            {domain} is live.
          </p>
        ) : (
          <p
            className={`text-sm rounded-lg px-3 py-2 ${
              f.tone === 'bad'
                ? 'text-red-700 bg-red-50 border border-red-200'
                : 'text-gray-600 bg-gray-50 border border-gray-200'
            }`}
          >
            {message || f.text}
          </p>
        )}
      </div>
    </div>
  );
}

function ConnectDomainForm({ subdomainSuffix, onConnect }) {
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);

  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // Reject anyone trying to "connect" a DriftHR subdomain here.
  const isDriftHr = /\.drifthr\.com$/i.test(clean) || (subdomainSuffix && clean.endsWith(String(subdomainSuffix).replace(/^\./, '')));

  async function connect(forceTransfer = false) {
    setBusy(true);
    setError('');
    setSuggestion('');
    try {
      await request('/api/subscription/custom-domain', {
        method: 'PUT',
        body: JSON.stringify(forceTransfer ? { domain: clean, forceTransfer: true } : { domain: clean }),
      });
      setTransferOpen(false);
      setBusy(false);
      onConnect?.(clean);
    } catch (err) {
      setBusy(false);
      const data = err.data || {};
      if (err.status === 409 && (data.reason === 'IN_USE' || data.code === 'IN_USE' || /in use/i.test(data.message || ''))) {
        setTransferOpen(true);
        return;
      }
      if (err.status === 422 && data.suggestion) {
        setSuggestion(data.suggestion);
        setError(`That looks like a root domain. Most people connect a subdomain instead, like ${data.suggestion}.`);
        return;
      }
      setError(data.message || err.message || 'Could not connect that domain. Please check it and try again.');
    }
  }

  return (
    <div>
      <label htmlFor="custom-domain-input" className="block text-sm font-medium text-gray-700 mb-1">
        Your domain
      </label>
      <div className="flex flex-col sm:flex-row gap-2 max-w-xl">
        <input
          id="custom-domain-input"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="hr.yourcompany.com"
          className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm focus:outline-none"
          aria-describedby="custom-domain-help"
        />
        <PrimaryButton loading={busy} onClick={() => connect(false)} disabled={!clean || isDriftHr}>
          Connect domain
        </PrimaryButton>
      </div>

      {isDriftHr && clean && (
        <p className="text-sm text-red-600 mt-2">
          That&apos;s a DriftHR address — to change it, use the <span className="font-medium">DriftHR subdomain</span> section
          above.
        </p>
      )}
      {error && !isDriftHr && (
        <p className="text-sm text-red-600 mt-2">
          {error}
          {suggestion && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => setDomain(suggestion)}
                className="font-medium underline"
              >
                Use {suggestion}
              </button>
            </>
          )}
        </p>
      )}
      <p id="custom-domain-help" className="text-xs text-gray-500 mt-2">
        Use a subdomain like <code className="font-mono">hr.yourcompany.com</code>. After connecting, you&apos;ll add a couple
        of DNS records to verify it.
      </p>

      {transferOpen && (
        <Modal title="This domain is already connected" onClose={() => (busy ? null : setTransferOpen(false))}>
          <p className="text-sm text-gray-600 mb-5">
            <code className="font-mono">{clean}</code> is in use on another DriftHR account. If you own it, you can move it
            here — it will stop working on the other account.
          </p>
          <ModalActions>
            <button
              type="button"
              onClick={() => setTransferOpen(false)}
              disabled={busy}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <PrimaryButton loading={busy} onClick={() => connect(true)}>
              Move it here
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  );
}

function CustomDomainSection({ enabled, subdomainSuffix, readOnly }) {
  const { status, setStatus, error, loading, refresh } = useDomainStatus({ enabled: enabled && !readOnly });
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [verifying, setVerifying] = useState(false);

  const s = status?.customDomainStatus || 'NONE';
  const domain = status?.customDomain || '';
  const connected = s !== 'NONE' && !!domain;

  async function verifyNow() {
    setVerifying(true);
    setActionError('');
    try {
      await request('/api/subscription/custom-domain/verify', { method: 'POST' });
      await refresh();
    } catch (err) {
      setActionError(err.data?.message || err.message || 'Could not re-check just now. Please try again shortly.');
    } finally {
      setVerifying(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    setActionError('');
    try {
      await request('/api/subscription/custom-domain', { method: 'DELETE' });
      setDisconnectOpen(false);
      setStatus({ customDomainStatus: 'NONE', customDomain: '' });
    } catch (err) {
      setActionError(err.data?.message || err.message || 'Could not disconnect just now. Please try again.');
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-gray-900 mb-1 inline-flex items-center">
        Custom domain
        <HelpHint term="customDomain" />
      </h2>

      {!enabled ? (
        // Feature-gated off: teaser only, no connect form.
        <div className="mt-1">
          <p className="text-sm text-gray-500">
            Coming soon — bring your own domain (e.g. <code className="font-mono">hr.yourcompany.com</code>) so employees
            sign in on your brand.
          </p>
          <span className="mt-3 inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
            Coming soon
          </span>
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-500 mb-4">
            Use your own web address. You&apos;ll add two DNS records to prove you own it, then we secure it automatically.
          </p>

          {error && (
            <div className="mb-3">
              <ErrorBanner message={error} />
            </div>
          )}
          {actionError && (
            <div className="mb-3">
              <ErrorBanner message={actionError} />
            </div>
          )}

          {loading && !status ? (
            <Spinner />
          ) : !connected ? (
            readOnly ? (
              <p className="text-sm text-gray-500">No custom domain connected.</p>
            ) : (
              <ConnectDomainForm subdomainSuffix={subdomainSuffix} onConnect={() => refresh()} />
            )
          ) : (
            <div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <code className="text-sm font-medium text-gray-900 break-all">{domain}</code>
                </div>
                {!readOnly && (
                  <div className="flex items-center gap-2">
                    {(s === 'PENDING_DNS' || s === 'PENDING_SSL' || s === 'FAILED') && (
                      <button
                        type="button"
                        onClick={verifyNow}
                        disabled={verifying}
                        className="px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                      >
                        {verifying ? 'Checking…' : s === 'FAILED' ? 'Try again' : 'Check now'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setDisconnectOpen(true)}
                      className="px-3 py-1.5 text-xs font-medium border border-red-300 rounded-lg text-red-700 hover:bg-red-50"
                    >
                      Disconnect
                    </button>
                  </div>
                )}
              </div>

              {/* DNS records (while not yet live) */}
              {s !== 'ACTIVE' && (status?.dns || status?.instructions) && (
                <DnsRecordsPanel dns={status.dns} instructions={status.instructions} />
              )}

              <DomainStatusTimeline status={s} domain={domain} message={status?.message} />

              {status?.suggestion && s !== 'ACTIVE' && (
                <p className="mt-2 text-xs text-gray-500">Suggestion: {status.suggestion}</p>
              )}
            </div>
          )}
        </>
      )}

      {disconnectOpen && (
        <Modal title="Disconnect custom domain?" onClose={() => (disconnecting ? null : setDisconnectOpen(false))}>
          <p className="text-sm text-gray-600 mb-5">
            <code className="font-mono">{domain}</code> will stop pointing to your portal. Employees can still sign in at
            your DriftHR subdomain. You can reconnect it later.
          </p>
          <ModalActions>
            <button
              type="button"
              onClick={() => setDisconnectOpen(false)}
              disabled={disconnecting}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={disconnect}
              disabled={disconnecting}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </ModalActions>
        </Modal>
      )}
    </section>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function DomainSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [business, setBusiness] = useState(null); // { slug, name }
  const [config, setConfig] = useState(null); // { customDomainEnabled, platformDomain, subdomainSuffix, targetCname }
  const [domainStatus, setDomainStatus] = useState(null); // for AddressCard row 2
  const [canEdit, setCanEdit] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [me, cfg, biz] = await Promise.all([
        get('/api/auth/me').catch(() => null),
        get('/api/business/domain-config').catch(() => ({})),
        get('/api/business/me').catch(() => ({})),
      ]);
      const session = me?.user || me;
      setCanEdit(hasPermission(permissionsFromSession(session), 'canEditDomain'));
      setConfig(cfg || {});
      setBusiness(biz || {});
      // For the AddressCard's row-2 (custom domain primary marker).
      const st = await get('/api/subscription/custom-domain/status').catch(() => null);
      setDomainStatus(st);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to load domain settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Resolve the platform/subdomain config with env fallbacks so the live
  // subdomain renders even before the backend endpoint lands.
  const platformDomain =
    config?.platformDomain || process.env.NEXT_PUBLIC_PLATFORM_DOMAIN || 'drifthr.com';
  const suffix = config?.subdomainSuffix || `.${platformDomain}`;
  const slug = business?.slug || '';
  const subdomainHost = `${slug}${suffix}`;
  const customDomainActive = domainStatus?.customDomainStatus === 'ACTIVE';
  const customDomain = domainStatus?.customDomain || '';

  if (loading) return <Spinner />;

  return (
    <div>
      <PageHeader
        title="Domain"
        subtitle="The web address your employees use to sign in"
        actions={
          <Link
            href="/settings"
            className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center"
          >
            ← Settings
          </Link>
        }
      />

      {!canEdit && <ReadOnlyBanner />}
      {error && (
        <div className="mb-5">
          <ErrorBanner message={error} />
        </div>
      )}

      {/* Explainer: subdomain vs custom domain, for a non-technical HR admin. */}
      <div className="mb-5 rounded-2xl border border-gray-200 bg-gray-50/60 p-4 text-sm text-gray-600">
        <p className="font-medium text-gray-900 mb-1">Two kinds of address</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>
            <span className="font-medium">DriftHR subdomain</span> — e.g.{' '}
            <code className="font-mono">{slug || 'your-company'}{suffix}</code>. Works instantly, nothing to configure.
          </li>
          <li>
            <span className="font-medium">Custom domain</span> — e.g. <code className="font-mono">hr.yourcompany.com</code>.
            Uses your own brand; you add a couple of DNS records to verify it.
          </li>
        </ul>
      </div>

      <div className="space-y-6 max-w-3xl">
        <AddressCard
          subdomainHost={subdomainHost}
          customDomain={customDomain}
          customDomainActive={customDomainActive}
        />

        <SubdomainSection
          currentSlug={slug}
          suffix={suffix}
          readOnly={!canEdit}
          onChanged={() => load()}
        />

        <CustomDomainSection
          enabled={!!config?.customDomainEnabled}
          subdomainSuffix={suffix}
          readOnly={!canEdit}
        />
      </div>
    </div>
  );
}
