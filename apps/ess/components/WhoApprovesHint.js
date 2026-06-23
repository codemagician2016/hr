'use client';

// Feature 10 slice 10e (ESS) — "Who will approve this?" submit hint.
//
// A small inline line on any request form that, when the user has filled enough
// to matter, calls the approval engine's PURE previewChain for their own
// reporting line + the sample context (amount/days/category/level) and shows the
// resolved approver count + step labels in plain language:
//   "This will go to: your manager, then Finance."
// Sets expectations before the user clicks Submit. Fails quiet (renders nothing)
// if preview isn't available — never blocks the form.
//
// Props: { module, ctx, enabled } — ctx is the sample context for conditions.

import { useEffect, useState } from 'react';
import { previewApprovalChain } from '@/lib/api';
import { InfoTip } from '@/lib/approvals';

// Plain-language label for a resolved level (we only have approver IDs, so we
// describe the STEP, not the names — the inbox shows actual names on arrival).
function levelLabel(lvl) {
  if (lvl.skipped) return null;
  if (lvl.autoApprove) return 'auto-approved';
  // The engine's `label` is the step name(s); fall back to a generic phrase.
  const name = (lvl.label || '').trim();
  if (name) return name;
  return 'an approver';
}

export default function WhoApprovesHint({ module, ctx, enabled = true }) {
  const [chain, setChain] = useState(null);
  const [state, setState] = useState('idle'); // idle | loading | done | error

  // Stable key so we only re-preview when the meaningful context changes.
  const ctxKey = JSON.stringify(ctx || {});

  useEffect(() => {
    if (!enabled || !module) { setChain(null); setState('idle'); return undefined; }
    let alive = true;
    setState('loading');
    // Debounce a touch so we don't fire on every keystroke.
    const t = setTimeout(() => {
      previewApprovalChain({ module, ctx: ctx || {} })
        .then((res) => { if (alive) { setChain(res?.chain || []); setState('done'); } })
        .catch(() => { if (alive) { setChain(null); setState('error'); } });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module, ctxKey, enabled]);

  if (!enabled || state === 'error' || state === 'idle') return null;

  if (state === 'loading') {
    return <p className="text-xs" style={{ color: 'var(--theme-muted)' }}>Checking who will approve…</p>;
  }

  const steps = (chain || []).map(levelLabel).filter(Boolean);

  if (steps.length === 0) {
    return (
      <p className="flex items-center text-xs" style={{ color: 'var(--theme-muted)' }}>
        This will be approved automatically — no one needs to sign off.
        <InfoTip text="Based on your company’s approval setup for this kind of request." />
      </p>
    );
  }

  return (
    <p className="flex items-center text-xs" style={{ color: 'var(--theme-muted)' }}>
      <span className="font-medium" style={{ color: 'var(--theme-text)' }}>This will go to:</span>
      <span className="ml-1">{steps.join(', then ')}.</span>
      <InfoTip text="A preview of who your request will be sent to, based on your company’s approval rules and your reporting line. The final approvers’ names appear once it’s submitted." />
    </p>
  );
}
