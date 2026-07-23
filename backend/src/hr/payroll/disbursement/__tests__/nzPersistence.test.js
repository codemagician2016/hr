'use strict';

// P5e — NZ PayoutBatch persistence. The demo staging tenant is IN + country-locked,
// so an NZ run can't be exercised live; this proves the persistence code path with an
// injected fake `db` (records the create call) and a mocked pure NZ generator. It
// asserts the batch persists on the NZ_DIRECT_CREDIT rail with null ifsc + the NZ
// account snapshot, and that the response carries persisted:true + a real id + the file.

jest.mock('../../filing/newzealand', () => ({
  collectBankBatchIssues: jest.fn(() => []),
  generateBankBatch: jest.fn(() => ({
    fileName: 'nz-dc.csv',
    contentType: 'text/csv',
    content: 'DC,...\nCTRL,...',
    meta: { control: { totalMinor: 45000000, totalDollars: '450000.00' }, itemCount: 2 },
  })),
}));
jest.mock('../../../../core/lib/audit', () => ({ writeAudit: jest.fn(async () => {}) }));

const svc = require('../disbursement.service');
const { createNzDirectCreditBatch } = svc._internals;

function fakeDb(created) {
  const tx = {
    payoutBatch: {
      create: jest.fn(async ({ data, include }) => {
        created.data = data;
        const lines = (data.lines && data.lines.create) || [];
        return { id: 'batch-nz-1', ...data, lines: include && include.lines ? lines.map((l, i) => ({ id: `line-${i}`, ...l })) : undefined };
      }),
    },
  };
  return {
    payoutBatch: { findFirst: jest.fn(async () => null) }, // no blocking batch
    payRunLine: {
      findMany: jest.fn(async () => ([
        { employeeId: 'e1', netPay: 300000, employee: { id: 'e1', code: 'NZ001', firstName: 'Olivia', lastName: 'Williams' } },
        { employeeId: 'e2', netPay: 150000, employee: { id: 'e2', code: 'NZ002', firstName: 'Liam', lastName: 'Jones' } },
      ])),
    },
    bankAccount: {
      findMany: jest.fn(async () => ([
        { employeeId: 'e1', nzBankAccount: '01-0902-0068389-00', accountNumber: null },
        { employeeId: 'e2', nzBankAccount: '02-1234-0567890-00', accountNumber: null },
      ])),
    },
    $transaction: jest.fn(async (cb) => cb(tx)),
    _tx: tx,
  };
}

const run = {
  id: 'run-nz-1',
  status: 'APPROVED',
  periodStart: new Date('2026-06-01'),
  periodEnd: new Date('2026-06-30'),
  payDate: new Date('2026-07-01'),
  currencyCode: 'NZD',
  entity: { id: 'ent-nz', countryCode: 'NZ', payCurrency: 'NZD', legalName: 'Kiwi Co Ltd', code: 'KIWI', irdEntityNumber: '123-456-789' },
};

describe('P5e — createNzDirectCreditBatch persists', () => {
  test('persists a PayoutBatch on the NZ_DIRECT_CREDIT rail with null ifsc', async () => {
    const created = {};
    const db = fakeDb(created);
    const out = await createNzDirectCreditBatch({ businessId: 'biz1', actorId: 'op1', run, valueDate: '2026-07-01', narration: 'SAL JUN2026', db });

    // The persisted batch
    expect(db.payoutBatch.findFirst).toHaveBeenCalled();       // double-pay guard ran
    expect(created.data.bank).toBe('NZ_DIRECT_CREDIT');
    expect(created.data.currencyCode).toBe('NZD');
    expect(created.data.status).toBe('PROCESSING');
    expect(created.data.fileGeneratedAt).toBeInstanceOf(Date);
    const lines = created.data.lines.create;
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.ifsc).toBeNull();                                // NZ has no IFSC
      expect(l.status).toBe('PENDING');
      expect(typeof l.accountNumber).toBe('string');
    }
    expect(lines[0].accountNumber).toBe('01-0902-0068389-00');  // NZ account snapshot
    // decimalToMinor(netPay) → cents; the two lines (30000000 + 15000000) sum to the
    // generator's control total (45000000), so the batch total round-trips.
    expect(String(lines[0].amountMinor)).toBe('30000000');
    expect(String(created.data.totalMinor)).toBe('45000000');

    // The response
    expect(out.persisted).toBe(true);
    expect(out.id).toBe('batch-nz-1');
    expect(out.rail).toBe('NZ_DIRECT_CREDIT');
    expect(out.file && out.file.fileName).toBe('nz-dc.csv');
  });

  test('refuses a second batch while one is in-flight (double-pay guard), unless forced', async () => {
    const created = {};
    const db = fakeDb(created);
    db.payoutBatch.findFirst = jest.fn(async () => ({ id: 'prior', status: 'PROCESSING' }));
    await expect(createNzDirectCreditBatch({ businessId: 'biz1', actorId: 'op1', run, valueDate: '2026-07-01', db }))
      .rejects.toMatchObject({ code: 'BAD_STATE' });
    // force=true re-issues
    const out = await createNzDirectCreditBatch({ businessId: 'biz1', actorId: 'op1', run, valueDate: '2026-07-01', force: true, db });
    expect(out.persisted).toBe(true);
  });
});
