'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import RichTextEditor from './RichTextEditor';
import ImageEditorModal from '@/components/ImageEditorModal';
import { useConfirm } from '@/components/ConfirmDialog';
import { getTheme, getThemeVars, resolveThemeKey, THEMES, THEME_KEYS } from '@/lib/themes';
import { DEFAULT_CURRENCY } from '@/lib/currency';
import { resolveBuilderProfile } from '@/lib/builderProfiles';
import { getHeroImageGuidance } from '@/lib/heroImageGuidance';
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getPlatformDomain } from '@/lib/platformDomain';

// Per Design Spec v1.0 — the 8 reorderable sections between the fixed
// Hero (top) and Footer (bottom). Legacy keys (stats/pricing/cta) are no
// longer surfaced in the editor but their DB columns remain so old data
// doesn't disappear if a tenant ever migrates back.
const DEFAULT_SECTION_ORDER = ['services', 'about', 'team', 'gallery', 'testimonials', 'pricing', 'faq', 'locations', 'contact'];

// Vertical-aware section visibility. STATIC tenants now get the same
// section toolbox as APPOINTMENT (services / team / pricing all editable)
// — the math_tuition theme uses Services for subjects, Team for tutors,
// Pricing for session rates. ECOMMERCE keeps the slim list because
// products / orders live in their own admin tabs.
//
// Existing DB columns (servicesTitle, teamTitle, etc.) stay populated
// across vertical changes — no data loss.
const VERTICAL_SECTION_KEYS = {
  APPOINTMENT: ['services', 'about', 'team', 'gallery', 'testimonials', 'pricing', 'faq', 'locations', 'contact'],
  STATIC:      ['services', 'about', 'team', 'gallery', 'testimonials', 'pricing', 'faq', 'locations', 'contact'],
  ECOMMERCE:   ['about', 'gallery', 'testimonials', 'faq', 'contact'],
};

function sectionKeysForVertical(vertical) {
  return VERTICAL_SECTION_KEYS[vertical] || VERTICAL_SECTION_KEYS.APPOINTMENT;
}

function logoAspectRatio(value) {
  if (value === 'square') return 1;
  if (value === 'rectangle') return 3;
  return 4;
}

function logoAspectForDimensions(width, height) {
  if (!width || !height) return null;
  const ratio = width / height;
  const normalized = ratio < 1 ? 1 / ratio : ratio;
  if (normalized < 1.35) return 'square';
  if (ratio > 3.25) return 'wide';
  return 'rectangle';
}

async function detectLogoAspectFromFile(file) {
  const dataUrl = await readFileAsDataUrl(file);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(logoAspectForDimensions(img.naturalWidth, img.naturalHeight));
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function isLoopbackHost(host) {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || String(host || '').toLowerCase().endsWith('.localhost');
}

function localWebPublicOrigin() {
  if (typeof window === 'undefined') return '';
  const configured = process.env.NEXT_PUBLIC_WEB_PUBLIC_URL
    || process.env.NEXT_PUBLIC_PUBLIC_SITE_URL
    || '';
  if (configured) return String(configured).replace(/\/+$/, '');
  const port = process.env.NEXT_PUBLIC_WEB_PUBLIC_PORT || '3003';
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

function isLocalPreviewOrigin(origin) {
  if (typeof window === 'undefined' || !origin) return false;
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.hostname) && url.port !== window.location.port;
  } catch {
    return false;
  }
}

function parseLayoutText(value) {
  if (!value) return {};
  if (typeof value === 'object') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializeLayoutText(value) {
  const clean = {};
  for (const [key, raw] of Object.entries(value || {})) {
    const next = typeof raw === 'string' ? raw.trim() : raw;
    if (next !== undefined && next !== null && next !== '') clean[key] = next;
  }
  return Object.keys(clean).length ? JSON.stringify(clean) : '';
}

// Curated stock image URLs (Lorem Picsum — free for commercial use, deterministic by seed).
// Grouped so the gallery picker can show relevant suggestions per section.
const STOCK_IMAGES = {
  hero: [
    'https://picsum.photos/seed/welcome-storefront/1600/600',
    'https://picsum.photos/seed/office-warmth/1600/600',
    'https://picsum.photos/seed/modern-reception/1600/600',
    'https://picsum.photos/seed/bright-interior/1600/600',
    'https://picsum.photos/seed/team-smiling/1600/600',
    'https://picsum.photos/seed/clean-studio/1600/600',
  ],
  about: [
    'https://picsum.photos/seed/about-team/1200/900',
    'https://picsum.photos/seed/about-workspace/1200/900',
    'https://picsum.photos/seed/about-founder/1200/900',
    'https://picsum.photos/seed/about-meeting/1200/900',
    'https://picsum.photos/seed/about-coffee/1200/900',
    'https://picsum.photos/seed/about-lounge/1200/900',
  ],
  services: [
    'https://picsum.photos/seed/service-salon/1200/800',
    'https://picsum.photos/seed/service-spa/1200/800',
    'https://picsum.photos/seed/service-clinic/1200/800',
    'https://picsum.photos/seed/service-fitness/1200/800',
    'https://picsum.photos/seed/service-consultation/1200/800',
    'https://picsum.photos/seed/service-studio/1200/800',
  ],
  cta: [
    'https://picsum.photos/seed/cta-gradient/1600/400',
    'https://picsum.photos/seed/cta-abstract/1600/400',
    'https://picsum.photos/seed/cta-texture/1600/400',
    'https://picsum.photos/seed/cta-calm/1600/400',
  ],
  gallery: [
    'https://picsum.photos/seed/gallery-interior-1/1200/800',
    'https://picsum.photos/seed/gallery-interior-2/1200/800',
    'https://picsum.photos/seed/gallery-work-1/1200/800',
    'https://picsum.photos/seed/gallery-work-2/1200/800',
    'https://picsum.photos/seed/gallery-detail-1/1200/800',
    'https://picsum.photos/seed/gallery-detail-2/1200/800',
    'https://picsum.photos/seed/gallery-moment-1/1200/800',
    'https://picsum.photos/seed/gallery-moment-2/1200/800',
  ],
};

// Load a File as a data URL (readable by <img src=...>)
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = (ev) => resolve(ev.target?.result || '');
    reader.readAsDataURL(file);
  });
}

function isValidExternalUrl(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && url.hostname.includes('.');
  } catch {
    return false;
  }
}

function normalizeSocialPreviewUrl(network, value) {
  if (isValidExternalUrl(value)) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const handle = trimmed.replace(/^@/, '').replace(/^\/+/, '');
  if (!handle) return null;

  const fallback = network === 'facebook'
    ? `https://facebook.com/${handle}`
    : network === 'instagram'
      ? `https://instagram.com/${handle}`
      : network === 'twitter'
        ? `https://x.com/${handle}`
        : network === 'linkedin'
          ? `https://linkedin.com/company/${handle}`
          : network === 'youtube'
            ? `https://youtube.com/@${handle}`
            : null;

  return isValidExternalUrl(fallback) ? fallback : null;
}

function relLuminance(hex) {
  if (typeof hex !== 'string') return 0;
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (full.length !== 6) return 0;
  const n = parseInt(full, 16);
  const srgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(fgHex, bgHex) {
  const lighter = Math.max(relLuminance(fgHex), relLuminance(bgHex));
  const darker = Math.min(relLuminance(fgHex), relLuminance(bgHex));
  return (lighter + 0.05) / (darker + 0.05);
}

function pickOnColor(bgHex) {
  return contrastRatio('#FFFFFF', bgHex) >= contrastRatio('#0A0A0A', bgHex) ? '#FFFFFF' : '#0A0A0A';
}

function resolveSectionOrder(raw, vertical = null) {
  // Restrict the editor's section list to keys this vertical surfaces.
  // The ECOMMERCE / STATIC view hides booking-specific keys (services,
  // team, pricing) entirely — they aren't filterable in the nav.
  const allowed = vertical ? sectionKeysForVertical(vertical) : DEFAULT_SECTION_ORDER;
  const saved = (raw || '').split(',').map((s) => s.trim()).filter((s) => allowed.includes(s));
  if (saved.length === 0) return [...allowed];
  const result = [...saved];
  for (const key of allowed) {
    if (result.includes(key)) continue;
    const defaultIdx = allowed.indexOf(key);
    const nextSibling = allowed.slice(defaultIdx + 1).find((k) => result.includes(k));
    if (nextSibling) {
      result.splice(result.indexOf(nextSibling), 0, key);
    } else {
      result.push(key);
    }
  }
  return result;
}

const SOCIAL_ICONS = {
  facebook:  { name: 'Facebook',    color: '#1877F2', path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
  instagram: { name: 'Instagram',   color: '#E4405F', path: 'M12 2.163c3.204 0 3.584.012 4.849.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.849.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
  twitter:   { name: 'X (Twitter)', color: '#000000', path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
  linkedin:  { name: 'LinkedIn',    color: '#0A66C2', path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
  youtube:   { name: 'YouTube',     color: '#FF0000', path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
};

/**
 * Step-by-step website builder. Left side: form wizard. Right side: full live preview.
 *
 * Props:
 *   themeKey, businessName, value, onChange,
 *   testimonials, onTestimonialsChange,
 *   services, staff, business
 */
export default function ContentEditor({
  themeKey, businessName, value, onChange,
  testimonials = [], onTestimonialsChange,
  services = [], staff = [], business = {},
  onServicesChange, onStaffChange,
  // New top-bar props (optional — editor still works without them)
  siteUrl, onPublish, onExport,
  saving = false, saved = false, error = null,
  // Top-bar view toggle (Editor | Colors). When view === 'colors', the
  // canvas area renders colorsPanel instead of the live preview.
  view = 'editor', onViewChange,
  themesPanel = null,
  stylesPanel = null,
  colorsPanel = null,
  layoutPanel = null,
  previewBust = '',
  previewPresetKey = null,
  designPreset = null,
  sectionVariants = null,
  // Theme switcher — dropdown in the top bar, between the Editor/Colors
  // toggle and the viewport switch. Calls onThemeChange(newKey) when the
  // user picks a different theme.
  onThemeChange, themeSwitching = false,
  // Launch readiness — drives the little pill beside Publish that tells
  // the owner whether the site can go live. Object from the backend's
  // /api/business/launch-checklist endpoint: { isLive, allRequiredComplete,
  // requiredItems: [{label, completed, tab}] }. Optional; when missing
  // the top bar renders its plain Publish button as before.
  launchStatus = null,
  onLaunchClick,
  // Contact details shared with Settings + onboarding — same Business row,
  // edited in three surfaces. Parent owns the save (calls /api/business/setup
  // so the debounced autosave on /api/business/content doesn't clobber it).
  onBusinessContactUpdate,
  // Tenant vertical (STATIC / APPOINTMENT / ECOMMERCE). Filters the
  // section nav so booking-specific editors (Services, Team, Pricing)
  // don't surface for a marketing-only or shop tenant. Defaults to
  // APPOINTMENT for back-compat with existing callers.
  vertical = 'APPOINTMENT',
}) {
  const resolved = resolveThemeKey(themeKey);
  const theme = getTheme(resolved);
  const dc = theme.defaultContent || {};
  const vocab = theme.vocab || {};
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  const builderProfile = useMemo(
    () => resolveBuilderProfile({ themeKey: resolved, theme, business, vertical }),
    [business, resolved, theme, vertical]
  );
  const profileCopy = (key, fallback) => builderProfile.copy?.[key] || fallback;
  const profileSection = (key) => builderProfile.sections?.[key] || {};
  const sectionLabel = (key, fallback) => profileSection(key).label || fallback;
  const sectionDesc = (key, fallback) => profileSection(key).desc || fallback;
  const sectionDefaultOn = (key, fallback) => {
    const v = profileSection(key).defaultOn;
    return typeof v === 'boolean' ? v : fallback;
  };
  const isRestaurantBuilder = builderProfile.id === 'restaurant';
  const servicesLabel = sectionLabel('services', cap(vocab.services || 'Services'));
  const teamLabel = sectionLabel('team', cap(vocab.staff || 'Team'));
  const defaultCtaLabel = profileCopy('ctaLabel', vertical === 'APPOINTMENT' ? (vocab.bookNow || 'Book now') : vertical === 'ECOMMERCE' ? 'Shop now' : 'Contact us');
  const heroImageGuidance = useMemo(
    () => getHeroImageGuidance({ designPreset, sectionVariants }),
    [designPreset, sectionVariants]
  );

  const [activeTab, setActiveTab] = useState('business');
  const [viewport, setViewport] = useState('laptop'); // see VIEWPORT_PRESETS below

  // Shared "adjust before save" modal used by every image uploader in the
  // editor. Set by any upload handler; the modal renders at the root and
  // closes after the user confirms or cancels.
  //
  // Sprint 3.3f — under the hood this now drives the centralised
  // ImageEditorModal (same component used by PagesPanel block editor,
  // BlogPanel cover image, and ServicesTab service photo). The
  // openImageAdjust(opts) public API is preserved so all 40+ existing
  // call sites in this file + child components keep working unchanged.
  const [adjustingImage, setAdjustingImage] = useState(null);
  // Wrap the caller's callbacks so confirm/cancel ALWAYS close the modal —
  // callers from child components (gallery, avatars) don't own the state.
  // When called with `opts.file` we pre-read the file as a data URL so
  // the new modal can preload it as `value`.
  async function openImageAdjust(opts) {
    let initialValue = opts.initialSrc || '';
    if (opts.file) {
      try {
        initialValue = await readFileAsDataUrl(opts.file);
      } catch (err) {
        opts.onCancel?.();
        // eslint-disable-next-line no-alert
        alert(err.message || 'Could not read file');
        return;
      }
    }
    const userOnConfirm = opts.onConfirm;
    const userOnCancel  = opts.onCancel;
    setAdjustingImage({
      ...opts,
      value: initialValue,
      onConfirm: (value) => {
        try { userOnConfirm?.(value); } finally { setAdjustingImage(null); }
      },
      onCancel: () => {
        try { userOnCancel?.(); } finally { setAdjustingImage(null); }
      },
    });
  }
  function closeImageAdjust() { setAdjustingImage(null); }

  // Debounced preview
  const [preview, setPreview] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setPreview({ ...value }), 250);
    return () => clearTimeout(t);
  }, [value]);

  // Optimistic preview of the Business row (email / phone / address).
  // The parent only passes an updated `business` prop AFTER the save round-
  // trip succeeds, which is too slow for a "live" preview feel. We mirror
  // every keystroke into businessDraft immediately and postMessage that
  // into the iframe so the storefront shows the change before the save
  // completes. When a new `business` prop lands (post-save), we re-sync.
  const [businessDraft, setBusinessDraft] = useState(business);
  useEffect(() => { setBusinessDraft(business); }, [business]);
  const [previewBusinessDraft, setPreviewBusinessDraft] = useState(business);
  useEffect(() => {
    const t = setTimeout(() => setPreviewBusinessDraft(businessDraft), 250);
    return () => clearTimeout(t);
  }, [businessDraft]);
  function handleBusinessPreview(field, val) {
    setBusinessDraft((prev) => ({ ...(prev || {}), [field]: val }));
  }

  // ─── Live-draft preview bridge ────────────────────────────────────────
  // Every debounced content change gets postMessage'd to the iframe so the
  // preview reflects unsaved edits in real time — no Publish required.
  // Handshake: the iframe posts {type:'ae-preview-ready'} once mounted, and
  // we immediately reply with the current snapshot so reloads sync too.
  //
  // When the admin is on the platform path (sitepresso.com/<slug>/admin),
  // the iframe is cross-origin (at <slug>.sitepresso.com) so both the
  // outgoing postMessage targetOrigin and the incoming e.origin filter
  // must use the preview origin, not the parent window's origin. These
  // state vars are declared here (above the effects that reference them)
  // to avoid a TDZ error when the effect deps array evaluates previewOrigin.
  const [previewKey, setPreviewKey] = useState(0);
  const [previewOrigin, setPreviewOrigin] = useState('');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const host = window.location.hostname;
    const platformDomain = getPlatformDomain().toLowerCase();

    if (isLoopbackHost(host) && business?.slug) {
      setPreviewOrigin(localWebPublicOrigin());
      return;
    }

    // Unified-admin host (app.aapkatech.com / app.sitepresso.com): URL
    // has no slug segment, so pull the slug from the tenant context
    // (business prop) and derive the tenant domain by stripping `app.`
    // — that way staging routes preview to <slug>.aapkatech.com and
    // prod to <slug>.sitepresso.com automatically, regardless of what
    // NEXT_PUBLIC_PLATFORM_DOMAIN was baked in at build time.
    if (host.startsWith('app.')) {
      const tenantDomain = host.slice(4);
      if (business?.slug) {
        setPreviewOrigin(`${window.location.protocol}//${business.slug}.${tenantDomain}`);
        return;
      }
    }

    // Platform-path admin: hostname is the bare platform domain or www.
    // Extract the slug from the URL (sitepresso.com/<slug>/admin) and
    // point the preview at <slug>.<platformDomain>. Otherwise the admin
    // is on the tenant subdomain (or a custom domain) and same-origin
    // resolution is correct.
    const onPlatform = host === platformDomain || host === `www.${platformDomain}`;
    if (onPlatform) {
      const slug = window.location.pathname.split('/')[1] || '';
      if (slug) {
        setPreviewOrigin(`${window.location.protocol}//${slug}.${platformDomain}`);
        return;
      }
    }
    setPreviewOrigin(window.location.origin);
  }, [business?.slug]);
  const iframeRef = useRef(null);
  function postDraftToIframe(contentSnapshot = preview, businessSnapshot = previewBusinessDraft) {
    const el = iframeRef.current;
    if (!el || !el.contentWindow) return;
    try {
      const publicStaff = (staff || []).filter((s) => s.showOnWebsite !== false);
      el.contentWindow.postMessage(
        { type: 'ae-preview-update', content: contentSnapshot, testimonials, services, staff: publicStaff, business: businessSnapshot },
        previewOrigin || '*'
      );
    } catch { /* cross-origin — safe to skip */ }
  }
  useEffect(() => {
    function onMessage(e) {
      if (!previewOrigin) return;
      if (e.origin !== previewOrigin) return;
      if (e.data?.type === 'ae-preview-ready') postDraftToIframe();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOrigin]);
  useEffect(() => { postDraftToIframe(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [preview, testimonials, services, staff, previewBusinessDraft, previewOrigin]);

  // Tell the iframe to scroll to the section matching the active tab, so
  // clicking Hero / Services / About / etc. brings that section into view
  // in the preview automatically. Runs whenever activeTab changes.
  function postScrollToIframe(section) {
    const el = iframeRef.current;
    if (!el || !el.contentWindow) return;
    try {
      el.contentWindow.postMessage(
        { type: 'ae-preview-scroll', section },
        previewOrigin || '*'
      );
    } catch { /* safe to skip */ }
  }
  useEffect(() => { postScrollToIframe(activeTab); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [activeTab]);

  function update(field, val) {
    onChange({ [field]: val });
  }

  const layoutTextValues = useMemo(() => parseLayoutText(value.layoutText), [value.layoutText]);
  function updateLayoutTextField(field, val) {
    update('layoutText', serializeLayoutText({ ...layoutTextValues, [field]: val }));
  }

  // Most uploads have a natural aspect ratio on the storefront — give the
  // adjust modal a matching initial frame so the owner frames the shot for
  // the slot it'll actually appear in.
  const UPLOAD_ASPECT = {
    heroBannerUrl:     heroImageGuidance.aspect,
    servicesImageUrl:  16 / 9,
    ctaBackgroundUrl:  16 / 6,
    aboutImageUrl:     4 / 3,
    logoUrl:           logoAspectRatio(value.logoAspect),
    faviconUrl:        1,
  };

  async function handleImageUpload(field, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert('File must be under 15MB'); return; }
    const isFavicon = field === 'faviconUrl';
    const detectedLogoAspect = field === 'logoUrl' ? await detectLogoAspectFromFile(file).catch(() => null) : null;
    const frameAspect = detectedLogoAspect ? logoAspectRatio(detectedLogoAspect) : (UPLOAD_ASPECT[field] ?? null);
    // Allow the same file to be re-picked later by clearing the input value.
    const inputEl = e.target;
    openImageAdjust({
      file,
      aspect: frameAspect,
      maxWidth: isFavicon ? 512 : 1920,
      quality: isFavicon ? 0.95 : 0.85,
      frameLabel: isFavicon ? 'Adjust favicon' : 'Adjust image',
      uploadScope: field, // S3 key prefix so objects group by slot (heroBannerUrl/*)
      outputType: isFavicon ? 'image/png' : 'image/jpeg',
      onConfirm: (nextValue) => {
        if (detectedLogoAspect) onChange({ [field]: nextValue, logoAspect: detectedLogoAspect });
        else update(field, nextValue);
        try { inputEl.value = ''; } catch {}
      },
      onCancel:  () => { try { inputEl.value = ''; } catch {} },
    });
  }

  // Re-open the adjust modal on an already-saved image so the owner can
  // tweak zoom/pan without re-uploading from disk.
  function handleImageEdit(field) {
    const currentSrc = value[field];
    if (!currentSrc) return;
    const isFavicon = field === 'faviconUrl';
    openImageAdjust({
      initialSrc: currentSrc,
      aspect: UPLOAD_ASPECT[field] ?? null,
      maxWidth: isFavicon ? 512 : 1920,
      quality: isFavicon ? 0.95 : 0.85,
      frameLabel: isFavicon ? 'Adjust favicon' : 'Adjust image',
      uploadScope: field,
      outputType: isFavicon ? 'image/png' : 'image/jpeg',
      onConfirm: (v) => update(field, v),
    });
  }

  const sectionOrder = resolveSectionOrder(value.sectionOrder, vertical);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sectionOrder.indexOf(active.id);
    const newIdx = sectionOrder.indexOf(over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(sectionOrder, oldIdx, newIdx);
    update('sectionOrder', next.join(','));
  }

  // Per Design Spec v1.0 pages 4 & 5-14, the editor exposes:
  //   2 fixed sections      — Hero (top) and Footer (bottom) are always enabled
  //   8 reorderable sections — Services, About, Team, Gallery, Testimonials,
  //                             Booking, FAQ, Contact
  //   1 Business Details panel at the very top (phone/email/hours/brand/nav)
  // `labelField` = the DB column that stores the user's rename of this tab.
  // Rename once (inline on the tab), and the new name shows on the tab, in
  // the public navbar, and as the fallback heading for the section.
  // `defaultOn` = whether the section is shown for a brand-new tenant;
  // Gallery + FAQ are opt-in per Design Spec v1.0 page 4.
  const SECTION_META = {
    services:     { label: servicesLabel, showKey: 'showServices', labelField: 'navServicesLabel', defaultOn: sectionDefaultOn('services', true),  desc: sectionDesc('services', 'Cards showing your services') },
    about:        { label: sectionLabel('about', 'About'), showKey: 'showAbout', labelField: 'navAboutLabel', defaultOn: sectionDefaultOn('about', true), desc: sectionDesc('about', 'The story + 3 proof-point stats') },
    team:         { label: teamLabel, showKey: 'showTeam', labelField: 'navTeamLabel', defaultOn: sectionDefaultOn('team', true),  desc: sectionDesc('team', `Show your ${(vocab.staff || 'team').toLowerCase()} members`) },
    gallery:      { label: sectionLabel('gallery', 'Gallery'), showKey: 'showGallery', labelField: 'navGalleryLabel', defaultOn: sectionDefaultOn('gallery', false), desc: sectionDesc('gallery', 'Space, work, or people - 4-12 images') },
    testimonials: { label: sectionLabel('testimonials', 'Testimonials'), showKey: 'showTestimonials', labelField: 'navTestimonialsLabel', defaultOn: sectionDefaultOn('testimonials', true), desc: sectionDesc('testimonials', 'Customer reviews with star ratings') },
    pricing:      { label: sectionLabel('pricing', 'Pricing'), showKey: 'showPricing', labelField: 'navPricingLabel', defaultOn: sectionDefaultOn('pricing', true), desc: sectionDesc('pricing', 'Plan comparison cards with prices and features') },
    faq:          { label: sectionLabel('faq', 'FAQ'), showKey: 'showFaq', labelField: 'navFaqLabel', defaultOn: sectionDefaultOn('faq', false), desc: sectionDesc('faq', 'Pre-empt the phone calls') },
    locations:    { label: sectionLabel('locations', 'Locations'), showKey: 'showLocations', labelField: 'navLocationsLabel', defaultOn: sectionDefaultOn('locations', false), desc: sectionDesc('locations', 'Branch addresses from your Locations tab') },
    contact:      { label: sectionLabel('contact', 'Contact'), showKey: 'showContact', labelField: 'navContactLabel', defaultOn: sectionDefaultOn('contact', true), desc: sectionDesc('contact', 'Address, hours, map embed') },
  };

  // Single source of truth for whether a section is enabled, so the tab
  // toggle and the public-site renderer stay in sync.
  function sectionEnabled(key) {
    const meta = SECTION_META[key];
    if (!meta) return false;
    const v = value[meta.showKey];
    if (v === true || v === false) return v;
    return !!meta.defaultOn;
  }

  const FIXED_ITEMS = [
    { key: 'business', label: profileCopy('businessLabel', 'Business details'), icon: '🏢' },
    { key: 'hero',     label: 'Hero',             icon: '🎯', showKey: 'showHero' },
    { key: 'layout-copy', label: 'Layout copy',   icon: '✎' },
  ];

  const FIXED_FOOTER = { key: 'footer', label: 'Footer', icon: '📄', showKey: 'showFooter' };

  // Host domain for the "editing" URL in the top bar. Resolved at
  // runtime by the shared helper so staging always shows the staging
  // domain regardless of the build-time NEXT_PUBLIC_PLATFORM_DOMAIN env.
  const platformDomain = getPlatformDomain();
  const isLocalEditorHost = typeof window !== 'undefined' && isLoopbackHost(window.location.hostname);
  const editingHost = siteUrl
    || (isLocalEditorHost && business?.slug
      ? `${localWebPublicOrigin().replace(/^https?:\/\//, '')}/?tenant=${business.slug}`
      : `${(business?.slug || 'yoursite')}.${platformDomain}`);

  // Toast that pops up for 3s after a successful publish so the owner has a
  // clear, visible confirmation that their latest edits are live. The tiny
  // "saved" pill in the top bar is easy to miss; this is in-your-face.
  const [publishedToast, setPublishedToast] = useState(false);
  const prevSavedRef = useRef(saved);
  useEffect(() => {
    if (saved && !prevSavedRef.current && !saving && !error) {
      setPublishedToast(true);
      const t = setTimeout(() => setPublishedToast(false), 3000);
      return () => clearTimeout(t);
    }
    prevSavedRef.current = saved;
  }, [saved, saving, error]);

  // Viewport presets — match Chrome DevTools device sizes so the preview
  // reflects what customers actually see on each screen class.
  const VIEWPORT_PRESETS = [
    { key: 'xl',      label: 'Large laptop', icon: '🖥️', width: 1440, height: 900 },
    { key: 'laptop',  label: 'Laptop',       icon: '💻', width: 1280, height: 800 },
    { key: 'tablet',  label: 'Tablet',       icon: '📱', width: 768,  height: 1024 },
    { key: 'mobileL', label: 'Mobile L',     icon: '📱', width: 425,  height: 800 },
    { key: 'mobileM', label: 'Mobile M',     icon: '📱', width: 375,  height: 750 },
    { key: 'mobileS', label: 'Mobile S',     icon: '📱', width: 320,  height: 700 },
  ];
  const activePreset = VIEWPORT_PRESETS.find((p) => p.key === viewport) || VIEWPORT_PRESETS[1];
  const [vpMenuOpen, setVpMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  // Scale the device frame to fit the available canvas space (like Figma /
  // Chrome DevTools). The iframe inside still renders at the preset's native
  // px width so media queries fire correctly; only the visual surface is
  // transform-scaled to fit.
  const canvasWrapRef = useRef(null);
  const [previewScale, setPreviewScale] = useState(1);
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const compute = () => {
      const availW = el.clientWidth - 4;
      const availH = el.clientHeight - 4;
      const sW = availW / activePreset.width;
      const sH = availH / activePreset.height;
      // Mobile presets must STAY mobile-sized — the whole point is a
      // realistic 320/375/425-wide preview, not a zoomed-in one. For
      // anything wider (tablet / laptop / large laptop), fill the canvas
      // horizontally; the canvas wrapper's overflow-y handles any
      // vertical spill, so the preview goes edge-to-edge instead of
      // floating in gutters.
      const isMobileish = activePreset.width < 600;
      const scale = isMobileish
        ? Math.min(1, sW, sH)
        : Math.min(2, sW);
      setPreviewScale(scale);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activePreset.width, activePreset.height, view]);

  // Iframe preview — points at the actual public storefront so the canvas
  // shows the real rendered site at each device size, not a mock.
  // previewOrigin is computed further up (same file) because the postMessage
  // handlers above need it in their useEffect deps.
  const previewQuery = `_ae_preview=${previewKey}${previewPresetKey ? `&_force_preset=${encodeURIComponent(previewPresetKey)}` : ''}`;
  const iframeSrc = previewOrigin
    ? (isLocalPreviewOrigin(previewOrigin) && business?.slug
      ? `${previewOrigin}/?tenant=${encodeURIComponent(business.slug)}&${previewQuery}`
      : `${previewOrigin}/?${previewQuery}`)
    : `/?${previewQuery}`;
  const designPanel = view === 'layouts' ? layoutPanel
    : view === 'themes' ? themesPanel
      : view === 'styles' ? stylesPanel
        : view === 'colors' ? colorsPanel
          : null;
  const isDesignView = view !== 'editor' && !!designPanel;
  const designViewLabel = view === 'layouts' ? 'Layouts'
    : view === 'themes' ? 'Themes'
      : view === 'styles' ? 'Visual Styles'
        : view === 'colors' ? 'Colors'
          : '';
  const prevSavingRef = useRef(saving);
  useEffect(() => {
    if (prevSavingRef.current && !saving && !error) setPreviewKey((k) => k + 1);
    prevSavingRef.current = saving;
  }, [saving, error]);

  // Bust the iframe whenever the active layout / theme / style / colours
  // change so the live preview always reflects what's saved in the
  // subscription. previewBust is a stringified identity of the current
  // subscription tokens, supplied by the parent.
  const prevPreviewBustRef = useRef(null);
  useEffect(() => {
    if (prevPreviewBustRef.current !== null && prevPreviewBustRef.current !== previewBust) {
      setPreviewKey((k) => k + 1);
    }
    prevPreviewBustRef.current = previewBust;
  }, [previewBust]);

  return (
    <div
      className="ae-editor-root relative flex flex-col h-[calc(100vh-120px)] border rounded-[14px] overflow-hidden"
      style={{ borderColor: 'var(--ae-line)', background: 'var(--ae-bg)' }}
    >

      {/* Post-publish toast */}
      {publishedToast && (
        <div
          className="absolute top-4 left-1/2 -translate-x-1/2 z-[60] pointer-events-none"
          role="status"
          aria-live="polite"
        >
          <div
            className="flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg text-sm font-medium"
            style={{ background: '#059669', color: '#fff' }}
          >
            <span aria-hidden>✓</span>
            Your latest changes are now live
            {siteUrl && (
              <a
                href={`https://${siteUrl}`}
                target="_blank" rel="noopener"
                className="ml-1 underline decoration-white/60 hover:decoration-white pointer-events-auto"
              >
                view site ↗
              </a>
            )}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          TOP BAR — 52px · brand · editing URL · viewport · export · publish
          Per Design Spec v1.0 · page 04 "Two zones. Always visible."
          ═══════════════════════════════════════════════════════════════════ */}
      <div
        className="flex items-center gap-3 px-4 flex-shrink-0"
        style={{ height: 'var(--ae-topbar-h)', borderBottom: '1px solid var(--ae-line)', background: 'var(--ae-card)' }}
      >
        {/* Editing URL + live dot (leftmost item in the top bar) */}
        <div className="hidden md:flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--ae-success)' }} />
          <span className="ae-kicker" style={{ fontSize: 10 }}>editing</span>
          <span className="text-[12px] font-medium" style={{ color: 'var(--ae-ink-2)', fontFamily: 'var(--ae-font-mono)' }}>{editingHost}</span>
        </div>

        {/* View toggle — four panels in the editor top bar:
            Website Editor · Themes · Visual Styles · Colors.
            Each panel loads a dedicated editing surface below. */}
        {onViewChange && (
          <div className="hidden md:inline-flex items-center rounded-[8px] p-0.5 ml-2" style={{ background: 'var(--ae-bg-2)' }}>
            {[
              { k: 'editor', label: 'Website Editor' },
              { k: 'themes', label: 'Themes' },
              { k: 'layouts', label: 'Layouts' },
              { k: 'styles', label: 'Visual Styles' },
              { k: 'colors', label: 'Colors' },
            ].map((t) => {
              const active = view === t.k;
              return (
                <button
                  key={t.k}
                  onClick={() => onViewChange(t.k)}
                  className="px-3 py-1 text-[12px] font-medium rounded-[6px] transition-colors"
                  style={{
                    background: active ? 'var(--ae-card)' : 'transparent',
                    color: active ? 'var(--ae-ink)' : 'var(--ae-muted)',
                    boxShadow: active ? '0 1px 2px rgba(11,11,20,.08)' : 'none',
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Standalone theme-dropdown was removed — use the "Themes" top-bar
            tab instead. onThemeChange is still accepted as a prop because
            the Themes panel below wires to it. */}

        <div className="flex-1" />

        {/* Viewport switcher — keep it available in design modes too, since
            Themes / Layouts are judged against the live site preview. */}
        <div className="relative hidden sm:inline-block">
          <button
            onClick={() => setVpMenuOpen((o) => !o)}
            onBlur={() => setTimeout(() => setVpMenuOpen(false), 120)}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium rounded-[8px] border"
            style={{ background: 'var(--ae-card)', borderColor: 'var(--ae-line-2)', color: 'var(--ae-ink)' }}
            title="Change device preview"
          >
            <span>{activePreset.icon}</span>
            <span>{activePreset.label}</span>
            <span style={{ color: 'var(--ae-muted)', fontFamily: 'var(--ae-font-mono)', fontSize: 11 }}>
              {activePreset.width}px
            </span>
            <svg className="w-3 h-3 opacity-60" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {vpMenuOpen && (
            <div
              className="absolute right-0 mt-1 w-56 rounded-[10px] py-1 z-50"
              style={{ background: 'var(--ae-card)', border: '1px solid var(--ae-line)', boxShadow: 'var(--ae-shadow-elevated)' }}
            >
              {VIEWPORT_PRESETS.map((p) => {
                const active = p.key === viewport;
                return (
                  <button
                    key={p.key}
                    onMouseDown={(e) => { e.preventDefault(); setViewport(p.key); setVpMenuOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors"
                    style={{ background: active ? 'var(--ae-indigo-soft)' : 'transparent', color: 'var(--ae-ink)' }}
                  >
                    <span>{p.icon}</span>
                    <span className="flex-1 font-medium">{p.label}</span>
                    <span style={{ color: 'var(--ae-muted)', fontFamily: 'var(--ae-font-mono)', fontSize: 11 }}>{p.width}×{p.height}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="w-px h-5 mx-1" style={{ background: 'var(--ae-line)' }} />

        {/* Status pill */}
        {saving && (
          <span className="ae-kicker hidden md:inline" style={{ color: 'var(--ae-muted)' }}>saving…</span>
        )}
        {!saving && saved && (
          <span className="ae-kicker hidden md:inline" style={{ color: 'var(--ae-success)' }}>saved</span>
        )}
        {error && (
          <span className="ae-kicker hidden md:inline" style={{ color: '#B91C1C' }}>error</span>
        )}

        {/* Export */}
        {onExport && (
          <button
            onClick={onExport}
            className="px-3 py-1.5 text-[12px] font-semibold rounded-[8px] border transition-colors"
            style={{ borderColor: 'var(--ae-line-2)', color: 'var(--ae-ink)', background: 'var(--ae-card)' }}
          >
            Export
          </button>
        )}

        {/* Live indicator — subtle green badge when the site is already live.
            Draft state shows nothing here; the Publish button itself is the
            owner's primary signal, and clicking it opens a confirmation popup
            the first time they go live. */}
        {launchStatus?.isLive && (
          <span className="px-2.5 py-1 text-[11px] font-semibold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Live
          </span>
        )}

        {/* Publish — one button, two behaviours:
            · Site already live → saves content edits (calls onPublish as before).
            · Site in draft      → opens a pre-launch confirmation popup; the
                                   owner can cancel to keep editing or continue
                                   to publish + go live. */}
        <PublishButton
          saving={saving}
          isLive={!!launchStatus?.isLive}
          siteUrl={siteUrl}
          vertical={vertical}
          onSave={onPublish}
          onLaunch={onLaunchClick}
        />
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          ROW 2 — horizontal section tabs (Business details, Hero, 8 sections,
          Footer). Drag the middle group to reorder. Click any tab to edit it.

          Explicit h-[52px] + ae-tab-strip class: the height stays stable even
          when the horizontal scrollbar appears on narrow widths, which stops
          clicks from causing the preview iframe to rescale and "shake".
          ═══════════════════════════════════════════════════════════════════ */}
      <div
        className="ae-tab-strip flex items-center gap-1 px-3 overflow-x-auto overflow-y-hidden flex-shrink-0 border-b h-[52px]"
        style={{ borderColor: 'var(--ae-line)', background: 'var(--ae-bg)' }}
      >
        {FIXED_ITEMS.map((item) => (
          <HorizontalNavItem
            key={item.key}
            label={item.label}
            active={activeTab === item.key}
            show={item.showKey ? value[item.showKey] !== false : true}
            onToggleShow={item.showKey ? (v) => update(item.showKey, v) : null}
            onClick={() => setActiveTab(item.key)}
          />
        ))}

        <span className="w-px h-5 flex-shrink-0 mx-1" style={{ background: 'var(--ae-line)' }} />

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={sectionOrder} strategy={horizontalListSortingStrategy}>
            {sectionOrder.map((key) => {
              const meta = SECTION_META[key];
              if (!meta) return null;
              return (
                <SortableHorizontalNavItem
                  key={key}
                  id={key}
                  label={meta.label}
                  labelOverride={meta.labelField ? value[meta.labelField] : null}
                  onLabelChange={meta.labelField ? (v) => update(meta.labelField, v) : null}
                  active={activeTab === key}
                  show={sectionEnabled(key)}
                  onSelect={() => setActiveTab(key)}
                  onToggleShow={(v) => update(meta.showKey, v)}
                />
              );
            })}
          </SortableContext>
        </DndContext>

        <span className="w-px h-5 flex-shrink-0 mx-1" style={{ background: 'var(--ae-line)' }} />

        <HorizontalNavItem
          label={FIXED_FOOTER.label}
          active={activeTab === FIXED_FOOTER.key}
          show={value.showFooter !== false}
          onToggleShow={(v) => update('showFooter', v)}
          onClick={() => setActiveTab(FIXED_FOOTER.key)}
        />
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          BODY — left = inspector (only); right = canvas
          ═══════════════════════════════════════════════════════════════════ */}
      <div className={`flex-1 grid grid-cols-1 ${isDesignView ? 'lg:grid-cols-[minmax(360px,520px),minmax(0,1fr)]' : 'lg:grid-cols-[320px,minmax(0,1fr)]'} min-h-0`}>

      {/* ─── INSPECTOR (left column) — just the form for the active tab ─── */}
      <div
        className="ae-sidebar border-r overflow-y-auto"
        style={{ borderColor: 'var(--ae-line)', background: 'var(--ae-card)' }}
      >
        <div className="p-4 space-y-5">
          <p className="ae-kicker">
            {isDesignView
              ? `choose · ${designViewLabel}`
              : `edit · ${SECTION_META[activeTab]?.label || FIXED_ITEMS.find((f) => f.key === activeTab)?.label || (activeTab === 'footer' ? 'Footer' : activeTab)}`}
          </p>

          {isDesignView ? (
            <div className="design-picker-panel [&_.rounded-2xl]:rounded-xl [&_.p-6]:p-4 [&_.mt-4]:mt-3">
              {designPanel}
            </div>
          ) : (
            <>

          {/* ─── BUSINESS DETAILS — stacked: contact info + brand + navbar ───
              Per Design Spec v1.0 p.13: "address, phone, email, hours come
              from schema.business.* — editable once in a Business details
              panel at the top of the sidebar." */}
          {activeTab === 'business' && (
            <div className="space-y-5 [&_.text-sm]:text-[13px] [&_.text-xs]:text-[13px]">
              <TabHeader title="Header / Top Bar" desc="Contact details and social icons shown in the thin strip above the navbar. Email, phone and address share the same data as Settings and onboarding." />
              <SectionStateBanner show={value.showTopBar !== false} />

              {isRestaurantBuilder && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950">
                  <p className="text-sm font-bold">{profileCopy('restaurantReadinessTitle', 'Restaurant launch readiness')}</p>
                  <p className="mt-1 text-xs leading-5">{profileCopy('restaurantReadinessBody', 'Use this editor for restaurant website content. Reservation rules live in Tables and Reservations.')}</p>
                  <div className="mt-2 grid gap-1.5">
                    {String(profileCopy('restaurantReadinessItems', 'Menu cards tell guests why to book|Tables control real availability|Host Stand handles walk-ins and waitlist|Policies are shown before confirmation'))
                      .split('|')
                      .filter(Boolean)
                      .map((item) => (
                        <span key={item} className="rounded-md bg-white/70 px-2 py-1 text-[11px] font-bold">{item}</span>
                      ))}
                  </div>
                </div>
              )}

              <FieldWithToggle
                label="Business email"
                hint={vertical === 'APPOINTMENT'
                  ? 'Saved to your business record — also used on Settings, onboarding and in booking confirmation emails.'
                  : 'Saved to your business record — also used on Settings, onboarding, contact forms, and email replies.'}
                show={value.showTopBarEmail !== false}
                onToggleShow={(v) => update('showTopBarEmail', v)}
              >
                <BusinessContactInput
                  business={business}
                  field="email"
                  onUpdate={onBusinessContactUpdate}
                  onPreview={handleBusinessPreview}
                  placeholder="support@yourbusiness.com"
                  type="email"
                />
              </FieldWithToggle>

              <FieldWithToggle
                label="Business phone"
                hint="Saved to your business record — also used on Settings and onboarding."
                show={value.showTopBarPhone !== false}
                onToggleShow={(v) => update('showTopBarPhone', v)}
              >
                <BusinessContactInput
                  business={business}
                  field="phone"
                  onUpdate={onBusinessContactUpdate}
                  onPreview={handleBusinessPreview}
                  placeholder="+91 98765 43210"
                  type="tel"
                />
              </FieldWithToggle>

              <FieldWithToggle
                label="Business address"
                hint="Saved to your business record — also used on Settings and onboarding."
                show={value.showTopBarAddress !== false}
                onToggleShow={(v) => update('showTopBarAddress', v)}
              >
                <BusinessContactInput
                  business={business}
                  field="address"
                  onPreview={handleBusinessPreview}
                  onUpdate={onBusinessContactUpdate}
                  placeholder="123 Main St, City"
                />
              </FieldWithToggle>

              <FieldWithToggle
                label="Business hours"
                hint="Shown in the top info bar"
                show={value.showTopBarHours !== false}
                onToggleShow={(v) => update('showTopBarHours', v)}
              >
                <Input value={value.businessHoursText || ''} onChange={(v) => update('businessHoursText', v)} placeholder="Mon - Fri: 8:00 am - 7:00 pm" />
              </FieldWithToggle>

              <div className="border-t border-gray-200 pt-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-1">Social media links</h4>
                <p className="text-xs text-gray-500 mb-3">Add your profile URLs and use the toggle to show or hide each one independently.</p>

                <div className="space-y-3">
                  <SocialInput icon="facebook"  label="Facebook"   value={value.socialFacebook  || ''} onChange={(v) => update('socialFacebook',  v)} placeholder="https://facebook.com/yourbusiness"  show={value.showSocialFacebook  !== false} onToggleShow={(v) => update('showSocialFacebook',  v)} />
                  <SocialInput icon="instagram" label="Instagram"  value={value.socialInstagram || ''} onChange={(v) => update('socialInstagram', v)} placeholder="https://instagram.com/yourbusiness" show={value.showSocialInstagram !== false} onToggleShow={(v) => update('showSocialInstagram', v)} />
                  <SocialInput icon="twitter"   label="Twitter / X" value={value.socialTwitter   || ''} onChange={(v) => update('socialTwitter',   v)} placeholder="https://twitter.com/yourbusiness"   show={value.showSocialTwitter   !== false} onToggleShow={(v) => update('showSocialTwitter',   v)} />
                  <SocialInput icon="linkedin"  label="LinkedIn"   value={value.socialLinkedin  || ''} onChange={(v) => update('socialLinkedin',  v)} placeholder="https://linkedin.com/company/yourbusiness" show={value.showSocialLinkedin !== false} onToggleShow={(v) => update('showSocialLinkedin',  v)} />
                  <SocialInput icon="youtube"   label="YouTube"    value={value.socialYoutube   || ''} onChange={(v) => update('socialYoutube',   v)} placeholder="https://youtube.com/@yourbusiness"  show={value.showSocialYoutube   !== false} onToggleShow={(v) => update('showSocialYoutube',   v)} />
                </div>
              </div>

            </div>
          )}

          {/* ─── BRAND (Logo + Business name + Tagline) — part of Business details ─── */}
          {activeTab === 'business' && (
            <div className="space-y-5">
              <TabHeader title="Brand" desc="Your visual identity — logo, business name, and the short tagline that sits under your name." />

              <FieldWithToggle
                label="Business logo"
                hint="PNG, JPG or SVG · max 3MB"
                show={value.showLogo !== false}
                onToggleShow={(v) => update('showLogo', v)}
              >
                <div className="flex items-center gap-4">
                  {value.logoUrl ? (
                    <div className="relative inline-block">
                      <img
                        src={value.logoUrl}
                        alt="Logo"
                        className="h-16 rounded-lg object-contain border border-gray-200 bg-gray-50 p-1.5"
                        style={{ width: Math.min(64 * (UPLOAD_ASPECT.logoUrl || 1), 256) }}
                      />
                      <ImageActions
                        onEdit={() => handleImageEdit('logoUrl')}
                        onRemove={() => update('logoUrl', '')}
                        size="xs"
                      />
                    </div>
                  ) : (
                    <div className="w-16 h-16 rounded-lg flex items-center justify-center text-white font-bold text-2xl" style={{ backgroundColor: theme.primaryColor }}>
                      {(businessName || 'B').charAt(0)}
                    </div>
                  )}
                  <div>
                    <label className="cursor-pointer text-sm font-medium px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
                      {value.logoUrl ? 'Change logo' : 'Upload logo'}
                      <input type="file" accept="image/*" className="hidden" onChange={(e) => handleImageUpload('logoUrl', e)} />
                    </label>
                    <select
                      value={value.logoAspect || 'wide'}
                      onChange={(e) => update('logoAspect', e.target.value)}
                      className="mt-2 block w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700"
                    >
                      <option value="square">Square</option>
                      <option value="rectangle">Rectangle</option>
                      <option value="wide">Wide rectangle</option>
                    </select>
                    <p className="text-xs text-gray-400 mt-1.5">Logo shape is detected from upload; change it if needed.</p>
                  </div>
                </div>
              </FieldWithToggle>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-gray-700">Favicon</label>
                  <span className="text-xs text-gray-400">Browser tab icon</span>
                </div>
                <p className="text-xs text-gray-400 mb-2">Square PNG recommended · uploaded favicon is used on public site tabs.</p>
                <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-gray-50 p-3">
                  {value.faviconUrl ? (
                    <div className="relative inline-block">
                      <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-gray-200 bg-white p-2">
                        <img src={value.faviconUrl} alt="Favicon" className="max-h-8 max-w-8 object-contain" />
                      </div>
                      <ImageActions
                        onEdit={() => handleImageEdit('faviconUrl')}
                        onRemove={() => update('faviconUrl', '')}
                        size="xs"
                      />
                    </div>
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-gray-300 bg-white text-sm font-bold text-gray-400">
                      {(businessName || 'B').charAt(0)}
                    </div>
                  )}
                  <div>
                    <label className="cursor-pointer text-sm font-medium px-4 py-2 bg-white text-gray-700 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors">
                      {value.faviconUrl ? 'Change favicon' : 'Upload favicon'}
                      <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/*" className="hidden" onChange={(e) => handleImageUpload('faviconUrl', e)} />
                    </label>
                    <p className="text-xs text-gray-400 mt-1.5">Use a simple mark that stays readable at 32×32.</p>
                  </div>
                </div>
              </div>

              <FieldWithToggle
                label="Business name (in navbar)"
                hint="Leave blank to use your business name from Settings. Type here to show a different name on the website."
                show={value.showBusinessName !== false}
                onToggleShow={(v) => update('showBusinessName', v)}
              >
                <Input value={value.navbarBusinessName || ''} onChange={(v) => update('navbarBusinessName', v)} placeholder={businessName || 'Your Business'} max={60} />
              </FieldWithToggle>

              <FieldWithToggle
                label="Tagline"
                hint="Short text under your business name"
                show={value.showTagline !== false}
                onToggleShow={(v) => update('showTagline', v)}
              >
                <Input value={value.tagline || ''} onChange={(v) => update('tagline', v)} placeholder={dc.tagline} max={48} />
              </FieldWithToggle>
            </div>
          )}

          {/* ─── BLOG PAGE LAYOUT ─── */}
          {activeTab === 'business' && (
            <div className="space-y-4">
              <div className="border-t border-gray-200 pt-4">
                <TabHeader title="Blog page layout" desc="Choose which sections appear below the blog post list. Top bar, navbar and footer are always shown. Hero is never shown on blog." />
                <div className="space-y-2 mt-3">
                  {[
                    { key: 'showBlogServices',     label: servicesLabel,                        desc: 'Your services grid below the posts' },
                    { key: 'showBlogAbout',         label: 'About',                             desc: 'About section below the posts' },
                    { key: 'showBlogTestimonials',  label: 'Testimonials',                      desc: 'Customer reviews below the posts' },
                    { key: 'showBlogContact',       label: 'Contact',                           desc: 'Contact form and map below the posts' },
                  ].map(({ key, label, desc }) => (
                    <div key={key} className="flex items-center justify-between py-2 px-3 rounded-lg bg-gray-50 border border-gray-100">
                      <div>
                        <p className="text-[13px] font-medium text-gray-800">{label}</p>
                        <p className="text-[11px] text-gray-400 mt-0.5">{desc}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => update(key, !value[key])}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${value[key] ? 'bg-indigo-600' : 'bg-gray-200'}`}
                        role="switch"
                        aria-checked={!!value[key]}
                      >
                        <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${value[key] ? 'translate-x-4' : 'translate-x-0'}`} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ─── HOME BANNER / HERO ─── */}
          {activeTab === 'hero' && (
            <div className="space-y-5">
              <TabHeader title="Hero section" desc="The first screen visitors see. The image frame changes with the selected layout." />
              <SectionStateBanner show={value.showHero !== false} />

              <Field label={heroImageGuidance.fieldLabel} hint={heroImageGuidance.uploadHint}>
                <HeroImageFrameGuide guidance={heroImageGuidance} />
                {heroImageGuidance.usesImage ? (
                  <ImageUploader
                    value={value.heroBannerUrl}
                    onChange={(v) => update('heroBannerUrl', v)}
                    onUpload={(e) => handleImageUpload('heroBannerUrl', e)}
                    onEdit={() => handleImageEdit('heroBannerUrl')}
                    gallery="hero"
                    stockImages={heroImageGuidance.stockImages}
                    previewAspect={heroImageGuidance.aspectCss}
                    previewMaxWidth={heroImageGuidance.previewMaxWidth}
                    position={{
                      x: value.heroBannerPosX ?? 50, y: value.heroBannerPosY ?? 50, zoom: value.heroBannerZoom ?? 100,
                      onChange: ({ x, y, zoom }) => onChange({ heroBannerPosX: x, heroBannerPosY: y, heroBannerZoom: zoom }),
                    }}
                  />
                ) : (
                  <HeroImageNotUsed
                    value={value.heroBannerUrl}
                    onRemove={() => update('heroBannerUrl', '')}
                  />
                )}
              </Field>

              <Field label="Headline (Line 1)" hint="Big bold text — keep it powerful and short">
                <Input value={value.heroHeadline || ''} onChange={(v) => update('heroHeadline', v)} placeholder={dc.heroHeadline} max={80} />
              </Field>

              <Field label="Subheading (Line 2)" hint="Supporting text below the headline">
                <Area value={value.heroSubheading || ''} onChange={(v) => update('heroSubheading', v)} placeholder={dc.heroSubheading} max={250} rows={3} />
              </Field>

              <Field label="Description (Line 3)" hint="Optional extra detail or call-to-action text">
                <Area
                  value={value.heroLine3 || ''}
                  onChange={(v) => update('heroLine3', v)}
                  placeholder={profileCopy('heroLine3Placeholder', vertical === 'APPOINTMENT' ? 'Book your appointment today and experience the difference.' : 'Tell visitors what makes your work different.')}
                  max={200}
                  rows={2}
                />
              </Field>

              <Field label="CTA button text" hint={`Default: "${defaultCtaLabel}"`}>
                <Input value={value.heroCtaText || ''} onChange={(v) => update('heroCtaText', v)} placeholder={defaultCtaLabel} max={40} />
              </Field>

              <FieldWithToggle
                label="Trust badges"
                hint={profileCopy('trustBadgesHint', vertical === 'APPOINTMENT'
                  ? 'Three short phrases shown below the CTA, such as same-day appointments. Leave any box empty to use the theme default for that slot. Toggle off to hide all three.'
                  : 'Three short phrases shown below the CTA, such as free consultation. Leave any box empty to use the theme default for that slot. Toggle off to hide all three.')}
                show={value.showHeroTrust !== false}
                onToggleShow={(v) => update('showHeroTrust', v)}
              >
                <div className="space-y-2">
                  <Input value={value.heroTrust1 || ''} onChange={(v) => update('heroTrust1', v)} placeholder={dc.trustItems?.[0] || 'Badge 1'} max={40} />
                  <Input value={value.heroTrust2 || ''} onChange={(v) => update('heroTrust2', v)} placeholder={dc.trustItems?.[1] || 'Badge 2'} max={40} />
                  <Input value={value.heroTrust3 || ''} onChange={(v) => update('heroTrust3', v)} placeholder={dc.trustItems?.[2] || 'Badge 3'} max={40} />
                </div>
              </FieldWithToggle>

            </div>
          )}

          {/* ─── LAYOUT COPY ─── */}
          {activeTab === 'layout-copy' && (
            <div className="space-y-5">
              <TabHeader title="Layout helper text" desc="Optional copy for layout-specific touches. Which ones appear depends on your chosen Layout — and the image caption + panel title below only show inside the hero's image box when you haven't uploaded a hero photo. Leave any field blank to use the theme default." />
              <Field label="Hero image caption" hint="Small label shown inside the hero image box — only when no hero photo is uploaded">
                <Input
                  value={layoutTextValues.heroImageCaption || ''}
                  onChange={(v) => updateLayoutTextField('heroImageCaption', v)}
                  placeholder={`${servicesLabel}, proof, next step`}
                  max={80}
                />
              </Field>
              <Field label="Hero secondary button" hint="The outline button beside the main CTA">
                <Input
                  value={layoutTextValues.heroSecondaryCta || ''}
                  onChange={(v) => updateLayoutTextField('heroSecondaryCta', v)}
                  placeholder={`Review ${servicesLabel.toLowerCase()}`}
                  max={40}
                />
              </Field>
              <Field label="Hero side panel title" hint="Large title shown inside the hero image box — only when no hero photo is uploaded">
                <Input
                  value={layoutTextValues.heroPanelTitle || ''}
                  onChange={(v) => updateLayoutTextField('heroPanelTitle', v)}
                  placeholder="Visitor brief"
                  max={50}
                />
              </Field>
              <Field label="Hero checklist items" hint="One per line. Used by layouts with intake, visit, chair or goal checklist cards.">
                <Area
                  value={layoutTextValues.heroChecklist || ''}
                  onChange={(v) => updateLayoutTextField('heroChecklist', v)}
                  placeholder={`Reason for visit\nPreferred timing\nPreparation notes\nBest next step`}
                  max={320}
                  rows={4}
                />
              </Field>
              <Field label="Featured service label">
                <Input
                  value={layoutTextValues.servicesLeadLabel || ''}
                  onChange={(v) => updateLayoutTextField('servicesLeadLabel', v)}
                  placeholder={`Featured ${servicesLabel.toLowerCase().replace(/s$/, '')}`}
                  max={50}
                />
              </Field>
              <Field label="Featured service button">
                <Input
                  value={layoutTextValues.servicesLeadCta || ''}
                  onChange={(v) => updateLayoutTextField('servicesLeadCta', v)}
                  placeholder="Ask about this option"
                  max={40}
                />
              </Field>
              <Field label="Testimonials support note" hint="Short note beside or above review cards in bespoke proof layouts">
                <Area
                  value={layoutTextValues.testimonialsIntro || ''}
                  onChange={(v) => updateLayoutTextField('testimonialsIntro', v)}
                  placeholder="Explain what these reviews help visitors understand."
                  max={260}
                  rows={3}
                />
              </Field>
              <Field label="Featured testimonial label">
                <Input
                  value={layoutTextValues.testimonialLeadLabel || ''}
                  onChange={(v) => updateLayoutTextField('testimonialLeadLabel', v)}
                  placeholder={`${(vocab.customers || 'Client').replace(/s$/, '')} note`}
                  max={40}
                />
              </Field>
              <Field label="Pricing card prefix" hint="Shown before the number on package cards, e.g. Plan, Fee, Chair, Scope.">
                <Input
                  value={layoutTextValues.pricingItemLabel || ''}
                  onChange={(v) => updateLayoutTextField('pricingItemLabel', v)}
                  placeholder="Option"
                  max={24}
                />
              </Field>
              <Field label="Contact helper note" hint="Small disclaimer or guidance note below bespoke contact text">
                <Area
                  value={layoutTextValues.contactDisclaimer || ''}
                  onChange={(v) => updateLayoutTextField('contactDisclaimer', v)}
                  placeholder="Add any important note visitors should read before sending the form."
                  max={260}
                  rows={3}
                />
              </Field>
              <Field label="Contact prompt label" hint="Small prefix used before contact prompt card numbers">
                <Input
                  value={layoutTextValues.contactPromptLabel || ''}
                  onChange={(v) => updateLayoutTextField('contactPromptLabel', v)}
                  placeholder="Prompt"
                  max={24}
                />
              </Field>
              <Field label="Contact prompt items" hint="One per line. Used by bespoke contact cards beside the enquiry form.">
                <Area
                  value={layoutTextValues.contactChecklist || ''}
                  onChange={(v) => updateLayoutTextField('contactChecklist', v)}
                  placeholder={`Reason for enquiry\nPreferred timing\nHelpful context\nBest contact method`}
                  max={320}
                  rows={4}
                />
              </Field>
            </div>
          )}

          {/* ─── SERVICES ─── */}
          {activeTab === 'services' && (
            <div className="space-y-5">
              <TabHeader title={profileCopy('servicesSectionTitle', `${servicesLabel} Section`)} desc={profileCopy('servicesSectionDesc', `Cards showing your ${(vocab.services || 'services').toLowerCase()}. Edit each card below.`)} />
              <SectionStateBanner show={value.showServices !== false} />
              <Field label="Eyebrow (small uppercase label)" hint="Shown above the section title">
                <Input value={value.servicesEyebrow || ''} onChange={(v) => update('servicesEyebrow', v)} placeholder={profileCopy('servicesEyebrowPlaceholder', `Our ${servicesLabel}`)} max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.servicesTitle || ''} onChange={(v) => update('servicesTitle', v)} placeholder={profileCopy('servicesTitlePlaceholder', 'What We Offer')} max={60} />
              </Field>
              <Field label="Section intro" hint="Short paragraph shown above the service cards">
                <Area value={value.servicesIntro || ''} onChange={(v) => update('servicesIntro', v)} placeholder={dc.servicesIntro} max={200} rows={3} />
              </Field>
              <div className="border-t border-gray-200 pt-5">
                <div className="mb-3">
                  <h4 className="text-sm font-semibold text-gray-900">{profileCopy('serviceCardsTitle', servicesLabel)}</h4>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {profileCopy('serviceCardsHelp', vertical === 'APPOINTMENT'
                      ? `Add a card for each ${(vocab.services || 'service').toLowerCase().replace(/s$/, '')} you offer. Price, duration, and booking settings live in the Services tab.`
                      : `Add a card for each ${(vocab.services || 'service').toLowerCase().replace(/s$/, '')} you want to show on this website.`)}
                  </p>
                </div>
                <ServicesCardsEditor
                  value={value.cmsServices || ''}
                  onChange={(v) => update('cmsServices', v)}
                  vocab={vocab}
                  vertical={vertical}
                  builderProfile={builderProfile}
                  openImageAdjust={openImageAdjust}
                />
              </div>
            </div>
          )}

          {/* ─── ABOUT ─── */}
          {activeTab === 'about' && (
            <div className="space-y-5">
              <TabHeader title={profileCopy('aboutSectionTitle', 'About Section')} desc={profileCopy('aboutSectionDesc', 'Tell visitors about your business, mission, and team.')} />
              <SectionStateBanner show={value.showAbout !== false} />
              <Field label="Eyebrow (small uppercase label)" hint="Shown above the section title">
                <Input value={value.aboutEyebrow || ''} onChange={(v) => update('aboutEyebrow', v)} placeholder={profileCopy('aboutEyebrowPlaceholder', 'About Us')} max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.aboutTitle || ''} onChange={(v) => update('aboutTitle', v)} placeholder={dc.aboutTitle} max={60} />
              </Field>
              <Field label="About your business">
                <Area value={value.aboutBody || ''} onChange={(v) => update('aboutBody', v)} placeholder={dc.aboutBody} max={600} rows={5} />
              </Field>
              <Field label="Highlights / bullet points" hint="The checkmark list next to your description. Leave empty to use default bullets.">
                <HighlightsEditor value={value.aboutHighlights} onChange={(v) => update('aboutHighlights', v)} />
              </Field>
              <Field label="About section image" hint="JPG or PNG · max 3MB. Shown next to your description (leave blank for a stylised quote card).">
                <ImageUploader
                  value={value.aboutImageUrl}
                  onChange={(v) => update('aboutImageUrl', v)}
                  onUpload={(e) => handleImageUpload('aboutImageUrl', e)}
                  onEdit={() => handleImageEdit('aboutImageUrl')}
                  gallery="about"
                  position={{
                    x: value.aboutImagePosX ?? 50, y: value.aboutImagePosY ?? 50, zoom: value.aboutImageZoom ?? 100,
                    onChange: ({ x, y, zoom }) => onChange({ aboutImagePosX: x, aboutImagePosY: y, aboutImageZoom: zoom }),
                  }}
                />
              </Field>
              <Field label="Image position" hint="Left or right of the text">
                <div className="flex gap-2">
                  {[{ v: 'right', label: 'Right (default)' }, { v: 'left', label: 'Left' }].map((opt) => {
                    const active = (value.aboutImagePosition || 'right') === opt.v;
                    return (
                      <button key={opt.v} onClick={() => update('aboutImagePosition', opt.v)}
                        className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${active ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'}`}>
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
            </div>
          )}

          {/* ─── TEAM ─── */}
          {activeTab === 'team' && (
            <div className="space-y-5">
              <TabHeader title={profileCopy('teamSectionTitle', `${teamLabel} Section`)} desc={profileCopy('teamSectionDesc', `Cards showing your ${(vocab.staff || 'team').toLowerCase()}. Edit each card below.`)} />
              <SectionStateBanner show={value.showTeam !== false} />
              <Field label="Eyebrow (small uppercase label)">
                <Input value={value.teamEyebrow || ''} onChange={(v) => update('teamEyebrow', v)} placeholder={`Our ${teamLabel}`} max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.teamTitle || ''} onChange={(v) => update('teamTitle', v)} placeholder={`Meet Our ${teamLabel}`} max={80} />
              </Field>
              <Field label="Section intro">
                <Area
                  value={value.teamIntro || ''}
                  onChange={(v) => update('teamIntro', v)}
                  placeholder={profileCopy('teamIntroPlaceholder', `Our qualified ${(vocab.staff || 'team').toLowerCase()} is here to provide you with the best experience.`)}
                  max={250}
                  rows={3}
                />
              </Field>
              <Field label="Default member subtitle" hint={profileCopy('teamMemberSubtitleHint', "Shown under each team member name when their own subtitle is empty.")}>
                <Input value={value.teamMemberLabel || ''} onChange={(v) => update('teamMemberLabel', v)} placeholder={`${teamLabel} Member`} max={40} />
              </Field>
              <div className="border-t border-gray-200 pt-5">
                <div className="mb-3">
                  <h4 className="text-sm font-semibold text-gray-900">{profileCopy('teamCardsTitle', teamLabel)}</h4>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {profileCopy('teamCardsHelp', vertical === 'APPOINTMENT'
                      ? `Add a card for each ${(vocab.staff || 'team').toLowerCase().replace(/s$/, '') || 'member'} you want to feature. To let a ${(vocab.staff || 'team').toLowerCase().replace(/s$/, '') || 'member'} log in and take bookings, invite them from the Staff tab.`
                      : `Add a card for each ${(vocab.staff || 'team').toLowerCase().replace(/s$/, '') || 'member'} you want to feature on this website.`)}
                  </p>
                </div>
                <TeamCardsEditor
                  value={value.cmsTeam || ''}
                  onChange={(v) => update('cmsTeam', v)}
                  vocab={vocab}
                  vertical={vertical}
                  memberLabelPlaceholder={`${teamLabel} Member`}
                  openImageAdjust={openImageAdjust}
                />
              </div>
            </div>
          )}

          {/* ─── TESTIMONIALS ─── */}
          {activeTab === 'testimonials' && (
            <div className="space-y-4">
              <TabHeader title={profileCopy('testimonialsSectionTitle', sectionLabel('testimonials', 'Testimonials'))} desc={profileCopy('testimonialsSectionDesc', 'Customer reviews with star ratings - up to 6.')} />
              <SectionStateBanner show={value.showTestimonials !== false} />
              <Field label="Eyebrow (small uppercase label)">
                <Input value={value.testimonialsEyebrow || ''} onChange={(v) => update('testimonialsEyebrow', v)} placeholder={profileCopy('testimonialsEyebrowPlaceholder', sectionLabel('testimonials', 'Testimonials'))} max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.testimonialsTitle || ''} onChange={(v) => update('testimonialsTitle', v)} placeholder={profileCopy('testimonialsTitlePlaceholder', vertical === 'APPOINTMENT' ? 'What Our Patients Say' : 'What Clients Say')} max={80} />
              </Field>
              {onTestimonialsChange && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-gray-900">Reviews ({testimonials.length}/6)</h4>
                    {testimonials.length < 6 && (
                      <button onClick={() => onTestimonialsChange([...testimonials, { name: '', text: '', rating: 5, role: '' }])}
                        className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
                        + Add review
                      </button>
                    )}
                  </div>
                  {testimonials.length === 0 && (
                    <p className="text-xs text-gray-500 italic py-6 text-center border border-dashed border-gray-300 rounded-lg">No reviews yet. Click "Add review" to start.</p>
                  )}
                  {testimonials.map((t, i) => (
                    <div key={i} className="border border-gray-200 rounded-xl p-3 mb-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-gray-500">Review #{i + 1}</span>
                        <button onClick={() => { const c = [...testimonials]; c.splice(i, 1); onTestimonialsChange(c); }} className="text-xs text-red-600 hover:underline">Remove</button>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0">
                          <TestimonialAvatarUploader
                            value={t.avatarUrl || ''}
                            name={t.name}
                            openImageAdjust={openImageAdjust}
                            onChange={(url) => { const c = [...testimonials]; c[i] = { ...c[i], avatarUrl: url }; onTestimonialsChange(c); }}
                          />
                        </div>
                        <div className="flex-1 space-y-2 min-w-0">
                          <div className="grid grid-cols-2 gap-2">
                            <Input value={t.name} onChange={(v) => { const c = [...testimonials]; c[i] = { ...c[i], name: v }; onTestimonialsChange(c); }} placeholder="Name" />
                            <Input value={t.role || ''} onChange={(v) => { const c = [...testimonials]; c[i] = { ...c[i], role: v }; onTestimonialsChange(c); }} placeholder="Role (optional)" />
                          </div>
                        </div>
                      </div>
                      <Area value={t.text} onChange={(v) => { const c = [...testimonials]; c[i] = { ...c[i], text: v }; onTestimonialsChange(c); }} max={200} rows={2} placeholder="Their review..." />
                      <div className="flex gap-1">
                        {[1, 2, 3, 4, 5].map((star) => (
                          <button key={star} onClick={() => { const c = [...testimonials]; c[i] = { ...c[i], rating: star }; onTestimonialsChange(c); }}
                            className="text-lg" style={{ color: star <= (t.rating || 5) ? '#f59e0b' : '#d1d5db' }}>★</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ─── GALLERY (Design Spec v1.0 · page 9) ─── */}
          {activeTab === 'gallery' && (
            <div className="space-y-5">
              <TabHeader title={profileCopy('gallerySectionTitle', sectionLabel('gallery', 'Gallery'))} desc={profileCopy('gallerySectionDesc', 'Show the space, the work, or the people. 4-12 images.')} />
              <SectionStateBanner show={value.showGallery === true} />
              <Field label="Eyebrow (small uppercase label)">
                <Input value={value.galleryEyebrow || ''} onChange={(v) => update('galleryEyebrow', v)} placeholder={sectionLabel('gallery', 'Gallery')} max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.galleryTitle || ''} onChange={(v) => update('galleryTitle', v)} placeholder={profileCopy('galleryTitlePlaceholder', 'Inside the space')} max={80} />
              </Field>
              <Field label="Supporting line" hint="Optional — one short sentence below the title">
                <Input value={value.gallerySub || ''} onChange={(v) => update('gallerySub', v)} placeholder="A look around our space." max={160} />
              </Field>
              <GalleryItemsEditor
                value={value.galleryItems || ''}
                onChange={(v) => update('galleryItems', v)}
                openImageAdjust={openImageAdjust}
              />
            </div>
          )}

          {/* ─── FAQ (Design Spec v1.0 · page 12) ─── */}
          {activeTab === 'faq' && (
            <div className="space-y-5">
              <TabHeader title={profileCopy('faqSectionTitle', 'FAQ')} desc={profileCopy('faqSectionDesc', 'Pre-empt the phone calls. 4-8 questions, one-click accordion.')} />
              <SectionStateBanner show={value.showFaq === true} />
              <Field label="Eyebrow (small uppercase label)">
                <Input value={value.faqEyebrow || ''} onChange={(v) => update('faqEyebrow', v)} placeholder="FAQ" max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.faqTitle || ''} onChange={(v) => update('faqTitle', v)} placeholder="Common questions" max={80} />
              </Field>
              <Field label="Intro line" hint="Optional — one line above the questions">
                <Input value={value.faqIntro || ''} onChange={(v) => update('faqIntro', v)} placeholder="Matters often asked" max={160} />
              </Field>
              <FaqItemsEditor value={value.faqItems || ''} onChange={(v) => update('faqItems', v)} />
            </div>
          )}

          {/* ─── LOCATIONS ─── */}
          {activeTab === 'locations' && (
            <div className="space-y-5">
              <TabHeader title={profileCopy('locationsSectionTitle', 'Locations')} desc={profileCopy('locationsSectionDesc', 'Show your branch addresses on the website as a simple list.')} />
              <SectionStateBanner show={value.showLocations === true} />
              <div className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
                Branches come from your <strong>Locations</strong> tab (the “Multi-branch addresses” page). Add or edit
                addresses there — every <em>active</em> location shows here automatically. This section only controls the
                heading and whether the list appears on your site.
              </div>
              <Field label="Eyebrow (small uppercase label)">
                <Input value={value.locationsEyebrow || ''} onChange={(v) => update('locationsEyebrow', v)} placeholder="Our locations" max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.locationsTitle || ''} onChange={(v) => update('locationsTitle', v)} placeholder="Visit us" max={80} />
              </Field>
              <Field label="Intro line" hint="Optional — one line above the branch list">
                <Input value={value.locationsIntro || ''} onChange={(v) => update('locationsIntro', v)} placeholder="Find us at any of our branches." max={160} />
              </Field>
            </div>
          )}

          {/* ─── CONTACT ─── */}
          {activeTab === 'contact' && (
            <div className="space-y-5">
              <TabHeader title={profileCopy('contactSectionTitle', 'Contact Section')} desc={profileCopy('contactSectionDesc', vertical === 'APPOINTMENT' ? 'Contact information and a quick booking card.' : 'Contact information and enquiry form.')} />
              <SectionStateBanner show={value.showContact !== false} />
              <Field label="Eyebrow (small uppercase label)">
                <Input value={value.contactEyebrow || ''} onChange={(v) => update('contactEyebrow', v)} placeholder={profileCopy('contactEyebrowPlaceholder', 'Contact Us')} max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.contactTitle || ''} onChange={(v) => update('contactTitle', v)} placeholder="Get In Touch" max={60} />
              </Field>
              <Field label="Section body" hint="Short paragraph shown inside the Contact section">
                <Area value={value.contactBody || ''} onChange={(v) => update('contactBody', v)} placeholder="We'd love to hear from you. Reach out with any questions." max={400} rows={4} />
              </Field>
              <div className="border-t border-gray-200 pt-4 space-y-4">
                <h4 className="text-sm font-semibold text-gray-900">Info labels</h4>
                <Field label="Address label">
                  <Input value={value.aboutAddressLabel || ''} onChange={(v) => update('aboutAddressLabel', v)} placeholder="Address" max={30} />
                </Field>
                <Field label="Phone label">
                  <Input value={value.aboutPhoneLabel || ''} onChange={(v) => update('aboutPhoneLabel', v)} placeholder="Phone" max={30} />
                </Field>
              </div>
              <div className="border-t border-gray-200 pt-4 space-y-4">
                <h4 className="text-sm font-semibold text-gray-900">Enquiry form</h4>
                <p className="text-xs text-gray-500">Customer-submitted messages land in the Enquiries tab.</p>
                <Field label="Form title">
                  <Input value={value.enquiryFormTitle || ''} onChange={(v) => update('enquiryFormTitle', v)} placeholder="Send an enquiry" max={60} />
                </Field>
                <Field label="Form body">
                  <Area value={value.enquiryFormBody || ''} onChange={(v) => update('enquiryFormBody', v)} placeholder="Fill in the form and we'll get back within one business day." max={240} rows={2} />
                </Field>
                <Field label="Submit button label">
                  <Input value={value.enquiryFormCta || ''} onChange={(v) => update('enquiryFormCta', v)} placeholder="Send message" max={40} />
                </Field>
                <Field label="Thank-you title" hint="Shown after a successful submit">
                  <Input value={value.enquiryThanksTitle || ''} onChange={(v) => update('enquiryThanksTitle', v)} placeholder="Thanks — message received." max={80} />
                </Field>
                <Field label="Thank-you body">
                  <Area value={value.enquiryThanksBody || ''} onChange={(v) => update('enquiryThanksBody', v)} placeholder="We'll be in touch shortly." max={200} rows={2} />
                </Field>
              </div>
              {vertical === 'APPOINTMENT' && (
                <div className="border-t border-gray-200 pt-4 space-y-4">
                  <h4 className="text-sm font-semibold text-gray-900">If booking is paused</h4>
                  <p className="text-xs text-gray-500">Shown to visitors when your business isn&apos;t accepting bookings.</p>
                  <Field label="Notice title">
                    <Input value={value.inactiveNoticeTitle || ''} onChange={(v) => update('inactiveNoticeTitle', v)} placeholder={`${businessName || 'Your business'} is not currently accepting online bookings.`} max={160} />
                  </Field>
                  <Field label="Notice body">
                    <Area value={value.inactiveNoticeBody || ''} onChange={(v) => update('inactiveNoticeBody', v)} placeholder="Please check back later or contact the business directly." max={240} rows={2} />
                  </Field>
                </div>
              )}
            </div>
          )}

          {/* ─── FOOTER ─── */}
          {activeTab === 'footer' && (
            <div className="space-y-5">
              <TabHeader title="Footer" desc="The dark strip at the very bottom of your website. Shows your logo, business name, tagline, and a copyright line." />
              <FieldWithToggle
                label="Show footer"
                hint="Toggle off to hide the footer entirely"
                show={value.showFooter !== false}
                onToggleShow={(v) => update('showFooter', v)}
              >
                <p className="text-xs text-gray-500">When hidden, your site ends at the last content section.</p>
              </FieldWithToggle>
              <Field label="Copyright line" hint="The text at the very bottom. Leave blank to auto-generate &copy; {year} {business name}.">
                <Input value={value.footerCopyright || ''} onChange={(v) => update('footerCopyright', v)} placeholder={`© ${new Date().getFullYear()} ${businessName || 'Your Business'}. All rights reserved.`} max={120} />
              </Field>

              <div className="border-t border-gray-200 pt-5">
                <div className="mb-3">
                  <h4 className="text-sm font-semibold text-gray-900">Website policies</h4>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Add policies like Privacy Policy, Terms of Service, Refund Policy. Each appears as a link in the footer. Leave empty to hide — policy links only appear once you&rsquo;ve written at least one.
                  </p>
                </div>
                <PoliciesEditor
                  value={value.policies || ''}
                  onChange={(v) => update('policies', v)}
                />
              </div>

              <p className="text-xs text-gray-500">
                Your logo, business name, and tagline come from the <strong>Brand</strong> tab — edit them there to change how they appear in the footer.
              </p>
            </div>
          )}

          {/* ─── CTA ─── */}
          {/* ─── BOOKING (Design Spec v1.0 · page 11) — "The payoff."
              The whole product exists for this. A live booking form that
              collects service, date/time and customer info, POSTs to the
              backend and triggers SMS + email confirmation. */}
          {activeTab === 'pricing' && (
            <div className="space-y-5">
              <TabHeader title={profileCopy('pricingSectionTitle', sectionLabel('pricing', 'Pricing'))} desc={profileCopy('pricingSectionDesc', "Plan comparison cards with prices and features. Up to 4 tiers - the highlighted one gets the 'Most popular' badge.")} />
              <SectionStateBanner show={value.showPricing !== false} />
              <Field label="Eyebrow (small uppercase label)">
                <Input value={value.pricingEyebrow || ''} onChange={(v) => update('pricingEyebrow', v)} placeholder={profileCopy('pricingEyebrowPlaceholder', sectionLabel('pricing', 'Pricing'))} max={40} />
              </Field>
              <Field label="Section title">
                <Input value={value.pricingTitle || ''} onChange={(v) => update('pricingTitle', v)} placeholder="Simple, transparent pricing" max={80} />
              </Field>
              <Field label="Section intro" hint="Short paragraph shown above the pricing cards.">
                <Area value={value.pricingIntro || ''} onChange={(v) => update('pricingIntro', v)} placeholder="Choose the plan that fits where you are today — you can always upgrade later." max={240} rows={2} />
              </Field>
              <div className="border-t border-gray-200 pt-4">
                <div className="mb-2">
                  <h4 className="text-sm font-semibold text-gray-900">{profileCopy('pricingTierTitle', 'Pricing tiers')}</h4>
                  <p className="text-xs text-gray-500 mt-0.5">{profileCopy('pricingTierHelp', 'Each tier: title, price, optional badge, description, feature list, and a button label. Tick Highlight on the one you want to stand out.')}</p>
                </div>
                <PricingTiersEditor value={value.pricingTiers || ''} onChange={(v) => update('pricingTiers', v)} builderProfile={builderProfile} />
              </div>
            </div>
          )}
            </>
          )}
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          CANVAS — real preview. Same renderer that will serve the public site.
          Wrapped in a viewport frame (desktop 100% · tablet 820 · mobile 390).
          ═══════════════════════════════════════════════════════════════════ */}
      <div
        className="hidden lg:flex flex-col overflow-auto"
        style={{ background: 'var(--ae-bg-2)' }}
      >
        {/* Tiny label strip to echo spec's "CANVAS · DEVICE · site.com" caption */}
        <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-shrink-0">
          <p className="ae-kicker">
            {isDesignView
              ? `preview · ${designViewLabel.toLowerCase()} · ${activePreset.label.toLowerCase()} · ${activePreset.width}×${activePreset.height}${previewScale < 1 ? ` @ ${Math.round(previewScale * 100)}%` : ''} · ${editingHost}`
              : `canvas · ${activePreset.label.toLowerCase()} · ${activePreset.width}×${activePreset.height}${previewScale < 1 ? ` @ ${Math.round(previewScale * 100)}%` : ''} · ${editingHost}`}
          </p>
          <div className="flex-1" />
          {view === 'editor' && (
            <p className="text-[11px]" style={{ color: 'var(--ae-muted)', fontStyle: 'italic' }}>
              Live draft · edits appear instantly, hit Publish to save.
            </p>
          )}
        </div>

        {/* Canvas wrapper — measured by ResizeObserver so the device frame
            can be transform-scaled to fit without horizontal scrolling. */}
        <div ref={canvasWrapRef} className="flex-1 px-2 pb-2 overflow-x-hidden overflow-y-auto flex justify-center items-start">
          {/* Outer holder reserves the SCALED space (so no empty gap below). */}
          <div
            style={{
              width: activePreset.width * previewScale,
              height: activePreset.height * previewScale,
            }}
          >
            <div
              className="transition-all duration-200 relative"
              style={{
                width: activePreset.width,
                height: activePreset.height,
                boxShadow: 'var(--ae-shadow-elevated)',
                borderRadius: 'var(--ae-r)',
                background: '#fff',
                border: '1px solid var(--ae-line)',
                overflow: 'hidden',
                transform: `scale(${previewScale})`,
                transformOrigin: 'top left',
              }}
            >
              {/* The iframe renders the real public storefront at the device's
                  pixel width, so the preview matches exactly what customers see. */}
              <iframe
                ref={iframeRef}
                key={previewKey}
                src={iframeSrc}
                title="Live site preview"
                style={{ width: '100%', height: '100%', border: 0, display: 'block', background: '#fff' }}
                loading="eager"
                onLoad={postDraftToIframe}
              />
              {/* Refresh pill — bottom right of the frame */}
              <button
                onClick={() => setPreviewKey((k) => k + 1)}
                className="absolute bottom-2 right-2 px-2.5 py-1 rounded-full text-[11px] font-medium flex items-center gap-1"
                style={{ background: 'rgba(11,11,20,.75)', color: '#fff', backdropFilter: 'blur(6px)' }}
                title="Reload preview"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 4v6h6M20 20v-6h-6M4 10a8 8 0 0114.93-2M20 14a8 8 0 01-14.93 2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Refresh
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>{/* end body grid */}

      {/* Shared image-adjust modal — Sprint 3.3f routes through the
          centralised ImageEditorModal so every editor uploader uses
          the same crop/zoom/rotate UX as the block editor + blog +
          services. openImageAdjust API preserved upstream so all
          existing call sites stay unchanged. */}
      {adjustingImage && (
        <ImageEditorModal
          value={adjustingImage.value}
          frameAspect={adjustingImage.aspect || 16 / 9}
          maxOutputWidth={adjustingImage.maxWidth || 1920}
          scope={adjustingImage.uploadScope || 'image'}
          outputType={adjustingImage.outputType || 'image/jpeg'}
          title={adjustingImage.frameLabel || 'Adjust image'}
          onSave={adjustingImage.onConfirm}
          onClose={adjustingImage.onCancel || closeImageAdjust}
        />
      )}
    </div>
  );
}

// ============================================================================
// Medixi-style full preview
// ============================================================================
function MedixiPreview({ theme, themeKey, businessName, content, testimonials, services, staff, business, vocab, onEdit, selectedKey, onSelectSection, vertical = 'APPOINTMENT' }) {
  // Click-to-select helper — adds a 2px indigo outline + click handler per section.
  // Per Design Spec v1.0 page 4: "Clicking a section in the canvas or sidebar
  // highlights it with a 2px indigo outline and scrolls the inspector into view."
  function sectionSelectable(key, extra = {}) {
    if (!onSelectSection) return extra;
    const isSelected = selectedKey === key;
    return {
      ...extra,
      onClick: (e) => { e.stopPropagation?.(); onSelectSection(key); extra.onClick?.(e); },
      className: `${extra.className || ''} ae-selectable ${isSelected ? 'ae-selected' : ''}`.trim(),
    };
  }
  const dc = theme.defaultContent || {};
  const vars = getThemeVars(themeKey);
  const builderProfile = resolveBuilderProfile({ themeKey, theme, business, vertical });
  const profileCopy = (key, fallback) => builderProfile.copy?.[key] || fallback;
  const profileSection = (key) => builderProfile.sections?.[key] || {};
  const sectionLabel = (key, fallback) => profileSection(key).label || fallback;
  const isDark = theme.heroStyle === 'dark';
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';

  const tagline = content.tagline || dc.tagline || '';
  const headline = content.heroHeadline || dc.heroHeadline || '';
  const subheading = content.heroSubheading || dc.heroSubheading || '';
  const heroLine3 = content.heroLine3 || '';
  const ctaText = content.heroCtaText || profileCopy('ctaLabel', vertical === 'APPOINTMENT' ? (vocab.bookNow || 'Book now') : vertical === 'ECOMMERCE' ? 'Shop now' : 'Contact us');
  const aboutTitle = content.aboutTitle || dc.aboutTitle || 'About us';
  const aboutBody = content.aboutBody || dc.aboutBody || '';
  const servicesIntro = content.servicesIntro || dc.servicesIntro || '';
  const contactTitle = content.contactTitle || 'Get In Touch';
  const logoUrl = content.logoUrl || null;
  const bannerUrl = content.heroBannerUrl || null;
  const initial = (businessName || 'B').charAt(0).toUpperCase();

  const showStats = content.showStats !== false;
  const showServices = content.showServices !== false;
  const showAbout = content.showAbout !== false;
  const showTeam = content.showTeam !== false;
  const showTestimonials = content.showTestimonials !== false;
  const showContact = content.showContact !== false;
  const showCta = content.showCta !== false;
  const showGallery = content.showGallery === true;
  const showFaq = content.showFaq === true;

  // Gallery + FAQ parsed payloads
  const parsedGalleryItems = (() => {
    if (!content.galleryItems) return [];
    try { const a = JSON.parse(content.galleryItems); return Array.isArray(a) ? a : []; } catch { return []; }
  })();
  const parsedFaqItems = (() => {
    if (!content.faqItems) return [];
    try { const a = JSON.parse(content.faqItems); return Array.isArray(a) ? a : []; } catch { return []; }
  })();

  // Stats: custom items override defaults; defaults use service/staff counts + trust items
  const parsedStatsItems = (() => {
    if (!content.statsItems) return null;
    try {
      const arr = JSON.parse(content.statsItems);
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch { return null; }
  })();
  const staffLabelPreview = sectionLabel('team', cap(vocab.staff || 'Team'));
  const servicesLabelPreview = sectionLabel('services', cap(vocab.services || 'Services'));
  const defaultStats = [
    { number: `${services.length}+`, label: `${servicesLabelPreview} offered` },
    { number: `${staff.length}+`, label: `${staffLabelPreview} members` },
    ...(((dc.trustItems || []).length > 0) ? [{ number: '24/7', label: dc.trustItems[0] || 'Available' }] : []),
    ...(((dc.trustItems || []).length > 1) ? [{ number: '100%', label: dc.trustItems[1] || 'Satisfaction' }] : []),
  ];
  const statsItems = parsedStatsItems
    ? parsedStatsItems.slice(0, 4).map((it) => ({ number: it.number || it.value || '', label: it.label || '' }))
    : defaultStats;

  // About: eyebrow + highlights + image
  const aboutEyebrow = content.aboutEyebrow?.trim() || 'About Us';
  const parsedHighlights = (() => {
    if (!content.aboutHighlights) return null;
    try {
      const arr = JSON.parse(content.aboutHighlights);
      if (Array.isArray(arr)) {
        const cleaned = arr.map((s) => String(s).trim()).filter(Boolean);
        return cleaned.length > 0 ? cleaned : null;
      }
      return null;
    } catch { return null; }
  })();
  const defaultHighlights = vertical === 'APPOINTMENT' ? [
    'Experienced & certified professionals',
    'Patient-centered approach',
    'Modern equipment & facilities',
    'Convenient online booking',
  ] : [
    'Experienced professionals',
    'Clear communication',
    'Reliable service',
    'Easy enquiry process',
  ];
  const aboutHighlightItems = parsedHighlights || defaultHighlights;

  // Section eyebrows + titles
  const servicesEyebrow = content.servicesEyebrow?.trim() || `Our ${servicesLabelPreview}`;
  const servicesTitle = content.servicesTitle?.trim() || profileCopy('servicesTitlePlaceholder', 'What We Offer');
  const teamEyebrow = content.teamEyebrow?.trim() || `Our ${staffLabelPreview}`;
  const teamTitle = content.teamTitle?.trim() || `Meet Our ${staffLabelPreview}`;
  const teamIntroText = content.teamIntro?.trim() || '';
  const teamMemberSubtitle = content.teamMemberLabel?.trim() || `${staffLabelPreview} Member`;
  const testimonialsEyebrow = content.testimonialsEyebrow?.trim() || profileCopy('testimonialsEyebrowPlaceholder', sectionLabel('testimonials', 'Testimonials'));
  const testimonialsTitle = content.testimonialsTitle?.trim() || profileCopy('testimonialsTitlePlaceholder', vertical === 'APPOINTMENT' ? 'What Our Patients Say' : 'What Clients Say');
  const galleryEyebrow = content.galleryEyebrow?.trim() || sectionLabel('gallery', 'Gallery');
  const galleryTitle = content.galleryTitle?.trim() || profileCopy('galleryTitlePlaceholder', 'Inside the space');
  const gallerySub = content.gallerySub?.trim() || '';
  const faqEyebrow = content.faqEyebrow?.trim() || 'FAQ';
  const faqTitle = content.faqTitle?.trim() || 'Common questions';
  const faqIntro = content.faqIntro?.trim() || '';
  const contactEyebrow = content.contactEyebrow?.trim() || profileCopy('contactEyebrowPlaceholder', 'Contact Us');
  const contactBodyText = content.contactBody?.trim() || profileCopy('contactBodyFallback', vertical === 'APPOINTMENT' ? 'Have questions? Reach out or book online.' : 'Have questions? Reach out and we will get back to you.');
  const ctaBodyText = content.ctaBody?.trim() || profileCopy('ctaBodyFallback', vertical === 'APPOINTMENT' ? 'Book your appointment online today.' : 'Send an enquiry and we will get back to you.');
  const ctaHeadlineText = content.ctaHeadline?.trim() || vocab.ctaQuestion || 'Ready to get started?';

  // Navbar labels — dynamic, one per enabled section
  const navLinks = [
    content.showHero         !== false && (content.navHomeLabel?.trim()         || 'Home'),
    content.showServices     !== false && (content.navServicesLabel?.trim()     || servicesLabelPreview),
    content.showPricing      === true  && (content.navPricingLabel?.trim()      || 'Pricing'),
    content.showAbout        !== false && (content.navAboutLabel?.trim()        || 'About'),
    content.showTeam         !== false && (content.navTeamLabel?.trim()         || staffLabelPreview),
    content.showTestimonials !== false && (content.navTestimonialsLabel?.trim() || 'Testimonials'),
    content.showContact      !== false && (content.navContactLabel?.trim()      || 'Contact'),
  ].filter(Boolean);

  // Image URLs
  const servicesImageUrl = content.servicesImageUrl || null;
  const aboutImageUrl = content.aboutImageUrl || null;
  const aboutImageOnLeft = content.aboutImagePosition === 'left';
  const ctaBackgroundUrl = content.ctaBackgroundUrl || null;

  // Image positioning styles (same helper as live page)
  const pvImgStyle = (x, y, z) => {
    const px = Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 50;
    const py = Number.isFinite(y) ? Math.max(0, Math.min(100, y)) : 50;
    const pz = Number.isFinite(z) ? Math.max(100, Math.min(300, z)) : 100;
    return {
      objectPosition: `${px}% ${py}%`,
      transform: pz !== 100 ? `scale(${pz / 100})` : undefined,
      transformOrigin: `${px}% ${py}%`,
    };
  };
  const heroBannerStyle = pvImgStyle(content.heroBannerPosX, content.heroBannerPosY, content.heroBannerZoom);
  const aboutImageStyle = pvImgStyle(content.aboutImagePosX, content.aboutImagePosY, content.aboutImageZoom);
  const servicesImageStyle = pvImgStyle(content.servicesImagePosX, content.servicesImagePosY, content.servicesImageZoom);
  const ctaBgStyle = pvImgStyle(content.ctaBackgroundPosX, content.ctaBackgroundPosY, content.ctaBackgroundZoom);

  // Footer
  const footerDescription = content.footerDescription?.trim() || business.description || '';
  const footerCopyright = content.footerCopyright?.trim() || `© ${new Date().getFullYear()} ${businessName}`;
  const showFooter = content.showFooter !== false;

  const socials = [
    normalizeSocialPreviewUrl('facebook', content.socialFacebook)  && content.showSocialFacebook  !== false && SOCIAL_ICONS.facebook,
    normalizeSocialPreviewUrl('instagram', content.socialInstagram) && content.showSocialInstagram !== false && SOCIAL_ICONS.instagram,
    normalizeSocialPreviewUrl('twitter', content.socialTwitter)   && content.showSocialTwitter   !== false && SOCIAL_ICONS.twitter,
    normalizeSocialPreviewUrl('linkedin', content.socialLinkedin)  && content.showSocialLinkedin  !== false && SOCIAL_ICONS.linkedin,
    normalizeSocialPreviewUrl('youtube', content.socialYoutube)   && content.showSocialYoutube   !== false && SOCIAL_ICONS.youtube,
  ].filter(Boolean);

  const pvShowLogo = content.showLogo !== false;
  const pvShowBusinessName = content.showBusinessName !== false;
  const pvShowTagline = content.showTagline !== false;
  const pvDisplayName = content.navbarBusinessName?.trim() || businessName;
  const pvEmail = (business.email && business.email.trim()) || (content.businessEmail && content.businessEmail.trim());
  const pvPhone = (business.phone && business.phone.trim()) || (content.businessPhoneOverride && content.businessPhoneOverride.trim());
  const pvAddress = (business.address && business.address.trim()) || (content.businessAddressOverride && content.businessAddressOverride.trim());
  const pvShowTopEmail = content.showTopBarEmail !== false && !!pvEmail;
  const pvShowTopPhone = content.showTopBarPhone !== false && !!pvPhone;
  const pvShowTopAddress = content.showTopBarAddress !== false && !!pvAddress;
  const pvShowTopHours = content.showTopBarHours !== false && !!content.businessHoursText;

  // Custom colors
  const cv = { ...vars };
  if (content.customPrimary) cv['--theme-primary'] = content.customPrimary;
  if (content.customBg) cv['--theme-bg'] = content.customBg;
  if (content.customSurface) cv['--theme-surface'] = content.customSurface;
  if (content.customText) cv['--theme-text'] = content.customText;
  if (content.customMuted) cv['--theme-muted'] = content.customMuted;
  if (content.customAccent) cv['--theme-accent'] = content.customAccent;
  if (content.customPrimary) cv['--theme-on-primary'] = pickOnColor(content.customPrimary);
  if (content.customAccent) cv['--theme-on-accent'] = pickOnColor(content.customAccent);

  // Delegated click-to-select: walk up from the target looking for an ancestor
  // with data-ae-section; select it. Per Design Spec v1.0 · page 4.
  function handleCanvasClick(e) {
    if (!onSelectSection) return;
    let node = e.target;
    while (node && node !== e.currentTarget) {
      const key = node.getAttribute?.('data-ae-section');
      if (key) { onSelectSection(key); return; }
      node = node.parentElement;
    }
  }

  return (
    <div
      className="rounded-xl overflow-hidden border border-gray-300 shadow-xl"
      style={{ fontSize: '10px' }}
      onClick={handleCanvasClick}
    >
      {/* Browser chrome */}
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-gray-100 border-b border-gray-200">
        <div className="flex gap-1">
          <span className="w-2 h-2 rounded-full bg-red-400" />
          <span className="w-2 h-2 rounded-full bg-yellow-400" />
          <span className="w-2 h-2 rounded-full bg-green-400" />
        </div>
        <div className="flex-1 px-2 py-0.5 bg-white rounded text-[8px] text-gray-400 text-center border border-gray-200 truncate">
          {(businessName || 'yourbusiness').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.{getPlatformDomain()}
        </div>
      </div>

      <div style={{ ...cv, backgroundColor: 'var(--theme-bg)', color: 'var(--theme-text)', fontFamily: 'var(--font-body)' }}>

        {/* ── Top info bar (Medixi-style) ── */}
        {content.showTopBar !== false && (pvShowTopEmail || pvShowTopPhone || pvShowTopAddress || pvShowTopHours || socials.length > 0) && (
          <div className="flex items-center justify-between gap-2 overflow-hidden px-3 py-1" style={{ backgroundColor: isDark ? 'var(--theme-surface)' : '#f8fafc', borderBottom: '1px solid var(--theme-border)' }}>
            <div className="flex min-w-0 items-center gap-2 overflow-hidden" style={{ fontSize: '7px', color: 'var(--theme-muted)' }}>
              {pvShowTopEmail && <span className="truncate">Mail {pvEmail}</span>}
              {pvShowTopPhone && <span className="truncate">Phone {pvPhone}</span>}
              {pvShowTopAddress && <span className="truncate">Place {pvAddress}</span>}
              {pvShowTopHours && <span className="truncate">Hours {content.businessHoursText}</span>}
            </div>
            {socials.length > 0 && (
              <div className="flex shrink-0 gap-1">
                {socials.map((s, i) => (
                  <span key={i} className="w-3 h-3 rounded-full flex items-center justify-center" style={{ backgroundColor: s.color, color: '#fff' }}>
                    <svg className="w-2 h-2" viewBox="0 0 24 24" fill="currentColor"><path d={s.path} /></svg>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Navbar ── */}
        <div className="flex items-center justify-between gap-2 overflow-hidden px-3 py-2 border-b" style={{ backgroundColor: isDark ? 'var(--theme-surface)' : '#fff', borderColor: 'var(--theme-border)' }}>
          <div className="flex min-w-0 items-center gap-1.5">
            {pvShowLogo && (
              logoUrl ? (
                <img
                  src={logoUrl}
                  alt=""
                  className="h-6 shrink-0 rounded object-contain"
                  style={{ width: Math.min(24 * logoAspectRatio(content.logoAspect), 96) }}
                />
              ) : (
                <span className="w-6 h-6 shrink-0 rounded flex items-center justify-center font-bold" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)', fontSize: '9px' }}>{initial}</span>
              )
            )}
            <div className="min-w-0">
              {pvShowBusinessName && (
                <span className="block truncate font-bold" style={{ color: 'var(--theme-text)', fontFamily: 'var(--font-heading)', fontSize: '10px' }}>{pvDisplayName}</span>
              )}
              {pvShowTagline && tagline && <span className="block truncate" style={{ color: 'var(--theme-muted)', fontSize: '7px' }}>{tagline}</span>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <div className="hidden gap-2 sm:flex sm:flex-wrap" style={{ fontSize: '7px', color: 'var(--theme-muted)' }}>
              {navLinks.map((label, i) => <span key={i}>{label}</span>)}
            </div>
            <span className="px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)', fontSize: '6px' }}>{ctaText}</span>
            <span className="grid h-4 w-4 place-items-center rounded border" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)' }}>
              <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" /></svg>
            </span>
          </div>
        </div>

        {/* ── Hero banner ── */}
        {content.showHero !== false && (
        <div className="relative" style={{ minHeight: '120px' }}>
          {bannerUrl ? (
            <div className="relative">
              <img src={bannerUrl} alt="" className="w-full h-32 object-cover" style={heroBannerStyle} />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(0,0,0,0.65) 50%, rgba(0,0,0,0.2) 100%)' }}>
                <div className="p-4 h-full flex flex-col justify-center" style={{ maxWidth: '60%' }}>
                  <InlineEditable field="heroHeadline" value={headline} onEdit={onEdit}
                    className="block font-bold text-white leading-tight mb-1"
                    style={{ fontFamily: 'var(--font-heading)', fontSize: '13px' }} />
                  <InlineEditable field="heroSubheading" value={subheading} onEdit={onEdit} multiline
                    className="block text-white/80 leading-relaxed mb-1" style={{ fontSize: '7px' }} />
                  {heroLine3 && (
                    <InlineEditable field="heroLine3" value={heroLine3} onEdit={onEdit} multiline
                      className="block text-white/60" style={{ fontSize: '6px' }} />
                  )}
                  <div className="mt-2">
                    <span className="inline-block px-2 py-1 rounded font-bold" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)', fontSize: '7px' }}>{ctaText}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="px-4 py-8 relative" style={{ backgroundColor: isDark ? 'var(--theme-surface)' : 'var(--theme-bg)' }}>
              {isDark && <div className="absolute inset-0 opacity-15" style={{ background: `radial-gradient(ellipse at 20% 50%, var(--theme-primary), transparent 70%)` }} />}
              <div className="relative">
                {isDark && <div className="w-0.5 h-6 rounded-full mb-1.5" style={{ backgroundColor: 'var(--theme-primary)' }} />}
                <InlineEditable field="heroHeadline" value={headline} onEdit={onEdit}
                  className="block font-bold leading-tight mb-1"
                  style={{ fontFamily: 'var(--font-heading)', color: 'var(--theme-text)', fontSize: '13px' }} />
                <InlineEditable field="heroSubheading" value={subheading} onEdit={onEdit} multiline
                  className="block leading-relaxed mb-1" style={{ color: 'var(--theme-muted)', fontSize: '7px', maxWidth: '70%' }} />
                {heroLine3 && (
                  <InlineEditable field="heroLine3" value={heroLine3} onEdit={onEdit} multiline
                    className="block" style={{ color: 'var(--theme-muted)', fontSize: '6px', opacity: 0.7 }} />
                )}
                <div className="mt-2 flex gap-1.5">
                  <span className="px-2 py-1 rounded font-bold" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)', fontSize: '7px' }}>{ctaText} →</span>
                  <span className="px-2 py-1 rounded border" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)', fontSize: '7px' }}>Learn more</span>
                </div>
              </div>
            </div>
          )}
        </div>
        )}

        {/* ── Reorderable sections ── */}
        {resolveSectionOrder(content.sectionOrder, vertical).map((key) => {
          if (key === 'stats' && showStats && statsItems.length > 0) {
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="grid grid-cols-4 gap-2 px-3 py-2 border-t border-b" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
                {statsItems.map((s, i) => (
                  <div key={i} className="text-center">
                    <div className="font-bold" style={{ color: 'var(--theme-primary)', fontFamily: 'var(--font-heading)', fontSize: '11px' }}>{s.number}</div>
                    <div className="truncate" style={{ color: 'var(--theme-muted)', fontSize: '6px' }}>{s.label}</div>
                  </div>
                ))}
              </div>
            );
          }
          if (key === 'services' && showServices) {
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="px-3 py-3" style={{ backgroundColor: 'var(--theme-bg)' }}>
                {servicesImageUrl && (
                  <div className="rounded overflow-hidden mb-2" style={{ border: '1px solid var(--theme-border)' }}>
                    <img src={servicesImageUrl} alt="" className="w-full h-12 object-cover" style={servicesImageStyle} />
                  </div>
                )}
                <div className="uppercase font-bold tracking-wider mb-0.5" style={{ color: 'var(--theme-primary)', fontSize: '6px' }}>{servicesEyebrow}</div>
                <div className="font-bold mb-0.5" style={{ color: 'var(--theme-text)', fontSize: '9px', fontFamily: 'var(--font-heading)' }}>{servicesTitle}</div>
                {servicesIntro && <div className="mb-1" style={{ color: 'var(--theme-muted)', fontSize: '6px', lineHeight: 1.4 }}>{servicesIntro}</div>}
                <div className="grid grid-cols-3 gap-1.5 mt-1">
                  {(services.length > 0 ? services.slice(0, 3) : [{ name: 'Service 1' }, { name: 'Service 2' }, { name: 'Service 3' }]).map((s, i) => (
                    <div key={i} className="rounded overflow-hidden border flex flex-col" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
                      {s.imageUrl && (
                        <img src={s.imageUrl} alt={s.name} className="w-full h-8 object-cover" />
                      )}
                      <div className="p-1.5 flex-1">
                        <div className="font-bold truncate" style={{ fontSize: '7px', color: 'var(--theme-text)' }}>{s.name}</div>
                        {s.price !== undefined && s.price !== null && <div style={{ fontSize: '7px', color: 'var(--theme-primary)', fontWeight: 700 }}>${s.price}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (key === 'pricing' && content.showPricing === true) {
            const pricingEyebrow = content.pricingEyebrow?.trim() || 'Pricing';
            const pricingTitle = content.pricingTitle?.trim() || 'Choose a plan that fits you';
            let pricingTiersParsed = [];
            try { pricingTiersParsed = JSON.parse(content.pricingTiers || '[]'); if (!Array.isArray(pricingTiersParsed)) pricingTiersParsed = []; } catch { pricingTiersParsed = []; }
            const pvTiers = pricingTiersParsed.length > 0 ? pricingTiersParsed : [{ title: 'Starter', price: '', priceCaption: 'Contact for price', features: ['Feature 1', 'Feature 2'] }];
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="px-3 py-3" style={{ backgroundColor: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)' }}>
                <div className="uppercase font-bold tracking-wider mb-0.5 text-center" style={{ color: 'var(--theme-primary)', fontSize: '6px' }}>{pricingEyebrow}</div>
                <div className="font-bold mb-1 text-center" style={{ color: 'var(--theme-text)', fontSize: '9px', fontFamily: 'var(--font-heading)' }}>{pricingTitle}</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {pvTiers.slice(0, 3).map((tier, i) => (
                    <div key={i} className="rounded p-1.5 border" style={{ borderColor: tier.highlighted ? 'var(--theme-primary)' : 'var(--theme-border)', backgroundColor: 'var(--theme-surface)' }}>
                      <div className="font-bold truncate" style={{ fontSize: '7px', color: 'var(--theme-text)' }}>{tier.title || `Tier ${i + 1}`}</div>
                      <div style={{ fontSize: '8px', color: 'var(--theme-primary)', fontWeight: 700 }}>{tier.price ? (String(tier.price).startsWith('$') || String(tier.price).startsWith('₹') ? tier.price : `$${tier.price}`) : '—'}</div>
                      {(tier.features || []).slice(0, 2).map((f, fi) => (
                        <div key={fi} className="truncate" style={{ fontSize: '5px', color: 'var(--theme-muted)' }}>✓ {f}</div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          if (key === 'about' && showAbout) {
            const textCol = (
              <div>
                <div className="uppercase font-bold tracking-wider mb-0.5" style={{ color: 'var(--theme-primary)', fontSize: '6px' }}>{aboutEyebrow}</div>
                <InlineEditable field="aboutTitle" value={aboutTitle} onEdit={onEdit}
                  className="block font-bold mb-0.5" style={{ color: 'var(--theme-text)', fontSize: '9px', fontFamily: 'var(--font-heading)' }} />
                <InlineEditable field="aboutBody" value={aboutBody} onEdit={onEdit} multiline
                  className="block line-clamp-2 mb-1" style={{ color: 'var(--theme-muted)', fontSize: '7px', lineHeight: 1.4 }} />
                <ul className="space-y-0.5">
                  {aboutHighlightItems.slice(0, 3).map((h, i) => (
                    <li key={i} className="flex items-center gap-1 truncate" style={{ fontSize: '6px', color: 'var(--theme-text)' }}>
                      <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--theme-primary)' }} />
                      {h}
                    </li>
                  ))}
                </ul>
              </div>
            );
            const imgCol = aboutImageUrl ? (
              <img src={aboutImageUrl} alt="" className="w-full h-16 rounded object-cover" style={{ border: '1px solid var(--theme-border)', ...aboutImageStyle }} />
            ) : null;
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="px-3 py-3" style={{ backgroundColor: 'var(--theme-surface)', borderTop: '1px solid var(--theme-border)' }}>
                {aboutImageUrl ? (
                  <div className="grid grid-cols-2 gap-2 items-start">
                    {aboutImageOnLeft ? <>{imgCol}{textCol}</> : <>{textCol}{imgCol}</>}
                  </div>
                ) : textCol}
              </div>
            );
          }
          if (key === 'team' && showTeam) {
            // Preview must match the live website — only include staff with
            // showOnWebsite=true (the same filter tenant.controller.js applies).
            const publicStaff = staff.filter((s) => s.showOnWebsite !== false);
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="px-3 py-3 text-center" style={{ backgroundColor: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)' }}>
                <div className="uppercase font-bold tracking-wider mb-0.5" style={{ color: 'var(--theme-primary)', fontSize: '6px' }}>{teamEyebrow}</div>
                <div className="font-bold mb-0.5" style={{ color: 'var(--theme-text)', fontSize: '9px', fontFamily: 'var(--font-heading)' }}>{teamTitle}</div>
                {teamIntroText && <div className="mb-1" style={{ color: 'var(--theme-muted)', fontSize: '6px', lineHeight: 1.4 }}>{teamIntroText}</div>}
                {publicStaff.length === 0 ? (
                  <div className="mx-2 py-2 border-2 border-dashed rounded italic" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)', fontSize: '6px' }}>
                    {staff.length === 0
                      ? vertical === 'APPOINTMENT'
                        ? `Add ${staffLabelPreview.toLowerCase()} members in the Staff tab to see them here.`
                        : `Add ${staffLabelPreview.toLowerCase()} cards in the Team section editor to see them here.`
                      : `No ${staffLabelPreview.toLowerCase()} members are set to show on the website yet.`}
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-1.5">
                    {publicStaff.map((s, i) => (
                      <div key={i} className="rounded p-1 text-center border" style={{ backgroundColor: 'var(--theme-surface)', borderColor: 'var(--theme-border)' }}>
                        {s.avatarUrl ? (
                          <img src={s.avatarUrl} alt={s.name} className="w-5 h-5 mx-auto mb-0.5 rounded-full object-cover" />
                        ) : (
                          <div className="w-5 h-5 mx-auto mb-0.5 rounded-full flex items-center justify-center font-bold" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)', fontSize: '7px' }}>{(s.name || '?').charAt(0)}</div>
                        )}
                        <div className="truncate" style={{ fontSize: '6px', color: 'var(--theme-text)' }}>{s.name}</div>
                        <div className="truncate" style={{ fontSize: '5px', color: 'var(--theme-muted)' }}>{teamMemberSubtitle}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (key === 'gallery' && showGallery) {
            const items = parsedGalleryItems.slice(0, 6);
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="px-3 py-3" style={{ backgroundColor: 'var(--theme-surface)', borderTop: '1px solid var(--theme-border)' }}>
                <div className="uppercase font-bold tracking-wider mb-0.5 text-center" style={{ color: 'var(--theme-primary)', fontSize: '6px' }}>{galleryEyebrow}</div>
                <div className="font-bold mb-1 text-center" style={{ color: 'var(--theme-text)', fontSize: '9px', fontFamily: 'var(--font-heading)' }}>{galleryTitle}</div>
                {gallerySub && <div className="text-center mb-1.5" style={{ color: 'var(--theme-muted)', fontSize: '6px' }}>{gallerySub}</div>}
                {items.length === 0 ? (
                  <div className="mx-2 py-2 border-2 border-dashed rounded italic text-center" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)', fontSize: '6px' }}>
                    Add gallery images in the Gallery tab.
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-1">
                    {items.map((it, i) => (
                      <div key={i} className="aspect-[4/3] rounded overflow-hidden" style={{ backgroundColor: 'var(--theme-border)' }}>
                        {it.image && <img src={it.image} alt={it.caption || ''} className="w-full h-full object-cover" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (key === 'testimonials' && showTestimonials) {
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="px-3 py-3" style={{ backgroundColor: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)' }}>
                <div className="uppercase font-bold tracking-wider mb-0.5 text-center" style={{ color: 'var(--theme-primary)', fontSize: '6px' }}>{testimonialsEyebrow}</div>
                <div className="font-bold mb-1 text-center" style={{ color: 'var(--theme-text)', fontSize: '9px', fontFamily: 'var(--font-heading)' }}>{testimonialsTitle}</div>
                {testimonials.length === 0 ? (
                  <div className="mx-2 py-2 border-2 border-dashed rounded italic text-center" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)', fontSize: '6px' }}>
                    Add reviews in the Testimonials tab to see them here.
                  </div>
                ) : (
                <div className="grid grid-cols-2 gap-1.5">
                  {testimonials.slice(0, 2).map((t, i) => (
                    <div key={i} className="rounded p-1.5 border" style={{ borderColor: 'var(--theme-border)', backgroundColor: 'var(--theme-surface)' }}>
                      <div className="flex gap-0.5 mb-0.5">{[1, 2, 3, 4, 5].map((s) => <span key={s} style={{ color: s <= (t.rating || 5) ? '#f59e0b' : 'var(--theme-border)', fontSize: '6px' }}>★</span>)}</div>
                      <div className="line-clamp-2 italic" style={{ fontSize: '6px', color: 'var(--theme-text)' }}>&quot;{t.text}&quot;</div>
                      <div className="mt-0.5 flex items-center gap-1">
                        {t.avatarUrl ? (
                          <img src={t.avatarUrl} alt="" className="w-2.5 h-2.5 rounded-full object-cover" />
                        ) : (
                          <span className="w-2.5 h-2.5 rounded-full flex items-center justify-center font-bold" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)', fontSize: '5px' }}>{(t.name || 'A').charAt(0).toUpperCase()}</span>
                        )}
                        <span className="font-bold truncate" style={{ fontSize: '5px', color: 'var(--theme-muted)' }}>{t.name}</span>
                      </div>
                    </div>
                  ))}
                </div>
                )}
              </div>
            );
          }
          if (key === 'faq' && showFaq) {
            const items = parsedFaqItems.slice(0, 4);
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="px-3 py-3" style={{ backgroundColor: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)' }}>
                <div className="uppercase font-bold tracking-wider mb-0.5 text-center" style={{ color: 'var(--theme-primary)', fontSize: '6px' }}>{faqEyebrow}</div>
                <div className="font-bold mb-1 text-center" style={{ color: 'var(--theme-text)', fontSize: '9px', fontFamily: 'var(--font-heading)' }}>{faqTitle}</div>
                {faqIntro && <div className="text-center mb-1.5" style={{ color: 'var(--theme-muted)', fontSize: '6px' }}>{faqIntro}</div>}
                {items.length === 0 ? (
                  <div className="mx-2 py-2 border-2 border-dashed rounded italic text-center" style={{ borderColor: 'var(--theme-border)', color: 'var(--theme-muted)', fontSize: '6px' }}>
                    Add questions in the FAQ tab.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {items.map((it, i) => (
                      <div key={i} className="rounded p-1.5 border" style={{ borderColor: 'var(--theme-border)', backgroundColor: 'var(--theme-surface)' }}>
                        <div className="flex items-start justify-between gap-1">
                          <div className="font-bold flex-1" style={{ fontSize: '6px', color: 'var(--theme-text)' }}>{it.q || '—'}</div>
                          <span style={{ fontSize: '7px', color: 'var(--theme-primary)' }}>{i === 0 ? '−' : '+'}</span>
                        </div>
                        {i === 0 && it.a && (
                          <div className="mt-0.5 line-clamp-2" style={{ fontSize: '5.5px', color: 'var(--theme-muted)', lineHeight: 1.4 }}>{it.a}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (key === 'contact' && showContact) {
            const cardTitle = content.contactCardTitle?.trim() || 'Quick Appointment';
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="px-3 py-3 grid grid-cols-2 gap-2" style={{ backgroundColor: 'var(--theme-surface)', borderTop: '1px solid var(--theme-border)' }}>
                <div>
                  <div className="uppercase font-bold tracking-wider mb-0.5" style={{ color: 'var(--theme-primary)', fontSize: '6px' }}>{contactEyebrow}</div>
                  <InlineEditable field="contactTitle" value={contactTitle} onEdit={onEdit}
                    className="block font-bold mb-0.5" style={{ color: 'var(--theme-text)', fontSize: '9px', fontFamily: 'var(--font-heading)' }} />
                  <div className="line-clamp-2" style={{ color: 'var(--theme-muted)', fontSize: '6px', lineHeight: 1.4 }}>{contactBodyText}</div>
                </div>
                <div className="rounded p-1.5 border" style={{ borderColor: 'var(--theme-border)', backgroundColor: 'var(--theme-bg)' }}>
                  <div className="font-bold mb-0.5" style={{ color: 'var(--theme-text)', fontSize: '7px', fontFamily: 'var(--font-heading)' }}>{cardTitle}</div>
                  <span className="inline-block px-1.5 py-0.5 rounded font-bold mt-0.5" style={{ backgroundColor: 'var(--theme-primary)', color: 'var(--theme-on-primary)', fontSize: '6px' }}>{ctaText}</span>
                </div>
              </div>
            );
          }
          if (key === 'cta' && showCta) {
            return (
              <div key={key} data-ae-section={key} data-ae-selected={selectedKey === key || undefined} className="relative overflow-hidden px-3 py-4 text-center" style={{ backgroundColor: 'var(--theme-primary)' }}>
                {ctaBackgroundUrl && (
                  <div className="absolute inset-0">
                    <img src={ctaBackgroundUrl} alt="" className="w-full h-full object-cover" style={ctaBgStyle} />
                    <div className="absolute inset-0" style={{ backgroundColor: 'var(--theme-primary)', opacity: 0.8 }} />
                  </div>
                )}
                <div className="relative">
                  <InlineEditable field="ctaHeadline" value={ctaHeadlineText} onEdit={onEdit}
                    className="block font-bold text-white mb-0.5" style={{ fontSize: '9px', fontFamily: 'var(--font-heading)' }} />
                  <div className="text-white/80 mb-1" style={{ fontSize: '6px' }}>{ctaBodyText}</div>
                  <span className="inline-block px-2 py-0.5 rounded font-bold" style={{ backgroundColor: '#fff', color: 'var(--theme-primary)', fontSize: '6px' }}>{ctaText} →</span>
                </div>
              </div>
            );
          }
          return null;
        })}

        {/* ── Footer ── */}
        {showFooter && (
          <div className="px-3 py-3" style={{ backgroundColor: 'color-mix(in srgb, var(--theme-text) 95%, var(--theme-bg))' }}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="font-bold" style={{ color: 'var(--theme-on-primary)', fontSize: '8px' }}>{pvDisplayName}</span>
            </div>
            {footerDescription && (
              <div className="line-clamp-2" style={{ fontSize: '5px', color: 'rgba(255,255,255,0.5)' }}>{footerDescription}</div>
            )}
            <div className="flex gap-2 mt-1" style={{ fontSize: '5px', color: 'rgba(255,255,255,0.5)' }}>
              {content.showFooterQuickLinks !== false && <span>{content.footerLinkBookLabel?.trim() || 'Book'}</span>}
              {content.showFooterQuickLinks !== false && <span>{content.footerLinkAboutLabel?.trim() || 'About'}</span>}
              {content.showFooterContact !== false && business.phone && <span>{business.phone}</span>}
            </div>
            <div className="mt-1 pt-0.5 border-t truncate" style={{ borderColor: 'rgba(255,255,255,0.15)', fontSize: '5px', color: 'rgba(255,255,255,0.3)' }}>
              {footerCopyright}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Shared UI components
// ============================================================================
function TabHeader({ title, desc }) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="text-sm text-gray-500 mt-0.5">{desc}</p>
    </div>
  );
}

function NavItem({ active, icon, label, onClick, show, onToggleShow }) {
  return (
    <div className={`flex items-center gap-1 px-3 py-2 rounded-lg transition-colors ${active ? 'bg-indigo-600 text-white shadow-sm' : 'hover:bg-gray-100'}`}>
      <button onClick={onClick}
        className={`flex-1 flex items-center gap-2 text-sm font-medium text-left ${active ? 'text-white' : 'text-gray-700'} ${show === false ? 'opacity-50' : ''}`}>
        <span className="text-base leading-none">{icon}</span>
        <span className="truncate">{label}</span>
      </button>
      {onToggleShow && (
        <span onClick={(e) => e.stopPropagation()} className="flex-shrink-0">
          <MiniToggle checked={show !== false} onChange={onToggleShow} active={active} />
        </span>
      )}
    </div>
  );
}

function SortableSectionNavItem({ id, label, active, show, onSelect, onToggleShow }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 'auto',
  };
  return (
    <div ref={setNodeRef} style={style} className={`group flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors ${active ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white hover:bg-gray-100'} ${isDragging ? 'shadow-lg ring-2 ring-indigo-400' : ''}`}>
      <button
        {...attributes}
        {...listeners}
        className={`flex-shrink-0 w-5 h-6 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none ${active ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-gray-600'}`}
        title="Drag to reorder"
        aria-label="Drag handle"
      >
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="3" r="1.5" /><circle cx="11" cy="3" r="1.5" /><circle cx="5" cy="8" r="1.5" /><circle cx="11" cy="8" r="1.5" /><circle cx="5" cy="13" r="1.5" /><circle cx="11" cy="13" r="1.5" /></svg>
      </button>
      <button onClick={onSelect} className={`flex-1 text-left text-sm font-medium truncate ${active ? 'text-white' : 'text-gray-700'} ${!show ? 'opacity-50' : ''}`}>
        {label}
      </button>
      <span onClick={(e) => e.stopPropagation()} className="ml-1 flex-shrink-0">
        <MiniToggle checked={show} onChange={onToggleShow} active={active} />
      </span>
    </div>
  );
}

function MiniToggle({ checked, onChange, active }) {
  return (
    <label className="relative inline-block cursor-pointer" style={{ width: 28, height: 16 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <div className={`w-7 h-4 rounded-full transition-colors ${checked ? (active ? 'bg-white' : 'bg-emerald-500') : (active ? 'bg-white/30' : 'bg-gray-300')}`} />
      <div className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full transition-transform ${checked ? 'translate-x-3' : ''} ${checked && active ? 'bg-indigo-600' : 'bg-white'}`} />
    </label>
  );
}

// ============================================================================
// Horizontal section tabs — used in the Row 2 strip directly below the top bar
// ============================================================================

// Shared six-dot glyph. Kept visual-only on fixed items (no drag listeners).
// Six-dot drag handle. Always visible. The hit zone is the full button
// width so a plain click anywhere on the handle selects the tab (via
// onClick), while a sustained drag triggers reorder. On fixed items
// (no drag) we render a non-interactive SVG that still selects the tab
// when clicked — the whole row is clickable except the toggle.
function SixDotHandle({ active, dragProps = null, onClick }) {
  const dotColor = active ? 'rgba(255,255,255,0.8)' : 'var(--ae-muted)';
  const dots = (
    <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="5" cy="4" r="1.2" /><circle cx="11" cy="4" r="1.2" />
      <circle cx="5" cy="8" r="1.2" /><circle cx="11" cy="8" r="1.2" />
      <circle cx="5" cy="12" r="1.2" /><circle cx="11" cy="12" r="1.2" />
    </svg>
  );
  if (!dragProps) {
    return (
      <span
        onClick={onClick}
        className={`flex-shrink-0 w-5 h-full flex items-center justify-center ${onClick ? 'cursor-pointer' : ''}`}
        style={{ color: dotColor }}
        aria-hidden="true"
      >
        {dots}
      </span>
    );
  }
  return (
    <button
      type="button"
      {...dragProps}
      onClick={onClick}
      className="flex-shrink-0 w-6 h-full flex items-center justify-center touch-none cursor-grab active:cursor-grabbing"
      style={{ color: dotColor }}
      title="Drag to reorder · click to open"
      aria-label="Drag handle"
    >
      {dots}
    </button>
  );
}

// Editable tab label — click to rename. Commits on Enter or blur;
// Esc cancels. Empty values fall back to the default label.
function EditableTabLabel({ value, defaultLabel, active, onChange, onClick, disabled }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!editing) setDraft(value || '');
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function commit() {
    const next = draft.trim();
    if (next !== (value || '').trim() && onChange) onChange(next || null);
    setEditing(false);
  }
  function cancel() {
    setDraft(value || '');
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter')  { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        placeholder={defaultLabel}
        className="py-1.5 px-1 text-[12px] font-medium bg-transparent outline-none whitespace-nowrap min-w-[90px]"
        style={{
          color: active ? '#fff' : 'var(--ae-ink)',
          borderBottom: `1px dashed ${active ? 'rgba(255,255,255,0.6)' : 'var(--ae-indigo)'}`,
        }}
      />
    );
  }

  return (
    <button
      onClick={onClick}
      onDoubleClick={disabled ? undefined : () => setEditing(true)}
      className="py-1.5 text-[12px] font-medium whitespace-nowrap"
      style={{ color: active ? '#fff' : 'var(--ae-ink)' }}
      title={disabled ? undefined : 'Double-click to rename'}
    >
      {(value && value.trim()) || defaultLabel}
    </button>
  );
}

function HorizontalNavItem({ label, labelOverride, onLabelChange, active, show = true, onToggleShow, onClick }) {
  return (
    <div
      className="group flex items-center gap-1 h-8 rounded-[8px] flex-shrink-0 transition-colors"
      style={{
        background: active ? 'var(--ae-indigo)' : 'var(--ae-card)',
        border: active ? 'none' : '1px solid var(--ae-line)',
        opacity: show ? 1 : 0.55,
      }}
    >
      <SixDotHandle active={active} onClick={onClick} />
      <EditableTabLabel
        value={labelOverride}
        defaultLabel={label}
        active={active}
        onClick={onClick}
        onChange={onLabelChange}
        disabled={!onLabelChange}
      />
      {onToggleShow ? (
        <span onClick={(e) => e.stopPropagation()} className="flex items-center pr-1.5 flex-shrink-0">
          <MiniToggle checked={show} onChange={onToggleShow} active={active} />
        </span>
      ) : (
        <span className="pr-2 flex-shrink-0" />
      )}
    </div>
  );
}

function SortableHorizontalNavItem({ id, label, labelOverride, onLabelChange, active, show, onSelect, onToggleShow }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 'auto',
  };
  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        background: active ? 'var(--ae-indigo)' : 'var(--ae-card)',
        border: active ? 'none' : '1px solid var(--ae-line)',
      }}
      className="group flex items-center gap-1 h-8 rounded-[8px] flex-shrink-0 transition-colors"
    >
      <SixDotHandle active={active} dragProps={{ ...attributes, ...listeners }} onClick={onSelect} />
      <EditableTabLabel
        value={labelOverride}
        defaultLabel={label}
        active={active}
        onClick={onSelect}
        onChange={onLabelChange}
      />
      <span onClick={(e) => e.stopPropagation()} className="flex items-center pr-1.5 flex-shrink-0">
        <MiniToggle checked={show} onChange={onToggleShow} active={active} />
      </span>
    </div>
  );
}

function SectionStateBanner({ show }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border ${show ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
      <span className={`w-2 h-2 rounded-full ${show ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      {show ? 'This section is visible on your website' : 'This section is hidden — toggle it on in the left rail'}
    </div>
  );
}

function HeroImageFrameGuide({ guidance }) {
  if (!guidance) return null;
  return (
    <div className="mb-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-gray-800">{guidance.label}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-gray-500">{guidance.hint}</p>
        </div>
        <div className="shrink-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-right">
          <p className="text-[10px] font-semibold uppercase text-gray-400">Live frame</p>
          <p className="text-[11px] font-semibold text-gray-800">{guidance.frameName}</p>
        </div>
      </div>
      {guidance.usesImage && (
        <p className="mt-2 text-[11px] leading-snug text-gray-500">{guidance.helper}</p>
      )}
    </div>
  );
}

function HeroImageNotUsed({ value, onRemove }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="text-xs font-medium text-amber-900">This selected hero layout is text-first, so a hero image will not appear on the live site.</p>
      {value && (
        <button
          type="button"
          onClick={onRemove}
          className="mt-2 text-xs font-semibold text-amber-900 underline underline-offset-2"
        >
          Remove saved hero image
        </button>
      )}
    </div>
  );
}

function InfoNote({ children }) {
  return (
    <div className="px-3 py-2 rounded-lg bg-sky-50 border border-sky-200 text-xs text-sky-900">
      ℹ️ {children}
    </div>
  );
}


// Edit + delete icon pair placed absolutely at the top-right of any image
// preview. Parent must be `relative`. `size` controls the icon footprint
// so it fits equally well on a tiny avatar or a full-width banner.
function ImageActions({ onEdit, onRemove, size = 'md', className = '' }) {
  const sizeCls = size === 'xs' ? 'w-5 h-5' : size === 'sm' ? 'w-6 h-6' : 'w-7 h-7';
  const iconCls = size === 'xs' ? 'w-2.5 h-2.5' : size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const strokeW = size === 'xs' ? 2 : 1.8;
  return (
    <div className={`absolute top-1.5 right-1.5 flex gap-1 z-10 ${className}`}>
      {onEdit && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(); }}
          title="Edit image"
          aria-label="Edit image"
          className={`${sizeCls} bg-white/95 hover:bg-white text-gray-700 rounded-full flex items-center justify-center shadow-md transition-colors`}
        >
          <svg className={iconCls} fill="none" stroke="currentColor" strokeWidth={strokeW} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
          </svg>
        </button>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
          title="Remove image"
          aria-label="Remove image"
          className={`${sizeCls} bg-white/95 hover:bg-red-50 text-red-600 rounded-full flex items-center justify-center shadow-md transition-colors`}
        >
          <svg className={iconCls} fill="none" stroke="currentColor" strokeWidth={strokeW} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166M4.772 5.79L3.75 5.957m0 0a48.108 48.108 0 013.478-.397M19.228 5.79L20.25 5.957m0 0a48.108 48.108 0 00-3.478-.397m-12 .562a48.08 48.08 0 0112 0" />
          </svg>
        </button>
      )}
    </div>
  );
}

function ImageUploader({ value, onChange, onUpload, onEdit, gallery, position, stockImages: stockImagesOverride, previewAspect = '16 / 9', previewMaxWidth = null }) {
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [posOpen, setPosOpen] = useState(false);
  const stockImages = stockImagesOverride || (gallery ? STOCK_IMAGES[gallery] || [] : []);
  const posX = position?.x ?? 50;
  const posY = position?.y ?? 50;
  const zoom = position?.zoom ?? 100;
  const previewStyle = {
    objectPosition: `${posX}% ${posY}%`,
    transform: zoom !== 100 ? `scale(${zoom / 100})` : undefined,
    transformOrigin: `${posX}% ${posY}%`,
  };
  const frameStyle = {
    aspectRatio: previewAspect || '16 / 9',
    maxWidth: previewMaxWidth ? `${previewMaxWidth}px` : undefined,
  };
  const frameClass = previewMaxWidth ? 'mx-auto w-full' : 'w-full';

  return (
    <div className="space-y-2">
      {value ? (
        <div className={`relative rounded-lg overflow-hidden border border-gray-200 bg-gray-100 ${frameClass}`} style={frameStyle}>
          <img src={value} alt="" className="absolute inset-0 h-full w-full object-cover" style={previewStyle} />
          <ImageActions
            onEdit={onEdit}
            onRemove={() => onChange('')}
          />
        </div>
      ) : (
        <label className={`cursor-pointer flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-lg hover:border-indigo-400 hover:bg-indigo-50/50 transition-colors ${frameClass}`} style={frameStyle}>
          <svg className="w-8 h-8 text-gray-400 mb-1" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
          </svg>
          <span className="text-sm font-medium text-gray-500">Click to upload</span>
          <span className="text-xs text-gray-400 mt-0.5">or drag and drop</span>
          <input type="file" accept="image/*" className="hidden" onChange={onUpload} />
        </label>
      )}

      {value && position && (
        <div>
          <button type="button" onClick={() => setPosOpen(!posOpen)}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1">
            {posOpen ? 'Hide' : 'Adjust'} image position &amp; zoom
            <svg className={`w-3 h-3 transition-transform ${posOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {posOpen && (
            <div className="mt-2 p-3 rounded-lg border border-gray-200 bg-gray-50 space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <button type="button" onClick={() => position.onChange({ x: 50, y: Math.max(0, posY - 10), zoom })}
                  className="col-start-2 py-1 text-xs rounded bg-white border border-gray-300 hover:bg-indigo-50">↑ Up</button>
                <button type="button" onClick={() => position.onChange({ x: Math.max(0, posX - 10), y: posY, zoom })}
                  className="py-1 text-xs rounded bg-white border border-gray-300 hover:bg-indigo-50">← Left</button>
                <button type="button" onClick={() => position.onChange({ x: 50, y: 50, zoom: 100 })}
                  className="py-1 text-xs rounded bg-white border border-gray-300 hover:bg-indigo-50 font-medium">Reset</button>
                <button type="button" onClick={() => position.onChange({ x: Math.min(100, posX + 10), y: posY, zoom })}
                  className="py-1 text-xs rounded bg-white border border-gray-300 hover:bg-indigo-50">Right →</button>
                <button type="button" onClick={() => position.onChange({ x: posX, y: Math.min(100, posY + 10), zoom })}
                  className="col-start-2 py-1 text-xs rounded bg-white border border-gray-300 hover:bg-indigo-50">↓ Down</button>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-gray-700">Horizontal ({posX}%)</label>
                </div>
                <input type="range" min="0" max="100" value={posX} onChange={(e) => position.onChange({ x: Number(e.target.value), y: posY, zoom })} className="w-full" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-gray-700">Vertical ({posY}%)</label>
                </div>
                <input type="range" min="0" max="100" value={posY} onChange={(e) => position.onChange({ x: posX, y: Number(e.target.value), zoom })} className="w-full" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-gray-700">Zoom ({zoom}%)</label>
                  <div className="flex gap-1">
                    <button type="button" onClick={() => position.onChange({ x: posX, y: posY, zoom: Math.max(100, zoom - 10) })}
                      className="px-2 py-0.5 text-xs rounded bg-white border border-gray-300 hover:bg-indigo-50">−</button>
                    <button type="button" onClick={() => position.onChange({ x: posX, y: posY, zoom: Math.min(300, zoom + 10) })}
                      className="px-2 py-0.5 text-xs rounded bg-white border border-gray-300 hover:bg-indigo-50">+</button>
                  </div>
                </div>
                <input type="range" min="100" max="300" value={zoom} onChange={(e) => position.onChange({ x: posX, y: posY, zoom: Number(e.target.value) })} className="w-full" />
              </div>
            </div>
          )}
        </div>
      )}

      {stockImages.length > 0 && (
        <div>
          <button type="button" onClick={() => setGalleryOpen(!galleryOpen)}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1">
            {galleryOpen ? 'Hide' : 'Or pick from'} stock gallery
            <svg className={`w-3 h-3 transition-transform ${galleryOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {galleryOpen && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              {stockImages.map((url) => (
                <button key={url} type="button" onClick={() => { onChange(url); setGalleryOpen(false); }}
                  className="group relative rounded-lg overflow-hidden border border-gray-200 hover:border-indigo-400 hover:ring-2 hover:ring-indigo-200 transition-all">
                  <img src={url} alt="" className="w-full object-cover" style={{ aspectRatio: previewAspect || '16 / 9' }} loading="lazy" />
                  <div className="absolute inset-0 bg-indigo-600/0 group-hover:bg-indigo-600/20 flex items-end justify-center opacity-0 group-hover:opacity-100 transition-opacity pb-1">
                    <span className="text-[10px] font-semibold text-white bg-indigo-600 px-2 py-0.5 rounded">Use</span>
                  </div>
                </button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-gray-400 mt-1">Free stock images — good for placeholders until you upload your own.</p>
        </div>
      )}
    </div>
  );
}

function InlineEditable({ field, value, onEdit, multiline, className, style }) {
  const ref = useRef(null);
  const [editing, setEditing] = useState(false);

  function commit() {
    const next = ref.current?.innerText?.trim() ?? '';
    if (next !== (value || '').trim() && onEdit) {
      onEdit(field, next);
    }
    setEditing(false);
  }

  function cancel() {
    if (ref.current) ref.current.innerText = value || '';
    setEditing(false);
    ref.current?.blur();
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !multiline) {
      e.preventDefault();
      ref.current?.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  if (!onEdit) {
    return <span className={className} style={style}>{value}</span>;
  }

  return (
    <span
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      className={`${className || ''} outline-none rounded transition-colors ${editing ? 'ring-1 ring-indigo-500 bg-white/80' : 'hover:bg-indigo-100/40'}`}
      style={{ cursor: 'text', ...style }}
      title="Click to edit"
    >
      {value}
    </span>
  );
}

function TestimonialAvatarUploader({ value, name, onChange, openImageAdjust }) {
  function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { alert('Avatar must be under 10MB'); return; }
    const inputEl = e.target;
    if (typeof openImageAdjust !== 'function') return;
    openImageAdjust({
      file,
      aspect: 1,
      maxWidth: 400,
      quality: 0.88,
      frameLabel: `Adjust avatar${name ? ` · ${name}` : ''}`,
      uploadScope: 'avatar',
      onConfirm: (value) => { onChange(value); try { inputEl.value = ''; } catch {} },
      onCancel:  () => { try { inputEl.value = ''; } catch {} },
    });
  }

  function handleEdit() {
    if (!value || typeof openImageAdjust !== 'function') return;
    openImageAdjust({
      initialSrc: value,
      aspect: 1,
      maxWidth: 400,
      quality: 0.88,
      frameLabel: `Adjust avatar${name ? ` · ${name}` : ''}`,
      uploadScope: 'avatar',
      onConfirm: (v) => onChange(v),
    });
  }

  if (value) {
    return (
      <div className="relative w-14 h-14">
        <img src={value} alt={name || 'Avatar'} className="w-full h-full object-cover rounded-full border-2 border-gray-200" />
        <ImageActions
          onEdit={handleEdit}
          onRemove={() => onChange('')}
          size="xs"
          className="top-0 right-0"
        />
      </div>
    );
  }

  return (
    <label className="block w-14 h-14 rounded-full cursor-pointer relative overflow-hidden border-2 border-dashed border-gray-300 hover:border-indigo-400 transition-colors">
      <div className="w-full h-full flex items-center justify-center bg-gray-100 text-gray-400 text-xs font-semibold">
        {(name || 'A').charAt(0).toUpperCase()}
      </div>
      <input type="file" accept="image/*" className="hidden" onChange={handleUpload} />
    </label>
  );
}

const PRICING_TEMPLATE_TIERS = [
  { title: 'Discovery', description: 'A first conversation or assessment to confirm fit, timing, scope and next steps.', price: 'By enquiry', priceCaption: '', badge: '', features: ['Fit and scope check', 'Timing and preparation notes', 'Recommended next step'], ctaLabel: 'Send enquiry', highlighted: false },
  { title: 'Core Service', description: 'The main service or package most visitors are comparing before they contact you.', price: 'From', priceCaption: 'confirmed after review', badge: 'Popular', features: ['Clear inclusions', 'Preparation guidance', 'Follow-up expectations'], ctaLabel: 'Ask about this option', highlighted: true },
  { title: 'Ongoing Support', description: 'Retainer, membership, maintenance or repeat support for clients who need continuity.', price: 'Custom', priceCaption: 'by scope', badge: '', features: ['Review rhythm', 'Priority context', 'Ongoing support path'], ctaLabel: 'Discuss support', highlighted: false },
];

function PricingTiersEditor({ value, onChange }) {
  const tiers = (() => {
    try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  })();

  function save(next) { onChange(JSON.stringify(next)); }
  function setTier(i, patch) { const n = [...tiers]; n[i] = { ...n[i], ...patch }; save(n); }
  function remove(i) { const n = [...tiers]; n.splice(i, 1); save(n); }
  function add() {
    if (tiers.length >= 6) return;
    save([...tiers, { title: '', price: '', priceCaption: '', badge: '', description: '', features: [], ctaLabel: '', highlighted: false }]);
  }
  function seedTemplate() { save(PRICING_TEMPLATE_TIERS); }

  function setFeature(tierIdx, featIdx, v) {
    const feats = [...(tiers[tierIdx].features || [])];
    feats[featIdx] = v;
    setTier(tierIdx, { features: feats });
  }
  function addFeature(tierIdx) {
    const feats = [...(tiers[tierIdx].features || []), ''];
    setTier(tierIdx, { features: feats });
  }
  function removeFeature(tierIdx, featIdx) {
    const feats = [...(tiers[tierIdx].features || [])];
    feats.splice(featIdx, 1);
    setTier(tierIdx, { features: feats });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-500">{tiers.length}/6 pricing tiers</p>
        {tiers.length < 6 && (
          <button onClick={add} className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            + Add tier
          </button>
        )}
      </div>
      {tiers.length === 0 && (
        <div className="py-6 text-center border border-dashed border-gray-300 rounded-lg space-y-3">
          <p className="text-xs text-gray-500 italic">
            No tiers yet. Add your own packages, or seed a neutral business package template and edit it for this industry.
          </p>
          <div className="flex items-center justify-center gap-2">
            <button type="button" onClick={seedTemplate}
              className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
              Use package template
            </button>
            <button type="button" onClick={add}
              className="px-3 py-1.5 text-xs font-semibold border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
              Start from blank
            </button>
          </div>
        </div>
      )}
      <div className="space-y-3">
        {tiers.map((tier, i) => (
          <div key={i} className="border border-gray-200 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500">Tier #{i + 1}{tier.highlighted ? ' · featured' : ''}</span>
              <button onClick={() => remove(i)} className="text-xs text-red-600 hover:underline">Remove</button>
            </div>
            <Input value={tier.title || ''} onChange={(v) => setTier(i, { title: v })} placeholder="e.g. Starter / Basic / Premium" max={40} />
            <div className="grid grid-cols-2 gap-2">
              <Input value={tier.price || ''} onChange={(v) => setTier(i, { price: v })} placeholder="Price e.g. $23 or NZ$23" max={30} />
              <Input value={tier.priceCaption || ''} onChange={(v) => setTier(i, { priceCaption: v })} placeholder="Caption e.g. /mo or forever" max={30} />
            </div>
            <Input value={tier.badge || ''} onChange={(v) => setTier(i, { badge: v })} placeholder="Badge (optional) e.g. Popular or Limited slots" max={40} />
            <Area value={tier.description || ''} onChange={(v) => setTier(i, { description: v })} placeholder="Short description of who this tier is for" max={200} rows={2} />
            <div>
              <p className="text-xs text-gray-500 mb-1">Features (bullet list)</p>
              <div className="space-y-1.5">
                {(tier.features || []).map((f, fi) => (
                  <div key={fi} className="flex items-center gap-2">
                    <Input value={f} onChange={(v) => setFeature(i, fi, v)} placeholder="e.g. Unlimited bookings" max={80} />
                    <button onClick={() => removeFeature(i, fi)} className="text-xs text-red-600 hover:underline flex-shrink-0">x</button>
                  </div>
                ))}
                <button type="button" onClick={() => addFeature(i)} className="text-xs text-indigo-600 hover:underline">+ Add feature</button>
              </div>
            </div>
            <Input value={tier.ctaLabel || ''} onChange={(v) => setTier(i, { ctaLabel: v })} placeholder="Button label (blank = use Home Banner CTA)" max={30} />
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={!!tier.highlighted} onChange={(e) => setTier(i, { highlighted: e.target.checked })} className="rounded" />
              <span>Highlight this tier (shows a &quot;Most popular&quot; badge)</span>
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

function HighlightsEditor({ value, onChange }) {
  const items = (() => {
    try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a.map((s) => String(s)) : []; } catch { return []; }
  })();

  function save(next) { onChange(JSON.stringify(next)); }
  function setItem(i, v) { const n = [...items]; n[i] = v; save(n); }
  function remove(i) { const n = [...items]; n.splice(i, 1); save(n); }
  function add() { if (items.length >= 6) return; save([...items, '']); }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-500">{items.length}/6 bullets</p>
        {items.length < 6 && (
          <button onClick={add} className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            + Add bullet
          </button>
        )}
      </div>
      {items.length === 0 && (
        <p className="text-xs text-gray-500 italic py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No custom bullets — default list will show on your site.
        </p>
      )}
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={it} onChange={(v) => setItem(i, v)} placeholder="e.g. Experienced professionals" max={80} />
            <button onClick={() => remove(i)} className="text-xs text-red-600 hover:underline flex-shrink-0">Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// JSON-array editor for the homepage Services cards. Decoupled from the
// booking-side Service[] table — edits here change what renders on the
// storefront homepage; price / duration / bookable services still live
// in the Services admin tab.
function ServicesCardsEditor({ value, vocab = {}, vertical = 'APPOINTMENT', builderProfile = null, openImageAdjust, onChange }) {
  const items = (() => {
    try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  })();
  const profileCopy = (key, fallback) => builderProfile?.copy?.[key] || fallback;
  const singular = profileCopy('serviceCardSingular', (vocab.services || 'service').toLowerCase().replace(/s$/, '') || 'service');
  const confirm = useConfirm();

  function emit(next) { onChange(next.length > 0 ? JSON.stringify(next) : ''); }
  function patchAt(i, patch) { emit(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it))); }
  // Inherit currency from existing cards so new cards default to the
  // business's local currency (set by the seed). Falls back to USD if
  // somehow nothing is seeded.
  const inheritedCurrency = items.find((it) => it && it.currency)?.currency || DEFAULT_CURRENCY;

  function addCard() {
    emit([...items, { name: `New ${singular}`, description: '', imageUrl: '', features: [], highlighted: false, price: '', priceCaption: 'from', duration: '', currency: inheritedCurrency }]);
  }
  async function removeAt(i) {
    if (!await confirm('Remove this card?', { confirmLabel: 'Remove', tone: 'danger' })) return;
    emit(items.filter((_, idx) => idx !== i));
  }
  function handleImageUpload(i, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert('Image must be under 15MB'); return; }
    const inputEl = e.target;
    if (typeof openImageAdjust !== 'function') return;
    openImageAdjust({
      file, aspect: 3 / 2, maxWidth: 1200, quality: 0.85,
      frameLabel: `Adjust ${singular} image`, uploadScope: 'service',
      onConfirm: (url) => { patchAt(i, { imageUrl: url }); try { inputEl.value = ''; } catch {} },
      onCancel: () => { try { inputEl.value = ''; } catch {} },
    });
  }
  function handleImageEdit(i, currentSrc) {
    if (!currentSrc || typeof openImageAdjust !== 'function') return;
    openImageAdjust({
      initialSrc: currentSrc, aspect: 3 / 2, maxWidth: 1200, quality: 0.85,
      frameLabel: `Adjust ${singular} image`, uploadScope: 'service',
      onConfirm: (url) => patchAt(i, { imageUrl: url }),
    });
  }

  const rowLabels = {
    highlight: profileCopy('serviceCardHighlightLabel', 'Most popular'),
    namePlaceholder: profileCopy('serviceCardNamePlaceholder', 'Service name'),
    descriptionPlaceholder: profileCopy('serviceCardDescriptionPlaceholder', 'Short description'),
    priceCaptionPlaceholder: profileCopy('serviceCardPriceCaptionPlaceholder', 'from'),
    pricePlaceholder: profileCopy('serviceCardPricePlaceholder', 'Price'),
    durationPlaceholder: profileCopy('serviceCardDurationPlaceholder', '30 min'),
    featuresPlaceholder: profileCopy('serviceCardFeaturesPlaceholder', 'Bullet features, one per line - optional'),
  };

  return (
    <div>
      {items.length === 0 ? (
        <p className="text-xs text-gray-500 italic py-6 text-center border border-dashed border-gray-300 rounded-lg mb-3">
          No {singular} cards yet. Click &ldquo;+ Add {singular}&rdquo; to create your first one.
        </p>
      ) : (
        <div className="space-y-3 mb-3">
          {items.map((s, i) => (
            <ServiceCardRow
              key={i}
              index={i}
              service={s}
              onPatch={(patch) => patchAt(i, patch)}
              onImageUpload={(e) => handleImageUpload(i, e)}
              onImageEdit={() => handleImageEdit(i, s.imageUrl)}
              onImageRemove={() => patchAt(i, { imageUrl: '' })}
              onRemove={() => removeAt(i)}
              labels={rowLabels}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addCard}
        className="w-full px-3 py-2 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
      >
        + Add {singular}
      </button>
      <p className="text-[11px] text-gray-400 mt-2">
        {profileCopy('serviceCardsFootnote', vertical === 'APPOINTMENT'
          ? 'These cards drive the homepage Services section. Booking-side prices, durations, and bookable services live in the Services admin tab.'
          : 'These cards drive the homepage Services section only. They do not create booking services.')}
      </p>
    </div>
  );
}

function ServiceCardRow({ index, service, onPatch, onImageUpload, onImageEdit, onImageRemove, onRemove, labels = {} }) {
  const featuresText = Array.isArray(service.features) ? service.features.join('\n') : '';
  return (
    <div className="border border-gray-200 rounded-xl p-3 space-y-2 bg-white">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-500">Card #{index + 1}</span>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 select-none text-xs cursor-pointer" title="Mark this card as most popular">
            <input
              type="checkbox"
              checked={!!service.highlighted}
              onChange={(e) => onPatch({ highlighted: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-gray-600">{labels.highlight || 'Most popular'}</span>
          </label>
          <button type="button" onClick={onRemove} className="text-xs text-red-600 hover:underline">
            Remove
          </button>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          {service.imageUrl ? (
            <div className="relative w-20 h-20">
              <img src={service.imageUrl} alt={service.name || ''} className="w-full h-full rounded-lg object-cover border border-gray-200" />
              <ImageActions
                onEdit={onImageEdit}
                onRemove={onImageRemove}
                size="xs"
                className="top-0.5 right-0.5"
              />
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center w-20 h-20 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-indigo-400 text-center">
              <span className="text-[10px] text-gray-400 leading-tight">Upload<br />image</span>
              <input type="file" accept="image/*" className="hidden" onChange={onImageUpload} />
            </label>
          )}
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          <input
            type="text"
            value={service.name || ''}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder={labels.namePlaceholder || 'Service name'}
            maxLength={80}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <textarea
            value={service.description || ''}
            onChange={(e) => onPatch({ description: e.target.value })}
            placeholder={labels.descriptionPlaceholder || 'Short description'}
            maxLength={300}
            rows={2}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              type="text"
              value={service.priceCaption || ''}
              onChange={(e) => onPatch({ priceCaption: e.target.value })}
              placeholder={labels.priceCaptionPlaceholder || 'from'}
              maxLength={20}
              className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              title="Price prefix (e.g. 'from', 'starting at')"
            />
            <input
              type="text"
              value={service.price || ''}
              onChange={(e) => onPatch({ price: e.target.value })}
              placeholder={`${labels.pricePlaceholder || 'Price'} (${service.currency || 'currency'})`}
              maxLength={20}
              className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              title={`Price in ${service.currency || 'business currency'}`}
            />
            <input
              type="text"
              value={service.duration || ''}
              onChange={(e) => onPatch({ duration: e.target.value })}
              placeholder={labels.durationPlaceholder || '30 min'}
              maxLength={20}
              className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
              title="Duration text"
            />
          </div>
          <textarea
            value={featuresText}
            onChange={(e) => onPatch({ features: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}
            placeholder={labels.featuresPlaceholder || 'Bullet features, one per line - optional'}
            rows={2}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          />
        </div>
      </div>
    </div>
  );
}

// JSON-array editor for the homepage Team cards. Decoupled from the
// booking-side User[] / Staff table — admins editing Staff (login,
// permissions, calendar) doesn't touch the homepage display, and edits
// here don't grant anyone login access.
function TeamCardsEditor({ value, vocab = {}, vertical = 'APPOINTMENT', memberLabelPlaceholder = 'Team Member', openImageAdjust, onChange }) {
  const items = (() => {
    try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a : []; }
    catch { return []; }
  })();
  const singular = ((vocab.staff || 'team').toLowerCase().replace(/s$/, '')) || 'member';
  const confirm = useConfirm();

  function emit(next) { onChange(next.length > 0 ? JSON.stringify(next) : ''); }
  function patchAt(i, patch) { emit(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it))); }
  function addCard() {
    emit([...items, { name: `New ${singular}`, role: '', bio: '', imageUrl: '', showOnWebsite: true }]);
  }
  async function removeAt(i) {
    if (!await confirm('Remove this card?', { confirmLabel: 'Remove', tone: 'danger' })) return;
    emit(items.filter((_, idx) => idx !== i));
  }
  function handleImageUpload(i, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert('Image must be under 15MB'); return; }
    const inputEl = e.target;
    if (typeof openImageAdjust !== 'function') return;
    openImageAdjust({
      file, aspect: 1, maxWidth: 600, quality: 0.88,
      frameLabel: `Adjust ${singular} photo`, uploadScope: 'staff',
      onConfirm: (url) => { patchAt(i, { imageUrl: url }); try { inputEl.value = ''; } catch {} },
      onCancel: () => { try { inputEl.value = ''; } catch {} },
    });
  }
  function handleImageEdit(i, currentSrc) {
    if (!currentSrc || typeof openImageAdjust !== 'function') return;
    openImageAdjust({
      initialSrc: currentSrc, aspect: 1, maxWidth: 600, quality: 0.88,
      frameLabel: `Adjust ${singular} photo`, uploadScope: 'staff',
      onConfirm: (url) => patchAt(i, { imageUrl: url }),
    });
  }

  return (
    <div>
      {items.length === 0 ? (
        <p className="text-xs text-gray-500 italic py-6 text-center border border-dashed border-gray-300 rounded-lg mb-3">
          No {singular} cards yet. Click &ldquo;+ Add {singular}&rdquo; to create your first one.
        </p>
      ) : (
        <div className="space-y-3 mb-3">
          {items.map((m, i) => (
            <TeamCardRow
              key={i}
              index={i}
              member={m}
              subtitlePlaceholder={memberLabelPlaceholder}
              onPatch={(patch) => patchAt(i, patch)}
              onImageUpload={(e) => handleImageUpload(i, e)}
              onImageEdit={() => handleImageEdit(i, m.imageUrl)}
              onImageRemove={() => patchAt(i, { imageUrl: '' })}
              onRemove={() => removeAt(i)}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addCard}
        className="w-full px-3 py-2 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
      >
        + Add {singular}
      </button>
      <p className="text-[11px] text-gray-400 mt-2">
        {vertical === 'APPOINTMENT'
          ? 'These cards drive the homepage Team section. Inviting staff who can log in and take bookings is done separately in the Staff admin tab.'
          : 'These cards drive the homepage Team section only. They do not create staff logins.'}
      </p>
    </div>
  );
}

function TeamCardRow({ index, member, subtitlePlaceholder, onPatch, onImageUpload, onImageEdit, onImageRemove, onRemove }) {
  const shown = member.showOnWebsite !== false;
  return (
    <div className={`border rounded-xl p-3 space-y-2 border-gray-200 bg-white ${shown ? '' : 'opacity-70'}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-gray-500">Card #{index + 1}</span>
        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-1.5 select-none text-xs cursor-pointer" title="Show this person in the public website Team section">
            <input
              type="checkbox"
              checked={shown}
              onChange={(e) => onPatch({ showOnWebsite: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-gray-600">On website</span>
          </label>
          <button type="button" onClick={onRemove} className="text-xs text-red-600 hover:underline">
            Remove
          </button>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0">
          {member.imageUrl ? (
            <div className="relative w-20 h-20">
              <img src={member.imageUrl} alt={member.name || ''} className="w-full h-full rounded-full object-cover border border-gray-200" />
              <ImageActions
                onEdit={onImageEdit}
                onRemove={onImageRemove}
                size="xs"
                className="top-0 right-0"
              />
            </div>
          ) : (
            <label className="flex flex-col items-center justify-center w-20 h-20 border-2 border-dashed border-gray-300 rounded-full cursor-pointer hover:border-indigo-400 text-center">
              <span className="text-[10px] text-gray-400 leading-tight">Upload<br />image</span>
              <input type="file" accept="image/*" className="hidden" onChange={onImageUpload} />
            </label>
          )}
        </div>
        <div className="flex-1 space-y-2 min-w-0">
          <input
            type="text"
            value={member.name || ''}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder="Name e.g. Dr. Shreya"
            maxLength={80}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <input
            type="text"
            value={member.role || ''}
            onChange={(e) => onPatch({ role: e.target.value })}
            placeholder={`Role — defaults to "${subtitlePlaceholder}"`}
            maxLength={80}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <textarea
            value={member.bio || ''}
            onChange={(e) => onPatch({ bio: e.target.value })}
            placeholder="Short bio"
            maxLength={600}
            rows={3}
            className="w-full px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          />
        </div>
      </div>
    </div>
  );
}

function GalleryItemsEditor({ value, onChange, openImageAdjust }) {
  const items = (() => {
    try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  })();

  function save(next) { onChange(JSON.stringify(next)); }
  function setItem(i, patch) { const n = [...items]; n[i] = { ...n[i], ...patch }; save(n); }
  function remove(i) { const n = [...items]; n.splice(i, 1); save(n); }
  function add() {
    if (items.length >= 12) return;
    save([...items, { image: '', caption: '' }]);
  }

  function handleUpload(i, e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { alert('Image must be under 15MB'); return; }
    const inputEl = e.target;
    // Prefer the shared adjust modal; if the parent forgot to pass it in
    // (shouldn't happen, but be defensive) fall back to straight compress.
    if (typeof openImageAdjust !== 'function') return;
    openImageAdjust({
      file,
      aspect: 4 / 3,
      maxWidth: 1200,
      quality: 0.82,
      frameLabel: `Adjust gallery image ${i + 1}`,
      uploadScope: 'gallery',
      onConfirm: (value) => { setItem(i, { image: value }); try { inputEl.value = ''; } catch {} },
      onCancel:  () => { try { inputEl.value = ''; } catch {} },
    });
  }

  function handleEdit(i, currentSrc) {
    if (!currentSrc || typeof openImageAdjust !== 'function') return;
    openImageAdjust({
      initialSrc: currentSrc,
      aspect: 4 / 3,
      maxWidth: 1200,
      quality: 0.82,
      frameLabel: `Adjust gallery image ${i + 1}`,
      uploadScope: 'gallery',
      onConfirm: (v) => setItem(i, { image: v }),
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-500">{items.length}/12 images</p>
        {items.length < 12 && (
          <button onClick={add} className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            + Add image
          </button>
        )}
      </div>
      {items.length === 0 && (
        <p className="text-xs text-gray-500 italic py-6 text-center border border-dashed border-gray-300 rounded-lg">
          No gallery images yet. 4–12 works best.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {items.map((item, i) => (
          <div key={i} className="border border-gray-200 rounded-lg p-2 space-y-1.5">
            {item.image ? (
              <div className="relative">
                <img src={item.image} alt={item.caption || ''} className="w-full h-20 object-cover rounded" />
                <ImageActions
                  onEdit={() => handleEdit(i, item.image)}
                  onRemove={() => remove(i)}
                  size="xs"
                />
              </div>
            ) : (
              <label className="flex items-center justify-center h-20 border-2 border-dashed border-gray-300 rounded cursor-pointer hover:border-indigo-400">
                <span className="text-[10px] text-gray-400">Upload</span>
                <input type="file" accept="image/*" className="hidden" onChange={(e) => handleUpload(i, e)} />
              </label>
            )}
            <input
              type="text"
              value={item.caption || ''}
              onChange={(e) => setItem(i, { caption: e.target.value })}
              placeholder="Caption (optional)"
              maxLength={60}
              className="w-full px-2 py-1 text-[11px] border border-gray-200 rounded focus:outline-none focus:border-indigo-500"
            />
          </div>
        ))}
      </div>
      <p className="text-[11px] text-gray-400 mt-2">Tip: images auto-compress. Use 1200×800 or larger for crispness.</p>
    </div>
  );
}

// Editor for the footer policies list. Each entry has a short display name
// (shown as a footer link) and long policy text (shown when a customer clicks
// the link). The long text gets its own popup so owners can paste entire
// policy documents without fighting a tiny inline textarea.
function PoliciesEditor({ value, onChange }) {
  const items = (() => {
    try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  })();

  const [editingIndex, setEditingIndex] = useState(null);

  function save(next) { onChange(JSON.stringify(next)); }
  function setItem(i, patch) { const n = [...items]; n[i] = { ...n[i], ...patch }; save(n); }
  function remove(i) { const n = [...items]; n.splice(i, 1); save(n); }
  function add() {
    if (items.length >= 8) return;
    save([...items, { name: '', details: '' }]);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-500">{items.length}/8 policies</p>
        {items.length < 8 && (
          <button type="button" onClick={add} className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            + Add policy
          </button>
        )}
      </div>
      {items.length === 0 && (
        <p className="text-xs text-gray-500 italic py-6 text-center border border-dashed border-gray-300 rounded-lg">
          No policies yet. Click &ldquo;+ Add policy&rdquo; to add your first one — e.g. Privacy Policy or Terms of Service.
        </p>
      )}
      <div className="space-y-2">
        {items.map((it, i) => {
          const plain = (it.details || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
          const hasDetails = plain.length > 0;
          return (
            <div key={i} className="border border-gray-200 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500">Policy #{i + 1}</span>
                <button type="button" onClick={() => remove(i)} className="text-xs text-red-600 hover:underline">Remove</button>
              </div>
              <Input
                value={it.name || ''}
                onChange={(v) => setItem(i, { name: v })}
                placeholder="Policy name (e.g. Privacy Policy)"
                max={60}
              />
              <div className="flex items-center justify-between gap-3">
                <span className={`text-xs ${hasDetails ? 'text-gray-600' : 'text-amber-600'}`}>
                  {hasDetails
                    ? `${plain.length} characters`
                    : 'No content yet — the link will stay hidden until you add policy text.'}
                </span>
                <button
                  type="button"
                  onClick={() => setEditingIndex(i)}
                  className="px-3 py-1.5 text-xs font-semibold border border-indigo-600 text-indigo-600 rounded-lg hover:bg-indigo-50"
                >
                  {hasDetails ? 'Edit content' : 'Write content'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {editingIndex !== null && items[editingIndex] && (
        <PolicyContentModal
          policy={items[editingIndex]}
          onClose={() => setEditingIndex(null)}
          onSave={(next) => { setItem(editingIndex, next); setEditingIndex(null); }}
        />
      )}
    </div>
  );
}

// Popup WYSIWYG editor for a single policy. Owners can paste a whole policy
// document and format with bold, headings, bullets, and links. Content is
// stored as HTML constrained to Tiptap's schema (safe to render with
// dangerouslySetInnerHTML downstream).
function PolicyContentModal({ policy, onClose, onSave }) {
  const [name, setName] = useState(policy.name || '');
  const [details, setDetails] = useState(policy.details || '');
  return (
    <div className="fixed inset-0 z-[60] flex items-start md:items-center justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-3xl my-8 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Edit policy</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Policy name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Privacy Policy, Terms of Service, Refund Policy"
              maxLength={60}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <p className="text-xs text-gray-500 mt-1">This is the text that appears as a link in your footer.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Policy content</label>
            <RichTextEditor
              value={details}
              onChange={setDetails}
              placeholder="Type or paste the full policy. Use the toolbar for headings, bold, bullet points, and links."
              minHeight={360}
            />
            <p className="text-xs text-gray-500 mt-1">
              Customers see this when they click the policy link in the footer. Leave blank and the link stays hidden.
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          <button
            type="button"
            onClick={() => onSave({ name: name.trim(), details })}
            className="px-4 py-2 text-sm font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            Save policy
          </button>
        </div>
      </div>
    </div>
  );
}

function FaqItemsEditor({ value, onChange }) {
  const items = (() => {
    try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  })();

  function save(next) { onChange(JSON.stringify(next)); }
  function setItem(i, patch) { const n = [...items]; n[i] = { ...n[i], ...patch }; save(n); }
  function remove(i) { const n = [...items]; n.splice(i, 1); save(n); }
  function add() {
    if (items.length >= 12) return;
    save([...items, { q: '', a: '' }]);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-gray-500">{items.length}/12 questions</p>
        {items.length < 12 && (
          <button onClick={add} className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            + Add question
          </button>
        )}
      </div>
      {items.length === 0 && (
        <p className="text-xs text-gray-500 italic py-6 text-center border border-dashed border-gray-300 rounded-lg">
          No questions yet. Answer them in the business's voice, not corporate-ese.
        </p>
      )}
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="border border-gray-200 rounded-lg p-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500">#{i + 1}</span>
              <button onClick={() => remove(i)} className="text-xs text-red-600 hover:underline">Remove</button>
            </div>
            <Input value={it.q || ''} onChange={(v) => setItem(i, { q: v })} placeholder="Customer-phrased question" max={120} />
            <Area value={it.a || ''} onChange={(v) => setItem(i, { a: v })} placeholder="Plain-language answer" max={400} rows={3} />
          </div>
        ))}
      </div>
    </div>
  );
}

function StatsItemsEditor({ value, onChange }) {
  const items = (() => {
    try { const a = JSON.parse(value || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  })();

  function save(next) { onChange(JSON.stringify(next)); }
  function setItem(idx, patch) {
    const next = [...items];
    next[idx] = { ...next[idx], ...patch };
    save(next);
  }
  function remove(idx) {
    const next = [...items];
    next.splice(idx, 1);
    save(next);
  }
  function add() {
    if (items.length >= 4) return;
    save([...items, { number: '', label: '' }]);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium text-gray-700">Stats ({items.length}/4)</p>
        {items.length < 4 && (
          <button onClick={add} className="px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
            + Add stat
          </button>
        )}
      </div>
      {items.length === 0 && (
        <p className="text-xs text-gray-500 italic py-6 text-center border border-dashed border-gray-300 rounded-lg">
          No custom stats yet — your site will show defaults (service count, team size).
        </p>
      )}
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input value={it.number || ''} onChange={(v) => setItem(i, { number: v })} placeholder="500+" max={12} />
            <Input value={it.label || ''} onChange={(v) => setItem(i, { label: v })} placeholder="Happy customers" max={40} />
            <button onClick={() => remove(i)} className="text-xs text-red-600 hover:underline flex-shrink-0">Remove</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Toggle({ checked, onChange }) {
  return (
    <label className="relative flex-shrink-0 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <div className="w-11 h-6 bg-gray-200 peer-checked:bg-emerald-500 rounded-full transition-colors" />
      <div className="absolute left-0.5 top-0.5 w-5 h-5 bg-white rounded-full shadow peer-checked:translate-x-5 transition-transform" />
    </label>
  );
}

function SocialInput({ icon, label, value, onChange, placeholder, show, onToggleShow }) {
  const brand = SOCIAL_ICONS[icon];
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: brand?.color || '#e5e7eb', color: '#fff' }} aria-label={label}>
        {brand ? (
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d={brand.path} /></svg>
        ) : (
          <span className="text-xs font-bold text-gray-500">{icon[0]}</span>
        )}
      </span>
      <input type="url" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
      {onToggleShow && <Toggle checked={show} onChange={onToggleShow} />}
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {hint && <p className="text-xs text-gray-400 mb-1">{hint}</p>}
      {children}
    </div>
  );
}

// Single-field input for the Business.email / phone / address row. Reads
// from the parent's `business` prop, debounces typing for 1200ms, then calls
// onUpdate with the full { email, phone, address } triple (the backend
  // endpoint /api/business/setup wants the whole record, so each field's
// change carries the others along unchanged).
function BusinessContactInput({ business = {}, field, onUpdate, onPreview, placeholder, type = 'text' }) {
  const [val, setVal] = useState(business?.[field] || '');
  const initialRef = useRef(true);

  useEffect(() => {
    setVal(business?.[field] || '');
    initialRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business?.[field]]);

  // Live preview — fires on every keystroke (no debounce) so the iframe
  // reflects typing in real time. The save effect below still debounces at
  // 1200 ms so we're not hammering /api/business/setup while the owner types.
  useEffect(() => {
    if (initialRef.current) return;
    onPreview?.(field, val);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [val]);

  useEffect(() => {
    if (initialRef.current) { initialRef.current = false; return; }
    if (!onUpdate) return;
    const handle = setTimeout(() => {
      onUpdate({
        email: field === 'email' ? val.trim() : (business?.email || ''),
        phone: field === 'phone' ? val.trim() : (business?.phone || ''),
        address: field === 'address' ? val.trim() : (business?.address || ''),
      });
    }, 1200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [val]);

  return (
    <input
      type={type}
      value={val}
      onChange={(e) => setVal(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
    />
  );
}

// Single Publish button that saves content when the site is already live
// and, when the site is still a draft, opens a friendly confirmation popup
// reminding the owner to fill their details + check the preview before
// going live. No hard checklist — owner is free to cancel + keep editing
// or continue to launch.
function PublishButton({ saving, isLive, siteUrl, vertical = 'APPOINTMENT', onSave, onLaunch }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [err, setErr] = useState('');

  async function handleClick() {
    if (isLive) {
      // Site's already live — Publish = save new edits, same as before.
      onSave?.();
      return;
    }
    // First-time publish: let the owner confirm.
    setConfirmOpen(true);
    setErr('');
  }

  async function confirmLaunch() {
    setLaunching(true); setErr('');
    try {
      // Flush any pending edits first so what goes live reflects the editor.
      if (onSave) {
        try { await onSave(); } catch { /* non-fatal */ }
      }
      // Actually go live via the parent-supplied launcher (calls
      // /api/business/launch then refreshes tenant state).
      if (onLaunch) {
        await onLaunch();
      }
      setConfirmOpen(false);
    } catch (e) {
      setErr(e?.message || 'Could not publish — please try again.');
    } finally {
      setLaunching(false);
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        disabled={saving}
        className="px-3.5 py-1.5 text-[12px] font-semibold rounded-[8px] text-white transition-opacity disabled:opacity-60"
        style={{ background: isLive ? 'var(--ae-indigo)' : '#059669' }}
        title={isLive ? 'Save your edits' : 'Publish and make your website live'}
      >
        {saving ? 'Publishing…' : isLive ? 'Publish' : '🚀 Publish'}
      </button>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(10,10,20,0.55)' }}
          onClick={() => !launching && setConfirmOpen(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-3">
              <span className="w-9 h-9 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-lg flex-shrink-0">🚀</span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Ready to publish your website?</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  {vertical === 'APPOINTMENT'
                    ? 'Once published, your website goes live and customers can start booking.'
                    : 'Once published, your website goes live for visitors.'}
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 mb-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-2">Before you publish</p>
              <ul className="space-y-1.5 text-sm text-gray-700">
                <li className="flex gap-2"><span className="text-emerald-600">✓</span><span>Fill in your business details (name, category, email, phone, address)</span></li>
                <li className="flex gap-2"><span className="text-emerald-600">✓</span><span>Write a hero headline for the top of your homepage</span></li>
                <li className="flex gap-2"><span className="text-emerald-600">✓</span><span>Check the live preview to make sure everything looks right</span></li>
              </ul>
            </div>

            {err && (
              <p className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>
            )}

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={launching}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 disabled:opacity-50"
              >
                Cancel — keep editing
              </button>
              <button
                type="button"
                onClick={confirmLaunch}
                disabled={launching}
                className="px-5 py-2 text-sm font-semibold rounded-lg text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {launching ? 'Publishing…' : 'Publish & go live →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function FieldWithToggle({ label, hint, show, onToggleShow, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-gray-700">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">{show ? 'Visible' : 'Hidden'}</span>
          <Toggle checked={show} onChange={onToggleShow} />
        </div>
      </div>
      {hint && <p className="text-xs text-gray-400 mb-2">{hint}</p>}
      <div className={show ? '' : 'opacity-50'}>{children}</div>
    </div>
  );
}

function Input({ value, onChange, placeholder, max }) {
  return (
    <div>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={max}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent" />
      {max && <CharCount val={value} max={max} />}
    </div>
  );
}

function Area({ value, onChange, placeholder, max, rows = 3 }) {
  return (
    <div>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={max} rows={rows}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none" />
      {max && <CharCount val={value} max={max} />}
    </div>
  );
}

function CharCount({ val, max }) {
  const len = (val || '').length;
  const near = len > max * 0.85;
  return <p className={`text-xs mt-1 text-right ${near ? 'text-amber-600' : 'text-gray-400'}`}>{len}/{max}</p>;
}
