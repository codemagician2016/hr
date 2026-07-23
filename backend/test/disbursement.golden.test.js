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

// ── Review-finding regression pins (HIGH/MEDIUM/LOW) ──────────────────────────
describe('review fixes — fixed-width overflow fails loudly (MEDIUM 2/3)', () => {
  const { padLeftZero, padRight, normalizeInput } = bf._internals;

  test('padLeftZero THROWS BAD_INPUT/422 on overflow instead of dropping the high digit', () => {
    // 16-digit paise into a 15-wide column: the OLD code sliced off the leading
    // '9' → a smaller credit + a broken trailer total. It must now throw.
    expect(padLeftZero('123456789012345', 15)).toBe('123456789012345'); // exact fit OK
    try { padLeftZero('9123456789012345', 15); throw new Error('should have thrown'); }
    catch (e) { expect(e.code).toBe('BAD_INPUT'); expect(e.statusCode).toBe(422); expect(e.message).toMatch(/exceeds fixed-width|truncate/); }
  });

  test('padRight THROWS BAD_INPUT/422 on overflow instead of silently truncating', () => {
    expect(padRight('12345', 5)).toBe('12345'); // exact fit OK
    try { padRight('123456', 5); throw new Error('should have thrown'); }
    catch (e) { expect(e.code).toBe('BAD_INPUT'); expect(e.statusCode).toBe(422); }
  });

  test('generateSbi THROWS (not truncates) when a paise amount overflows the 15-wide column', () => {
    // ₹10,00,00,00,000.00 = 100000000000000 paise = 15 digits (fits). Bump one more
    // digit → 16 → must throw BAD_INPUT/422, never emit a smaller-credit row.
    const overflow = [{ beneficiaryName: 'Big Pay', accountNumber: '123456', ifsc: 'HDFC0001234', amountMinor: 1000000000000000 }];
    try { bf.generateSbi(overflow, META); throw new Error('should have thrown'); }
    catch (e) { expect(e.code).toBe('BAD_INPUT'); expect(e.statusCode).toBe(422); }
  });

  test('account number validated: too long / non-numeric throws BAD_INPUT/422 (MEDIUM 3)', () => {
    const tooLong = [{ beneficiaryName: 'X', accountNumber: '1234567890123456789', ifsc: 'HDFC0001234', amountMinor: 100 }]; // 19 digits
    try { bf.generate('HDFC', tooLong, META); throw new Error('should have thrown'); }
    catch (e) { expect(e.code).toBe('BAD_INPUT'); expect(e.statusCode).toBe(422); expect(e.message).toMatch(/accountNumber/); }
    const nonNumeric = [{ beneficiaryName: 'X', accountNumber: 'ABC123', ifsc: 'HDFC0001234', amountMinor: 100 }];
    expect(() => bf.generate('HDFC', nonNumeric, META)).toThrow(/accountNumber/);
    // A normal 6-18 digit account still passes.
    expect(() => normalizeInput([{ beneficiaryName: 'X', accountNumber: '500100123456', ifsc: 'HDFC0001234', amountMinor: 100 }], META)).not.toThrow();
  });
});

describe('review fixes — CSV formula injection neutralized (LOW 4)', () => {
  const { csvCell, clean, neutralizeFormula } = bf._internals;

  test('a leading = + - @ TAB CR is prefixed with a single quote', () => {
    expect(neutralizeFormula('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(neutralizeFormula('+1+1')).toBe("'+1+1");
    expect(neutralizeFormula('-2+3')).toBe("'-2+3");
    expect(neutralizeFormula('@cmd')).toBe("'@cmd");
    expect(neutralizeFormula('\tTAB')).toBe("'\tTAB");
    expect(neutralizeFormula('Priya Nair')).toBe('Priya Nair'); // benign untouched
    expect(neutralizeFormula('')).toBe(''); // empty untouched
  });

  test('csvCell neutralizes a formula-leading cell (and still quotes if needed)', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    // formula lead + embedded comma → neutralized THEN quoted
    expect(csvCell('=HYPERLINK("x"),evil')).toBe('"\'=HYPERLINK(""x""),evil"');
  });

  test('clean neutralizes a formula lead after stripping delimiters', () => {
    expect(clean('=danger')).toBe("'=danger");
  });

  test('a malicious beneficiaryName surfaces neutralized in a real generated file', () => {
    // clean() strips | so the name lands as "=cmd calc"; the leading '=' must be guarded.
    const evil = [{ beneficiaryName: '=cmd|calc', accountNumber: '500100123456', ifsc: 'HDFC0001234', amountMinor: 100 }];
    const out = bf.generateHdfc(evil, META);
    expect(out).toContain("'=cmd calc"); // single-quote guard present (| stripped by clean)
    expect(out).not.toMatch(/(^|,)=cmd/); // no raw formula at a cell boundary
  });
});

// ── Country dispatch (IN vs NZ vs unsupported) — PURE, no DB ───────────────────
// The gate that used to hard-throw "India-only" now routes by the run entity's
// country: IN → the IFSC bank-format rail (bankFormats.js), NZ → the direct-credit
// rail (filing/newzealand.generateBankBatch), any OTHER country → COUNTRY_UNSUPPORTED.
describe('disbursement country dispatch (resolveDisbursementRoute)', () => {
  const svc = require('../src/hr/payroll/disbursement/disbursement.service');
  const { resolveDisbursementRoute } = svc._internals;

  test('IN → the IFSC bank-format rail (case-insensitive)', () => {
    expect(resolveDisbursementRoute('IN')).toBe('IN_BANK_FORMAT');
    expect(resolveDisbursementRoute('in')).toBe('IN_BANK_FORMAT');
  });

  test('NZ → the direct-credit rail (case-insensitive)', () => {
    expect(resolveDisbursementRoute('NZ')).toBe('NZ_DIRECT_CREDIT');
    expect(resolveDisbursementRoute('nz')).toBe('NZ_DIRECT_CREDIT');
  });

  test('any other / missing country → COUNTRY_UNSUPPORTED (422, no payout rail)', () => {
    for (const cc of ['US', 'AU', 'GB', '', null, undefined]) {
      try {
        resolveDisbursementRoute(cc);
        throw new Error(`should have thrown for ${JSON.stringify(cc)}`);
      } catch (e) {
        expect(e.code).toBe('COUNTRY_UNSUPPORTED');
      }
    }
  });
});
