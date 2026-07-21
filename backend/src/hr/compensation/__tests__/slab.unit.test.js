'use strict';

/*
 * slab.unit.test.js — Program P1.3 custom SLAB components. Pure checks over
 * evaluateSlab + deriveBreakup integration (earning slab on GROSS, deduction
 * slab on GROSS, slab on a named base, floor/cap clamp on a slab line).
 * Plain-node: node backend/src/hr/compensation/__tests__/slab.unit.test.js
 */

const assert = require('assert');
const { deriveBreakup, _internal } = require('../deriveBreakup');
const { evaluateSlab } = _internal;

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

// ── evaluateSlab (bands are in MAJOR units; results in minor/paise) ──
const bands = [
  { upTo: 10000, value: 200, valueType: 'FLAT' },
  { upTo: 20000, value: 400, valueType: 'FLAT' },
  { upTo: null, value: 2, valueType: 'PERCENT' },
];
ok('band 1 lookup', evaluateSlab(bands, 800000) === 20000); // 8k base → ₹200
ok('boundary is inclusive', evaluateSlab(bands, 1000000) === 20000); // exactly 10k → band 1
ok('band 2 lookup', evaluateSlab(bands, 1500000) === 40000); // 15k → ₹400
ok('open PERCENT band', evaluateSlab(bands, 5000000) === 100000); // 50k → 2% = ₹1000
ok('unsorted bands sort', evaluateSlab([bands[2], bands[1], bands[0]], 800000) === 20000);
ok('no match above bounded top → 0', evaluateSlab(bands.slice(0, 2), 2500000) === 0);
ok('empty/null slabs → 0', evaluateSlab([], 100) === 0 && evaluateSlab(null, 100) === 0);

// ── deriveBreakup integration ──
const comp = (over) => ({
  id: over.code, code: over.code, name: over.code, kind: over.kind || 'CUSTOM',
  category: over.category || 'EARNING', calcMethod: over.calcMethod,
  calcBaseScope: over.calcBaseScope || 'SINGLE', calcBaseCode: over.calcBaseCode || null,
  slabsJson: over.slabsJson || null, derivationPass: over.derivationPass != null ? over.derivationPass : 0,
  floorValue: over.floorValue != null ? over.floorValue : null,
  capValue: over.capValue != null ? over.capValue : null,
});
const line = (c, extra = {}) => ({ component: c, calcMethod: c.calcMethod, ...extra });

// GROSS 50k: BASIC 50% of gross, slab attendance-bonus (≤30k→500 else 1%), balancing fills.
{
  const r = deriveBreakup({
    target: { grossMonthlyMinor: 5000000 }, basis: 'GROSS',
    lines: [
      line(comp({ code: 'BASIC', kind: 'BASIC', calcMethod: 'PERCENT_OF', calcBaseScope: 'GROSS', derivationPass: 2 }), { calcValue: 50 }),
      line(comp({ code: 'ATTBON', calcMethod: 'SLAB', calcBaseScope: 'GROSS', slabsJson: [{ upTo: 30000, value: 500, valueType: 'FLAT' }, { upTo: null, value: 1, valueType: 'PERCENT' }] })),
      line(comp({ code: 'SPECIAL', calcMethod: 'BALANCING', derivationPass: 3 })),
    ],
    ctx: { countryCode: 'IN' },
  });
  const by = Object.fromEntries(r.resolved.map((x) => [x.code, x.amountMonthlyMinor]));
  ok('earning slab: 50k gross → 1% band = ₹500', by.ATTBON === 50000);
  ok('balancing reconciles with slab present', r.grossMinor === 5000000);
  ok('basic still 50%', by.BASIC === 2500000);
}

// Deduction slab banded by GROSS (canteen: ≤20k→100, else 250).
{
  const r = deriveBreakup({
    target: { grossMonthlyMinor: 1500000 }, basis: 'GROSS',
    lines: [
      line(comp({ code: 'BASIC', kind: 'BASIC', calcMethod: 'FLAT' }), { amountMonthly: 15000 }),
      line(comp({ code: 'CANTEEN', category: 'DEDUCTION', calcMethod: 'SLAB', calcBaseScope: 'GROSS', slabsJson: [{ upTo: 20000, value: 100, valueType: 'FLAT' }, { upTo: null, value: 250, valueType: 'FLAT' }] })),
    ],
    ctx: { countryCode: 'IN' },
  });
  const ded = r.resolved.find((x) => x.code === 'CANTEEN');
  ok('deduction slab on gross: 15k → ₹100', ded && ded.amountMonthlyMinor === 10000);
}

// Slab banded by a NAMED component (pass 1: needs BASIC first) + cap clamp.
{
  const r = deriveBreakup({
    target: { grossMonthlyMinor: 4000000 }, basis: 'GROSS',
    lines: [
      line(comp({ code: 'BASIC', kind: 'BASIC', calcMethod: 'PERCENT_OF', calcBaseScope: 'GROSS', derivationPass: 2 }), { calcValue: 50 }),
      line(comp({ code: 'CITYALL', calcMethod: 'SLAB', calcBaseScope: 'SINGLE', calcBaseCode: 'BASIC', capValue: 800, slabsJson: [{ upTo: 15000, value: 5, valueType: 'PERCENT' }, { upTo: null, value: 1000, valueType: 'FLAT' }] })),
      line(comp({ code: 'SPECIAL', calcMethod: 'BALANCING', derivationPass: 3 })),
    ],
    ctx: { countryCode: 'IN' },
  });
  const by = Object.fromEntries(r.resolved.map((x) => [x.code, x.amountMonthlyMinor]));
  // BASIC = 20k → open band ₹1000, capValue 800 clamps to ₹800.
  ok('named-base slab + cap clamp', by.CITYALL === 80000);
  ok('reconciles to target', r.grossMinor === 4000000);
}

console.log(`slab.unit: ${passed} checks passed`);
