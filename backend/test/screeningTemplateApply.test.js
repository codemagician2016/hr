jest.mock('../src/core/lib/prisma', () => ({
  $transaction: jest.fn(),
  screeningFormTemplate: { findFirst: jest.fn() },
  job: { findFirst: jest.fn() },
  screeningQuestion: { count: jest.fn(), create: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
}));

const prisma = require('../src/core/lib/prisma');
const { _internals } = require('../src/hr/talent/controllers/screeningFormTemplates.controller');

const { applyCore } = _internals;

// A job whose questions were all DELETED reads as empty on screen, but the delete
// is soft — the rows keep their sortOrder and @@unique([businessId, jobId,
// sortOrder]) is a FULL unique, so it still counts them. Applying a template then
// inserted sortOrder 0..n on top of invisible rows → P2002 → "Internal server
// error", with the screen still showing "No screening questions yet".
describe('applyCore — soft-deleted screening questions', () => {
  const businessId = 'biz_1';
  const jobId = 'job_1';
  const templateId = 'tpl_1';

  let tx;
  beforeEach(() => {
    jest.resetAllMocks();
    tx = {
      screeningQuestion: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    prisma.$transaction.mockImplementation(async (fn) => fn(tx));
    prisma.screeningFormTemplate.findFirst.mockResolvedValue({
      id: templateId,
      questions: [
        { prompt: 'Q1', kind: 'BOOLEAN', required: true, isKnockout: false, knockoutValue: null, maxPoints: null, sortOrder: 0, options: [] },
        { prompt: 'Q2', kind: 'BOOLEAN', required: true, isKnockout: false, knockoutValue: null, maxPoints: null, sortOrder: 1, options: [] },
      ],
    });
    prisma.job.findFirst.mockResolvedValue({ id: jobId });
  });

  test('clears the tombstones before inserting, so sortOrder cannot collide', async () => {
    // The reported state: nothing LIVE (count filters deletedAt: null) but
    // tombstones still hold sortOrder 0 and 1.
    prisma.screeningQuestion.count.mockResolvedValue(0);

    const out = await applyCore({ businessId, templateId, jobId, replace: false });

    expect(out.status).toBe(200);
    const purge = tx.screeningQuestion.deleteMany.mock.calls
      .map((c) => c[0].where)
      .find((w) => w.deletedAt && w.deletedAt.not === null);
    expect(purge).toEqual({ businessId, jobId, deletedAt: { not: null } });
    // and it must happen BEFORE the first insert, or the collision still occurs
    const purgeOrder = tx.screeningQuestion.deleteMany.mock.invocationCallOrder[0];
    const firstCreate = tx.screeningQuestion.create.mock.invocationCallOrder[0];
    expect(purgeOrder).toBeLessThan(firstCreate);
    expect(tx.screeningQuestion.create).toHaveBeenCalledTimes(2);
  });

  test('a job with LIVE questions is still refused without replace=true', async () => {
    prisma.screeningQuestion.count.mockResolvedValue(3);
    const out = await applyCore({ businessId, templateId, jobId, replace: false });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('QUESTIONS_EXIST');
    expect(tx.screeningQuestion.create).not.toHaveBeenCalled();
  });

  test('replace=true wipes the job clean and reapplies', async () => {
    prisma.screeningQuestion.count.mockResolvedValue(3);
    const out = await applyCore({ businessId, templateId, jobId, replace: true });
    expect(out.status).toBe(200);
    expect(out.body.replaced).toBe(true);
    expect(tx.screeningQuestion.deleteMany).toHaveBeenCalledWith({ where: { businessId, jobId } });
    expect(tx.screeningQuestion.create).toHaveBeenCalledTimes(2);
  });

  test('the returned list never contains tombstones', async () => {
    prisma.screeningQuestion.count.mockResolvedValue(0);
    await applyCore({ businessId, templateId, jobId, replace: false });
    expect(tx.screeningQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { businessId, jobId, deletedAt: null } }),
    );
  });
});
