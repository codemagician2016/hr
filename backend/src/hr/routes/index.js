'use strict';
// HR vertical API aggregator — mounted at /api/hr in backend/src/index.js.
// Each sub-router owns one HR domain area; controllers are tenant-scoped by
// req.user.businessId. Payroll + compliance register here as they are built
// (see docs/19-delivery-plan.md phasing).
const express = require('express');
const router = express.Router();

router.use('/employees', require('./employee.routes'));
router.use('/org', require('./org.routes'));
router.use('/leave', require('./leave.routes'));
router.use('/attendance', require('./attendance.routes'));
router.use('/compensation', require('./compensation.routes'));
router.use('/documents', require('./documents.routes'));
router.use('/assets', require('./assets.routes'));
router.use('/expenses', require('./expenses.routes'));
router.use('/loans', require('./loans.routes'));
router.use('/letters/templates', require('../letters/routes/templates.routes'));

// Employee lifecycle (Feature 4) — onboarding pipeline + checklist tasks. RBAC:
// reads/task actions are F1-scoped (canViewEmployees; manager sees only sub-tree
// hires), HR pipeline actions require canManageOnboarding. Separation/e-sign land
// in later slices (4d/4f).
router.use('/onboarding', require('../lifecycle/routes/onboarding.routes'));
router.use('/separations', require('../lifecycle/routes/offboarding.routes'));
router.use('/esign', require('../lifecycle/routes/esign.routes'));

// Talent (recruitment/ATS + performance). RBAC: recruitment -> canManageEmployees;
// performance -> canViewEmployees (read) / canManageEmployees (write). The offer
// pre-flight reuses the payroll engine's India 50% wage check.
const talent = require('../talent/routes');
router.use('/recruitment', talent.recruitment);
router.use('/performance', talent.performance);
// Feature 8 ESS — employee self-service performance (customer session, self-only).
router.use('/ess/performance', talent.essPerformance);

// Payroll orchestration — operator API (RBAC: canRunPayroll / canApprovePayroll
// / canViewPayrollReports) and the ESS payslip API (customer session). The
// /me/payslips router uses the customer-auth middleware internally.
router.use('/payroll', require('../payroll/payroll.routes'));
router.use('/me/payslips', require('../payroll/mePayslips.routes'));
// ESS profile/country surface — the authoritative country source for the ESS app
// (tax declaration, payslip currency, separation labels gate by it; fail-closed).
router.use('/me/profile', require('../lifecycle/routes/meProfile.routes'));
router.use('/me/onboarding', require('../lifecycle/routes/meOnboarding.routes'));
router.use('/me/separation', require('../lifecycle/routes/meSeparation.routes'));
router.use('/me/documents', require('./meDocuments.routes'));
// ESS compensation (CTC breakup waterfall + history + letters). Customer session;
// SELF_ONLY; no `:id` path → cross-employee leakage is structurally impossible.
router.use('/me/compensation', require('./meCompensation.routes'));

// Reports / analytics — read-only payroll register, statutory summary,
// headcount & attrition, leave liability. RBAC: canViewPayrollReports.
router.use('/reports', require('../reports/reports.routes'));

// Integrations — accounting GL export (operator) + public read-only HR API.
//   /api/hr/integrations  → operator API (session auth + RBAC)
//   /api/hr/v1            → public read-only API (ApiKey auth, no session)
// HR notification templates (integrations/notifications.js) and webhook
// emitters (integrations/webhooks.js) are libraries invoked from domain code,
// not HTTP routers, so they are not mounted here.
router.use('/integrations', require('../integrations/integrations.routes'));
router.use('/v1', require('../integrations/publicV1.routes'));

module.exports = router;
