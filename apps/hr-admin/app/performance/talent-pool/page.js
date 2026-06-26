'use client';

// Talent pool & succession (Feature 34) — HR talent (canManageSuccession to write;
// canViewTeamPerformance to read, server-scoped to the sub-tree).
//   - Pool tab: filterable list of TalentTags (HIPO / flight-risk / promotion-ready /
//     key persons). Add/retire a tag.
//   - Succession tab: group-by position — each position → its successors with readiness
//     chips (Ready now / 1–2 yr / 3+ yr).
//   The tag never reaches the subject (server confidentiality); this is an HR/manager
//   talent surface only.

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, PrimaryButton, Modal, ModalActions, TextInput, TextArea } from '@hr/ui';
import { ReadinessBadge, TalentTagChip } from '@hr/ui';
import { get, post, patch } from '@/lib/api';
import { asList, PageHeader, Tabs, DataTable, ActionButton, employeeLabel } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

const KINDS = ['HIPO', 'FLIGHT_RISK', 'PROMOTION_READY', 'SUCCESSOR', 'KEY_PERSON'];
const READINESS = ['', 'READY_NOW', 'READY_1_2_YR', 'READY_3_PLUS_YR'];
const TABS = [{ key: 'pool', label: 'Talent pool' }, { key: 'succession', label: 'Succession' }];

function TagModal({ onClose, onSaved }) {
  const [draft, setDraft] = useState({ employeeId: '', kind: 'HIPO', positionRef: '', readiness: '', note: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isSuccessor = draft.kind === 'SUCCESSOR';
  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await post('/api/hr/ninebox/talent-tags', {
        employeeId: draft.employeeId, kind: draft.kind,
        ...(draft.positionRef ? { positionRef: draft.positionRef } : {}),
        ...(draft.readiness ? { readiness: draft.readiness } : {}),
        ...(draft.note ? { note: draft.note } : {}),
      });
      onSaved();
    } catch (err) { setError(err.data?.message || err.message || 'Save failed.'); setSaving(false); }
  }
  return (
    <Modal title="New talent tag" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <ErrorBanner message={error} />}
        <TextInput label="Employee ID" value={draft.employeeId} onChange={(v) => setDraft((d) => ({ ...d, employeeId: v }))} required />
        <label className="block text-sm"><span className="text-gray-700 font-medium">Kind</span>
          <select value={draft.kind} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        {isSuccessor && <TextInput label="Position (successor for)" value={draft.positionRef} onChange={(v) => setDraft((d) => ({ ...d, positionRef: v }))} required />}
        {(isSuccessor || draft.kind === 'PROMOTION_READY') && (
          <label className="block text-sm"><span className="text-gray-700 font-medium">Readiness</span>
            <select value={draft.readiness} onChange={(e) => setDraft((d) => ({ ...d, readiness: e.target.value }))} className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {READINESS.map((r) => <option key={r} value={r}>{r || '—'}</option>)}
            </select>
          </label>
        )}
        <TextArea label="Note" value={draft.note} onChange={(v) => setDraft((d) => ({ ...d, note: v }))} rows={2} />
        <ModalActions>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>Create tag</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

export default function TalentPoolPage() {
  const [tab, setTab] = useState('pool');
  const [perms, setPerms] = useState(null);
  const [tags, setTags] = useState(null);
  const [succession, setSuccession] = useState(null);
  const [kindFilter, setKindFilter] = useState('');
  const [error, setError] = useState('');
  const [show, setShow] = useState(false);

  const canSucceed = hasPermission(perms, 'canManageSuccession');

  const loadPool = useCallback(async () => {
    setError('');
    try { setTags(asList(await get('/api/hr/ninebox/talent-tags', { kind: kindFilter, active: true }))); }
    catch (e) { setError(e.message || 'Failed to load.'); setTags([]); }
  }, [kindFilter]);
  const loadSuccession = useCallback(async () => {
    setError('');
    try { setSuccession(await get('/api/hr/ninebox/succession')); }
    catch (e) { setError(e.message || 'Failed to load.'); setSuccession({ byPosition: {}, total: 0 }); }
  }, []);

  useEffect(() => {
    (async () => {
      const me = await get('/api/auth/me').catch(() => null);
      setPerms(permissionsFromSession(me?.user || me));
    })();
  }, []);
  useEffect(() => { if (tab === 'pool') loadPool(); else loadSuccession(); }, [tab, loadPool, loadSuccession]);

  async function retire(id, version) {
    setError('');
    try { await patch(`/api/hr/ninebox/talent-tags/${id}`, { isActive: false, version }); loadPool(); }
    catch (e) { setError(e.data?.message || e.message || 'Retire failed.'); }
  }

  return (
    <div>
      <PageHeader
        title="Talent pool & succession"
        subtitle="High-potential, flight-risk, promotion-ready + successor nominations"
        actions={canSucceed ? <PrimaryButton onClick={() => setShow(true)}>New tag</PrimaryButton> : null}
      />
      <ModuleGuide
        id="performance-talent-pool"
        title="Tag your high-potentials and build a succession bench"
        what="A confidential HR/manager-only surface to flag key talent — high-potential (HIPO), flight-risk, promotion-ready, key persons — and nominate successors for critical positions. Tags never reach the employee; they help you plan promotions, retention and cover for the next CTC review or org change."
        steps={[
          'Use the Talent pool tab to see existing tags; filter by kind (HIPO, Flight risk, Promotion ready, Key person, Successor).',
          'Click New tag, enter the Employee ID, and pick a Kind.',
          'For a Successor or Promotion-ready tag, add the Position and a Readiness (Ready now / 1–2 yr / 3+ yr).',
          'Add an optional confidential Note (e.g. retention risk, comp gap) and Create tag.',
          'Switch to the Succession tab to view the bench grouped by position with readiness chips.',
          'Retire a tag from the pool list when it no longer applies (e.g. after the promotion lands).',
        ]}
        example={<>HR tags <b>Aarav Sharma</b> (Sr. Engineer, Acme India Pvt Ltd, <b>₹24,00,000 CTC</b>) as <b>FLIGHT_RISK</b> with a note "comp 12% below market — review in June 2026 cycle", and as a <b>SUCCESSOR</b> for <b>Engineering Manager — Pune</b> with readiness <b>Ready 1–2 yr</b>. The Succession tab then shows him on the Engineering Manager bench.</>}
        tips={[
          'Tags are server-confidential — the employee never sees them, so be candid but professional in notes.',
          'Only the SUCCESSOR kind requires a Position; readiness shows for Successor and Promotion-ready tags.',
          'You need canManageSuccession to create or retire tags; canViewTeamPerformance is read-only and scoped to your reporting sub-tree.',
        ]}
      />
      {error ? <ErrorBanner message={error} /> : null}
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'pool' && (
        <div>
          <div className="my-3">
            <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
              <option value="">All kinds</option>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <DataTable
            columns={[
              { key: 'employee', header: 'Employee', render: (t) => <span className="font-medium text-gray-900">{t.employee ? employeeLabel(t.employee) : t.employeeId}</span> },
              { key: 'kind', header: 'Tag', render: (t) => <TalentTagChip kind={t.kind} /> },
              { key: 'position', header: 'Position', render: (t) => t.positionRef || '—' },
              { key: 'readiness', header: 'Readiness', render: (t) => <ReadinessBadge value={t.readiness} /> },
              { key: 'note', header: 'Note', render: (t) => t.note || '—' },
              { key: 'actions', header: '', render: (t) => canSucceed ? <ActionButton tone="danger" onClick={() => retire(t.id, t.version)}>Retire</ActionButton> : null },
            ]}
            rows={tags} loading={tags === null} emptyText="No talent tags yet." />
        </div>
      )}

      {tab === 'succession' && (
        <div className="space-y-4 mt-3">
          {succession === null ? <div className="text-sm text-gray-400 py-6">Loading…</div> : (
            Object.keys(succession.byPosition || {}).length === 0 ? (
              <div className="text-sm text-gray-500 py-6">No successors nominated yet. Tag an employee as SUCCESSOR with a position to build the bench.</div>
            ) : (
              Object.entries(succession.byPosition).map(([position, list]) => (
                <div key={position} className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
                  <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 text-sm font-semibold text-gray-900">{position}</div>
                  <ul className="divide-y divide-gray-100">
                    {list.map((t) => (
                      <li key={t.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                        <span className="text-sm text-gray-800">{t.employee ? employeeLabel(t.employee) : t.employeeId}</span>
                        <ReadinessBadge value={t.readiness} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )
          )}
        </div>
      )}

      {show && <TagModal onClose={() => setShow(false)} onSaved={() => { setShow(false); loadPool(); }} />}
    </div>
  );
}
