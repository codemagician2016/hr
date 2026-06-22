'use strict';
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const org = require('../controllers/org.controller');

// Reading org structure is open to any authenticated operator; mutations require
// the canManageOrg permission (Owner/HR-Admin).
router.use(protect);

function mountResource(path, ctrl) {
  router.get(`/${path}`, ctrl.list);
  router.get(`/${path}/:id`, ctrl.get);
  router.post(`/${path}`, requirePermission('canManageOrg'), ctrl.create);
  router.patch(`/${path}/:id`, requirePermission('canManageOrg'), ctrl.update);
  router.delete(`/${path}/:id`, requirePermission('canManageOrg'), ctrl.remove);
}

mountResource('entities', org.entities);
mountResource('locations', org.locations);
mountResource('departments', org.departments);
mountResource('designations', org.designations);
mountResource('grades', org.grades);
mountResource('bands', org.bands);

module.exports = router;
