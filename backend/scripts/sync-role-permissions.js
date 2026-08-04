'use strict';

/**
 * sync-role-permissions.js — backfill NEW permission keys into persisted roles.
 *
 * Why this exists: `SYSTEM_ROLES` in core/lib/rbac.js is the preset for each
 * built-in role, but a tenant's roles are COPIED into BusinessRole rows when the
 * tenant is provisioned. Every feature that adds a permission key therefore
 * leaves every existing tenant's roles one key short, and their admins get a 403
 * on the new screen with no clue why. This has bitten us on canManageLetters,
 * the performance keys, and (as of this writing) six more:
 * canManageSurveys, canManageRecognition, canFulfilRedemptions, canViewReports,
 * canScheduleReports, canManageSso.
 *
 * It is ADDITIVE and idempotent — safe to run on every deploy:
 *   - Only roles whose name matches a preset (or a LEGACY_NAMES alias) are touched.
 *     A tenant's own custom roles are never modified.
 *   - Only keys ABSENT from the stored permissions are added. A key an admin
 *     deliberately set to false stays false — we backfill gaps, we don't reset
 *     a role to the preset.
 *
 * Run:  node scripts/sync-role-permissions.js [--dry-run]
 */

const prisma = require('../src/core/lib/prisma');
const { SYSTEM_ROLES } = require('../src/core/lib/rbac');

// Seeded/legacy role names that mean a preset role but don't match its key.
// The HR seeder names the role "HR Administrator"; the preset key is "HR-Admin".
const LEGACY_NAMES = {
  'HR Administrator': 'HR-Admin',
  'HR Admin': 'HR-Admin',
  Administrator: 'Owner',
};

function presetFor(roleName) {
  if (SYSTEM_ROLES[roleName]) return SYSTEM_ROLES[roleName];
  const alias = LEGACY_NAMES[roleName];
  return alias ? SYSTEM_ROLES[alias] : null;
}

async function syncRolePermissions({ dryRun = false, log = console.log } = {}) {
  const roles = await prisma.businessRole.findMany({
    select: { id: true, name: true, businessId: true, permissions: true },
  });

  let updated = 0;
  let keysAdded = 0;
  for (const role of roles) {
    const preset = presetFor(role.name);
    if (!preset) continue; // a tenant's own custom role — leave it alone.

    const current = (role.permissions && typeof role.permissions === 'object') ? role.permissions : {};
    // Add only the keys the preset GRANTS and the role has never seen. An
    // explicit false stays false.
    const missing = Object.keys(preset).filter((k) => preset[k] === true && !(k in current));
    if (missing.length === 0) continue;

    const next = { ...current };
    for (const k of missing) next[k] = true;

    if (!dryRun) {
      await prisma.businessRole.update({ where: { id: role.id }, data: { permissions: next } });
    }
    updated += 1;
    keysAdded += missing.length;
    log(`  ${dryRun ? '[dry-run] ' : ''}${role.name} (${role.businessId}) += ${missing.join(', ')}`);
  }

  log(`[sync-role-permissions] ${dryRun ? 'would update' : 'updated'} ${updated} role(s), ${keysAdded} key(s) backfilled (${roles.length} scanned)`);
  return { scanned: roles.length, updated, keysAdded };
}

module.exports = { syncRolePermissions, presetFor, LEGACY_NAMES };

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  syncRolePermissions({ dryRun })
    .then(async () => { await prisma.$disconnect(); })
    .catch(async (e) => {
      console.error('[sync-role-permissions] failed:', e.message);
      await prisma.$disconnect();
      process.exit(1);
    });
}
