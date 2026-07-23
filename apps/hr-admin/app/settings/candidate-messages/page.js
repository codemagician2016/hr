'use client';

// Settings → Candidate messages (Feature 36).
//
// Two things in one place, for the recruiter/HR admin:
//   1. Auto-send toggles — decide which pipeline events message the candidate
//      automatically (applied / shortlisted / interview invite / slot request /
//      offer / rejected). Rejection is OFF by default: candidates are only told
//      they weren't selected if you turn it on.
//        GET  /api/hr/recruitment/comms-config  → { config, defaults }
//        PUT  /api/hr/recruitment/comms-config   { autoSend, replyTo, senderName }
//   2. Message library — the copy for each candidate-facing stage, editable per
//      tenant (override the BODY only; the variables are fixed by the platform).
//      Mirrors Settings → Notification templates.
//        GET    /api/hr/recruitment/comms-templates            → { items:[…] }
//        PUT    /api/hr/recruitment/comms-templates/:key         { body } (422 on bad {TOKEN})
//        DELETE /api/hr/recruitment/comms-templates/:key         → reset to the stock copy
//
// Writes are gated on canManageHiring / canManageEmployees (server is the real
// boundary). Read-only operators see the banner and no editors. 4xx bodies are
// surfaced verbatim (the unknown-{TOKEN} message lists the allowed variables).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, Spinner } from '@hr/ui';
import { get, put, del } from '@/lib/api';
import { DataTable, PageHeader, ActionButton } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';
import { permissionsFromSession, hasAnyPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

/* ── helpers ──────────────────────────────────────────────────────────────── */

const TOKEN_RE = /\{([A-Za-z0-9_.]+)\}/g;
// Sample values so the live preview reads like a real message.
const SAMPLE = { NAME: 'Alex Candidate', ROLE: 'Backend Engineer', BIZ: 'Acme Inc', LINK: 'https://…/track', MODE: 'Video', SLOTLINE: 'Proposed time: Tue 3:00 PM.', EXPIRY: '30 Jun', WHEN: 'Tue 3:00 PM', CANDIDATE: 'Alex Candidate' };

function renderPreview(body, variables) {
  const allowed = new Set(variables || []);
  return String(body || '').replace(TOKEN_RE, (m, t) => (allowed.has(t) ? (SAMPLE[t] != null ? SAMPLE[t] : `[${t}]`) : m));
}
function unknownTokens(body, variables) {
  const allowed = new Set(variables || []);
  const seen = new Set();
  for (const m of String(body || '').matchAll(TOKEN_RE)) if (!allowed.has(m[1])) seen.add(m[1]);
  return [...seen];
}
function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const CHANNEL_META = [
  ['email', 'Email', 'bg-sky-50 text-sky-700 border-sky-200'],
  ['whatsapp', 'WhatsApp', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
  ['sms', 'SMS', 'bg-violet-50 text-violet-700 border-violet-200'],
];
function ChannelChips({ channels }) {
  const active = CHANNEL_META.filter(([k]) => channels?.[k]);
  if (!active.length) return <span className="text-xs text-gray-400">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {active.map(([k, label, cls]) => (
        <span key={k} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>{label}</span>
      ))}
    </span>
  );
}
function CustomisedChip() {
  return <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Customised</span>;
}

/* ── auto-send toggles ────────────────────────────────────────────────────── */

const AUTO_SEND_STAGES = [
  { key: 'applied', label: 'Application received', hint: 'Sent automatically when someone applies on your careers page — the "we\'ve got it" acknowledgement.' },
  { key: 'shortlisted', label: 'Shortlisted', hint: 'Sent when you move a candidate forward to screening / interview.' },
  { key: 'interview_invite', label: 'Interview invitation', hint: 'Sent when a candidate is invited to interview.' },
  { key: 'slot_request', label: 'Pick-an-interview-slot', hint: 'Sent when interview time options are proposed. (Using "Propose slots" always sends this immediately, regardless of this toggle.)' },
  { key: 'offer', label: 'Offer sent', hint: 'Sent when you send an offer to the candidate.' },
  { key: 'rejected', label: 'Not selected', hint: 'Sent when a candidate is rejected. OFF by default — candidates are only told they weren\'t selected if you turn this on.' },
];

function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={() => !disabled && onChange(!checked)} disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? '' : 'bg-gray-200'}`}
      style={checked ? { backgroundColor: 'var(--theme-primary)' } : undefined}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  );
}

function AutoSendSection({ canManage }) {
  const [config, setConfig] = useState(null); // { autoSend, replyTo, senderName }
  const [defaults, setDefaults] = useState({ autoSend: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/recruitment/comms-config')
      .then((r) => { setConfig(r?.config || {}); setDefaults(r?.defaults || { autoSend: {} }); })
      .catch((e) => setError(e.data?.message || e.message || 'Could not load candidate-message settings.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Effective value = explicit tenant override, else the platform default.
  const effective = (stage) => {
    const cfg = config?.autoSend || {};
    if (typeof cfg[stage] === 'boolean') return cfg[stage];
    return !!(defaults.autoSend && defaults.autoSend[stage]);
  };

  const setStage = (stage, val) => setConfig((c) => ({ ...(c || {}), autoSend: { ...((c && c.autoSend) || {}), [stage]: val } }));

  async function save() {
    setSaving(true); setError(''); setNotice('');
    // Send an explicit value for every stage so effective = stored (no ambiguity).
    const autoSend = {};
    for (const s of AUTO_SEND_STAGES) autoSend[s.key] = effective(s.key);
    try {
      const r = await put('/api/hr/recruitment/comms-config', {
        autoSend,
        replyTo: config?.replyTo ?? null,
        senderName: config?.senderName ?? null,
      });
      setConfig(r?.config || { autoSend });
      setNotice('Auto-send settings saved.');
      setTimeout(() => setNotice(''), 4000);
    } catch (e) { setError(e.data?.message || e.message || 'Could not save settings.'); }
    finally { setSaving(false); }
  }

  if (loading) return <Spinner />;

  return (
    <section className="space-y-4">
      <SectionTitle tip="Choose which pipeline events message the candidate automatically. You can always send any message manually from a candidate's card.">
        Automatic messages
      </SectionTitle>
      {error && <ErrorBanner message={error} />}
      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}

      <div className="rounded-2xl border border-gray-200 bg-white divide-y divide-gray-100">
        {AUTO_SEND_STAGES.map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 flex items-center">
                {s.label}
                <InfoTip text={s.hint} />
                {s.key === 'rejected' && !effective('rejected') && <span className="ml-2 text-[11px] text-gray-400">off by default</span>}
              </div>
            </div>
            <Toggle checked={effective(s.key)} onChange={(v) => setStage(s.key, v)} disabled={!canManage} label={`Auto-send ${s.label}`} />
          </div>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Reply-to address<InfoTip text="Where candidate replies to these emails are delivered (e.g. careers@yourcompany.com). Leave blank to use the platform default." /></span>
          <input
            type="email" value={config?.replyTo || ''} disabled={!canManage}
            onChange={(e) => setConfig((c) => ({ ...(c || {}), replyTo: e.target.value }))}
            placeholder="careers@yourcompany.com"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
          />
        </label>
        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Sender name<InfoTip text="The from-name candidates see on these messages, e.g. 'Acme Talent Team'." /></span>
          <input
            type="text" value={config?.senderName || ''} disabled={!canManage}
            onChange={(e) => setConfig((c) => ({ ...(c || {}), senderName: e.target.value }))}
            placeholder="Acme Talent Team"
            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
          />
        </label>
      </div>

      {canManage && (
        <div className="pt-1">
          <PrimaryButton loading={saving} onClick={save}>Save settings</PrimaryButton>
        </div>
      )}
    </section>
  );
}

/* ── template edit modal ──────────────────────────────────────────────────── */

function TemplateEditModal({ tpl, onClose, onSaved }) {
  const [body, setBody] = useState(tpl.overrideBody ?? tpl.defaultBody ?? '');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useRef(null);

  const variables = tpl.variables || [];
  const preview = useMemo(() => renderPreview(body, variables), [body, variables]);
  const unknown = useMemo(() => unknownTokens(body, variables), [body, variables]);

  function insertVariable(token) {
    const chunk = `{${token}}`;
    const ta = textareaRef.current;
    if (!ta) { setBody((b) => b + chunk); return; }
    const start = ta.selectionStart ?? body.length;
    const end = ta.selectionEnd ?? start;
    setBody(body.slice(0, start) + chunk + body.slice(end));
    requestAnimationFrame(() => { ta.focus(); const pos = start + chunk.length; try { ta.setSelectionRange(pos, pos); } catch { /* ignore */ } });
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await put(`/api/hr/recruitment/comms-templates/${tpl.key}`, { body });
      onSaved(`"${tpl.displayName}" saved — your wording is now in use.`);
    } catch (err) {
      // 422 messages are user-readable (unknown {TOKEN} lists the allowed ones).
      setError(err.data?.message || err.message || 'Failed to save the template.');
    } finally { setSaving(false); }
  }

  async function resetToDefault() {
    if (!window.confirm(`Reset "${tpl.displayName}" to the stock message? Your wording will be removed.`)) return;
    setResetting(true); setError('');
    try {
      await del(`/api/hr/recruitment/comms-templates/${tpl.key}`);
      onSaved(`"${tpl.displayName}" reset to the stock message.`);
    } catch (err) { setError(err.data?.message || err.message || 'Failed to reset the template.'); }
    finally { setResetting(false); }
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
        <p className="text-xs text-gray-500">Overrides change the <b>message body only</b> — the variables each message receives are fixed by the platform.</p>

        <div>
          <span className="flex items-center text-sm font-medium text-gray-700">Available variables<InfoTip text="These placeholders are filled in when the message is sent. Click one to insert it at the cursor. Using a token that isn't in this list makes the save fail." /></span>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {variables.length === 0 && <span className="text-xs text-gray-400">This message has no variables.</span>}
            {variables.map((v) => (
              <button key={v} type="button" onClick={() => insertVariable(v)} title="Insert at cursor" className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 font-mono text-[11px] text-indigo-700 hover:bg-indigo-100">
                {`{${v}}`}
              </button>
            ))}
          </div>
        </div>

        <label className="block text-sm">
          <span className="flex items-center font-medium text-gray-700">Message body<InfoTip text="What the candidate receives. {TOKEN} placeholders are replaced with real values at send time." /></span>
          <textarea ref={textareaRef} value={body} onChange={(e) => setBody(e.target.value)} rows={5} required className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" />
        </label>

        {unknown.length > 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            Unknown variable{unknown.length === 1 ? '' : 's'}: {unknown.map((t) => `{${t}}`).join(', ')} — not in this message&apos;s list, so saving will fail.
          </p>
        )}

        <div className="rounded-xl border border-gray-200 bg-gradient-to-br from-indigo-50/60 to-white p-3 text-sm text-gray-700">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Live preview <span className="normal-case font-normal">— sample values stand in for the real data</span></p>
          <p className="whitespace-pre-wrap">{preview || <span className="text-gray-400">Type a message body above…</span>}</p>
        </div>

        <ModalActions>
          {tpl.overridden && (
            <button type="button" onClick={resetToDefault} disabled={resetting || saving} className="mr-auto rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
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

export default function CandidateMessagesPage() {
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  const load = useCallback(() => {
    setLoading(true);
    get('/api/hr/recruitment/comms-templates')
      .then((res) => setItems(res?.items || []))
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load candidate message templates.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasAnyPermission(permissionsFromSession(session), ['canManageHiring', 'canManageEmployees']));
      })
      .catch(() => {});
  }, [load]);

  const overriddenCount = (items || []).filter((t) => t.overridden).length;

  const columns = [
    {
      key: 'template', header: 'Message',
      render: (t) => (
        <span className="block">
          <span className="block font-medium text-gray-900">{t.displayName}</span>
          <span className="block font-mono text-[11px] text-gray-400">{t.key}</span>
        </span>
      ),
    },
    { key: 'channels', header: 'Channels', render: (t) => <ChannelChips channels={t.channels} /> },
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
    ...(canManage ? [{ key: 'actions', header: '', render: (t) => <ActionButton onClick={() => setEditing(t)}>Edit</ActionButton> }] : []),
  ];

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Candidate messages
            <InfoTip text="What DriftHR sends the people applying to your jobs — the automatic messages at each pipeline stage and the exact wording of each one." />
          </span>
        )}
        subtitle="Control the messages candidates receive as they move through hiring — and the wording of each."
      />

      <ModuleGuide
        id="settings-candidate-messages"
        title="Keep candidates in the loop, in your words"
        what="As candidates apply, get shortlisted, are invited to interview, receive an offer or aren't selected, DriftHR can message them automatically over email / WhatsApp / SMS. Here you choose which of those go out automatically and customise the wording of every one — overrides change the body only; the {VARIABLE} placeholders are filled in with real values at send time."
        steps={[
          'Under Automatic messages, switch each stage on or off. Rejection is off by default — turn it on only if you want candidates told they weren\'t selected.',
          'Set an optional reply-to address and sender name so replies reach your talent team.',
          'In the Message library, click Edit on any stage. Click a variable chip to insert its {TOKEN}, check the live preview, then Save.',
          'Changed your mind? "Reset to default" on a customised message restores the stock wording.',
        ]}
        example={<>Turn <b>Application received</b> on so every applicant gets an instant acknowledgement with a personal &quot;track your application&quot; link, and rewrite <b>Shortlisted</b> to your own warm wording. Leave <b>Not selected</b> off until you are ready to send rejections.</>}
        tips={[
          'Using a {TOKEN} that isn\'t in a message\'s variable list fails the save — the error lists the allowed ones.',
          'You can also send any of these messages manually from a candidate\'s card, regardless of the automatic toggles.',
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Managing candidate messages requires the manage-hiring permission.
        </p>
      )}
      {error && <ErrorBanner message={error} />}

      <AutoSendSection canManage={canManage} />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle tip="The wording of each candidate-facing message. Overrides change the message body only; the variables are fixed.">Message library</SectionTitle>
          {!loading && items && <p className="text-xs text-gray-500">{items.length} message{items.length === 1 ? '' : 's'} · {overriddenCount} customised</p>}
        </div>
        {loading ? (
          <DataTable columns={columns} rows={[]} loading emptyText="" />
        ) : (
          <DataTable columns={columns} rows={items || []} rowKey={(r) => r.key} emptyText="No candidate message templates." caption="Candidate message templates" />
        )}
      </div>

      {editing && (
        <TemplateEditModal tpl={editing} onClose={() => setEditing(null)} onSaved={(msg) => { setEditing(null); flash(msg); load(); }} />
      )}
    </div>
  );
}
