const express = require('express');
const router = express.Router();
const { protect, requireRole } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const { requireVertical } = require('../../core/middleware/requireVertical');
const {
  checkSlug,
  setup,
  getMyBusiness,
  getMyBusinessContext,
  inviteStaff,
  quickAddStaff,
  listStaff,
  updateStaff,
  removeStaff,
  getContent,
  updateContent,
  getReminderConfig,
  updateReminderConfig,
  listCustomers,
  getCustomerHistory,
  listEmailDeliveries,
  updateSettings,
  verticalImpact,
  requestDeletion,
  undoDeletion,
  getFeatureFlags,
} = require('../controllers/business.controller');
const { getChecklist, launch, unpublish } = require('../controllers/launch.controller');
const { exportBusinessData } = require('../controllers/dataExport.controller');
const { getReport, exportAppointments } = require('../controllers/reports.controller');
const { validateBody, validateQuery } = require('../../core/lib/validate');
const { setupBusinessSchema, updateBusinessSettingsSchema } = require('../../core/lib/schemas/business.schema');
const { reportRangeSchema, exportRangeSchema } = require('../../core/lib/schemas/reports.schema');
const {
  listForBusiness: listIntegrations,
  startConnect: startIntegrationConnect,
  handleCallback: handleIntegrationCallback,
  disconnect: disconnectIntegration,
} = require('../controllers/integration.controller');
const {
  getSeo,
  updateSeoSettings,
  updateSeoPages,
  exportSeoCsv,
  importSeoCsv,
  getRedirects,
  saveRedirect,
  deleteRedirect,
  importRedirectsCsv,
} = require('../controllers/seoCenter.controller');

// Public — anyone can check if a slug is available (used during onboarding)
router.get('/check-slug', checkSlug);

// Any authenticated user can call setup — it promotes them to BUSINESS_ADMIN on first call
router.post('/setup', protect, validateBody(setupBusinessSchema), setup);
router.get('/context', protect, getMyBusinessContext);

// Read/write business + manage staff — BUSINESS_ADMIN only
router.get('/me', protect, requireRole(ROLES.BUSINESS_ADMIN), getMyBusiness);
router.patch('/settings', protect, requireRole(ROLES.BUSINESS_ADMIN), validateBody(updateBusinessSettingsSchema), updateSettings);
// Read the feature catalog + current admin overrides + resolved effective
// state. Drives the admin Features Settings panel. Patch happens via the
// existing /settings endpoint (featureFlags is one of the accepted fields).
router.get('/feature-flags', protect, requireRole(ROLES.BUSINESS_ADMIN), getFeatureFlags);
router.get('/vertical-impact', protect, requireRole(ROLES.BUSINESS_ADMIN), verticalImpact);

// Custom-domain BINDING for the white-label ESS (connect/verify/disconnect an
// EXISTING tenant-owned domain via Cloudflare-for-SaaS) lives in
// subscription.routes.js under /api/subscription/custom-domain*. Domain
// REGISTRATION/PURCHASE and business-email/mailbox RESALE were removed — we
// do not sell domains or mailboxes.

// GDPR Art. 20 / NZ Privacy Act IPP 6 right-to-portability — exports a
// JSON snapshot of everything we hold for this business.
router.get('/data-export', protect, requireRole(ROLES.BUSINESS_ADMIN), exportBusinessData);

// GDPR Article 17 — soft-delete with 30-day grace. The cron in
// backend/src/core/lib/accountDeletion.js purges PII after grace expires.
router.post('/request-deletion', protect, requireRole(ROLES.BUSINESS_ADMIN), requestDeletion);
router.post('/undo-deletion',    protect, requireRole(ROLES.BUSINESS_ADMIN), undoDeletion);
router.post('/staff', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT', 'ECOMMERCE'), inviteStaff);
router.post('/staff/card', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT', 'ECOMMERCE'), quickAddStaff);
router.get('/staff', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT', 'ECOMMERCE'), listStaff);
router.patch('/staff/:id', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT', 'ECOMMERCE'), updateStaff);
router.delete('/staff/:id', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT', 'ECOMMERCE'), removeStaff);
router.get('/content', protect, requireRole(ROLES.BUSINESS_ADMIN), getContent);
router.put('/content', protect, requireRole(ROLES.BUSINESS_ADMIN), updateContent);
router.get('/reminder-config', protect, requireRole(ROLES.BUSINESS_ADMIN), getReminderConfig);
router.put('/reminder-config', protect, requireRole(ROLES.BUSINESS_ADMIN), updateReminderConfig);
router.get('/seo', protect, requireRole(ROLES.BUSINESS_ADMIN), getSeo);
router.put('/seo/settings', protect, requireRole(ROLES.BUSINESS_ADMIN), updateSeoSettings);
router.put('/seo/pages', protect, requireRole(ROLES.BUSINESS_ADMIN), updateSeoPages);
router.get('/seo/export.csv', protect, requireRole(ROLES.BUSINESS_ADMIN), exportSeoCsv);
router.post('/seo/import', protect, requireRole(ROLES.BUSINESS_ADMIN), importSeoCsv);
router.get('/seo/redirects', protect, requireRole(ROLES.BUSINESS_ADMIN), getRedirects);
router.post('/seo/redirects', protect, requireRole(ROLES.BUSINESS_ADMIN), saveRedirect);
router.delete('/seo/redirects/:id', protect, requireRole(ROLES.BUSINESS_ADMIN), deleteRedirect);
router.post('/seo/redirects/import', protect, requireRole(ROLES.BUSINESS_ADMIN), importRedirectsCsv);
router.get('/email-deliveries', protect, requireRole(ROLES.BUSINESS_ADMIN), listEmailDeliveries);
router.get('/reports', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), validateQuery(reportRangeSchema), getReport);
router.get('/appointments/export', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), validateQuery(exportRangeSchema), exportAppointments);

// Video integrations (Google Meet / Zoom / MS Teams). Auth-required for
// list / connect / disconnect; the OAuth callback is exempt because
// providers redirect there server-side without our cookies — auth is
// proven by the JWT-signed `state` parameter we set when starting the
// flow.
router.get('/integrations',                          protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), listIntegrations);
router.post('/integrations/:provider/connect',       protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), startIntegrationConnect);
router.get('/integrations/:provider/callback',       handleIntegrationCallback);
router.delete('/integrations/:provider',             protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), disconnectIntegration);

// Launch checklist
router.get('/launch-checklist', protect, requireRole(ROLES.BUSINESS_ADMIN), getChecklist);
router.post('/launch', protect, requireRole(ROLES.BUSINESS_ADMIN), launch);
router.post('/unpublish', protect, requireRole(ROLES.BUSINESS_ADMIN), unpublish);

// Customer list + per-customer history.
router.get('/customers',                     protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), listCustomers);
router.get('/customers/:customerId/history', protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.STAFF), requireVertical('APPOINTMENT'), getCustomerHistory);

module.exports = router;
