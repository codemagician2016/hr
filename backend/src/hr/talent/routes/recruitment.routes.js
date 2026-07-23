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
const { requireEntitlement } = require('../../../core/middleware/requireEntitlement');
const { effectivePermissions } = require('../../../core/lib/rbac');
const { ROLES } = require('../../../core/lib/roles');
const { attachSelfEmployee } = require('../../middleware/scope.middleware');
const { attachRecruitmentScope } = require('../recruitment/recruitmentScope');
const c = require('../controllers/recruitment.controller');
const s = require('../recruitment/recruitment.scoring.controller');
// Feature 36 — candidate communication (scheduling handshake, bulk message,
// template library + comms config).
const cc = require('../recruitment/candidateComms.controller');

router.use(protect);
// Talent Acquisition is a paid ADD-ON — gate the WHOLE recruitment surface behind
// the tenant's entitlement (402 if their plan needs renewal, 403 if the add-on
// isn't owned). Sits ABOVE the per-route RBAC: entitlement = WHETHER the tenant's
// plan includes the module; RBAC = WHO inside the tenant may use it.
router.use(requireEntitlement('talent_acquisition', 'Talent Acquisition'));

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
// Read gate = the canView permission AND F1 read-scope resolution. The scope
// middleware attaches req.recruitmentScope (the hiring-manager id-set the caller
// may read across); the read handlers AND it into every query so a Manager/
// Recruiter sees ONLY their own requisitions' jobs/candidates/applications/
// merit/interviews/offers (admin/HR keep the tenant-wide view).
const canView = [
  requireAny('canViewHiring', 'canViewEmployees', 'canManageHiring', 'canManageEmployees'),
  ...attachRecruitmentScope('canViewHiring'),
];

// ── Jobs ─────────────────────────────────────────────────────────────────────
router.get('/jobs', canView, c.listJobs);
router.get('/jobs/:id', canView, c.getJob);
// Share / public link + per-job funnel summary (read-scoped).
router.get('/jobs/:id/share', canView, c.shareJob);
router.get('/jobs/:id/summary', canView, c.jobSummary);
router.post('/jobs', canManage, c.createJob);
// Job WRITES are F1 read-scoped (same as close): a scoped recruiter can only
// mutate/publish/unpublish/delete a requisition they own (out-of-scope → 404),
// and updateJob additionally blocks a non-ALL band from reassigning
// hiringManagerId to widen its own scope (priv-esc, §6/§9.3).
const writeScoped = [canManage, ...attachRecruitmentScope('canViewHiring')];
router.patch('/jobs/:id', writeScoped, c.updateJob);
router.delete('/jobs/:id', writeScoped, c.removeJob);
router.post('/jobs/:id/publish', writeScoped, c.publishJob);
// Prominent Publish/Unpublish-to-careers toggle (auto-derives the public slug).
router.post('/jobs/:id/set-public', writeScoped, c.setJobPublic);
// Close needs read-scope resolved so a recruiter can only close a job they own.
router.post('/jobs/:id/close', writeScoped, c.closeJob);

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
// Bulk reject / shortlist / set-status over the CURRENT FILTER (scoped + audited).
// Needs the F1 read-scope resolved so the server can intersect the target set with
// the caller's reachable requisitions — a client can never act out of scope.
router.post('/applications/bulk-action', [canManage, ...attachRecruitmentScope('canViewHiring')], c.bulkApplicationAction);
// Feature 36 — bulk candidate MESSAGE over the same scoped/filtered set (reuses
// bulkApplicationAction's accessibleJobIds + filter + scope resolution verbatim).
router.post('/applications/bulk-message', [canManage, ...attachRecruitmentScope('canViewHiring')], cc.bulkMessage);

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
// Feature 36 — interview scheduling handshake (propose N slots → candidate confirms
// one on the public link). Scope-resolved so a recruiter can only propose on a
// requisition they own (out-of-scope → 404).
router.post('/interviews/:id/propose-slots', writeScoped, cc.proposeSlots);
router.post('/interviews/:id/withdraw-slots', writeScoped, cc.withdrawSlots);

// ── Interviewer self-service (scope-bound to the caller's own Employee) ───────
const canScore = requireAny('canScoreInterview', 'canManageHiring', 'canManageEmployees');
router.get('/me/interviews', canScore, attachSelfEmployee, s.myInterviews);
router.get('/me/scorecards/:interviewId', canScore, attachSelfEmployee, s.myScorecard);
router.patch('/me/scorecards/:id', canScore, attachSelfEmployee, s.saveMyScorecard);
router.post('/me/scorecards/:id/submit', canScore, attachSelfEmployee, s.submitMyScorecard);

// ── Candidate-message template library + per-tenant comms config (Feature 36) ──
// The library edits the per-tenant BODY override for the 8 HR_CAND_*/interview
// keys (token-validated; system templates are editable-but-not-deletable).
router.get('/comms-templates', canView, cc.listCommsTemplates);
router.put('/comms-templates/:key', canManage, cc.updateCommsTemplate);
router.delete('/comms-templates/:key', canManage, cc.resetCommsTemplate);
router.get('/comms-config', canManage, cc.getCommsConfig);
router.put('/comms-config', canManage, cc.updateCommsConfig);

// ── Offers (50% wage pre-flight runs in createOffer) ─────────────────────────
// Offer create/send/accept/decline/render/sign are F1 read-scoped: a scoped
// recruiter can only draft/extend/finalise an offer on an application in a
// requisition they own (out-of-scope → 404). attachRecruitmentScope ALSO runs
// attachSelfEmployee, so the offer-approval SoD (maker ≠ checker, §9.4) still has
// the actor's own Employee resolved on send/accept.
const offerScoped = [canManage, ...attachRecruitmentScope('canViewHiring')];
router.get('/offers', canView, c.listOffers);
router.get('/offers/:id', canView, c.getOffer);
router.post('/offers', offerScoped, c.createOffer);
// send/accept carry the offer-approval SoD: attachSelfEmployee (via the scope
// middleware) resolves the actor's own Employee so the controller can reject a
// scorer/panellist approving their own candidate's offer (maker ≠ checker, §9.4).
router.post('/offers/:id/send', offerScoped, c.sendOffer);
router.post('/offers/:id/accept', offerScoped, c.acceptOffer);
router.post('/offers/:id/decline', offerScoped, c.declineOffer);
router.post('/offers/:id/render-letter', offerScoped, c.renderOfferLetter);
router.post('/offers/:id/request-signature', offerScoped, s.requestOfferSignature);

module.exports = router;
