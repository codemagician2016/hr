const express = require('express');
const router = express.Router();
const { requireAuth, requireSuperAdmin } = require('../../core/middleware/auth.middleware');
const {
  billingActivity,
  billingInvoice,
  emailDeliveryActivity,
  listBusinesses,
  stats,
  dashboardAnalytics,
  businessAnalytics,
  toggleSuspend,
  deleteBusiness,
  getSettings,
  updateSetting,
} = require('../controllers/admin.controller');
const {
  listPlatformForSuperadmin,
  replyPlatformForSuperadmin,
} = require('../../core/controllers/support.controller');
const { getIndiaGstReport } = require('../controllers/gstReport.controller');
const { getComplianceRates } = require('../controllers/complianceRates.controller');

router.use(requireAuth);
router.use(requireSuperAdmin);

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

router.get('/businesses', listBusinesses);
router.get('/stats', stats);
// India GST (GSTR-1) export — self-billed Razorpay invoices for a date range.
router.get('/gst/india-invoices', wrap(getIndiaGstReport));
// Read-only effective statutory rates for the super-admin compliance console.
router.get('/compliance/rates', wrap(getComplianceRates));
router.get('/email-deliveries', emailDeliveryActivity);
router.get('/billing', billingActivity);
router.post('/billing/invoices/:transactionId', billingInvoice);
router.get('/dashboard', dashboardAnalytics);
router.get('/businesses/:id/analytics', businessAnalytics);
router.put('/businesses/:id/suspend', toggleSuspend);
router.delete('/businesses/:id', deleteBusiness);
router.get('/settings', getSettings);
router.put('/settings', updateSetting);
router.get('/support/conversations', wrap(listPlatformForSuperadmin));
router.post('/support/conversations/:id/messages', wrap(replyPlatformForSuperadmin));

module.exports = router;
