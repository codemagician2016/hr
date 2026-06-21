'use strict';
const express = require('express');
const { protect, requireRole } = require('../../core/middleware/auth.middleware');
const { ROLES } = require('../../core/lib/roles');
const c = require('../controllers/locations.controller');

const router = express.Router();
router.use(protect);
router.use(requireRole(ROLES.BUSINESS_ADMIN, ROLES.SUPER_ADMIN));

router.get('/', c.list);
router.post('/', c.create);
router.put('/:id', c.update);
router.delete('/:id', c.remove);

module.exports = router;
