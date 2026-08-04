'use client';

// Setup guide — the staged, full-product view of what's still worth doing.
//
// Everything on this page is READ-ONLY: it scores the workspace from
// GET /api/hr/setup-checklist (which probes real data, so the guide can't drift
// out of sync with reality) and then sends you to the actual feature screen.
// It never operates a feature inline — a step you complete here would be a
// second, divergent implementation of a screen we already ship.
//
// Gating is advisory by design. The percentage never blocks a pay run, a leave
// approval or a letter; the only things it drives are which row we suggest next
// and whether the dashboard widget is still worth showing.
//
// Four zones, in strict vertical order:
//   1  score            — where you are, and why the denominator is what it is
//   2  next best action — the one thing we're asking for; the only filled button
//   3  stages           — the whole product, unfinished first, one stage open
//   4  footer           — hidden steps + how the score is calculated

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner, Spinner } from '@hr/ui';
import {
  allSteps,
  readOpenStages,
  setupFullyComplete,
  stageOfNextAction,
  useSetup,
  writeOpenStages,
} from '@/lib/setup';
import SetupHeader from '@/components/setup/SetupHeader';
import NextActionCard from '@/components/setup/NextActionCard';
import StageAccordion from '@/components/setup/StageAccordion';
import HiddenSteps from '@/components/setup/HiddenSteps';

// How long a just-hidden row stays put with an Undo before it moves to the
// footer. Long enough to notice a misclick, short enough not to look stuck.
const UNDO_MS = 10000;

export default function SetupGuidePage() {
  const { data, loading, error, stale, businessId, refresh, dismiss, restore, setUiState } = useSetup();

  // Landing on /setup is the one moment we WANT the freshest possible score —
  // the operator has usually just come back from finishing something.
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

  // Restore the operator's own expansions (30-day, per tenant) exactly once.
  useEffect(() => {
    if (restoredStages.current || !businessId) return;
    restoredStages.current = true;
    const stored = readOpenStages(businessId);
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
      if (businessId) writeOpenStages(businessId, next);
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

  if (!data) {
    return (
      <div className="max-w-4xl">
        <h1 className="text-2xl font-semibold text-gray-900">Setup guide</h1>
        <p className="mt-1 text-sm text-gray-600">
          We couldn’t load your setup just now. Nothing is blocked — everything in the console still works.
        </p>
        <div className="mt-4">
          <ErrorBanner message={error?.message || 'The setup checklist is unavailable.'} />
        </div>
        <button
          type="button"
          onClick={refresh}
          className="mt-2 inline-flex min-h-[44px] items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-50"
        >
          Try again
        </button>
      </div>
    );
  }

  // The done card and its confetti say the COMPANY is set up, so they wait on
  // the whole tenant being finished — not on this operator having finished the
  // slice their permissions let them see (see setupFullyComplete).
  const celebrate = setupFullyComplete(data);

  return (
    // While `stale`, what's on screen is the <24h cached payload and the live
    // read is still in flight — dimmed and flagged busy so nobody acts on a
    // number we haven't re-confirmed yet.
    <div className="max-w-4xl" aria-busy={stale || undefined} style={stale ? { opacity: 0.6 } : undefined}>
      <SetupHeader
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

      {error && <div className="mb-4"><ErrorBanner message="We’re showing your last known setup — the live check didn’t answer." /></div>}
      {actionError && <div className="mb-4"><ErrorBanner message={actionError} /></div>}

      <NextActionCard
        step={nextStep}
        blocked={data.nextActionBlocked}
        currency={data.currency}
        country={data.country}
        totalCount={data.totalCount}
        allComplete={celebrate}
        completedAt={data.completedAt}
        celebratedAt={data.celebratedAt}
        onSkipToList={skipToList}
        onCelebrated={handleCelebrated}
      />

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
