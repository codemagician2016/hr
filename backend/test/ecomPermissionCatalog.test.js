// Unit tests for the ECOMMERCE Path B permission catalog.
// Pure constants — no DB, no Express. Verifies the catalog stays
// self-consistent (24 perms × 6 areas, key uniqueness, dot.notation,
// system-role grants point to real permission keys).

const {
  ECOM_PERMISSIONS,
  ECOM_PERMISSION_KEYS,
  ECOM_SYSTEM_ROLES,
} = require('../src/core/lib/ecomPermissionCatalog');

const EXPECTED_AREAS = ['orders', 'catalogue', 'inventory', 'customers', 'finance', 'system'];

describe('ECOM_PERMISSIONS catalog', () => {
  test('contains exactly 24 permissions', () => {
    expect(ECOM_PERMISSIONS.length).toBe(24);
  });

  test('covers exactly 6 areas with 4 permissions each', () => {
    const counts = {};
    for (const p of ECOM_PERMISSIONS) {
      counts[p.area] = (counts[p.area] || 0) + 1;
    }
    expect(Object.keys(counts).sort()).toEqual([...EXPECTED_AREAS].sort());
    for (const area of EXPECTED_AREAS) {
      expect(counts[area]).toBe(4);
    }
  });

  test('every permission has the required shape', () => {
    for (const p of ECOM_PERMISSIONS) {
      expect(typeof p.key).toBe('string');
      expect(p.key.length).toBeGreaterThan(0);
      expect(p.key).toMatch(/^[a-z]+(\.[a-z_]+)+$/); // dot.notation, snake-allowed
      expect(EXPECTED_AREAS).toContain(p.area);
      expect(typeof p.label).toBe('string');
      expect(p.label.length).toBeGreaterThan(0);
      expect(typeof p.weight).toBe('number');
      expect(p.weight).toBeGreaterThan(0);
    }
  });

  test('permission keys are unique', () => {
    const keys = ECOM_PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every permission key is namespaced to its area', () => {
    for (const p of ECOM_PERMISSIONS) {
      expect(p.key.startsWith(`${p.area}.`)).toBe(true);
    }
  });

  test('ECOM_PERMISSION_KEYS Set matches the catalog', () => {
    expect(ECOM_PERMISSION_KEYS.size).toBe(ECOM_PERMISSIONS.length);
    for (const p of ECOM_PERMISSIONS) {
      expect(ECOM_PERMISSION_KEYS.has(p.key)).toBe(true);
    }
  });
});

describe('ECOM_SYSTEM_ROLES presets', () => {
  test('Owner gets the wildcard "*" so future perms inherit', () => {
    expect(ECOM_SYSTEM_ROLES.Owner).toBe('*');
  });

  test('every non-Owner role grants only valid permission keys', () => {
    for (const [roleName, grants] of Object.entries(ECOM_SYSTEM_ROLES)) {
      if (roleName === 'Owner') continue;
      expect(Array.isArray(grants)).toBe(true);
      for (const key of grants) {
        expect(ECOM_PERMISSION_KEYS.has(key)).toBe(true);
      }
    }
  });

  test('every system role exists and has a non-empty grant list', () => {
    const expected = ['Owner', 'Manager', 'Inventory', 'Support', 'Marketing', 'ReadOnly'];
    for (const name of expected) {
      expect(ECOM_SYSTEM_ROLES).toHaveProperty(name);
      const grants = ECOM_SYSTEM_ROLES[name];
      if (name === 'Owner') {
        expect(grants).toBe('*');
      } else {
        expect(Array.isArray(grants)).toBe(true);
        expect(grants.length).toBeGreaterThan(0);
      }
    }
  });

  test('Manager has broader scope than Inventory', () => {
    expect(ECOM_SYSTEM_ROLES.Manager.length).toBeGreaterThan(ECOM_SYSTEM_ROLES.Inventory.length);
  });

  test('ReadOnly never includes a destructive permission', () => {
    const destructive = [
      'orders.cancel', 'orders.refund', 'orders.edit',
      'catalogue.edit', 'catalogue.price', 'catalogue.delete',
      'inventory.adjust', 'inventory.transfer', 'inventory.grn',
      'customers.edit', 'customers.delete', 'customers.gdpr_export',
      'finance.settle', 'finance.tax_edit',
      'system.staff', 'system.roles', 'system.settings', 'system.integrations',
    ];
    for (const key of ECOM_SYSTEM_ROLES.ReadOnly) {
      expect(destructive).not.toContain(key);
    }
  });
});
