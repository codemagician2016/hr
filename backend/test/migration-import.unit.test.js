'use strict';

/*
 * migration-import.unit.test.js — PURE unit tests for the Feature 18 import
 * subsystem (CSV codec, templates, per-kind validators). No DB, jest-runnable.
 */

const csv = require('../src/hr/migration/parsers/csv');
const templates = require('../src/hr/migration/templates');
const { validateRow } = require('../src/hr/migration/validators');

describe('CSV codec', () => {
  test('RFC-4180 quoting: comma inside quotes stays one field', () => {
    const { rows } = csv.parseCsv('a,b\r\n"x,y",z\r\n');
    expect(rows[0]).toEqual({ a: 'x,y', b: 'z' });
  });

  test('escaped double-quote', () => {
    const { rows } = csv.parseCsv('a\n"he said ""hi"""\n');
    expect(rows[0].a).toBe('he said "hi"');
  });

  test('BOM is stripped from the first header', () => {
    const { headers } = csv.parseCsv('﻿code,name\nX,Y\n');
    expect(headers[0]).toBe('code');
  });

  test('blank cells normalise to null', () => {
    const { rows } = csv.parseCsv('a,b\n,z\n');
    expect(rows[0].a).toBeNull();
    expect(rows[0].b).toBe('z');
  });

  test('formula-leading cells are kept VERBATIM on read (NOT neutralised — DB is not a spreadsheet)', () => {
    const { rows } = csv.parseCsv('a\n=SUM(A1)\n');
    expect(rows[0].a).toBe('=SUM(A1)'); // no leading apostrophe persisted
  });

  test('read preserves +91 E.164 phones and negative money verbatim (no corruption)', () => {
    const { rows } = csv.parseCsv('phone,claimedAmount\n+919876543210,-500\n');
    expect(rows[0].phone).toBe('+919876543210'); // NOT "'+919876543210"
    expect(rows[0].claimedAmount).toBe('-500');   // NOT "'-500" → still parses as money
  });

  test('toCsv quotes + neutralises on write (export-only formula-injection guard)', () => {
    const out = csv.toCsv(['a', 'b'], [{ a: '=cmd', b: 'x,y' }]);
    expect(out).toContain("'=cmd"); // escaped on the EXPORT side
    expect(out).toContain('"x,y"');
    // round-trip: a +91 phone exported then re-read stays clean
    const wrote = csv.toCsv(['phone'], [{ phone: '+919876543210' }]);
    expect(wrote).toContain("'+919876543210"); // export escapes the leading +
    expect(csv.parseCsv(wrote).rows[0].phone).toBe("'+919876543210"); // read is verbatim
  });

  test('CRLF and LF line endings both parse', () => {
    expect(csv.parseCsv('a\r\n1\r\n').rows.length).toBe(1);
    expect(csv.parseCsv('a\n1\n').rows.length).toBe(1);
  });
});

describe('templates', () => {
  test('every kind has a downloadable template with a # data dictionary', () => {
    for (const kind of templates.KINDS) {
      const t = templates.buildTemplateCsv(kind);
      expect(t.startsWith('#')).toBe(true);
      expect(t).toContain('Data dictionary');
    }
  });

  test('required fields are declared per kind', () => {
    expect(templates.requiredFields('EMPLOYEE')).toContain('workEmail');
    expect(templates.requiredFields('COMPENSATION')).toContain('employeeCode');
    expect(templates.requiredFields('PAYROLL_HISTORY')).toContain('periodMonth');
  });

  test('COMPENSATION has a oneOf target group', () => {
    const groups = templates.oneOfGroups('COMPENSATION');
    expect(groups.target).toEqual(expect.arrayContaining(['ctcAnnual', 'grossMonthly']));
  });
});

describe('validators (India-first)', () => {
  const ctx = {
    countryCode: 'IN',
    entityCodes: new Set(['IN-HQ']),
    employeeCodes: new Set(['EMP-1']),
    employeeByCode: new Map([['EMP-1', { id: 'e1' }]]),
    today: '2026-06-24',
    mode: {},
  };

  test('EMPLOYEE: invalid PAN is an ERROR (reported, not dropped)', () => {
    const r = validateRow('EMPLOYEE', { firstName: 'A', lastName: 'B', workEmail: 'a@b.in', dateOfJoining: '2025-04-01', entityCode: 'IN-HQ', pan: 'NOTAPAN' }, ctx);
    expect(r.status).toBe('ERROR');
    expect(r.findings.some((f) => f.code === 'BAD_PAN')).toBe(true);
  });

  test('EMPLOYEE: valid row passes; unknown entity is ERROR', () => {
    const good = { firstName: 'A', lastName: 'B', workEmail: 'a@b.in', gender: 'FEMALE', dateOfBirth: '1990-01-01', dateOfJoining: '2025-04-01', entityCode: 'IN-HQ', pan: 'ABCDE1234X' };
    expect(validateRow('EMPLOYEE', good, ctx).status).toBe('PASS');
    expect(validateRow('EMPLOYEE', { ...good, entityCode: 'NOPE' }, ctx).status).toBe('ERROR');
  });

  test('EMPLOYEE: missing gender/PAN for IN is a WARN (advisory, not blocking)', () => {
    const r = validateRow('EMPLOYEE', { firstName: 'A', lastName: 'B', workEmail: 'a@b.in', dateOfJoining: '2025-04-01', entityCode: 'IN-HQ', pan: 'ABCDE1234X' }, ctx);
    expect(r.status).toBe('WARN');
    expect(r.findings.some((f) => f.code === 'REQUIRED_IN' && f.severity === 'WARN')).toBe(true);
  });

  test('COMPENSATION: missing target (no ctc/gross) is ERROR; ctc coerces to minor', () => {
    expect(validateRow('COMPENSATION', { employeeCode: 'EMP-1', effectiveFrom: '2025-04-01' }, ctx).status).toBe('ERROR');
    const r = validateRow('COMPENSATION', { employeeCode: 'EMP-1', effectiveFrom: '2025-04-01', ctcAnnual: '1200000' }, ctx);
    expect(r.status).toBe('PASS');
    expect(r.normalized.ctcAnnualMinor).toBe(120000000);
    expect(r.naturalKey).toBe('EMP-1|2025-04-01');
  });

  test('ATTENDANCE: DAILY needs date+status; bad status is ERROR', () => {
    expect(validateRow('ATTENDANCE', { employeeCode: 'EMP-1', date: '2025-12-01', status: 'PRESENT' }, ctx).status).toBe('PASS');
    expect(validateRow('ATTENDANCE', { employeeCode: 'EMP-1', date: '2025-12-01', status: 'WAT' }, ctx).status).toBe('ERROR');
  });

  test('ATTENDANCE: SUMMARY mode keyed on periodMonth', () => {
    const r = validateRow('ATTENDANCE', { employeeCode: 'EMP-1', periodMonth: '2025-12', payableDays: '29', lopDays: '2' }, { ...ctx, mode: { attendanceMode: 'SUMMARY' } });
    expect(r.status).toBe('PASS');
    expect(r.normalized.mode).toBe('SUMMARY');
    expect(r.naturalKey).toBe('EMP-1|2025-12');
  });

  test('PAYROLL_HISTORY: a future month is rejected (history only)', () => {
    expect(validateRow('PAYROLL_HISTORY', { employeeCode: 'EMP-1', periodMonth: '2026-12' }, ctx).status).toBe('ERROR');
    expect(validateRow('PAYROLL_HISTORY', { employeeCode: 'EMP-1', periodMonth: '2025-12' }, ctx).status).toBe('PASS');
  });

  test('REIMBURSEMENT: approved > claimed is a WARN (allowed, flagged)', () => {
    const r = validateRow('REIMBURSEMENT', { employeeCode: 'EMP-1', expenseDate: '2025-11-15', claimedAmount: '1000', approvedAmount: '1500' }, ctx);
    expect(r.status).toBe('WARN');
    expect(r.findings.some((f) => f.code === 'APPROVED_GT_CLAIMED')).toBe(true);
  });

  test('REIMBURSEMENT: approved defaults to claimed when blank', () => {
    const r = validateRow('REIMBURSEMENT', { employeeCode: 'EMP-1', expenseDate: '2025-11-15', claimedAmount: '1000' }, ctx);
    expect(r.normalized.approvedMinor).toBe(r.normalized.claimedMinor);
  });
});
