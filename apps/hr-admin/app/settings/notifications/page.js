'use client';

// Settings → Notification templates (Program P1.6).
//
// Every HR notification the platform sends (payslip published, leave approved,
// approvals, helpdesk, announcements, birthdays, probation, …) as an editable
// template. A tenant can override the message BODY only — the variables each
// message receives are fixed by the platform:
//   GET    /api/hr/notifications/templates              → { items:[{ key, displayName,
//          category, channels:{sms,whatsapp,email}, variables:[...], defaultBody,
//          overrideBody|null, overridden, updatedAt|null }] }
//   PUT    /api/hr/notifications/templates/:key         { body } → save an override
//   DELETE /api/hr/notifications/templates/:key         → reset to the stock body
//   POST   /api/hr/notifications/templates/:key/preview → server-side render (we
//          render client-side instead: {VAR} → [VAR] sample values, same output)
//
// All routes are canManageOrg (server-gated). The page shows a read-only banner
// and hides the editors for operators who lack the key; the server is the real
// enforcement boundary. 400s from PUT are user-readable (an unknown {TOKEN}
// message lists the allowed ones) and are surfaced verbatim.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton } from '@hr/ui';
import { get, put, del } from '@/lib/api';
import { DataTable, PageHeader, ActionButton } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

/* ── helpers ──────────────────────────────────────────────────────────────── */

// "TRANSACTIONAL" → "Transactional", "LIFE_CYCLE" → "Life cycle".
function categoryLabel(category) {
  const c = String(category || 'OTHER');
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase().replace(/_/g, ' ');
}

// Client-side render of the live preview — the same output the server's
// /preview endpoint produces with sample values: each KNOWN {TOKEN} becomes
// [TOKEN]; unknown tokens are left as-is (and flagged, since saving would 400).
const TOKEN_RE = /\{([A-Za-z0-9_.]+)\}/g;
function renderPreview(body, variables) {
  const allowed = new Set(variables || []);
  return String(body || '').replace(TOKEN_RE, (m, t) => (allowed.has(t) ? `[${t}]` : m));
}
function unknownTokens(body, variables) {
  const allowed = new Set(variables || []);
  const seen = new Set();
  for (const m of String(body || '').matchAll(TOKEN_RE)) {
    if (!allowed.has(m[1])) seen.add(m[1]);
  }
  return [...seen];
}

function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ── chips ────────────────────────────────────────────────────────────────── */

const CHANNEL_META = [
  ['email', 'Email', 'bg-sky-50 text-sky-700 border-sky-200'],
  ['whatsapp', 'WhatsApp', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
  ['sms', 'SMS', 'bg-violet-50 text-violet-700 border-violet-200'],
];

function ChannelChips({ channels }) {
  const active = CHANNEL_META.filter(([k]) => channels?.[k]);
  if (active.length === 0) return <span className="text-xs text-gray-400">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {active.map(([k, label, cls]) => (
        <span key={k} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
          {label}
        </span>
      ))}
    </span>
  );
}

function CustomisedChip() {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
      Customised
    </span>
  );
}

/* ── edit modal ───────────────────────────────────────────────────────────── */

function TemplateEditModal({ tpl, onClose, onSaved }) {
  const [body, setBody] = useState(tpl.overrideBody ?? tpl.defaultBody ?? '');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useRef(null);

  const variables = tpl.variables || [];
  const preview = useMemo(() => renderPreview(body, variables), [body, variables]);
  const unknown = useMemo(() => unknownTokens(body, variables), [body, variables]);

  // Nice-to-have: click a variable chip to insert its {TOKEN} at the cursor.
  function insertVariable(token) {
    const chunk = `{${token}}`;
    const ta = textareaRef.current;
    if (!ta) {
      setBody((b) => b + chunk);
      return;
    }
    const start = ta.selectionStart ?? body.length;
    const end = ta.selectionEnd ?? start;
    setBody(body.slice(0, start) + chunk + body.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + chunk.length;
      try { ta.setSelectionRange(pos, pos); } catch { /* ignore */ }
    });
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await put(`/api/hr/notifications/templates/${tpl.key}`, { body });
      onSaved(`"${tpl.displayName}" saved — your customised message is now in use.`);
    } catch (err) {
      // 400 messages are user-readable (unknown {TOKEN} lists the allowed ones).
      setError(err.data?.message || err.message || 'Failed to save the template.');
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    if (!window.confirm(`Reset "${tpl.displayName}" to the stock message? Your customised body will be removed.`)) return;
    setResetting(true);
    setError('');
    try {
      await del(`/api/hr/notifications/templates/${tpl.key}`);
      onSaved(`"${tpl.displayName}" reset to the stock message.`);
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to reset the template.');
    } finally {
      setResetting(false);
    }
  }

  return (
    <Modal title={`Edit — ${tpl.displayName}`} size="lg" onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        {error && <ErrorBanner message={error} />}

        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-600">{tpl.key}</code>
          <ChannelChips channels={tpl.channels} />
          {tpl.overridden && <CustomisedChip />}
        </div>

        <p className="text-xs text-gray-500">
          Overrides change the <b>message body only</b> — the variables each message receives are fixed by the platform.
        </p>

        <div>
          <span className="flex items-center text-sm font-medium text-gray-700">
            Available variables
            <InfoTip text="These placeholders are filled in when the message is sent. Click one to insert it at the cursor. Using a token that isn't in this list makes the save fail." />
          </span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {variables.length === 0 && <span className="text-xs text-gray-400">This message has no variables.</span>}
            {variables.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => insertVariable(v)}
                title="Insert at cursor"
                className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-mono text-[11px] text-indigo-700 hover:bg-indigo-100"
              >
                {`{${v}}`}
              </button>
            ))}
          </div>
        </div>

        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">
            Message body
            <InfoTip text="What the employee receives. {TOKEN} placeholders are replaced with real values at send time." />
          </span>
          <textarea
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            required
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm"
          />
        </label>

        {unknown.length > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Unknown variable{unknown.length === 1 ? '' : 's'}: {unknown.map((t) => `{${t}}`).join(', ')} — not in this
            message&apos;s list, so saving will fail.
          </p>
        )}

        <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-indigo-50/60 to-white p-3 text-sm text-gray-700">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
            Live preview <span className="normal-case font-normal">— [SAMPLE] values stand in for the real data</span>
          </p>
          <p className="whitespace-pre-wrap">{preview || <span className="text-gray-400">Type a message body above…</span>}</p>
        </div>

        <ModalActions>
          {tpl.overridden && (
            <button
              type="button"
              onClick={resetToDefault}
              disabled={resetting || saving}
              className="mr-auto rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {resetting ? 'Resetting…' : 'Reset to default'}
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Cancel</button>
          <PrimaryButton type="submit" loading={saving}>Save template</PrimaryButton>
        </ModalActions>
      </form>
    </Modal>
  );
}

/* ── page ─────────────────────────────────────────────────────────────────── */

export default function NotificationTemplatesPage() {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // template row being edited

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/notifications/templates')
      .then((res) => setItems(res?.items || []))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load notification templates.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasPermission(permissionsFromSession(session), 'canManageOrg'));
      })
      .catch(() => {});
  }, [load]);

  // Search across name / key / category, then group by category
  // (TRANSACTIONAL first, remaining categories alphabetically).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (items || []).filter((t) => {
      if (!q) return true;
      return (
        String(t.displayName || '').toLowerCase().includes(q)
        || String(t.key || '').toLowerCase().includes(q)
        || String(t.category || '').toLowerCase().includes(q)
      );
    });
    const byCat = new Map();
    for (const t of filtered) {
      const cat = t.category || 'OTHER';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(t);
    }
    return [...byCat.entries()].sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === 'TRANSACTIONAL') return -1;
      if (b === 'TRANSACTIONAL') return 1;
      return a.localeCompare(b);
    });
  }, [items, query]);

  const overriddenCount = (items || []).filter((t) => t.overridden).length;

  const columns = [
    {
      key: 'template', header: 'Template',
      render: (t) => (
        <span className="block">
          <span className="block font-medium text-gray-900">{t.displayName}</span>
          <span className="block font-mono text-[11px] text-gray-400">{t.key}</span>
        </span>
      ),
    },
    { key: 'channels', header: 'Channels', render: (t) => <ChannelChips channels={t.channels} /> },
    {
      key: 'variables', header: 'Variables',
      render: (t) => <span className="text-xs text-gray-500">{(t.variables || []).length}</span>,
    },
    {
      key: 'status', header: 'Status',
      render: (t) => (t.overridden ? (
        <span className="inline-flex flex-col items-start gap-0.5">
          <CustomisedChip />
          {t.updatedAt && <span className="text-[11px] text-gray-400">Updated {formatWhen(t.updatedAt)}</span>}
        </span>
      ) : (
        <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">Stock</span>
      )),
    },
    ...(canManage ? [{
      key: 'actions', header: '',
      render: (t) => <ActionButton onClick={() => setEditing(t)}>Edit</ActionButton>,
    }] : []),
  ];

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Notification templates
            <InfoTip text="Every notification the platform sends employees, with the exact message body. Customise any of them — overrides change the body only; the variables each message receives are fixed." />
          </span>
        )}
        subtitle="Customise the messages DriftHR sends your employees — payslips, leave, approvals, birthdays and more."
      />

      <ModuleGuide
        id="settings-notifications"
        title="Customise the messages your employees receive"
        what="Every HR notification the platform sends (payslip published, leave approved, approvals, helpdesk, announcements, birthdays, probation, …) has a stock message. You can override the message body per template — write your own wording with the listed {VARIABLE} placeholders, which are filled in with real values at send time. Overrides change the body only; the variables each message receives are fixed."
        steps={[
          'Find the template (search by name or key) and click Edit.',
          'Write your message — click a variable chip to insert its {TOKEN} at the cursor.',
          'Check the live preview below the editor ([SAMPLE] values stand in for real data), then Save.',
          'Changed your mind? "Reset to default" on a customised template restores the stock wording.',
        ]}
        example={<>For <b>Payslip published</b>, change the body to <i>&quot;Hi {'{EMPLOYEE_NAME}'}, your payslip for {'{PERIOD}'} is ready in the portal.&quot;</i> — every payslip notification then goes out with your wording.</>}
        tips={[
          'A "Customised" chip marks templates using your wording; everything else sends the stock message.',
          'Using a {TOKEN} that is not in the template\'s variable list fails the save — the error lists the allowed ones.',
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Customising notification templates requires the manage-organisation permission.
        </p>
      )}
      {error && <ErrorBanner message={error} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates by name, key or category…"
          aria-label="Search notification templates"
          className="w-full max-w-sm rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        {!loading && items && (
          <p className="text-xs text-gray-500">
            {items.length} template{items.length === 1 ? '' : 's'} · {overriddenCount} customised
          </p>
        )}
      </div>

      {loading ? (
        <DataTable columns={columns} rows={[]} loading emptyText="" />
      ) : groups.length === 0 ? (
        <DataTable
          columns={columns}
          rows={[]}
          emptyText={query ? 'No templates match your search.' : 'No notification templates yet.'}
        />
      ) : (
        groups.map(([category, rows]) => (
          <div key={category} className="space-y-3">
            <SectionTitle tip="Templates in this category. Overrides change the message body only; the variables each message receives are fixed.">
              {categoryLabel(category)}
            </SectionTitle>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.key}
              caption={`${categoryLabel(category)} notification templates`}
            />
          </div>
        ))
      )}

      {editing && (
        <TemplateEditModal
          tpl={editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => { setEditing(null); flash(msg); load(); }}
        />
      )}
    </div>
  );
}
