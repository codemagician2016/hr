'use client';

// 9-box board (Feature 34) — HR-Admin + Manager. X = Performance, Y = Potential.
//   - HR sees the whole org for a cycle (+ a cycle picker); a Manager sees ONLY their
//     TEAM sub-tree (the board fetch is scope-bound server-side — they cannot load a
//     peer's report). The performance axis is DERIVED from the F8 calibrated/final
//     rating server-side; this UI never re-rates it.
//   - Drag a chip between cells → POST /placements/:id/move with {toPotential, reason,
//     version, sessionId}. A required reason prompt feeds the append-only ledger;
//     optimistic move with reload-on-409. SoD is server-enforced (a manager can't move
//     their own box → 404). Author potential on an un-placed report from the tray.
//   - Calibration mode: "Open calibration" (skip-level/HR) starts a NINE_BOX session;
//     a live concentration-warning banner shows over-target boxes; "Finalize" needs
//     canManageSuccession. The warning is advisory — it never blocks finalize.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea } from '@hr/ui';
import { NineBoxGrid, TalentTagChip } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, PageHeader, StatusBadge, ActionButton, employeeLabel } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';

function Tooltip({ text }) {
  return (
    <span className="relative inline-flex group ml-1 align-middle" tabIndex={0}>
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold text-gray-600 cursor-help">i</span>
      <span className="pointer-events-none absolute left-1/2 top-5 z-20 w-64 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-[11px] leading-snug text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100">{text}</span>
    </span>
  );
}

// Move/author prompt: capture potential + a required reason (feeds the ledger).
function MovePrompt({ chip, toBox, onClose, onSubmit }) {
  const [potential, setPotential] = useState(chip?.potentialRating != null ? String(chip.potentialRating) : '');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!reason.trim()) { setError('A reason is required (it is recorded in the move ledger).'); return; }
    setSaving(true); setError('');
    try { await onSubmit({ toPotential: Number(potential), reason: reason.trim() }); }
    catch (err) { setError(err.data?.message || err.message || 'Move failed.'); setSaving(false); }
  }
  return (
    <Modal title={`Place ${chip ? employeeLabel(chip.employee) : ''} → Box ${toBox}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <TextInput label="Potential rating" value={potential} onChange={setPotential} type="number" required />
        <TextArea label="Reason (recorded in the ledger)" value={reason} onChange={setReason} rows={3} required />
        <p className="text-xs text-gray-500">The performance axis is derived from the calibrated rating and is never edited here — only potential moves a chip.</p>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>Save placement</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function NineBoxPage() {
  const [perms, setPerms] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [cycleId, setCycleId] = useState('');
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [dragChip, setDragChip] = useState(null);
  const [prompt, setPrompt] = useState(null); // { chip, toBox }
  const [busy, setBusy] = useState(false);

  const canConfig = hasPermission(perms, 'canManagePerformanceCycle');
  const canCalibrate = hasPermission(perms, 'canCalibrateRatings');
  const canSucceed = hasPermission(perms, 'canManageSuccession');

  useEffect(() => {
    (async () => {
      const me = await get('/api/auth/me').catch(() => null);
      setPerms(permissionsFromSession(me?.user || me));
      const cs = asList(await get('/api/hr/performance/cycles').catch(() => ({ items: [] })));
      setCycles(cs);
      if (cs.length) setCycleId(cs[0].id);
    })();
  }, []);

  const loadBoard = useCallback(async () => {
    if (!cycleId) return;
    setLoading(true); setError('');
    try { setBoard(await get('/api/hr/ninebox/board', { cycleId })); }
    catch (e) { setError(e.data?.message || e.message || 'Failed to load the board.'); setBoard(null); }
    finally { setLoading(false); }
  }, [cycleId]);
  useEffect(() => { loadBoard(); }, [loadBoard]);

  async function seed() {
    setBusy(true); setError('');
    try { await post(`/api/hr/ninebox/cycles/${cycleId}/seed`, {}); await loadBoard(); }
    catch (e) { setError(e.data?.message || e.message || 'Seed failed.'); }
    finally { setBusy(false); }
  }

  async function openCalibration() {
    setBusy(true); setError('');
    try {
      // Root the session at the first placed employee's manager chain is server-resolved;
      // for the board we root at the current viewer's own anchor (HR roots at any).
      const skipLevelEmployeeId = board?.unplaced?.[0]?.employeeId || Object.values(board?.cells || {}).flat()[0]?.employeeId;
      if (!skipLevelEmployeeId) { setError('No one to calibrate yet — seed placements first.'); setBusy(false); return; }
      const s = await post('/api/hr/ninebox/sessions', { cycleId, skipLevelEmployeeId });
      setSessionId(s.id);
    } catch (e) { setError(e.data?.message || e.message || 'Could not open calibration.'); }
    finally { setBusy(false); }
  }

  function onDropChip(toBox) {
    if (!dragChip) return;
    setPrompt({ chip: dragChip, toBox });
  }

  async function submitMove({ toPotential, reason }) {
    const chip = prompt.chip;
    const isAuthor = chip.box == null; // un-placed → author potential; placed → move
    const path = isAuthor
      ? `/api/hr/ninebox/placements/${chip.id}/author-potential`
      : `/api/hr/ninebox/placements/${chip.id}/move`;
    const payload = isAuthor
      ? { potentialRating: toPotential, reason, version: chip.version }
      : { toPotential, reason, sessionId: sessionId || undefined, version: chip.version };
    await post(path, payload);
    setPrompt(null); setDragChip(null);
    await loadBoard();
  }

  async function finalizeAll() {
    setBusy(true); setError('');
    try {
      const all = Object.values(board?.cells || {}).flat();
      for (const p of all) {
        if (p.status === 'CALIBRATED' || p.status === 'PROPOSED') {
          await post(`/api/hr/ninebox/placements/${p.id}/finalize`, { version: p.version }).catch(() => {});
        }
      }
      await loadBoard();
    } catch (e) { setError(e.data?.message || e.message || 'Finalize failed.'); }
    finally { setBusy(false); }
  }

  const warningByBox = {};
  if (board?.warning?.buckets) {
    for (const b of board.warning.buckets) if (b.exceedsTolerance) warningByBox[Number(b.value)] = true;
  }

  function renderChip(c) {
    return (
      <button
        key={c.id}
        type="button"
        draggable={canCalibrate || canConfig}
        onDragStart={() => setDragChip(c)}
        onClick={() => setPrompt({ chip: c, toBox: c.box })}
        className="inline-flex items-center gap-1 rounded-full bg-white border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-700 shadow-sm hover:shadow cursor-move"
        title={`${employeeLabel(c.employee)} · perf band ${c.performanceBand ?? '—'}`}
      >
        {employeeLabel(c.employee)}
      </button>
    );
  }

  return (
    <div>
      <PageHeader
        title="9-box talent grid"
        subtitle="Performance × potential — a development view, not a ranking"
        actions={canConfig && cycleId ? <PrimaryButton onClick={seed} disabled={busy}>Seed placements</PrimaryButton> : null}
      />
      {error ? <ErrorBanner message={error} /> : null}

      <div className="flex flex-wrap items-center gap-3 my-3">
        <label className="text-sm text-gray-700">
          Cycle
          <select value={cycleId} onChange={(e) => setCycleId(e.target.value)} className="ml-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
            {cycles.length === 0 && <option value="">No cycles</option>}
            {cycles.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
          </select>
        </label>
        {canCalibrate && (
          <ActionButton tone="neutral" disabled={busy || !cycleId} onClick={openCalibration}>
            {sessionId ? 'Calibration open' : 'Open calibration'}
          </ActionButton>
        )}
        {canSucceed && sessionId && (
          <ActionButton tone="positive" disabled={busy} onClick={finalizeAll}>Finalize all</ActionButton>
        )}
        <span className="text-xs text-gray-500">Drag a chip to move a person on potential.<Tooltip text="The horizontal (performance) axis is fixed by the calibrated rating. You move people up or down on potential only; every move records a reason in an audit ledger." /></span>
      </div>

      {board?.warning?.hasTarget && !board.warning.withinTolerance && (
        <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          Distribution is over target in {Object.keys(warningByBox).length} box(es). This is advisory only — you can still finalize a genuinely high-performing team.
        </div>
      )}

      {loading || board === null ? (
        <div className="text-sm text-gray-400 py-8 text-center">Loading the grid…</div>
      ) : (
        <>
          <NineBoxGrid cells={board.cells} onDropChip={onDropChip} renderChip={renderChip} warningByBox={warningByBox} />
          {board.unplaced?.length > 0 && (
            <div className="mt-4 rounded-xl border border-dashed border-gray-300 bg-white p-3">
              <div className="text-xs font-semibold text-gray-500 mb-2">Unplaced ({board.unplaced.length}) — potential not yet authored. Click to place.</div>
              <div className="flex flex-wrap gap-1.5">{board.unplaced.map(renderChip)}</div>
            </div>
          )}
          {Object.values(board.cells).flat().length === 0 && board.unplaced?.length === 0 && (
            <div className="text-sm text-gray-500 py-8 text-center">
              No one to place yet. {canConfig ? 'Seed placements once the cycle has manager-submitted reviews.' : 'Your reports will appear here once their reviews are submitted.'}
            </div>
          )}
        </>
      )}

      {prompt && (
        <MovePrompt
          chip={prompt.chip}
          toBox={prompt.toBox}
          onClose={() => { setPrompt(null); setDragChip(null); }}
          onSubmit={submitMove}
        />
      )}
    </div>
  );
}
