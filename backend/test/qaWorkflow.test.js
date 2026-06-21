const qaRoutes = require('../src/qa/qa.routes');

const {
  initialStatusForType,
  normalizeStatus,
  statusAllowedForType,
  allowedTransitions,
  canPmModerateIssue,
  agentAllowedTransition,
} = qaRoutes.__testing;

function memberUser(flags = {}) {
  return {
    id: flags.id || 'user-1',
    isAdmin: Boolean(flags.isAdmin),
    projectAccess: [
      {
        projectId: 'project-1',
        isActive: true,
        canTest: Boolean(flags.canTest),
        canDevelop: Boolean(flags.canDevelop),
        canApproveRecommendations: Boolean(flags.canApproveRecommendations),
        project: { isActive: true },
      },
    ],
  };
}

function issue(overrides = {}) {
  return {
    id: 'issue-1',
    projectId: 'project-1',
    type: 'RECOMMENDATION',
    status: 'PM_REVIEW',
    createdById: 'reporter-1',
    comments: [],
    ...overrides,
  };
}

describe('QA recommendation workflow', () => {
  test('recommendations start in PM review, while bugs start in development', () => {
    expect(initialStatusForType('RECOMMENDATION')).toBe('PM_REVIEW');
    expect(initialStatusForType('BUG')).toBe('DEVELOPMENT');
    expect(normalizeStatus('PENDING_PM_APPROVAL')).toBe('PM_REVIEW');
    expect(normalizeStatus('REJECTED')).toBe('CANCELLED');
  });

  test('PM review is valid only for recommendations, while cancelled is valid for every issue', () => {
    expect(statusAllowedForType('RECOMMENDATION', 'PM_REVIEW')).toBe(true);
    expect(statusAllowedForType('BUG', 'PM_REVIEW')).toBe(false);
    expect(statusAllowedForType('RECOMMENDATION', 'CANCELLED')).toBe(true);
    expect(statusAllowedForType('BUG', 'CANCELLED')).toBe(true);
  });

  test('only PM-write members can accept or reject a recommendation in PM review', () => {
    const recommendation = issue();

    expect(allowedTransitions(memberUser({ canTest: true }), recommendation)).toEqual([]);
    expect(allowedTransitions(memberUser({ canDevelop: true }), recommendation)).toEqual([]);
    expect(allowedTransitions(memberUser({ id: 'pm-1', canApproveRecommendations: true }), recommendation).sort())
      .toEqual(['CANCELLED', 'DEVELOPMENT']);
  });

  test('the creator cannot accept or reject their own recommendation', () => {
    const recommendation = issue({ createdById: 'reporter-1' });
    const creatorWithPmWrite = memberUser({ id: 'reporter-1', canTest: true, canApproveRecommendations: true });
    const adminCreator = memberUser({ id: 'reporter-1', isAdmin: true });

    expect(canPmModerateIssue(creatorWithPmWrite, recommendation)).toBe(false);
    expect(allowedTransitions(creatorWithPmWrite, recommendation)).toEqual([]);
    expect(allowedTransitions(adminCreator, recommendation)).not.toContain('DEVELOPMENT');
    expect(allowedTransitions(adminCreator, recommendation)).not.toContain('CANCELLED');
  });

  test('PM-write members can cancel any issue status', () => {
    const pm = memberUser({ id: 'pm-1', canApproveRecommendations: true });

    expect(allowedTransitions(pm, issue({ type: 'BUG', status: 'DEVELOPMENT' }))).toContain('CANCELLED');
    expect(allowedTransitions(pm, issue({ type: 'BUG', status: 'READY_FOR_QA' }))).toContain('CANCELLED');
    expect(allowedTransitions(pm, issue({ type: 'RECOMMENDATION', status: 'COMPLETED' }))).toContain('CANCELLED');
    expect(allowedTransitions(pm, issue({ type: 'BUG', status: 'CANCELLED' }))).not.toContain('CANCELLED');
  });

  test('after PM approval the normal developer and QA cycle applies', () => {
    const inDevelopment = issue({ status: 'DEVELOPMENT' });
    const readyForQa = issue({ status: 'READY_FOR_QA' });

    expect(allowedTransitions(memberUser({ canDevelop: true }), inDevelopment))
      .toEqual(['READY_FOR_QA']);
    expect(allowedTransitions(memberUser({ canApproveRecommendations: true }), readyForQa))
      .toEqual(['CANCELLED']);
    expect(allowedTransitions(memberUser({ canTest: true }), readyForQa).sort())
      .toEqual(['BACK_TO_DEVELOPMENT', 'COMPLETED']);
  });

  test('agent keys cannot skip PM review', () => {
    expect(agentAllowedTransition('PM_REVIEW', 'READY_FOR_QA')).toBe(false);
    expect(agentAllowedTransition('PM_REVIEW', 'DEVELOPMENT')).toBe(false);
    expect(agentAllowedTransition('DEVELOPMENT', 'READY_FOR_QA')).toBe(true);
    expect(agentAllowedTransition('BACK_TO_DEVELOPMENT', 'READY_FOR_QA')).toBe(true);
  });
});
