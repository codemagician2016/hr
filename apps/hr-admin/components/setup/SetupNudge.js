'use client';

// SetupNudge — a small, bottom-right reminder for a workspace that is still
// being set up. Mounted once by AdminShell so it survives route changes.
//
// It is NOT a modal: it never traps focus, never steals focus, never blocks the
// page, and /setup is never force-opened on login (owner decision 3 — setup
// gating is advisory). It appears 1200ms after the shell paints so it can't
// fight first render.
//
// The hard rule this component exists to honour: it must never become
// annoying. Every one of these is a stop condition —
//   • the operator dismissed it → gone for good (persisted per user+tenant),
//   • setup is complete → gone, regardless of dismissal state,
//   • already shown today → not again until tomorrow,
//   • shown 5 times in this operator's lifetime → never again,
//   • the workspace is older than 90 days → the moment for a nudge has passed,
//   • the same prompt is already on screen — /setup, or the dashboard where
//     SetupWidget shows the identical percentage and button → not now,
//   • a modal is open → not now.
// There are no email nudges anywhere in this feature (owner decision 4).

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSetup, stepHref } from '@/lib/setup';
import { useSetupIdentity, readSetupPrefs, writeSetupPrefs, mirrorUiState, MUTED } from '@/components/setup/SetupWidget';

const APPEAR_DELAY_MS = 1200;
const MAX_LIFETIME_SHOWS = 5;
const MAX_TENANT_AGE_DAYS = 90;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function prefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Anything modal on screen owns the user's attention; queue behind it rather
// than stacking a second thing to dismiss.
function modalIsOpen() {
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('[role="dialog"], [aria-modal="true"]');
}

export default function SetupNudge() {
  const setup = useSetup();
  const data = setup.data;
  const pathname = usePathname() || '/';

  const identity = useSetupIdentity();
  const [prefs, setPrefs] = useState(null); // null = localStorage not read yet
  const [phase, setPhase] = useState('idle'); // idle | shown | closed
  const [entered, setEntered] = useState(false);
  const cardRef = useRef(null);

  useEffect(() => {
    if (!identity) return;
    setPrefs(readSetupPrefs('nudge', identity));
  }, [identity]);

  const percent = Number.isFinite(Number(data?.percent)) ? Math.round(Number(data.percent)) : null;
  const step = data?.nextAction && data.nextAction.locked !== true ? data.nextAction : null;
  // Suppress wherever the same nudge is already on screen in another form: the
  // Setup page itself, and the dashboard, where SetupWidget (app/page.js) already
  // shows the identical percentage and next-action button. Two cards side by side
  // asking for the same click reads as a bug, not as encouragement.
  const nudgeRedundantHere = pathname === '/setup' || pathname.startsWith('/setup/') || pathname === '/';

  // Tenant age gate. `tenantAgeDays` is the payload's only tenant-level age
  // signal (setupChecklist.controller derives it from Business.createdAt for
  // exactly this check); when it is null — a business row with no createdAt —
  // we FAIL OPEN rather than suppress the nudge for everyone, since the
  // dismissal, per-day and lifetime caps above already bound how often anyone
  // can see it.
  const tenantIsNew = Number.isFinite(data?.tenantAgeDays)
    ? data.tenantAgeDays <= MAX_TENANT_AGE_DAYS
    : true;

  // Same rule as the widget: a 403/401 from the checklist means this operator
  // is no longer entitled to it, so the cached copy must not be shown back.
  const forbidden = setup.error?.status === 403 || setup.error?.status === 401;

  const eligible =
    !!data
    && !forbidden
    && percent != null
    && data.allComplete !== true
    && !!step
    && prefs != null
    && !prefs.dismissedAt
    && (Number(prefs.shownCount) || 0) < MAX_LIFETIME_SHOWS
    && prefs.lastShownDay !== todayKey()
    && tenantIsNew
    && !nudgeRedundantHere;

  // Delayed reveal. Re-checked at fire time so a modal opened during the delay,
  // or a step completed in that second, still suppresses it.
  useEffect(() => {
    if (phase !== 'idle' || !eligible) return undefined;
    const t = setTimeout(() => {
      if (modalIsOpen()) return; // stay 'idle' — the next mount/route may qualify
      setPhase('shown');
      setPrefs(writeSetupPrefs('nudge', identity, {
        shownCount: (Number(prefs?.shownCount) || 0) + 1,
        lastShownDay: todayKey(),
        lastShownAt: new Date().toISOString(),
      }));
    }, APPEAR_DELAY_MS);
    return () => clearTimeout(t);
  }, [phase, eligible, identity, prefs]);

  // Slide-in only for people who want motion.
  useEffect(() => {
    if (phase !== 'shown') return undefined;
    if (prefersReducedMotion()) { setEntered(true); return undefined; }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  /** Close for today only — incidental (Esc, a click elsewhere, navigating to /setup). */
  const snooze = useCallback(() => {
    setPhase('closed');
  }, []);

  /** Explicit dismissal — this one is permanent, on this device and on the server. */
  const dismissForever = useCallback(() => {
    setPhase('closed');
    setPrefs(writeSetupPrefs('nudge', identity, { dismissedAt: new Date().toISOString() }));
    mirrorUiState(setup.setUiState, { nudgeDismissed: true });
  }, [identity, setup.setUiState]);

  // Esc closes it without touching focus (we never took focus to return).
  useEffect(() => {
    if (phase !== 'shown') return undefined;
    const onKey = (e) => { if (e.key === 'Escape') snooze(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, snooze]);

  // A click anywhere else means "I'm busy" — close, but don't punish an
  // accidental click by never showing this again.
  useEffect(() => {
    if (phase !== 'shown') return undefined;
    const onDown = (e) => { if (cardRef.current && !cardRef.current.contains(e.target)) snooze(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [phase, snooze]);

  // Reaching the guide (or finishing setup) makes the reminder redundant.
  useEffect(() => {
    if (phase === 'shown' && (nudgeRedundantHere || data?.allComplete === true)) setPhase('closed');
  }, [phase, nudgeRedundantHere, data]);

  if (phase !== 'shown' || !step) return null;

  return (
    <div
      ref={cardRef}
      role="status"
      aria-labelledby="setup-nudge-title"
      className="fixed bottom-4 right-4 z-30 w-[360px] max-w-[calc(100vw-2rem)] rounded-2xl border bg-white p-4 shadow-lg"
      style={{
        borderColor: 'var(--theme-border)',
        opacity: entered ? 1 : 0,
        transform: entered ? 'none' : 'translateY(8px)',
        transition: 'opacity .2s ease, transform .2s ease',
      }}
    >
      {/* Dismiss sits FIRST in DOM order so a keyboard user meets the way out
          before the call to action. */}
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={dismissForever}
          aria-label="Dismiss setup reminder"
          title="Don't show this again"
          className="order-2 -mr-1.5 -mt-1.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base leading-none"
          style={{ color: MUTED }}
        >
          <span aria-hidden="true">×</span>
        </button>
        <div className="order-1 min-w-0">
          <div id="setup-nudge-title" className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-primary)' }}>
            Finish setting up
          </div>
          <p className="mt-1 text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
            {/* A degraded probe run can only under-count, so hedge rather than claim. */}
            You&apos;re {data.probeDegraded ? 'at least ' : ''}{percent}% set up.
          </p>
          <p className="mt-0.5 text-sm" style={{ color: MUTED }}>
            Next: {step.label}.
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <Link
          href={stepHref(step)}
          onClick={snooze}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold"
          style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
        >
          {step.cta || 'Set up'} <span aria-hidden="true">→</span>
        </Link>
        {/* Honest label: this really is permanent, so it must not say "Later". */}
        <button type="button" onClick={dismissForever} className="min-h-[28px] rounded px-1 text-xs font-medium" style={{ color: MUTED }}>
          Don&apos;t show again
        </button>
      </div>
    </div>
  );
}
