const { scoreScreening, computeMeritScore } = require('../src/hr/talent/recruitment/scoring');

// A Yes/No question has two sides written by different people:
//   - the CANDIDATE form is hardcoded to submit a real boolean (true/false);
//   - HR types the option labels, and the editor defaults an option's `value` to
//     its LABEL, so a "Yes" option is stored as value "Yes".
// Compared literally, 'true' !== 'yes' — the answer matched no option, so it
// scored 0 with no answer label, while the knockout still passed (its default
// pass set is [true]). On a real form that under-scored every candidate.
const opt = (value, points, label) => ({ value, label: label || value, points });
const q = (id, kind, options, extra = {}) => ({ id, kind, prompt: id, options, ...extra });

describe('scoreScreening — Yes/No answers', () => {
  const yesNo = [opt('Yes', 1), opt('No', 0)];

  test('a boolean true earns the "Yes" option\'s points', () => {
    const r = scoreScreening(
      [q('avail', 'BOOLEAN', yesNo)],
      [{ questionId: 'avail', answerValue: true }],
    );
    expect(r.score).toBe(1);
    expect(r.max).toBe(1);
    expect(r.lines[0].label).toBe('Yes');
  });

  test('a boolean false earns the "No" option\'s points, not the Yes one', () => {
    const r = scoreScreening(
      [q('avail', 'BOOLEAN', yesNo)],
      [{ questionId: 'avail', answerValue: false }],
    );
    expect(r.score).toBe(0);
    expect(r.lines[0].label).toBe('No');
  });

  test.each([['true'], ['TRUE'], ['Yes'], ['y'], ['1'], [true]])(
    'accepts %p however it was submitted', (submitted) => {
      const r = scoreScreening(
        [q('avail', 'BOOLEAN', yesNo)],
        [{ questionId: 'avail', answerValue: submitted }],
      );
      expect(r.score).toBe(1);
    },
  );

  test.each([['Y', 1], ['TRUE', 1], ['1', 1]])(
    'matches however HR spelled the option value (%p)', (optionValue, expected) => {
      const r = scoreScreening(
        [q('avail', 'BOOLEAN', [opt(optionValue, 1), opt('No', 0)])],
        [{ questionId: 'avail', answerValue: true }],
      );
      expect(r.score).toBe(expected);
    },
  );

  test('a knockout configured as "Yes" accepts the form\'s boolean true', () => {
    const r = scoreScreening(
      [q('avail', 'BOOLEAN', yesNo, { isKnockout: true, knockoutValue: 'Yes' })],
      [{ questionId: 'avail', answerValue: true }],
    );
    expect(r.knockedOut).toBe(false);
    expect(r.score).toBe(1);
  });

  test('a knockout still FAILS on the wrong answer', () => {
    const r = scoreScreening(
      [q('avail', 'BOOLEAN', yesNo, { isKnockout: true, knockoutValue: 'Yes' })],
      [{ questionId: 'avail', answerValue: false }],
    );
    expect(r.knockedOut).toBe(true);
  });

  // The normalisation must NOT leak into other kinds: an option genuinely
  // labelled "No" on a multiple-choice list is a real answer, not a false.
  test('SINGLE_CHOICE options named Yes/No are still matched literally', () => {
    const r = scoreScreening(
      [q('pick', 'SINGLE_CHOICE', [opt('Yes', 5), opt('No', 3), opt('Maybe', 1)])],
      [{ questionId: 'pick', answerValue: 'Maybe' }],
    );
    expect(r.score).toBe(1);
    expect(r.lines[0].label).toBe('Maybe');
  });

  test('an unanswered Yes/No scores 0 but still counts toward the total', () => {
    const r = scoreScreening([q('avail', 'BOOLEAN', yesNo)], []);
    expect(r.score).toBe(0);
    expect(r.max).toBe(1);
  });

  // The reported screen: 4 Yes/No answers were being thrown away.
  test('the reported form scores 7/9, not 3/9', () => {
    const questions = [
      q('qual', 'SINGLE_CHOICE', [opt("Bachelor's Degree", 1), opt('PhD', 3)]),
      q('spec', 'SINGLE_CHOICE', [opt('Computer Science', 1)]),
      q('acad', 'SINGLE_CHOICE', []),
      q('exp', 'SINGLE_CHOICE', [opt('1-2 Year', 1)]),
      q('ft', 'BOOLEAN', yesNo, { isKnockout: true }),
      q('dur', 'BOOLEAN', yesNo, { isKnockout: true }),
      q('course', 'BOOLEAN', yesNo),
      q('tested', 'BOOLEAN', yesNo),
    ];
    const answers = [
      { questionId: 'qual', answerValue: "Bachelor's Degree" },
      { questionId: 'spec', answerValue: 'Computer Science' },
      { questionId: 'exp', answerValue: '1-2 Year' },
      { questionId: 'ft', answerValue: true },
      { questionId: 'dur', answerValue: true },
      { questionId: 'course', answerValue: true },
      { questionId: 'tested', answerValue: true },
    ];
    const r = scoreScreening(questions, answers);
    expect(r.score).toBe(7);
    expect(r.max).toBe(9);
    expect(r.knockedOut).toBe(false);

    const merit = computeMeritScore(
      { screeningScore: r.score, screeningMax: r.max, interviewScore: null, knockedOut: r.knockedOut },
      { applicationWeightPct: 40, interviewWeightPct: 60 },
    );
    // No interview yet → weights renormalise, so merit is the application %.
    expect(merit.merit).toBeCloseTo(77.78, 1);
    expect(merit.breakdown.effectiveApplicationWeightPct).toBe(100);
  });
});
