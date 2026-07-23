'use client';

// Roster console (Feature 29 — shift management) against /api/hr/attendance/roster|rotations|swaps.
//
// Tabs:
//  - Grid:      GET /roster/grid?from&to (keyset-paginated BY EMPLOYEE). Rows = employees,
//               columns = days. Each cell = a colour-coded shift code (M/A/N/OFF) with a
//               tooltip (start–end, break, Night shift, source). Click a cell → set a shift
//               or OFF (PUT /roster/cell, writes a MANUAL DRAFT). Bulk publish a window.
//  - Rotations: GET/POST/PATCH/DELETE /rotations + POST /rotations/:id/apply (generate DRAFT
//               rows for the in-scope population/window → { written, violations }).
//  - Swaps:     GET /swaps queue; POST /swaps/:id/approve|reject (F10 SHIFT_SWAP decision).
//
// All reads/writes are cookie-authed and tenant- + F1-scoped server-side. DRAFT rows are
// hidden from derive/pay until Publish (the muster "exhibit").

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Spinner, ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, DateField, TextArea } from '@hr/ui';
import { get, post, put, patch, del } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

const TABS = [
  { key: 'grid', label: 'Roster grid' },
  { key: 'rotations', label: 'Rotations' },
  { key: 'swaps', label: 'Swaps' },
  { key: 'openshifts', label: 'Open shifts' },
];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function eachDayISO(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) out.push(d);
  return out;
}
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); } catch { return String(d).slice(0, 10); }
}

// A short shift code + colour for a cell. Night = amber, OFF = grey, work = blue.
function cellChip(cell) {
  if (!cell) return { label: '·', title: 'No roster cell (falls back to assignment/default)', color: '#e5e7eb', fg: '#6b7280' };
  if (cell.dayType === 'OFF') return { label: 'OFF', title: `Weekly off (${cell.source})`, color: '#f3f4f6', fg: '#6b7280' };
  const s = cell.shift || {};
  const night = s.isNightShift;
  const code = (s.code || '?').slice(0, 3).toUpperCase();
  const title = `${s.name || s.code || 'Shift'} ${s.startTime || ''}–${s.endTime || ''}${s.breakMinutes != null ? ` · break ${s.breakMinutes}m` : ''}${night ? ' · Night shift' : ''} · ${cell.source}${cell.status === 'DRAFT' ? ' · DRAFT' : ''}`;
  return { label: code, title, color: night ? '#fef3c7' : '#dbeafe', fg: night ? '#92400e' : '#1e40af' };
}

export default function RosterPage() {
  const [tab, setTab] = useState('grid');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [canManage, setCanManage] = useState(false);

  useEffect(() => {
    get('/api/auth/me')
      .then((me) => { const session = me?.user || me; setCanManage(hasPermission(permissionsFromSession(session), 'canManageAttendance')); })
      .catch(() => setCanManage(false));
  }, []);

  // ── Grid ──
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(addDaysISO(todayISO(), 13)); // a fortnight
  const [nodes, setNodes] = useState([]);
  const [gridLoading, setGridLoading] = useState(false);
  const [shifts, setShifts] = useState([]);
  const days = useMemo(() => eachDayISO(from, to), [from, to]);

  const loadShifts = useCallback(() => {
    get('/api/hr/attendance/shifts').then((res) => setShifts(asList(res) || [])).catch(() => {});
  }, []);
  const loadGrid = useCallback(() => {
    setGridLoading(true); setError('');
    get('/api/hr/attendance/roster/grid', { from, to, limit: 50 })
      .then((res) => setNodes((res && res.nodes) || []))
      .catch((e) => setError(e.message))
      .finally(() => setGridLoading(false));
  }, [from, to]);
  useEffect(() => { if (tab === 'grid') { loadShifts(); loadGrid(); } }, [tab, loadGrid, loadShifts]);

  const cellMap = useMemo(() => {
    const m = new Map();
    for (const n of nodes) for (const c of n.cells || []) m.set(`${n.employee.id}|${c.date}`, c);
    return m;
  }, [nodes]);

  async function setCell(employeeId, date, value) {
    setError(''); setNotice('');
    try {
      const body = value === 'OFF'
        ? { employeeId, date, dayType: 'OFF' }
        : { employeeId, date, dayType: 'WORK', shiftPatternId: value };
      await put('/api/hr/attendance/roster/cell', body);
      setNotice('Cell saved (DRAFT).');
      loadGrid();
    } catch (e) { setError(e.message); }
  }
  async function publishWindow() {
    setError(''); setNotice('');
    try {
      const res = await post(`/api/hr/attendance/roster/publish?from=${from}&to=${to}`, {});
      setNotice(`Published ${res.published || 0} cell(s).`);
      loadGrid();
    } catch (e) { setError(e.message); }
  }

  // ── Rotations ──
  const [rotations, setRotations] = useState([]);
  const [rotLoading, setRotLoading] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  // Rotation-template editor: `editor` holds the draft for the New/Edit modal.
  const [editor, setEditor] = useState(null);
  const [editorErr, setEditorErr] = useState('');
  const [saving, setSaving] = useState(false);
  const loadRotations = useCallback(() => {
    setRotLoading(true);
    get('/api/hr/attendance/rotations')
      .then((res) => setRotations(asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setRotLoading(false));
  }, []);
  // The editor's WORK slots reference active shift patterns; load them when the
  // Rotations tab is shown so the slot picker has options to choose from.
  useEffect(() => { if (tab === 'rotations') { loadRotations(); loadShifts(); } }, [tab, loadRotations, loadShifts]);

  async function applyRotation(id) {
    setError(''); setNotice(''); setApplyResult(null);
    try {
      const res = await post(`/api/hr/attendance/rotations/${id}/apply`, { from, to });
      setApplyResult(res);
      setNotice(`Generated ${res.written || 0} DRAFT cell(s)${(res.violations || []).length ? ` · ${res.violations.length} violation(s)` : ''}.`);
    } catch (e) { setError(e.message); }
  }

  // Open the editor for a new template, or seed it from an existing row.
  function openNewRotation() {
    setEditorErr('');
    setEditor({ id: null, code: '', name: '', anchorDate: todayISO(), slots: [{ kind: 'WORK', shiftPatternId: '' }] });
  }
  function openEditRotation(r) {
    setEditorErr('');
    const slots = (r.slotsJson || []).map((s) => ({ kind: s.kind === 'OFF' ? 'OFF' : 'WORK', shiftPatternId: s.shiftPatternId || '' }));
    setEditor({
      id: r.id, code: r.code || '', name: r.name || '',
      anchorDate: r.anchorDate ? String(r.anchorDate).slice(0, 10) : todayISO(),
      slots: slots.length ? slots : [{ kind: 'WORK', shiftPatternId: '' }],
    });
  }
  function setSlot(i, patch) {
    setEditor((ed) => ({ ...ed, slots: ed.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  }
  function addSlot(kind) {
    setEditor((ed) => ({ ...ed, slots: [...ed.slots, { kind, shiftPatternId: '' }] }));
  }
  function removeSlot(i) {
    setEditor((ed) => ({ ...ed, slots: ed.slots.filter((_, j) => j !== i) }));
  }

  // Build the slotsJson the backend expects: each slot is { kind:'WORK'|'OFF', shiftPatternId? }.
  function buildSlotsJson(ed) {
    return ed.slots.map((s) => (s.kind === 'WORK'
      ? { kind: 'WORK', shiftPatternId: s.shiftPatternId || null }
      : { kind: 'OFF' }));
  }

  async function saveRotation() {
    if (!editor) return;
    setEditorErr('');
    if (!editor.name.trim()) { setEditorErr('Name is required.'); return; }
    if (!editor.id && !editor.code.trim()) { setEditorErr('Code is required.'); return; }
    if (!editor.anchorDate) { setEditorErr('Anchor date is required.'); return; }
    if (!editor.slots.length) { setEditorErr('Add at least one day to the cycle.'); return; }
    if (editor.slots.some((s) => s.kind === 'WORK' && !s.shiftPatternId)) { setEditorErr('Every WORK day needs a shift.'); return; }
    const slotsJson = buildSlotsJson(editor);
    setSaving(true);
    try {
      if (editor.id) {
        await patch(`/api/hr/attendance/rotations/${editor.id}`, {
          name: editor.name.trim(), anchorDate: editor.anchorDate, slotsJson, cycleLength: slotsJson.length,
        });
        setNotice('Rotation updated.');
      } else {
        await post('/api/hr/attendance/rotations', {
          code: editor.code.trim(), name: editor.name.trim(), anchorDate: editor.anchorDate, slotsJson, cycleLength: slotsJson.length,
        });
        setNotice('Rotation created.');
      }
      setEditor(null);
      loadRotations();
    } catch (e) { setEditorErr(e.message); } finally { setSaving(false); }
  }

  async function toggleRotation(r) {
    setError(''); setNotice('');
    try {
      await patch(`/api/hr/attendance/rotations/${r.id}`, { isActive: !r.isActive });
      setNotice(`Rotation ${r.isActive ? 'deactivated' : 'activated'}.`);
      loadRotations();
    } catch (e) { setError(e.message); }
  }
  async function deleteRotation(r) {
    setError(''); setNotice('');
    if (typeof window !== 'undefined' && !window.confirm(`Delete rotation "${r.name}"? This cannot be undone.`)) return;
    try {
      await del(`/api/hr/attendance/rotations/${r.id}`);
      setNotice('Rotation deleted.');
      loadRotations();
    } catch (e) { setError(e.message); }
  }

  const rotationCols = useMemo(() => [
    { key: 'code', header: 'Code' },
    { key: 'name', header: 'Name' },
    { key: 'cycleLength', header: 'Cycle', render: (r) => `${r.cycleLength} days` },
    { key: 'anchorDate', header: 'Anchor', render: (r) => fmtDate(r.anchorDate) },
    { key: 'isActive', header: 'Active', render: (r) => <StatusBadge status={r.isActive ? 'ACTIVE' : 'INACTIVE'} /> },
    {
      key: 'actions', header: '', render: (r) => (canManage ? (
        <div className="flex gap-2">
          <ActionButton onClick={() => applyRotation(r.id)}>Apply</ActionButton>
          <ActionButton onClick={() => openEditRotation(r)}>Edit</ActionButton>
          <ActionButton onClick={() => toggleRotation(r)}>{r.isActive ? 'Deactivate' : 'Activate'}</ActionButton>
          <ActionButton tone="danger" onClick={() => deleteRotation(r)}>Delete</ActionButton>
        </div>
      ) : null),
    },
  ], [canManage, from, to]);

  // ── Swaps ──
  const [swaps, setSwaps] = useState([]);
  const [swapLoading, setSwapLoading] = useState(false);
  const [swapStatus, setSwapStatus] = useState('PENDING');
  const loadSwaps = useCallback(() => {
    setSwapLoading(true);
    get('/api/hr/attendance/swaps', swapStatus ? { status: swapStatus } : {})
      .then((res) => setSwaps(asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setSwapLoading(false));
  }, [swapStatus]);
  useEffect(() => { if (tab === 'swaps') loadSwaps(); }, [tab, loadSwaps]);

  async function decideSwap(id, action) {
    setError(''); setNotice('');
    try {
      await post(`/api/hr/attendance/swaps/${id}/${action}`, {});
      setNotice(`Swap ${action === 'approve' ? 'approved' : 'rejected'}.`);
      loadSwaps();
    } catch (e) { setError(e.message); }
  }

  const swapCols = useMemo(() => [
    { key: 'requester', header: 'Requester', render: (r) => employeeLabel(r.requester) },
    { key: 'requesterDate', header: 'Gives', render: (r) => fmtDate(r.requesterDate) },
    { key: 'counterparty', header: 'Counterparty', render: (r) => employeeLabel(r.counterparty) },
    { key: 'counterpartyDate', header: 'Takes', render: (r) => fmtDate(r.counterpartyDate) },
    { key: 'counterpartyConsent', header: 'Consent', render: (r) => <StatusBadge status={r.counterpartyConsent} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '', render: (r) => ((canManage && r.status === 'PENDING') ? (
        <div className="flex gap-2">
          <ActionButton tone="positive" disabled={r.counterpartyConsent !== 'ACCEPTED'} onClick={() => decideSwap(r.id, 'approve')}>Approve</ActionButton>
          <ActionButton tone="danger" onClick={() => decideSwap(r.id, 'reject')}>Reject</ActionButton>
        </div>
      ) : null),
    },
  ], [canManage]);

  // ── Open shifts ──
  // Publish an unassigned shift to a claim pool. Employees claim it from ESS
  // (/me/shifts/open); each claim then rides the F10 OPEN_SHIFT_CLAIM chain and is
  // confirmed from the Approvals inbox — decisions do NOT happen here.
  //   GET  /api/hr/attendance/open-shifts?status → { items:[{ ...shift, date, headcount,
  //        filledCount, status(OPEN|FILLED|CANCELLED), shiftPattern,
  //        claimCounts:{ total,pending,approved,rejected,cancelled } }] }
  //   GET  /api/hr/attendance/open-shifts/:id     → one shift + its claims (employee+status)
  //   POST /api/hr/attendance/open-shifts         publish (canManageAttendance)
  //   POST /api/hr/attendance/open-shifts/:id/cancel  retire + withdraw pending claims
  const [openShifts, setOpenShifts] = useState([]);
  const [osLoading, setOsLoading] = useState(false);
  const [osStatus, setOsStatus] = useState('OPEN');
  const [osEditor, setOsEditor] = useState(null); // publish-modal draft
  const [osEditorErr, setOsEditorErr] = useState('');
  const [osSaving, setOsSaving] = useState(false);
  const [osDetail, setOsDetail] = useState(null); // drill-in { ...shift, claims }
  const [osDetailLoading, setOsDetailLoading] = useState(false);
  // Scope option sources for the publish modal (optional narrowing).
  const [entities, setEntities] = useState([]);
  const [locations, setLocations] = useState([]);
  const [departments, setDepartments] = useState([]);

  const loadOpenShifts = useCallback(() => {
    setOsLoading(true); setError('');
    get('/api/hr/attendance/open-shifts', osStatus ? { status: osStatus } : {})
      .then((res) => setOpenShifts(asList(res) || []))
      .catch((e) => setError(e.message))
      .finally(() => setOsLoading(false));
  }, [osStatus]);
  const loadScopeOptions = useCallback(() => {
    get('/api/hr/org/entities').then((r) => setEntities(asList(r))).catch(() => {});
    get('/api/hr/org/locations').then((r) => setLocations(asList(r))).catch(() => {});
    get('/api/hr/org/departments').then((r) => setDepartments(asList(r))).catch(() => {});
  }, []);
  useEffect(() => {
    if (tab === 'openshifts') { loadOpenShifts(); loadShifts(); loadScopeOptions(); }
  }, [tab, loadOpenShifts, loadShifts, loadScopeOptions]);

  function openPublish() {
    setOsEditorErr('');
    setOsEditor({ date: todayISO(), shiftPatternId: '', headcount: '1', entityId: '', locationId: '', departmentId: '', note: '' });
  }
  async function publishOpenShift() {
    if (!osEditor) return;
    setOsEditorErr('');
    if (!osEditor.date) { setOsEditorErr('Date is required.'); return; }
    if (!osEditor.shiftPatternId) { setOsEditorErr('Pick a shift pattern.'); return; }
    const hc = Number(osEditor.headcount);
    if (!Number.isInteger(hc) || hc < 1 || hc > 1000) { setOsEditorErr('Headcount must be a whole number 1–1000.'); return; }
    setOsSaving(true);
    try {
      await post('/api/hr/attendance/open-shifts', {
        date: osEditor.date,
        shiftPatternId: osEditor.shiftPatternId,
        headcount: hc,
        entityId: osEditor.entityId || null,
        locationId: osEditor.locationId || null,
        departmentId: osEditor.departmentId || null,
        note: osEditor.note.trim() || null,
      });
      setOsEditor(null);
      setNotice('Open shift published — employees can now claim it from ESS.');
      loadOpenShifts();
    } catch (e) { setOsEditorErr(e.message); } finally { setOsSaving(false); }
  }
  async function viewOpenShift(id) {
    setError(''); setOsDetail(null); setOsDetailLoading(true);
    try {
      const res = await get(`/api/hr/attendance/open-shifts/${id}`);
      setOsDetail(res);
    } catch (e) { setError(e.message); } finally { setOsDetailLoading(false); }
  }
  async function cancelOpenShift(row) {
    setError(''); setNotice('');
    if (typeof window !== 'undefined' && !window.confirm(`Cancel the open shift for ${fmtDate(row.date)}? Any pending claims are withdrawn.`)) return;
    try {
      await post(`/api/hr/attendance/open-shifts/${row.id}/cancel`, {});
      setNotice('Open shift cancelled.');
      loadOpenShifts();
      if (osDetail && osDetail.id === row.id) setOsDetail(null);
    } catch (e) { setError(e.message); }
  }

  const openShiftCols = useMemo(() => [
    { key: 'date', header: 'Date', render: (r) => fmtDate(r.date) },
    { key: 'pattern', header: 'Shift', render: (r) => (r.shiftPattern ? (r.shiftPattern.name || r.shiftPattern.code) : '—') },
    { key: 'headcount', header: 'Headcount', render: (r) => r.headcount },
    {
      key: 'filled', header: 'Filled / claims', render: (r) => {
        const cc = r.claimCounts || {};
        return (
          <span>{r.filledCount || 0}/{r.headcount}
            {cc.total ? <span className="text-xs text-gray-500"> · {cc.total} claim{cc.total === 1 ? '' : 's'}{cc.pending ? ` (${cc.pending} pending)` : ''}</span> : null}
          </span>
        );
      },
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '', render: (r) => (
        <div className="flex gap-2">
          <ActionButton onClick={() => viewOpenShift(r.id)}>View claims</ActionButton>
          {canManage && r.status !== 'CANCELLED' ? <ActionButton tone="danger" onClick={() => cancelOpenShift(r)}>Cancel</ActionButton> : null}
        </div>
      ),
    },
  ], [canManage, osDetail]);

  return (
    <div className="space-y-4">
      <PageHeader title="Roster" subtitle="Shift rosters, rotation patterns & swaps. Published rosters drive attendance; drafts do not." />
      <ModuleGuide
        id="roster"
        title="Plan and publish shift rosters"
        what="The Roster console is where you assign daily shifts (Morning, Afternoon, Night, OFF) to employees, apply repeating rotation rings, and approve shift swaps. Only published cells feed attendance derivation and payroll — drafts stay invisible to pay until you publish them."
        steps={[
          "On the Roster grid tab, set the From / To window (defaults to a fortnight) and click Refresh to load employees as rows and days as columns.",
          "Click any cell and pick a shift code (e.g. M/A/N) or OFF — this writes a MANUAL DRAFT. Night shifts show in amber.",
          "Use the Rotations tab to Apply a rotation ring across the in-scope population for the window; it bulk-generates DRAFT cells and reports any rest/night-consent violations.",
          "Resolve every violation (rest under 11h, missing night consent) before publishing.",
          "Back on the grid, click Publish window — only then do cells reach attendance and pay.",
          "On the Swaps tab, review pending swap requests and Approve (only when the counterparty has ACCEPTED) or Reject.",
        ]}
        example={<>For Acme India Pvt Ltd's Bengaluru support floor in June 2026, you apply the <b>4-on / 2-off rotation</b> across 18 agents for 1–14 Jun. The system writes <b>252 DRAFT cells</b> but flags <b>2 violations</b> — <b>Aarav Sharma</b> has only <b>9h rest</b> between a Night (N) and a Morning (M) shift. You swap his 5 Jun to OFF, clear the violation, then <b>Publish window</b> so attendance and the muster pick up the roster.</>}
        tips={[
          "Drafts never affect attendance or pay — if a shift looks wrong in payroll, check whether the cell was actually published.",
          "Times and dates render in Asia/Kolkata; a Night shift crossing midnight needs employee consent before it can be published.",
        ]}
      />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {error ? <ErrorBanner message={error} onDismiss={() => setError('')} /> : null}
      {notice ? <div className="rounded bg-emerald-50 text-emerald-800 px-3 py-2 text-sm">{notice}</div> : null}

      {tab === 'grid' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">From<input type="date" className="block border rounded px-2 py-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-sm">To<input type="date" className="block border rounded px-2 py-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <PrimaryButton onClick={loadGrid}>Refresh</PrimaryButton>
            {canManage ? <ActionButton onClick={publishWindow}>Publish window</ActionButton> : null}
          </div>
          <div className="text-xs text-gray-500" title="Only published cells reach attendance derivation and pay. Click a cell to set a shift or OFF (writes a manual DRAFT). Night shifts are amber.">
            DRAFT cells are hidden from attendance/pay until you Publish. Click a cell to set a shift or OFF. Night shifts are amber.
          </div>
          {gridLoading ? <Spinner /> : (
            <div className="overflow-x-auto border rounded">
              <table className="text-xs border-collapse">
                <thead>
                  <tr>
                    <th className="sticky left-0 bg-gray-50 border px-2 py-1 text-left">Employee</th>
                    {days.map((d) => <th key={d} className="border px-1 py-1 whitespace-nowrap" title={d}>{fmtDate(d)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {nodes.length === 0 ? (
                    <tr><td colSpan={days.length + 1} className="px-3 py-4 text-center text-gray-400">No employees in scope.</td></tr>
                  ) : nodes.map((n) => (
                    <tr key={n.employee.id}>
                      <td className="sticky left-0 bg-white border px-2 py-1 whitespace-nowrap">{employeeLabel(n.employee)}</td>
                      {days.map((d) => {
                        const cell = cellMap.get(`${n.employee.id}|${d}`);
                        const chip = cellChip(cell);
                        return (
                          <td key={d} className="border p-0.5 text-center" style={{ background: chip.color }} title={chip.title}>
                            {canManage ? (
                              <select
                                className="bg-transparent text-center w-full cursor-pointer"
                                style={{ color: chip.fg }}
                                value={cell && cell.dayType === 'OFF' ? 'OFF' : (cell && cell.shift ? cell.shift.id : '')}
                                onChange={(e) => setCell(n.employee.id, d, e.target.value)}
                              >
                                <option value="">·</option>
                                <option value="OFF">OFF</option>
                                {shifts.map((s) => <option key={s.id} value={s.id}>{(s.code || '').slice(0, 3)}</option>)}
                              </select>
                            ) : <span style={{ color: chip.fg }}>{chip.label}</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'rotations' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-gray-500">Apply a rotation ring to the in-scope population for the grid window ({from} → {to}). Generates DRAFT cells; resolve violations (rest &lt;11h, night-consent) before publishing.</div>
            {canManage ? <PrimaryButton onClick={openNewRotation}>New rotation</PrimaryButton> : null}
          </div>
          <DataTable columns={rotationCols} rows={rotations} loading={rotLoading} emptyText="No rotation templates yet." rowKey={(r) => r.id} />
          {applyResult ? (
            <div className="rounded border p-3 text-sm">
              <div>Written: <b>{applyResult.written || 0}</b> · Locked-skipped: {(applyResult.skippedLocked || []).length} · Violations: {(applyResult.violations || []).length}</div>
              {(applyResult.violations || []).length ? (
                <ul className="mt-2 list-disc list-inside text-amber-700">
                  {applyResult.violations.slice(0, 20).map((v, i) => <li key={i}>{v.code}{v.date ? ` · ${v.date}` : ''}{v.employeeId ? ` · emp ${String(v.employeeId).slice(0, 8)}` : ''}{v.restMinutes != null ? ` · ${v.restMinutes}m rest` : ''}</li>)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {canManage && editor ? (
        <Modal title={editor.id ? 'Edit rotation' : 'New rotation'} onClose={() => setEditor(null)} size="lg">
          <div className="space-y-3">
            <TextInput
              label="Code"
              value={editor.code}
              onChange={(v) => setEditor({ ...editor, code: v })}
              required={!editor.id}
              hint={editor.id ? 'Code is fixed after creation.' : 'A short, unique code, e.g. 4ON-2OFF.'}
              maxLength={editor.id ? undefined : 32}
            />
            <TextInput label="Name" value={editor.name} onChange={(v) => setEditor({ ...editor, name: v })} required hint="Display name, e.g. 4-on / 2-off support rotation." />
            <DateField label="Anchor date" value={editor.anchorDate} onChange={(v) => setEditor({ ...editor, anchorDate: v })} required hint="Day 1 of the cycle — phase aligns to this date." />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cycle pattern ({editor.slots.length} day{editor.slots.length === 1 ? '' : 's'})</label>
              <p className="text-xs text-gray-500 mb-2">The repeating ring of work / off days. A WORK day needs a shift; an OFF day is a weekly off.</p>
              <div className="space-y-2">
                {editor.slots.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-10">Day {i + 1}</span>
                    <select
                      className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                      value={s.kind}
                      onChange={(e) => setSlot(i, e.target.value === 'OFF' ? { kind: 'OFF', shiftPatternId: '' } : { kind: 'WORK' })}
                    >
                      <option value="WORK">Work</option>
                      <option value="OFF">Off</option>
                    </select>
                    {s.kind === 'WORK' ? (
                      <select
                        className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                        value={s.shiftPatternId}
                        onChange={(e) => setSlot(i, { shiftPatternId: e.target.value })}
                      >
                        <option value="">Select shift…</option>
                        {shifts.map((sp) => <option key={sp.id} value={sp.id}>{sp.code}{sp.name ? ` — ${sp.name}` : ''}</option>)}
                      </select>
                    ) : <span className="flex-1 text-sm text-gray-400">Weekly off</span>}
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-sm text-red-600 disabled:text-gray-300"
                      onClick={() => removeSlot(i)}
                      disabled={editor.slots.length <= 1}
                      title="Remove this day"
                    >×</button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-2">
                <ActionButton onClick={() => addSlot('WORK')}>+ Work day</ActionButton>
                <ActionButton onClick={() => addSlot('OFF')}>+ Off day</ActionButton>
              </div>
            </div>
            {editorErr ? <ErrorBanner message={editorErr} onDismiss={() => setEditorErr('')} /> : null}
          </div>
          <ModalActions>
            <button className="rounded-md px-3 py-1.5 text-sm text-gray-600" onClick={() => setEditor(null)}>Cancel</button>
            <PrimaryButton onClick={saveRotation} loading={saving}>{editor.id ? 'Save changes' : 'Create rotation'}</PrimaryButton>
          </ModalActions>
        </Modal>
      ) : null}

      {tab === 'swaps' && (
        <div className="space-y-3">
          <div className="flex items-end gap-3">
            <label className="text-sm">Status
              <select className="block border rounded px-2 py-1" value={swapStatus} onChange={(e) => setSwapStatus(e.target.value)}>
                <option value="">All</option>
                <option value="PENDING">Pending</option>
                <option value="APPROVED">Approved</option>
                <option value="REJECTED">Rejected</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </label>
            <PrimaryButton onClick={loadSwaps}>Refresh</PrimaryButton>
          </div>
          <DataTable columns={swapCols} rows={swaps} loading={swapLoading} emptyText="No swap requests." rowKey={(r) => r.id} />
        </div>
      )}

      {tab === 'openshifts' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex items-end gap-3">
              <label className="text-sm">Status
                <select className="block border rounded px-2 py-1" value={osStatus} onChange={(e) => setOsStatus(e.target.value)}>
                  <option value="">All</option>
                  <option value="OPEN">Open</option>
                  <option value="FILLED">Filled</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </label>
              <PrimaryButton onClick={loadOpenShifts}>Refresh</PrimaryButton>
            </div>
            {canManage ? <PrimaryButton onClick={openPublish}>Publish open shift</PrimaryButton> : null}
          </div>
          <div className="text-xs text-gray-500">
            Publish an unassigned shift to a claim pool. Employees claim it from ESS (My Shifts → Open shifts); each claim then lands in the Approvals inbox for you to confirm (OPEN_SHIFT_CLAIM). Cancelling withdraws any pending claims.
          </div>
          <DataTable columns={openShiftCols} rows={openShifts} loading={osLoading} emptyText="No open shifts." rowKey={(r) => r.id} />
        </div>
      )}

      {canManage && osEditor ? (
        <Modal title="Publish open shift" onClose={() => setOsEditor(null)} size="lg">
          <div className="space-y-3">
            <DateField label="Date" value={osEditor.date} onChange={(v) => setOsEditor({ ...osEditor, date: v })} required minToday hint="The day the shift needs to be filled." />
            <label className="block text-sm">
              <span className="text-gray-700 font-medium">Shift pattern</span>
              <select
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                value={osEditor.shiftPatternId}
                onChange={(e) => setOsEditor({ ...osEditor, shiftPatternId: e.target.value })}
              >
                <option value="">Select shift…</option>
                {shifts.filter((s) => s.isActive !== false).map((s) => (
                  <option key={s.id} value={s.id}>{s.code}{s.name ? ` — ${s.name}` : ''}{s.startTime ? ` (${s.startTime}–${s.endTime})` : ''}</option>
                ))}
              </select>
            </label>
            <TextInput label="Headcount" value={osEditor.headcount} onChange={(v) => setOsEditor({ ...osEditor, headcount: v })} type="number" min={1} max={1000} required hint="How many people can fill this shift (1–1000)." />
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm">
                <span className="text-gray-700 font-medium">Entity (optional)</span>
                <select
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={osEditor.entityId}
                  onChange={(e) => setOsEditor({ ...osEditor, entityId: e.target.value, locationId: '' })}
                >
                  <option value="">Whole company</option>
                  {entities.map((en) => <option key={en.id} value={en.id}>{en.code || en.legalName}{en.code && en.legalName ? ` — ${en.legalName}` : ''}</option>)}
                </select>
              </label>
              <label className="block text-sm">
                <span className="text-gray-700 font-medium">Location (optional)</span>
                <select
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={osEditor.locationId}
                  onChange={(e) => setOsEditor({ ...osEditor, locationId: e.target.value })}
                >
                  <option value="">All locations</option>
                  {(osEditor.entityId ? locations.filter((l) => l.entityId === osEditor.entityId) : locations).map((l) => <option key={l.id} value={l.id}>{l.name || l.code}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-sm">
              <span className="text-gray-700 font-medium">Department (optional)</span>
              <select
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                value={osEditor.departmentId}
                onChange={(e) => setOsEditor({ ...osEditor, departmentId: e.target.value })}
              >
                <option value="">All departments</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name || d.code}</option>)}
              </select>
            </label>
            <TextArea label="Note (optional)" value={osEditor.note} onChange={(v) => setOsEditor({ ...osEditor, note: v })} rows={2} hint="A short note shown to employees browsing open shifts." />
            {osEditorErr ? <ErrorBanner message={osEditorErr} onDismiss={() => setOsEditorErr('')} /> : null}
          </div>
          <ModalActions>
            <button className="rounded-md px-3 py-1.5 text-sm text-gray-600" onClick={() => setOsEditor(null)}>Cancel</button>
            <PrimaryButton onClick={publishOpenShift} loading={osSaving}>Publish</PrimaryButton>
          </ModalActions>
        </Modal>
      ) : null}

      {(osDetail || osDetailLoading) ? (
        <Modal title="Open shift claims" onClose={() => setOsDetail(null)} size="lg">
          {osDetailLoading || !osDetail ? <Spinner /> : (
            <div className="space-y-3">
              <div className="text-sm text-gray-700">
                <div className="font-semibold">{osDetail.shiftPattern ? (osDetail.shiftPattern.name || osDetail.shiftPattern.code) : 'Shift'} · {fmtDate(osDetail.date)}</div>
                <div className="text-xs text-gray-500 flex items-center gap-2 mt-1">
                  <span>Headcount {osDetail.headcount} · Filled {osDetail.filledCount || 0}</span>
                  <StatusBadge status={osDetail.status} />
                </div>
                {osDetail.note ? <div className="text-xs text-gray-500 mt-1">{osDetail.note}</div> : null}
              </div>
              <div className="text-xs text-gray-500">Claim decisions happen in the Approvals inbox (OPEN_SHIFT_CLAIM) — this view is read-only.</div>
              {(osDetail.claims || []).length === 0 ? (
                <div className="text-sm text-gray-400">No claims yet.</div>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-1 font-medium">Employee</th>
                      <th className="py-1 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {osDetail.claims.map((cl) => (
                      <tr key={cl.id} className="border-b last:border-b-0">
                        <td className="py-1.5">{employeeLabel(cl.employee)}</td>
                        <td className="py-1.5"><StatusBadge status={cl.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          <ModalActions>
            {canManage && osDetail && osDetail.status !== 'CANCELLED' ? <ActionButton tone="danger" onClick={() => cancelOpenShift(osDetail)}>Cancel shift</ActionButton> : null}
            <button className="rounded-md px-3 py-1.5 text-sm text-gray-600" onClick={() => setOsDetail(null)}>Close</button>
          </ModalActions>
        </Modal>
      ) : null}
    </div>
  );
}
