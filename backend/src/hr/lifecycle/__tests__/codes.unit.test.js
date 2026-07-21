'use strict';

/*
 * codes.unit.test.js — P1.7 token expansion + the null-ctx regression guard.
 * (expandTokens received an EXPLICIT null from allocateCode's tokenCtx default;
 * a `ctx = {}` parameter default does not apply to null and `null.year` broke
 * EVERY token-less allocateCode call — separations, journeys, letters, claims.)
 * Plain-node: node backend/src/hr/lifecycle/__tests__/codes.unit.test.js
 */

const assert = require('assert');
const { format, expandTokens } = require('../lib/codes');

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed += 1; }

const YYYY = String(new Date().getUTCFullYear());
const YY = YYYY.slice(-2);

// The regression: explicit null/undefined ctx must behave like no tokens.
ok('null ctx does not throw (the SEP-000123 path)', format('SEP-', 123, 6, null) === 'SEP-000123');
ok('undefined ctx (legacy 3-arg calls)', format('EMP-', 42, 6) === 'EMP-000042');
ok('expandTokens(null prefix, null ctx)', expandTokens(null, null) === '');

// Token expansion.
ok('entity+year tokens', format('EMP-{ENTITY}-{YY}-', 42, 4, { entityCode: 'BLR', year: 2026 }) === 'EMP-BLR-26-0042');
ok('YYYY token defaults to current year', format('E{YYYY}-', 7, 3, {}) === `E${YYYY}-007`);
ok('missing token values collapse to empty', format('X{DEPT}{ENTITY}-', 1, 2, null) === 'X-01');
ok('YY with null ctx = current year', expandTokens('{YY}', null) === YY);

console.log(`codes.unit: ${passed} checks passed`);
