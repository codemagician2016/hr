const {
  THEME_CONTRACT_VERSION,
  VERTICALS,
  THEME_MODES,
  THEME_INHERITANCE_MODES,
  SLOT_GROUPS,
} = require('@hr/types');

const VERTICAL_ALIASES = Object.freeze({
  booking: VERTICALS.APPOINTMENT,
  appointment: VERTICALS.APPOINTMENT,
  appointments: VERTICALS.APPOINTMENT,
  service: VERTICALS.APPOINTMENT,
  shop: VERTICALS.ECOMMERCE,
  ecommerce: VERTICALS.ECOMMERCE,
  e_commerce: VERTICALS.ECOMMERCE,
  commerce: VERTICALS.ECOMMERCE,
  web: VERTICALS.STATIC,
  website: VERTICALS.STATIC,
  static: VERTICALS.STATIC,
});

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

function normalizeVertical(value, fallback = VERTICALS.APPOINTMENT) {
  const raw = String(value || fallback).trim();
  const upper = raw.toUpperCase();
  if (VERTICALS[upper]) return VERTICALS[upper];
  return VERTICAL_ALIASES[cleanKey(raw, '')] || fallback;
}

function normalizeMode(value, fallback = THEME_MODES.MIXED) {
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
};
