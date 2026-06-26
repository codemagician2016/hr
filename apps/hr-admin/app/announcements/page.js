'use client';

// Announcements admin — company news feed authoring (Engagement Cycle 1).
// Lists all announcements (any status, pinned+newest first, server-paginated) and
// drives the full lifecycle against /api/hr/announcements:
//   create DRAFT → publish (→ fan-out notification) → pin/unpin → archive / delete.
// Audience targeting: ALL | by ENTITY | by DEPARTMENT | SPECIFIC employees, scheduled
// publishedAt + optional expiresAt. Gated server-side on canManageAnnouncements
// (Owner + HR-Admin); this page mirrors that as a nav gate.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, formatAdminDate } from '@hr/ui';
import { get, post, patch, del } from '@/lib/api';
import { DataTable, PageHeader, StatusBadge, ActionButton, ServerPagination } from '@/lib/ui';
import { InfoTip, LabelWithTip } from '../letters/lib';
import ModuleGuide from '@/components/ModuleGuide';
import EmployeeSearchSelect, { employeeName } from '@/components/EmployeeSearchSelect';

const STATUSES = ['', 'DRAFT', 'PUBLISHED', 'ARCHIVED'];
const CATEGORIES = ['NEWS', 'POLICY', 'EVENT', 'HOLIDAY', 'CELEBRATION', 'GENERAL'];
const SCOPES = [
  { value: 'ALL', label: 'Everyone (whole company)' },
  { value: 'ENTITY', label: 'By entity / legal company' },
  { value: 'DEPARTMENT', label: 'By department' },
  { value: 'SPECIFIC', label: 'Specific employees' },
];
const PAGE_SIZES = [25, 50, 100];

const EMPTY_FORM = {
  id: null,
  title: '',
  bodyRichText: '',
  category: 'NEWS',
  audienceScope: 'ALL',
  audienceEntityIds: [],
  audienceDeptIds: [],
  audienceEmployeeIds: [],
  // Display-name cache for the specific-employee chips, keyed by employee id.
  // Not sent to the API — only IDs are persisted; this is purely for the UI.
  audienceEmployeeLabels: {},
  pinned: false,
  publishedAt: '',
  expiresAt: '',
};

function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // datetime-local wants YYYY-MM-DDTHH:mm in local time.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AnnouncementsPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  // Reference data for the audience picker (cached once).
  const [entities, setEntities] = useState([]);
  const [departments, setDepartments] = useState([]);

  // Editor modal state.
  const [editing, setEditing] = useState(null); // null = closed; object = form
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    get('/api/hr/announcements', { status, page, pageSize })
      .then(setData)
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load announcements.'))
      .finally(() => setLoading(false));
  }, [status, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    // Best-effort reference data — a failure just disables the narrowed scopes.
    get('/api/hr/org/entities').then((r) => setEntities(r.items || r || [])).catch(() => {});
    get('/api/hr/org/departments').then((r) => setDepartments(r.items || r || [])).catch(() => {});
  }, []);

  const items = data?.items || [];
  const total = data?.total ?? items.length;

  function openCreate() { setFormError(''); setEditing({ ...EMPTY_FORM }); }
  function openEdit(row) {
    setFormError('');
    setEditing({
      id: row.id,
      title: row.title || '',
      bodyRichText: row.bodyRichText || '',
      category: row.category || 'NEWS',
      audienceScope: row.audienceScope || 'ALL',
      audienceEntityIds: row.audienceEntityIds || [],
      audienceDeptIds: row.audienceDeptIds || [],
      audienceEmployeeIds: row.audienceEmployeeIds || [],
      // The list endpoint returns IDs only; resolve friendly names lazily as the
      // admin re-picks. Seed any labels the row already carries (if the API ever
      // expands them), else chips fall back to the raw ID.
      audienceEmployeeLabels: row.audienceEmployeeLabels || {},
      pinned: !!row.pinned,
      publishedAt: toLocalInputValue(row.publishedAt),
      expiresAt: toLocalInputValue(row.expiresAt),
    });
  }
  function closeEditor() { setEditing(null); }

  async function act(id, action) {
    setBusyId(id);
    setError('');
    try {
      if (action === 'delete') await del(`/api/hr/announcements/${id}`);
      else await post(`/api/hr/announcements/${id}/${action}`);
      load();
    } catch (e) {
      setError(e.data?.message || e.message || `Failed to ${action} announcement.`);
    } finally {
      setBusyId('');
    }
  }

  async function save() {
    setSaving(true);
    setFormError('');
    const f = editing;
    const payload = {
      title: f.title.trim(),
      bodyRichText: f.bodyRichText,
      category: f.category,
      audienceScope: f.audienceScope,
      audienceEntityIds: f.audienceScope === 'ENTITY' ? f.audienceEntityIds : [],
      audienceDeptIds: f.audienceScope === 'DEPARTMENT' ? f.audienceDeptIds : [],
      audienceEmployeeIds: f.audienceScope === 'SPECIFIC' ? f.audienceEmployeeIds : [],
      pinned: f.pinned,
      publishedAt: f.publishedAt ? new Date(f.publishedAt).toISOString() : null,
      expiresAt: f.expiresAt ? new Date(f.expiresAt).toISOString() : null,
    };
    try {
      if (f.id) await patch(`/api/hr/announcements/${f.id}`, payload);
      else await post('/api/hr/announcements', payload);
      closeEditor();
      load();
    } catch (e) {
      setFormError(e.data?.message || e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }

  function audienceLabel(row) {
    if (row.audienceScope === 'ALL') return 'Everyone';
    if (row.audienceScope === 'ENTITY') return `${(row.audienceEntityIds || []).length} entity(ies)`;
    if (row.audienceScope === 'DEPARTMENT') return `${(row.audienceDeptIds || []).length} dept(s)`;
    if (row.audienceScope === 'SPECIFIC') return `${(row.audienceEmployeeIds || []).length} employee(s)`;
    return '—';
  }

  const columns = useMemo(() => [
    {
      key: 'title', header: 'Title',
      render: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {r.pinned && <span title="Pinned" aria-label="Pinned" className="text-amber-500">📌</span>}
            <span className="font-medium text-gray-900 truncate">{r.title}</span>
          </div>
          <div className="text-xs text-gray-400">{r.category}</div>
        </div>
      ),
    },
    { key: 'audience', header: 'Audience', render: (r) => <span className="text-gray-600">{audienceLabel(r)}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'publishedAt', header: 'Goes live', render: (r) => (r.publishedAt ? formatAdminDate(r.publishedAt) : '—') },
    { key: 'expiresAt', header: 'Expires', render: (r) => (r.expiresAt ? formatAdminDate(r.expiresAt) : 'Never') },
    {
      key: 'actions', header: '', className: 'text-right', cellClassName: 'text-right',
      render: (r) => (
        <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
          <ActionButton onClick={() => openEdit(r)} disabled={busyId === r.id}>Edit</ActionButton>
          {r.status !== 'PUBLISHED' && (
            <ActionButton tone="positive" onClick={() => act(r.id, 'publish')} disabled={busyId === r.id}>Publish</ActionButton>
          )}
          <ActionButton onClick={() => act(r.id, r.pinned ? 'unpin' : 'pin')} disabled={busyId === r.id}>
            {r.pinned ? 'Unpin' : 'Pin'}
          </ActionButton>
          {r.status === 'PUBLISHED' && (
            <ActionButton onClick={() => act(r.id, 'archive')} disabled={busyId === r.id}>Archive</ActionButton>
          )}
          {r.status === 'DRAFT' && (
            <ActionButton tone="danger" onClick={() => act(r.id, 'delete')} disabled={busyId === r.id}>Delete</ActionButton>
          )}
        </div>
      ),
    },
  ], [busyId]);

  return (
    <div>
      <PageHeader
        title="Announcements"
        subtitle="Company news feed — what every employee sees on their portal."
        actions={
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg px-3 py-2 text-sm font-medium text-white"
            style={{ background: 'var(--theme-primary)' }}
          >
            + New announcement
          </button>
        }
      />

      <ModuleGuide
        id="announcements"
        title="Post a company announcement and choose who sees it"
        what="The company news feed your people see on their portal. Author a note once, target the right audience (everyone, an entity, a department, or named employees), then publish to push it live and notify them."
        steps={[
          'Click "+ New announcement" and write a clear Title and Message.',
          'Pick a Category (News, Policy, Event, Holiday, Celebration) so employees can filter the feed.',
          'Set the Audience — Everyone, by legal entity, by department, or specific employees.',
          'Optionally set "Go live at" to schedule it and "Expires at" to auto-drop it off the feed.',
          'Save the draft, then use Publish on the list row to go live and fan-out the notification.',
          'Pin time-sensitive notices to keep them at the top; Archive once they are no longer relevant.',
        ]}
        example={<>HR at <b>Acme India Pvt Ltd</b> posts <b>"Diwali holiday — office closed 21 Oct 2026"</b> under <b>Holiday</b>, targets <b>Everyone</b>, pins it, and schedules <b>Go live at</b> 20 Oct 09:00 (Asia/Kolkata) with <b>Expires at</b> 22 Oct. After publishing, <b>Aarav Sharma</b> and every colleague get a feed note and notification.</>}
        tips={[
          'Only Owner and HR-Admin can manage announcements; an employee only sees PUBLISHED, in-audience, not-yet-expired notes whose go-live time has passed.',
          'Saving alone keeps it a DRAFT — you must Publish for anyone to see it. Leave "Go live at" blank to publish instantly.',
        ]}
      />

      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm text-gray-600">
          Status
          <select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          >
            {STATUSES.map((s) => <option key={s} value={s}>{s || 'All'}</option>)}
          </select>
        </label>
        <span className="inline-flex items-center text-xs text-gray-400">
          Published + in-audience + not-expired notes show on the employee feed
          <InfoTip text="Employees only see an announcement that is PUBLISHED, whose go-live time has passed, that has not expired, and that targets them (their entity / department, or a company-wide note)." label="Visibility" />
        </span>
      </div>

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      <DataTable
        columns={columns}
        rows={items}
        loading={loading}
        rowKey={(r) => r.id}
        emptyText="No announcements yet. Create your first company update."
      />

      <ServerPagination
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        sizes={PAGE_SIZES}
        noun="announcements"
      />

      {editing && (
        <Editor
          form={editing}
          setForm={setEditing}
          entities={entities}
          departments={departments}
          onClose={closeEditor}
          onSave={save}
          saving={saving}
          error={formError}
        />
      )}
    </div>
  );
}

// ── Editor modal ─────────────────────────────────────────────────────────────
function Editor({ form, setForm, entities, departments, onClose, onSave, saving, error }) {
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleId = (k, id) => setForm((f) => {
    const has = (f[k] || []).includes(id);
    return { ...f, [k]: has ? f[k].filter((x) => x !== id) : [...(f[k] || []), id] };
  });

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-8 w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{form.id ? 'Edit announcement' : 'New announcement'}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">✕</button>
        </div>

        {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

        <div className="space-y-4">
          <div>
            <LabelWithTip label="Title" tip="A short, scannable headline. Shown bold at the top of the feed card." htmlFor="ann-title" />
            <input
              id="ann-title"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="e.g. Diwali holiday on 21 Oct"
            />
          </div>

          <div>
            <LabelWithTip label="Message" tip="The body of the announcement. Plain text or light markdown; rendered on the employee feed." htmlFor="ann-body" />
            <textarea
              id="ann-body"
              value={form.bodyRichText}
              onChange={(e) => set('bodyRichText', e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="Write your update here…"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <LabelWithTip label="Category" tip="Labels the announcement (News, Policy, Event, Holiday…). Helps employees filter the feed." htmlFor="ann-cat" />
              <select id="ann-cat" value={form.category} onChange={(e) => set('category', e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={form.pinned} onChange={(e) => set('pinned', e.target.checked)} />
                Pin to top
                <InfoTip text="Pinned announcements always lead the employee feed, above unpinned ones." label="Pin" />
              </label>
            </div>
          </div>

          <div>
            <LabelWithTip label="Audience" tip="Who sees this. Everyone, or narrowed to one-or-more entities / departments, or a specific set of employees. Tenant-isolated and Feature-1 aware." htmlFor="ann-scope" />
            <select id="ann-scope" value={form.audienceScope} onChange={(e) => set('audienceScope', e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>

          {form.audienceScope === 'ENTITY' && (
            <ChipPicker
              label="Entities"
              options={entities.map((e) => ({ id: e.id, label: e.displayName || e.legalName || e.code }))}
              selected={form.audienceEntityIds}
              onToggle={(id) => toggleId('audienceEntityIds', id)}
              emptyHint="No entities found."
            />
          )}
          {form.audienceScope === 'DEPARTMENT' && (
            <ChipPicker
              label="Departments"
              options={departments.map((d) => ({ id: d.id, label: d.name || d.code }))}
              selected={form.audienceDeptIds}
              onToggle={(id) => toggleId('audienceDeptIds', id)}
              emptyHint="No departments found."
            />
          )}
          {form.audienceScope === 'SPECIFIC' && (
            <EmployeeMultiPicker
              ids={form.audienceEmployeeIds || []}
              labels={form.audienceEmployeeLabels || {}}
              onAdd={(emp) => setForm((f) => {
                if ((f.audienceEmployeeIds || []).includes(emp.id)) return f;
                return {
                  ...f,
                  audienceEmployeeIds: [...(f.audienceEmployeeIds || []), emp.id],
                  audienceEmployeeLabels: { ...(f.audienceEmployeeLabels || {}), [emp.id]: employeeName(emp) },
                };
              })}
              onRemove={(id) => setForm((f) => {
                const nextLabels = { ...(f.audienceEmployeeLabels || {}) };
                delete nextLabels[id];
                return {
                  ...f,
                  audienceEmployeeIds: (f.audienceEmployeeIds || []).filter((x) => x !== id),
                  audienceEmployeeLabels: nextLabels,
                };
              })}
            />
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <LabelWithTip label="Go live at" tip="When the announcement appears on the feed. Leave blank to go live the moment you publish; set a future time to schedule it." htmlFor="ann-pub" />
              <input id="ann-pub" type="datetime-local" value={form.publishedAt} onChange={(e) => set('publishedAt', e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <LabelWithTip label="Expires at" tip="When the announcement drops off the feed. Leave blank for no expiry." htmlFor="ann-exp" />
              <input id="ann-exp" type="datetime-local" value={form.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !form.title.trim() || !form.bodyRichText.trim()}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: 'var(--theme-primary)' }}
          >
            {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create draft'}
          </button>
        </div>
        <p className="mt-3 text-xs text-gray-400">Saving creates/updates a draft. Use “Publish” on the list to go live + notify the audience.</p>
      </div>
    </div>
  );
}

function ChipPicker({ label, options, selected, onToggle, emptyHint }) {
  return (
    <div>
      <div className="mb-1 block text-sm font-medium text-gray-700">{label}</div>
      {options.length === 0 ? (
        <p className="text-xs text-gray-400">{emptyHint}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => {
            const on = selected.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onToggle(o.id)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${on ? 'border-transparent text-white' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                style={on ? { background: 'var(--theme-primary)' } : undefined}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Specific-employee targeting: search the (F1-scoped) directory via the reusable
// EmployeeSearchSelect, add each pick to a removable chip list. Only the IDs are
// persisted (audienceEmployeeIds); names are a display-only cache. The picker is
// remounted via `key` after every add so its internal "chosen" chip resets and
// the operator can immediately search for the next person.
function EmployeeMultiPicker({ ids, labels, onAdd, onRemove }) {
  const [pickCount, setPickCount] = useState(0);
  return (
    <div>
      <LabelWithTip
        label="Specific employees"
        tip="Search the directory by name, code or work email and add each person you want to target. Only people you're allowed to see appear."
        htmlFor="ann-emps"
      />
      <EmployeeSearchSelect
        key={pickCount}
        id="ann-emps"
        status="ACTIVE"
        placeholder="Search by name, code or email…"
        onSelect={(emp) => { if (emp) { onAdd(emp); setPickCount((n) => n + 1); } }}
      />
      {ids.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {ids.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700"
            >
              {labels[id] || id}
              <button
                type="button"
                onClick={() => onRemove(id)}
                className="text-gray-400 hover:text-gray-700"
                aria-label={`Remove ${labels[id] || id}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-gray-400">No employees added yet — search above to target people individually.</p>
      )}
    </div>
  );
}
