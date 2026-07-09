'use strict';

// Feature 38 careers portal routes. Two mounts:
//   /api/careers      — public + candidate-magic-link surface (entitlement-gated in
//                       the controller via resolveEntitledBusiness).
//   /api/candidate    — the authenticated candidate's own profile/applications.

const express = require('express');
const c = require('./careersPortal.controller');
const { requireCandidate } = require('./candidateAuth');

// ── public careers portal (unauth; tenant + add-on resolved by slug) ──
const publicRouter = express.Router();
publicRouter.post('/:slug/auth/request', c.requestMagicLink);
publicRouter.get('/:slug/auth/verify', c.verifyMagicLink);
publicRouter.get('/:slug/jobs', c.board);
publicRouter.get('/:slug/jobs/:publicSlug', c.jobDetail);
publicRouter.post('/:slug/jobs/:publicSlug/apply', c.apply);

// ── candidate self-service (magic-link session) ──
const candidateRouter = express.Router();
candidateRouter.post('/logout', c.logout);
candidateRouter.use(requireCandidate);
candidateRouter.get('/me', c.me);
candidateRouter.put('/me', c.updateMe);
candidateRouter.post('/resume', c.uploadResume);
candidateRouter.get('/applications', c.myApplications);
candidateRouter.post('/education', c.education.create);
candidateRouter.put('/education/:id', c.education.update);
candidateRouter.delete('/education/:id', c.education.remove);
candidateRouter.post('/experience', c.experience.create);
candidateRouter.put('/experience/:id', c.experience.update);
candidateRouter.delete('/experience/:id', c.experience.remove);
candidateRouter.post('/skill', c.skill.create);
candidateRouter.put('/skill/:id', c.skill.update);
candidateRouter.delete('/skill/:id', c.skill.remove);

module.exports = { publicRouter, candidateRouter };
