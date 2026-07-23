'use strict';

const fa = require('../fieldAccess');

const viewer = (fieldAccess) => ({ id: 'u1', businessRole: fieldAccess === undefined ? {} : { fieldAccess } });

describe('fieldAccess.validateFieldAccessMap', () => {
  test('accepts a valid map', () => {
    const r = fa.validateFieldAccessMap({ bank: 'HIDDEN', personal: 'READ', contact: 'WRITE' });
    expect(r.ok).toBe(true);
    expect(r.map).toEqual({ bank: 'HIDDEN', personal: 'READ', contact: 'WRITE' });
  });
  test('null → ok empty', () => {
    expect(fa.validateFieldAccessMap(null)).toEqual({ ok: true, map: {} });
  });
  test('rejects unknown group', () => {
    expect(fa.validateFieldAccessMap({ salary: 'HIDDEN' }).ok).toBe(false);
  });
  test('rejects bad access level', () => {
    expect(fa.validateFieldAccessMap({ bank: 'NOPE' }).ok).toBe(false);
  });
  test('rejects a non-object', () => {
    expect(fa.validateFieldAccessMap(['bank']).ok).toBe(false);
  });
});

describe('fieldAccess.accessFor / resolveMap', () => {
  test('no map → WRITE (fail-open)', () => {
    expect(fa.accessFor(viewer(undefined), 'bank')).toBe('WRITE');
    expect(fa.accessFor({ id: 'x' }, 'bank')).toBe('WRITE');
  });
  test('reads the configured level, unset group → WRITE', () => {
    const v = viewer({ bank: 'HIDDEN' });
    expect(fa.accessFor(v, 'bank')).toBe('HIDDEN');
    expect(fa.accessFor(v, 'personal')).toBe('WRITE');
  });
  test('a stringified JSON map is parsed', () => {
    expect(fa.accessFor(viewer(JSON.stringify({ identity: 'READ' })), 'identity')).toBe('READ');
  });
  test('customAccess shortcut', () => {
    expect(fa.customAccess(viewer({ custom: 'HIDDEN' }))).toBe('HIDDEN');
    expect(fa.customAccess(viewer(undefined))).toBe('WRITE');
  });
});

describe('fieldAccess.applyFieldAccess (top-level scalars)', () => {
  const payload = () => ({
    id: 'e1', firstName: 'Priya', dateOfBirth: '1990-01-01', gender: 'FEMALE',
    personalEmail: 'p@x.com', phone: '99999',
    statutoryProfile: { pan: 'ABCDE1234F' }, bankAccounts: [{ id: 'b1' }], customFields: [{ definition: {}, value: 'L' }],
  });
  test('no map → identity (unchanged, no _fieldAccess)', () => {
    const p = payload();
    const out = fa.applyFieldAccess(p, viewer(undefined));
    expect(out).toBe(p);
    expect(out._fieldAccess).toBeUndefined();
  });
  test('empty map {} → identity (the schema default is byte-for-byte fail-open)', () => {
    const p = payload();
    const out = fa.applyFieldAccess(p, viewer({}));
    expect(out).toBe(p);
    expect(out._fieldAccess).toBeUndefined();
    expect(fa.firstDeniedWrite(viewer({}), ['dateOfBirth'])).toBeNull();
  });
  test('HIDDEN personal removes personal scalars but not name/contact', () => {
    const out = fa.applyFieldAccess(payload(), viewer({ personal: 'HIDDEN' }));
    expect(out.dateOfBirth).toBeUndefined();
    expect(out.gender).toBeUndefined();
    expect(out.firstName).toBe('Priya');       // name is ungoverned
    expect(out.personalEmail).toBe('p@x.com');  // contact untouched
    expect(out._fieldAccess.personal).toBe('HIDDEN');
  });
  test('HIDDEN bank empties bankAccounts; HIDDEN identity nulls statutoryProfile', () => {
    const out = fa.applyFieldAccess(payload(), viewer({ bank: 'HIDDEN', identity: 'HIDDEN' }));
    expect(out.bankAccounts).toEqual([]);
    expect(out.statutoryProfile).toBeNull();
    expect(out.customFields.length).toBe(1);    // custom untouched
  });
  test('HIDDEN custom empties customFields', () => {
    const out = fa.applyFieldAccess(payload(), viewer({ custom: 'HIDDEN' }));
    expect(out.customFields).toEqual([]);
  });
  test('READ leaves fields visible but records the level', () => {
    const out = fa.applyFieldAccess(payload(), viewer({ bank: 'READ' }));
    expect(out.bankAccounts.length).toBe(1);
    expect(out._fieldAccess.bank).toBe('READ');
  });
});

describe('fieldAccess.applyFieldAccess (nested scalarHost)', () => {
  test('redacts scalars under employee and sections at top level', () => {
    const full = {
      employee: { id: 'e1', firstName: 'Priya', dateOfBirth: '1990-01-01', personalEmail: 'p@x.com' },
      bank: { accountNumber: '123' }, statutory: { pan: 'X' }, customFields: [{ value: 1 }], addresses: [{ id: 'a1' }],
    };
    const out = fa.applyFieldAccess(full, viewer({ personal: 'HIDDEN', bank: 'HIDDEN', contact: 'HIDDEN' }), { scalarHost: 'employee' });
    expect(out.employee.dateOfBirth).toBeUndefined();
    expect(out.employee.personalEmail).toBeUndefined();
    expect(out.employee.firstName).toBe('Priya');
    expect(out.bank).toBeNull();
    expect(out.addresses).toEqual([]);   // addresses ride the contact group
  });
});

describe('fieldAccess.firstDeniedWrite', () => {
  test('no map → null (fail-open)', () => {
    expect(fa.firstDeniedWrite(viewer(undefined), ['dateOfBirth'])).toBeNull();
  });
  test('READ personal blocks a personal write', () => {
    const d = fa.firstDeniedWrite(viewer({ personal: 'READ' }), ['dateOfBirth', 'firstName']);
    expect(d).toMatchObject({ field: 'dateOfBirth', group: 'personal', access: 'READ' });
  });
  test('ungoverned keys (name/status) are always writable', () => {
    expect(fa.firstDeniedWrite(viewer({ personal: 'HIDDEN' }), ['firstName', 'status', 'managerEmployeeId'])).toBeNull();
  });
  test('WRITE on the group → allowed', () => {
    expect(fa.firstDeniedWrite(viewer({ contact: 'WRITE' }), ['phone'])).toBeNull();
  });
  test('HIDDEN bank blocks a contact write only if the key is governed', () => {
    // workEmail rides the contact group
    expect(fa.firstDeniedWrite(viewer({ contact: 'HIDDEN' }), ['workEmail'])).toMatchObject({ group: 'contact' });
  });
});
