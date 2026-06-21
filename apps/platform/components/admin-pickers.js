'use client';

// Theme + style + color picker cards. Used by SubscriptionTab + SettingsTab.
//
// Extracted from [slug]/admin/page.js 2026-04-29 as part of the admin
// page split. Vertical-isolation rule applies: this is shared admin-shell
// UI (every tenant has theme settings regardless of vertical).

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner } from '@/components/admin-ui';
import { THEMES, getThemesByCategory, resolveThemeKey, composeTheme } from '@/lib/themes';
import { STYLES, STYLE_KEYS, DEFAULT_STYLE_KEY } from '@/lib/themeStyles';
import { COLOR_PRESETS, parseThemeColors, sanitizeColorOverrides, isValidHex } from '@/lib/themeColors';
import { LAYOUT_PRESETS, DEFAULT_PRESET_KEY, AVAILABLE_VARIANTS, VARIANT_LABELS, SECTION_LABELS, resolvePreset } from '@/lib/layoutPresets';
import { getAvailableGroups } from '@/lib/availableThemes';
import { resolveVertical } from '@/lib/vertical';
import { resolveBuilderProfile } from '@/lib/builderProfiles';
import { useConfirm } from '@/components/ConfirmDialog';

function themeCardFromCatalog(theme) {
  const runtime = THEMES[theme.key] || null;
  return {
    key: theme.key,
    name: runtime?.name || theme.label,
    industry: runtime?.industry || theme.desc || theme.label,
    tags: runtime?.tags || [],
    primaryColor: runtime?.primaryColor || '#4F46E5',
    accentColor: runtime?.accentColor || runtime?.primaryColor || '#4F46E5',
    bgColor: runtime?.bgColor || '#F8FAFC',
    surfaceColor: runtime?.surfaceColor || '#FFFFFF',
    textColor: runtime?.textColor || '#0F172A',
    heroStyle: runtime?.heroStyle || 'split',
  };
}

function hashKey(value) {
  return String(value || '').split('').reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) % 997, 7);
}

function ThemePreviewThumb({ theme }) {
  const primary = theme.primaryColor || '#4F46E5';
  const accent = theme.accentColor || primary;
  const bg = theme.bgColor || '#F8FAFC';
  const surface = theme.surfaceColor || '#FFFFFF';
  const text = theme.textColor || '#0F172A';
  const muted = `${text}88`;
  const variant = hashKey(theme.key || theme.name) % 4;

  return (
    <div className="relative h-28 overflow-hidden border-b border-gray-100" style={{ backgroundColor: bg, color: text }}>
      <div className="absolute inset-x-0 top-0 h-6 flex items-center gap-1.5 px-2" style={{ backgroundColor: surface }}>
        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: primary }} />
        <span className="h-1.5 w-12 rounded-full" style={{ backgroundColor: text, opacity: 0.75 }} />
        <span className="ml-auto h-1.5 w-5 rounded-full" style={{ backgroundColor: muted }} />
        <span className="h-3 w-8 rounded-full" style={{ backgroundColor: accent }} />
      </div>
      {variant === 0 && (
        <div className="absolute inset-x-0 top-6 bottom-0 grid grid-cols-[1.05fr,0.95fr] gap-2 p-3">
          <div className="space-y-2 pt-1">
            <span className="block h-2 w-10 rounded-full" style={{ backgroundColor: accent }} />
            <span className="block h-3 w-20 rounded-full" style={{ backgroundColor: text }} />
            <span className="block h-3 w-16 rounded-full" style={{ backgroundColor: text, opacity: 0.8 }} />
            <span className="block h-2 w-24 rounded-full" style={{ backgroundColor: muted }} />
          </div>
          <div className="rounded-lg" style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }} />
        </div>
      )}
      {variant === 1 && (
        <div className="absolute inset-x-0 top-6 bottom-0 p-3">
          <div className="mx-auto max-w-[9rem] text-center space-y-2">
            <span className="mx-auto block h-2 w-14 rounded-full" style={{ backgroundColor: accent }} />
            <span className="mx-auto block h-3 w-24 rounded-full" style={{ backgroundColor: text }} />
            <span className="mx-auto block h-2 w-20 rounded-full" style={{ backgroundColor: muted }} />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-8 rounded-md" style={{ backgroundColor: i === 1 ? primary : surface, border: `1px solid ${primary}22` }} />
            ))}
          </div>
        </div>
      )}
      {variant === 2 && (
        <div className="absolute inset-x-0 top-6 bottom-0 p-3">
          <div className="h-full rounded-lg p-3" style={{ backgroundColor: primary, color: '#FFFFFF' }}>
            <span className="block h-2 w-12 rounded-full bg-white/70" />
            <span className="mt-2 block h-3 w-24 rounded-full bg-white" />
            <span className="mt-1.5 block h-2 w-20 rounded-full bg-white/55" />
            <span className="absolute bottom-3 right-3 h-8 w-12 rounded-md" style={{ backgroundColor: accent }} />
          </div>
        </div>
      )}
      {variant === 3 && (
        <div className="absolute inset-x-0 top-6 bottom-0 grid grid-cols-[0.8fr,1.2fr] gap-2 p-3">
          <div className="grid grid-cols-2 gap-1.5">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="rounded-md" style={{ backgroundColor: i === 0 ? accent : surface, border: `1px solid ${primary}22` }} />
            ))}
          </div>
          <div className="space-y-2 pt-1">
            <span className="block h-2 w-10 rounded-full" style={{ backgroundColor: accent }} />
            <span className="block h-3 w-24 rounded-full" style={{ backgroundColor: text }} />
            <span className="block h-2 w-20 rounded-full" style={{ backgroundColor: muted }} />
            <span className="block h-5 w-16 rounded-full" style={{ backgroundColor: primary }} />
          </div>
        </div>
      )}
    </div>
  );
}

function stringifyIfArray(value, mapper = (item) => item) {
  if (!Array.isArray(value)) return undefined;
  return JSON.stringify(value.map(mapper));
}

function buildThemeContentResetPayload(themeConfig) {
  const content = themeConfig?.defaultContent || themeConfig?.website?.defaultContent || {};
  const payload = {};
  const setText = (field, value) => {
    if (typeof value === 'string') payload[field] = value;
  };
  const setBool = (field, value) => {
    if (typeof value === 'boolean') payload[field] = value;
  };

  [
    'heroHeadline',
    'heroSubheading',
    'heroLine3',
    'heroBannerUrl',
    'tagline',
    'servicesIntro',
    'aboutTitle',
    'aboutBody',
    'contactTitle',
    'contactBody',
    'contactCardTitle',
    'contactCardBody',
    'aboutEyebrow',
    'servicesEyebrow',
    'servicesTitle',
    'teamEyebrow',
    'teamTitle',
    'teamIntro',
    'teamMemberLabel',
    'testimonialsEyebrow',
    'testimonialsTitle',
    'galleryEyebrow',
    'galleryTitle',
    'gallerySub',
    'faqEyebrow',
    'faqTitle',
    'faqIntro',
    'contactEyebrow',
    'pricingEyebrow',
    'pricingTitle',
    'pricingIntro',
    'sectionOrder',
    'footerDescription',
    'enquiryFormTitle',
    'enquiryFormBody',
    'enquiryFormCta',
    'enquiryThanksTitle',
    'enquiryThanksBody',
  ].forEach((field) => setText(field, content[field]));

  const preset = resolvePreset({ designPreset: themeConfig?.defaultDesignPreset || null });
  if (preset?.sectionOrder?.length) {
    payload.sectionOrder = preset.sectionOrder.join(',');
  }

  setText('heroCtaText', content.heroCtaText || content.ctaText || themeConfig?.vocab?.bookCta || themeConfig?.vocab?.bookNow);
  setText('ctaHeadline', content.ctaHeadline || content.contactCtaBarTitle);
  setText('ctaBody', content.ctaBody || content.contactCtaBarBody);

  [
    'showFaq',
    'showGallery',
    'showPricing',
    'showStats',
    'showServices',
    'showAbout',
    'showTeam',
    'showTestimonials',
    'showContact',
    'showCta',
  ].forEach((field) => setBool(field, content[field]));

  if (Array.isArray(content.trustItems)) {
    payload.heroTrust1 = content.trustItems[0] || null;
    payload.heroTrust2 = content.trustItems[1] || null;
    payload.heroTrust3 = content.trustItems[2] || null;
    payload.showHeroTrust = content.trustItems.length > 0;
  }

  const cmsServices = stringifyIfArray(content.services);
  if (cmsServices) payload.cmsServices = cmsServices;
  const cmsTeam = stringifyIfArray(content.team);
  if (cmsTeam) payload.cmsTeam = cmsTeam;
  const testimonials = stringifyIfArray(content.testimonials);
  if (testimonials) payload.testimonials = testimonials;
  const statsItems = stringifyIfArray(content.stats);
  if (statsItems) payload.statsItems = statsItems;
  const aboutHighlights = stringifyIfArray(content.aboutHighlights);
  if (aboutHighlights) payload.aboutHighlights = aboutHighlights;
  const faqItems = stringifyIfArray(content.faqItems);
  if (faqItems) payload.faqItems = faqItems;
  const pricingTiers = stringifyIfArray(content.pricing);
  if (pricingTiers) payload.pricingTiers = pricingTiers;
  const galleryItems = stringifyIfArray(content.gallery, (item) => (
    typeof item === 'string' ? { image: '', caption: item } : item
  ));
  if (galleryItems) payload.galleryItems = galleryItems;

  return payload;
}

function ThemePickerCard({ currentTheme, currentVertical, onChanged }) {
  const confirm = useConfirm();
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const vertical = resolveVertical(currentVertical);
  const categories = useMemo(() => {
    const available = getAvailableGroups(vertical);
    if (available.length > 0) {
      return available.map((group) => ({
        category: group.label,
        themes: group.themes.map(themeCardFromCatalog),
      }));
    }
    return getThemesByCategory();
  }, [vertical]);
  const categoryNames = useMemo(() => ['All', ...categories.map((c) => c.category)], [categories]);
  const currentThemeCard = useMemo(() => {
    const direct = THEMES[currentTheme];
    const resolved = THEMES[resolveThemeKey(currentTheme)];
    const catalog = categories.flatMap((group) => group.themes).find((theme) => theme.key === currentTheme);
    return direct || catalog || resolved;
  }, [categories, currentTheme]);

  async function pick(themeKey) {
    if (themeKey === currentTheme) return;
    const nextThemeCard = categories.flatMap((group) => group.themes).find((item) => item.key === themeKey) || THEMES[themeKey];
    const ok = await confirm(
      `Changing theme will reset your website homepage content to the "${nextThemeCard?.name || themeKey}" theme defaults.\n\nThis removes the current theme's services, team cards, testimonials, gallery, pricing, FAQ, hero text, CTA copy, and section layout. Your business details, logo, products/bookings, pages, blog posts, enquiries, and customers stay saved.`,
      {
        title: 'Reset website for new theme?',
        confirmLabel: 'Proceed and reset',
        cancelLabel: 'Cancel',
        tone: 'danger',
      },
    );
    if (!ok) return;
    setPending(themeKey); setError('');
    try {
      await api('/api/subscription/theme', { method: 'PUT', body: JSON.stringify({ theme: themeKey, resetThemeContent: true }) });
      const runtimeTheme = THEMES[themeKey] || THEMES[resolveThemeKey(themeKey)];
      const contentPayload = buildThemeContentResetPayload(runtimeTheme);
      if (Object.keys(contentPayload).length > 0) {
        await api('/api/business/content', { method: 'PUT', body: JSON.stringify(contentPayload) });
      }
      await Promise.resolve(onChanged?.(themeKey));
    } catch (err) { setError(err.message); } finally { setPending(null); }
  }

  const searchLower = search.toLowerCase();

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Theme</h3>
          <p className="text-sm text-gray-500 mt-1">
            Switch between themes for this business type. To use another business type, create a separate account or delete this business and start again.
          </p>
        </div>
        {currentThemeCard && (
          <span className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: currentThemeCard.primaryColor }} />
            {currentThemeCard.name}
          </span>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          {categoryNames.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search themes..."
          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="mt-4 space-y-5 max-h-[500px] overflow-y-auto">
        {categories.filter(({ category }) => filterCategory === 'All' || category === filterCategory).map(({ category, themes }) => {
          const filtered = searchLower
            ? themes.filter((t) => t.name.toLowerCase().includes(searchLower) || t.industry.toLowerCase().includes(searchLower) || (t.tags || []).some((tag) => tag.includes(searchLower)))
            : themes;
          if (filtered.length === 0) return null;
          return (
            <div key={category}>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">{category}</p>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                {filtered.map((t) => {
                  const active = t.key === currentTheme || (THEMES[t.key] && t.key === resolveThemeKey(currentTheme));
                  return (
                    <button
                      key={t.key}
                      onClick={() => pick(t.key)}
                      disabled={pending === t.key}
                      className={`relative rounded-xl border-2 overflow-hidden text-left transition-all ${
                        active ? 'ring-2 ring-offset-1' : 'border-gray-200 hover:border-gray-300'
                      }`}
                      style={active ? { borderColor: t.primaryColor, '--tw-ring-color': t.primaryColor } : {}}
                    >
                      <ThemePreviewThumb theme={t} />
                      <div className="p-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-gray-900">{t.name}</span>
                          {active && (
                            <span className="w-4 h-4 rounded-full flex items-center justify-center text-white text-[9px]" style={{ backgroundColor: t.primaryColor }}>✓</span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[10px] text-gray-500 truncate">{t.industry}</p>
                      </div>
                      {pending === t.key && (
                        <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
                          <Spinner small />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Theme STYLE picker — 10 visual variants (Light / Dark / Elegant / … /
// Organic). Composes on top of the profession choice. Saving sends the
// new themeStyle via PUT /api/subscription/theme.
// ────────────────────────────────────────────────────────────────────────────
function ThemeStylePickerCard({ currentTheme, currentStyle, currentColors, onChanged }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const professionKey = resolveThemeKey(currentTheme);
  // Legacy/unknown style values (e.g. a retired "modern" key) fall back to the
  // default at render time, so resolve them here too — otherwise no tile is
  // marked active and the selected ✓ never shows.
  const effectiveStyle = STYLES[currentStyle] ? currentStyle : DEFAULT_STYLE_KEY;

  async function pick(styleKey) {
    if (styleKey === effectiveStyle) return;
    setPending(styleKey); setError('');
    try {
      await api('/api/subscription/theme', {
        method: 'PUT',
        body: JSON.stringify({ themeStyle: styleKey }),
      });
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setPending(null); }
  }

  const activeStyleName = STYLES[effectiveStyle]?.name || STYLES.light.name;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 mt-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Visual style</h3>
          <p className="text-sm text-gray-500 mt-1">Pick a style to layer on top of your {THEMES[professionKey]?.name || 'profession'} theme.</p>
        </div>
        <span className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200">
          {activeStyleName}
        </span>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {STYLE_KEYS.map((key) => {
          const style = STYLES[key];
          // Render each tile using the COMPOSED preview so users see profession+style.
          const preview = composeTheme(professionKey, key, parseThemeColors(currentColors));
          const active = key === effectiveStyle;
          return (
            <button
              key={key}
              onClick={() => pick(key)}
              disabled={pending === key}
              className={`relative rounded-xl border-2 overflow-hidden text-left transition-all ${active ? 'ring-2 ring-offset-1' : 'border-gray-200 hover:border-gray-300'}`}
              style={active ? { borderColor: preview.primaryColor, '--tw-ring-color': preview.primaryColor } : {}}
            >
              {/* Tile swatch: bg + primary swoosh to hint the style's look */}
              <div className="relative h-14" style={{ backgroundColor: preview.bgColor }}>
                <div className="absolute inset-x-0 top-0 h-3" style={{ backgroundColor: preview.primaryColor }} />
                <div className="absolute left-2 bottom-2 w-4 h-4 rounded" style={{ backgroundColor: preview.accentColor }} />
                <div className="absolute right-2 bottom-2 w-6 h-1 rounded" style={{ backgroundColor: preview.textColor, opacity: 0.5 }} />
              </div>
              <div className="p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-900">{style.name}</span>
                  {active && (
                    <span className="w-4 h-4 rounded-full flex items-center justify-center bg-indigo-600 text-white text-[9px]">✓</span>
                  )}
                </div>
                <p className="mt-0.5 text-[10px] text-gray-500 leading-tight line-clamp-2">{style.description}</p>
              </div>
              {pending === key && (
                <div className="absolute inset-0 bg-white/60 flex items-center justify-center">
                  <Spinner small />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Theme COLOR picker — 14 curated presets + custom hex picker (primary +
// accent + surface). Overrides layer last in the compose pipeline, so they
// win over both profession and style defaults.
// ────────────────────────────────────────────────────────────────────────────
function ThemeColorPickerCard({ currentTheme, currentStyle, currentColors, onChanged }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const parsed = parseThemeColors(currentColors);
  const [primary, setPrimary] = useState(parsed.primary || '');
  const [accent,  setAccent]  = useState(parsed.accent  || '');
  const [surface, setSurface] = useState(parsed.surface || '');
  const [dirty,   setDirty]   = useState(false);

  // Keep local state in sync when the upstream currentColors changes.
  useEffect(() => {
    const p = parseThemeColors(currentColors);
    setPrimary(p.primary || '');
    setAccent (p.accent  || '');
    setSurface(p.surface || '');
    setDirty(false);
  }, [currentColors]);

  async function save(colorsObj) {
    setPending(true); setError('');
    try {
      await api('/api/subscription/theme', {
        method: 'PUT',
        body: JSON.stringify({ themeColors: colorsObj }),
      });
      onChanged?.();
      setDirty(false);
    } catch (err) { setError(err.message); } finally { setPending(false); }
  }

  async function pickPreset(preset) {
    await save({ primary: preset.primary, accent: preset.accent, surface: preset.surface });
  }

  async function clearOverrides() { await save(null); }

  async function saveCustom() {
    const overrides = sanitizeColorOverrides({ primary, accent, surface });
    if (Object.keys(overrides).length === 0) {
      await clearOverrides();
      return;
    }
    await save(overrides);
  }

  const hasOverrides = parsed.primary || parsed.accent || parsed.surface;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6 mt-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Colours</h3>
          <p className="text-sm text-gray-500 mt-1">Pick a preset or enter custom hex codes. Leave blank to use the profession defaults.</p>
        </div>
        {hasOverrides && (
          <button type="button" onClick={clearOverrides} disabled={pending} className="text-xs text-gray-500 hover:text-gray-900 font-medium">
            Reset to defaults
          </button>
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Preset palette grid */}
      <div className="mt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Presets</p>
        <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-7 gap-2">
          {(() => {
            // "Default" = the profession+style built-in palette (no overrides).
            // Marked active (✓) when the tenant hasn't picked a custom palette.
            const def = composeTheme(resolveThemeKey(currentTheme), currentStyle || 'light', {});
            const active = !hasOverrides;
            return (
              <button
                type="button"
                onClick={clearOverrides}
                disabled={pending}
                className={`relative rounded-lg border-2 p-2 text-left transition-all ${active ? 'ring-2 ring-offset-1 ring-indigo-500 border-indigo-500' : 'border-gray-200 hover:border-gray-300'}`}
                title="Profession defaults"
              >
                {active && (
                  <span className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center bg-indigo-600 text-white text-[9px]">✓</span>
                )}
                <div className="flex gap-1 mb-1.5">
                  <span className="w-4 h-4 rounded" style={{ backgroundColor: def.primaryColor }} />
                  <span className="w-4 h-4 rounded" style={{ backgroundColor: def.accentColor }} />
                  <span className="w-4 h-4 rounded border border-gray-200" style={{ backgroundColor: def.bgColor }} />
                </div>
                <p className="text-[10px] font-semibold text-gray-700 truncate">Default</p>
              </button>
            );
          })()}
          {COLOR_PRESETS.map((preset) => {
            const active = parsed.primary === preset.primary && parsed.accent === preset.accent;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => pickPreset(preset)}
                disabled={pending}
                className={`relative rounded-lg border-2 p-2 text-left transition-all ${active ? 'ring-2 ring-offset-1 ring-indigo-500 border-indigo-500' : 'border-gray-200 hover:border-gray-300'}`}
                title={preset.name}
              >
                {active && (
                  <span className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center bg-indigo-600 text-white text-[9px]">✓</span>
                )}
                <div className="flex gap-1 mb-1.5">
                  <span className="w-4 h-4 rounded" style={{ backgroundColor: preset.primary }} />
                  <span className="w-4 h-4 rounded" style={{ backgroundColor: preset.accent }} />
                  <span className="w-4 h-4 rounded border border-gray-200" style={{ backgroundColor: preset.surface }} />
                </div>
                <p className="text-[10px] font-semibold text-gray-700 truncate">{preset.name}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom hex inputs */}
      <div className="mt-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Custom</p>
        <div className="grid sm:grid-cols-3 gap-3">
          <HexInput label="Primary" value={primary} onChange={(v) => { setPrimary(v); setDirty(true); }} />
          <HexInput label="Accent"  value={accent}  onChange={(v) => { setAccent(v);  setDirty(true); }} />
          <HexInput label="Surface" value={surface} onChange={(v) => { setSurface(v); setDirty(true); }} />
        </div>
        {dirty && (
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={saveCustom}
              disabled={pending}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save custom colours'}
            </button>
            <button
              type="button"
              onClick={() => { setPrimary(parsed.primary || ''); setAccent(parsed.accent || ''); setSurface(parsed.surface || ''); setDirty(false); }}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 bg-white border border-gray-200 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function HexInput({ label, value, onChange }) {
  const valid = !value || isValidHex(value);
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-gray-600 mb-1">{label}</span>
      <div className="flex gap-2 items-center">
        <span
          className="w-9 h-9 rounded-lg border border-gray-200 flex-shrink-0"
          style={{ backgroundColor: valid && value ? value : '#FFFFFF', backgroundImage: valid && value ? 'none' : 'repeating-linear-gradient(45deg, #F3F4F6, #F3F4F6 4px, #FFF 4px, #FFF 8px)' }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#1B6CA8"
          className={`flex-1 px-3 py-2 border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 ${valid ? 'border-gray-300 focus:ring-indigo-500' : 'border-red-300 focus:ring-red-500'}`}
        />
      </div>
      {!valid && <p className="text-[11px] text-red-600 mt-1">Use #RGB or #RRGGBB</p>}
    </label>
  );
}


// ───────────── Layout pickers ─────────────
// Used by WebsiteContentTab + SettingsTab. Layout = the storefront
// homepage section ordering preset + per-section variant choices.

function LayoutPreviewThumb({ preset, palette }) {
  return <LayoutPreviewThumbCss preset={preset} palette={palette} />;
}

// Neutral fallback palette — used when no tenant theme is resolvable yet
// (e.g. a brand-new tenant before a theme is chosen).
const DEFAULT_THUMB_PALETTE = {
  bg: '#f8fafc', surface: '#ffffff', ink: '#0f172a',
  muted: '#64748b', border: '#e2e8f0', accent: '#4f46e5', primary: '#4f46e5',
};

// Resolve the tenant's *actual* storefront palette (profession theme × style ×
// colour overrides) through the same composeTheme pipeline the storefront uses,
// then map it onto the thumbnail's colour roles. This means each layout preview
// is painted in the colours the owner will really see — not a hand-picked guess.
function resolveThumbPalette({ theme, themeStyle, themeColors }) {
  try {
    const t = composeTheme(resolveThemeKey(theme), themeStyle || 'light', parseThemeColors(themeColors));
    if (!t || !t.bgColor) return DEFAULT_THUMB_PALETTE;
    return {
      bg: t.bgColor,
      surface: t.surfaceColor || t.bgColor,
      ink: t.textColor,
      muted: t.mutedColor || t.textColor,
      border: t.borderColor || t.mutedColor || '#e2e8f0',
      accent: t.accentColor || t.primaryColor,
      primary: t.primaryColor,
    };
  } catch {
    return DEFAULT_THUMB_PALETTE;
  }
}

function MiniLine({ width = '60%', height = 3, color = '#cbd5e1', className = '' }) {
  return <span className={`block rounded-full ${className}`} style={{ width, height, backgroundColor: color }} />;
}

function MiniBlock({ className = '', style = {} }) {
  return <span className={`block rounded-md ${className}`} style={style} />;
}

// A miniature, structurally-faithful mock of the storefront homepage. The
// hero/body/footer strips are chosen straight from the preset's real `variants`
// map (the same source the storefront renders from), so every preset — current
// or future — gets an accurate preview with no per-preset config to maintain.
function LayoutPreviewThumbCss({ preset, palette }) {
  const p = palette || DEFAULT_THUMB_PALETTE;
  const v = preset.variants || {};
  const heroVariant = normalizeThumbVariant('hero', v.hero || 'v1');
  const servicesVariant = normalizeThumbVariant('services', v.services || 'v1');
  const aboutVariant = normalizeThumbVariant('about', v.about || 'v1');
  const galleryVariant = normalizeThumbVariant('gallery', v.gallery || 'v1');
  const contactVariant = normalizeThumbVariant('contact', v.contact || 'v1');

  // The homepage is a vertical stack of sections. We sample five of them —
  // hero, services, about, gallery, contact — straight from the preset's real
  // variants. Five bands (vs. three) is what makes presets that differ only in
  // about/gallery — e.g. Minimal Mono vs Luxury Serif — read as distinct.
  return (
    <div className="relative flex w-full aspect-[4/5] flex-col overflow-hidden rounded-lg border shadow-sm" style={{ backgroundColor: p.bg, color: p.ink, borderColor: p.border }}>
      <div className="flex h-6 shrink-0 items-center gap-1.5 border-b px-2" style={{ borderColor: p.border, backgroundColor: p.surface }}>
        <MiniBlock className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: p.accent }} />
        <MiniLine width="20%" color={p.ink} />
        <div className="ml-auto flex items-center gap-1">
          <MiniLine width={10} color={p.muted} />
          <MiniLine width={10} color={p.muted} />
          <MiniBlock className="h-2.5 w-8 rounded-full" style={{ backgroundColor: p.accent }} />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-[1.7] overflow-hidden">{renderThumbHero(heroVariant, p)}</div>
        <div className="min-h-0 flex-[1.1] overflow-hidden">{renderThumbServices(servicesVariant, p)}</div>
        <div className="min-h-0 flex-[0.9] overflow-hidden">{renderThumbAbout(aboutVariant, p)}</div>
        <div className="min-h-0 flex-[0.9] overflow-hidden">{renderThumbGallery(galleryVariant, p)}</div>
        <div className="min-h-0 flex-[0.55] overflow-hidden">{renderThumbFooter(contactVariant, p)}</div>
      </div>
    </div>
  );
}

function normalizeThumbVariant(section, variant) {
  const v = String(variant || 'v1');
  if (section === 'hero') {
    if (/boardroom|legal|law|notary|finance|immigration|accounting/.test(v)) return 'legal-brief';
    if (/diagnostic|consult|executive|advisor|recruitment/.test(v)) return 'stat-band';
    if (/agency|casebook|design|developer|startup|systems|tech/.test(v)) return 'gradient-mesh';
    if (/restaurant|chef|cafe|bar|bakery|dining|food|wine/.test(v)) return 'restaurant-cover';
    if (/clinic|care|therapy|medical|health|dental|veterinary|lab/.test(v)) return 'clinic-intake';
    if (/school|course|cohort|academy|training|fitness/.test(v)) return 'training-sprint';
    return v;
  }
  if (section === 'services') {
    if (/boardroom|diagnostic|practice|advisory|retainer|scope|recruitment/.test(v)) return 'alternating-rows';
    if (/agency|design|developer|system|case|portfolio|build/.test(v)) return 'bento-grid';
    if (/menu|restaurant|chef|cafe|bar|bakery|dining|food|wine/.test(v)) return 'menu-board';
    if (/clinic|care|therapy|medical|health|dental|veterinary|lab/.test(v)) return 'care-pathways';
    if (/course|cohort|academy|training|fitness|program/.test(v)) return 'program-stack';
    return v;
  }
  if (section === 'about') return v;
  if (section === 'gallery') {
    if (/boardroom|diagnostic|firm|office|library/.test(v)) return 'firm-library';
    if (/agency|casebook|design|portfolio|mosaic/.test(v)) return 'mosaic';
    if (/restaurant|chef|cafe|bar|bakery|dining|food|wine/.test(v)) return 'dining-strip';
    if (/clinic|care|therapy|medical|health|dental|veterinary|lab/.test(v)) return 'clinic-tour';
    return v;
  }
  if (section === 'contact') {
    if (/boardroom|diagnostic|agency|brief|intake|consult|legal|confidential/.test(v)) return 'confidential-intake';
    if (/restaurant|chef|cafe|bar|bakery|dining|food|wine|reservation/.test(v)) return 'reservation-panel';
    if (/clinic|care|therapy|medical|health|dental|appointment/.test(v)) return 'appointment-panel';
    return v;
  }
  return v;
}

// Shared hero copy block — eyebrow + headline + subhead + CTA pill. `onAccent`
// flips it to white for heroes painted on a solid accent background.
function thumbHeroText(p, { onAccent = false } = {}) {
  return (
    <>
      <MiniLine width="26%" color={onAccent ? '#ffffff' : p.accent} />
      <MiniLine width="74%" height={8} color={onAccent ? '#ffffff' : p.ink} />
      <MiniLine width="50%" color={onAccent ? 'rgba(255,255,255,0.72)' : p.muted} />
      <MiniBlock className="mt-1 h-3 w-12 rounded-full" style={{ backgroundColor: onAccent ? '#ffffff' : p.accent }} />
    </>
  );
}

// Hero strip — one mini-mock per real hero variant (AVAILABLE_VARIANTS.hero).
function renderThumbHero(variant, p) {
  switch (variant) {
    case 'dental-visit':
      return (
        <div className="grid h-full grid-cols-[0.95fr_1.05fr] gap-1.5 p-2">
          <div className="flex flex-col justify-center gap-1.5">
            <MiniLine width="28%" color={p.accent} />
            <MiniLine width="78%" height={8} color={p.ink} />
            <MiniLine width="56%" height={7} color={p.ink} />
            <MiniLine width="62%" color={p.muted} />
            <MiniBlock className="mt-1 h-3 w-12 rounded" style={{ backgroundColor: p.accent }} />
          </div>
          <div className="grid grid-rows-[1fr_auto] gap-1">
            <MiniBlock className="h-full rounded" style={{ backgroundColor: p.primary }} />
            <div className="grid grid-cols-3 gap-1">
              {[0, 1, 2].map((i) => <MiniBlock key={i} className="h-5 rounded" style={{ backgroundColor: i === 0 ? p.accent : p.surface, border: `1px solid ${p.border}` }} />)}
            </div>
          </div>
        </div>
      );
    case 'barber-chair':
      return (
        <div className="grid h-full grid-cols-[0.9fr_1.1fr] gap-1.5 p-2" style={{ backgroundColor: p.ink }}>
          <div className="grid grid-rows-[1fr_auto] gap-1">
            <MiniBlock className="h-full rounded" style={{ backgroundColor: p.accent }} />
            <div className="grid grid-cols-3 gap-1">
              {[0, 1, 2].map((i) => <MiniBlock key={i} className="h-4 rounded" style={{ backgroundColor: i === 0 ? p.primary : 'rgba(255,255,255,0.16)' }} />)}
            </div>
          </div>
          <div className="flex flex-col justify-center gap-1.5 border-y py-1" style={{ borderColor: 'rgba(255,255,255,0.22)' }}>
            <MiniLine width="28%" color={p.accent} />
            <MiniLine width="82%" height={9} color="#ffffff" />
            <MiniLine width="58%" height={8} color="#ffffff" />
            <MiniLine width="62%" color="rgba(255,255,255,0.68)" />
            <MiniBlock className="mt-1 h-3 w-12 rounded" style={{ backgroundColor: p.accent }} />
          </div>
        </div>
      );
    case 'training-sprint':
      return (
        <div className="grid h-full grid-cols-[1.05fr_0.95fr] gap-1.5 p-2" style={{ backgroundColor: p.ink }}>
          <div className="flex flex-col justify-center gap-1.5 rounded p-1.5" style={{ backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.18)' }}>
            <MiniLine width="26%" color={p.accent} />
            <MiniLine width="82%" height={9} color="#ffffff" />
            <MiniLine width="60%" height={8} color="#ffffff" />
            <MiniLine width="56%" color="rgba(255,255,255,0.65)" />
            <MiniBlock className="mt-1 h-3 w-12 rounded" style={{ backgroundColor: p.accent }} />
          </div>
          <div className="grid grid-rows-[1fr_auto] gap-1">
            <MiniBlock className="h-full rounded" style={{ backgroundColor: p.accent }} />
            <div className="grid grid-cols-2 gap-1">
              {[0, 1, 2, 3].map((i) => <MiniBlock key={i} className="h-4 rounded" style={{ backgroundColor: i === 0 ? p.accent : 'rgba(255,255,255,0.16)' }} />)}
            </div>
          </div>
        </div>
      );
    case 'legal-brief':
      return (
        <div className="grid h-full grid-cols-[0.95fr_1.05fr] gap-1.5 p-2" style={{ backgroundColor: p.ink }}>
          <div className="flex flex-col justify-center gap-1.5 border-y py-1" style={{ borderColor: 'rgba(255,255,255,0.2)' }}>
            <MiniLine width="28%" color={p.accent} />
            <MiniLine width="78%" height={8} color="#ffffff" />
            <MiniLine width="58%" height={7} color="#ffffff" />
            <MiniLine width="54%" color="rgba(255,255,255,0.65)" />
            <MiniBlock className="mt-1 h-3 w-12 rounded" style={{ backgroundColor: p.accent }} />
          </div>
          <div className="grid grid-rows-[1fr_auto] gap-1">
            <div className="grid grid-cols-[0.9fr_1.1fr] gap-1">
              <MiniBlock className="h-full rounded" style={{ backgroundColor: p.primary }} />
              <div className="flex flex-col justify-center gap-1 rounded p-1" style={{ backgroundColor: p.bg }}>
                <MiniLine width="44%" color={p.accent} />
                <MiniLine width="78%" color={p.ink} />
                <MiniLine width="52%" color={p.muted} />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {[0, 1, 2].map((i) => <MiniBlock key={i} className="h-4 rounded" style={{ backgroundColor: i === 1 ? p.accent : 'rgba(255,255,255,0.16)' }} />)}
            </div>
          </div>
        </div>
      );
    case 'clinic-intake':
      return (
        <div className="grid h-full grid-cols-[0.95fr_1.05fr] gap-1.5 p-2">
          <div className="flex flex-col justify-center gap-1.5">
            <MiniLine width="26%" color={p.accent} />
            <MiniLine width="78%" height={8} color={p.ink} />
            <MiniLine width="58%" height={7} color={p.ink} />
            <MiniLine width="62%" color={p.muted} />
            <MiniBlock className="mt-1 h-3 w-12 rounded" style={{ backgroundColor: p.accent }} />
          </div>
          <div className="grid grid-rows-[auto_1fr] gap-1">
            <div className="grid grid-cols-3 gap-1">
              {[0, 1, 2].map((i) => <MiniBlock key={i} className="h-5 rounded" style={{ backgroundColor: i === 0 ? p.accent : p.surface, border: `1px solid ${p.border}` }} />)}
            </div>
            <div className="grid grid-cols-[0.85fr_1.15fr] gap-1">
              <MiniBlock className="h-full rounded" style={{ backgroundColor: p.primary }} />
              <div className="flex flex-col justify-center gap-1 rounded p-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
                <MiniLine width="44%" color={p.accent} />
                <MiniLine width="80%" color={p.ink} />
                <MiniLine width="62%" color={p.muted} />
              </div>
            </div>
          </div>
        </div>
      );
    case 'restaurant-cover':
      return (
        <div className="grid h-full grid-cols-[1.05fr_0.95fr] gap-1.5 p-2">
          <div className="flex flex-col justify-center gap-1.5 border-y" style={{ borderColor: p.border }}>
            <MiniLine width="24%" color={p.accent} />
            <MiniLine width="76%" height={9} color={p.ink} />
            <MiniLine width="62%" height={8} color={p.ink} />
            <MiniLine width="44%" color={p.muted} />
            <MiniBlock className="mt-1 h-3 w-12 rounded" style={{ backgroundColor: p.accent }} />
          </div>
          <div className="grid grid-rows-[1fr_auto] gap-1">
            <MiniBlock className="h-full rounded" style={{ backgroundColor: p.primary }} />
            <div className="grid grid-cols-3 gap-1">
              {[0, 1, 2].map((i) => <MiniBlock key={i} className="h-5 rounded" style={{ backgroundColor: i === 1 ? p.accent : p.border }} />)}
            </div>
          </div>
        </div>
      );
    case 'split-image':
      return (
        <div className="grid h-full grid-cols-2 gap-1.5 p-2">
          <div className="flex flex-col justify-center gap-1.5">{thumbHeroText(p)}</div>
          <MiniBlock className="h-full rounded-md" style={{ backgroundColor: p.accent }} />
        </div>
      );
    case 'editorial-split':
      return (
        <div className="grid h-full grid-cols-[1.3fr_0.7fr] gap-1.5 p-2">
          <div className="flex flex-col justify-center gap-1.5">{thumbHeroText(p)}</div>
          <div className="grid grid-rows-[1.4fr_0.6fr] gap-1">
            <MiniBlock className="h-full rounded-md" style={{ backgroundColor: p.accent }} />
            <MiniBlock className="h-full rounded-md" style={{ backgroundColor: p.border }} />
          </div>
        </div>
      );
    case 'minimal-centered':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1.5 px-5 text-center">
          <MiniLine width="16%" color={p.accent} />
          <MiniLine width="58%" height={9} color={p.ink} />
          <MiniLine width="38%" color={p.muted} />
          <MiniBlock className="mt-1 h-3 w-12 rounded-full" style={{ backgroundColor: p.accent }} />
        </div>
      );
    case 'gradient-mesh':
      return (
        <div className="relative h-full overflow-hidden p-2" style={{ background: `linear-gradient(135deg, ${p.surface}, ${p.bg})` }}>
          <div className="absolute right-2 top-1 h-12 w-12 rounded-full opacity-40" style={{ backgroundColor: p.accent }} />
          <div className="absolute -bottom-3 left-6 h-10 w-16 rounded-full opacity-40" style={{ backgroundColor: p.primary }} />
          <div className="relative flex h-full flex-col justify-center gap-1.5">{thumbHeroText(p)}</div>
        </div>
      );
    case 'stat-band':
      return (
        <div className="flex h-full flex-col justify-center gap-1.5 p-2">
          <MiniLine width="68%" height={8} color={p.ink} />
          <MiniLine width="44%" color={p.muted} />
          <div className="mt-0.5 grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-md p-1" style={{ backgroundColor: i === 1 ? p.accent : p.surface, border: `1px solid ${p.border}` }}>
                <MiniLine width="60%" height={5} color={i === 1 ? '#ffffff' : p.ink} />
                <MiniLine width="42%" color={i === 1 ? 'rgba(255,255,255,0.7)' : p.muted} className="mt-1" />
              </div>
            ))}
          </div>
        </div>
      );
    case 'card-stack':
      return (
        <div className="grid h-full grid-cols-[1fr_0.85fr] gap-1.5 p-2">
          <div className="flex flex-col justify-center gap-1.5">{thumbHeroText(p)}</div>
          <div className="relative">
            <MiniBlock className="absolute right-0 top-1 h-[80%] w-[80%] rounded-md" style={{ backgroundColor: p.border }} />
            <MiniBlock className="absolute right-2 top-3 h-[80%] w-[80%] rounded-md" style={{ backgroundColor: p.accent }} />
          </div>
        </div>
      );
    case 'v1':
    default:
      return (
        <div className="relative h-full overflow-hidden p-2" style={{ backgroundColor: p.accent }}>
          <div className="absolute inset-0 bg-black/15" />
          <div className="relative flex h-full flex-col justify-center gap-1.5">{thumbHeroText(p, { onAccent: true })}</div>
        </div>
      );
  }
}

// Services band — one mini-mock per real services variant (AVAILABLE_VARIANTS.services).
function renderThumbServices(variant, p) {
  const card = { backgroundColor: p.surface, border: `1px solid ${p.border}` };
  switch (variant) {
    case 'treatment-grid':
      return (
        <div className="grid h-full grid-cols-[0.75fr_1.25fr] gap-1.5 p-1.5">
          <div className="flex flex-col justify-center gap-1">
            <MiniLine width="34%" color={p.accent} />
            <MiniLine width="76%" height={6} color={p.ink} />
            <MiniLine width="56%" color={p.muted} />
          </div>
          <div className="grid grid-cols-2 grid-rows-2 gap-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded p-1" style={i === 0 ? { backgroundColor: p.accent } : card}>
                <MiniLine width="62%" color={i === 0 ? '#ffffff' : p.ink} />
                <MiniLine width="44%" color={i === 0 ? 'rgba(255,255,255,0.72)' : p.muted} className="mt-1" />
              </div>
            ))}
          </div>
        </div>
      );
    case 'grooming-menu':
      return (
        <div className="grid h-full grid-cols-[0.72fr_1.28fr] gap-1.5 p-1.5">
          <div className="flex flex-col justify-between rounded p-1.5" style={{ backgroundColor: p.ink }}>
            <MiniBlock className="h-8 rounded" style={{ backgroundColor: p.accent }} />
            <div className="flex flex-col gap-1">
              <MiniLine width="66%" color="#ffffff" />
              <MiniLine width="50%" color="rgba(255,255,255,0.65)" />
            </div>
          </div>
          <div className="flex flex-col justify-center border-y" style={{ borderColor: p.border }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between border-b py-1 last:border-b-0" style={{ borderColor: p.border }}>
                <MiniLine width={`${48 + i * 9}%`} color={p.ink} />
                <MiniLine width="16%" color={p.accent} />
              </div>
            ))}
          </div>
        </div>
      );
    case 'program-stack':
      return (
        <div className="flex h-full flex-col gap-1 p-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="grid flex-1 grid-cols-[0.26fr_1fr_0.56fr] overflow-hidden rounded" style={{ backgroundColor: i === 1 ? p.ink : p.surface, border: `1px solid ${i === 1 ? p.ink : p.border}` }}>
              <MiniBlock className="h-full" style={{ backgroundColor: i === 1 ? p.accent : p.primary }} />
              <div className="flex flex-col justify-center gap-1 px-1">
                <MiniLine width="72%" color={i === 1 ? '#ffffff' : p.ink} />
                <MiniLine width="48%" color={i === 1 ? 'rgba(255,255,255,0.65)' : p.muted} />
              </div>
              <div className="grid grid-rows-2 gap-1 p-1">
                <MiniBlock className="rounded" style={{ backgroundColor: i === 1 ? 'rgba(255,255,255,0.16)' : p.border }} />
                <MiniBlock className="rounded" style={{ backgroundColor: i === 1 ? p.accent : p.bg }} />
              </div>
            </div>
          ))}
        </div>
      );
    case 'practice-dossier':
      return (
        <div className="grid h-full grid-cols-[0.82fr_1.18fr] gap-1.5 p-1.5">
          <div className="flex flex-col justify-between rounded p-1.5" style={{ backgroundColor: p.ink }}>
            <MiniBlock className="h-8 rounded" style={{ backgroundColor: p.accent }} />
            <div className="flex flex-col gap-1">
              <MiniLine width="72%" color="#ffffff" />
              <MiniLine width="52%" color="rgba(255,255,255,0.65)" />
            </div>
          </div>
          <div className="flex flex-col justify-center rounded" style={card}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between border-b px-1.5 py-1 last:border-b-0" style={{ borderColor: p.border }}>
                <div className="flex items-center gap-1">
                  <MiniBlock className="h-2.5 w-2.5 rounded" style={{ backgroundColor: i === 0 ? p.accent : p.border }} />
                  <MiniLine width={42 + i * 8} color={p.ink} />
                </div>
                <MiniLine width={12} color={p.accent} />
              </div>
            ))}
          </div>
        </div>
      );
    case 'care-pathways':
      return (
        <div className="grid h-full grid-cols-[0.72fr_1.28fr] gap-1.5 p-1.5">
          <div className="flex flex-col justify-center gap-1">
            <MiniLine width="34%" color={p.accent} />
            <MiniLine width="78%" height={6} color={p.ink} />
            <MiniLine width="58%" color={p.muted} />
          </div>
          <div className="grid grid-rows-[1.15fr_0.85fr] gap-1">
            <div className="grid grid-cols-[0.88fr_1.12fr] gap-1 rounded" style={card}>
              <MiniBlock className="h-full rounded-l" style={{ backgroundColor: p.accent }} />
              <div className="flex flex-col justify-center gap-1 p-1">
                <MiniLine width="64%" color={p.ink} />
                <MiniLine width="82%" color={p.muted} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {[0, 1].map((i) => <MiniBlock key={i} className="h-full rounded" style={i === 0 ? card : { backgroundColor: p.border }} />)}
            </div>
          </div>
        </div>
      );
    case 'menu-board':
      return (
        <div className="grid h-full grid-cols-[0.8fr_1.2fr] gap-1.5 p-1.5">
          <div className="flex flex-col justify-center gap-1">
            <MiniLine width="34%" color={p.accent} />
            <MiniLine width="74%" height={6} color={p.ink} />
            <MiniLine width="56%" color={p.muted} />
          </div>
          <div className="flex flex-col justify-center border-y" style={{ borderColor: p.border }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between border-b py-1 last:border-b-0" style={{ borderColor: p.border }}>
                <MiniLine width={`${48 + i * 8}%`} color={p.ink} />
                <MiniLine width="14%" color={p.accent} />
              </div>
            ))}
          </div>
        </div>
      );
    case 'masonry':
      return (
        <div className="grid h-full grid-cols-4 gap-1 p-1.5">
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.border }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.primary }} />
        </div>
      );
    case 'list':
      return (
        <div className="flex h-full flex-col justify-center gap-1 px-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between border-b pb-1" style={{ borderColor: p.border }}>
              <div className="flex items-center gap-1.5">
                <MiniBlock className="h-2.5 w-2.5 rounded" style={{ backgroundColor: i === 0 ? p.accent : p.border }} />
                <MiniLine width={44 + i * 8} color={p.ink} />
              </div>
              <MiniLine width={12} color={i === 0 ? p.accent : p.muted} />
            </div>
          ))}
        </div>
      );
    case 'accordion':
      return (
        <div className="flex h-full flex-col justify-center gap-1 p-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between rounded px-1.5 py-1" style={i === 0 ? { backgroundColor: p.accent } : card}>
              <MiniLine width={`${50 - i * 6}%`} color={i === 0 ? '#ffffff' : p.ink} />
              <MiniBlock className="h-1.5 w-1.5 rounded-sm" style={{ backgroundColor: i === 0 ? '#ffffff' : p.muted }} />
            </div>
          ))}
        </div>
      );
    case 'pricing-table':
      return (
        <div className="grid h-full grid-cols-3 gap-1 p-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col justify-center gap-1 rounded px-1 py-1" style={i === 1 ? { backgroundColor: p.accent } : card}>
              <MiniLine width="60%" height={6} color={i === 1 ? '#ffffff' : p.ink} />
              <MiniLine width="82%" color={i === 1 ? 'rgba(255,255,255,0.65)' : p.muted} />
              <MiniLine width="55%" color={i === 1 ? 'rgba(255,255,255,0.65)' : p.muted} />
            </div>
          ))}
        </div>
      );
    case 'bento-grid':
      return (
        <div className="grid h-full grid-cols-4 grid-rows-2 gap-1 p-1.5">
          <MiniBlock className="col-span-2 row-span-2 h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.primary }} />
          <MiniBlock className="h-full rounded" style={card} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.border }} />
        </div>
      );
    case 'alternating-rows':
      return (
        <div className="flex h-full items-center gap-2 p-1.5">
          <MiniBlock className="h-full w-1/3 rounded" style={{ backgroundColor: p.accent }} />
          <div className="flex flex-1 flex-col gap-1">
            <MiniLine width="58%" color={p.ink} />
            <MiniLine width="82%" color={p.muted} />
            <MiniLine width="40%" color={p.muted} />
          </div>
        </div>
      );
    case 'v1':
    default:
      return (
        <div className="grid h-full grid-cols-3 gap-1 p-1.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1 rounded p-1" style={card}>
              <MiniBlock className="flex-1 rounded" style={{ backgroundColor: i === 0 ? p.accent : p.border }} />
              <MiniLine width="72%" color={p.ink} />
            </div>
          ))}
        </div>
      );
  }
}

// About band — one mini-mock per real about variant (AVAILABLE_VARIANTS.about).
function renderThumbAbout(variant, p) {
  const card = { backgroundColor: p.surface, border: `1px solid ${p.border}` };
  switch (variant) {
    case 'two-col':
      return (
        <div className="grid h-full grid-cols-2 gap-2 p-1.5">
          {[0, 1].map((c) => (
            <div key={c} className="flex flex-col justify-center gap-1">
              <MiniLine width="40%" color={p.accent} />
              <MiniLine width="88%" color={p.muted} />
              <MiniLine width="68%" color={p.muted} />
            </div>
          ))}
        </div>
      );
    case 'centered':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
          <MiniLine width="22%" color={p.accent} />
          <MiniLine width="62%" color={p.ink} />
          <MiniLine width="46%" color={p.muted} />
        </div>
      );
    case 'timeline':
      return (
        <div className="flex h-full items-center gap-1 p-1.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex flex-1 items-center gap-1">
              <MiniBlock className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: i === 0 ? p.accent : p.border }} />
              {i < 3 && <span className="h-px flex-1" style={{ backgroundColor: p.border }} />}
            </div>
          ))}
        </div>
      );
    case 'quote-card':
      return (
        <div className="flex h-full items-center justify-center p-1.5">
          <div className="flex w-[82%] flex-col gap-1 rounded-md p-1.5" style={card}>
            <MiniLine width="18%" height={6} color={p.accent} />
            <MiniLine width="92%" color={p.ink} />
            <MiniLine width="64%" color={p.muted} />
          </div>
        </div>
      );
    case 'v1':
    default: // side image + text
      return (
        <div className="flex h-full items-center gap-2 p-1.5">
          <MiniBlock className="h-full w-1/3 rounded" style={{ backgroundColor: p.border }} />
          <div className="flex flex-1 flex-col gap-1">
            <MiniLine width="36%" color={p.accent} />
            <MiniLine width="78%" color={p.ink} />
            <MiniLine width="58%" color={p.muted} />
          </div>
        </div>
      );
  }
}

// Gallery band — one mini-mock per real gallery variant (AVAILABLE_VARIANTS.gallery).
function renderThumbGallery(variant, p) {
  switch (variant) {
    case 'dental-suite':
      return (
        <div className="grid h-full grid-cols-4 grid-rows-2 gap-1 p-1.5">
          <MiniBlock className="col-span-2 row-span-2 h-full rounded" style={{ backgroundColor: p.primary }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.border }} />
        </div>
      );
    case 'barber-lookbook':
      return (
        <div className="grid h-full grid-cols-6 grid-rows-2 gap-1 p-1.5">
          <MiniBlock className="col-span-3 row-span-2 h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.ink }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.primary }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.border }} />
        </div>
      );
    case 'training-floor':
      return (
        <div className="grid h-full grid-cols-6 grid-rows-2 gap-1 p-1.5">
          <MiniBlock className="col-span-3 row-span-2 h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="row-span-2 h-full rounded" style={{ backgroundColor: p.ink }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.primary }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }} />
        </div>
      );
    case 'firm-library':
      return (
        <div className="grid h-full grid-cols-6 grid-rows-2 gap-1 p-1.5">
          <MiniBlock className="col-span-3 h-full rounded" style={{ backgroundColor: p.ink }} />
          <MiniBlock className="col-span-3 h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.border }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.primary }} />
        </div>
      );
    case 'clinic-tour':
      return (
        <div className="grid h-full grid-cols-4 grid-rows-2 gap-1 p-1.5">
          <MiniBlock className="col-span-2 row-span-2 h-full rounded" style={{ backgroundColor: p.primary }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.border }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }} />
        </div>
      );
    case 'dining-strip':
      return (
        <div className="grid h-full grid-cols-6 grid-rows-2 gap-1 p-1.5">
          <MiniBlock className="col-span-3 row-span-2 h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="row-span-2 h-full rounded" style={{ backgroundColor: p.primary }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.border }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }} />
        </div>
      );
    case 'mosaic':
      return (
        <div className="grid h-full grid-cols-4 grid-rows-2 gap-1 p-1.5">
          <MiniBlock className="col-span-2 row-span-2 h-full rounded" style={{ backgroundColor: p.accent }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.border }} />
          <MiniBlock className="h-full rounded" style={{ backgroundColor: p.primary }} />
          <MiniBlock className="col-span-2 h-full rounded" style={{ backgroundColor: p.border }} />
        </div>
      );
    case 'slideshow':
      return (
        <div className="flex h-full flex-col gap-1 p-1.5">
          <MiniBlock className="w-full flex-1 rounded" style={{ backgroundColor: p.accent }} />
          <div className="flex items-center justify-center gap-1">
            {[0, 1, 2].map((i) => <MiniBlock key={i} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: i === 0 ? p.accent : p.border }} />)}
          </div>
        </div>
      );
    case 'v1':
    default:
      return (
        <div className="grid h-full grid-cols-4 gap-1 p-1.5">
          {[0, 1, 2, 3].map((i) => <MiniBlock key={i} className="h-full rounded" style={{ backgroundColor: i === 1 ? p.accent : p.border }} />)}
        </div>
      );
  }
}

// Contact/footer band — driven by the contact-section variant (AVAILABLE_VARIANTS.contact).
function renderThumbFooter(variant, p) {
  switch (variant) {
    case 'appointment-request':
      return (
        <div className="grid h-full grid-cols-[1fr_0.85fr] gap-1.5 p-1.5">
          <div className="grid grid-rows-[auto_1fr] gap-1 rounded px-2 py-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
            <MiniLine width="28%" color={p.accent} />
            <div className="grid grid-cols-2 gap-1">
              {[0, 1, 2, 3].map((i) => <MiniBlock key={i} className="h-full rounded" style={{ backgroundColor: i === 0 ? p.accent : p.bg, border: `1px solid ${p.border}` }} />)}
            </div>
          </div>
          <div className="rounded p-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
            <MiniLine width="60%" color={p.ink} />
            <MiniLine width="80%" color={p.muted} className="mt-1" />
          </div>
        </div>
      );
    case 'chair-booking':
      return (
        <div className="grid h-full grid-cols-[1.12fr_0.88fr] gap-1.5 p-1.5">
          <div className="flex h-full flex-col justify-center gap-1 rounded px-2" style={{ backgroundColor: p.ink }}>
            <MiniLine width="28%" color={p.accent} />
            <MiniLine width="68%" color="#ffffff" />
            <div className="mt-1 grid grid-cols-2 gap-1">
              {[0, 1, 2, 3].map((i) => <MiniBlock key={i} className="h-2.5 rounded" style={{ backgroundColor: i === 2 ? p.accent : 'rgba(255,255,255,0.16)' }} />)}
            </div>
          </div>
          <div className="rounded p-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
            <MiniLine width="60%" color={p.ink} />
            <MiniLine width="80%" color={p.muted} className="mt-1" />
          </div>
        </div>
      );
    case 'goal-check':
      return (
        <div className="grid h-full grid-cols-[1.15fr_0.85fr] gap-1.5 p-1.5">
          <div className="flex h-full flex-col justify-center gap-1 rounded px-2" style={{ backgroundColor: p.ink }}>
            <MiniLine width="28%" color={p.accent} />
            <MiniLine width="72%" color="#ffffff" />
            <div className="mt-1 grid grid-cols-2 gap-1">
              {[0, 1, 2, 3].map((i) => <MiniBlock key={i} className="h-2.5 rounded" style={{ backgroundColor: i === 1 ? p.accent : 'rgba(255,255,255,0.16)' }} />)}
            </div>
          </div>
          <div className="rounded p-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
            <MiniLine width="60%" color={p.ink} />
            <MiniLine width="80%" color={p.muted} className="mt-1" />
          </div>
        </div>
      );
    case 'confidential-intake':
      return (
        <div className="grid h-full grid-cols-[1.15fr_0.85fr] gap-1.5 p-1.5">
          <div className="flex h-full flex-col justify-center gap-1 rounded px-2" style={{ backgroundColor: p.ink }}>
            <MiniLine width="28%" color={p.accent} />
            <MiniLine width="70%" color="#ffffff" />
            <div className="mt-1 grid grid-cols-2 gap-1">
              {[0, 1, 2, 3].map((i) => <MiniBlock key={i} className="h-2.5 rounded" style={{ backgroundColor: i === 0 ? p.accent : 'rgba(255,255,255,0.16)' }} />)}
            </div>
          </div>
          <div className="rounded p-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
            <MiniLine width="60%" color={p.ink} />
            <MiniLine width="80%" color={p.muted} className="mt-1" />
          </div>
        </div>
      );
    case 'appointment-panel':
      return (
        <div className="grid h-full grid-cols-[1fr_0.75fr] gap-1.5 p-1.5">
          <div className="grid grid-rows-[auto_1fr] gap-1 rounded px-2 py-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
            <MiniLine width="28%" color={p.accent} />
            <div className="grid grid-cols-3 gap-1">
              {[0, 1, 2].map((i) => <MiniBlock key={i} className="h-full rounded" style={{ backgroundColor: i === 1 ? p.accent : p.bg, border: `1px solid ${p.border}` }} />)}
            </div>
          </div>
          <div className="rounded p-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
            <MiniLine width="60%" color={p.ink} />
            <MiniLine width="80%" color={p.muted} className="mt-1" />
          </div>
        </div>
      );
    case 'reservation-panel':
      return (
        <div className="grid h-full grid-cols-[1.2fr_0.8fr] gap-1.5 p-1.5">
          <div className="flex h-full flex-col justify-center gap-1 rounded px-2" style={{ backgroundColor: p.ink }}>
            <MiniLine width="24%" color={p.accent} />
            <MiniLine width="66%" color="#ffffff" />
          </div>
          <div className="rounded p-1" style={{ backgroundColor: p.surface, border: `1px solid ${p.border}` }}>
            <MiniLine width="60%" color={p.ink} />
            <MiniLine width="80%" color={p.muted} className="mt-1" />
          </div>
        </div>
      );
    case 'cta-bar':
      return (
        <div className="h-full px-1.5 py-1">
          <div className="flex h-full items-center justify-between rounded px-2" style={{ backgroundColor: p.accent }}>
            <MiniLine width="36%" color="#ffffff" />
            <MiniBlock className="h-2.5 w-9 rounded-full" style={{ backgroundColor: '#ffffff' }} />
          </div>
        </div>
      );
    case 'compact':
      return (
        <div className="flex h-full items-center justify-center gap-2 border-t px-2" style={{ borderColor: p.border }}>
          {[0, 1, 2].map((i) => <MiniLine key={i} width="15%" color={p.muted} />)}
        </div>
      );
    case 'v1':
    default:
      return (
        <div className="flex h-full items-center gap-1.5 border-t px-2" style={{ borderColor: p.border }}>
          <MiniBlock className="h-2 w-2 rounded-sm" style={{ backgroundColor: p.accent }} />
          <MiniLine width="22%" color={p.muted} />
          <div className="ml-auto flex gap-1.5">
            <MiniLine width={10} color={p.muted} />
            <MiniLine width={10} color={p.muted} />
          </div>
        </div>
      );
  }
}

function LayoutPickerCard({ currentPreset, currentVariants, currentTheme, currentStyle, currentColors, currentBusiness, currentVertical, onChanged }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [overridePending, setOverridePending] = useState(false);

  const builderProfile = useMemo(() => {
    const resolved = resolveThemeKey(currentTheme);
    return resolveBuilderProfile({ themeKey: resolved, theme: THEMES[resolved], business: currentBusiness, vertical: currentVertical });
  }, [currentBusiness, currentTheme, currentVertical]);

  // Paint every layout preview in the tenant's *actual* storefront colours so
  // each thumbnail previews this layout in their theme — not a generic palette.
  const thumbPalette = useMemo(
    () => resolveThumbPalette({ theme: currentTheme, themeStyle: currentStyle, themeColors: currentColors }),
    [currentTheme, currentStyle, currentColors],
  );

  const activeKey = currentPreset || DEFAULT_PRESET_KEY;
  const activePreset = LAYOUT_PRESETS.find((p) => p.key === activeKey) || LAYOUT_PRESETS[0];
  const recommendedKeys = builderProfile.recommendedLayoutKeys || [];
  // Only show the layouts related to this theme's industry, in the curated
  // order. The full 100-preset library is intentionally NOT exposed here — too
  // many unrelated choices confuse users. Every theme resolves to a profile
  // with a related set (the `general` profile is the fallback).
  // Always include the currently-active layout, even if it isn't in this
  // theme's related set (e.g. a preset saved before the theme was changed) —
  // otherwise the user can't see or re-pick their current selection.
  const relatedKeys = recommendedKeys.includes(activeKey) ? recommendedKeys : [activeKey, ...recommendedKeys];
  const recOrder = new Map(relatedKeys.map((k, i) => [k, i]));
  const visible = LAYOUT_PRESETS
    .filter((p) => relatedKeys.includes(p.key))
    .sort((a, b) => (recOrder.get(a.key) ?? 0) - (recOrder.get(b.key) ?? 0));

  // Parse the per-tenant override map (sectionVariants JSON string) so
  // the dropdowns reflect saved overrides, not the preset's defaults.
  const overrides = useMemo(() => {
    if (!currentVariants) return {};
    if (typeof currentVariants === 'object') return currentVariants;
    try { const o = JSON.parse(currentVariants); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  }, [currentVariants]);

  // Effective variant for each section = override (if any) → preset
  // default → 'v1'. This mirrors the storefront's resolveVariant() so
  // admins see the same picture the storefront does.
  function effectiveFor(section) {
    return overrides[section] || activePreset.variants[section] || 'v1';
  }

  async function pick(key) {
    if (key === activeKey) return;
    const nextPreset = LAYOUT_PRESETS.find((p) => p.key === key);
    setPending(key); setError('');
    try {
      // Reset sectionVariants when a new preset is picked so the new
      // preset's variant defaults take effect cleanly. Admins who want
      // to mix-and-match can override on top later.
      await api('/api/subscription/theme', {
        method: 'PUT',
        body: JSON.stringify({ designPreset: key, sectionVariants: null }),
      });
      if (nextPreset?.sectionOrder?.length) {
        await api('/api/business/content', {
          method: 'PUT',
          body: JSON.stringify({ sectionOrder: nextPreset.sectionOrder.join(',') }),
        });
      }
      await Promise.resolve(onChanged?.(nextPreset));
    } catch (err) { setError(err.message); } finally { setPending(null); }
  }

  async function setOverride(section, variant) {
    setOverridePending(true); setError('');
    try {
      // If the chosen variant matches the preset's default, drop the
      // override key — the entry is redundant. Empty map sends as null
      // so the DB reflects "no overrides".
      const next = { ...overrides };
      const presetDefault = activePreset.variants[section] || 'v1';
      if (variant === presetDefault) delete next[section];
      else next[section] = variant;
      const payload = Object.keys(next).length > 0 ? next : null;
      await api('/api/subscription/theme', {
        method: 'PUT',
        body: JSON.stringify({ sectionVariants: payload }),
      });
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setOverridePending(false); }
  }

  async function resetAllOverrides() {
    if (!Object.keys(overrides).length) return;
    setOverridePending(true); setError('');
    try {
      await api('/api/subscription/theme', {
        method: 'PUT',
        body: JSON.stringify({ sectionVariants: null }),
      });
      onChanged?.();
    } catch (err) { setError(err.message); } finally { setOverridePending(false); }
  }

  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="bg-white rounded-2xl border border-gray-200 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Layout</h3>
          <p className="text-sm text-gray-500 mt-1">{visible.length} layouts tailored to your industry. Switching keeps your content — only the look changes.</p>
        </div>
        <span className="px-3 py-1.5 rounded-full text-xs font-medium border border-gray-200 bg-gray-50">
          {LAYOUT_PRESETS.find((p) => p.key === activeKey)?.name || 'Classic'}
        </span>
      </div>

      {error && <ErrorBanner message={error} />}

      <div className="mt-4 grid gap-3 max-h-[600px] overflow-y-auto" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        {visible.map((p, idx) => {
          const active = p.key === activeKey;
          return (
            <button
              key={p.key}
              type="button"
              onClick={() => pick(p.key)}
              disabled={pending === p.key}
              className={`group relative text-left rounded-xl overflow-hidden transition-all ${active ? 'ring-2 ring-indigo-500 ring-offset-2' : 'border border-gray-200 hover:border-gray-300 hover:-translate-y-0.5 hover:shadow-md'}`}
            >
              <LayoutPreviewThumb preset={p} palette={thumbPalette} />
              <div className="px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-gray-900">{p.name}</span>
                  {active && <span className="w-4 h-4 rounded-full flex items-center justify-center bg-indigo-600 text-white text-[9px]">✓</span>}
                </div>
                <p className="mt-0.5 text-[11px] text-gray-500 line-clamp-2">{p.description}</p>
                <span className="mt-1.5 inline-block text-[10px] uppercase tracking-wider text-gray-400">{p.aesthetic}</span>
              </div>
              {pending === p.key && (
                <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
                  <Spinner small />
                </div>
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-5 text-xs text-gray-400">
        Tip: pair with a Theme (profession), Visual Style (light / dark / elegant) and Colors above for a fully bespoke look.
      </p>

      {/* Advanced: per-section variant overrides. Admins who want to
          mix-and-match (e.g. Magazine layout but with the v1 testimonials
          cards) drop in here. The dropdowns show the effective variant
          (override → preset default → v1). */}
      <div className="mt-6 border-t border-gray-100 pt-5">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-700 hover:text-gray-900"
        >
          <span style={{ display: 'inline-block', transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 150ms' }}>›</span>
          Customize sections
          {overrideCount > 0 && (
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-100 text-indigo-700">
              {overrideCount} override{overrideCount === 1 ? '' : 's'}
            </span>
          )}
        </button>
        {advancedOpen && (
          <div className="mt-4 space-y-3">
            <p className="text-xs text-gray-500">
              Pick a different variant per section without leaving the layout. Set anything back to &ldquo;default&rdquo; to follow the preset.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.keys(SECTION_LABELS).filter((k) => (AVAILABLE_VARIANTS[k] || []).length > 1).map((section) => {
                const choices = AVAILABLE_VARIANTS[section] || ['v1'];
                const labels = VARIANT_LABELS[section] || {};
                const value = effectiveFor(section);
                const isOverridden = overrides[section] !== undefined;
                return (
                  <label key={section} className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                      {SECTION_LABELS[section]}
                      {isOverridden && <span className="text-[9px] uppercase tracking-wider text-indigo-600">override</span>}
                    </span>
                    <select
                      value={value}
                      onChange={(e) => setOverride(section, e.target.value)}
                      disabled={overridePending}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                    >
                      {choices.map((v) => (
                        <option key={v} value={v}>
                          {labels[v] || v}{v === activePreset.variants[section] ? '  ·  preset default' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
            {overrideCount > 0 && (
              <button
                type="button"
                onClick={resetAllOverrides}
                disabled={overridePending}
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
              >
                Reset all overrides → use preset defaults
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export { ThemePickerCard, ThemeStylePickerCard, ThemeColorPickerCard, HexInput, LayoutPreviewThumb, LayoutPreviewThumbCss, LayoutPickerCard };
