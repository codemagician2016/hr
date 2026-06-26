'use client';

// Performance & Goals (Feature 8) — HR-Admin + Manager console.
//   Tabs: Cycles · My Team Reviews · Setup · More.
//   - Cycles: list (GET /performance/cycles) + per-cycle completion (GET
//     /cycles/:id/stats, not N+1) + a create-cycle modal (POST /cycles with the
//     real contract). Launch (bulk-mint) + Release CTAs are gated on
//     canManagePerformanceCycle — a Manager sees the list read-only (server is the
//     real boundary; their list is TEAM-scoped anyway).
//   - My Team Reviews: the reviewer's queue (GET /performance/reviews?reviewerId=me,
//     SERVER-scoped — never trusts the query). Renders employee NAMES (joined
//     server-side), not raw UUIDs. Release gate holds: finalRating absent pre-release.
//   - Setup: rating scales (GET/POST /scales) + review templates (GET /templates) —
//     the config primitives a cycle binds.
//   - More: signposts the deferred admin surfaces (calibration, goals/OKR, 1:1s,
//     merit) that ship via API today and arrive in the console in a later phase —
//     no empty/dead tabs (see ROADMAP §8).
// All data is F1-scoped server-side; a Manager only ever sees their sub-tree.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, TextInput, DateField, Modal, ModalActions, formatAdminDate } from '@hr/ui';
import { get, post } from '@/lib/api';
import { asList, DataTable, PageHeader, Tabs, StatusBadge, ActionButton, employeeLabel } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

const REVIEW_STATUSES = ['', 'NOT_STARTED', 'SELF_SUBMITTED', 'MANAGER_SUBMITTED', 'CALIBRATED', 'ACKNOWLEDGED', 'CLOSED'];
const CYCLE_TYPES = ['ANNUAL', 'HALF_YEARLY', 'QUARTERLY', 'PROBATION', 'PROJECT', 'CONTINUOUS'];

// A sensible default 5-point rating scale so a cycle can be created end-to-end
// without first hand-authoring JSON. Operators can refine via the Setup tab.
const DEFAULT_RATING_SCALE = [
  { value: 1, label: 'Below expectations' },
  { value: 2, label: 'Partially meets' },
  { value: 3, label: 'Meets expectations' },
  { value: 4, label: 'Exceeds' },
  { value: 5, label: 'Outstanding' },
];

const TABS = [
  { key: 'cycles', label: 'Cycles' },
  { key: 'reviews', label: 'My Team Reviews' },
  { key: 'setup', label: 'Setup' },
  { key: 'more', label: 'More' },
];

// ── Create-cycle modal (POST /cycles) ────────────────────────────────────────
function CreateCycleModal({ scales, onClose, onCreated }) {
  const [draft, setDraft] = useState({ code: '', name: '', type: 'ANNUAL', periodStart: '', periodEnd: '', ratingScaleId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      // ratingScaleJson is required by the API; bind a saved scale's points when
      // chosen, else fall back to the default 5-point scale so creation never
      // dead-ends on missing config.
      const chosen = scales.find((s) => s.id === draft.ratingScaleId);
      const ratingScaleJson = chosen?.pointsJson || DEFAULT_RATING_SCALE;
      const payload = {
        code: draft.code, name: draft.name, type: draft.type,
        periodStart: draft.periodStart, periodEnd: draft.periodEnd,
        ratingScaleJson,
        ...(draft.ratingScaleId ? { ratingScaleId: draft.ratingScaleId } : {}),
      };
      const created = await post('/api/hr/performance/cycles', payload);
      onCreated(created);
    } catch (err) { setError(err.data?.message || err.message || 'Failed to create cycle.'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New review cycle" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Code" value={draft.code} onChange={(v) => setDraft((d) => ({ ...d, code: v }))} required />
          <label className="block text-sm">
            <span className="text-gray-700 font-medium">Type</span>
            <select value={draft.type} onChange={(e) => setDraft((d) => ({ ...d, type: e.target.value }))}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {CYCLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>
        <TextInput label="Name" value={draft.name} onChange={(v) => setDraft((d) => ({ ...d, name: v }))} required />
        <div className="grid grid-cols-2 gap-3">
          <DateField label="Period start" value={draft.periodStart} onChange={(v) => setDraft((d) => ({ ...d, periodStart: v }))} required />
          <DateField label="Period end" value={draft.periodEnd} onChange={(v) => setDraft((d) => ({ ...d, periodEnd: v }))} required />
        </div>
        <label className="block text-sm">
          <span className="text-gray-700 font-medium">Rating scale</span>
          <select value={draft.ratingScaleId} onChange={(e) => setDraft((d) => ({ ...d, ratingScaleId: e.target.value }))}
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">Default 5-point scale</option>
            {scales.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>Create cycle</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── Review-detail modal (manager rating · calibrate · sign-off) ───────────────
// The reviewer's action surface for a single team review. Which controls render
// is gated on BOTH the instance status (mirrors the backend state machine) and the
// caller's permission (calibrate/sign-off require canCalibrateRatings — the exact
// key the routes enforce: POST /reviews/:id/calibrate|sign-off → requirePermission
// ('canCalibrateRatings')). The server is the real boundary; this gating only keeps
// the operator from posting a transition that would 403/409.
function ReviewDetailModal({ review, canCalibrate, onClose, onActed }) {
  // managerRating + managerComments → POST /reviews/:id/manager (from SELF_SUBMITTED).
  const [managerRating, setManagerRating] = useState(review.managerRating ?? '');
  const [managerComments, setManagerComments] = useState(review.managerComments || '');
  // calibratedRating + reason → POST /reviews/:id/calibrate (from MANAGER_SUBMITTED/CALIBRATED).
  const [calibratedRating, setCalibratedRating] = useState(review.calibratedRating ?? '');
  const [calibrationReason, setCalibrationReason] = useState('');
  // finalRating → POST /reviews/:id/sign-off (from CALIBRATED). Optional; the server
  // defaults it to calibratedRating ?? managerRating when omitted.
  const [finalRating, setFinalRating] = useState(review.finalRating ?? '');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const status = review.status;
  const canSubmitManager = status === 'SELF_SUBMITTED' || status === 'NOT_STARTED';
  const canDoCalibrate = canCalibrate && (status === 'MANAGER_SUBMITTED' || status === 'CALIBRATED');
  const canSignOff = canCalibrate && status === 'CALIBRATED';

  // POST a transition; body is built per-action to match the controller contract.
  async function act(action, body) {
    setBusy(action); setError('');
    try {
      await post(`/api/hr/performance/reviews/${review.id}/${action}`, body);
      onActed();
    } catch (e) { setError(e.data?.message || e.message || `Failed to ${action}.`); }
    finally { setBusy(''); }
  }

  const numOrUndef = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));

  return (
    <Modal title="Review detail" onClose={onClose}>
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div><span className="text-gray-500">Employee</span><div className="font-medium text-gray-900">{review.employee ? employeeLabel(review.employee) : review.employeeId}</div></div>
          <div><span className="text-gray-500">Status</span><div><StatusBadge status={review.status} /></div></div>
          <div><span className="text-gray-500">Self rating</span><div className="font-medium text-gray-900">{review.selfRating ?? '—'}</div></div>
          <div><span className="text-gray-500">Manager rating</span><div className="font-medium text-gray-900">{review.managerRating ?? '—'}</div></div>
        </div>
        {review.selfComments && (
          <div className="text-sm">
            <span className="text-gray-500">Self comments</span>
            <p className="mt-0.5 text-gray-800 whitespace-pre-wrap rounded-lg bg-gray-50 px-3 py-2">{review.selfComments}</p>
          </div>
        )}

        {/* Manager rating — POST /reviews/:id/manager (assigned reviewer or HR) */}
        {canSubmitManager && (
          <section className="border-t border-gray-100 pt-3 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Submit manager review</h3>
            <TextInput label="Manager rating" type="number" min={1} max={5} step={0.5}
              value={managerRating} onChange={setManagerRating} />
            <label className="block text-sm">
              <span className="text-gray-700 font-medium">Manager comments</span>
              <textarea value={managerComments} onChange={(e) => setManagerComments(e.target.value)} rows={3}
                className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </label>
            <ModalActions>
              <PrimaryButton type="button" loading={busy === 'manager'}
                onClick={() => act('manager', { managerRating: numOrUndef(managerRating), managerComments: managerComments || undefined })}>
                Submit manager rating
              </PrimaryButton>
            </ModalActions>
          </section>
        )}

        {/* Calibrate — POST /reviews/:id/calibrate (canCalibrateRatings) */}
        {canDoCalibrate && (
          <section className="border-t border-gray-100 pt-3 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Calibrate</h3>
            <TextInput label="Calibrated rating" type="number" min={1} max={5} step={0.5}
              value={calibratedRating} onChange={setCalibratedRating} />
            <TextInput label="Reason" value={calibrationReason} onChange={setCalibrationReason}
              hint="Recorded on the calibration ledger." />
            <ModalActions>
              <PrimaryButton type="button" loading={busy === 'calibrate'}
                onClick={() => act('calibrate', { calibratedRating: numOrUndef(calibratedRating), reason: calibrationReason || undefined })}>
                Calibrate
              </PrimaryButton>
            </ModalActions>
          </section>
        )}

        {/* Sign-off — POST /reviews/:id/sign-off (canCalibrateRatings). Locks the
            final rating; the org-wide cycle Release is what publishes it. */}
        {canSignOff && (
          <section className="border-t border-gray-100 pt-3 space-y-2">
            <h3 className="text-sm font-semibold text-gray-900">Sign off</h3>
            <TextInput label="Final rating" type="number" min={1} max={5} step={0.5}
              value={finalRating} onChange={setFinalRating}
              hint="Optional — defaults to the calibrated (or manager) rating." />
            <p className="text-xs text-gray-400">Sign-off locks the rating; it stays hidden from the employee until you Release the cycle.</p>
            <ModalActions>
              <PrimaryButton type="button" loading={busy === 'sign-off'}
                onClick={() => act('sign-off', { finalRating: numOrUndef(finalRating) })}>
                Sign off
              </PrimaryButton>
            </ModalActions>
          </section>
        )}

        {!canSubmitManager && !canDoCalibrate && !canSignOff && (
          <p className="border-t border-gray-100 pt-3 text-sm text-gray-500">No actions are available for this review at its current status{canCalibrate ? '.' : ' with your permissions.'}</p>
        )}

        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Close</button>
        </ModalActions>
      </div>
    </Modal>
  );
}

// ── Setup tab: rating scales + review templates ──────────────────────────────
function SetupTab({ canConfig }) {
  const [scales, setScales] = useState(null);
  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState('');
  const [showScale, setShowScale] = useState(false);

  const load = useCallback(() => {
    setError('');
    get('/api/hr/performance/scales').then((r) => setScales(asList(r))).catch((e) => { setError(e.message || 'Failed to load scales.'); setScales([]); });
    get('/api/hr/performance/templates').then((r) => setTemplates(asList(r))).catch(() => setTemplates([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      {error && <ErrorBanner message={error} />}

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">Rating scales</h2>
          {canConfig && <ActionButton onClick={() => setShowScale(true)}>New scale</ActionButton>}
        </div>
        <DataTable
          columns={[
            { key: 'name', header: 'Scale', render: (s) => <span className="font-medium text-gray-900">{s.name}</span> },
            { key: 'points', header: 'Points', render: (s) => (Array.isArray(s.pointsJson) ? s.pointsJson.length : '—') },
            { key: 'half', header: 'Half points', render: (s) => (s.allowsHalfPoints ? 'Yes' : 'No') },
            { key: 'created', header: 'Created', render: (s) => formatAdminDate(s.createdAt) },
          ]}
          rows={scales} loading={scales === null} emptyText="No rating scales yet — create one to bind to a cycle." />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-900 mb-2">Review templates</h2>
        <DataTable
          columns={[
            { key: 'name', header: 'Template', render: (t) => <span className="font-medium text-gray-900">{t.name}</span> },
            { key: 'sections', header: 'Sections', render: (t) => (Array.isArray(t.sectionsJson) ? t.sectionsJson.length : (t.sectionsJson ? '—' : 0)) },
            { key: 'created', header: 'Created', render: (t) => formatAdminDate(t.createdAt) },
          ]}
          rows={templates} loading={templates === null} emptyText="No review templates yet." />
        <p className="text-xs text-gray-400 mt-2">Template authoring (sections/competencies editor) is available via the API; the in-console editor lands in a later phase.</p>
      </section>

      {showScale && <CreateScaleModal onClose={() => setShowScale(false)} onSaved={() => { setShowScale(false); load(); }} />}
    </div>
  );
}

// ── Create rating-scale modal (POST /scales) ─────────────────────────────────
function CreateScaleModal({ onClose, onSaved }) {
  const [name, setName] = useState('');
  const [points, setPoints] = useState(DEFAULT_RATING_SCALE.map((p) => ({ ...p })));
  const [allowsHalfPoints, setAllowsHalfPoints] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function setLabel(i, label) { setPoints((ps) => ps.map((p, j) => (j === i ? { ...p, label } : p))); }

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await post('/api/hr/performance/scales', { name, pointsJson: points, allowsHalfPoints });
      onSaved();
    } catch (err) { setError(err.data?.message || err.message || 'Failed to create scale.'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New rating scale" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <TextInput label="Scale name" value={name} onChange={setName} required />
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-gray-700">Points</span>
          {points.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-7 text-center text-sm font-semibold text-gray-500">{p.value}</span>
              <input value={p.label} onChange={(e) => setLabel(i, e.target.value)} className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
            </div>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allowsHalfPoints} onChange={(e) => setAllowsHalfPoints(e.target.checked)} />
          <span className="text-gray-700">Allow half points (e.g. 3.5)</span>
        </label>
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>Create scale</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

// ── More tab: deferred admin surfaces (no dead ends; clearly signposted) ──────
function MoreTab() {
  const surfaces = [
    { name: 'Calibration sessions', api: 'GET/POST /performance/calibration/sessions', note: 'HR + skip-level rating calibration roster.' },
    { name: 'Goals & OKRs', api: 'GET/POST /performance/goals · /objectives', note: 'Goal/objective authoring, key results, check-ins.' },
    { name: '1:1s', api: 'GET/POST /performance/one-on-ones', note: 'Manager ↔ report meeting notes (private notes never leave this surface).' },
    { name: 'Merit recommendations', api: 'GET /performance/merit-recommendations', note: 'Review → compensation hand-off (apply lives in Compensation).' },
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        These surfaces are live in the API and ship to this console in a later phase (see ROADMAP §8).
        The review operations above — cycles, launch/release, and team reviews — are fully wired today.
      </p>
      <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-200 overflow-hidden bg-white">
        {surfaces.map((s) => (
          <li key={s.name} className="px-4 py-3 flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-gray-900">{s.name}</div>
              <div className="text-xs text-gray-500 mt-0.5">{s.note}</div>
            </div>
            <code className="text-[11px] text-gray-400 whitespace-nowrap mt-0.5">{s.api}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PerformancePage() {
  const [tab, setTab] = useState('cycles');
  const [perms, setPerms] = useState(null);
  const [cycles, setCycles] = useState(null);
  const [statsById, setStatsById] = useState({});
  const [scales, setScales] = useState([]);
  const [reviews, setReviews] = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [openReview, setOpenReview] = useState(null);

  const canConfig = hasPermission(perms, 'canManagePerformanceCycle');
  const canCalibrate = hasPermission(perms, 'canCalibrateRatings');

  const loadCycles = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const me = await get('/api/auth/me').catch(() => null);
      setPerms(permissionsFromSession(me?.user || me));
      const data = await get('/api/hr/performance/cycles');
      const items = asList(data);
      setCycles(items);
      // Rating scales feed the create-cycle modal's scale picker.
      get('/api/hr/performance/scales').then((r) => setScales(asList(r))).catch(() => {});
      // Per-cycle completion stats (one call each — small N, not row-level N+1).
      const stats = {};
      await Promise.all(items.map(async (c) => {
        try { stats[c.id] = await get(`/api/hr/performance/cycles/${c.id}/stats`); } catch { /* ignore */ }
      }));
      setStatsById(stats);
    } catch (e) { setError(e.message || 'Failed to load cycles.'); setCycles([]); }
    finally { setLoading(false); }
  }, []);

  const loadReviews = useCallback(async () => {
    setLoading(true); setError('');
    try {
      // reviewerId=me is resolved server-side from the session (not trusted here).
      const data = await get('/api/hr/performance/reviews', { reviewerId: 'me', status: statusFilter });
      setReviews(asList(data));
    } catch (e) { setError(e.message || 'Failed to load reviews.'); setReviews([]); }
    finally { setLoading(false); }
  }, [statusFilter]);

  useEffect(() => {
    if (tab === 'cycles') loadCycles();
    else if (tab === 'reviews') loadReviews();
    else setLoading(false);
  }, [tab, loadCycles, loadReviews]);

  async function act(cycleId, action) {
    setBusyId(cycleId); setError('');
    try {
      await post(`/api/hr/performance/cycles/${cycleId}/${action}`, {});
      await loadCycles();
    } catch (e) { setError(e.data?.message || e.message || `Failed to ${action} cycle.`); }
    finally { setBusyId(''); }
  }

  const cycleColumns = [
    { key: 'code', header: 'Code', render: (c) => <span className="font-medium text-gray-900">{c.code}</span> },
    { key: 'name', header: 'Name', render: (c) => c.name },
    { key: 'type', header: 'Type', render: (c) => c.type || '—' },
    { key: 'period', header: 'Period', render: (c) => `${formatAdminDate(c.periodStart)} – ${formatAdminDate(c.periodEnd)}` },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} /> },
    {
      key: 'completion', header: 'Completion', render: (c) => {
        const s = statsById[c.id];
        if (!s) return '—';
        const done = (s.byStatus?.CLOSED || 0) + (s.byStatus?.ACKNOWLEDGED || 0);
        return `${done}/${s.total || 0}${s.releasedAt ? ' · released' : ''}`;
      },
    },
    {
      key: 'actions', header: '', render: (c) => canConfig ? (
        <div className="flex items-center gap-1.5 justify-end">
          <ActionButton tone="neutral" disabled={busyId === c.id} onClick={() => act(c.id, 'launch')}>Launch</ActionButton>
          <ActionButton tone="positive" disabled={busyId === c.id} onClick={() => act(c.id, 'release')}>Release</ActionButton>
        </div>
      ) : <span className="text-xs text-gray-400">read-only</span>,
    },
  ];

  const reviewColumns = [
    { key: 'employee', header: 'Employee', render: (r) => <span className="font-medium text-gray-900">{r.employee ? employeeLabel(r.employee) : r.employeeId}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'self', header: 'Self', render: (r) => (r.selfRating ?? '—') },
    { key: 'manager', header: 'Manager', render: (r) => (r.managerRating ?? '—') },
    // finalRating is ABSENT pre-release (server omits it) — shown only when present.
    { key: 'final', header: 'Final', render: (r) => (r.finalRating ?? (r.releasedAt ? '—' : 'pending release')) },
    {
      key: 'actions', header: '', render: (r) => (
        <div className="flex items-center justify-end">
          <ActionButton tone="neutral" onClick={() => setOpenReview(r)}>Open</ActionButton>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Performance & Goals"
        subtitle="Review cycles, ratings, and your team's reviews"
        actions={tab === 'cycles' && canConfig ? <PrimaryButton onClick={() => setShowNew(true)}>New cycle</PrimaryButton> : null}
      />
      <ModuleGuide
        id="performance"
        title="Run a review cycle, then release ratings to your team"
        what="This is where you set up appraisal cycles, track how many reviews are done, and work your own queue of team reviews. A cycle bundles a rating scale and review template over a period, then mints a review for every in-scope employee."
        steps={[
          'On the Cycles tab, click New cycle — give it a code, name, type (Annual, Half-yearly, Probation…), period start/end, and pick a rating scale (or keep the default 5-point scale).',
          'Use Launch to bulk-mint a review for every in-scope employee; the Completion column then tracks done-vs-total as self and manager submissions come in.',
          'Open My Team Reviews to work your own reviewer queue — filter by status (Self submitted, Manager submitted, Calibrated…) and see employee names, self and manager ratings.',
          'When ratings are final, click Release on the cycle to publish final ratings — Final stays "pending release" until you do this.',
          'Use Setup to define rating scales and review templates; the More tab signposts calibration, goals/OKRs, 1:1s, and merit (live via API, console UI later).',
        ]}
        example={<>For <b>Acme India Pvt Ltd</b>, you create cycle <b>FY25-ANNUAL</b> (Annual, 01 Apr 2025 – 31 Mar 2026) on the default 5-point scale, then <b>Launch</b> it — minting a review for <b>Aarav Sharma</b> and 240 others. Aarav self-rates <b>4</b>, his manager submits <b>4</b>; completion shows <b>180/241</b>. Once calibration is done you hit <b>Release</b> and his <b>Final</b> rating publishes.</>}
        tips={[
          'Launch and Release only appear if you hold canManagePerformanceCycle — a Manager sees the list read-only and their cycles/reviews are already scoped to their team.',
          'Final rating is intentionally hidden until you Release — don\'t expect a number in the Final column before then, even if manager ratings are in.',
        ]}
      />
      {error ? <ErrorBanner message={error} /> : null}
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'cycles' && (
        <DataTable columns={cycleColumns} rows={cycles} loading={loading || cycles === null} emptyText="No review cycles yet — create one to begin." />
      )}

      {tab === 'reviews' && (
        <div>
          <div className="my-3">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
            </select>
          </div>
          <DataTable columns={reviewColumns} rows={reviews} loading={loading || reviews === null} emptyText="No reviews assigned to you." />
        </div>
      )}

      {tab === 'setup' && <SetupTab canConfig={canConfig} />}
      {tab === 'more' && <MoreTab />}

      {showNew && (
        <CreateCycleModal
          scales={scales}
          onClose={() => setShowNew(false)}
          onCreated={() => { setShowNew(false); loadCycles(); }}
        />
      )}

      {openReview && (
        <ReviewDetailModal
          review={openReview}
          canCalibrate={canCalibrate}
          onClose={() => setOpenReview(null)}
          // Refresh the queue after a transition so status/ratings reflect the change.
          onActed={() => { setOpenReview(null); loadReviews(); }}
        />
      )}
    </div>
  );
}
