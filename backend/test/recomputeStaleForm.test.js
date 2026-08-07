jest.mock('../src/core/lib/prisma', () => ({
  $transaction: jest.fn(),
  application: { findFirst: jest.fn(), update: jest.fn() },
  screeningQuestion: { findMany: jest.fn() },
  screeningAnswer: { findMany: jest.fn() },
  interview: { findMany: jest.fn() },
  scorecard: { findMany: jest.fn() },
  scorecardTemplate: { findFirst: jest.fn() },
}));

const prisma = require('../src/core/lib/prisma');
const { _internals } = require('../src/hr/talent/recruitment/recruitment.scoring.controller');

const { recomputeAndPersist } = _internals;

// A ScreeningAnswer is keyed by questionId but has NO FK to the question. Replace
// a job's screening form — delete the questions, apply a template — and every
// existing answer points at a question that no longer exists. Rescoring then finds
// no answer for any current question, so the candidate scores 0 AND every required
// knockout fails CLOSED on "unanswered": a shortlisted candidate silently becomes a
// knocked-out one with a zero. Observed on a live job: 10 candidates, 8 answers
// each, 0 matching a live question.
describe('recomputeAndPersist — answers that predate the current form', () => {
  const businessId = 'biz_1';
  const applicationId = 'app_1';

  const liveQuestions = [
    {
      id: 'NEW-q1', kind: 'BOOLEAN', prompt: 'Available full-time?', required: true,
      isKnockout: true, knockoutValue: null, maxPoints: null, sortOrder: 0,
      options: [{ value: 'true', label: 'Yes', points: 1 }, { value: 'false', label: 'No', points: 0 }],
    },
    {
      id: 'NEW-q2', kind: 'SINGLE_CHOICE', prompt: 'Qualification', required: true,
      isKnockout: false, knockoutValue: null, maxPoints: null, sortOrder: 1,
      options: [{ value: 'BACH', label: "Bachelor's", points: 4 }, { value: 'PHD', label: 'PhD', points: 8 }],
    },
  ];

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.application.update.mockImplementation(async ({ data }) => data);
    prisma.screeningQuestion.findMany.mockResolvedValue(liveQuestions);
    prisma.interview.findMany.mockResolvedValue([]);
    prisma.scorecard.findMany.mockResolvedValue([]);
  });

  function application(over = {}) {
    return {
      id: applicationId,
      businessId,
      jobId: 'job_1',
      screeningScore: 7,
      screeningMaxScore: 9,
      knockedOut: false,
      meritScore: 77.78,
      scoreSnapshot: { screening: { score: 7, max: 9, pct: 77.78, lines: [{ q: 'old question', awarded: 1, max: 1 }] } },
      job: { id: 'job_1', applicationWeightPct: 40, interviewWeightPct: 60 },
      ...over,
    };
  }

  test('PRESERVES the stored score when no answer matches a live question', async () => {
    prisma.application.findFirst.mockResolvedValue(application());
    // 8 answers, all pointing at questions that were deleted
    prisma.screeningAnswer.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ questionId: `OLD-q${i}`, answerValue: true })),
    );

    const r = await recomputeAndPersist(null, businessId, applicationId);

    expect(r.screeningScore).toBe(7);
    expect(r.screeningMaxScore).toBe(9);
    expect(r.knockedOut).toBe(false);          // NOT knocked out by "unanswered"
    expect(r.scoreSnapshot.staleForm).toBe(true);
    // the ORIGINAL breakdown is kept — the current questions are not the ones
    // this candidate answered
    expect(r.scoreSnapshot.screening.lines[0].q).toBe('old question');
  });

  test('without the guard the candidate would have been zeroed AND knocked out', async () => {
    // Proves the hazard is real: same inputs, but the answers DO match the live
    // questions, so a genuine rescore happens.
    prisma.application.findFirst.mockResolvedValue(application());
    prisma.screeningAnswer.findMany.mockResolvedValue([
      { questionId: 'NEW-q1', answerValue: true },
      { questionId: 'NEW-q2', answerValue: 'BACH' },
    ]);

    const r = await recomputeAndPersist(null, businessId, applicationId);

    expect(r.scoreSnapshot.staleForm).toBeUndefined();
    expect(r.screeningScore).toBe(5);          // 1 (Yes) + 4 (Bachelor's)
    expect(r.screeningMaxScore).toBe(9);       // 1 + 8
    expect(r.knockedOut).toBe(false);
  });

  test('an application with NO answers at all is still scored normally', async () => {
    // Nothing to orphan — a candidate who genuinely answered nothing must still
    // fail the required knockout, which is the correct behaviour.
    prisma.application.findFirst.mockResolvedValue(application({ screeningScore: null, screeningMaxScore: null }));
    prisma.screeningAnswer.findMany.mockResolvedValue([]);

    const r = await recomputeAndPersist(null, businessId, applicationId);

    expect(r.scoreSnapshot.staleForm).toBeUndefined();
    expect(r.knockedOut).toBe(true);
  });

  test('a stale form still records a fresh INTERVIEW score and re-blends merit', async () => {
    prisma.application.findFirst.mockResolvedValue(application());
    prisma.screeningAnswer.findMany.mockResolvedValue([{ questionId: 'OLD-q1', answerValue: true }]);
    prisma.interview.findMany.mockResolvedValue([{ id: 'iv1' }]);
    prisma.scorecard.findMany.mockResolvedValue([
      { interviewId: 'iv1', status: 'SUBMITTED', submittedAt: new Date('2026-01-01'), weightedTotal: 80, ratings: [{ score: 8, weight: 1, scaleMin: 1, scaleMax: 10 }] },
    ]);

    const r = await recomputeAndPersist(null, businessId, applicationId);

    expect(r.screeningScore).toBe(7);                 // screening held
    expect(r.interviewScore).not.toBeNull();          // interview still lands
    // merit re-blended from the PRESERVED screening + the fresh interview
    expect(r.meritScore).toBeGreaterThan(0);
    expect(r.scoreSnapshot.staleForm).toBe(true);
  });
});
