'use client';

// Storefront content + theme + layout + branding shell.
// Wraps ContentEditor (the iframe-based homepage builder).
//
// Extracted from [slug]/admin/page.js 2026-04-29.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTenant } from '@/components/TenantProvider';
import { api } from '@/lib/adminApi';
import { Spinner, ErrorBanner, PrimaryButton } from '@/components/admin-ui';
import { THEMES, getThemeVars, resolveThemeKey, composeTheme } from '@/lib/themes';
import { STYLES, STYLE_KEYS, DEFAULT_STYLE_KEY } from '@/lib/themeStyles';
import { COLOR_PRESETS, parseThemeColors, sanitizeColorOverrides, isValidHex } from '@/lib/themeColors';
import { ThemePickerCard, ThemeStylePickerCard, ThemeColorPickerCard, LayoutPickerCard } from '@/components/admin-pickers';
import { getPlatformDomain } from '@/lib/platformDomain';
import { resolveVertical } from '@/lib/vertical';
import ContentEditor from '@/components/ContentEditor';

const CONTENT_VIEW_KEYS = new Set(['editor', 'layouts', 'themes', 'styles', 'colors']);

function normalizeContentView(value) {
  return CONTENT_VIEW_KEYS.has(value) ? value : 'editor';
}

const DEFAULT_CONTENT_FORM = {
  logoUrl: '',
  logoAspect: 'wide',
  tagline: '',
  heroHeadline: '',
  heroSubheading: '',
  heroCtaText: '',
  heroLine3: '',
  heroBannerUrl: '',
  aboutTitle: '',
  aboutBody: '',
  servicesIntro: '',
  contactTitle: '',
  contactBody: '',
  layoutText: '',
  // Top bar
  businessEmail: '',
  businessHoursText: '',
  // Socials
  socialFacebook: '',
  socialInstagram: '',
  socialTwitter: '',
  socialLinkedin: '',
  socialYoutube: '',
  // Navbar toggles
  showNavHome: true,
  showNavServices: true,
  showNavAbout: true,
  showNavContact: true,
  // Section toggles
  showStats: true,
  showServices: true,
  showAbout: true,
  showTeam: true,
  showTestimonials: true,
  showContact: true,
  showCta: true,
  // Custom colors
  customPrimary: '',
  customBg: '',
  customSurface: '',
  customText: '',
  customMuted: '',
  customAccent: '',
};

function WebsiteContentTab({ refreshTenant, checklist, onLaunch, reloadChecklist }) {
  const { tenant } = useTenant();
  const searchParams = useSearchParams();
  const themeName = resolveThemeKey(tenant?.subscription?.theme || 'coastal_dental');
  const theme = THEMES[themeName] || THEMES.coastal_dental;

  // Theme switcher — PUT /api/subscription/theme then reload tenant so the
  // editor + preview pick up the new theme's palette and typography.
  const [themeSwitching, setThemeSwitching] = useState(false);
  async function switchTheme(nextKey) {
    if (!nextKey || nextKey === themeName) return;
    setThemeSwitching(true);
    try {
      await api('/api/subscription/theme', { method: 'PUT', body: JSON.stringify({ theme: nextKey, resetThemeContent: true }) });
      await refreshTenant?.();
    } catch (err) {
      alert('Could not switch theme: ' + err.message);
    } finally { setThemeSwitching(false); }
  }
  const business = tenant?.business;

  const [form, setForm] = useState(() => ({ ...DEFAULT_CONTENT_FORM }));
  const [testimonials, setTestimonials] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const requestedSection = normalizeContentView(searchParams.get('section'));
  const [activeSection, setActiveSectionState] = useState(requestedSection);
  useEffect(() => {
    setActiveSectionState(requestedSection);
  }, [requestedSection]);
  const setActiveSection = useCallback((nextSection) => {
    const safeSection = normalizeContentView(nextSection);
    setActiveSectionState(safeSection);
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    if (safeSection === 'editor') params.delete('section');
    else params.set('section', safeSection);
    const query = params.toString();
    const hash = window.location.hash || '';
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${hash}`
    );
  }, []);

  // Load existing content — spread all fields so anything saved in DB
  // (including fields added in later phases) flows through to the editor
  const loadContent = useCallback(async () => {
    try {
      const data = await api('/api/business/content');
      const c = data.content || {};
      setForm({ ...DEFAULT_CONTENT_FORM, ...c });
      try {
        setTestimonials(c.testimonials ? JSON.parse(c.testimonials) : []);
      } catch { setTestimonials([]); }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    loadContent();
  }, [loadContent]);

  const update = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  }, []);

  function handleLogoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert('Logo must be under 2MB'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => update('logoUrl', ev.target?.result || '');
    reader.readAsDataURL(file);
  }

  // Autosave indicator — Publish button still shows "saving…" when the user
  // clicks Publish explicitly, but debounced background saves only flip a
  // subtle 'autoSaving' flag so they don't make the UI flash on every keystroke.
  const [autoSaving, setAutoSaving] = useState(false);

  async function save({ silent = false } = {}) {
    if (silent) setAutoSaving(true); else { setSaving(true); setError(''); setSaved(false); }
    try {
      // Send the entire form. The backend's CONTENT_FIELDS allow-list filters
      // to valid fields, so anything not in the schema is silently ignored.
      // Normalise: empty strings → null so we don't store whitespace;
      // booleans, numbers, and JSON strings pass through unchanged.
      const payload = {};
      for (const [k, v] of Object.entries(form)) {
        if (typeof v === 'string') {
          payload[k] = v.trim() || null;
        } else {
          payload[k] = v;
        }
      }
      // Testimonials as JSON string
      payload.testimonials = testimonials.length > 0 ? JSON.stringify(testimonials) : null;

      await api('/api/business/content', { method: 'PUT', body: JSON.stringify(payload) });
      if (!silent) {
        setSaved(true);
        refreshTenant?.();
        // Manual publish/save should refresh launch readiness immediately.
        reloadChecklist?.();
      }
    } catch (err) {
      if (!silent) setError(err.message);
    } finally {
      if (silent) setAutoSaving(false); else setSaving(false);
    }
  }

  // Debounced auto-save — 2s after the last form/testimonials change with
  // no further edits, persist in the background. Skip while still loading
  // the initial fetch so the first paint doesn't re-write empty state over
  // whatever was already in the DB.
  useEffect(() => {
    if (loading) return;
    const handle = setTimeout(() => { save({ silent: true }); }, 2000);
    return () => clearTimeout(handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, testimonials, loading]);

  const dc = theme.defaultContent || {};
  const vocab = theme.vocab || {};
  const businessVertical = resolveVertical(business?.vertical);
  const ph = {
    tagline: dc.tagline || '',
    heroHeadline: dc.heroHeadline || '',
    heroSubheading: dc.heroSubheading || '',
    heroCtaText: vocab.bookNow || 'Book now',
    aboutTitle: dc.aboutTitle || 'About us',
    aboutBody: dc.aboutBody || '',
    servicesIntro: dc.servicesIntro || '',
  };
  const subForTheme = tenant?.subscription;
  const [layoutPreviewPreset, setLayoutPreviewPreset] = useState(null);
  useEffect(() => {
    if (layoutPreviewPreset && subForTheme?.designPreset === layoutPreviewPreset) {
      setLayoutPreviewPreset(null);
    }
  }, [layoutPreviewPreset, subForTheme?.designPreset]);

  // Load services and staff for the preview
  const [previewServices, setPreviewServices] = useState([]);
  const [previewStaff, setPreviewStaff] = useState([]);
  useEffect(() => {
    if (businessVertical !== 'APPOINTMENT') {
      setPreviewServices([]);
      setPreviewStaff([]);
      return;
    }
    api('/api/services').then((d) => setPreviewServices(d.services || [])).catch(() => {});
    api('/api/business/staff').then((d) => setPreviewStaff(d.staff || [])).catch(() => {});
  }, [businessVertical]);

  // Themes / Visual Styles panels mounted alongside Colors — live in the
  // editor top-bar tabs so the owner can switch profession, style, or
  // colours without leaving the editing surface.
  const themesPanelJsx = useMemo(() => (
    <div className="space-y-4">
      <ThemePickerCard
        currentTheme={subForTheme?.theme}
        currentVertical={resolveVertical(business?.vertical)}
        onChanged={async () => { await refreshTenant?.(); await loadContent(); }}
      />
    </div>
  ), [business?.vertical, loadContent, refreshTenant, subForTheme?.theme]);
  const stylesPanelJsx = useMemo(() => (
    <div className="space-y-4">
      <ThemeStylePickerCard
        currentTheme={subForTheme?.theme}
        currentStyle={subForTheme?.themeStyle || 'light'}
        currentColors={subForTheme?.themeColors || null}
        currentBusiness={business || {}}
        currentVertical={businessVertical}
        onChanged={() => refreshTenant?.()}
      />
    </div>
  ), [business, businessVertical, refreshTenant, subForTheme?.theme, subForTheme?.themeColors, subForTheme?.themeStyle]);
  const themeColorsPanelJsx = useMemo(() => (
    <div className="space-y-4">
      <ThemeColorPickerCard
        currentTheme={subForTheme?.theme}
        currentStyle={subForTheme?.themeStyle || 'light'}
        currentColors={subForTheme?.themeColors || null}
        onChanged={() => refreshTenant?.()}
      />
    </div>
  ), [refreshTenant, subForTheme?.theme, subForTheme?.themeColors, subForTheme?.themeStyle]);
  const layoutPanelJsx = useMemo(() => (
    <div className="space-y-4">
      <LayoutPickerCard
        currentPreset={layoutPreviewPreset || subForTheme?.designPreset || null}
        currentVariants={subForTheme?.sectionVariants || null}
        currentTheme={subForTheme?.theme}
        currentStyle={subForTheme?.themeStyle || 'light'}
        currentColors={subForTheme?.themeColors || null}
        currentBusiness={business || {}}
        currentVertical={businessVertical}
        onChanged={async (preset) => {
          if (preset?.key) setLayoutPreviewPreset(preset.key);
          if (preset?.sectionOrder?.length) {
            setForm((prev) => ({ ...prev, sectionOrder: preset.sectionOrder.join(',') }));
          }
          await refreshTenant?.();
          await loadContent();
        }}
      />
    </div>
  ), [
    business,
    businessVertical,
    layoutPreviewPreset,
    loadContent,
    refreshTenant,
    subForTheme?.designPreset,
    subForTheme?.sectionVariants,
    subForTheme?.theme,
    subForTheme?.themeColors,
    subForTheme?.themeStyle,
  ]);

  if (loading) return <div className="py-10 flex justify-center"><Spinner /></div>;

  // Always render ContentEditor — it owns the Editor/Themes/Styles/Colors
  // view toggle now.
  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
      <ContentEditor
        themeKey={themeName}
        businessName={business?.name || 'Your Business'}
        value={form}
        onChange={(newForm) => {
          setForm((prev) => ({ ...prev, ...newForm }));
          setSaved(false);
        }}
        testimonials={testimonials}
        onTestimonialsChange={(t) => { setTestimonials(t); setSaved(false); }}
        services={previewServices}
        onServicesChange={() => {
          if (businessVertical !== 'APPOINTMENT') return;
          api('/api/services').then((d) => setPreviewServices(d.services || [])).catch(() => {});
        }}
        staff={previewStaff}
        onStaffChange={() => {
          if (businessVertical !== 'APPOINTMENT') return;
          api('/api/business/staff').then((d) => setPreviewStaff(d.staff || [])).catch(() => {});
        }}
        business={business || {}}
        vertical={businessVertical}
        siteUrl={business?.slug ? `${business.slug}.${getPlatformDomain()}` : null}
        onPublish={save}
        saving={saving}
        saved={saved}
        error={error}
        view={activeSection}
        onViewChange={setActiveSection}
        themesPanel={themesPanelJsx}
        stylesPanel={stylesPanelJsx}
        colorsPanel={themeColorsPanelJsx}
        layoutPanel={layoutPanelJsx}
        previewBust={`${subForTheme?.theme || ''}|${subForTheme?.themeStyle || ''}|${subForTheme?.themeColors || ''}|${layoutPreviewPreset || subForTheme?.designPreset || ''}|${subForTheme?.sectionVariants || ''}`}
        previewPresetKey={layoutPreviewPreset}
        designPreset={layoutPreviewPreset || subForTheme?.designPreset || null}
        sectionVariants={subForTheme?.sectionVariants || null}
        onThemeChange={switchTheme}
        themeSwitching={themeSwitching}
        launchStatus={checklist}
        onLaunchClick={onLaunch}
        onBusinessContactUpdate={async (fields) => {
          // Edits from the Business tab's Contact panel land here. Writes
          // straight to the Business row (same endpoint Settings / onboarding
          // use) so all three surfaces share one source of truth. Refresh
          // tenant context so subsequent field saves do not use stale values.
          if (!business) return;
          try {
            await api('/api/business/setup', {
              method: 'POST',
              body: JSON.stringify({
                name: business.name,
                slug: business.slug,
                category: business.category,
                description: business.description,
                state: business.state,
                country: business.country,
                timezone: business.timezone,
                bookingType: business.bookingType,
                reviewRequestEnabled: business.reviewRequestEnabled,
                reviewRequestLink: business.reviewRequestLink,
                autoConfirmBookings: business.autoConfirmBookings,
                defaultLanguage: business.defaultLanguage,
                defaultCurrency: business.defaultCurrency,
                vertical: businessVertical,
                email: fields.email,
                phone: fields.phone,
                address: fields.address,
              }),
            });
            refreshTenant?.();
          } catch (e) { /* parent picks this up via refreshTenant */ }
        }}
      />
    </div>
  );
}

// ============================================================================
// Hours & Holidays tab
// ============================================================================
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ============================================================================
// Enquiries tab — inbox of contact-form submissions from the public site
// ============================================================================
const ENQUIRY_STATUS_LABELS = { NEW: 'New', READ: 'Read', REPLIED: 'Replied', ARCHIVED: 'Archived' };
const ENQUIRY_FILTERS = [
  { key: 'all',      label: 'All' },
  { key: 'NEW',      label: 'New' },
  { key: 'READ',     label: 'Read' },
  { key: 'REPLIED',  label: 'Replied' },
  { key: 'ARCHIVED', label: 'Archived' },
];


// ============================================================================
// Leave Requests tab
// ============================================================================

// ============================================================================
// My Availability tab — lets the admin set their own schedule (solo business)
// ============================================================================
const SCHED_DAYS = [
  { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' }, { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' }, { value: 6, label: 'Saturday' },
  { value: 0, label: 'Sunday' },
];


// ============================================================================
// Coupons tab
// ============================================================================

// `show` prop lets callers render only one of the two sections:
//   "hours"    — opening-hours editor only (no inner sub-tab bar)
//   "holidays" — holidays list only (no inner sub-tab bar)
//   unset      — legacy mode with the inner Opening hours / Holidays pill bar

export default WebsiteContentTab;
