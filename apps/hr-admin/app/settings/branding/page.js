'use client';

// Settings → Branding (white-label).
//
// DriftHR is the VENDOR. This page lets a tenant set THEIR OWN brand so it shows
// everywhere — the HR console, the ESS portal, and both login pages — and the
// DriftHR mark NEVER appears on a tenant surface.
//
// What it edits (all tenant-wide; the server scopes by session businessId):
//   • Logo + favicon — uploaded via POST /api/hr/branding/asset (reuses the same
//     S3 door as /api/upload/image; falls back to an inline data URL when image
//     hosting isn't configured, so small logos still work).
//   • Primary / secondary / accent colours (hex) — primary flows to
//     --theme-primary so saving re-themes the portal.
//   • Display name (portal header + login + emails), support email, email-from.
//
// Save → PUT /api/hr/branding upserts the tenant-wide TenantBrand and mirrors
// logo/favicon → BusinessContent and primary → Subscription.themeColors, so the
// existing readers + the theme engine pick the brand up on the next resolve.
//
// Gated on canEditDomain OR canManageCompanyProfile OR canEditBranding (server is
// the real boundary; this page hides the controls + shows a read-only banner when
// the operator lacks every key). Every field carries an ⓘ tooltip.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorBanner, PrimaryButton, Spinner } from '@hr/ui';
import { get, put, post } from '@/lib/api';
import { PageHeader } from '@/lib/ui';
import { FieldLabel, SectionTitle, InfoTip } from '@/lib/widgets';
import { permissionsFromSession, hasPermission } from '@/lib/nav';
import ModuleGuide from '@/components/ModuleGuide';

const BRANDING_KEYS = ['canEditBranding', 'canEditDomain', 'canManageCompanyProfile'];
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_ASSET_BYTES = 2 * 1024 * 1024; // 2 MB — logos/favicons are small
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon'];

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function isHex(v) { return typeof v === 'string' && HEX.test(v); }

// Pick legible text colour for a given background (WCAG-ish relative luminance).
function onColor(hex) {
  if (!isHex(hex)) return '#FFFFFF';
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.5 ? '#0F172A' : '#FFFFFF';
}

// One labelled colour input — a native swatch + a hex text box, kept in sync.
function ColorField({ label, tip, value, onChange, disabled, placeholder = '#4F46E5' }) {
  const valid = !value || isHex(value);
  return (
    <div>
      <FieldLabel tip={tip}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour picker`}
          value={isHex(value) ? value : '#FFFFFF'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          disabled={disabled}
          className="h-9 w-12 cursor-pointer rounded border border-gray-300 bg-white p-0.5 disabled:opacity-50"
        />
        <input
          type="text"
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={`w-32 rounded-lg border px-3 py-2 text-sm uppercase outline-none focus:ring-2 disabled:bg-gray-50 ${valid ? 'border-gray-300' : 'border-red-400'}`}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            disabled={disabled}
            className="text-xs text-gray-500 underline disabled:opacity-50"
          >
            clear
          </button>
        )}
      </div>
      {!valid && <p className="mt-1 text-xs text-red-600">Enter a hex colour like #4F46E5.</p>}
    </div>
  );
}

// One labelled text field with an ⓘ tooltip.
function TextField({ label, tip, value, onChange, placeholder, disabled, type = 'text' }) {
  return (
    <div>
      <FieldLabel tip={tip}>{label}</FieldLabel>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 disabled:bg-gray-50"
      />
    </div>
  );
}

// An image picker (logo / favicon) — choose a file, upload (or inline-fallback),
// show a preview, and clear.
function AssetField({ label, tip, kind, value, onChange, disabled, previewBg = '#FFFFFF' }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setErr('');
    if (!ALLOWED_TYPES.includes(file.type)) {
      setErr('Use a PNG, JPG, SVG, WebP or ICO image.');
      return;
    }
    if (file.size > MAX_ASSET_BYTES) {
      setErr('Image must be 2 MB or smaller.');
      return;
    }
    setBusy(true);
    try {
      const dataUrl = await readAsDataUrl(file);
      try {
        // Prefer hosted upload (a stable URL).
        const r = await post('/api/hr/branding/asset', { dataUrl, kind });
        onChange(r?.url || dataUrl);
      } catch (uploadErr) {
        // 501 = image hosting not configured → embed the data URL inline. Any
        // other error surfaces to the operator.
        if (uploadErr?.status === 501) onChange(dataUrl);
        else throw uploadErr;
      }
    } catch (ex) {
      setErr(ex?.message || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <FieldLabel tip={tip}>{label}</FieldLabel>
      <div className="flex items-center gap-3">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-gray-200"
          style={{ background: previewBg }}
        >
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt={`${label} preview`} className="max-h-12 max-w-12 object-contain" />
          ) : (
            <span className="text-[10px] text-gray-400">none</span>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || busy}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy ? 'Uploading…' : value ? 'Replace' : 'Upload'}
            </button>
            {value && (
              <button
                type="button"
                onClick={() => onChange('')}
                disabled={disabled}
                className="text-xs text-gray-500 underline disabled:opacity-50"
              >
                remove
              </button>
            )}
          </div>
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED_TYPES.join(',')}
          onChange={onPick}
          className="hidden"
        />
      </div>
    </div>
  );
}

// Live preview of the portal header + login wordmark with the chosen brand.
// Mirrors the de-DriftHR rule: a logo if set, else the display name as a styled
// wordmark using the primary colour — never the DriftHR mark.
function BrandPreview({ logoUrl, name, primary }) {
  const p = isHex(primary) ? primary : '#4F46E5';
  const fg = onColor(p);
  const displayName = name || 'Your business';
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      {/* Portal header bar */}
      <div className="flex items-center gap-3 px-4 py-3" style={{ background: p, color: fg }}>
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={`${displayName} logo`} className="h-7 w-auto max-w-[140px] object-contain" />
        ) : (
          <span className="text-base font-semibold tracking-tight">{displayName}</span>
        )}
        <span className="ml-auto text-xs opacity-80">Portal header</span>
      </div>
      {/* Login card */}
      <div className="flex flex-col items-center gap-3 bg-gray-50 px-4 py-6 text-center">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={`${displayName} logo`} className="h-10 w-auto max-w-[160px] object-contain" />
        ) : (
          <div
            className="flex h-12 items-center justify-center rounded-xl px-4 text-lg font-bold"
            style={{ background: p, color: fg }}
          >
            {displayName}
          </div>
        )}
        <div>
          <div className="text-sm font-semibold text-gray-900">{displayName}</div>
          <div className="text-xs text-gray-500">Sign in to your account</div>
        </div>
        <button
          type="button"
          disabled
          className="mt-1 w-40 rounded-lg py-2 text-sm font-semibold"
          style={{ background: p, color: fg }}
        >
          Sign in
        </button>
      </div>
    </div>
  );
}

const EMPTY = {
  logoUrl: '', faviconUrl: '', primaryColor: '', secondaryColor: '', accentColor: '',
  name: '', supportEmail: '', emailFromName: '', emailFooter: '',
};

export default function BrandingPage() {
  const [form, setForm] = useState(EMPTY);
  const [businessName, setBusinessName] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [canEdit, setCanEdit] = useState(true);

  const set = (k) => (v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [me, data] = await Promise.all([
          get('/api/auth/me').catch(() => null),
          get('/api/hr/branding').catch((e) => { throw e; }),
        ]);
        if (!alive) return;
        const session = me?.user || me;
        if (session) {
          const perms = permissionsFromSession(session);
          setCanEdit(BRANDING_KEYS.some((k) => hasPermission(perms, k)));
        }
        const b = data?.brand || {};
        setBusinessName(data?.businessName || '');
        setForm({
          logoUrl: b.logoUrl || '',
          faviconUrl: b.faviconUrl || '',
          primaryColor: b.primaryColor || '',
          secondaryColor: b.secondaryColor || '',
          accentColor: b.accentColor || '',
          name: b.name || '',
          supportEmail: b.supportEmail || '',
          emailFromName: b.emailFromName || '',
          emailFooter: b.emailFooter || '',
        });
      } catch (e) {
        if (alive) setError(e?.message || 'Could not load branding.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const colorsValid = useMemo(
    () => ['primaryColor', 'secondaryColor', 'accentColor'].every((k) => !form[k] || isHex(form[k])),
    [form]
  );

  async function onSave(e) {
    e?.preventDefault();
    setError('');
    setSaved(false);
    if (!colorsValid) { setError('Fix the invalid hex colour before saving.'); return; }
    setSaving(true);
    try {
      const r = await put('/api/hr/branding', form);
      const b = r?.brand || {};
      setForm((f) => ({
        ...f,
        logoUrl: b.logoUrl || '',
        faviconUrl: b.faviconUrl || '',
        primaryColor: b.primaryColor || '',
        secondaryColor: b.secondaryColor || '',
        accentColor: b.accentColor || '',
        name: b.name || f.name,
        supportEmail: b.supportEmail || '',
        emailFromName: b.emailFromName || '',
        emailFooter: b.emailFooter || '',
      }));
      setSaved(true);
    } catch (ex) {
      setError(ex?.message || 'Could not save branding.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="p-6 sm:p-8"><Spinner /></div>;
  }

  const previewName = form.name || businessName || '';

  return (
    <div className="p-6 sm:p-8">
      <PageHeader
        title={(
          <span className="inline-flex items-center">
            Branding
            <InfoTip text="Set your own logo, colours and name. They show on the HR console, the employee portal, and both login pages — your brand, everywhere." />
          </span>
        )}
        subtitle="Make the portal yours — logo, colours, and display name."
      />

      <ModuleGuide
        id="settings-branding"
        title="White-label your portal"
        what="Branding makes the HR console, the employee self-service portal, and both login pages carry your company's identity — logo, colours and name — instead of DriftHR's. The brand applies tenant-wide and re-themes the portal the moment you save."
        steps={[
          'Set the Display name (e.g. Acme India Pvt Ltd) — this shows in the portal header, on the login page, and as the sender on payslip/letter emails.',
          'Upload your Logo (PNG or SVG with transparency, under 2 MB) and a square Favicon (16×16 or 32×32) for the browser tab.',
          'Pick your Primary colour as a hex value (e.g. #1D4ED8) — it themes buttons, links and active nav; add Secondary and Accent if you want them.',
          'Fill in Email from-name (e.g. Acme India HR) and Support email (e.g. hr@acmeindia.in) so employee emails look like they come from you.',
          'Watch the Live preview update, then click Save branding and reload the portal to see your brand everywhere.',
        ]}
        example={<>Acme India Pvt Ltd uploads its logo, sets Primary <b>#1D4ED8</b>, Display name <b>Acme India Pvt Ltd</b> and from-name <b>Acme India HR</b>. On save, every employee — from <b>Aarav Sharma</b> in Bengaluru downloading his June 2026 payslip to a new hire on the login page — sees the Acme brand, never the DriftHR mark.</>}
        tips={[
          'If you skip the logo, your display name is shown as a styled wordmark in your primary colour — so set the colour even when you have no logo.',
          'Changes are tenant-wide and need the branding permission; without it you get a read-only view. After saving, do a hard reload as colours are cached in the theme engine.',
        ]}
      />

      {!canEdit && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          You have read-only access to branding. Ask an Owner or an admin with the branding
          permission to make changes.
        </div>
      )}

      <form onSubmit={onSave} className="mt-6 grid gap-8 lg:grid-cols-[1fr_360px]">
        {/* Left: the editable fields */}
        <div className="space-y-8">
          {/* Identity */}
          <section className="space-y-4">
            <SectionTitle tip="What employees see in the portal header, on the login page, and in emails.">
              Identity
            </SectionTitle>
            <TextField
              label="Display name"
              tip="Your business name as shown in the portal header and on the login page. Defaults to your registered business name."
              value={form.name}
              onChange={set('name')}
              placeholder={businessName || 'e.g. Acme Corp'}
              disabled={!canEdit}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <AssetField
                label="Logo"
                tip="Shown in the portal sidebar/header and on the login page. PNG/SVG with transparency works best. If you don't set a logo, your display name is shown as a styled wordmark."
                kind="logo"
                value={form.logoUrl}
                onChange={set('logoUrl')}
                disabled={!canEdit}
                previewBg={isHex(form.primaryColor) ? form.primaryColor : '#FFFFFF'}
              />
              <AssetField
                label="Favicon"
                tip="The small icon shown in the browser tab. A square PNG or ICO (16×16 or 32×32) works best."
                kind="favicon"
                value={form.faviconUrl}
                onChange={set('faviconUrl')}
                disabled={!canEdit}
              />
            </div>
          </section>

          {/* Colours */}
          <section className="space-y-4">
            <SectionTitle tip="Your brand colours. The primary colour themes buttons, links and highlights across the whole portal.">
              Colours
            </SectionTitle>
            <div className="grid gap-4 sm:grid-cols-3">
              <ColorField
                label="Primary"
                tip="The main brand colour — buttons, links, active nav, highlights. This is what re-themes the portal when you save."
                value={form.primaryColor}
                onChange={set('primaryColor')}
                disabled={!canEdit}
                placeholder="#4F46E5"
              />
              <ColorField
                label="Secondary"
                tip="A supporting colour for secondary accents (optional)."
                value={form.secondaryColor}
                onChange={set('secondaryColor')}
                disabled={!canEdit}
                placeholder="#64748B"
              />
              <ColorField
                label="Accent"
                tip="An accent colour for badges/callouts (optional). Falls back to the primary colour."
                value={form.accentColor}
                onChange={set('accentColor')}
                disabled={!canEdit}
                placeholder="#0EA5E9"
              />
            </div>
          </section>

          {/* Email + support */}
          <section className="space-y-4">
            <SectionTitle tip="Used on emails the portal sends to your employees (e.g. payslip / letter notifications).">
              Email &amp; support
            </SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Email from-name"
                tip="The sender name on emails to employees, e.g. 'Acme Corp HR'."
                value={form.emailFromName}
                onChange={set('emailFromName')}
                placeholder={previewName ? `${previewName} HR` : 'Acme Corp HR'}
                disabled={!canEdit}
              />
              <TextField
                label="Support email"
                tip="Where employees should reach your HR/support team. Shown in the portal and email footers."
                type="email"
                value={form.supportEmail}
                onChange={set('supportEmail')}
                placeholder="hr@acme.com"
                disabled={!canEdit}
              />
            </div>
            <TextField
              label="Email footer"
              tip="A short line added to the bottom of emails (e.g. address or a confidentiality note)."
              value={form.emailFooter}
              onChange={set('emailFooter')}
              placeholder="Acme Corp · 123 Street · City"
              disabled={!canEdit}
            />
          </section>

          {error && <ErrorBanner message={error} />}

          <div className="flex items-center gap-3">
            <PrimaryButton type="submit" loading={saving} disabled={!canEdit || !colorsValid}>
              Save branding
            </PrimaryButton>
            {saved && <span className="text-sm text-green-600">Saved. Reload the portal to see your brand.</span>}
          </div>
        </div>

        {/* Right: live preview */}
        <div className="space-y-3 lg:sticky lg:top-6 self-start">
          <SectionTitle tip="A live preview of how your brand looks. The real portal applies the same colours and logo.">
            Live preview
          </SectionTitle>
          <BrandPreview logoUrl={form.logoUrl} name={previewName} primary={form.primaryColor} />
          <p className="text-xs text-gray-500">
            No logo? Your display name shows as a styled wordmark in your primary colour. The
            DriftHR brand never appears on your employees&apos; portal.
          </p>
        </div>
      </form>
    </div>
  );
}
