const express = require('express');
const router = express.Router();
const { requireAuth, requireSuperAdmin } = require('../../core/middleware/auth.middleware');
const {
  list,
  create,
  update,
  remove,
  redemptions,
} = require('../../booking/controllers/adminCoupon.controller');
const { validateBody } = require('../../core/lib/validate');
const {
  createAdminCouponSchema,
  updateAdminCouponSchema,
} = require('../../core/lib/schemas/adminCoupon.schema');

// All endpoints here require SUPER_ADMIN. Business-admin endpoints for
// validating and redeeming a coupon live under /api/subscription in
// subscription.routes.js — they only need BUSINESS_ADMIN auth.
router.use(requireAuth);
router.use(requireSuperAdmin);

router.get('/', list);
router.post('/', validateBody(createAdminCouponSchema), create);
router.put('/:id', validateBody(updateAdminCouponSchema), update);
router.delete('/:id', remove);
router.get('/:id/redemptions', redemptions);

module.exports = router;
