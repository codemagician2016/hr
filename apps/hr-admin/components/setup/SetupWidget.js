'use client';

// SetupWidget — the dashboard's setup progress card: one percentage, one next
// action, one link into the full guide. It sits above the headcount tiles and
// is deliberately capped at ~96px so the real dashboard never drops below the
// fold; the guide's job here is to remind, not to teach (that is /setup).
//
// It reads the SAME payload as the /setup page, the nav badge and the nudge,
// through lib/setup's shared store — one GET /api/hr/setup-checklist per shell
// mount however many surfaces subscribe, so they can never disagree about the
// percentage or about which step is next, and never fetch it four times.
//
// Disappearance rules (owner decision 3 — gating is advisory, never nagging):
//   • gone permanently once the TENANT is at 100%, with no fanfare here — the
//     celebration belongs on /setup where the work happened,
//   • gone while the operator has hidden it ("Hide for now" = 7 days, not a
//     permanent dismissal, because setup is the thing we want finished),
//   • gone for anyone the endpoint 403s (it is requirePermission
//     ('canManageCompanyProfile')) — no data, nothing renders,
//   • gone when every probe failed (percent null): we would rather show
//     nothing than a fabricated 0%.
// It comes BACK, with a "New setup step" eyebrow, when the denominator grows
// (an add-on bought, a second entity created) — otherwise a hidden widget
// would silently swallow newly-relevant work.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { get } from '@/lib/api';
import { useSetup, setupFullyComplete, stepHref } from '@/lib/setup';

const HIDE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── contrast-safe local tokens (exported: the nudge uses the same ones) ──────
// --theme-muted is the tenant text colour at 60% alpha, which lands ~4.2:1 on
// a white card — under WCAG AA for the 11–13px type these two surfaces are
// built from, so their secondary text uses a stronger mix instead.
// The progress FILL is --theme-primary-dark, not --theme-primary: a mid-
// luminance brand colour cannot reach 3:1 against ANY light track (teal tops
// out near 2.5:1 even against pure white), while the darker variant clears it.
export const MUTED = 'color-mix(in srgb, var(--theme-text) 78%, transparent)';
export const TRACK = 'color-mix(in srgb, var(--theme-text) 7%, var(--theme-surface))';
export const FILL = 'var(--theme-primary-dark)';

// ── per user+tenant UI bookkeeping (shared with SetupNudge) ──────────────────
// The widget and the post-login nudge each remember a little state that must
// never leak between two operators who share a browser, so every key is scoped
// by businessId AND userId. The server mirrors the same facts in
// Business.setupState.ui[userId] so they follow a person across devices;
// localStorage is the LOCAL authority so both surfaces still behave correctly
// when that write fails, when the payload omits the mirror, or offline.
// These helpers live here (rather than a lib/) because this track owns no
// shared module — one implementation, imported by SetupNudge.

/** Resolve { businessId, userId } for localStorage scoping. Null until read. */
export function useSetupIdentity() {
  const [identity, setIdentity] = useState(null);

  useEffect(() => {
    let alive = true;
    // /api/auth/me is on lib/api's cacheable allowlist, so this reuses the
    // response AdminShell already fetched — no extra round-trip.
    get('/api/auth/me')
      .then((r) => {
        if (alive) setIdentity({ businessId: r?.user?.businessId || null, userId: r?.user?.id || null });
      })
      .catch(() => {
        // Unresolvable identity still yields a (shared) key rather than
        // breaking the surface — the session gate above us already 401'd.
        if (alive) setIdentity({ businessId: null, userId: null });
      });
    return () => { alive = false; };
  }, []);

  return identity;
}

function prefsKey(kind, identity) {
  return `drifthr.setup.${kind}.${identity?.businessId || 'anon'}.${identity?.userId || 'anon'}`;
}

/** Read the per-user prefs blob for `kind` ('widget' | 'nudge'). Browser only. */
export function readSetupPrefs(kind, identity) {
  if (!identity || typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(prefsKey(kind, identity));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // private mode / corrupt value → behave as "nothing remembered"
  }
}

/** Merge (never replace) a patch into the prefs blob and return the result. */
export function writeSetupPrefs(kind, identity, patch) {
  const next = { ...readSetupPrefs(kind, identity), ...patch };
  if (!identity || typeof window === 'undefined') return next;
  try {
    window.localStorage.setItem(prefsKey(kind, identity), JSON.stringify(next));
  } catch {
    /* private mode / quota — the in-memory result below still applies for this page */
  }
  return next;
}

/** Best-effort mirror to Business.setupState.ui[userId]; failure is never fatal. */
export function mirrorUiState(setUiState, patch) {
  if (typeof setUiState !== 'function') return;
  try {
    Promise.resolve(setUiState(patch)).catch(() => {});
  } catch {
    /* ignore — localStorage already holds the authoritative local answer */
  }
}

// ── the widget ───────────────────────────────────────────────────────────────

export default function SetupWidget() {
  const setup = useSetup();
  const data = setup.data;

  const identity = useSetupIdentity();
  const [prefs, setPrefs] = useState(null); // null = localStorage not read yet

  useEffect(() => {
    if (!identity) return;
    setPrefs(readSetupPrefs('widget', identity));
  }, [identity]);

  const percent = Number.isFinite(Number(data?.percent)) ? Math.round(Number(data.percent)) : null;
  const total = Number(data?.totalCount) || 0;
  const done = Number(data?.completedCount) || 0;
  const step = data?.nextAction || null;

  // The server mirror (when the payload carries it) acts as a floor on the
  // local hide, so hiding on a laptop also hides on a phone.
  const hiddenUntil = useMemo(() => {
    const local = Number(prefs?.hiddenUntil) || 0;
    const remote = Date.parse(data?.ui?.widgetHiddenUntil || '') || 0;
    return Math.max(local, remote);
  }, [prefs, data]);

  // A grown denominator means work appeared that this operator has never been
  // offered (an add-on bought, a second entity created) — that overrides an
  // active hide, once, with its own eyebrow. LATCHED for the session: the very
  // next thing we do is record the new total, which would otherwise make the
  // widget vanish again mid-look.
  const [newWork, setNewWork] = useState(false);
  useEffect(() => {
    if (!prefs || newWork) return;
    const seen = Number(prefs.seenTotal);
    if (Number.isFinite(seen) && total > seen) setNewWork(true);
  }, [prefs, total, newWork]);

  // The endpoint is requirePermission('canManageCompanyProfile'). If it now
  // refuses this operator, never paint the cached copy from when they still
  // had the key — a revoked permission has to look revoked immediately.
  const forbidden = setup.error?.status === 403 || setup.error?.status === 401;

  const visible =
    !!data
    && !forbidden
    && percent != null
    // Tenant-wide, not this operator's own 100%: a narrowly-permissioned admin
    // can finish every step they can reach while the workspace has not started,
    // and taking the guide off their dashboard would hide that from them. When
    // they genuinely have nothing left, the right-hand column already says so.
    && !setupFullyComplete(data)
    && prefs != null
    && (newWork || hiddenUntil <= Date.now());

  // Record the denominator we have now shown this operator, and drop the hide
  // that the new work overrode. Guarded on a real change so this never loops.
  useEffect(() => {
    if (!visible || !identity || !prefs) return;
    if (Number(prefs.seenTotal) === total) return;
    setPrefs(writeSetupPrefs('widget', identity, { seenTotal: total, ...(newWork ? { hiddenUntil: 0 } : null) }));
  }, [visible, identity, prefs, total, newWork]);

  if (!visible) return null;

  function hideForNow() {
    // Clear the latch too, or the widget would ignore the hide it was just given.
    setNewWork(false);
    setPrefs(writeSetupPrefs('widget', identity, { hiddenUntil: Date.now() + HIDE_DAYS * DAY_MS, seenTotal: total }));
    mirrorUiState(setup.setUiState, { widgetHiddenDays: HIDE_DAYS });
  }

  // A degraded run (one or more probes threw) can only UNDER-count, so the
  // honest phrasing is a floor, never a claim.
  const percentLabel = data.probeDegraded ? `at least ${percent}%` : `${percent}%`;
  const valueText = `${percent} percent complete, ${done} of ${total} steps done`;

  return (
    <section
      role="region"
      aria-labelledby="setup-widget-title"
      className="mb-4 rounded-2xl border bg-white px-4 py-3"
      style={{ borderColor: 'var(--theme-border)' }}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Left — where you are. Counts sit NEXT TO the percentage always: with
            locked/dismissed/permission filtering no two operators share a
            denominator, so the number has to explain itself. */}
        <div className="min-w-0 sm:max-w-md sm:flex-1">
          {newWork && (
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--theme-primary)' }}>
              New setup step
            </div>
          )}
          <h2 id="setup-widget-title" className="text-sm font-semibold" style={{ color: 'var(--theme-text)' }}>
            Setup — {percentLabel} complete
          </h2>
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={valueText}
            className="mt-1.5 h-2 w-full overflow-hidden rounded-full"
            style={{ background: TRACK, boxShadow: 'inset 0 0 0 1px var(--theme-border)' }}
          >
            {/* min-width keeps the very first completed step visible instead of
                rounding away to an empty track — we show real early progress
                rather than pre-ticking a step to fake it. */}
            <div
              className="h-full rounded-full"
              style={{
                width: `${percent}%`,
                minWidth: percent > 0 ? '4px' : 0,
                background: FILL,
                transition: 'width .3s ease',
              }}
            />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: MUTED }}>
            <span>{done} of {total} done</span>
            <Link href="/setup" className="font-medium" style={{ color: 'var(--theme-primary-dark)' }}>
              See all steps
            </Link>
            {/* A text link, not an ×: this is a 7-day snooze, not a dismissal.
                There is deliberately no way to kill the widget for good — it
                goes away by being finished. */}
            <button type="button" onClick={hideForNow} className="min-h-[24px] font-medium underline-offset-2 hover:underline">
              Hide for now
            </button>
          </div>
        </div>

        {/* Right — the single next action, byte-identical to the one /setup and
            the nudge show, so the three surfaces never point different ways. */}
        <div className="flex min-w-0 shrink-0 flex-col items-start gap-1.5 sm:items-end">
          {step ? (
            <>
              <div className="max-w-full truncate text-xs" style={{ color: MUTED }}>
                Next: <span style={{ color: 'var(--theme-text)' }}>{step.label}</span>
              </div>
              <Link
                href={stepHref(step)}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold"
                style={{ background: 'var(--theme-primary)', color: 'var(--theme-on-primary)' }}
              >
                {step.cta || 'Set up'} <span aria-hidden="true">→</span>
              </Link>
            </>
          ) : (
            <div className="text-xs" style={{ color: MUTED }}>
              Nothing waiting on you right now.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
