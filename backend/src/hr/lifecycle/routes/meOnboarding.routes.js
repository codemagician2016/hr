'use strict';

/**
 * meOnboarding.routes.js — new-hire SELF-SERVICE onboarding API (Feature 4 §4.2,
 * §4.5, §6, slice 4b). Mounted at /api/hr/me/onboarding by the HR aggregator.
 *
 * AUTH (§4.5 "no :id in the path"):
 *   - Logged-in new hire → CUSTOMER session (the ESS portal). `requireCustomer`
 *     resolves req.customer; the controller derives the subject Employee/journey
 *     from the session — never from the body.
 *   - Pre-join candidate (no portal account yet) → a hashed, expiring magic-link
 *     token in ?token= / X-Onboarding-Token. When a token is present we SKIP the
 *     customer gate and let the controller resolve the journey by token hash
 *     (expired/invalid → 401). The token maps to exactly one journey, so a
 *     cross-employee write is structurally impossible either way.
 *
 * There is intentionally no permission/scope middleware here: the surface is
 * self-only by construction (the subject is the session/token, not a path id).
 */

const express = require('express');
const router = express.Router();
const { authenticateCustomer } = require('../../../core/middleware/auth.middleware');
const c = require('../controllers/meOnboarding.controller');

// Auth gate: a pre-join token bypasses the session (the controller validates the
// token + its expiry). Otherwise an authenticated ESS customer is required.
async function customerOrPreJoinToken(req, res, next) {
  const hasToken = (req.query && req.query.token) || req.get('x-onboarding-token');
  if (hasToken) return next(); // token path — resolved + validated in the controller
  try {
    req.customer = await authenticateCustomer(req, res);
    req.authType = 'customer';
    return next();
  } catch (err) {
    return res.status(err.statusCode || 401).json({ message: err.message || 'Not authenticated' });
  }
}

router.use(customerOrPreJoinToken);

// The caller's own active onboarding journey + tasks + completeness vector.
router.get('/', c.getMyOnboarding);

// Stage a self-service section + mark the matching COLLECT_* task DONE.
router.post('/personal', c.postPersonal);
router.post('/statutory', c.postStatutory); // 422 with field errors on invalid statutory
router.post('/bank', c.postBank);
router.post('/emergency', c.postEmergency);

// Upload a document (base64 data URL → s3.uploadDataUrl → real EmployeeDocument).
router.post('/documents', c.postDocuments);

// Guarded submit: blocked (422) until required docs + tasks done; advances stage.
router.post('/submit', c.submitOnboarding);

module.exports = router;
