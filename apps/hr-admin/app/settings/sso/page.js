'use client';

// Settings → Single sign-on (Enterprise SSO + SCIM).
//
// One SAML/OIDC connection per tenant + SCIM provisioning tokens, over the
// /api/hr/sso admin API (protect + canManageSso — Owner and HR-Admin):
//   GET    /api/hr/sso/connection        → { connection } — secrets NEVER echoed
//          (hasClientSecret / hasSpPrivateKey booleans only) + derived
//          `endpoints` (SP metadata/ACS/redirect URIs + SCIM base URL)
//   PUT    /api/hr/sso/connection        upsert; clientSecret is WRITE-ONLY:
//          provided → stored encrypted; omitted → kept; null → cleared
//   POST   /api/hr/sso/connection/test   OIDC live discovery / SAML cert parse
//   DELETE /api/hr/sso/connection
//   GET    /api/hr/sso/scim-tokens       list (name/last4/lastUsedAt — never the hash)
//   POST   /api/hr/sso/scim-tokens       mint → returns the RAW token exactly ONCE
//   DELETE /api/hr/sso/scim-tokens/:id   revoke
//
// The page shows a read-only banner for operators who lack canManageSso; the
// server is the real enforcement boundary. 4xx messages are surfaced verbatim.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, Modal, ModalActions, PrimaryButton, TextArea, TextInput } from '@hr/ui';
import { get, put, post, del } from '@/lib/api';
import { DataTable, PageHeader, ActionButton } from '@/lib/ui';
import { InfoTip, SectionTitle } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import { ssoApiOrigin } from '@/lib/sso';
import ModuleGuide from '@/components/ModuleGuide';

/* ── helpers ──────────────────────────────────────────────────────────────── */

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Read-only copy-box: a mono value + one-click copy (clipboard API with a
// select-text fallback). Mirrors the domain page's CopyButton idiom.
function CopyBox({ label, value, tip }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(String(value || ''));
      else {
        const ta = document.createElement('textarea');
        ta.value = String(value || '');
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the field is still selectable */ }
  }
  return (
    <div>
      <span className="flex items-center text-xs font-medium text-gray-600">
        {label}
        {tip && <InfoTip text={tip} />}
      </span>
      <div className="mt-1 flex items-stretch gap-2">
        <input
          readOnly
          value={value || ''}
          onClick={(e) => e.target.select()}
          className="flex-1 truncate rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700 focus:outline-none"
        />
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          aria-label={copied ? `${label}: copied` : `Copy ${label}`}
        >
          <span aria-live="polite">{copied ? 'Copied ✓' : 'Copy'}</span>
        </button>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange, tip, hint, disabled }) {
  return (
    <label className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 rounded border-gray-300"
      />
      <span>
        <span className="flex items-center font-medium text-gray-700">
          {label}
          {tip && <InfoTip text={tip} />}
        </span>
        {hint && <span className="block text-xs text-gray-500">{hint}</span>}
      </span>
    </label>
  );
}

const TARGET_OPTIONS = [
  ['ESS', 'Employee portal (ESS)'],
  ['OPERATOR', 'HR console (operators)'],
  ['BOTH', 'Both'],
];

/* ── page ─────────────────────────────────────────────────────────────────── */

export default function SsoSettingsPage() {
  const [connection, setConnection] = useState(null); // last-saved projection
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [canManage, setCanManage] = useState(true);
  const [slug, setSlug] = useState(null); // tenant slug (endpoint fallback)
  const [notice, setNotice] = useState('');

  // Connection form state (secrets are WRITE-ONLY — never pre-filled).
  const [protocol, setProtocol] = useState('SAML');
  const [displayName, setDisplayName] = useState('');
  const [loginTarget, setLoginTarget] = useState('ESS');
  const [jitProvision, setJitProvision] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState(''); // blank = keep stored
  const [scopes, setScopes] = useState('openid email profile');
  const [idpEntityId, setIdpEntityId] = useState('');
  const [idpSsoUrl, setIdpSsoUrl] = useState('');
  const [idpCertPem, setIdpCertPem] = useState('');
  const [wantAssertionsSigned, setWantAssertionsSigned] = useState(true);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { ok, ...verbatim } | { ok:false, message }

  // SCIM tokens
  const [tokens, setTokens] = useState(null);
  const [tokensError, setTokensError] = useState('');
  const [generateOpen, setGenerateOpen] = useState(false);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(''), 4000); };

  function hydrateForm(conn) {
    if (!conn) return;
    setProtocol(conn.protocol || 'SAML');
    setDisplayName(conn.displayName || '');
    setLoginTarget(conn.loginTarget || 'ESS');
    setJitProvision(conn.jitProvision === true);
    setIsActive(conn.isActive !== false);
    setIssuerUrl(conn.issuerUrl || '');
    setClientId(conn.clientId || '');
    setClientSecret(''); // write-only — blank keeps the stored secret
    setScopes(conn.scopes || 'openid email profile');
    setIdpEntityId(conn.idpEntityId || '');
    setIdpSsoUrl(conn.idpSsoUrl || '');
    setIdpCertPem(conn.idpCertPem || '');
    setWantAssertionsSigned(conn.wantAssertionsSigned !== false);
  }

  const loadConnection = useCallback(() => {
    setLoading(true);
    get('/api/hr/sso/connection')
      .then((res) => {
        setConnection(res?.connection || null);
        hydrateForm(res?.connection);
      })
      .catch((e) => setError(e.data?.message || e.message || 'Failed to load the SSO connection.'))
      .finally(() => setLoading(false));
  }, []);

  const loadTokens = useCallback(() => {
    get('/api/hr/sso/scim-tokens')
      .then((res) => setTokens(res?.tokens || []))
      .catch((e) => setTokensError(e.data?.message || e.message || 'Failed to load SCIM tokens.'));
  }, []);

  useEffect(() => {
    loadConnection();
    loadTokens();
    get('/api/auth/me')
      .then((res) => {
        const session = res?.user || res;
        setCanManage(hasPermission(permissionsFromSession(session), 'canManageSso'));
        setSlug(session?.businessSlug || null);
      })
      .catch(() => {});
  }, [loadConnection, loadTokens]);

  // SP endpoints the tenant pastes into their IdP. Prefer the server-derived
  // `endpoints` on the connection response (authoritative — built from the
  // backend's resolveApiBaseUrl); before the first save, construct the same
  // URLs client-side from the derived api origin + the tenant slug.
  const endpoints = useMemo(() => {
    if (connection?.endpoints) return connection.endpoints;
    const origin = ssoApiOrigin();
    if (!origin || !slug) return null;
    return {
      oidcRedirectUri: `${origin}/sso/${slug}/callback`,
      samlMetadataUrl: `${origin}/sso/${slug}/metadata`,
      samlEntityId: `${origin}/sso/${slug}/metadata`,
      samlAcsUrl: `${origin}/sso/${slug}/saml/acs`,
      scimBaseUrl: `${origin}/scim/v2`,
    };
  }, [connection, slug]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setTestResult(null);
    try {
      const body = {
        protocol,
        displayName: displayName.trim(),
        loginTarget,
        jitProvision,
        isActive,
      };
      if (protocol === 'OIDC') {
        body.issuerUrl = issuerUrl.trim();
        body.clientId = clientId.trim();
        body.scopes = scopes.trim();
        // WRITE-ONLY: only send when the operator typed one — an omitted key
        // keeps the stored secret (never send '' — that would clear it).
        if (clientSecret) body.clientSecret = clientSecret;
      } else {
        body.idpEntityId = idpEntityId.trim();
        body.idpSsoUrl = idpSsoUrl.trim();
        body.idpCertPem = idpCertPem.trim();
        body.wantAssertionsSigned = wantAssertionsSigned;
      }
      const res = await put('/api/hr/sso/connection', body);
      setConnection(res?.connection || null);
      hydrateForm(res?.connection);
      flash('SSO connection saved.');
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to save the SSO connection.');
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setError('');
    setTestResult(null);
    try {
      const res = await post('/api/hr/sso/connection/test');
      setTestResult(res);
    } catch (err) {
      // 404/422 carry { ok:false, message } — surface verbatim.
      setTestResult(err.data && typeof err.data === 'object' ? err.data : { ok: false, message: err.message });
    } finally {
      setTesting(false);
    }
  }

  async function deleteConnection() {
    if (!window.confirm('Delete this SSO connection? Single sign-on stops working immediately for everyone in this organisation.')) return;
    setDeleting(true);
    setError('');
    setTestResult(null);
    try {
      await del('/api/hr/sso/connection');
      setConnection(null);
      setProtocol('SAML');
      setDisplayName('');
      setLoginTarget('ESS');
      setJitProvision(false);
      setIsActive(true);
      setIssuerUrl(''); setClientId(''); setClientSecret(''); setScopes('openid email profile');
      setIdpEntityId(''); setIdpSsoUrl(''); setIdpCertPem(''); setWantAssertionsSigned(true);
      flash('SSO connection deleted.');
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to delete the SSO connection.');
    } finally {
      setDeleting(false);
    }
  }

  async function revokeToken(t) {
    if (!window.confirm(`Revoke SCIM token "${t.name}" (…${t.last4})? Your IdP's provisioning stops immediately until you configure a new token.`)) return;
    try {
      await del(`/api/hr/sso/scim-tokens/${t.id}`);
      flash(`SCIM token "${t.name}" revoked.`);
      loadTokens();
    } catch (err) {
      setTokensError(err.data?.message || err.message || 'Failed to revoke the token.');
    }
  }

  const tokenColumns = [
    {
      key: 'name', header: 'Name',
      render: (t) => (
        <span className="block">
          <span className="block font-medium text-gray-900">{t.name}</span>
          <span className="block font-mono text-[11px] text-gray-400">…{t.last4}</span>
        </span>
      ),
    },
    { key: 'created', header: 'Created', render: (t) => <span className="text-xs text-gray-500">{formatWhen(t.createdAt)}</span> },
    {
      key: 'lastUsed', header: 'Last used',
      render: (t) => <span className="text-xs text-gray-500">{t.lastUsedAt ? formatWhen(t.lastUsedAt) : 'Never'}</span>,
    },
    {
      key: 'status', header: 'Status',
      render: (t) => (t.isActive ? (
        <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Active</span>
      ) : (
        <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">Inactive</span>
      )),
    },
    ...(canManage ? [{
      key: 'actions', header: '',
      render: (t) => <ActionButton tone="danger" onClick={() => revokeToken(t)}>Revoke</ActionButton>,
    }] : []),
  ];

  return (
    <div className="p-6 sm:p-8 space-y-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Single sign-on
            <InfoTip text="Let your team sign in through your company identity provider (Okta, Entra ID, Google Workspace, …) via SAML or OIDC, and provision accounts automatically over SCIM." />
          </span>
        )}
        subtitle="Connect your identity provider for one-click sign-in, and issue SCIM tokens for automatic user provisioning."
      />

      <ModuleGuide
        id="settings-sso"
        title="Connect your identity provider"
        what="One SSO connection per organisation, SAML 2.0 or OIDC. Once saved and active, a 'Continue with single sign-on' button appears on your sign-in pages (employee portal, HR console, or both — your choice). SCIM tokens let your IdP create, update and deactivate employee accounts automatically."
        steps={[
          'Pick your protocol: SAML (paste the IdP SSO URL + signing certificate) or OIDC (issuer URL + client ID/secret).',
          'For SAML, copy the Service Provider endpoints below (metadata / Entity ID / ACS URL) into your IdP app.',
          'Choose where SSO signs in (employee portal, HR console, or both), then Save and run "Test connection".',
          'For provisioning, generate a SCIM token and add the SCIM base URL + token to your IdP\'s provisioning settings.',
        ]}
        tips={[
          'Secrets are write-only: they are stored encrypted and never shown again — leave the field blank to keep the stored value.',
          'Just-in-time provisioning auto-creates an employee on first SSO login when no matching account exists.',
          'A generated SCIM token is shown exactly once — copy it immediately.',
        ]}
      />

      {notice && <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700" role="status">{notice}</div>}
      {!canManage && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          You have read-only access. Configuring single sign-on requires the manage-SSO permission.
        </p>
      )}
      {error && <ErrorBanner message={error} />}

      {/* ── Section 1 — Connection ─────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionTitle tip="One connection per organisation. The protocol decides which identity-provider fields apply.">
          Connection
          {connection && (
            connection.configured && connection.isActive ? (
              <span className="ml-2 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 align-middle">Configured · active</span>
            ) : (
              <span className="ml-2 inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 align-middle">
                {connection.configured ? 'Configured · inactive' : 'Incomplete'}
              </span>
            )
          )}
        </SectionTitle>

        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : (
          <form onSubmit={save} className="space-y-5 rounded-xl border border-gray-200 bg-white p-5">
            {/* Protocol picker */}
            <div>
              <span className="flex items-center text-sm font-medium text-gray-700">
                Protocol
                <InfoTip text="SAML 2.0: paste your IdP's SSO URL + signing certificate and register our SP endpoints. OIDC: paste the issuer URL + client credentials." />
              </span>
              <div className="mt-2 flex gap-2">
                {['SAML', 'OIDC'].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => { setProtocol(p); setTestResult(null); }}
                    disabled={!canManage}
                    aria-pressed={protocol === p}
                    className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
                      protocol === p
                        ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                        : 'border-gray-300 text-gray-600 hover:bg-gray-50'
                    } disabled:opacity-60`}
                  >
                    {p === 'SAML' ? 'SAML 2.0' : 'OIDC'}
                  </button>
                ))}
              </div>
            </div>

            {/* Protocol-specific fields */}
            {protocol === 'OIDC' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextInput
                  label="Issuer URL"
                  value={issuerUrl}
                  onChange={setIssuerUrl}
                  required
                  placeholder="https://login.example.com/oauth2/default"
                  hint="The OIDC issuer — we discover the authorize/token endpoints from its /.well-known configuration."
                />
                <TextInput
                  label="Client ID"
                  value={clientId}
                  onChange={setClientId}
                  required
                  placeholder="0oa1b2c3d4…"
                />
                <div>
                  <TextInput
                    label="Client secret"
                    type="password"
                    value={clientSecret}
                    onChange={setClientSecret}
                    placeholder={connection?.hasClientSecret ? '••••••••  (unchanged)' : 'Paste the client secret'}
                    hint={connection?.hasClientSecret
                      ? 'Secret stored ✓ — leave blank to keep it; type a new one to rotate.'
                      : 'Stored encrypted, never shown again.'}
                  />
                </div>
                <TextInput
                  label="Scopes"
                  value={scopes}
                  onChange={setScopes}
                  placeholder="openid email profile"
                  hint="Space-separated. Defaults to “openid email profile”."
                />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextInput
                    label="IdP Entity ID"
                    value={idpEntityId}
                    onChange={setIdpEntityId}
                    placeholder="https://idp.example.com/metadata"
                    hint="Your identity provider's entity ID (optional)."
                  />
                  <TextInput
                    label="IdP SSO URL"
                    value={idpSsoUrl}
                    onChange={setIdpSsoUrl}
                    required
                    placeholder="https://idp.example.com/sso/saml"
                    hint="The sign-on URL we redirect to (HTTP-Redirect binding)."
                  />
                </div>
                <TextArea
                  label="IdP signing certificate (PEM)"
                  value={idpCertPem}
                  onChange={setIdpCertPem}
                  rows={6}
                  hint="Paste the X.509 certificate your IdP signs assertions with — with or without the BEGIN/END CERTIFICATE lines."
                />
                <Toggle
                  label="Require signed assertions"
                  checked={wantAssertionsSigned}
                  onChange={setWantAssertionsSigned}
                  disabled={!canManage}
                  tip="Reject SAML responses whose assertions are not signed. Leave on unless your IdP cannot sign assertions."
                />

                {/* SP endpoints — what the tenant pastes into their IdP */}
                {endpoints && (
                  <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                      Your Service Provider endpoints
                      <span className="ml-1 normal-case font-normal">— register these in your identity provider</span>
                    </p>
                    <CopyBox label="SP metadata URL" value={endpoints.samlMetadataUrl} tip="Most IdPs can import this metadata XML directly — it carries the Entity ID and ACS URL below." />
                    <CopyBox label="SP Entity ID (audience)" value={endpoints.samlEntityId} />
                    <CopyBox label="ACS URL (reply URL)" value={endpoints.samlAcsUrl} tip="Where your IdP POSTs the SAML assertion after sign-in." />
                  </div>
                )}
              </div>
            )}

            {protocol === 'OIDC' && endpoints && (
              <div className="space-y-3 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  Your redirect URI
                  <span className="ml-1 normal-case font-normal">— register this in your identity provider</span>
                </p>
                <CopyBox label="OIDC redirect URI (callback)" value={endpoints.oidcRedirectUri} tip="Add this as an allowed redirect/callback URL on the OIDC app in your IdP." />
              </div>
            )}

            {/* Shared fields */}
            <div className="grid gap-4 sm:grid-cols-2">
              <TextInput
                label="Display name"
                value={displayName}
                onChange={setDisplayName}
                placeholder="e.g. Okta, Acme SSO"
                hint="Shown on the sign-in button: “Continue with <name>”."
              />
              <div>
                <span className="flex items-center text-sm font-medium text-gray-700">
                  Sign-in target
                  <InfoTip text="Which sign-in surface this connection serves: the employee portal (ESS), the HR console (operators), or both." />
                </span>
                <select
                  value={loginTarget}
                  onChange={(e) => setLoginTarget(e.target.value)}
                  disabled={!canManage}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm"
                >
                  {TARGET_OPTIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </div>
            </div>

            <div className="space-y-3">
              <Toggle
                label="Just-in-time provisioning"
                checked={jitProvision}
                onChange={setJitProvision}
                disabled={!canManage}
                hint="Auto-create an employee on first SSO login when no match exists."
                tip="Without this, an SSO login only works for people who already have an account (created manually or via SCIM)."
              />
              <Toggle
                label="Connection active"
                checked={isActive}
                onChange={setIsActive}
                disabled={!canManage}
                hint="Turn off to pause single sign-on without deleting the configuration."
              />
            </div>

            {canManage && (
              <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
                <PrimaryButton type="submit" loading={saving}>Save connection</PrimaryButton>
                <button
                  type="button"
                  onClick={testConnection}
                  disabled={testing || !connection}
                  title={connection ? undefined : 'Save the connection first'}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {testing ? 'Testing…' : 'Test connection'}
                </button>
                {connection && (
                  <button
                    type="button"
                    onClick={deleteConnection}
                    disabled={deleting}
                    className="ml-auto rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    {deleting ? 'Deleting…' : 'Delete connection'}
                  </button>
                )}
              </div>
            )}

            {testResult && (
              <div
                className={`rounded-lg border px-4 py-3 text-sm ${
                  testResult.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}
                role="status"
              >
                <p className="font-medium">{testResult.ok ? 'Connection test passed' : 'Connection test failed'}</p>
                {testResult.message && <p className="mt-1">{testResult.message}</p>}
                <dl className="mt-2 space-y-1 font-mono text-xs">
                  {Object.entries(testResult)
                    .filter(([k]) => !['ok', 'message'].includes(k))
                    .map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <dt className="shrink-0 text-gray-500">{k}:</dt>
                        <dd className="break-all">{String(v)}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            )}
          </form>
        )}
      </div>

      {/* ── Section 2 — SCIM provisioning ──────────────────────────────────── */}
      <div className="space-y-3">
        <SectionTitle tip="SCIM 2.0 lets your identity provider create, update and deactivate employee accounts automatically. Authenticate with a bearer token generated here.">
          SCIM provisioning
        </SectionTitle>

        {endpoints?.scimBaseUrl && (
          <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50/60 p-4">
            <CopyBox label="SCIM base URL" value={endpoints.scimBaseUrl} />
            <p className="text-xs text-gray-500">
              Add this URL and a token below to your IdP&apos;s provisioning configuration (bearer authentication).
            </p>
          </div>
        )}

        {tokensError && <ErrorBanner message={tokensError} />}

        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-500">
            {tokens ? `${tokens.length} token${tokens.length === 1 ? '' : 's'}` : ''}
          </p>
          {canManage && (
            <PrimaryButton onClick={() => setGenerateOpen(true)}>Generate token</PrimaryButton>
          )}
        </div>

        <DataTable
          columns={tokenColumns}
          rows={tokens || []}
          loading={tokens === null && !tokensError}
          rowKey={(t) => t.id}
          emptyText="No SCIM tokens yet — generate one to connect your IdP's provisioning."
          caption="SCIM provisioning tokens"
        />
      </div>

      {generateOpen && (
        <GenerateTokenModal
          onClose={() => setGenerateOpen(false)}
          onCreated={(name) => { flash(`SCIM token "${name}" created.`); loadTokens(); }}
        />
      )}
    </div>
  );
}

/* ── generate-token modal ─────────────────────────────────────────────────── */

// POST /scim-tokens returns the RAW token exactly once (only its sha256+last4
// are stored). The modal switches to a copy-once view and refuses to show the
// value ever again after close.
function GenerateTokenModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [raw, setRaw] = useState(null); // the one-time token

  async function create(e) {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      const res = await post('/api/hr/sso/scim-tokens', { name: name.trim() });
      setRaw(res?.token?.raw || '');
      onCreated(res?.token?.name || name.trim());
    } catch (err) {
      setError(err.data?.message || err.message || 'Failed to generate the token.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal title={raw ? 'SCIM token created' : 'Generate SCIM token'} onClose={onClose}>
      {raw ? (
        <div className="space-y-3">
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <b>Copy this token now — you won&apos;t see it again.</b> Only a hash is stored; if it&apos;s lost,
            revoke it and generate a new one.
          </p>
          <CopyBoxOnce value={raw} />
          <p className="text-xs text-gray-500">
            Paste it (with the SCIM base URL) into your IdP&apos;s provisioning settings as the bearer token.
          </p>
          <ModalActions>
            <PrimaryButton onClick={onClose}>Done</PrimaryButton>
          </ModalActions>
        </div>
      ) : (
        <form onSubmit={create} className="space-y-3">
          {error && <ErrorBanner message={error} />}
          <TextInput
            label="Token name"
            value={name}
            onChange={setName}
            required
            placeholder="e.g. Okta provisioning"
            hint="A label so you can tell tokens apart (shown in the list with the last 4 characters)."
          />
          <ModalActions>
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">Cancel</button>
            <PrimaryButton type="submit" loading={creating} disabled={!name.trim()}>Generate token</PrimaryButton>
          </ModalActions>
        </form>
      )}
    </Modal>
  );
}

// Copy-box variant for the one-time raw token (no label chrome, mono, wraps).
function CopyBoxOnce({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(String(value || ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the value is still selectable */ }
  }
  return (
    <div className="flex items-stretch gap-2">
      <code
        onClick={(e) => {
          const range = document.createRange();
          range.selectNodeContents(e.currentTarget);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }}
        className="flex-1 break-all rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800"
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 self-start rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
      >
        <span aria-live="polite">{copied ? 'Copied ✓' : 'Copy'}</span>
      </button>
    </div>
  );
}
