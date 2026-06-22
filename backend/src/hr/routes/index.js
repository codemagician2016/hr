'use strict';
// HR vertical API aggregator — mounted at /api/hr in backend/src/index.js.
// Each sub-router owns one HR domain area; controllers are tenant-scoped by
// req.user.businessId. New domains (attendance, leave, payroll, compliance)
// register here as they are built (see docs/19-delivery-plan.md phasing).
const express = require('express');
const router = express.Router();

router.use('/employees', require('./employee.routes'));
router.use('/org', require('./org.routes'));

module.exports = router;
