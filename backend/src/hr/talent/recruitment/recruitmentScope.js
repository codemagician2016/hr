'use strict';

/**
 * recruitmentScope.js — Feature 12 read-scope (F1 hierarchical RBAC for the ATS).
 *
 * Spec §6/§9.3 + rbac.js: a hiring-manager / recruiter read is requisition-scoped
 * — they see ONLY the jobs they own (Job.hiringManagerId in their F1 reporting
 * sub-tree) and the candidates / applications / merit / interviews / offers in
 * those jobs. Admin/HR (scope band ALL) keep the tenant-wide view. An interviewer
 * who owns no requisition still reaches the interviews they were panelled onto
 * (and only those) via the assigned-interview fallback.
 *
 * THE single chokepoint reuses F1's resolveAccessibleEmployeeIds — it does NOT
 * re-implement the hierarchy. The middleware attaches:
 *   req.recruitmentScope = { kind:'ALL' } | { kind:'IDS', ids:Set } | { kind:'NONE' }
 * which is the set of *hiring-manager* employee ids the caller may read across.
 */

const prisma = require('../../../core/lib/prisma');
const { resolveAccessibleEmployeeIds } = require('../../lib/scopeResolver');
const { attachSelfEmployee } = require('../../middleware/scope.middleware');

// Resolve the recruitment read scope and attach it. Runs attachSelfEmployee first
// so the F1 resolver has a self anchor (employeeId) for the TEAM sub-tree.
function attachRecruitmentScope(action = 'canViewHiring') {
  return [
    attachSelfEmployee,
    async function recruitmentScopeGuard(req, res, next) {
      try {
        req.recruitmentScope = await resolveAccessibleEmployeeIds(req.user, action);
        return next();
      } catch (err) {
        return next(err);
      }
    },
  ];
}

// Build the Job `where` fragment that restricts a query to the jobs the caller may
// read. ALL → no restriction; NONE → match-nothing; IDS → hiringManagerId ∈ ids.
// A job with NO hiringManagerId is an unassigned/HR-owned requisition: only the
// ALL band (admin/HR) sees it, never a scoped recruiter.
function jobScopeWhere(scope) {
  if (!scope || scope.kind === 'ALL') return {};
  if (scope.kind === 'NONE') return { id: { in: [] } };
  return { hiringManagerId: { in: [...scope.ids] } };
}

// True when the caller's scope reaches a given job (used to 404 out-of-scope :id).
function scopeAllowsJob(scope, job) {
  if (!scope || scope.kind === 'ALL') return true;
  if (scope.kind === 'NONE') return false;
  return !!(job && job.hiringManagerId && scope.ids.has(job.hiringManagerId));
}

// Resolve the set of jobIds (within the tenant) the caller may read, honouring the
// scope. Returns { all:true } for the unrestricted band, else { ids:string[] }.
// Centralises the "applications/interviews/offers/merit live under a scoped job"
// join so every list handler filters identically.
async function accessibleJobIds(businessId, scope) {
  if (!scope || scope.kind === 'ALL') return { all: true };
  if (scope.kind === 'NONE') return { all: false, ids: [] };
  const jobs = await prisma.job.findMany({
    where: { businessId, deletedAt: null, hiringManagerId: { in: [...scope.ids] } },
    select: { id: true },
  });
  return { all: false, ids: jobs.map((j) => j.id) };
}

// The set of interview ids the caller is personally panelled onto (assigned-
// interviewer fallback). interviewerIds is a CSV; we contains-match then verify
// the token so a substring of another id can't leak an interview.
async function assignedInterviewIds(businessId, selfEmployeeId) {
  if (!selfEmployeeId) return [];
  const rows = await prisma.interview.findMany({
    where: { businessId, interviewerIds: { contains: selfEmployeeId } },
    select: { id: true, interviewerIds: true },
  });
  return rows
    .filter((iv) => String(iv.interviewerIds || '').split(',').map((s) => s.trim()).includes(selfEmployeeId))
    .map((iv) => iv.id);
}

module.exports = {
  attachRecruitmentScope,
  jobScopeWhere,
  scopeAllowsJob,
  accessibleJobIds,
  assignedInterviewIds,
};
