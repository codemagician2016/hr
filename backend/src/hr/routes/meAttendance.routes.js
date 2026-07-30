'use strict';

/**
 * meAttendance.routes.js — Employee Self-Service (ESS) attendance API, mounted at
 * /api/hr/me/attendance. Uses the CUSTOMER-auth middleware (req.customer): the ESS
 * runs on the customer session, not an operator session.
 *
 * SELF_ONLY by construction — the subject employee is resolved from the session
 * inside the controller; there is NO :employeeId (or any employee id) in any path
 * or accepted from a body, so a cross-employee read/write is structurally
 * impossible. Terminated/inactive employees are locked out (404).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { requireCustomer } = require('../../core/middleware/auth.middleware');
const { extractClientIp } = require('../../core/middleware/abuse.middleware');
const { ipKeyGenerator } = require('express-rate-limit');
const c = require('../controllers/meAttendance.controller');

router.use(requireCustomer);

// Punch + face-enrol run CPU-heavy ONNX face matching/embedding. Cap per
// employee session (fall back to IP before the session resolves) so a logged-in
// employee can't spin the matcher to burn server CPU. Real clock-in/out and
// enrolment are a handful of calls a day — 30/min is generous headroom.
const faceCaptureLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.customer?.id ? `face:${req.customer.id}` : `face-ip:${ipKeyGenerator(extractClientIp(req))}`),
  message: { message: 'Too many attendance capture attempts. Please wait a minute and try again.' },
});

// Clock + punches
router.post('/punch', faceCaptureLimiter, c.createPunch);
router.get('/punches', c.listPunches);

// Feature 2 — multi-mode capture: the policy that applies to ME (which methods are
// required), plus self face-enrolment for the FACE mode. SELF_ONLY (session subject).
router.get('/policy', c.getCapturePolicy);
router.get('/face', c.getFaceEnrollment);
router.post('/face/enroll', faceCaptureLimiter, c.enrollFace);

// Dashboard rollup (own daily summary buckets)
router.get('/summary', c.summary);

// Per-day rollup rows (own "Attendance Details" table — one row per civil day)
router.get('/days', c.listDays);

// Timesheets (read + self-submit)
router.get('/timesheets', c.listTimesheets);
router.get('/timesheets/:id', c.getTimesheet);
router.post('/timesheets/:id/submit', c.submitTimesheet);

// Corrections (regularizations)
router.get('/regularizations', c.listRegularizations);
router.post('/regularizations', c.createRegularization);

// OT pre-approval — request authorization for overtime minutes on a day (rides the
// F10 OVERTIME engine; manager authorizes). SELF_ONLY (session subject).
router.get('/overtime', c.listOvertimeRequests);
router.post('/overtime', c.createOvertimeRequest);
router.post('/overtime/:id/cancel', c.cancelOvertimeRequest);

// Schedule + holidays
router.get('/schedule', c.getSchedule);
router.get('/holidays', c.listHolidays);

// Program P1.7 — restricted/optional holiday elections (pick N per year).
const rh = require('../attendance/restrictedHolidays.controller');
router.get('/restricted-holidays', rh.listMine);
router.post('/restricted-holidays', rh.elect);
router.delete('/restricted-holidays/:holidayId', rh.withdraw);

module.exports = router;
