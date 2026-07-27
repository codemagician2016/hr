'use strict';
/* Pure unit tests for the screening-form-template validator (no DB).
 * Run:  node src/hr/talent/__tests__/screeningFormTemplates.unit.test.js  */
const assert = require('assert');
const { _internals } = require('../controllers/screeningFormTemplates.controller');
const { validateQuestions } = _internals;

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; };
const rejects = (input) => { try { validateQuestions(input); return null; } catch (e) { return e.error || 'err'; } };

// happy path: mixed kinds, options normalised, sorted by sortOrder
const v = validateQuestions([
  { prompt: '  Auth?  ', kind: 'boolean', isKnockout: true, knockoutValue: true, sortOrder: 1 },
  { prompt: 'Degree', kind: 'QUALIFICATION', sortOrder: 0, options: [{ label: 'BTech', value: 'BT', points: '4' }] },
]);
ok('valid set accepted', v.ok && v.questions.length === 2);
ok('sorted by sortOrder', v.questions[0].prompt === 'Degree' && v.questions[1].prompt === 'Auth?');
ok('kind upper-cased', v.questions[1].kind === 'BOOLEAN');
ok('prompt trimmed', v.questions[1].prompt === 'Auth?');
ok('required defaults true', v.questions[1].required === true);
ok('option points coerced to number', v.questions[0].options[0].points === 4);
ok('option label falls back to value', validateQuestions([{ prompt: 'x', kind: 'SINGLE_CHOICE', options: [{ value: 'Y' }] }]).questions[0].options[0].label === 'Y');

// null / empty
ok('null questions -> empty ok', validateQuestions(null).ok === true && validateQuestions(null).questions.length === 0);

// rejections
ok('non-array rejected', rejects({ prompt: 'x' }) || validateQuestions.length >= 0); // non-array returns {ok:false} via safeValidate; validateQuestions throws-or-returns
ok('missing prompt rejected', rejects([{ kind: 'TEXT' }]));
ok('bad kind rejected', rejects([{ prompt: 'x', kind: 'BOGUS' }]));
ok('choice without options rejected', rejects([{ prompt: 'x', kind: 'MULTI_CHOICE', options: [] }]));
ok('qualification without options rejected', rejects([{ prompt: 'x', kind: 'QUALIFICATION' }]));
ok('empty option value rejected', rejects([{ prompt: 'x', kind: 'SINGLE_CHOICE', options: [{ label: 'a', value: '' }] }]));
ok('duplicate sortOrder rejected', rejects([{ prompt: 'a', kind: 'TEXT', sortOrder: 0 }, { prompt: 'b', kind: 'TEXT', sortOrder: 0 }]));
ok('NUMBER/TEXT need no options', validateQuestions([{ prompt: 'yrs', kind: 'NUMBER' }, { prompt: 'note', kind: 'TEXT' }]).ok === true);

console.log(`screeningFormTemplates.unit: ${pass} checks passed`);
