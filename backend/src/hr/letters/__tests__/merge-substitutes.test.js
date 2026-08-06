'use strict';

/**
 * merge-substitutes.test.js — the letter MERGE actually substitutes employee data.
 *
 * WHY THIS LIVES HERE AND NOT IN THE BROWSER SMOKE
 * ────────────────────────────────────────────────
 * The letters smoke (qa/smoke/letters.js) tried three times to prove this through
 * the rendered PDF and could not, because the renderer embeds SUBSET fonts: the
 * glyph runs decode to repeated 0x21 bytes, so
 *
 *   • searching the inflated text for the employee's name finds nothing, and
 *   • the companion "no {{tokens}} remain" check therefore passed VACUOUSLY, and
 *   • whole-file byte comparison is defeated by a producer timestamp, while
 *   • content-stream comparison appeared IDENTICAL for two different employees —
 *     which looked exactly like "the template is never merged".
 *
 * That last one nearly became a false defect report. If it had been real, every
 * experience certificate a company issues would be the same document regardless
 * of recipient — so it was worth settling properly rather than guessing either way.
 *
 * The answer: the merge is fine. Proving it needs the substitution tested BEFORE
 * PDF conversion, where font encoding cannot obscure the result. That is this test.
 */

const assert = require('assert');
const { resolveMergeData, renderMerge } = require('../mergeFields');

const BODY = 'This is to certify that {{employee.name}} (code {{employee.code}}) '
  + 'served as {{employee.designation}} at {{company.legalName}}.';

const DECLARED = {
  'employee.name': { type: 'string' },
  'employee.code': { type: 'string' },
  'employee.designation': { type: 'string' },
  'company.legalName': { type: 'string' },
};

// Mirrors letters.service.js's real call site. Building a different `sources`
// shape by hand silently yields EMPTY values — which is how this looked like a
// product bug in the first place.
function render(name, code, designation) {
  const [firstName, lastName] = name.split(' ');
  const { values } = resolveMergeData({
    employee: { name, code, designation, firstName, lastName },
    business: { legalName: 'Demo Co' },
    comp: null,
    entity: { countryCode: 'IN' },
    locale: 'en-IN',
    now: new Date('2026-01-01T00:00:00Z'),
    refNo: 'REF-1',
    authority: { name: 'HR Head', designation: 'Head' },
    perms: {},
    required: [],
    declared: DECLARED,
  });
  return renderMerge(BODY, values).text;
}

const a = render('Asha Rao', 'EMP-001', 'Engineer');
const b = render('Bilal Khan', 'EMP-002', 'Analyst');

assert(a.includes('Asha Rao'), `employee name must be substituted, got: ${a}`);
assert(a.includes('EMP-001'), `employee code must be substituted, got: ${a}`);
assert(a.includes('Engineer'), `designation must be substituted, got: ${a}`);
assert(a.includes('Demo Co'), `company name must be substituted, got: ${a}`);

// The one that matters: two different people must NOT produce the same letter.
assert(a !== b, 'two different employees produced an IDENTICAL letter body');
assert(b.includes('Bilal Khan') && !b.includes('Asha Rao'), `wrong employee merged: ${b}`);

// No placeholder may survive into a document that leaves the building.
const leftover = [...a.matchAll(/\{\{[^}]{1,40}\}\}/g)].map((m) => m[0]);
assert(leftover.length === 0, `unsubstituted tokens remain: ${leftover.join(' ')}`);

console.log('  PASS  letter merge substitutes employee data');
console.log('  PASS  two different employees render different letters');
console.log('  PASS  no unsubstituted tokens remain');
console.log('ALL PASS');
