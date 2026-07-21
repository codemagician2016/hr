'use strict';

/*
 * probationPolicy.unit.test.js — Program P1.4: most-specific-wins resolution.
 * Plain-node: node backend/src/hr/lifecycle/__tests__/probationPolicy.unit.test.js
 */

const assert = require('assert');
const { resolveProbationPolicy } = require('../controllers/probation.controller');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

const rows = [
  { id: 'tenant', entityId: null, employmentType: null, probationDays: 90, isActive: true },
  { id: 'type', entityId: null, employmentType: 'INTERN', probationDays: 30, isActive: true },
  { id: 'entity', entityId: 'E1', employmentType: null, probationDays: 120, isActive: true },
  { id: 'both', entityId: 'E1', employmentType: 'FULL_TIME', probationDays: 180, isActive: true },
];
const db = (list) => ({ probationPolicy: { findMany: async () => list } });

(async () => {
  const at = (entityId, employmentType) => resolveProbationPolicy(db(rows), { businessId: 'B', entityId, employmentType });

  ok('entity+type wins', (await at('E1', 'FULL_TIME')).id === 'both');
  ok('entity beats type', (await at('E1', 'INTERN')).id === 'entity');
  ok('type matches when no entity row', (await at('E2', 'INTERN')).id === 'type');
  ok('tenant-wide fallback', (await at('E2', 'FULL_TIME')).id === 'tenant');
  ok('no rows → null', (await resolveProbationPolicy(db([]), { businessId: 'B' })) === null);
  ok('scoped rows never match a different scope',
    (await resolveProbationPolicy(db([rows[3]]), { businessId: 'B', entityId: 'E2', employmentType: 'FULL_TIME' })) === null);

  console.log(`probationPolicy.unit: ${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
