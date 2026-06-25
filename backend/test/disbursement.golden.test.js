'use strict';

/**
 * disbursement.golden.test.js — GOLDEN byte-pin for the India salary-advice
 * bank formatters (backend/src/hr/payroll/disbursement/bankFormats.js).
 *
 * These tests are THE CONTRACT: each bank's exact output bytes are pinned for a
 * fixed input. If a formatter's column order / delimiter / header / fixed-width
 * boundary changes, this test fails LOUDLY — that is intentional. A bank file
 * that drifts silently bounces a real salary credit, so the golden is the guard.
 *
 * Pure module: no DB, no I/O — runs under plain `node` or jest.
 */

const bf = require('../src/hr/payroll/disbursement/bankFormats');

// Fixed input — chosen to exercise:
//   - 2-decimal rupee formatting from paise (45000.75, 123.45)
//   - the RTGS auto-select floor in the generic rail (250000.00 >= ₹2,00,000)
//   - free-text sanitation (the comma in "Aarav Sharma, Jr" must NOT break CSV)
//   - SBI fixed-width padding / paise-amount zero-pad
const BENES = [
  { beneficiaryName: 'Priya Nair', accountNumber: '50100123456789', ifsc: 'HDFC0001234', amountMinor: 4500075, narration: 'SAL JUN2026' },
  { beneficiaryName: 'Olivia Williams', accountNumber: '00112233445566', ifsc: 'ICIC0000456', amountMinor: 25000000, narration: 'SAL JUN2026' },
  { beneficiaryName: 'Aarav Sharma, Jr', accountNumber: '777888999000', ifsc: 'SBIN0007777', amountMinor: 12345, narration: 'SAL JUN2026' },
];
const META = { debitAccount: '00060350001234', valueDate: '2026-06-30', batchRef: 'PB-2026-06-IN', defaultNarration: 'SALARY' };
const TOTAL_MINOR = 29512420; // 4500075 + 25000000 + 12345 — round-trip anchor

const CRLF = '\r\n';

describe('bank salary-advice golden bytes', () => {
  test('HDFC (Enet) — header-less CSV', () => {
    const expected =
      'NEFT,1,50100123456789,Priya Nair,45000.75,00060350001234,HDFC0001234,SAL JUN2026,30/06/2026' + CRLF +
      'NEFT,2,00112233445566,Olivia Williams,250000.00,00060350001234,ICIC0000456,SAL JUN2026,30/06/2026' + CRLF +
      'NEFT,3,777888999000,Aarav Sharma  Jr,123.45,00060350001234,SBIN0007777,SAL JUN2026,30/06/2026' + CRLF;
    expect(bf.generateHdfc(BENES, META)).toBe(expected);
    expect(bf.generate('HDFC', BENES, META).content).toBe(expected);
  });

  test('ICICI (CIB) — CSV with header', () => {
    const expected =
      'Sr No,Beneficiary Name,Beneficiary Account No,IFSC Code,Amount,Debit Account No,Transaction Type,Value Date,Remarks' + CRLF +
      '1,Priya Nair,50100123456789,HDFC0001234,45000.75,00060350001234,NEFT,30/06/2026,SAL JUN2026' + CRLF +
      '2,Olivia Williams,00112233445566,ICIC0000456,250000.00,00060350001234,NEFT,30/06/2026,SAL JUN2026' + CRLF +
      '3,Aarav Sharma  Jr,777888999000,SBIN0007777,123.45,00060350001234,NEFT,30/06/2026,SAL JUN2026' + CRLF;
    expect(bf.generateIcici(BENES, META)).toBe(expected);
  });

  test('Axis (Corporate) — CSV with header', () => {
    const expected =
      'PaymentType,BeneficiaryName,BeneficiaryAccountNo,IFSC,Amount,DebitAccountNo,ValueDate,Email,Narration' + CRLF +
      'NEFT,Priya Nair,50100123456789,HDFC0001234,45000.75,00060350001234,30/06/2026,,SAL JUN2026' + CRLF +
      'NEFT,Olivia Williams,00112233445566,ICIC0000456,250000.00,00060350001234,30/06/2026,,SAL JUN2026' + CRLF +
      'NEFT,Aarav Sharma  Jr,777888999000,SBIN0007777,123.45,00060350001234,30/06/2026,,SAL JUN2026' + CRLF;
    expect(bf.generateAxis(BENES, META)).toBe(expected);
  });

  test('Kotak — CSV with header (Client Code carries batchRef)', () => {
    const expected =
      'Client Code,Product Code,Payment Type,Beneficiary Name,Beneficiary Account Number,IFSC Code,Amount,Debit Account Number,Value Date,Narration' + CRLF +
      'PB-2026-06-IN,NEFT,NEFT,Priya Nair,50100123456789,HDFC0001234,45000.75,00060350001234,30/06/2026,SAL JUN2026' + CRLF +
      'PB-2026-06-IN,NEFT,NEFT,Olivia Williams,00112233445566,ICIC0000456,250000.00,00060350001234,30/06/2026,SAL JUN2026' + CRLF +
      'PB-2026-06-IN,NEFT,NEFT,Aarav Sharma  Jr,777888999000,SBIN0007777,123.45,00060350001234,30/06/2026,SAL JUN2026' + CRLF;
    expect(bf.generateKotak(BENES, META)).toBe(expected);
  });

  test('SBI (CINB) — fixed-width flat file with paise amounts + control trailer', () => {
    const expected =
      'DNEFT50100123456789   HDFC0001234000000004500075Priya Nair                              SAL JUN2026                   30062026' + CRLF +
      'DNEFT00112233445566   ICIC0000456000000025000000Olivia Williams                         SAL JUN2026                   30062026' + CRLF +
      'DNEFT777888999000     SBIN0007777000000000012345Aarav Sharma  Jr                        SAL JUN2026                   30062026' + CRLF +
      'T0000003000000000029512420' + CRLF;
    expect(bf.generateSbi(BENES, META)).toBe(expected);
  });

  test('Generic NEFT/RTGS — CSV with header + control row + RTGS auto-select', () => {
    const expected =
      'Sr No,Beneficiary Name,Account Number,IFSC,Amount,Payment Mode,Value Date,Narration' + CRLF +
      '1,Priya Nair,50100123456789,HDFC0001234,45000.75,NEFT,30/06/2026,SAL JUN2026' + CRLF +
      '2,Olivia Williams,00112233445566,ICIC0000456,250000.00,RTGS,30/06/2026,SAL JUN2026' + CRLF +
      '3,Aarav Sharma  Jr,777888999000,SBIN0007777,123.45,NEFT,30/06/2026,SAL JUN2026' + CRLF +
      'TOTAL,3,,,295124.20,,,' + CRLF;
    expect(bf.generateNeftRtgs(BENES, META)).toBe(expected);
  });
});

describe('registry + money round-trip', () => {
  test('every registered bank renders and reports the same round-tripped total', () => {
    for (const bank of Object.keys(bf.formats)) {
      const out = bf.generate(bank, BENES, META);
      expect(out.count).toBe(3);
      expect(out.totalMinor).toBe(TOTAL_MINOR); // Σ lines == batch total (paise)
      expect(typeof out.content).toBe('string');
      expect(out.content.endsWith(CRLF)).toBe(true);
      expect(out.fileExt).toMatch(/^(csv|txt)$/);
    }
  });

  test('listBanks exposes all six rails with labels in stable order', () => {
    const banks = bf.listBanks();
    expect(banks.map((b) => b.value)).toEqual(['HDFC', 'ICICI', 'AXIS', 'KOTAK', 'SBI', 'NEFT_RTGS']);
    banks.forEach((b) => expect(typeof b.label).toBe('string'));
  });

  test('isSupportedBank gates the enum', () => {
    expect(bf.isSupportedBank('HDFC')).toBe(true);
    expect(bf.isSupportedBank('NEFT_RTGS')).toBe(true);
    expect(bf.isSupportedBank('BOGUS')).toBe(false);
    expect(bf.isSupportedBank('')).toBe(false);
  });
});

describe('validation (fail-closed, tagged errors → 4xx not 500)', () => {
  test('unknown bank throws UNKNOWN_BANK/400', () => {
    expect(() => bf.generate('BOGUS', BENES, META)).toThrow(/Unknown bank rail/);
    try { bf.generate('BOGUS', BENES, META); } catch (e) {
      expect(e.code).toBe('UNKNOWN_BANK');
      expect(e.statusCode).toBe(400);
    }
  });

  test('invalid IFSC throws BAD_INPUT/422', () => {
    const bad = [{ beneficiaryName: 'X', accountNumber: '1', ifsc: 'BADIFSC', amountMinor: 100 }];
    try { bf.generate('HDFC', bad, META); throw new Error('should have thrown'); }
    catch (e) { expect(e.code).toBe('BAD_INPUT'); expect(e.statusCode).toBe(422); }
  });

  test('non-integer (float) amount is rejected by the money guard', () => {
    const bad = [{ beneficiaryName: 'X', accountNumber: '1', ifsc: 'HDFC0001234', amountMinor: 100.5 }];
    expect(() => bf.generate('HDFC', bad, META)).toThrow();
  });

  test('non-positive amount throws BAD_INPUT/422', () => {
    const bad = [{ beneficiaryName: 'X', accountNumber: '1', ifsc: 'HDFC0001234', amountMinor: 0 }];
    try { bf.generate('HDFC', bad, META); throw new Error('should have thrown'); }
    catch (e) { expect(e.code).toBe('BAD_INPUT'); expect(e.statusCode).toBe(422); }
  });

  test('missing accountNumber / beneficiaryName throws BAD_INPUT/422', () => {
    expect(() => bf.generate('HDFC', [{ beneficiaryName: '', accountNumber: '1', ifsc: 'HDFC0001234', amountMinor: 100 }], META)).toThrow(/beneficiaryName/);
    expect(() => bf.generate('HDFC', [{ beneficiaryName: 'X', accountNumber: '', ifsc: 'HDFC0001234', amountMinor: 100 }], META)).toThrow(/accountNumber/);
  });
});
