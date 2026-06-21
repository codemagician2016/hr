const ADMIN_CORE_VERSION = 1;

function createPanelDefinition(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('Panel definition must be an object.');
  }
  if (!definition.key) {
    throw new TypeError('Panel definition requires a key.');
  }
  return {
    version: ADMIN_CORE_VERSION,
    vertical: 'shared',
    group: 'Main',
    requiredFeatures: [],
    ...definition,
    key: String(definition.key),
  };
}

function filterPanelsForFeatures(panels, features = {}) {
  return (panels || []).filter((panel) => {
    const required = panel.requiredFeatures || [];
    return required.every((key) => Boolean(features[key]));
  });
}

function createPanelRegistry(panels = []) {
  const registry = new Map();
  for (const panel of panels) {
    const definition = createPanelDefinition(panel);
    registry.set(definition.key, definition);
  }
  return {
    get: (key) => registry.get(String(key)),
    keys: () => Array.from(registry.keys()),
    list: (filter = {}) => Array.from(registry.values()).filter((panel) => {
      if (filter.vertical && panel.vertical !== filter.vertical) return false;
      if (filter.group && panel.group !== filter.group) return false;
      return true;
    }),
    forFeatures: (features = {}) => filterPanelsForFeatures(Array.from(registry.values()), features),
  };
}

const GROCERY_ADMIN_PANEL_KEYS = Object.freeze([
  'overview',
  'orders',
  'products',
  'inventory',
  'customers',
  'ecom-coupons',
  'banners',
  'cms',
  'ecom-notifications',
  'reviews',
  'slots',
  'riders',
  'returns',
  'bulk',
  'payments',
  'ecom-reports',
  'tax',
  'cities',
  'roles',
  'ecom-staff',
  'activity',
]);

module.exports = {
  ADMIN_CORE_VERSION,
  createPanelDefinition,
  createPanelRegistry,
  filterPanelsForFeatures,
  GROCERY_ADMIN_PANEL_KEYS,
};
