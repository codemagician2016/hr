// Pure-function tests for intake-form helpers (validation + conditional logic).

const {
  FIELD_TYPES,
  validateFieldDef,
  validateFieldsArray,
  shouldShow,
  validateSubmission,
} = require('../../src/core/lib/intakeForms');

describe('FIELD_TYPES', () => {
  test('contains the 12 supported field types', () => {
    expect(FIELD_TYPES).toEqual(expect.arrayContaining([
      'text', 'textarea', 'email', 'phone', 'number',
      'select', 'radio', 'checkbox', 'date',
      'file', 'signature', 'markdown',
    ]));
    expect(FIELD_TYPES.length).toBe(12);
  });
});

describe('validateFieldDef', () => {
  test('valid text field passes', () => {
    expect(validateFieldDef({ id: 'f1', type: 'text', label: 'Name' })).toBeNull();
  });

  test('missing id fails', () => {
    expect(validateFieldDef({ type: 'text', label: 'X' })).toMatch(/Field id/);
  });

  test('unknown type fails', () => {
    expect(validateFieldDef({ id: 'f', type: 'crazy', label: 'X' })).toMatch(/not supported/);
  });

  test('select without options fails', () => {
    expect(validateFieldDef({ id: 'f', type: 'select', label: 'X' })).toMatch(/options/);
  });

  test('select with options passes', () => {
    expect(validateFieldDef({ id: 'f', type: 'select', label: 'X', options: ['A', 'B'] })).toBeNull();
  });

  test('markdown without label is OK (info-only)', () => {
    expect(validateFieldDef({ id: 'f', type: 'markdown' })).toBeNull();
  });

  test('non-markdown without label fails', () => {
    expect(validateFieldDef({ id: 'f', type: 'text' })).toMatch(/label is required/);
  });

  test('showIf with bad operator fails', () => {
    expect(validateFieldDef({
      id: 'f', type: 'text', label: 'X',
      showIf: { fieldId: 'g', operator: 'crazy', value: 'y' },
    })).toMatch(/showIf.operator/);
  });

  test('valid showIf passes', () => {
    expect(validateFieldDef({
      id: 'f', type: 'text', label: 'X',
      showIf: { fieldId: 'g', operator: 'equals', value: 'yes' },
    })).toBeNull();
  });
});

describe('validateFieldsArray', () => {
  test('empty array is valid', () => {
    expect(validateFieldsArray([])).toEqual({ ok: true, errors: [] });
  });

  test('non-array fails', () => {
    expect(validateFieldsArray('nope').ok).toBe(false);
  });

  test('catches duplicate IDs', () => {
    const r = validateFieldsArray([
      { id: 'f1', type: 'text', label: 'A' },
      { id: 'f1', type: 'email', label: 'B' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /duplicate id/i.test(e))).toBe(true);
  });

  test('valid mixed array passes', () => {
    expect(validateFieldsArray([
      { id: 'f1', type: 'text', label: 'A' },
      { id: 'f2', type: 'email', label: 'B' },
      { id: 'f3', type: 'select', label: 'C', options: ['x', 'y'] },
      { id: 'f4', type: 'markdown' },
    ])).toEqual({ ok: true, errors: [] });
  });
});

describe('shouldShow', () => {
  test('no showIf → always show', () => {
    expect(shouldShow({ field: { id: 'a' }, answers: {} })).toBe(true);
  });

  test('equals operator', () => {
    const f = { id: 'a', showIf: { fieldId: 'gender', operator: 'equals', value: 'female' } };
    expect(shouldShow({ field: f, answers: { gender: 'female' } })).toBe(true);
    expect(shouldShow({ field: f, answers: { gender: 'male' } })).toBe(false);
  });

  test('notEquals operator', () => {
    const f = { id: 'a', showIf: { fieldId: 'g', operator: 'notEquals', value: 'no' } };
    expect(shouldShow({ field: f, answers: { g: 'yes' } })).toBe(true);
    expect(shouldShow({ field: f, answers: { g: 'no' } })).toBe(false);
  });

  test('contains operator with array answer', () => {
    const f = { id: 'a', showIf: { fieldId: 'allergies', operator: 'contains', value: 'peanuts' } };
    expect(shouldShow({ field: f, answers: { allergies: ['nuts', 'peanuts'] } })).toBe(true);
    expect(shouldShow({ field: f, answers: { allergies: ['nuts'] } })).toBe(false);
  });

  test('notEmpty operator', () => {
    const f = { id: 'a', showIf: { fieldId: 'x', operator: 'notEmpty' } };
    expect(shouldShow({ field: f, answers: { x: 'something' } })).toBe(true);
    expect(shouldShow({ field: f, answers: { x: '' } })).toBe(false);
    expect(shouldShow({ field: f, answers: {} })).toBe(false);
    expect(shouldShow({ field: f, answers: { x: [] } })).toBe(false);
  });
});

describe('validateSubmission', () => {
  test('required text field empty → error', () => {
    const r = validateSubmission({
      fields: [{ id: 'name', type: 'text', label: 'Name', required: true }],
      answers: {},
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].fieldId).toBe('name');
  });

  test('required text field filled → pass', () => {
    expect(validateSubmission({
      fields: [{ id: 'name', type: 'text', label: 'Name', required: true }],
      answers: { name: 'Sarah' },
    }).ok).toBe(true);
  });

  test('email validation', () => {
    const fields = [{ id: 'e', type: 'email', label: 'Email', required: true }];
    expect(validateSubmission({ fields, answers: { e: 'sarah@example.com' } }).ok).toBe(true);
    expect(validateSubmission({ fields, answers: { e: 'not an email' } }).ok).toBe(false);
  });

  test('select with invalid option → error', () => {
    expect(validateSubmission({
      fields: [{ id: 's', type: 'select', label: 'X', required: true, options: ['A', 'B'] }],
      answers: { s: 'C' },
    }).ok).toBe(false);
  });

  test('checkbox with invalid array option → error', () => {
    expect(validateSubmission({
      fields: [{ id: 'c', type: 'checkbox', label: 'X', options: ['A', 'B'] }],
      answers: { c: ['A', 'NOT_AN_OPTION'] },
    }).ok).toBe(false);
  });

  test('hidden field (showIf=false) skips validation even if required', () => {
    const r = validateSubmission({
      fields: [
        { id: 'gender', type: 'radio', label: 'Gender', options: ['M', 'F'] },
        { id: 'preg', type: 'radio', label: 'Pregnant?', required: true, options: ['Y', 'N'],
          showIf: { fieldId: 'gender', operator: 'equals', value: 'F' } },
      ],
      answers: { gender: 'M' }, // preg should be hidden, no error
    });
    expect(r.ok).toBe(true);
  });

  test('signature must be base64 data URL', () => {
    const fields = [{ id: 'sig', type: 'signature', label: 'Sign', required: true }];
    expect(validateSubmission({ fields, answers: { sig: 'data:image/png;base64,iVBOR...' } }).ok).toBe(true);
    expect(validateSubmission({ fields, answers: { sig: 'just text' } }).ok).toBe(false);
  });

  test('date validation', () => {
    const fields = [{ id: 'd', type: 'date', label: 'X' }];
    expect(validateSubmission({ fields, answers: { d: '2026-04-29' } }).ok).toBe(true);
    expect(validateSubmission({ fields, answers: { d: 'not a date' } }).ok).toBe(false);
  });

  test('phone too short → error', () => {
    expect(validateSubmission({
      fields: [{ id: 'p', type: 'phone', label: 'X' }],
      answers: { p: '12' },
    }).ok).toBe(false);
  });

  test('multiple errors collected', () => {
    const r = validateSubmission({
      fields: [
        { id: 'n', type: 'text', label: 'Name', required: true },
        { id: 'e', type: 'email', label: 'Email', required: true },
      ],
      answers: { e: 'not-email' },
    });
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});
