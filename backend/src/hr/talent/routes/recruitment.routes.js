'use strict';
// Recruitment / ATS routes — mounted at /api/hr/recruitment.
// Reads are open to any authenticated operator; all writes (job/candidate/
// application/interview/offer mutations + lifecycle transitions) require
// canManageEmployees. Tenant scope is enforced in the controller via
// req.user.businessId.
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/recruitment.controller');

router.use(protect);
const canManage = requirePermission('canManageEmployees');

// ── Jobs ─────────────────────────────────────────────────────────────────────
router.get('/jobs', c.listJobs);
router.get('/jobs/:id', c.getJob);
router.post('/jobs', canManage, c.createJob);
router.patch('/jobs/:id', canManage, c.updateJob);
router.delete('/jobs/:id', canManage, c.removeJob);
router.post('/jobs/:id/publish', canManage, c.publishJob);
router.post('/jobs/:id/close', canManage, c.closeJob);

// ── Job pipeline stages ──────────────────────────────────────────────────────
router.get('/jobs/:jobId/stages', c.listStages);
router.post('/jobs/:jobId/stages', canManage, c.createStage);

// ── Candidates ───────────────────────────────────────────────────────────────
router.get('/candidates', c.listCandidates);
router.get('/candidates/:id', c.getCandidate);
router.post('/candidates', canManage, c.createCandidate);
router.patch('/candidates/:id', canManage, c.updateCandidate);
router.delete('/candidates/:id', canManage, c.removeCandidate);

// ── Applications (pipeline) ──────────────────────────────────────────────────
router.get('/applications', c.listApplications);
router.get('/applications/:id', c.getApplication);
router.post('/applications', canManage, c.createApplication);
router.post('/applications/:id/move', canManage, c.moveApplication);

// ── Interviews ───────────────────────────────────────────────────────────────
router.get('/interviews', c.listInterviews);
router.post('/interviews', canManage, c.createInterview);
router.patch('/interviews/:id', canManage, c.updateInterview);

// ── Offers (50% wage pre-flight runs in createOffer) ─────────────────────────
router.get('/offers', c.listOffers);
router.get('/offers/:id', c.getOffer);
router.post('/offers', canManage, c.createOffer);
router.post('/offers/:id/send', canManage, c.sendOffer);
router.post('/offers/:id/accept', canManage, c.acceptOffer);
router.post('/offers/:id/decline', canManage, c.declineOffer);

module.exports = router;
