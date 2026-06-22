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

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { COLORS, FIXED_STYLE_KEYS, FIXED_STYLE_SEEDS, resolveColor } from '@hr/theme-engine';
import { ErrorBanner, PrimaryButton, TextInput, Spinner } from '@hr/ui';
import { get, request } from '@/lib/api';
import { asList, PageHeader, Tabs, DataTable } from '@/lib/ui';
import { permissionsFromSession, hasPermission } from '@/lib/nav';

const STYLE_OPTIONS = FIXED_STYLE_KEYS.map((key) => ({
  key,
  label: FIXED_STYLE_SEEDS[key]?.label || key,
  primary: FIXED_STYLE_SEEDS[key]?.palette?.primary,
}));

function BrandingTab() {
  const [styleKey, setStyleKey] = useState('indigo');
  const [colorKey, setColorKey] = useState('indigo');
  const [logoUrl, setLogoUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLoading(true);
    get('/api/tenant/resolve')
      .then((res) => {
        const brand = res?.brand || res?.subscription || res || {};
        const hr = res?.hrTheme || res?.theme || {};
        setStyleKey(brand.styleKey || hr.styleKey || brand.themeStyle || 'indigo');
        setColorKey(brand.colorKey || hr.colorKey || 'indigo');
        setLogoUrl(brand.logoUrl || hr.logoUrl || res?.business?.logoUrl || '');
      })
      .catch((e) => setError(e.message || 'Failed to load branding.'))
      .finally(() => setLoading(false));
  }, []);

  const primaryHex = useMemo(() => resolveColor(colorKey), [colorKey]);

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      // The tenant resolver reads themeStyle + themeColors.primary; we also
      // carry colorKey so the picker round-trips on reload.
      await request('/api/subscription/theme', {
        method: 'PUT',
        body: JSON.stringify({
          themeStyle: styleKey,
          themeColors: { primary: primaryHex, colorKey },
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

  return (
    <div className="max-w-3xl space-y-8">
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
                onClick={() => setStyleKey(s.key)}
                className={`rounded-xl border p-3 text-left transition-colors ${on ? 'border-transparent ring-2' : 'border-gray-200 hover:border-gray-300'}`}
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
            const on = c.key === colorKey;
            return (
              <button
                key={c.key}
                type="button"
                title={c.name}
                onClick={() => setColorKey(c.key)}
                className={`h-10 rounded-lg border transition-transform ${on ? 'ring-2 ring-offset-2 scale-105' : 'border-gray-200 hover:scale-105'}`}
                style={{ backgroundColor: c.hex, ...(on ? { '--tw-ring-color': c.hex } : {}) }}
                aria-label={c.name}
                aria-pressed={on}
              />
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Selected: <span className="font-medium text-gray-700">{COLORS.find((c) => c.key === colorKey)?.name}</span> ({primaryHex})
        </p>
      </section>

      <section className="max-w-md">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">Logo</h2>
        <TextInput label="Logo URL" value={logoUrl} onChange={setLogoUrl} placeholder="https://…/logo.png" />
        {logoUrl ? (
          <div className="mt-3 flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={logoUrl} alt="Logo preview" className="h-10 w-auto max-w-[160px] object-contain border border-gray-100 rounded" />
            <span className="text-xs text-gray-500">Preview</span>
          </div>
        ) : null}
      </section>

      <div className="flex items-center gap-3 pt-2 border-t border-gray-100">
        <PrimaryButton loading={saving} onClick={save}>
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

const TABS = [
  { key: 'branding', label: 'Branding' },
  { key: 'roles', label: 'Roles' },
];

export default function SettingsPage() {
  const [tab, setTab] = useState('branding');
  return (
    <div>
      <PageHeader title="Settings" subtitle="Branding and roles" />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === 'branding' && <BrandingTab />}
      {tab === 'roles' && <RolesTab />}
    </div>
  );
}
