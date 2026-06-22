'use strict';
// Holiday calendar routes. Mounted at /api/hr/attendance/holidays.
// Reads are open to any authenticated operator (a holiday calendar is not
// employee-PII); writes + statutory import require canManageAttendance.
const express = require('express');
const router = express.Router();
const { protect, requirePermission } = require('../../core/middleware/auth.middleware');
const c = require('../controllers/holidays.controller');

router.use(protect);

router.get('/', c.listHolidays);
router.post('/', requirePermission('canManageAttendance'), c.createHoliday);
router.post('/import', requirePermission('canManageAttendance'), c.importHolidays);
router.patch('/:id', requirePermission('canManageAttendance'), c.updateHoliday);
router.delete('/:id', requirePermission('canManageAttendance'), c.removeHoliday);

module.exports = router;
