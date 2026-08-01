'use client';

// Settings → Branding + Roles.
//
// Branding: the tenant picks one of the 5 FIXED_STYLE_KEYS and one of the 12
// curated COLORS from @hr/theme-engine, plus a logo URL. The live tenant brand
// comes from GET /api/tenant/resolve (same source AdminShell reads). We persist
// via PUT /api/subscription/theme — the resolver reads `themeStyle` as the
// style key and `themeColors.primary` as the brand hex, so we send the resolved
// COLORS hex as `primary` (and keep the colorKey alongside for round-tripping)
// plus the chosen styleKey and the logo URL. A live preview swatch shows the
// resulting primary so the operator sees the change before saving.
//
// Roles: read-only overview from GET /api/rbac/roles + /api/rbac/permissions.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { COLORS, FIXED_STYLE_KEYS, FIXED_STYLE_SEEDS, resolveColor } from '@hr/theme-engine';
import { ErrorBanner, PrimaryButton, TextInput, Spinner } from '@hr/ui';
import { get, request } from '@/lib/api';
import { asList, PageHeader, Tabs, DataTable } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import BillingTab from '@/components/BillingTab';
import ModuleGuide from '@/components/ModuleGuide';

const STYLE_OPTIONS = FIXED_STYLE_KEYS.map((key) => ({
  key,
  label: FIXED_STYLE_SEEDS[key]?.label || key,
  primary: FIXED_STYLE_SEEDS[key]?.palette?.primary,
}));

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const MAX_LOGO_BYTES = 1024 * 1024; // 1 MB
const LOGO_TYPES = ['image/png', 'image/svg+xml', 'image/jpeg'];

function normalizeHex(value) {
  if (!HEX_RE.test(String(value || '').trim())) return null;
  const v = String(value).trim();
  return (v.startsWith('#') ? v : `#${v}`).toUpperCase();
}

// Subscription.themeColors is persisted as a JSON STRING (e.g.
// '{"primary":"#4F46E5","colorKey":"indigo"}'). The resolve payload returns it
// verbatim, so parse it here; tolerate an already-parsed object or junk.
function parseThemeColors(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// ─── HexColorInput ───────────────────────────────────────────────────────────
// Optional freeform brand color. When a valid hex is entered it overrides the
// curated swatch; clearing it falls back to the chosen swatch.
function HexColorInput({ value, onChange, disabled }) {
  const valid = !value || HEX_RE.test(value);
  return (
    <div className="max-w-xs">
      <label htmlFor="brand-hex" className="block text-sm font-medium text-gray-700 mb-1">
        Custom color (optional)
      </label>
      <div className="flex items-center gap-2">
        <span
          className="h-9 w-9 shrink-0 rounded-lg border border-gray-200"
          style={{ backgroundColor: normalizeHex(value) || '#ffffff' }}
          aria-hidden="true"
        />
        <input
          id="brand-hex"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="#4F46E5"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={!valid}
          aria-describedby="brand-hex-help"
          className={`w-full px-4 py-2.5 border rounded-lg text-sm focus:outline-none disabled:bg-gray-50 disabled:text-gray-500 ${
            valid ? 'border-gray-300' : 'border-red-300'
          }`}
        />
      </div>
      <p id="brand-hex-help" className={`text-xs mt-1 ${valid ? 'text-gray-500' : 'text-red-600'}`}>
        {valid ? 'Overrides the swatch above. Leave blank to use a curated color.' : 'Enter a 6-digit hex, e.g. #4F46E5.'}
      </p>
    </div>
  );
}

// ─── LogoUploader ────────────────────────────────────────────────────────────
// Upload (base64 → POST /api/upload/image → {url}) or paste a URL. If upload
// returns 501 (not configured), we degrade to URL-only and tell the operator.
function LogoUploader({ logoUrl, onChange, disabled }) {
  const [mode, setMode] = useState('url'); // 'url' | 'upload'
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadDisabled, setUploadDisabled] = useState(false); // flipped on 501
  const fileRef = useRef(null);

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setUploadError('');
    if (!LOGO_TYPES.includes(file.type)) {
      setUploadError('Use a PNG, SVG or JPG image.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setUploadError('That file is over 1 MB. Please use a smaller image.');
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      const res = await request('/api/upload/image', {
        method: 'POST',
        body: JSON.stringify({ image: dataUrl, filename: file.name }),
      });
      const url = res?.url || res?.logoUrl;
      if (url) onChange(url);
      else setUploadError('Upload finished but no image URL came back.');
    } catch (err) {
      if (err.status === 501) {
        // Image hosting isn't configured here — degrade to URL-only.
        setUploadDisabled(true);
        setMode('url');
        setUploadError('Uploads aren’t available yet. Paste your logo’s URL instead.');
      } else {
        setUploadError(err.data?.message || err.message || 'Could not upload that image.');
      }
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="max-w-md">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Logo</h2>

      {!uploadDisabled && (
        <div
          className="inline-flex rounded-lg border border-gray-200 p-0.5 mb-3"
          role="tablist"
          aria-label="Logo source"
        >
          {[
            { key: 'upload', label: 'Upload' },
            { key: 'url', label: 'URL' },
          ].map((t) => {
            const on = mode === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setMode(t.key)}
                disabled={disabled}
                className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                  on ? 'bg-gray-100 text-gray-900' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}

      {mode === 'upload' && !uploadDisabled ? (
        <div>
          <label htmlFor="logo-file" className="block text-sm font-medium text-gray-700 mb-1">
            Upload an image
          </label>
          <input
            id="logo-file"
            ref={fileRef}
            type="file"
            accept="image/png,image/svg+xml,image/jpeg"
            onChange={onFile}
            disabled={disabled || uploading}
            className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border file:border-gray-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-50 disabled:opacity-50"
          />
          <p className="text-xs text-gray-500 mt-1">PNG, SVG or JPG, up to 1 MB.</p>
          {uploading && (
            <p className="text-xs text-gray-500 mt-1 inline-flex items-center gap-1">
              <Spinner small /> Uploading…
            </p>
          )}
        </div>
      ) : (
        <div>
          <TextInput label="Logo URL" value={logoUrl} onChange={onChange} placeholder="https://…/logo.png" />
          <p className="text-xs text-gray-500 mt-1">
            {uploadDisabled
              ? 'Direct uploads aren’t available on this server yet — paste a public image URL (e.g. from your website or a file host).'
              : 'Paste a public link to your logo, or switch to Upload.'}
          </p>
        </div>
      )}

      {uploadError && <p className="text-xs text-red-600 mt-2">{uploadError}</p>}

      {logoUrl ? (
        <div className="mt-3 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoUrl} alt="Logo preview" className="h-10 w-auto max-w-[160px] object-contain border border-gray-100 rounded" />
          <span className="text-xs text-gray-500">Preview</span>
          {!disabled && (
            <button type="button" onClick={() => onChange('')} className="text-xs text-gray-400 hover:text-gray-600 underline">
              Remove
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

// ─── BrandPreview ────────────────────────────────────────────────────────────
// Non-interactive mock of the employee self-service surface, driven by the
// chosen primary color + logo. "This is what your employees see."
function BrandPreview({ primary, logoUrl }) {
  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-900 mb-3">Preview</h2>
      <div className="rounded-2xl border border-gray-200 overflow-hidden bg-gray-50" aria-hidden="true">
        {/* ESS header */}
        <div className="flex items-center justify-between px-4 h-12" style={{ backgroundColor: primary }}>
          <div className="flex items-center gap-2">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="h-6 w-auto max-w-[120px] object-contain" />
            ) : (
              <span className="text-sm font-semibold text-white">Your Company</span>
            )}
          </div>
          <span className="h-6 w-6 rounded-full bg-white/30" />
        </div>
        {/* Login-card mock */}
        <div className="flex justify-center py-8 px-4">
          <div className="w-full max-w-xs rounded-xl bg-white border border-gray-200 p-5 shadow-sm">
            <div className="flex justify-center mb-4">
              {logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoUrl} alt="" className="h-8 w-auto max-w-[140px] object-contain" />
              ) : (
                <span className="h-8 w-8 rounded-lg" style={{ backgroundColor: primary }} />
              )}
            </div>
            <p className="text-center text-sm font-semibold text-gray-900 mb-4">Sign in to your portal</p>
            <div className="space-y-2 mb-4">
              <div className="h-8 rounded-md border border-gray-200 bg-gray-50" />
              <div className="h-8 rounded-md border border-gray-200 bg-gray-50" />
            </div>
            <div className="h-9 rounded-md flex items-center justify-center text-sm font-semibold text-white" style={{ backgroundColor: primary }}>
              Sign in
            </div>
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2">This is what your employees see.</p>
    </section>
  );
}

function BrandingReadOnlyBanner() {
  return (
    <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
      <span aria-hidden="true">🔒 </span>
      You have read-only access to branding. Editing the style, colors or logo requires the
      <span className="font-medium"> canEditBranding</span> permission.
    </p>
  );
}

function BrandingTab() {
  const [styleKey, setStyleKey] = useState('indigo');
  const [colorKey, setColorKey] = useState('indigo');
  const [customHex, setCustomHex] = useState(''); // freeform override
  const [logoUrl, setLogoUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [canEdit, setCanEdit] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      // Brand is optional — on an admin origin /api/tenant/resolve can 404
      // (no tenant host context). Mirror AdminShell and swallow it so the
      // whole load doesn't fail; we fall back to defaults and the saved theme
      // still round-trips via /api/auth/me + the next resolve.
      get('/api/tenant/resolve').catch(() => ({})),
      get('/api/auth/me').catch(() => null),
    ])
      .then(([res, me]) => {
        const brand = res?.brand || res?.subscription || res || {};
        const hr = res?.hrTheme || res?.theme || {};
        // themeColors arrives as a JSON STRING from /api/tenant/resolve's
        // `subscription.themeColors` (it's persisted as JSON). Parse it so
        // `primary` and the curated `colorKey` round-trip; tolerate an already-
        // parsed object (brand.themeColors) or a bad/empty value.
        const tc = parseThemeColors(brand.themeColors ?? hr.themeColors);
        setStyleKey(brand.styleKey || hr.styleKey || brand.themeStyle || hr.themeStyle || 'indigo');
        const ck = tc.colorKey || brand.colorKey || hr.colorKey || '';
        setColorKey(ck || 'indigo');
        // A stored primary that isn't a curated color surfaces as the custom hex.
        const storedPrimary = tc.primary || brand.primary || hr.primary;
        if (!ck && storedPrimary && HEX_RE.test(storedPrimary)) setCustomHex(normalizeHex(storedPrimary));
        setLogoUrl(brand.logoUrl || hr.logoUrl || res?.content?.logoUrl || res?.business?.logoUrl || '');
        const session = me?.user || me;
        setCanEdit(hasPermission(permissionsFromSession(session), 'canEditBranding'));
      })
      .catch((e) => setError(e.message || 'Failed to load branding.'))
      .finally(() => setLoading(false));
  }, []);

  // A valid custom hex wins; otherwise the curated swatch supplies the primary.
  const swatchHex = useMemo(() => resolveColor(colorKey), [colorKey]);
  const customNorm = useMemo(() => normalizeHex(customHex), [customHex]);
  const primaryHex = customNorm || swatchHex;

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // The tenant resolver reads themeStyle + themeColors.primary; we also
      // carry colorKey so the picker round-trips on reload. A freeform hex
      // clears colorKey so it round-trips as a custom primary.
      await request('/api/subscription/theme', {
        method: 'PUT',
        body: JSON.stringify({
          themeStyle: styleKey,
          themeColors: { primary: primaryHex, colorKey: customNorm ? null : colorKey },
          logoUrl: logoUrl || null,
        }),
      });
      setSaved(true);
      if (typeof document !== 'undefined') {
        document.documentElement.style.setProperty('--theme-primary', primaryHex);
      }
    } catch (e) {
      setError(e.data?.message || e.message || 'Failed to save branding.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;

  const ro = !canEdit;

  return (
    <div className="max-w-3xl space-y-8">
      {ro && <BrandingReadOnlyBanner />}
      {error && <ErrorBanner message={error} />}
      {saved && (
        <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
          Branding saved.
        </p>
      )}

      <section>
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Style</h2>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {STYLE_OPTIONS.map((s) => {
            const on = s.key === styleKey;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => !ro && setStyleKey(s.key)}
                disabled={ro}
                aria-pressed={on}
                className={`rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${on ? 'border-transparent ring-2' : 'border-gray-200 hover:border-gray-300'}`}
                style={on ? { '--tw-ring-color': primaryHex, boxShadow: `0 0 0 2px ${primaryHex}` } : undefined}
              >
                <span className="block h-8 rounded-md mb-2" style={{ backgroundColor: s.primary }} />
                <span className="text-sm font-medium text-gray-900">{s.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Brand color</h2>
        <div className="grid grid-cols-6 sm:grid-cols-12 gap-2">
          {COLORS.map((c) => {
            const on = !customNorm && c.key === colorKey;
            return (
              <button
                key={c.key}
                type="button"
                title={c.name}
                onClick={() => {
                  if (ro) return;
                  setColorKey(c.key);
                  setCustomHex(''); // picking a swatch clears the freeform override
                }}
                disabled={ro}
                className={`h-10 rounded-lg border transition-transform disabled:cursor-not-allowed disabled:opacity-60 ${on ? 'ring-2 ring-offset-2 scale-105' : 'border-gray-200 hover:scale-105'}`}
                style={{ backgroundColor: c.hex, ...(on ? { '--tw-ring-color': c.hex } : {}) }}
                aria-label={c.name}
                aria-pressed={on}
              />
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Selected:{' '}
          <span className="font-medium text-gray-700">
            {customNorm ? 'Custom' : COLORS.find((c) => c.key === colorKey)?.name}
          </span>{' '}
          ({primaryHex})
        </p>
        <div className="mt-4">
          <HexColorInput value={customHex} onChange={setCustomHex} disabled={ro} />
        </div>
      </section>

      <LogoUploader logoUrl={logoUrl} onChange={ro ? () => {} : setLogoUrl} disabled={ro} />

      <BrandPreview primary={primaryHex} logoUrl={logoUrl} />

      <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
        <PrimaryButton loading={saving} onClick={save} disabled={ro}>
          Save branding
        </PrimaryButton>
        <span className="inline-flex items-center gap-2 text-sm text-gray-500">
          <span className="h-5 w-5 rounded-full" style={{ backgroundColor: primaryHex }} />
          Primary preview
        </span>
      </div>
    </div>
  );
}

function RolesTab() {
  const [roles, setRoles] = useState(null);
  const [permMeta, setPermMeta] = useState(null);
  const [canManage, setCanManage] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      get('/api/rbac/roles').catch(() => ({ roles: [] })),
      get('/api/rbac/permissions').catch(() => ({ permissions: [], systemRoles: [] })),
      get('/api/auth/me').catch(() => null),
    ])
      .then(([r, p, me]) => {
        setRoles(asList(r?.roles ? { items: r.roles } : r));
        setPermMeta(p);
        // Hide the management link from operators who can't administer roles
        // (the server also enforces BUSINESS_ADMIN on /settings/roles).
        const session = me?.user || me;
        setCanManage(hasPermission(permissionsFromSession(session), 'canManageEmployees'));
      })
      .catch((e) => setError(e.message || 'Failed to load roles.'))
      .finally(() => setLoading(false));
  }, []);

  function permCount(role) {
    const p = role.permissions;
    if (Array.isArray(p)) return p.length;
    if (p && typeof p === 'object') return Object.values(p).filter(Boolean).length;
    return role.permissionCount ?? '—';
  }

  const columns = [
    { key: 'name', header: 'Role', render: (r) => <span className="font-medium text-gray-900">{r.name || r.key}</span> },
    { key: 'system', header: 'Type', render: (r) => (r.isSystem || r.system ? 'System' : 'Custom') },
    { key: 'perms', header: 'Permissions', render: (r) => permCount(r) },
    { key: 'members', header: 'Members', render: (r) => r.memberCount ?? r.userCount ?? '—' },
  ];

  const catalogPermCount =
    permMeta?.permissions && typeof permMeta.permissions === 'object'
      ? Object.keys(permMeta.permissions).length
      : permMeta?.permissions?.length;

  return (
    <div className="max-w-3xl">
      {error && <ErrorBanner message={error} />}
      <div className="flex items-center justify-between mb-4 gap-4">
        <p className="text-sm text-gray-500">
          Overview of the tenant&apos;s roles. Edit permissions, data scope, and per-user assignments on the roles &amp;
          access screen.
        </p>
        {canManage && (
          <Link
            href="/settings/roles"
            className="shrink-0 px-3 py-2 text-sm font-medium text-white rounded-lg inline-flex items-center"
            style={{ backgroundColor: 'var(--theme-primary)' }}
          >
            Manage roles &amp; access
          </Link>
        )}
      </div>
      <DataTable columns={columns} rows={roles} loading={loading} emptyText="No roles defined." />
      {catalogPermCount ? (
        <p className="text-xs text-gray-400 mt-3">{catalogPermCount} permissions available across the catalog.</p>
      ) : null}
    </div>
  );
}

export default function SettingsPage() {
  const [perms, setPerms] = useState(null); // null = not resolved → allow-all
  const [tab, setTab] = useState(null);

  // Resolve the operator's permissions once so tab visibility matches what each
  // tab can actually do (e.g. a Finance role sees Billing but not Branding).
  useEffect(() => {
    get('/api/auth/me')
      .then((me) => setPerms(permissionsFromSession(me?.user || me)))
      .catch(() => setPerms(null)); // unknown → allow-all (tabs all visible)
  }, []);

  // Branding is the default/landing tab and stays visible to everyone (it shows
  // read-only without canEditBranding). Billing only appears for billing-capable
  // operators. Roles is an overview anyone in Settings can see.
  const tabs = useMemo(() => {
    const out = [{ key: 'branding', label: 'Branding' }];
    if (perms === null || hasPermission(perms, 'canEditBilling')) out.push({ key: 'billing', label: 'Billing' });
    out.push({ key: 'roles', label: 'Roles' });
    return out;
  }, [perms]);

  // Default to the first available tab once permissions resolve — OR honor a
  // ?tab=<key> deep-link (e.g. the recruitment add-on upsell links to
  // /settings?tab=billing). Read from the URL directly to avoid a Suspense
  // boundary around useSearchParams.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const wanted = new URLSearchParams(window.location.search).get('tab');
      if (wanted && tabs.some((t) => t.key === wanted)) { setTab(wanted); return; }
    }
    if (tab === null || !tabs.some((t) => t.key === tab)) setTab(tabs[0]?.key || 'branding');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  const active = tab || 'branding';

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Branding, billing, domain and roles"
        actions={
          <Link
            href="/settings/domain"
            className="px-3 py-2 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 inline-flex items-center"
          >
            Domain &amp; address
          </Link>
        }
      />
      <ModuleGuide
        id="settings"
        title="Brand your portal and govern who can do what"
        what="Settings is the tenant control panel: brand the employee self-service portal (style, colour, logo), manage your subscription &amp; billing, and review the roles that decide which admins can run payroll, edit branding, or manage people."
        steps={[
          'On the Branding tab, pick a Style and a Brand colour (or paste an exact hex like #4F46E5 to match your corporate identity).',
          'Add your Logo by uploading a PNG/SVG/JPG (up to 1 MB) or pasting a public image URL.',
          'Check the live Preview — it shows exactly what your employees see on the sign-in screen — then click Save branding.',
          'Open the Billing tab to review or change your subscription plan and invoices.',
          'Open the Roles tab to see each role, its permission count and members; use Manage roles & access to edit who can do what.',
        ]}
        example={<>Acme India Pvt Ltd sets the style to <b>Indigo</b>, pastes their brand hex <b>#4F46E5</b>, and uploads their logo. Now when <b>Aarav Sharma</b> signs in to the employee portal to view his June 2026 payslip, he sees the Acme logo and colours. On the Roles tab, the admin confirms only the <b>Payroll Manager</b> role carries <b>canRunPayroll</b>, so finance can&apos;t accidentally edit branding.</>}
        tips={[
          'No Save button on Branding? You have read-only access — editing needs the canEditBranding permission.',
          'A custom hex overrides the curated swatch; clear the field to fall back to a curated brand colour.',
        ]}
      />
      <Tabs tabs={tabs} active={active} onChange={setTab} />
      {active === 'branding' && <BrandingTab />}
      {active === 'billing' && <BillingTab />}
      {active === 'roles' && <RolesTab />}
    </div>
  );
}
