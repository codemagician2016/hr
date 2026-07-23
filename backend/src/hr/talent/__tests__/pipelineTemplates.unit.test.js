'use strict';

/*
 * pipelineTemplates.unit.test.js — Recruitment pipeline template stage
 * materialisation (Phase 4 pure helpers). Plain-node, NO DB:
 *   node backend/src/hr/talent/__tests__/pipelineTemplates.unit.test.js
 *
 * Covers orderStagesForMaterialization (sort by sortOrder, stable ties,
 * contiguous 0-based re-sequencing that dedupes colliding/gappy sortOrders) and
 * validateStages (name required, StageKind whitelist, array/undefined handling).
 */

const assert = require('assert');
const { _internals } = require('../controllers/pipelineTemplates.controller');
const { orderStagesForMaterialization, validateStages, STAGE_KINDS } = _internals;

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

function main() {
  /* ── orderStagesForMaterialization ── */
  {
    // Out-of-order input sorts by sortOrder then re-sequences 0..n-1.
    const out = orderStagesForMaterialization([
      { name: 'Offer', kind: 'OFFER', sortOrder: 30 },
      { name: 'Sourced', kind: 'SOURCED', sortOrder: 10 },
      { name: 'Screening', kind: 'SCREENING', sortOrder: 20 },
    ]);
    ok('sorted by sortOrder', out.map((s) => s.name).join(',') === 'Sourced,Screening,Offer');
    ok('re-sequenced contiguous 0-based', out.map((s) => s.sortOrder).join(',') === '0,1,2');
    ok('kind preserved', out.map((s) => s.kind).join(',') === 'SOURCED,SCREENING,OFFER');
  }
  {
    // Colliding sortOrders → deterministic, unique output (stable on input order).
    const out = orderStagesForMaterialization([
      { name: 'A', kind: 'SOURCED', sortOrder: 5 },
      { name: 'B', kind: 'SCREENING', sortOrder: 5 },
      { name: 'C', kind: 'INTERVIEW', sortOrder: 5 },
    ]);
    ok('collisions keep input order (stable)', out.map((s) => s.name).join(',') === 'A,B,C');
    ok('collisions get unique sortOrders', out.map((s) => s.sortOrder).join(',') === '0,1,2');
  }
  {
    // Missing sortOrder falls back to the original index.
    const out = orderStagesForMaterialization([
      { name: 'First', kind: 'SOURCED' },
      { name: 'Second', kind: 'SCREENING' },
      { name: 'Third', kind: 'HIRED' },
    ]);
    ok('missing sortOrder → index order', out.map((s) => s.name).join(',') === 'First,Second,Third');
    ok('missing sortOrder re-sequenced', out.map((s) => s.sortOrder).join(',') === '0,1,2');
  }
  {
    ok('empty stages → empty', orderStagesForMaterialization([]).length === 0);
    ok('null stages → empty', orderStagesForMaterialization(null).length === 0);
  }

  /* ── validateStages ── */
  {
    ok('undefined → ok, empty', (() => { const v = validateStages(undefined); return v.ok && v.stages.length === 0; })());
    ok('non-array → error', validateStages('nope').ok === false);
    ok('valid stages → ok', validateStages([{ name: 'Sourced', kind: 'SOURCED' }]).ok === true);
    ok('missing name → error', validateStages([{ kind: 'SOURCED' }]).ok === false);
    ok('blank name → error', validateStages([{ name: '   ', kind: 'SOURCED' }]).ok === false);
    ok('bad kind → error', validateStages([{ name: 'X', kind: 'NOPE' }]).ok === false);
    ok('every real StageKind accepted', STAGE_KINDS.every((k) => validateStages([{ name: 'S', kind: k }]).ok));
  }

  console.log(`pipelineTemplates.unit: ${passed} checks passed`);
}

main();
