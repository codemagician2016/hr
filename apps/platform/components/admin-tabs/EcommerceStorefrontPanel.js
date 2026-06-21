'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTenant } from '@/components/TenantProvider';
import { api } from '@/lib/adminApi';
import { ErrorBanner, PrimaryButton, Spinner, TextInput } from '@/components/admin-ui';
import ImageDropZone from '@/components/ImageDropZone';

const SOCIAL_FIELDS = [
  {
    network: 'facebook',
    urlKey: 'socialFacebook',
    showKey: 'showSocialFacebook',
    label: 'Facebook',
    placeholder: 'facebook.com/your-store or @yourstore',
    hosts: ['facebook.com', 'fb.com'],
    color: '#1877F2',
  },
  {
    network: 'instagram',
    urlKey: 'socialInstagram',
    showKey: 'showSocialInstagram',
    label: 'Instagram',
    placeholder: 'instagram.com/your-store or @yourstore',
    hosts: ['instagram.com'],
    color: '#E4405F',
  },
  {
    network: 'twitter',
    urlKey: 'socialTwitter',
    showKey: 'showSocialTwitter',
    label: 'X / Twitter',
    placeholder: 'x.com/your-store or @yourstore',
    hosts: ['x.com', 'twitter.com'],
    color: '#111827',
  },
  {
    network: 'linkedin',
    urlKey: 'socialLinkedin',
    showKey: 'showSocialLinkedin',
    label: 'LinkedIn',
    placeholder: 'linkedin.com/company/your-store or your-store',
    hosts: ['linkedin.com'],
    color: '#0A66C2',
  },
  {
    network: 'youtube',
    urlKey: 'socialYoutube',
    showKey: 'showSocialYoutube',
    label: 'YouTube',
    placeholder: 'youtube.com/@your-store or @yourstore',
    hosts: ['youtube.com', 'youtu.be'],
    color: '#FF0000',
  },
];

const LOGO_FRAME_OPTIONS = [
  {
    value: 'square',
    label: 'Icon',
    size: '1:1 · 512 × 512 px',
    description: 'Best for compact marks and app-style icons.',
    aspect: 1,
  },
  {
    value: 'rectangle',
    label: 'Standard logo',
    size: '3:1 · 1200 × 400 px',
    description: 'Best for most store wordmarks.',
    aspect: 3,
  },
  {
    value: 'wide',
    label: 'Wide logo',
    size: '4:1 · 1600 × 400 px',
    description: 'Best for long horizontal brand marks.',
    aspect: 4,
  },
];

const CONTENT_DEFAULTS = {
  logoUrl: '',
  logoSourceUrl: '',
  logoAspect: 'wide',
  faviconUrl: '',
  tagline: '',
  navbarBusinessName: '',
  showLogo: true,
  showBusinessName: true,
  showTagline: true,
  socialFacebook: '',
  socialInstagram: '',
  socialTwitter: '',
  socialLinkedin: '',
  socialYoutube: '',
  showSocialFacebook: false,
  showSocialInstagram: false,
  showSocialTwitter: false,
  showSocialLinkedin: false,
  showSocialYoutube: false,
};

const MANAGED_CONTENT_FIELDS = new Set(Object.keys(CONTENT_DEFAULTS));

function pickManagedContent(data = {}) {
  const out = {};
  for (const key of MANAGED_CONTENT_FIELDS) {
    if (data[key] !== undefined) out[key] = data[key];
  }
  return out;
}

function normalisePayload(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key]) => MANAGED_CONTENT_FIELDS.has(key))
      .map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() || null : value,
      ])
  );
}

function hasProtocol(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function looksLikeUrl(value) {
  return hasProtocol(value) || /^[a-z0-9.-]+\.[a-z]{2,}(?:[/?#:]|$)/i.test(value);
}

function parseHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = hasProtocol(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!url.hostname || !url.hostname.includes('.')) return null;
    return url;
  } catch {
    return null;
  }
}

function hostMatches(field, hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return field.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function hasProfilePath(url) {
  const path = url.pathname.replace(/\/+$/, '');
  return Boolean(path && path !== '/');
}

function handleToUrl(network, handle) {
  if (network === 'facebook') return `https://facebook.com/${handle}`;
  if (network === 'instagram') return `https://instagram.com/${handle}`;
  if (network === 'twitter') return `https://x.com/${handle}`;
  if (network === 'linkedin') return `https://linkedin.com/company/${handle}`;
  if (network === 'youtube') return `https://youtube.com/@${handle.replace(/^@/, '')}`;
  return null;
}

function cleanHandle(value) {
  const handle = value.trim().replace(/^@/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!handle || /\s/.test(handle) || /[?#]/.test(handle)) return null;
  return handle;
}

function socialLinkStatus(field, value) {
  const emptyMessage = `Please enter a ${field.label} link before enabling.`;
  if (typeof value !== 'string') return { ok: false, href: null, message: emptyMessage };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, href: null, message: emptyMessage };
  if (/\s/.test(trimmed)) {
    return { ok: false, href: null, message: `${field.label} links cannot contain spaces.` };
  }

  if (looksLikeUrl(trimmed)) {
    const url = parseHttpUrl(trimmed);
    if (!url) return { ok: false, href: null, message: `Please enter a valid ${field.label} link.` };
    if (!hostMatches(field, url.hostname)) {
      return { ok: false, href: null, message: `This field needs a ${field.label} profile link or handle.` };
    }
    if (!hasProfilePath(url)) {
      return { ok: false, href: null, message: `Please enter the ${field.label} profile/page link, not just the homepage.` };
    }
    return { ok: true, href: url.toString(), message: '' };
  }

  const handle = cleanHandle(trimmed);
  const fallback = handle ? handleToUrl(field.network, handle) : null;
  const url = fallback ? parseHttpUrl(fallback) : null;
  if (!url) return { ok: false, href: null, message: `Please enter a valid ${field.label} link or handle.` };
  return { ok: true, href: url.toString(), message: '' };
}

function Section({ title, description, children, actions }) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
        </div>
        {actions}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function ToggleRow({ checked, onChange, label, description }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 px-3 py-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1"
      />
      <span>
        <span className="block text-sm font-semibold text-gray-900">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-gray-500">{description}</span>}
      </span>
    </label>
  );
}

function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2',
        checked ? 'border-emerald-600 bg-emerald-600' : 'border-gray-300 bg-gray-200',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  );
}

function logoAspectRatio(value) {
  return LOGO_FRAME_OPTIONS.find((option) => option.value === value)?.aspect || 4;
}

function logoFrameOption(value) {
  return LOGO_FRAME_OPTIONS.find((option) => option.value === value) || LOGO_FRAME_OPTIONS[2];
}

function logoAspectForDimensions(width, height) {
  if (!width || !height) return null;
  const ratio = width / height;
  const normalized = ratio < 1 ? 1 / ratio : ratio;
  if (normalized < 1.35) return 'square';
  if (ratio > 3.25) return 'wide';
  return 'rectangle';
}

function LogoPreview({ logoUrl, logoAspect, storeName, tagline, showLogo, showBusinessName, showTagline }) {
  const initial = (storeName || 'S').charAt(0).toUpperCase();
  const frame = logoFrameOption(logoAspect);
  return (
    <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">Live preview</p>
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-3">
          {showLogo && (
            logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                className="h-11 rounded-xl bg-white object-contain"
                style={{ width: Math.min(44 * logoAspectRatio(logoAspect), 176) }}
              />
            ) : (
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-600 text-base font-bold text-white">
                {initial}
              </span>
            )
          )}
          <div className="min-w-0">
            {showBusinessName && <p className="truncate text-base font-bold text-gray-900">{storeName}</p>}
            {showTagline && tagline && <p className="truncate text-xs text-gray-500">{tagline}</p>}
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-500">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          {frame.label} frame. The storefront header will use this fitted mark.
        </div>
      </div>
    </div>
  );
}

export default function EcommerceStorefrontPanel({ refreshTenant }) {
  const { tenant } = useTenant();
  const business = tenant?.business || {};
  const [content, setContent] = useState(CONTENT_DEFAULTS);
  const [settings, setSettings] = useState({
    announcementBarEnabled: false,
    announcementBarText: '',
    announcementBarBgColor: '#146A39',
    announcementBarTextColor: '#ffffff',
    wishlistEnabled: true,
    wishlistIconType: 'bookmark',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [socialMessages, setSocialMessages] = useState({});

  useEffect(() => {
    setSettings({
      announcementBarEnabled: business.announcementBarEnabled ?? false,
      announcementBarText: business.announcementBarText || '',
      announcementBarBgColor: business.announcementBarBgColor || '#146A39',
      announcementBarTextColor: business.announcementBarTextColor || '#ffffff',
      wishlistEnabled: business.wishlistEnabled !== false,
      wishlistIconType: business.wishlistIconType || 'bookmark',
    });
  }, [
    business.announcementBarEnabled,
    business.announcementBarText,
    business.announcementBarBgColor,
    business.announcementBarTextColor,
    business.wishlistEnabled,
    business.wishlistIconType,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await api('/api/business/content');
        if (!cancelled) setContent({ ...CONTENT_DEFAULTS, ...pickManagedContent(data.content || {}) });
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load storefront settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const previewUrl = useMemo(() => {
    const slug = business.slug || tenant?.slug || '';
    return slug ? `/${slug}/shop` : '/shop';
  }, [business.slug, tenant?.slug]);

  function updateContent(field, value) {
    setContent((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  }

  function setSocialMessage(urlKey, message) {
    setSocialMessages((prev) => {
      const next = { ...prev };
      if (message) next[urlKey] = message;
      else delete next[urlKey];
      return next;
    });
  }

  function updateSocialUrl(field, value) {
    const status = socialLinkStatus(field, value);
    setContent((prev) => ({
      ...prev,
      [field.urlKey]: value,
      [field.showKey]: prev[field.showKey] === true && !status.ok ? false : prev[field.showKey],
    }));
    setSaved(false);
    if (!value.trim() || status.ok) {
      setSocialMessage(field.urlKey, '');
    }
  }

  function toggleSocial(field, enabled) {
    if (!enabled) {
      setContent((prev) => ({ ...prev, [field.showKey]: false }));
      setSaved(false);
      setSocialMessage(field.urlKey, '');
      return;
    }
    const status = socialLinkStatus(field, content[field.urlKey]);
    if (!status.ok) {
      setContent((prev) => ({ ...prev, [field.showKey]: false }));
      setSaved(false);
      setSocialMessage(field.urlKey, status.message);
      return;
    }
    setContent((prev) => ({ ...prev, [field.urlKey]: status.href, [field.showKey]: true }));
    setSaved(false);
    setSocialMessage(field.urlKey, '');
  }

  function updateSettings(field, value) {
    setSettings((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  }

  const logoFrameAspect = logoAspectRatio(content.logoAspect);
  const selectedLogoFrame = logoFrameOption(content.logoAspect);

  function prepareContentForSave() {
    const next = { ...content };
    const messages = {};
    for (const field of SOCIAL_FIELDS) {
      const raw = typeof next[field.urlKey] === 'string' ? next[field.urlKey] : '';
      const status = socialLinkStatus(field, raw);
      if (!raw.trim()) {
        next[field.urlKey] = '';
        next[field.showKey] = false;
        continue;
      }
      if (!status.ok) {
        messages[field.urlKey] = status.message;
        next[field.showKey] = false;
      } else {
        next[field.urlKey] = status.href;
        next[field.showKey] = next[field.showKey] === true;
      }
    }

    if (Object.keys(messages).length > 0) {
      return { ok: false, content: next, messages };
    }
    return { ok: true, content: next, messages: {} };
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const prepared = prepareContentForSave();
      setContent(prepared.content);
      setSocialMessages(prepared.messages);
      if (!prepared.ok) {
        const firstMessage = Object.values(prepared.messages)[0];
        throw new Error(firstMessage || 'Please fix the social links before saving.');
      }
      await api('/api/business/content', {
        method: 'PUT',
        body: JSON.stringify(normalisePayload(prepared.content)),
      });
      await api('/api/business/settings', {
        method: 'PATCH',
        body: JSON.stringify(settings),
      });
      await refreshTenant?.();
      setSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save storefront');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="flex justify-center py-10"><Spinner /></div>;

  const storeName = content.navbarBusinessName || business.name || 'Your store';

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Storefront</h2>
            <p className="mt-1 max-w-3xl text-sm text-gray-500">
              Control ecommerce-only presentation: brand header, announcement bar, shopper features, and social links.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              href={previewUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              View storefront
            </a>
            <PrimaryButton onClick={save} loading={saving}>Save storefront</PrimaryButton>
          </div>
        </div>
        {saved && <p className="mt-3 text-sm font-medium text-emerald-700">Saved</p>}
        {error && <div className="mt-3"><ErrorBanner message={error} /></div>}
      </div>

      <Section
        title="Header and brand"
        description="Keep this light: products, categories, banners, and homepage blocks have their own ecommerce tools."
      >
        <div className="grid gap-5 lg:grid-cols-[1fr_0.9fr]">
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Logo</label>
              <div className="mb-3 grid gap-2 sm:grid-cols-3">
                {LOGO_FRAME_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updateContent('logoAspect', option.value)}
                    className={[
                      'rounded-xl border px-3 py-3 text-left transition',
                      content.logoAspect === option.value
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-950'
                        : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300',
                    ].join(' ')}
                  >
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className="mt-1 block text-xs font-mono text-gray-500">{option.size}</span>
                    <span className="mt-1 block text-xs text-gray-500">{option.description}</span>
                  </button>
                ))}
              </div>
              <ImageDropZone
                value={content.logoUrl}
                onChange={(value) => updateContent('logoUrl', value)}
                editorValue={content.logoSourceUrl || content.logoUrl}
                openEditorOnUpload
                onOriginalChange={(value) => updateContent('logoSourceUrl', value)}
                onImageInfo={({ width, height }) => {
                  const detected = logoAspectForDimensions(width, height);
                  if (detected) updateContent('logoAspect', detected);
                }}
                scope="storefront-logo"
                frameAspect={logoFrameAspect}
                aspectOptions={LOGO_FRAME_OPTIONS}
                aspectValue={content.logoAspect || 'wide'}
                onAspectChange={(value) => updateContent('logoAspect', value)}
                maxOutputWidth={1200}
                outputType="image/png"
                editorBackground="transparent"
                editorFitMode="contain"
                editorTitle="Fit storefront logo"
                max={1}
              />
              <p className="mt-2 text-xs text-gray-500">
                Current frame: {selectedLogoFrame.size}. Upload opens the fitter first; future edits reopen from the original source when available.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Favicon</label>
              <ImageDropZone
                value={content.faviconUrl}
                onChange={(value) => updateContent('faviconUrl', value)}
                scope="storefront-favicon"
                frameAspect={1}
                max={1}
              />
              <p className="mt-2 text-xs text-gray-500">
                Square icon used in browser tabs for the public storefront.
              </p>
            </div>
            <details className="rounded-xl border border-gray-200 px-4 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-gray-700">Advanced logo URL</summary>
              <div className="mt-3">
                <TextInput label="Display logo URL" hint="This is the fitted version shoppers see." value={content.logoUrl} onChange={(value) => updateContent('logoUrl', value)} placeholder="https://..." />
                <TextInput label="Original logo source URL" hint="Used when reopening the fitter so the original upload is not lost." value={content.logoSourceUrl} onChange={(value) => updateContent('logoSourceUrl', value)} placeholder="https://..." />
                <TextInput label="Favicon URL" value={content.faviconUrl} onChange={(value) => updateContent('faviconUrl', value)} placeholder="https://..." />
              </div>
            </details>
            <TextInput label="Navigation store name" value={content.navbarBusinessName} onChange={(value) => updateContent('navbarBusinessName', value)} placeholder={business.name || 'Store name'} />
            <TextInput label="Short tagline" value={content.tagline} onChange={(value) => updateContent('tagline', value)} maxLength={48} placeholder="Fresh groceries delivered today" />
            <div className="grid gap-3 sm:grid-cols-3">
              <ToggleRow checked={content.showLogo !== false} onChange={(value) => updateContent('showLogo', value)} label="Logo" />
              <ToggleRow checked={content.showBusinessName !== false} onChange={(value) => updateContent('showBusinessName', value)} label="Store name" />
              <ToggleRow checked={content.showTagline === true} onChange={(value) => updateContent('showTagline', value)} label="Tagline" />
            </div>
          </div>
          <LogoPreview
            logoUrl={content.logoUrl}
            logoAspect={content.logoAspect}
            storeName={storeName}
            tagline={content.tagline}
            showLogo={content.showLogo !== false}
            showBusinessName={content.showBusinessName !== false}
            showTagline={content.showTagline === true}
          />
        </div>
      </Section>

      <Section
        title="Announcement and shopper features"
        description="These controls affect the live storefront without using the old website builder."
      >
        <div className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
          <div className="space-y-3">
            <ToggleRow
              checked={settings.announcementBarEnabled}
              onChange={(value) => updateSettings('announcementBarEnabled', value)}
              label="Show announcement bar"
              description="Use for delivery cut-offs, holiday hours, or limited offers."
            />
            {settings.announcementBarEnabled && (
              <div className="space-y-3 rounded-xl border border-gray-200 p-4">
                <TextInput label="Announcement text" value={settings.announcementBarText} onChange={(value) => updateSettings('announcementBarText', value)} maxLength={500} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextInput label="Background colour" value={settings.announcementBarBgColor} onChange={(value) => updateSettings('announcementBarBgColor', value)} maxLength={7} />
                  <TextInput label="Text colour" value={settings.announcementBarTextColor} onChange={(value) => updateSettings('announcementBarTextColor', value)} maxLength={7} />
                </div>
                <div
                  className="rounded-lg px-4 py-2 text-center text-sm font-semibold"
                  style={{ background: settings.announcementBarBgColor, color: settings.announcementBarTextColor }}
                >
                  {settings.announcementBarText || 'Announcement preview'}
                </div>
              </div>
            )}
          </div>
          <div className="space-y-3">
            <ToggleRow
              checked={settings.wishlistEnabled}
              onChange={(value) => updateSettings('wishlistEnabled', value)}
              label="Enable wishlist"
              description="Show Saved/Wishlist entry points in the ecommerce header."
            />
            {settings.wishlistEnabled && (
              <div className="rounded-xl border border-gray-200 p-4">
                <p className="mb-2 text-sm font-semibold text-gray-900">Wishlist icon</p>
                <div className="flex gap-4">
                  {['bookmark', 'heart'].map((value) => (
                    <label key={value} className="flex items-center gap-2 text-sm text-gray-700">
                      <input
                        type="radio"
                        name="wishlistIconType"
                        value={value}
                        checked={settings.wishlistIconType === value}
                        onChange={() => updateSettings('wishlistIconType', value)}
                      />
                      {value === 'bookmark' ? 'Bookmark' : 'Heart'}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Section>

      <Section title="Social links" description="Add a profile link or handle, then turn on the platform to publish its icon in the storefront footer.">
        <div className="grid gap-3 lg:grid-cols-2">
          {SOCIAL_FIELDS.map((field) => {
            const rawValue = typeof content[field.urlKey] === 'string' ? content[field.urlKey] : '';
            const status = socialLinkStatus(field, rawValue);
            const enabled = content[field.showKey] === true && status.ok;
            const message = socialMessages[field.urlKey] || (rawValue.trim() && !status.ok ? status.message : '');
            return (
            <div key={field.urlKey} className="rounded-xl border border-gray-200 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <span
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white"
                    style={{ backgroundColor: field.color }}
                  >
                    {field.label.charAt(0)}
                  </span>
                  {field.label}
                </span>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold ${enabled ? 'text-emerald-700' : 'text-gray-500'}`}>
                    {enabled ? 'On' : 'Off'}
                  </span>
                  <ToggleSwitch
                    checked={enabled}
                    label={`Publish ${field.label} in footer`}
                    onChange={(value) => toggleSocial(field, value)}
                  />
                </div>
              </div>
              <TextInput
                label={`${field.label} link or handle`}
                hint="Full URL, @handle, or profile handle accepted."
                value={rawValue}
                onChange={(value) => updateSocialUrl(field, value)}
                placeholder={field.placeholder}
              />
              {status.ok && (
                <p className="mt-2 break-all text-xs text-gray-500">
                  Footer link:{' '}
                  <a href={status.href} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 hover:text-emerald-800">
                    {status.href}
                  </a>
                </p>
              )}
              {message && (
                <p className="mt-2 text-xs font-medium text-amber-700" role="alert">
                  {message}
                </p>
              )}
            </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
