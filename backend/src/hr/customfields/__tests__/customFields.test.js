'use strict';

/*
 * customFields.test.js — Phase 5b pure-function tests for the custom-fields service.
 * No DB: only the pure validators/normalisers/coercers are exercised. Run: npx jest
 */

const svc = require('../customFields.service');

// Assert that `fn` throws an Error whose service `code` === `code`.
function expectCode(fn, code) {
  let thrown;
  try { fn(); } catch (e) { thrown = e; }
  expect(thrown).toBeDefined();
  expect(thrown.code).toBe(code);
  expect(thrown.status).toBeGreaterThanOrEqual(400);
}

describe('slugifyKey', () => {
  test('lowercases + spaces → underscore', () => {
    expect(svc.slugifyKey('First Name')).toBe('first_name');
  });
  test('dashes → underscore', () => {
    expect(svc.slugifyKey('Blood-Group')).toBe('blood_group');
  });
  test('strips non [a-z0-9_] and collapses repeats', () => {
    expect(svc.slugifyKey('  Weird!! Chars@@  ')).toBe('weird_chars');
    expect(svc.slugifyKey('a--b__c')).toBe('a_b_c');
    expect(svc.slugifyKey('multiple   spaces')).toBe('multiple_spaces');
  });
  test('keeps digits + underscores', () => {
    expect(svc.slugifyKey('emp_id_2')).toBe('emp_id_2');
  });
  test('empty / symbol-only / whitespace throw INVALID_KEY (422)', () => {
    expectCode(() => svc.slugifyKey(''), 'INVALID_KEY');
    expectCode(() => svc.slugifyKey('   '), 'INVALID_KEY');
    expectCode(() => svc.slugifyKey('!!!'), 'INVALID_KEY');
    expectCode(() => svc.slugifyKey(null), 'INVALID_KEY');
  });
});

describe('validateDefinitionInput', () => {
  test('TEXT: normalises + derives the key from the label, options forced null', () => {
    const out = svc.validateDefinitionInput({ fieldType: 'text', label: '  Blood Group  ' });
    expect(out.fieldType).toBe('TEXT');
    expect(out.key).toBe('blood_group');
    expect(out.label).toBe('Blood Group');
    expect(out.options).toBeNull();
    expect(out.required).toBe(false);
    expect(out.essVisible).toBe(false);
    expect(out.essPolicy).toBe('READ_ONLY');
    expect(out.entityType).toBe('EMPLOYEE');
    expect(out.isActive).toBe(true);
    expect(out.orderIndex).toBe(0);
  });

  test('explicit key wins over the label', () => {
    const out = svc.validateDefinitionInput({ fieldType: 'NUMBER', label: 'T Shirt Size', key: 'Tshirt Size' });
    expect(out.key).toBe('tshirt_size');
  });

  test('non-SELECT ignores any options passed (forced null)', () => {
    const out = svc.validateDefinitionInput({ fieldType: 'NUMBER', label: 'Age', options: [{ value: 'x', label: 'X' }] });
    expect(out.options).toBeNull();
  });

  test('SELECT: keeps a valid unique { value, label } option set', () => {
    const out = svc.validateDefinitionInput({
      fieldType: 'SELECT', label: 'Shirt', options: [{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }],
    });
    expect(out.options).toEqual([{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }]);
  });

  test('SELECT: empty / missing options rejected (422)', () => {
    expectCode(() => svc.validateDefinitionInput({ fieldType: 'SELECT', label: 'X', options: [] }), 'INVALID_OPTIONS');
    expectCode(() => svc.validateDefinitionInput({ fieldType: 'SELECT', label: 'X' }), 'INVALID_OPTIONS');
  });

  test('SELECT: option missing value/label rejected', () => {
    expectCode(() => svc.validateDefinitionInput({ fieldType: 'SELECT', label: 'X', options: [{ value: 'a' }] }), 'INVALID_OPTIONS');
    expectCode(() => svc.validateDefinitionInput({ fieldType: 'SELECT', label: 'X', options: [{ label: 'A' }] }), 'INVALID_OPTIONS');
  });

  test('SELECT: duplicate option values rejected', () => {
    expectCode(
      () => svc.validateDefinitionInput({ fieldType: 'SELECT', label: 'X', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'Again' }] }),
      'INVALID_OPTIONS',
    );
  });

  test('bad fieldType / bad essPolicy / empty label rejected', () => {
    expectCode(() => svc.validateDefinitionInput({ fieldType: 'JSON', label: 'X' }), 'INVALID_TYPE');
    expectCode(() => svc.validateDefinitionInput({ fieldType: 'TEXT', label: 'X', essPolicy: 'WRITE' }), 'INVALID_ESS_POLICY');
    expectCode(() => svc.validateDefinitionInput({ fieldType: 'TEXT', label: '   ' }), 'INVALID_LABEL');
  });
});

describe('validateValue', () => {
  const textDef = { fieldType: 'TEXT', required: false };
  const numDef = { fieldType: 'NUMBER', required: false };
  const dateDef = { fieldType: 'DATE', required: false };
  const boolDef = { fieldType: 'BOOLEAN', required: false };
  const selDef = { fieldType: 'SELECT', required: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] };

  test('TEXT: trims + stores in textValue, others null', () => {
    const r = svc.validateValue(textDef, '  hello ');
    expect(r.ok).toBe(true);
    expect(r.columns).toEqual({ textValue: 'hello', numberValue: null, dateValue: null, boolValue: null });
  });

  test('TEXT: blank clears to all-null (non-required)', () => {
    expect(svc.validateValue(textDef, '').columns).toEqual({ textValue: null, numberValue: null, dateValue: null, boolValue: null });
    expect(svc.validateValue(textDef, null).columns).toEqual({ textValue: null, numberValue: null, dateValue: null, boolValue: null });
    expect(svc.validateValue(textDef, undefined).columns).toEqual({ textValue: null, numberValue: null, dateValue: null, boolValue: null });
  });

  test('required clear is rejected (REQUIRED) for every type', () => {
    for (const ft of ['TEXT', 'NUMBER', 'DATE', 'BOOLEAN', 'SELECT']) {
      const r = svc.validateValue({ fieldType: ft, required: true, options: selDef.options }, '');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('REQUIRED');
    }
  });

  test('NUMBER: parses, rejects NaN, accepts 0', () => {
    expect(svc.validateValue(numDef, '42').columns.numberValue).toBe(42);
    expect(svc.validateValue(numDef, 3.5).columns.numberValue).toBe(3.5);
    expect(svc.validateValue(numDef, 0).columns.numberValue).toBe(0);
    const bad = svc.validateValue(numDef, 'abc');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('NOT_A_NUMBER');
  });

  test('DATE: parses ISO, rejects garbage', () => {
    const good = svc.validateValue(dateDef, '2020-01-15');
    expect(good.ok).toBe(true);
    expect(good.columns.dateValue instanceof Date).toBe(true);
    const bad = svc.validateValue(dateDef, 'not-a-date');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('INVALID_DATE');
  });

  test('BOOLEAN: accepts true/false/"true"/"false"/1/0, rejects others', () => {
    expect(svc.validateValue(boolDef, true).columns.boolValue).toBe(true);
    expect(svc.validateValue(boolDef, false).columns.boolValue).toBe(false);
    expect(svc.validateValue(boolDef, 'true').columns.boolValue).toBe(true);
    expect(svc.validateValue(boolDef, 'false').columns.boolValue).toBe(false);
    expect(svc.validateValue(boolDef, 1).columns.boolValue).toBe(true);
    expect(svc.validateValue(boolDef, 0).columns.boolValue).toBe(false);
    const bad = svc.validateValue(boolDef, 'maybe');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('NOT_A_BOOLEAN');
  });

  test('SELECT: membership enforced against options[].value', () => {
    expect(svc.validateValue(selDef, 'a').columns.textValue).toBe('a');
    const bad = svc.validateValue(selDef, 'z');
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('INVALID_OPTION');
  });
});

describe('readValue', () => {
  test('null row → null for every type', () => {
    expect(svc.readValue({ fieldType: 'TEXT' }, null)).toBeNull();
    expect(svc.readValue({ fieldType: 'NUMBER' }, null)).toBeNull();
  });
  test('reads the right typed column', () => {
    expect(svc.readValue({ fieldType: 'TEXT' }, { textValue: 'x' })).toBe('x');
    expect(svc.readValue({ fieldType: 'SELECT' }, { textValue: 'a' })).toBe('a');
    expect(svc.readValue({ fieldType: 'NUMBER' }, { numberValue: 7 })).toBe(7);
    expect(svc.readValue({ fieldType: 'BOOLEAN' }, { boolValue: false })).toBe(false);
    const iso = svc.readValue({ fieldType: 'DATE' }, { dateValue: new Date('2020-01-01T00:00:00Z') });
    expect(iso).toBe('2020-01-01T00:00:00.000Z');
  });
});
