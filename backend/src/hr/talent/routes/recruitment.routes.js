'use strict';
// Recruitment / ATS routes — mounted at /api/hr/recruitment.
//
// RBAC (Feature 12): writes require canManageHiring (the recruiter/HR write key)
// OR canManageEmployees (the back-compat super-set the original routes used).
// Reads require canViewHiring OR canViewEmployees OR canManageEmployees. The
// interviewer self-service surface (/me/*) is gated on canScoreInterview +
// attachSelfEmployee and is hard-bound to the caller's own Employee (SoD).
// Tenant scope is enforced in the controllers via req.user.businessId.
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const { effectivePermissions } = require('../../../core/lib/rbac');
const { ROLES } = require('../../../core/lib/roles');
const { attachSelfEmployee } = require('../../middleware/scope.middleware');
const c = require('../controllers/recruitment.controller');
const s = require('../recruitment/recruitment.scoring.controller');

router.use(protect);

// Allow ANY of the listed permission keys (SUPER_ADMIN always passes). Lets the
// new canManageHiring/canViewHiring keys coexist with the legacy canManage*
// super-set without breaking existing operator roles.
function requireAny(...keys) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
    if (req.user.role === ROLES.SUPER_ADMIN) return next();
    const perms = effectivePermissions(req.user) || {};
    if (keys.some((k) => perms[k])) return next();
    return res.status(403).json({ message: `Forbidden: missing one of ${keys.join(', ')}`, missingPermission: keys[0] });
  };
}

const canManage = requireAny('canManageHiring', 'canManageEmployees');
const canView = requireAny('canViewHiring', 'canViewEmployees', 'canManageHiring', 'canManageEmployees');

// ── Jobs ─────────────────────────────────────────────────────────────────────
router.get('/jobs', canView, c.listJobs);
router.get('/jobs/:id', canView, c.getJob);
router.post('/jobs', canManage, c.createJob);
router.patch('/jobs/:id', canManage, c.updateJob);
router.delete('/jobs/:id', canManage, c.removeJob);
router.post('/jobs/:id/publish', canManage, c.publishJob);
router.post('/jobs/:id/close', canManage, c.closeJob);

// ── Job pipeline stages ──────────────────────────────────────────────────────
router.get('/jobs/:jobId/stages', canView, c.listStages);
router.post('/jobs/:jobId/stages', canManage, c.createStage);

// ── Screening questions (config) + answers ──────────────────────────────────
router.get('/jobs/:jobId/screening-questions', canView, s.listScreeningQuestions);
router.post('/jobs/:jobId/screening-questions', canManage, s.createScreeningQuestion);
router.patch('/screening-questions/:id', canManage, s.updateScreeningQuestion);
router.delete('/screening-questions/:id', canManage, s.removeScreeningQuestion);
router.post('/applications/:id/screening-answers', canManage, s.submitScreeningAnswers);

// ── Scorecard templates (reusable skill sets) ────────────────────────────────
router.get('/scorecard-templates', canView, s.listScorecardTemplates);
router.get('/scorecard-templates/:id', canView, s.getScorecardTemplate);
router.post('/scorecard-templates', canManage, s.createScorecardTemplate);
router.patch('/scorecard-templates/:id', canManage, s.updateScorecardTemplate);
router.delete('/scorecard-templates/:id', canManage, s.removeScorecardTemplate);

// ── Candidates ───────────────────────────────────────────────────────────────
router.get('/candidates', canView, c.listCandidates);
router.get('/candidates/:id', canView, c.getCandidate);
router.post('/candidates', canManage, c.createCandidate);
router.patch('/candidates/:id', canManage, c.updateCandidate);
router.delete('/candidates/:id', canManage, c.removeCandidate);

// ── Applications (pipeline) ──────────────────────────────────────────────────
router.get('/applications', canView, c.listApplications);
router.get('/applications/:id', canView, c.getApplication);
router.post('/applications', canManage, c.createApplication);
router.post('/applications/:id/move', canManage, c.moveApplication);
router.post('/applications/:id/recompute-score', canManage, s.recomputeScore);

// ── Merit list ───────────────────────────────────────────────────────────────
router.get('/jobs/:jobId/merit-list', canView, s.meritList);

// ── Interviews ───────────────────────────────────────────────────────────────
router.get('/interviews', canView, c.listInterviews);
router.post('/interviews', canManage, c.createInterview);
router.patch('/interviews/:id', canManage, c.updateInterview);
router.post('/interviews/:id/invite', canManage, s.inviteInterview);
router.post('/interviews/:id/reschedule', canManage, s.rescheduleInterview);
router.post('/interviews/:id/cancel', canManage, s.cancelInterview);
router.post('/scorecards/:id/reopen', canManage, s.reopenScorecard);

// ── Interviewer self-service (scope-bound to the caller's own Employee) ───────
const canScore = requireAny('canScoreInterview', 'canManageHiring', 'canManageEmployees');
router.get('/me/interviews', canScore, attachSelfEmployee, s.myInterviews);
router.get('/me/scorecards/:interviewId', canScore, attachSelfEmployee, s.myScorecard);
router.patch('/me/scorecards/:id', canScore, attachSelfEmployee, s.saveMyScorecard);
router.post('/me/scorecards/:id/submit', canScore, attachSelfEmployee, s.submitMyScorecard);

// ── Offers (50% wage pre-flight runs in createOffer) ─────────────────────────
router.get('/offers', canView, c.listOffers);
router.get('/offers/:id', canView, c.getOffer);
router.post('/offers', canManage, c.createOffer);
router.post('/offers/:id/send', canManage, c.sendOffer);
router.post('/offers/:id/accept', canManage, c.acceptOffer);
router.post('/offers/:id/decline', canManage, c.declineOffer);
router.post('/offers/:id/render-letter', canManage, c.renderOfferLetter);
router.post('/offers/:id/request-signature', canManage, s.requestOfferSignature);

module.exports = router;
