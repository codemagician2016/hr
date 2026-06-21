'use strict';

// ECOMMERCE Path B (2026-05-01) — relational permission catalog.
//
// 24 permissions × 6 areas, mirroring the prototype's roles.html matrix.
// Seeded into the `EcomPermission` table on backend startup via
// `seedEcomPermissions()` (idempotent upsert by `key`).
//
// Each permission has:
//   - key:         stable dot-notation identifier (e.g. 'orders.refund').
//                  Code reads against this; never changes once shipped.
//   - area:        one of 'orders' / 'catalogue' / 'inventory' /
//                  'customers' / 'finance' / 'system'. Drives the
//                  matrix UI's row grouping.
//   - label:       human-readable label shown in role builder.
//   - description: longer explanation shown on hover / detail.
//   - weight:      lower = more dangerous → sorted to top of its area
//                  in the UI so admins consider the destructive
//                  permissions first.
//
// System role presets (Owner / Manager / Inventory / Support / Marketing /
// Read-only) are seeded separately by `seedEcomSystemRoles()` — this
// file only defines the catalog of grantable permissions.

const ECOM_PERMISSIONS = Object.freeze([
  // ── Orders & fulfilment ────────────────────────────────────────────
  { key: 'orders.view',     area: 'orders', label: 'View orders',
    description: 'See order list and detail pages, customer info on orders, line items.',
    weight: 10 },
  { key: 'orders.edit',     area: 'orders', label: 'Edit orders',
    description: 'Change order status, add notes, update shipping info, replace items.',
    weight: 20 },
  { key: 'orders.cancel',   area: 'orders', label: 'Cancel orders',
    description: 'Cancel pending or paid orders. Releases reserved inventory and slots.',
    weight: 30 },
  { key: 'orders.refund',   area: 'orders', label: 'Issue refunds',
    description: 'Process partial or full refunds against the original payment method or store credit.',
    weight: 40 },

  // ── Catalogue ──────────────────────────────────────────────────────
  { key: 'catalogue.view',   area: 'catalogue', label: 'View catalogue',
    description: 'Browse products, categories, brands, and storefront preview.',
    weight: 10 },
  { key: 'catalogue.edit',   area: 'catalogue', label: 'Edit products & categories',
    description: 'Create and update products, descriptions, images, categories, brand assignments.',
    weight: 20 },
  { key: 'catalogue.price',  area: 'catalogue', label: 'Change prices',
    description: 'Update list price, sale price, and per-currency overrides on any product.',
    weight: 30 },
  { key: 'catalogue.delete', area: 'catalogue', label: 'Delete products',
    description: 'Soft-delete products (hidden from storefront) and hard-delete categories with no SKUs.',
    weight: 40 },

  // ── Inventory ──────────────────────────────────────────────────────
  { key: 'inventory.view',     area: 'inventory', label: 'View inventory',
    description: 'See on-hand and reserved counts per location, low-stock alerts, ledger.',
    weight: 10 },
  { key: 'inventory.adjust',   area: 'inventory', label: 'Adjust stock',
    description: 'Manual stock corrections (damage, theft, count adjustment) with audit trail.',
    weight: 20 },
  { key: 'inventory.transfer', area: 'inventory', label: 'Transfer between stores',
    description: 'Move inventory from one location to another. Both legs (ship + receive) audited.',
    weight: 30 },
  { key: 'inventory.grn',      area: 'inventory', label: 'Post goods receipt notes',
    description: 'Record incoming supplier deliveries, post to the ledger, attach invoices.',
    weight: 40 },

  // ── Customers ──────────────────────────────────────────────────────
  { key: 'customers.view',         area: 'customers', label: 'View customers',
    description: 'See customer list, profiles, order history, addresses, lifetime value.',
    weight: 10 },
  { key: 'customers.edit',         area: 'customers', label: 'Edit customer details',
    description: 'Update customer contact info, tags, segment membership, marketing opt-in.',
    weight: 20 },
  { key: 'customers.gdpr_export',  area: 'customers', label: 'GDPR export',
    description: 'Export a customer’s full record for data-subject access requests.',
    weight: 30 },
  { key: 'customers.delete',       area: 'customers', label: 'Delete customers',
    description: 'Hard-delete a customer and anonymise their order history (irreversible).',
    weight: 40 },

  // ── Finance ────────────────────────────────────────────────────────
  { key: 'finance.view',     area: 'finance', label: 'View finance',
    description: 'See payment ledger, settlement reports, gateway fees, cash reconciliation.',
    weight: 10 },
  { key: 'finance.settle',   area: 'finance', label: 'Process settlements',
    description: 'Mark settlements as paid, attach bank-statement matches, reconcile gateways.',
    weight: 20 },
  { key: 'finance.export',   area: 'finance', label: 'Export finance data',
    description: 'Download CSV/PDF of payments, refunds, settlements for accounting handoff.',
    weight: 30 },
  { key: 'finance.tax_edit', area: 'finance', label: 'Edit tax rates & invoicing',
    description: 'Change UK VAT, Indian GST, per-product tax categories, and invoice templates.',
    weight: 40 },

  // ── System ─────────────────────────────────────────────────────────
  { key: 'system.staff',        area: 'system', label: 'Manage staff',
    description: 'Invite, suspend, depart staff. Assign locations and basic profile.',
    weight: 10 },
  { key: 'system.roles',        area: 'system', label: 'Manage roles & permissions',
    description: 'Create and edit roles, grant or revoke permissions, set per-location scope.',
    weight: 20 },
  { key: 'system.settings',     area: 'system', label: 'Edit business settings',
    description: 'Update business name, branding, locations, hours, delivery zones, tax setup.',
    weight: 30 },
  { key: 'system.integrations', area: 'system', label: 'Manage integrations',
    description: 'Connect/disconnect payment gateways, accounting tools, marketing channels.',
    weight: 40 },
]);

// Set of valid keys for fast `has()` checks during permission validation.
const ECOM_PERMISSION_KEYS = Object.freeze(new Set(ECOM_PERMISSIONS.map((p) => p.key)));

// System role presets — mirrors the 6 roles in the prototype's matrix.
// Boolean true = granted. Missing key = not granted. Owner gets every
// permission, including any added in future migrations.
const ECOM_SYSTEM_ROLES = Object.freeze({
  Owner: '*', // grant every permission, including future ones
  Manager: [
    'orders.view', 'orders.edit', 'orders.cancel', 'orders.refund',
    'catalogue.view', 'catalogue.edit', 'catalogue.price',
    'inventory.view', 'inventory.adjust', 'inventory.transfer',
    'customers.view', 'customers.edit',
    'finance.view',
    'system.staff', 'system.settings',
  ],
  Inventory: [
    'inventory.view', 'inventory.adjust', 'inventory.transfer', 'inventory.grn',
  ],
  Support: [
    'orders.view', 'orders.edit', 'orders.cancel', 'orders.refund',
    'catalogue.view',
    'inventory.view',
    'customers.view', 'customers.edit',
  ],
  Marketing: [
    'catalogue.view', 'catalogue.edit', 'catalogue.price',
    'customers.view',
  ],
  ReadOnly: [
    'orders.view',
    'catalogue.view',
    'inventory.view',
    'customers.view',
    'finance.view', 'finance.export',
  ],
});

module.exports = {
  ECOM_PERMISSIONS,
  ECOM_PERMISSION_KEYS,
  ECOM_SYSTEM_ROLES,
};
