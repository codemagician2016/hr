'use strict';

// ECOMMERCE Path B (2026-05-01) — idempotent permission catalog seeder.
//
// Runs at backend startup (after Prisma is wired) to ensure the
// EcomPermission table mirrors the canonical catalog in
// `ecomPermissionCatalog.js`. Safe to run repeatedly:
//   - inserts new permissions (added in future releases)
//   - updates label / description / area / weight on existing permissions
//   - never deletes — removed permissions stay in the table as orphans
//     so existing grants don't cascade-delete in production. Operators
//     can prune them manually after auditing impact.
//
// Importable in tests too, so we can call it before assertions that
// rely on the catalog being present.

const prisma = require('./prisma');
const { ECOM_PERMISSIONS } = require('./ecomPermissionCatalog');

let seededOnce = false;
let inFlight = null;

/**
 * Upsert the canonical permission catalog into EcomPermission.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] - force re-seed even if already done in this process
 * @returns {Promise<{ inserted: number, updated: number, total: number }>}
 */
async function seedEcomPermissions(opts = {}) {
  if (seededOnce && !opts.force) {
    return { inserted: 0, updated: 0, total: ECOM_PERMISSIONS.length, skipped: true };
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let inserted = 0;
    let updated = 0;
    for (const perm of ECOM_PERMISSIONS) {
      const existing = await prisma.ecomPermission.findUnique({
        where: { key: perm.key },
        select: { id: true, area: true, label: true, description: true, weight: true },
      });
      if (existing) {
        const drift =
          existing.area !== perm.area ||
          existing.label !== perm.label ||
          existing.description !== (perm.description || null) ||
          existing.weight !== perm.weight;
        if (drift) {
          await prisma.ecomPermission.update({
            where: { key: perm.key },
            data: {
              area: perm.area,
              label: perm.label,
              description: perm.description || null,
              weight: perm.weight,
            },
          });
          updated += 1;
        }
      } else {
        await prisma.ecomPermission.create({
          data: {
            key: perm.key,
            area: perm.area,
            label: perm.label,
            description: perm.description || null,
            weight: perm.weight,
          },
        });
        inserted += 1;
      }
    }
    seededOnce = true;
    return { inserted, updated, total: ECOM_PERMISSIONS.length };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  seedEcomPermissions,
};
