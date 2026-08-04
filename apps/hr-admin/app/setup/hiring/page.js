'use client';

// Hiring setup — the Talent Acquisition track, scored on its own.
//
// A DELIBERATE second page rather than a section of /setup: a company that never
// hires must be able to reach 100% on the core guide while this sits untouched
// at 0%, and the only way to guarantee that is to keep the two denominators in
// two places. The engine is shared (same registry shape, same probes, same
// next-action ranking, same components) — only the registry differs.
//
// Same rules as the core guide:
//   • READ-ONLY — it scores the workspace from GET /api/hr/setup-checklist/talent
//     and then sends you to the real screen. It never operates a feature inline.
//   • ADVISORY — nothing here blocks posting a job, interviewing or hiring.
//
// The one difference is the ending. The core guide finishes on "you're all set";
// this one finishes on a LINK — the careers URL a recruiter can actually send to
// candidates — which is what <ActivationCard> renders in place of the
// next-action card once the page is live.
//
// A recruiter typically lacks canManageCompanyProfile, so they cannot open
// /setup at all. This page therefore never reads the core payload for anything:
// it fetches its own track and is reachable from its own nav item.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner, Spinner } from '@hr/ui';
import {
  allSteps,
  readOpenStages,
  setupFullyComplete,
  stageOfNextAction,
  useSetupTrack,
  writeOpenStages,
} from '@/lib/setup';
import AddOnUpsell from '@/components/AddOnUpsell';
import SetupHeader from '@/components/setup/SetupHeader';
import NextActionCard from '@/components/setup/NextActionCard';
import ActivationCard from '@/components/setup/ActivationCard';
import StageAccordion from '@/components/setup/StageAccordion';
import HiddenSteps from '@/components/setup/HiddenSteps';

const TRACK = 'talent';

// How long a just-hidden row stays put with an Undo before it moves to the
// footer. Long enough to notice a misclick, short enough not to look stuck.
const UNDO_MS = 10000;

export default function HiringSetupPage() {
  const { data, loading, error, stale, businessId, refresh, dismiss, restore, setUiState } = useSetupTrack(TRACK);

  // Landing here is the one moment we WANT the freshest possible score — the
  // recruiter has usually just come back from publishing something.
  useEffect(() => { refresh(); }, [refresh]);

  const [openKeys, setOpenKeys] = useState(() => new Set());
  const [doneOpenKeys, setDoneOpenKeys] = useState(() => new Set());
  const [undoKey, setUndoKey] = useState(null);
  const [actionError, setActionError] = useState('');
  const [focusRequest, setFocusRequest] = useState(0);
  const undoTimer = useRef(null);
  const restoredStages = useRef(false);
  const autoOpened = useRef(null);

  useEffect(() => () => clearTimeout(undoTimer.current), []);

  // Restore this operator's own expansions (30-day, per tenant AND per track, so
  // opening "Go live" here never closes a stage on the core guide).
  useEffect(() => {
    if (restoredStages.current || !businessId) return;
    restoredStages.current = true;
    const stored = readOpenStages(businessId, TRACK);
    if (stored && stored.length) setOpenKeys((prev) => new Set([...prev, ...stored]));
  }, [businessId]);

  // …then union the stage holding the next action. Auto-opening is keyed on the
  // stage itself, so a stage the operator deliberately closed stays closed until
  // the next action genuinely moves elsewhere.
  const nextStageKey = stageOfNextAction(data);
  useEffect(() => {
    if (!nextStageKey || autoOpened.current === nextStageKey) return;
    autoOpened.current = nextStageKey;
    setOpenKeys((prev) => new Set(prev).add(nextStageKey));
  }, [nextStageKey]);

  const toggleStage = useCallback((key) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      if (businessId) writeOpenStages(businessId, next, TRACK);
      return next;
    });
  }, [businessId]);

  const toggleDone = useCallback((key) => {
    setDoneOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const steps = useMemo(() => allSteps(data), [data]);
  const stepByKey = useMemo(() => new Map(steps.map((s) => [s.key, s])), [steps]);

  const labelOf = useCallback((key) => {
    const step = stepByKey.get(key);
    return step ? { label: step.label, done: step.state === 'done' } : null;
  }, [stepByKey]);

  // The activation card names the one outstanding half by step key, and needs
  // that row's real label/route/cta to render a live button for it.
  const stepFor = useCallback((key) => stepByKey.get(key) || null, [stepByKey]);

  const hidden = useMemo(
    () => steps.filter((s) => s.state === 'dismissed' && s.key !== undoKey),
    [steps, undoKey],
  );

  // The API's nextAction is a summary; the full row carries the explainer copy,
  // so "What is this?" reads identically in the card and in the list.
  const nextStep = useMemo(() => {
    if (!data?.nextAction) return null;
    const full = stepByKey.get(data.nextAction.key);
    return full ? { ...full, ...data.nextAction, explain: full.explain } : data.nextAction;
  }, [data, stepByKey]);

  const handleDismiss = useCallback(async (step) => {
    setActionError('');
    try {
      await dismiss(step.key);
      setUndoKey(step.key);
      clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndoKey(null), UNDO_MS);
    } catch (err) {
      setActionError(err?.data?.message || err?.message || 'Could not hide that step.');
    }
  }, [dismiss]);

  const handleRestore = useCallback(async (key) => {
    setActionError('');
    clearTimeout(undoTimer.current);
    setUndoKey(null);
    try {
      await restore(key);
    } catch (err) {
      setActionError(err?.data?.message || err?.message || 'Could not bring that step back.');
    }
  }, [restore]);

  const handleCelebrated = useCallback(() => {
    // Best-effort: a failure here only means the confetti may fire once more.
    // It writes the TALENT track's own slice — the core celebration is untouched.
    setUiState({ celebrated: true }).catch(() => {});
  }, [setUiState]);

  // "Not now" — open the next action's stage and drop the caret on its first
  // pending row, rather than dumping the operator at the top of a long list.
  const skipToList = useCallback(() => {
    if (nextStageKey) setOpenKeys((prev) => new Set(prev).add(nextStageKey));
    setFocusRequest((n) => n + 1);
  }, [nextStageKey]);

  useEffect(() => {
    if (!focusRequest) return;
    const panel = nextStageKey && document.getElementById(`setup-stage-panel-${nextStageKey}`);
    const target = panel?.querySelector('[data-setup-todo]')
      || document.querySelector(`[data-setup-stage-header="${nextStageKey}"]`);
    // focus() honours the rows' scroll-margin-top, so the sticky chrome never
    // ends up covering the thing we just pointed at.
    target?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // ── States ────────────────────────────────────────────────────────────────

  if (loading && !data) {
    return (
      <div className="max-w-4xl">
        <div className="py-16 flex justify-center"><Spinner /></div>
      </div>
    );
  }

  // Not on the plan. The endpoint answers 200 with an upsell envelope rather
  // than 403 precisely so we land here instead of in the error branch.
  if (data && data.entitled === false) {
    return <AddOnUpsell title="Talent Acquisition" cta="Add Talent Acquisition" href={data.upsell?.route || '/settings?tab=billing'} />;
  }

  if (!data) {
    // The nav item is gated on the same two keys the route is, so a 403 here means
    // someone followed a link rather than a bug — say which access is missing
    // instead of offering a "Try again" that will fail identically every time.
    const forbidden = error?.status === 403;
    return (
      <div className="max-w-4xl">
        <h1 className="text-2xl font-semibold text-gray-900">Hiring setup</h1>
        <p className="mt-1 text-sm text-gray-600">
          {forbidden
            ? 'This guide is for the people who run hiring. Ask an admin for the “Manage hiring” permission and it will appear in your sidebar.'
            : 'We couldn’t load your hiring setup just now. Nothing is blocked — posting jobs, interviewing and offers all still work.'}
        </p>
        <div className="mt-4">
          <ErrorBanner message={forbidden
            ? 'You don’t have permission to see the hiring setup guide.'
            : (error?.message || 'The hiring checklist is unavailable.')}
          />
        </div>
        {!forbidden && (
          <button
            type="button"
            onClick={refresh}
            className="mt-2 inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
          >
            Try again
          </button>
        )}
      </div>
    );
  }

  const activation = data.activation || null;
  // The activation card OWNS the top of the page once there is something true to
  // say about the public board — and it deliberately outranks the checklist, so a
  // tenant whose page is live at 73% still sees "live" rather than "73% ready".
  const showActivation = !!activation && (activation.state === 'live' || activation.state === 'almost');

  return (
    // While `stale`, what's on screen is the <24h cached payload and the live
    // read is still in flight — dimmed and flagged busy so nobody acts on a
    // number we haven't re-confirmed yet.
    <div className="max-w-4xl" aria-busy={stale || undefined} style={stale ? { opacity: 0.6 } : undefined}>
      <SetupHeader
        eyebrow={data.trackTitle || 'Hiring setup'}
        track={data.track}
        percent={data.percent}
        completedCount={data.completedCount}
        totalCount={data.totalCount}
        requiredRemaining={data.requiredRemaining}
        lockedCount={data.lockedCount}
        probeDegraded={data.probeDegraded}
        allComplete={data.allComplete}
        tenantAllComplete={data.tenantAllComplete}
        stepsNeedingSomeoneElse={data.stepsNeedingSomeoneElse}
      />

      {stale && <p className="-mt-4 mb-4 text-xs text-gray-600">Updating…</p>}

      {error && <div className="mb-4"><ErrorBanner message="We’re showing your last known hiring setup — the live check didn’t answer." /></div>}
      {actionError && <div className="mb-4"><ErrorBanner message={actionError} /></div>}

      {showActivation ? (
        <ActivationCard
          activation={activation}
          stepFor={stepFor}
          celebratedAt={data.celebratedAt}
          onCelebrated={handleCelebrated}
        />
      ) : (
        <NextActionCard
          step={nextStep}
          blocked={data.nextActionBlocked}
          currency={data.currency}
          country={data.country}
          totalCount={data.totalCount}
          // The done card and its confetti say the COMPANY is set up, so they wait
          // on the whole tenant being finished — not on this operator having
          // finished the slice their permissions let them see.
          allComplete={setupFullyComplete(data)}
          completedAt={data.completedAt}
          celebratedAt={data.celebratedAt}
          onSkipToList={skipToList}
          onCelebrated={handleCelebrated}
        />
      )}

      <StageAccordion
        stages={data.stages}
        openKeys={openKeys}
        onToggle={toggleStage}
        doneOpenKeys={doneOpenKeys}
        onToggleDone={toggleDone}
        nextActionStageKey={nextStageKey}
        currency={data.currency}
        country={data.country}
        undoKey={undoKey}
        onDismiss={handleDismiss}
        onRestore={handleRestore}
        labelOf={labelOf}
      />

      <HiddenSteps steps={hidden} onRestore={handleRestore} />
    </div>
  );
}
