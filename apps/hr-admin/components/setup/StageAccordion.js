'use client';

// Zone 3: the whole product, grouped into the five stages a company actually
// moves through. Never one flat forty-row list — a list that long reads as a
// bill, not a plan.
//
// Exactly one stage auto-opens (the one holding the next action); anything the
// operator opens themselves is remembered per tenant. No stage is ever locked
// or disabled: setup is advisory, so every screen stays reachable at all times.

import { useCallback } from 'react';
import { orderSteps } from '@/lib/setup';
import StepRow from '@/components/setup/StepRow';
import LockedRow from '@/components/setup/LockedRow';

// Above this many pending rows a stage stops being a list and becomes a wall,
// so we split it into what matters now and what can wait.
const SPLIT_THRESHOLD = 7;

const STAGE_STATUS_WORD = {
  not_started: 'Not started',
  in_progress: 'In progress',
  required_done: 'Essentials done',
  done: 'Done',
};

function Chevron({ open }) {
  return (
    <span
      aria-hidden
      className="ml-1 inline-block text-xs text-gray-600 transition-transform motion-reduce:transition-none"
      style={{ transform: open ? 'rotate(180deg)' : 'none' }}
    >
      ▾
    </span>
  );
}

// Everything the operator has already finished, folded away by default. It is
// evidence, not work — but it has to stay visible, because "Review →" on a done
// row is how people re-open a screen they set up months ago.
function DoneGroup({ steps, open, onToggle, panelId, ...rowProps }) {
  if (steps.length === 0) return null;
  return (
    <li className="border-b border-gray-100 py-2 last:border-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-sm py-1.5 text-left"
      >
        <span className="text-sm font-medium text-gray-700">Done ({steps.length})</span>
        <span className="ml-auto text-xs text-gray-600">{open ? 'Hide' : 'Show'}</span>
        <Chevron open={open} />
      </button>
      <ul id={panelId} className="mt-1" hidden={!open}>
        {steps.map((s) => <StepRow key={s.key} step={s} {...rowProps} />)}
      </ul>
    </li>
  );
}

function SubHeading({ children }) {
  return (
    <li className="pt-3 pb-1">
      <h3 className="text-[11px] font-bold uppercase tracking-[0.08em] text-gray-600">{children}</h3>
    </li>
  );
}

function StageSection({
  stage,
  open,
  onToggle,
  onHeaderKeyDown,
  doneOpen,
  onToggleDone,
  undoKey,
  isNextStage,
  ...rowProps
}) {
  const panelId = `setup-stage-panel-${stage.key}`;
  const headerId = `setup-stage-header-${stage.key}`;

  const steps = stage.steps || [];
  // A dismissed row normally lives in the page footer — except for the 10s undo
  // window, where it must stay exactly where the operator left it.
  const visible = steps.filter((s) => s.state !== 'dismissed' || s.key === undoKey);

  const locked = visible.filter((s) => s.locked || s.state === 'locked');
  const rest = visible.filter((s) => !(s.locked || s.state === 'locked'));
  const done = rest.filter((s) => s.state === 'done');
  const unreachable = rest.filter((s) => s.state !== 'done' && s.permitted === false);
  const pending = orderSteps(rest.filter((s) => s.state !== 'done' && s.permitted !== false));

  // Split only when the stage is genuinely long AND there is a meaningful
  // dividing line to draw. A stage of nine optional rows stays one list.
  const essentials = pending.filter((s) => s.required);
  const laterOn = pending.filter((s) => !s.required);
  const split = pending.length > SPLIT_THRESHOLD && essentials.length > 0 && laterOn.length > 0;

  const statusWord = STAGE_STATUS_WORD[stage.status] || '';

  return (
    <section className="scroll-mt-24 border-b border-gray-200 last:border-0">
      {/* Heading wraps the button, not the other way round: <button> takes
          phrasing content only, so a heading inside it would be invalid HTML and
          would cost the row its heading semantics. */}
      <h2>
        <button
          type="button"
          id={headerId}
          data-setup-stage-header={stage.key}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(stage.key)}
          onKeyDown={onHeaderKeyDown}
          className="flex w-full items-center justify-between gap-4 px-1 py-4 text-left hover:bg-gray-50"
        >
          <span className="min-w-0">
            <span className="block text-base font-semibold text-gray-900">
              {stage.title}
              {/* Words, not a colour: the stage holding the next action says so. */}
              {isNextStage && (
                <span className="ml-2 align-middle text-[11px] font-bold uppercase tracking-wide text-gray-600">
                  Next
                </span>
              )}
            </span>
            <span className="block text-xs text-gray-600">{stage.subtitle}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-gray-600">
            <span className="whitespace-nowrap">
              {stage.completedCount} of {stage.totalCount} done
            </span>
            {statusWord && (
              <span className="hidden whitespace-nowrap rounded-full border border-gray-300 px-2 py-0.5 font-semibold text-gray-700 sm:inline">
                {statusWord}
              </span>
            )}
            <Chevron open={open} />
          </span>
        </button>
      </h2>

      {/* `hidden` (not just CSS) so nothing focusable can hide inside a collapsed
          panel and swallow a Tab press. */}
      <div
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        hidden={!open}
        className="pb-2"
      >
        <ul className="px-1">
          {split && <SubHeading>Essentials</SubHeading>}
          {(split ? essentials : pending).map((s) => (
            <StepRow key={s.key} step={s} undo={s.key === undoKey} {...rowProps} />
          ))}

          {split && (
            <>
              <SubHeading>When you’re ready</SubHeading>
              {laterOn.map((s) => (
                <StepRow key={s.key} step={s} undo={s.key === undoKey} {...rowProps} />
              ))}
            </>
          )}

          {locked.length > 0 && <LockedRow steps={locked} />}

          {unreachable.length > 0 && (
            <>
              <SubHeading>Needs someone else</SubHeading>
              {unreachable.map((s) => <StepRow key={s.key} step={s} {...rowProps} />)}
            </>
          )}

          <DoneGroup
            steps={done}
            open={doneOpen}
            onToggle={() => onToggleDone(stage.key)}
            panelId={`setup-stage-done-${stage.key}`}
            {...rowProps}
          />

          {visible.length === 0 && (
            <li className="py-4 text-sm text-gray-600">Nothing to do in this stage.</li>
          )}
        </ul>
      </div>
    </section>
  );
}

export default function StageAccordion({
  stages,
  openKeys,
  onToggle,
  doneOpenKeys,
  onToggleDone,
  nextActionStageKey,
  ...rowProps
}) {
  // Roving arrow-key movement between the five stage headers, so a keyboard user
  // can scan the shape of the whole setup without tabbing through every row.
  const onHeaderKeyDown = useCallback((event) => {
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const headers = Array.from(document.querySelectorAll('[data-setup-stage-header]'));
    const index = headers.indexOf(event.currentTarget);
    if (index === -1) return;
    event.preventDefault();
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % headers.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + headers.length) % headers.length;
    else if (event.key === 'Home') next = 0;
    else next = headers.length - 1;
    headers[next]?.focus();
  }, []);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white px-4 sm:px-5">
      {(stages || []).map((stage) => (
        <StageSection
          key={stage.key}
          stage={stage}
          open={openKeys.has(stage.key)}
          onToggle={onToggle}
          onHeaderKeyDown={onHeaderKeyDown}
          doneOpen={doneOpenKeys.has(stage.key)}
          onToggleDone={onToggleDone}
          isNextStage={stage.key === nextActionStageKey}
          {...rowProps}
        />
      ))}
    </div>
  );
}
