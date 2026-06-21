'use client';

// Per-tenant blog settings: who can comment, who can like, moderation
// mode, and the email-on-new-comment notification toggle. Mounts inside
// BlogPanel as the "Settings" sub-tab. Endpoints:
//   GET /api/blog/settings  → { settings: BlogSettings }
//   PUT /api/blog/settings  → { settings: BlogSettings }
//
// Defaults (set server-side on first read):
//   commentsEnabled = true
//   likesEnabled    = true
//   commentPolicy   = BOTH
//   likePolicy      = BOTH
//   moderationMode  = PRE_MODERATE
//   notifyAdminOnNewComment = true
//   guestRequiresEmail      = true (always — product spec)

import { useEffect, useState } from 'react';

async function api(path, init = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const POLICY_OPTIONS = [
  { id: 'BOTH', label: 'Anyone (guests + signed-in)' },
  { id: 'REGISTERED_ONLY', label: 'Signed-in customers only' },
  { id: 'GUEST_ONLY', label: 'Guests only' },
  { id: 'NONE', label: 'Nobody (turn it off entirely)' },
];

const MODERATION_OPTIONS = [
  { id: 'PRE_MODERATE', label: 'Hold every comment for review (recommended)' },
  { id: 'NONE', label: 'Auto-publish — skip moderation' },
];

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
        on ? 'bg-indigo-600' : 'bg-gray-300'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
          on ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function Row({ title, desc, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-gray-100 last:border-0">
      <div>
        <p className="text-sm font-medium text-gray-900">{title}</p>
        {desc && <p className="text-xs text-gray-500 mt-0.5">{desc}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      {title && <h4 className="text-sm font-semibold text-gray-900 mb-2">{title}</h4>}
      {children}
    </div>
  );
}

function Select({ value, onChange, options, disabled }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
    >
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

export default function BlogSettingsTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/blog/settings');
      setSettings(data.settings);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  function update(patch) {
    setSettings((s) => s ? { ...s, ...patch } : s);
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        commentsEnabled: settings.commentsEnabled,
        likesEnabled: settings.likesEnabled,
        commentPolicy: settings.commentPolicy,
        likePolicy: settings.likePolicy,
        moderationMode: settings.moderationMode,
        notifyAdminOnNewComment: settings.notifyAdminOnNewComment,
        guestRequiresEmail: settings.guestRequiresEmail,
      };
      const data = await api('/api/blog/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setSettings(data.settings);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading settings…</p>;
  if (!settings) return <p className="text-sm text-red-600">{error || 'Could not load settings.'}</p>;

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h3 className="text-base font-semibold text-gray-900">Blog settings</h3>
        <p className="text-sm text-gray-500">
          Decide who can comment, who can like, and how strict moderation should be.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      <Card title="Comments">
        <Row
          title="Allow comments"
          desc="Master switch — turn this off to hide the comment form on every post."
        >
          <Toggle
            on={settings.commentsEnabled}
            onChange={(v) => update({ commentsEnabled: v })}
          />
        </Row>
        <Row
          title="Who can comment?"
          desc="Match this to whether your storefront has customer accounts."
        >
          <Select
            value={settings.commentPolicy}
            onChange={(v) => update({ commentPolicy: v })}
            options={POLICY_OPTIONS}
            disabled={!settings.commentsEnabled}
          />
        </Row>
        <Row
          title="Moderation"
          desc="Pre-moderate is safer for new blogs — every comment waits for your approval."
        >
          <Select
            value={settings.moderationMode}
            onChange={(v) => update({ moderationMode: v })}
            options={MODERATION_OPTIONS}
            disabled={!settings.commentsEnabled}
          />
        </Row>
        <Row
          title="Email me on new comments"
          desc="Lands in the admin inbox. (Email senders ship with the storefront port — wiring is on the way.)"
        >
          <Toggle
            on={settings.notifyAdminOnNewComment}
            onChange={(v) => update({ notifyAdminOnNewComment: v })}
            disabled={!settings.commentsEnabled}
          />
        </Row>
        <Row
          title="Guests must enter an email"
          desc="Required by default. Lets you spot fake comments and reach out to legitimate readers."
        >
          <Toggle
            on={settings.guestRequiresEmail}
            onChange={(v) => update({ guestRequiresEmail: v })}
            disabled={!settings.commentsEnabled}
          />
        </Row>
      </Card>

      <Card title="Likes">
        <Row
          title="Allow likes"
          desc="Readers can like a post once. Guests are tracked by a long-lived cookie."
        >
          <Toggle
            on={settings.likesEnabled}
            onChange={(v) => update({ likesEnabled: v })}
          />
        </Row>
        <Row
          title="Who can like?"
        >
          <Select
            value={settings.likePolicy}
            onChange={(v) => update({ likePolicy: v })}
            options={POLICY_OPTIONS}
            disabled={!settings.likesEnabled}
          />
        </Row>
      </Card>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:bg-indigo-300"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {savedFlash && <span className="text-sm text-emerald-700">✓ Saved</span>}
      </div>
    </div>
  );
}
