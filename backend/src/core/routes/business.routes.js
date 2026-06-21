const express = require('express');
const router = express.Router();
const { protect, requireRole, requirePermission } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const { requireBusiness } = require('../../core/middleware/requireBusiness');
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
const { getHours, setHours, getHolidays, addHoliday, removeHoliday } = require('../../booking/controllers/hours.controller');
const { getChecklist, launch, unpublish } = require('../controllers/launch.controller');
const { listEnquiries, updateEnquiryStatus, deleteEnquiry } = require('../../web/controllers/enquiry.controller');
const {
  listPages,
  getPage,
  createPage,
  updatePage,
  deletePage,
  togglePublish,
  getSiteNav,
  updateSiteNav,
  listPagePresets,
  addPagePreset,
} = require('../../web/controllers/page.controller');
const {
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  loadSampleProducts,
  bulkMoveProducts,
} = require('../../shop/controllers/product.controller');
const {
  listVariants,
  createVariant,
  updateVariant,
  deleteVariant,
} = require('../../shop/controllers/productVariant.controller');
const {
  createCategorySchema,
  updateCategorySchema,
  createProductSchema,
  updateProductSchema,
} = require('../../core/lib/schemas/product.schema');
const {
  listOrders,
  getOrder,
  updateOrderStatus,
} = require('../../shop/controllers/order.controller');
const { exportBusinessData } = require('../controllers/dataExport.controller');
const { getReport, exportAppointments } = require('../controllers/reports.controller');
const { validateBody, validateQuery } = require('../../core/lib/validate');
const { setHoursSchema, addHolidaySchema } = require('../../core/lib/schemas/hours.schema');
const { setupBusinessSchema, updateBusinessSettingsSchema } = require('../../core/lib/schemas/business.schema');
const { updateEnquiryStatusSchema } = require('../../core/lib/schemas/enquiry.schema');
const { reportRangeSchema, exportRangeSchema } = require('../../core/lib/schemas/reports.schema');
const { bulkMessage } = require('../../booking/controllers/appointment.controller');
const { bulkMessageSchema } = require('../../core/lib/schemas/bulkMessage.schema');
const { listWaitlist, updateWaitlist, removeWaitlist } = require('../../booking/controllers/waitlist.controller');
const { updateWaitlistStatusSchema } = require('../../core/lib/schemas/waitlist.schema');
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
const domainAdmin = require('../../domains/domainAdmin.controller');
const mailboxAdmin = require('../controllers/mailbox.controller');

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

// Domain reseller — tenant owner self-service. Search is authenticated here
// so onboarding/admin can use one shape; a public read-only search also
// exists under /api/storefront/:slug/domain/search.
router.get('/domains/search', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.search);
router.get('/domains', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.list);
router.post('/domains/checkout', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.checkout);
router.post('/domains/register', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.register);
router.post('/domains/transfer-in', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.transferIn);
router.post('/domains/byod', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.byod);
router.post('/domains/sync-paddle-payment', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.syncPayment);
// Reseller business email (Zoho mailbox) — create + status
router.post('/mailbox/provision', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, mailboxAdmin.provision);
router.get('/mailbox', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, mailboxAdmin.list);
router.get('/domains/:id/transfer-status', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.transferStatus);
router.post('/domains/:id/auth-code', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.authCode);
router.post('/domains/:id/privacy', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.privacy);
router.post('/domains/:id/toggle-privacy', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.privacy);
router.post('/domains/:id/auto-renew', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.autoRenew);
router.post('/domains/:id/toggle-autorenew', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.autoRenew);
router.post('/domains/:id/renew', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.renew);
router.post('/domains/:id/primary', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.primary);
router.post('/domains/:id/redirect', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.redirect);
router.delete('/domains/:id', protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, domainAdmin.remove);

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
router.post('/appointments/bulk-message', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), validateBody(bulkMessageSchema), bulkMessage);

// Video integrations (Google Meet / Zoom / MS Teams). Auth-required for
// list / connect / disconnect; the OAuth callback is exempt because
// providers redirect there server-side without our cookies — auth is
// proven by the JWT-signed `state` parameter we set when starting the
// flow.
router.get('/integrations',                          protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), listIntegrations);
router.post('/integrations/:provider/connect',       protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), startIntegrationConnect);
router.get('/integrations/:provider/callback',       handleIntegrationCallback);
router.delete('/integrations/:provider',             protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), disconnectIntegration);

// Waitlist management — admin only.
router.get('/waitlist',         protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), listWaitlist);
router.patch('/waitlist/:id',   protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), validateBody(updateWaitlistStatusSchema), updateWaitlist);
router.delete('/waitlist/:id',  protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), removeWaitlist);

// Business hours + holidays — BUSINESS_ADMIN only
router.get('/hours', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), getHours);
router.put('/hours', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), validateBody(setHoursSchema), setHours);
// Holidays double as "days you don't deliver" for ECOMMERCE (grocery) — the
// storefront slot engine suppresses delivery on these dates — so the holiday
// endpoints are open to ECOMMERCE too (hours stay APPOINTMENT-only).
router.get('/holidays', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT', 'ECOMMERCE'), getHolidays);
router.post('/holidays', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT', 'ECOMMERCE'), validateBody(addHolidaySchema), addHoliday);
router.delete('/holidays/:id', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT', 'ECOMMERCE'), removeHoliday);

// Launch checklist
router.get('/launch-checklist', protect, requireRole(ROLES.BUSINESS_ADMIN), getChecklist);
router.post('/launch', protect, requireRole(ROLES.BUSINESS_ADMIN), launch);
router.post('/unpublish', protect, requireRole(ROLES.BUSINESS_ADMIN), unpublish);

// Customer list + per-customer history.
router.get('/customers',                     protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('APPOINTMENT'), listCustomers);
router.get('/customers/:customerId/history', protect, requireRole(ROLES.BUSINESS_ADMIN, ROLES.STAFF), requireVertical('APPOINTMENT'), getCustomerHistory);

// Enquiries from the public contact form — BUSINESS_ADMIN only
router.get('/enquiries',           protect, requireRole(ROLES.BUSINESS_ADMIN), listEnquiries);
router.patch('/enquiries/:id',     protect, requireRole(ROLES.BUSINESS_ADMIN), validateBody(updateEnquiryStatusSchema), updateEnquiryStatus);
router.delete('/enquiries/:id',    protect, requireRole(ROLES.BUSINESS_ADMIN), deleteEnquiry);

// Multi-page CMS — BUSINESS_ADMIN only. Public storefront-facing read
// route lives on storefront.routes.js (/api/storefront/:slug/pages).
// Pages CMS — every endpoint is tenant-scoped, so requireBusiness gates
// once at the route layer instead of at the top of each controller body.
router.get('/pages',                  protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, listPages);
router.post('/pages',                 protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, createPage);
router.get('/pages/:id',              protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, getPage);
router.put('/pages/:id',              protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, updatePage);
router.delete('/pages/:id',           protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, deletePage);
router.put('/pages/:id/publish',      protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, togglePublish);
// Sprint 3.3 — Pages v2 nav manager (drag-to-nest tree)
router.get('/site-nav',               protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, getSiteNav);
router.put('/site-nav',               protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, updateSiteNav);
// Sprint 3.3b — Quick-add preset pages
router.get('/page-presets',           protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, listPagePresets);
router.post('/pages/from-preset',     protect, requireRole(ROLES.BUSINESS_ADMIN), requireBusiness, addPagePreset);

// E-commerce — Product + Category CRUD. Enforce vertical on the backend too,
// so STATIC/APPOINTMENT tenants cannot deep-link into hidden shop data.
router.get('/categories',             protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), listCategories);
router.post('/categories',            protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), validateBody(createCategorySchema), createCategory);
router.get('/categories/:id',         protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), getCategory);
router.put('/categories/:id',         protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), validateBody(updateCategorySchema), updateCategory);
router.delete('/categories/:id',      protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), deleteCategory);

router.get('/products',               protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), listProducts);
router.post('/products',              protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageProducts'), validateBody(createProductSchema), createProduct);
router.post('/products/load-samples', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageProducts'), loadSampleProducts);
router.post('/products/bulk-move',    protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageProducts'), bulkMoveProducts);
router.get('/products/:id',           protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), getProduct);
router.put('/products/:id',           protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageProducts'), validateBody(updateProductSchema), updateProduct);
router.delete('/products/:id',        protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageProducts'), deleteProduct);

// Product variants — size/weight/unit options within one product family.
router.get('/products/:productId/variants',              protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), listVariants);
router.post('/products/:productId/variants',             protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageProducts'), createVariant);
router.patch('/products/:productId/variants/:variantId', protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageProducts'), updateVariant);
router.delete('/products/:productId/variants/:variantId',protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageProducts'), deleteVariant);

// E-commerce Phase 2 — Orders. Read + status-mutate only; orders are
// created by the storefront /checkout endpoint, not the admin.
router.get('/orders',                 protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), listOrders);
router.get('/orders/:id',             protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), getOrder);
router.patch('/orders/:id',           protect, requireRole(ROLES.BUSINESS_ADMIN), requireVertical('ECOMMERCE'), requirePermission('canManageOrders'), updateOrderStatus);

module.exports = router;
