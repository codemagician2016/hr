const {
  THEME_CONTRACT_VERSION,
  THEME_MODES,
  THEME_INHERITANCE_MODES,
  SLOT_GROUPS,
  VERTICALS: TYPES_VERTICALS,
} = require('@hr/types');

// HRMS is a single-vertical product. The 60+ profession verticals
// (booking/shop/web and their aliases) have been collapsed to one 'HR'
// vertical. The canonical value now lives in `@hr/types` (VERTICALS.HR); we
// keep a local fallback in case the import shape differs (older @hr/types).
const HR = (TYPES_VERTICALS && TYPES_VERTICALS.HR) || 'HR';
// Back-compat alias: existing code/tests referenced HR_VERTICAL.
const HR_VERTICAL = HR;
const VERTICALS = Object.freeze({ HR });

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanKey(value, fallback = 'default') {
  const key = String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return key || fallback;
}

// Single-vertical product: every theme is an HR theme. The argument is
// accepted for signature/back-compat but the result is always 'HR'.
function normalizeVertical() {
  return HR_VERTICAL;
}

function normalizeMode(value, fallback = THEME_MODES.GENERIC) {
  const mode = String(value || fallback).trim().toLowerCase();
  return Object.values(THEME_MODES).includes(mode) ? mode : fallback;
}

function normalizeInheritance(value, fallback = THEME_INHERITANCE_MODES.MERGE) {
  const mode = String(value || fallback).trim().toLowerCase();
  return Object.values(THEME_INHERITANCE_MODES).includes(mode) ? mode : fallback;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

function normalizeVocab(raw = {}) {
  const source = raw.vocab || raw.themeVocab || raw.noun || {};
  return {
    appointments: source.appointments || source.noun?.plural || source.bookingNoun?.plural || undefined,
    appointment: source.appointment || source.noun?.singular || source.bookingNoun?.singular || undefined,
    services: source.services || source.serviceNoun?.plural || undefined,
    service: source.service || source.serviceNoun?.singular || undefined,
    team: source.team || source.staffNoun?.plural || undefined,
    staff: source.staff || source.staffNoun?.plural || undefined,
    customers: source.customers || source.customerNoun?.plural || undefined,
    customer: source.customer || source.customerNoun?.singular || undefined,
    locations: source.locations || source.locationNoun?.plural || undefined,
    location: source.location || source.locationNoun?.singular || undefined,
    bookCta: source.bookCta || undefined,
    confirmMsg: source.confirmMsg || undefined,
  };
}

function normalizePalette(raw = {}) {
  const palette = raw.palette || {};
  return {
    primary: palette.primary || raw.primaryColor || raw.primary || undefined,
    accent: palette.accent || raw.accentColor || raw.accent || undefined,
    background: palette.background || raw.backgroundColor || undefined,
    foreground: palette.foreground || raw.textColor || undefined,
  };
}

function normalizePanels(raw = {}) {
  const panels = raw.panels || raw.adminPanels || raw.admin?.panels || [];
  return Array.isArray(panels) ? panels.map((key) => cleanKey(key, '')).filter(Boolean) : [];
}

function normalizeSlots(raw = {}) {
  return {
    [SLOT_GROUPS.ADMIN]: raw.slots?.admin || raw.componentOverrides?.admin || raw.admin?.slots || {},
    [SLOT_GROUPS.STOREFRONT]: raw.slots?.storefront || raw.componentOverrides?.storefront || raw.storefront || raw.website || {},
    [SLOT_GROUPS.CUSTOMER]: raw.slots?.customer || raw.componentOverrides?.customer || raw.customer?.slots || {},
    [SLOT_GROUPS.STAFF]: raw.slots?.staff || raw.componentOverrides?.staff || raw.staff?.slots || {},
  };
}

function inferMode(raw = {}) {
  if (raw.mode) return normalizeMode(raw.mode);
  const slots = normalizeSlots(raw);
  const slotCount = Object.values(slots).reduce((sum, group) => sum + Object.keys(group || {}).length, 0);
  if (slotCount > 8) return THEME_MODES.BESPOKE;
  if (slotCount > 0 || raw.admin?.panels || raw.adminPanels) return THEME_MODES.MIXED;
  return THEME_MODES.GENERIC;
}

function normalizeThemeConfig(raw = {}, defaults = {}) {
  const merged = deepMerge(defaults, raw);
  const key = cleanKey(merged.key || merged.themeKey || merged.id);
  return {
    contractVersion: Number(merged.contractVersion || THEME_CONTRACT_VERSION),
    key,
    label: merged.label || key.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
    vertical: normalizeVertical(merged.vertical),
    mode: inferMode(merged),
    extends: merged.extends ? cleanKey(merged.extends, '') : undefined,
    inheritance: normalizeInheritance(merged.inheritance),
    palette: normalizePalette(merged),
    vocab: normalizeVocab(merged),
    features: { ...(merged.features || {}) },
    panels: normalizePanels(merged),
    slots: normalizeSlots(merged),
    metadata: {
      mood: merged.mood || undefined,
      category: merged.category || merged.profession || undefined,
      source: merged.source || undefined,
    },
    raw: merged,
  };
}

function validateThemeContract(theme) {
  const errors = [];
  const warnings = [];
  const normalized = normalizeThemeConfig(theme);

  if (!normalized.key) errors.push('Theme key is required.');
  if (!Object.values(VERTICALS).includes(normalized.vertical)) {
    errors.push(`Unsupported vertical: ${normalized.vertical}`);
  }
  if (!Object.values(THEME_MODES).includes(normalized.mode)) {
    errors.push(`Unsupported mode: ${normalized.mode}`);
  }
  if (normalized.extends && normalized.extends === normalized.key) {
    errors.push(`Theme ${normalized.key} cannot extend itself.`);
  }
  if (normalized.contractVersion !== THEME_CONTRACT_VERSION) {
    warnings.push(`Theme contract version ${normalized.contractVersion} will be normalized as ${THEME_CONTRACT_VERSION}.`);
  }
  if (normalized.mode === THEME_MODES.BESPOKE && normalized.panels.length === 0 && Object.keys(normalized.slots.admin || {}).length === 0) {
    warnings.push('Bespoke themes should declare admin panels or admin slots.');
  }

  return { valid: errors.length === 0, errors, warnings, theme: normalized };
}

function composeTheme(base = {}, override = {}, options = {}) {
  const inheritance = normalizeInheritance(override?.inheritance || options.inheritance);
  const source = inheritance === THEME_INHERITANCE_MODES.REPLACE
    ? { ...override }
    : deepMerge(base, override);
  return normalizeThemeConfig({
    ...source,
    key: override?.key || source.key || base?.key,
    extends: override?.extends || base?.key,
    inheritance,
  }, options.defaults || {});
}

function createThemeRegistry(entries = {}, options = {}) {
  const defaultKey = cleanKey(options.defaultKey || 'default');
  const registry = new Map();

  function register(key, config) {
    const baseKey = config?.extends;
    const base = baseKey ? registry.get(cleanKey(baseKey))?.raw : null;
    const normalized = base
      ? composeTheme(base, { ...(config || {}), key: key || config?.key })
      : normalizeThemeConfig({ ...(config || {}), key: key || config?.key });
    registry.set(normalized.key, normalized);
    return normalized;
  }

  if (Array.isArray(entries)) {
    for (const entry of entries) register(entry?.key, entry);
  } else {
    for (const [key, config] of Object.entries(entries || {})) register(key, config);
  }

  function get(key, fallbackKey = defaultKey) {
    const normalizedKey = cleanKey(key || fallbackKey);
    return registry.get(normalizedKey) || registry.get(cleanKey(fallbackKey)) || registry.values().next().value || null;
  }

  function list(filter = {}) {
    return Array.from(registry.values()).filter((theme) => {
      if (filter.vertical && theme.vertical !== normalizeVertical(filter.vertical)) return false;
      if (filter.mode && theme.mode !== normalizeMode(filter.mode)) return false;
      return true;
    });
  }

  return {
    register,
    get,
    list,
    keys: () => Array.from(registry.keys()),
    byVertical: (vertical) => list({ vertical }),
    resolve: (key, fallbackKey) => get(key, fallbackKey),
    size: () => registry.size,
  };
}

function resolveThemeSlots(theme, defaults = {}) {
  const normalized = normalizeThemeConfig(theme);
  const defaultSlots = normalizeSlots({ slots: defaults });
  const resolved = {};

  for (const group of Object.values(SLOT_GROUPS)) {
    resolved[group] = {
      ...(defaultSlots[group] || {}),
      ...(normalized.slots[group] || {}),
    };
  }

  return resolved;
}

function resolveThemeSlot(theme, group, slotKey, defaults = {}) {
  const slotGroup = String(group || '').toLowerCase();
  const key = String(slotKey || '');
  const slots = resolveThemeSlots(theme, defaults);
  return slots[slotGroup]?.[key] ?? null;
}

function createLazySlotResolver({ importers = {}, defaults = {}, dynamicLoader } = {}) {
  return function lazySlot(theme, group, slotKey, fallbackSlot) {
    const slotRef = resolveThemeSlot(theme, group, slotKey, defaults) || fallbackSlot;
    const importer = importers[slotRef] || (fallbackSlot ? importers[fallbackSlot] : null);
    if (!importer) return null;
    return typeof dynamicLoader === 'function' ? dynamicLoader(importer) : importer;
  };
}

function buildThemeManifest(entries = {}, options = {}) {
  const registry = createThemeRegistry(entries, options);
  return registry.list().map((theme) => ({
    contractVersion: theme.contractVersion,
    key: theme.key,
    label: theme.label,
    vertical: theme.vertical,
    mode: theme.mode,
    extends: theme.extends,
    inheritance: theme.inheritance,
    palette: theme.palette,
    vocab: theme.vocab,
    features: theme.features,
    panels: theme.panels,
    metadata: theme.metadata,
    ...(options.includeSlots ? { slots: theme.slots } : {}),
  }));
}

function buildBackendThemeManifest(entries = {}, options = {}) {
  return buildThemeManifest(entries, options).map((theme) => ({
    key: theme.key,
    label: theme.label,
    vertical: theme.vertical,
    mode: theme.mode,
    contractVersion: theme.contractVersion,
    panels: theme.panels,
    features: theme.features,
    vocab: theme.vocab,
    metadata: theme.metadata,
  }));
}

// ============================================================================
// HR fixed styles
//
// Core product principle: a tenant picks ONE of these 5 fixed styles, ONE
// brand color (palette.primary), and a logo — they do NOT design themes. Each
// style is a base palette + neutral defaults, expressed as a normalizeThemeConfig
// seed. The tenant override model is `{ palette: { primary }, logoUrl, styleKey }`.
// ============================================================================

const DEFAULT_STYLE_KEY = 'slate';

// ============================================================================
// Curated brand colors
//
// White-label model: a tenant picks ONE of 5 fixed styles + ONE of these 12
// curated brand colors (palette.primary) + a logo. No freeform color picker.
// Every hex below is pre-vetted for WCAG AA contrast on the styles' surfaces.
// ============================================================================

const COLORS = Object.freeze([
  { key: 'indigo', name: 'Indigo', hex: '#4F46E5' },
  { key: 'blue', name: 'Blue', hex: '#2563EB' },
  { key: 'teal', name: 'Teal', hex: '#0D9488' },
  { key: 'emerald', name: 'Emerald', hex: '#059669' },
  { key: 'green', name: 'Green', hex: '#16A34A' },
  { key: 'amber', name: 'Amber', hex: '#D97706' },
  { key: 'orange', name: 'Orange', hex: '#EA580C' },
  { key: 'red', name: 'Red', hex: '#DC2626' },
  { key: 'rose', name: 'Rose', hex: '#E11D48' },
  { key: 'pink', name: 'Pink', hex: '#DB2777' },
  { key: 'violet', name: 'Violet', hex: '#7C3AED' },
  { key: 'slate', name: 'Slate', hex: '#475569' },
]);

const COLOR_KEYS = Object.freeze(COLORS.map((c) => c.key));
const DEFAULT_COLOR_KEY = 'indigo';
const COLORS_BY_KEY = Object.freeze(
  COLORS.reduce((acc, c) => { acc[c.key] = c; return acc; }, {})
);

function normalizeColorKey(colorKey) {
  const key = cleanKey(colorKey, DEFAULT_COLOR_KEY);
  return COLORS_BY_KEY[key] ? key : DEFAULT_COLOR_KEY;
}

// Resolve a curated brand color key to its hex. Unknown/empty → default color.
function resolveColor(colorKey) {
  return COLORS_BY_KEY[normalizeColorKey(colorKey)].hex;
}

const FIXED_STYLE_SEEDS = Object.freeze({
  slate: {
    key: 'slate',
    label: 'Slate',
    palette: { primary: '#475569', background: '#FFFFFF', foreground: '#0F172A' },
    metadata: { mood: 'neutral', source: 'fixed' },
  },
  indigo: {
    key: 'indigo',
    label: 'Indigo',
    palette: { primary: '#4F46E5', background: '#FFFFFF', foreground: '#1E1B4B' },
    metadata: { mood: 'professional', source: 'fixed' },
  },
  emerald: {
    key: 'emerald',
    label: 'Emerald',
    palette: { primary: '#059669', background: '#FFFFFF', foreground: '#064E3B' },
    metadata: { mood: 'fresh', source: 'fixed' },
  },
  rose: {
    key: 'rose',
    label: 'Rose',
    palette: { primary: '#E11D48', background: '#FFFFFF', foreground: '#4C0519' },
    metadata: { mood: 'warm', source: 'fixed' },
  },
  mono: {
    key: 'mono',
    label: 'Mono',
    palette: { primary: '#171717', background: '#FFFFFF', foreground: '#0A0A0A' },
    metadata: { mood: 'minimal', source: 'fixed' },
  },
});

const FIXED_STYLE_KEYS = Object.freeze(Object.keys(FIXED_STYLE_SEEDS));

// Build the registry once. Each seed normalizes to an HR-vertical, GENERIC theme.
function createHrStyleRegistry() {
  return createThemeRegistry(FIXED_STYLE_SEEDS, { defaultKey: DEFAULT_STYLE_KEY });
}

const hrStyleRegistry = createHrStyleRegistry();

function normalizeStyleKey(styleKey) {
  const key = cleanKey(styleKey, DEFAULT_STYLE_KEY);
  return FIXED_STYLE_SEEDS[key] ? key : DEFAULT_STYLE_KEY;
}

// Resolve a runtime theme for a tenant from their stored brand record:
// `{ styleKey, colorKey, primary, logoUrl }`. The chosen fixed style supplies
// the base palette + neutral defaults; the tenant's single brand color
// overrides `palette.primary`; the logo is carried through on the theme.
//
// Brand primary resolution: a curated `colorKey` (one of COLOR_KEYS) takes
// precedence and resolves via COLORS; a raw `primary` hex is used only when no
// colorKey is supplied. When neither is given, fall back to DEFAULT_COLOR_KEY.
function resolveTenantTheme(tenant = {}) {
  const styleKey = normalizeStyleKey(tenant.styleKey);
  const base = hrStyleRegistry.get(styleKey);

  let colorKey;
  let primary;
  if (tenant.colorKey) {
    colorKey = normalizeColorKey(tenant.colorKey);
    primary = resolveColor(colorKey);
  } else {
    const rawPrimary = tenant.primary || tenant.primaryColor || tenant.palette?.primary;
    if (rawPrimary) {
      primary = rawPrimary;
    } else {
      colorKey = DEFAULT_COLOR_KEY;
      primary = resolveColor(colorKey);
    }
  }

  const logoUrl = tenant.logoUrl || tenant.logo || base.raw?.logoUrl;

  const override = { key: styleKey };
  if (primary) override.palette = { primary };
  if (logoUrl) override.logoUrl = logoUrl;

  const theme = composeTheme(base.raw, override, { inheritance: THEME_INHERITANCE_MODES.MERGE });
  theme.styleKey = styleKey;
  theme.colorKey = colorKey || null;
  theme.logoUrl = logoUrl || null;
  return theme;
}

module.exports = {
  THEME_CONTRACT_VERSION,
  VERTICALS,
  THEME_MODES,
  THEME_INHERITANCE_MODES,
  SLOT_GROUPS,
  cleanKey,
  normalizeVertical,
  normalizeMode,
  normalizeInheritance,
  deepMerge,
  composeTheme,
  normalizeThemeConfig,
  validateThemeContract,
  createThemeRegistry,
  resolveThemeSlots,
  resolveThemeSlot,
  createLazySlotResolver,
  buildThemeManifest,
  buildBackendThemeManifest,
  // HR fixed-style system
  HR,
  HR_VERTICAL,
  DEFAULT_STYLE_KEY,
  FIXED_STYLE_SEEDS,
  FIXED_STYLE_KEYS,
  createHrStyleRegistry,
  hrStyleRegistry,
  normalizeStyleKey,
  resolveTenantTheme,
  // Curated brand colors
  COLORS,
  COLOR_KEYS,
  DEFAULT_COLOR_KEY,
  normalizeColorKey,
  resolveColor,
};
