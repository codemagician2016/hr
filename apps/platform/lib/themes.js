// Theme surface shim for the platform admin app.
//
// The old profession-catalog module (the 60+ profession catalog) was removed
// when the engine was slimmed to 5 fixed styles + 12 curated brand colors.
// This file re-creates the SAME compatibility surface
// the existing admin consumers import — THEMES, getThemeVars, resolveThemeKey,
// getThemesByCategory, composeTheme, getTheme, THEME_KEYS,
// createProfessionThemeSurface — but backs it with the new fixed-style +
// brand-color system instead of the deleted profession catalog.
//
// White-label model: a tenant picks ONE of 5 styles + ONE of 12 brand colors
// + a logo. There is no freeform profession catalog anymore.

import {
  hrStyleRegistry,
  FIXED_STYLE_SEEDS,
  FIXED_STYLE_KEYS,
  DEFAULT_STYLE_KEY,
  normalizeStyleKey,
  resolveTenantTheme,
  resolveColor,
  COLOR_KEYS,
  COLORS,
  composeTheme as engineComposeTheme,
} from '@hr/theme-engine';

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function isHex(v) {
  return typeof v === 'string' && HEX_RE.test(v.trim());
}

function expandHex(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return h.length === 6 ? h : null;
}

// Relative-luminance-based contrast pick: returns a readable on-color
// (#FFFFFF or a near-black) for text/icons sitting on `hex`.
function onColor(hex) {
  const h = expandHex(hex);
  if (!h) return '#FFFFFF';
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55 ? '#0F172A' : '#FFFFFF';
}

// Darken a hex toward black by `amount` (0..1) — for --theme-primary-dark.
function darken(hex, amount = 0.18) {
  const h = expandHex(hex);
  if (!h) return hex;
  const ch = (i) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    return Math.max(0, Math.round(v * (1 - amount)));
  };
  const to2 = (n) => n.toString(16).padStart(2, '0');
  return `#${to2(ch(0))}${to2(ch(2))}${to2(ch(4))}`.toUpperCase();
}

// ── THEMES: the 5 fixed styles as a registry/map ────────────────────────────
//
// Keyed by style key. Each entry carries the flat color fields the admin
// pickers/preview thumbs read (primaryColor, bgColor, …) plus the metadata
// fields ContentEditor reads (vocab, defaultContent, heroStyle).
function themeEntry(styleKey) {
  const seed = FIXED_STYLE_SEEDS[styleKey] || {};
  const palette = seed.palette || {};
  const primary = palette.primary || '#4F46E5';
  return {
    key: styleKey,
    name: seed.label || styleKey,
    label: seed.label || styleKey,
    industry: seed.label || styleKey,
    tags: [],
    primaryColor: primary,
    accentColor: primary,
    bgColor: palette.background || '#F8FAFC',
    surfaceColor: '#FFFFFF',
    textColor: palette.foreground || '#0F172A',
    heroStyle: 'split',
    vocab: {},
    defaultContent: {},
    metadata: seed.metadata || {},
  };
}

export const THEMES = FIXED_STYLE_KEYS.reduce((acc, key) => {
  acc[key] = themeEntry(key);
  return acc;
}, {});

// THEME_KEYS → the 5 fixed style keys.
export const THEME_KEYS = [...FIXED_STYLE_KEYS];

// resolveThemeKey → coerce any (possibly legacy/profession) key to one of the
// 5 fixed style keys.
export const resolveThemeKey = normalizeStyleKey;

// getTheme → the THEMES entry for a (normalized) style key.
export function getTheme(key) {
  return THEMES[normalizeStyleKey(key)] || THEMES[DEFAULT_STYLE_KEY];
}

// ── Brand-primary resolution shared by composeTheme + getThemeVars ──────────
//
// Consumers call these with mixed legacy signatures. We resolve the brand
// primary from, in precedence order: an explicit hex in `overrides.primary`,
// a curated `colorKey` (one of COLOR_KEYS), else the style's own primary.
function resolveBrandPrimary(styleKey, colorKey, overrides = {}) {
  if (overrides && isHex(overrides.primary)) return overrides.primary;
  if (typeof colorKey === 'string' && COLOR_KEYS.includes(colorKey)) {
    return resolveColor(colorKey);
  }
  if (isHex(colorKey)) return colorKey;
  return THEMES[normalizeStyleKey(styleKey)]?.primaryColor || resolveColor('indigo');
}

function resolveBrandAccent(primary, overrides = {}) {
  return isHex(overrides && overrides.accent) ? overrides.accent : primary;
}

// composeTheme — compatibility wrapper.
//
// Existing consumers call composeTheme(styleKey, styleKey2, colorsObj) and read
// back FLAT color fields (.primaryColor, .accentColor, .bgColor, .surfaceColor,
// .textColor). We honor that shape. When called the engine way (object base +
// object override) we delegate to the engine's composeTheme.
export function composeTheme(base, override, options) {
  if (base && typeof base === 'object') {
    return engineComposeTheme(base, override, options);
  }
  // Legacy flat form: (styleKey, styleKey2OrColorKey, colorsObj)
  const styleKey = normalizeStyleKey(base);
  const theme = THEMES[styleKey];
  const overrides = (override && typeof override === 'object') ? override
    : (options && typeof options === 'object') ? options
    : {};
  const primary = resolveBrandPrimary(styleKey, override, overrides);
  const accent = resolveBrandAccent(primary, overrides);
  return {
    ...theme,
    key: styleKey,
    primaryColor: primary,
    accentColor: accent,
    bgColor: isHex(overrides.bg) ? overrides.bg : theme.bgColor,
    surfaceColor: isHex(overrides.surface) ? overrides.surface : theme.surfaceColor,
    textColor: isHex(overrides.text) ? overrides.text : theme.textColor,
  };
}

// getThemeVars — compose the `--theme-*` CSS-variable map consumers apply to
// document.documentElement. Signatures in use:
//   getThemeVars(styleKey)
//   getThemeVars(styleKey, themeStyle, themeColors)  (legacy)
//   getThemeVars(styleKey, colorKey)
export function getThemeVars(styleKey, colorKey, overrides = {}) {
  const key = normalizeStyleKey(styleKey);
  const tenant = THEMES[key];
  const primary = resolveBrandPrimary(key, colorKey, overrides);
  const accent = resolveBrandAccent(primary, overrides);
  const bg = isHex(overrides.bg) ? overrides.bg : tenant.bgColor;
  const surface = isHex(overrides.surface) ? overrides.surface : tenant.surfaceColor;
  const text = isHex(overrides.text) ? overrides.text : tenant.textColor;
  return {
    '--theme-primary': primary,
    '--theme-primary-dark': darken(primary),
    '--theme-accent': accent,
    '--theme-bg': bg,
    '--theme-surface': surface,
    '--theme-text': text,
    '--theme-muted': `${text}99`,
    '--theme-border': `${text}22`,
    '--theme-on-primary': onColor(primary),
    '--theme-on-accent': onColor(accent),
  };
}

// getThemesByCategory — the catalog grouping the theme picker renders. With the
// fixed-style model there is a single category containing the 5 styles. Each
// card carries the fields admin-pickers' themeCardFromCatalog expects.
export function getThemesByCategory() {
  return [
    {
      category: 'Styles',
      themes: FIXED_STYLE_KEYS.map((key) => {
        const t = THEMES[key];
        return {
          key,
          name: t.name,
          label: t.label,
          desc: t.name,
          industry: t.industry,
          tags: t.tags,
          primaryColor: t.primaryColor,
          accentColor: t.accentColor,
          bgColor: t.bgColor,
          surfaceColor: t.surfaceColor,
          textColor: t.textColor,
          heroStyle: t.heroStyle,
        };
      }),
    },
  ];
}

// Compatibility: the 12 curated brand colors, surfaced for any picker that
// imported the old COLORS/COLOR_KEYS list off the theme surface.
export const THEME_COLORS = COLORS;
export const THEME_COLOR_KEYS = [...COLOR_KEYS];

// Compatibility no-op-ish surface factory. The deleted profession registry
// exposed createProfessionThemeSurface({...}); no current consumer imports it,
// but we provide a thin surface backed by hrStyleRegistry so any straggler
// import resolves to a coherent object.
export function createProfessionThemeSurface() {
  return {
    THEMES,
    THEME_KEYS,
    THEME_CATEGORIES: getThemesByCategory(),
    DEFAULT_PROFESSION_KEY: DEFAULT_STYLE_KEY,
    STYLES: THEMES,
    getThemesByCategory,
    getTheme,
    composeTheme,
    getThemeVars,
    resolveThemeKey,
    resolveTenantTheme,
    registry: hrStyleRegistry,
  };
}
