'use client';

// Feature 17 — the shared CTC-statement waterfall + 50% chip. Reused by the policy
// builder's live preview pane AND the onboard-by-CTC wizard. It posts a debounced
// preview to the backend (compile → deriveBreakup → waterfall + India 50% verdict)
// and renders a layman waterfall: CTC → −employer cost → Gross → −deductions → Net.
//
// `previewPath` + `previewBody` make it generic: the builder posts an ad-hoc draft to
// /ctc-policies/preview, the wizard posts /ctc-policies/:id/preview. A green/red chip
// reflects wagesVerdict (Basic ≥ 50% of CTC) and is the single source for `onVerdict`
// so callers can disable Save/Next while the chip is red.

import { useEffect, useRef, useState } from 'react';
import { post } from '@/lib/api';

function money(minor, currency = 'INR') {
  if (minor == null) return '—';
  const major = Number(minor) / 100;
  const symbol = currency === 'INR' ? '₹' : (currency === 'NZD' ? '$' : '');
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return `${symbol}${Math.abs(major).toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function Line({ label, mo, an, currency, muted, strong, accent }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className={`${strong ? 'font-semibold' : ''} ${muted ? 'text-gray-400' : 'text-gray-600'}`}>{label}</span>
      <span className="flex gap-6">
        <span className={`tabular-nums ${accent ? 'text-[color:var(--theme-primary)] font-semibold' : (strong ? 'font-semibold text-gray-900' : 'text-gray-800')}`}>{money(mo, currency)}<span className="text-xs text-gray-400">/mo</span></span>
        <span className="w-28 text-right tabular-nums text-gray-400 text-xs">{money(an, currency)}/yr</span>
      </span>
    </div>
  );
}

export default function CtcStatement({ previewPath, previewBody, currency = 'INR', onVerdict }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  const bodyKey = JSON.stringify(previewBody || {});
  useEffect(() => {
    if (!previewPath || !previewBody) return undefined;
    if (timer.current) clearTimeout(timer.current);
    setLoading(true);
    timer.current = setTimeout(async () => {
      try {
        const res = await post(previewPath, previewBody);
        setData(res);
        setError('');
        if (onVerdict) onVerdict(res.wagesVerdict || null, res);
      } catch (e) {
        setData(null);
        setError(e.data?.message || e.message || 'Could not preview this CTC.');
        if (onVerdict) onVerdict(null, null);
      } finally {
        setLoading(false);
      }
    }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewPath, bodyKey]);

  const w = data?.waterfall || {};
  const resolved = data?.resolved || [];
  const employer = (data?.employerCost?.items) || [];
  const earnings = resolved.filter((r) => (r.category || 'EARNING') === 'EARNING');
  const deductions = resolved.filter((r) => ['DEDUCTION'].includes(r.category));
  const verdict = data?.wagesVerdict;
  const chipOk = verdict ? verdict.ok : null;
  const grossMo = w.grossMonthlyMinor;
  const netMo = grossMo != null ? grossMo - deductions.reduce((s, d) => s + (d.amountMonthlyMinor || 0), 0) : null;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">Live CTC statement</h3>
        {chipOk != null && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${chipOk ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}
            title="India requires Basic + DA to be at least 50% of CTC."
          >
            <span className={`h-1.5 w-1.5 rounded-full ${chipOk ? 'bg-green-500' : 'bg-red-500'}`} />
            {chipOk ? 'Basic ≥ 50% of CTC' : 'Basic below 50% of CTC'}
          </span>
        )}
      </div>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}
      {loading && !data && <p className="text-sm text-gray-400">Calculating…</p>}

      {data && (
        <div className={loading ? 'opacity-60 transition' : 'transition'}>
          {w.ctcAnnualMinor != null && (
            <div className="rounded-xl bg-gray-50 px-4 py-3 mb-3 flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wide text-gray-500">Cost to company (annual)</span>
              <span className="text-lg font-bold text-gray-900 tabular-nums">{money(w.ctcAnnualMinor, currency)}</span>
            </div>
          )}

          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mt-2 mb-1">Earnings (paid to employee)</p>
          {earnings.map((r) => (
            <Line key={r.code} label={r.code} mo={r.amountMonthlyMinor} an={r.amountAnnualMinor} currency={currency} />
          ))}
          <div className="border-t border-gray-100 mt-1">
            <Line label="Gross (in hand before deductions)" mo={grossMo} an={grossMo != null ? grossMo * 12 : null} currency={currency} strong />
          </div>

          {deductions.length > 0 && (
            <>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mt-3 mb-1">Employee deductions</p>
              {deductions.map((r) => (
                <Line key={r.code} label={r.code} mo={r.amountMonthlyMinor} an={r.amountAnnualMinor} currency={currency} />
              ))}
            </>
          )}

          <div className="rounded-xl bg-[color:var(--theme-primary)]/5 px-4 py-2 mt-2">
            <Line label="Net in hand (estimate)" mo={netMo} an={netMo != null ? netMo * 12 : null} currency={currency} strong accent />
          </div>

          {employer.length > 0 && (
            <>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mt-3 mb-1" title="The company's cost, not paid to the employee.">Company contributions (cost to company)</p>
              {employer.map((it) => (
                <Line key={it.code} label={it.code} mo={it.amountMinor} an={it.amountMinor != null ? it.amountMinor * 12 : null} currency={currency} muted />
              ))}
            </>
          )}

          {verdict && !verdict.ok && (
            <p className="mt-3 text-xs text-red-600">
              Basic + DA is below 50% of CTC. India requires Basic ≥ 50% — pick a policy with a higher Basic or raise the CTC.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
